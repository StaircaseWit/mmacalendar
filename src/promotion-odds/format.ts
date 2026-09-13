import { cleanText, decimalOdds, formatShortCheckDate } from "../utils.js";
import {
  VALID_ODDS,
  canonicalOddsName,
  numericOdds,
  type PromotionOddsSnapshot,
} from "./model.js";

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

export function formatPromotionOdds(own: string | null | undefined): string | null {
  if (!own || !VALID_ODDS.test(own)) return null;
  const decimal = decimalOdds(own);
  return `${own}${decimal ? ` (${decimal})` : ""}`;
}

function formatPromotionOddsWithMarker(
  own: string | null | undefined,
  opponent: string | null | undefined,
): string | null {
  const odds = formatPromotionOdds(own);
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
