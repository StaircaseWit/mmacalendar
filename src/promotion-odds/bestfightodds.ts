import * as cheerio from "cheerio";
import { fetchText } from "../http.js";
import { absoluteUrl, cleanText, mapWithConcurrency } from "../utils.js";
import {
  VALID_ODDS,
  canonicalOddsName,
  eventIdentity,
  eventNameScore,
  numericOdds,
  type KnownOddsBout,
  type PromotionOddsMarket,
} from "./model.js";

export const BEST_FIGHT_ODDS_URL = "https://www.bestfightodds.com/";

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
  const eventUrls = [...new Set([...archiveUrls.values(), ...searched.filter((url): url is string => Boolean(url))])].filter(
    (url) => !homepageUrls.has(url),
  );
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

/** Align bookmaker spellings with official card names without guessing ambiguous rematches. */
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
