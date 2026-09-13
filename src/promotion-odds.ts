import * as cheerio from "cheerio";
import { DAY_MS } from "./config.js";
import { fetchText } from "./http.js";
import { absoluteUrl, cleanText, decimalOdds, formatShortCheckDate, normalizedName } from "./utils.js";
import { mapWithConcurrency } from "./utils.js";

export const BEST_FIGHT_ODDS_URL = "https://www.bestfightodds.com/";

export interface PromotionOddsMarket {
  eventName: string;
  sourceUrl: string;
  promotion?: string;
  eventId?: string;
  redName: string;
  blueName: string;
  redOdds: string | null;
  blueOdds: string | null;
}

export interface PromotionOddsSnapshot {
  checkedAt: string;
  eventName: string;
  sourceUrl: string;
  promotion?: string;
  eventId?: string;
  odds: Record<string, string | null>;
  names: Record<string, string>;
}

export interface PromotionOddsStore {
  lastCheckedAt: string | null;
  fights: Record<string, PromotionOddsSnapshot[]>;
}

export interface KnownOddsBout {
  promotion: string;
  eventId: string;
  eventName: string;
  redName: string;
  blueName: string;
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

export function fighterPairKey(redName: string, blueName: string): string {
  return [canonicalOddsName(redName), canonicalOddsName(blueName)].sort().join("--");
}

export function promotionOddsKey(
  promotion: string,
  eventId: string,
  redName: string,
  blueName: string,
): string {
  return `${canonicalOddsName(promotion)}::${canonicalOddsName(eventId)}::${fighterPairKey(redName, blueName)}`;
}

export function promotionEventKey(promotion: string, eventId: string): string {
  return `${canonicalOddsName(promotion)}::${canonicalOddsName(eventId)}`;
}

export function prunePromotionOddsStore(
  store: PromotionOddsStore,
  retainedEvents: ReadonlySet<string>,
): PromotionOddsStore {
  store.fights ??= {};
  for (const [key, history] of Object.entries(store.fights)) {
    const latest = history.at(-1);
    const promotion = latest?.promotion;
    const eventId = latest?.eventId;
    if (promotion && eventId && !retainedEvents.has(promotionEventKey(promotion, eventId))) {
      delete store.fights[key];
    }
  }
  return store;
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
    console.warn(`Could not read the recent BestFightOdds archive: ${message}`);
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
      console.warn(`Could not search BestFightOdds for ${eventName}: ${message}`);
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
      console.warn(`Could not read BestFightOdds from ${url}: ${message}`);
      return [];
    }
  })).flat();
  return [...homepageMarkets, ...eventMarkets];
}

export function promotionOddsRefreshIsDue(store: PromotionOddsStore, now = new Date()): boolean {
  if (!store.lastCheckedAt) return true;
  const lastCheck = new Date(store.lastCheckedAt);
  return Number.isNaN(lastCheck.valueOf()) || now.valueOf() - lastCheck.valueOf() >= 3 * DAY_MS;
}

function fighterNameScore(left: string, right: string): number {
  const leftName = canonicalOddsName(left);
  const rightName = canonicalOddsName(right);
  if (leftName === rightName) return 100;
  const leftParts = leftName.split(" ").filter(Boolean);
  const rightParts = rightName.split(" ").filter(Boolean);
  if (!leftParts.length || !rightParts.length) return 0;
  const sameFirst = leftParts[0] === rightParts[0];
  const sameLast = leftParts.at(-1) === rightParts.at(-1);
  if (sameFirst && sameLast && leftParts.length > 1 && rightParts.length > 1) return 95;
  const leftTokens = new Set(leftParts);
  const rightTokens = new Set(rightParts);
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  if (shared >= 2 && (shared === leftTokens.size || shared === rightTokens.size)) return 92;
  if (sameLast && shared >= 2) return 88;
  return 0;
}

