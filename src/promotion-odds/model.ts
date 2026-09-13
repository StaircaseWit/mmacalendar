import { normalizedName } from "../utils.js";

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

export const VALID_ODDS = /^(?:[+-]\d+|EVEN)$/i;

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

export function numericOdds(value: string): number {
  return value.toUpperCase() === "EVEN" ? 100 : Number(value);
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

export function eventIdentity(value: string): string {
  const name = canonicalOddsName(value);
  return name.match(/one friday fights \d+/)?.[0]
    ?? name.match(/one fight night \d+/)?.[0]
    ?? name.match(/one samurai \d+/)?.[0]
    ?? name.match(/super rizin \d+/)?.[0]
    ?? name.match(/rizin landmark \d+/)?.[0]
    ?? name;
}

export function eventNameScore(left: string, right: string): number {
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
