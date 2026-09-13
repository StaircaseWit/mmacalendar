import * as cheerio from "cheerio";
import { DAY_MS } from "./config.js";
import { fetchText } from "./http.js";
import { absoluteUrl, cleanText, decimalOdds, formatShortCheckDate, normalizedName } from "./utils.js";
import { mapWithConcurrency } from "./utils.js";

export const BEST_FIGHT_ODDS_URL = "https://www.bestfightodds.com/";

export interface PromotionOddsMarket {
  eventName: string;
  sourceUrl: string;
  redName: string;
  blueName: string;
  redOdds: string | null;
  blueOdds: string | null;
}

export interface PromotionOddsSnapshot {
  checkedAt: string;
  eventName: string;
  sourceUrl: string;
  odds: Record<string, string | null>;
  names: Record<string, string>;
}

export interface PromotionOddsStore {
  lastCheckedAt: string | null;
  fights: Record<string, PromotionOddsSnapshot[]>;
}

export interface AttachedPromotionOdds {
  redOdds: string | null;
  blueOdds: string | null;
  oddsHistory: PromotionOddsSnapshot[];
}

const VALID_ODDS = /^(?:[+-]\d+|EVEN)$/i;

export function canonicalOddsName(value: string): string {
  let name = normalizedName(value)
    .replace(/[’'".,()\-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+\b(?:jr|sr|ii|iii|iv)\b$/i, "");
  // Treat initials consistently, for example “A.J. McKee” and “AJ McKee”.
  name = name.replace(/\b([a-z])\s+(?=[a-z]\b)/g, "$1");
  return name;
}

export function promotionOddsKey(redName: string, blueName: string): string {
  return [canonicalOddsName(redName), canonicalOddsName(blueName)].sort().join("--");
}

function numericOdds(value: string): number {
  return value.toUpperCase() === "EVEN" ? 100 : Number(value);
}

function bestAvailableOdds(values: string[]): string | null {
  const valid = values.map(cleanText).filter((value) => VALID_ODDS.test(value));
  if (!valid.length) return null;
  return valid.reduce((best, candidate) => numericOdds(candidate) > numericOdds(best) ? candidate : best);
}

export function parseBestFightOdds(source: string): PromotionOddsMarket[] {
  const $ = cheerio.load(source);
  const markets: PromotionOddsMarket[] = [];
  $(".table-outer-wrapper").each((_, wrapper) => {
    const root = $(wrapper);
    const eventName = cleanText(root.find(".table-header h1").first().text()) || "Future Events";
    const eventPath = root.find(".table-header a[href*='/events/']").first().attr("href");
    const sourceUrl = absoluteUrl(eventPath, BEST_FIGHT_ODDS_URL) ?? BEST_FIGHT_ODDS_URL;
    const fighters = root.find(".table-inner-wrapper tbody tr").toArray().flatMap((row) => {
      const name = cleanText($(row).find(".t-b-fcc").first().text());
      if (!name) return [];
      const odds = $(row).find("td span[id^='oID']").toArray().map((span) => cleanText($(span).text()));
      return [{ name, odds: bestAvailableOdds(odds) }];
    });
    for (let index = 0; index + 1 < fighters.length; index += 2) {
      const red = fighters[index]!;
      const blue = fighters[index + 1]!;
      if (!red.odds && !blue.odds) continue;
      markets.push({
        eventName,
        sourceUrl,
        redName: red.name,
        blueName: blue.name,
        redOdds: red.odds,
        blueOdds: blue.odds,
      });
    }
  });
  return markets;
}

function eventIdentity(value: string): string {
  const name = canonicalOddsName(value);
  return name.match(/one friday fights \d+/)?.[0]
    ?? name.match(/one fight night \d+/)?.[0]
    ?? name.match(/one samurai \d+/)?.[0]
    ?? name.match(/super rizin \d+/)?.[0]
    ?? name.match(/rizin landmark \d+/)?.[0]
    ?? name;
}

export function bestFightOddsSearchTerm(eventName: string): string {
  const one = eventName.match(/ONE\s+(?:Friday Fights|Fight Night|SAMURAI)\s+\d+/i)?.[0];
  if (one) return cleanText(one);
  const landmark = eventName.match(/RIZIN\s+LANDMARK\s+\d+/i)?.[0];
  if (landmark) return cleanText(landmark);
  const numberedRizin = eventName.match(/RIZIN\s*\.?\s*(\d+)/i);
  if (numberedRizin?.[1]) return `${eventName.includes("超") ? "Super " : ""}RIZIN ${numberedRizin[1]}`;
  return cleanText(eventName);
}

export function findBestFightOddsEventUrl(source: string, eventName: string): string | null {
  const $ = cheerio.load(source);
  const target = canonicalOddsName(bestFightOddsSearchTerm(eventName));
  const targetIdentity = eventIdentity(target);
  let best: { url: string; score: number } | null = null;
  $("a[href*='/events/']").each((_, link) => {
    const candidate = canonicalOddsName($(link).text());
    const url = absoluteUrl($(link).attr("href"), BEST_FIGHT_ODDS_URL);
    if (!candidate || !url) return;
    const candidateIdentity = eventIdentity(candidate);
    let score = 0;
    if (candidateIdentity === targetIdentity) score = 100;
    else if (candidate === target) score = 95;
    else if (target.includes(candidate) || candidate.includes(target)) score = 80;
    else {
      const targetTokens = new Set(target.split(" "));
      const candidateTokens = new Set(candidate.split(" "));
      const shared = [...targetTokens].filter((token) => candidateTokens.has(token)).length;
      const union = new Set([...targetTokens, ...candidateTokens]).size;
      score = union ? Math.round(70 * shared / union) : 0;
    }
    if (score >= 75 && (!best || score > best.score)) best = { url, score };
  });
  return (best as { url: string; score: number } | null)?.url ?? null;
}

export async function scrapeBestFightOddsMarkets(eventNames: string[]): Promise<PromotionOddsMarket[]> {
  const homepage = await fetchText(BEST_FIGHT_ODDS_URL);
  const homepageMarkets = parseBestFightOdds(homepage);
  const homepageUrls = new Set(homepageMarkets.map(({ sourceUrl }) => sourceUrl));
  const searchTerms = [...new Set(eventNames.map(bestFightOddsSearchTerm).filter(Boolean))];
  let archive = "";
  try {
    archive = await fetchText(`${BEST_FIGHT_ODDS_URL}archive`, { attempts: 2 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not read the recent non-UFC odds archive: ${message}`);
  }
  const archiveUrls = new Map(searchTerms.flatMap((eventName) => {
    const url = archive ? findBestFightOddsEventUrl(archive, eventName) : null;
    return url ? [[eventName, url] as const] : [];
  }));
  const undiscovered = searchTerms.filter((eventName) => !archiveUrls.has(eventName));
  const searched = await mapWithConcurrency(undiscovered, 1, async (eventName) => {
    try {
      const searchUrl = `${BEST_FIGHT_ODDS_URL}search?query=${encodeURIComponent(eventName)}`;
      const result = findBestFightOddsEventUrl(await fetchText(searchUrl), eventName);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not search non-UFC odds for ${eventName}: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return null;
    }
  });
  const eventUrls = [...new Set([...archiveUrls.values(), ...searched.filter((url): url is string => Boolean(url))])]
    .filter((url) => !homepageUrls.has(url));
  const eventMarkets = (await mapWithConcurrency(eventUrls, 2, async (url) => {
    try {
      return parseBestFightOdds(await fetchText(url)).map((market) => ({ ...market, sourceUrl: url }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not read non-UFC odds from ${url}: ${message}`);
      return [];
    }
  })).flat();
  return [...homepageMarkets, ...eventMarkets];
}