function eventNameScore(left: string, right: string): number {
  const leftIdentity = eventIdentity(left);
  const rightIdentity = eventIdentity(right);
  if (!leftIdentity || !rightIdentity || leftIdentity === "future events") return 0;
  if (leftIdentity === rightIdentity) return 100;
  if (leftIdentity.includes(rightIdentity) || rightIdentity.includes(leftIdentity)) return 85;
  const leftTokens = new Set(leftIdentity.split(" ").filter((token) => token.length > 1));
  const rightTokens = new Set(rightIdentity.split(" ").filter((token) => token.length > 1));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? Math.round(70 * shared / union) : 0;
}

/**
 * Align bookmaker spellings with the official card names. This keeps stored keys
 * stable when a market omits a middle name or uses initials/a nickname.
 */
export function matchBestFightOddsMarkets(
  markets: PromotionOddsMarket[],
  knownBouts: KnownOddsBout[],
): PromotionOddsMarket[] {
  const matched: PromotionOddsMarket[] = [];
  for (const market of markets) {
    const candidates: Array<{ bout: KnownOddsBout; reversed: boolean; fighterScore: number; eventScore: number }> = [];
    for (const bout of knownBouts) {
      const directRed = fighterNameScore(market.redName, bout.redName);
      const directBlue = fighterNameScore(market.blueName, bout.blueName);
      const reverseRed = fighterNameScore(market.redName, bout.blueName);
      const reverseBlue = fighterNameScore(market.blueName, bout.redName);
      const direct = Math.min(directRed, directBlue);
      const reverse = Math.min(reverseRed, reverseBlue);
      const fighterScore = Math.max(direct, reverse);
      if (fighterScore < 88) continue;
      candidates.push({
        bout,
        reversed: reverse > direct,
        fighterScore,
        eventScore: eventNameScore(market.eventName, bout.eventName),
      });
    }
    candidates.sort((left, right) =>
      (right.fighterScore * 2 + right.eventScore) - (left.fighterScore * 2 + left.eventScore)
    );
    const best = candidates[0];
    if (!best) continue;
    if (candidates.length > 1) {
      const next = candidates[1]!;
      if (best.eventScore < 75 || best.eventScore === next.eventScore) continue;
    }
    matched.push({
      ...market,
      promotion: best.bout.promotion,
      eventId: best.bout.eventId,
      eventName: best.bout.eventName,
      redName: best.bout.redName,
      blueName: best.bout.blueName,
      redOdds: best.reversed ? market.blueOdds : market.redOdds,
      blueOdds: best.reversed ? market.redOdds : market.blueOdds,
    });
  }
  return matched;
}

/** Move unambiguous legacy fighter-pair histories into event-specific keys. */
export function migratePromotionOddsStore(
  store: PromotionOddsStore,
  knownBouts: KnownOddsBout[],
): PromotionOddsStore {
  store.fights ??= {};
  for (const [legacyKey, history] of Object.entries({ ...store.fights })) {
    if (legacyKey.includes("::")) continue;
    const candidates = knownBouts.filter((bout) => fighterPairKey(bout.redName, bout.blueName) === legacyKey);
    if (!candidates.length) continue;
    let selected: KnownOddsBout | undefined;
    if (candidates.length === 1) {
      selected = candidates[0];
    } else {
      const eventName = history.at(-1)?.eventName ?? "";
      const ranked = candidates
        .map((bout) => ({ bout, score: eventNameScore(eventName, bout.eventName) }))
        .sort((left, right) => right.score - left.score);
      if (ranked[0] && ranked[0].score >= 75 && ranked[0].score > (ranked[1]?.score ?? -1)) {
        selected = ranked[0].bout;
      }
    }
    if (!selected) continue;
    const key = promotionOddsKey(
      selected.promotion,
      selected.eventId,
      selected.redName,
      selected.blueName,
    );
    const migrated = history.map((snapshot) => ({
      ...snapshot,
      promotion: selected!.promotion,
      eventId: selected!.eventId,
      eventName: selected!.eventName,
    }));
    store.fights[key] = [...(store.fights[key] ?? []), ...migrated]
      .filter((snapshot, index, snapshots) =>
        index === 0 || snapshots[index - 1]!.checkedAt !== snapshot.checkedAt || snapshotsDiffer(snapshots[index - 1], snapshot)
      );
    delete store.fights[legacyKey];
  }
  return compactPromotionOddsStore(store);
}