export function promotionOddsRefreshIsDue(store: PromotionOddsStore, now = new Date()): boolean {
  if (!store.lastCheckedAt) return true;
  const lastCheck = new Date(store.lastCheckedAt);
  return Number.isNaN(lastCheck.valueOf()) || now.valueOf() - lastCheck.valueOf() >= 7 * DAY_MS;
}

function snapshotsDiffer(left: PromotionOddsSnapshot | undefined, right: PromotionOddsSnapshot): boolean {
  return JSON.stringify(left?.odds ?? {}) !== JSON.stringify(right.odds);
}

export function updatePromotionOddsStore(
  store: PromotionOddsStore,
  markets: PromotionOddsMarket[],
  now = new Date(),
): PromotionOddsStore {
  const checkedAt = now.toISOString();
  store.fights ??= {};
  const seen = new Set<string>();
  for (const market of markets) {
    const key = promotionOddsKey(market.redName, market.blueName);
    if (seen.has(key)) continue;
    seen.add(key);
    const redKey = canonicalOddsName(market.redName);
    const blueKey = canonicalOddsName(market.blueName);
    const snapshot: PromotionOddsSnapshot = {
      checkedAt,
      eventName: market.eventName,
      sourceUrl: market.sourceUrl,
      odds: { [redKey]: market.redOdds, [blueKey]: market.blueOdds },
      names: { [redKey]: market.redName, [blueKey]: market.blueName },
    };
    const history = store.fights[key] ?? [];
    if (!history.length || snapshotsDiffer(history.at(-1), snapshot)) history.push(snapshot);
    store.fights[key] = history;
  }
  store.lastCheckedAt = checkedAt;
  return store;
}

export function promotionOddsForBout(
  redName: string,
  blueName: string,
  store: PromotionOddsStore,
): AttachedPromotionOdds {
  const oddsHistory = store.fights?.[promotionOddsKey(redName, blueName)] ?? [];
  const latest = oddsHistory.at(-1)?.odds ?? {};
  const redOdds = latest[canonicalOddsName(redName)] ?? null;
  const blueOdds = latest[canonicalOddsName(blueName)] ?? null;
  return {
    redOdds: VALID_ODDS.test(redOdds ?? "") ? redOdds : null,
    blueOdds: VALID_ODDS.test(blueOdds ?? "") ? blueOdds : null,
    oddsHistory,
  };
}

function impliedProbability(value: string | null | undefined): number | null {
  if (!value || !VALID_ODDS.test(value)) return null;
  const american = numericOdds(value);
  return american < 0 ? Math.abs(american) / (Math.abs(american) + 100) : 100 / (american + 100);
}

function oddsMarker(own: string | null | undefined, opponent: string | null | undefined): string {
  const ownProbability = impliedProbability(own);
  const opponentProbability = impliedProbability(opponent);
  if (ownProbability === null) return "";
  if (opponentProbability !== null) {
    if (ownProbability === opponentProbability) return "🟡 ";
    return ownProbability > opponentProbability ? "🟢 " : "🔴 ";
  }
  return numericOdds(own!) < 0 ? "🟢 " : "🔴 ";
}

export function formatPromotionOdds(own: string | null | undefined, opponent: string | null | undefined): string | null {
  if (!own || !VALID_ODDS.test(own)) return null;
  const decimal = decimalOdds(own);
  return `${oddsMarker(own, opponent)}${own}${decimal ? ` (${decimal})` : ""}`;
}

export function shortPromotionFighterName(name: string): string {
  const parts = cleanText(name).split(" ");
  if (/^(?:jr\.?|sr\.?|ii|iii|iv)$/i.test(parts.at(-1) ?? "") && parts.length > 1) parts.pop();
  return parts.at(-1) || name;
}

export function formatPromotionOddsHistory(
  history: PromotionOddsSnapshot[] | undefined,
  redName: string,
  blueName: string,
): string | null {
  if (!history?.length) return null;
  const redKey = canonicalOddsName(redName);
  const blueKey = canonicalOddsName(blueName);
  const redShort = shortPromotionFighterName(redName);
  const blueShort = shortPromotionFighterName(blueName);
  const rows = history.flatMap((snapshot) => {
    const redOdds = snapshot.odds?.[redKey] ?? null;
    const blueOdds = snapshot.odds?.[blueKey] ?? null;
    if (!redOdds && !blueOdds) return [];
    const red = formatPromotionOdds(redOdds, blueOdds) ?? "unavailable";
    const blue = formatPromotionOdds(blueOdds, redOdds) ?? "unavailable";
    return [`  ◦ ${formatShortCheckDate(snapshot.checkedAt)}: ${redShort} ${red} | ${blueShort} ${blue}`];
  });
  return rows.length ? `• Odds history:\n${rows.join("\n")}` : null;
}