function snapshotsDiffer(left: PromotionOddsSnapshot | undefined, right: PromotionOddsSnapshot): boolean {
  const values = (snapshot: PromotionOddsSnapshot | undefined): string => JSON.stringify(
    Object.entries(snapshot?.odds ?? {}).sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
  );
  return values(left) !== values(right);
}

export function compactPromotionOddsStore(store: PromotionOddsStore): PromotionOddsStore {
  for (const [key, history] of Object.entries(store.fights ?? {})) {
    store.fights[key] = history.filter((snapshot, index) => index === 0 || snapshotsDiffer(history[index - 1], snapshot));
  }
  return store;
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
    if (!market.promotion || !market.eventId) continue;
    const key = promotionOddsKey(market.promotion, market.eventId, market.redName, market.blueName);
    if (seen.has(key)) continue;
    seen.add(key);
    const redKey = canonicalOddsName(market.redName);
    const blueKey = canonicalOddsName(market.blueName);
    const snapshot: PromotionOddsSnapshot = {
      checkedAt,
      eventName: market.eventName,
      sourceUrl: market.sourceUrl,
      promotion: market.promotion,
      eventId: market.eventId,
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
  promotion: string,
  eventId: string,
  redName: string,
  blueName: string,
  store: PromotionOddsStore,
): AttachedPromotionOdds {
  const oddsHistory = store.fights?.[promotionOddsKey(promotion, eventId, redName, blueName)] ?? [];
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

export function formatPromotionOdds(own: string | null | undefined, _opponent: string | null | undefined): string | null {
  if (!own || !VALID_ODDS.test(own)) return null;
  const decimal = decimalOdds(own);
  return `${own}${decimal ? ` (${decimal})` : ""}`;
}

function formatPromotionOddsWithMarker(
  own: string | null | undefined,
  opponent: string | null | undefined,
): string | null {
  const odds = formatPromotionOdds(own, opponent);
  return odds ? `${oddsMarker(own, opponent)}${odds}` : null;
}

export function shortPromotionFighterName(name: string): string {
  const parts = cleanText(name).split(" ");
  if (/^(?:jr\.?|sr\.?|ii|iii|iv)$/i.test(parts.at(-1) ?? "") && parts.length > 1) parts.pop();
  return parts.at(-1) || name;
}

export function promotionOddsHistoryRows(
  history: PromotionOddsSnapshot[] | undefined,
  redName: string,
  blueName: string,
): string[] {
  if (!history?.length) return [];
  const redKey = canonicalOddsName(redName);
  const blueKey = canonicalOddsName(blueName);
  const redShort = shortPromotionFighterName(redName);
  const blueShort = shortPromotionFighterName(blueName);
  return history.flatMap((snapshot) => {
    const redOdds = snapshot.odds?.[redKey] ?? null;
    const blueOdds = snapshot.odds?.[blueKey] ?? null;
    if (!redOdds && !blueOdds) return [];
    const red = formatPromotionOddsWithMarker(redOdds, blueOdds) ?? "unavailable";
    const blue = formatPromotionOddsWithMarker(blueOdds, redOdds) ?? "unavailable";
    return [`${formatShortCheckDate(snapshot.checkedAt)}: ${redShort} ${red} | ${blueShort} ${blue}`];
  });
}

export function formatPromotionOddsHistory(
  history: PromotionOddsSnapshot[] | undefined,
  redName: string,
  blueName: string,
): string | null {
  const rows = promotionOddsHistoryRows(history, redName, blueName);
  return rows.length ? `• Odds history:\n${rows.map((row) => `  ◦ ${row}`).join("\n")}` : null;
}
