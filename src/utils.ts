import { WEIGHT_CLASSES } from "./config.js";
import type { Fighter } from "./types.js";

export function cleanText(value: string = ""): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function absoluteUrl(value: string | undefined, origin = "https://www.ufc.com"): string | null {
  if (!value) return null;
  return new URL(value, origin).toString();
}

export function slugFromUrl(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "event";
}

export function normalizedName(name: string): string {
  return cleanText(name).toLocaleLowerCase("en").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function fightKey(eventSlug: string, redName: string, blueName: string): string {
  const pair = [normalizedName(redName), normalizedName(blueName)].sort().join("--");
  return `${eventSlug}::${pair}`;
}

export function countryCodeFromFlag(src: string = ""): string | null {
  return src.match(/\/flags\/([a-z]{2})\.(?:png|svg|webp)/i)?.[1]?.toUpperCase() ?? null;
}

export function flagEmoji(countryCode: string | null | undefined): string {
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) return "";
  return [...countryCode].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join("");
}

export function describeWeightClass(rawValue: string): string {
  const original = cleanText(rawValue);
  const isTitleBout = /title bout/i.test(original);
  const cleaned = original
    .replace(/\s+(?:Interim\s+)?Title Bout$/i, "")
    .replace(/\s+Bout$/i, "");
  const match = WEIGHT_CLASSES.find(([name]) => name.toLowerCase() === cleaned.toLowerCase());
  if (!match) return `${cleaned || "Weight class unavailable"}${isTitleBout ? " · Title Bout" : ""}`;
  const [name, pounds, kilograms] = match;
  return `${pounds}lbs/${kilograms}kg ${name}${isTitleBout ? " · Title Bout" : ""}`;
}

export function parseTimestamp(value: string | undefined): Date | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

export function dateIsValid(date: Date): boolean {
  return date instanceof Date && !Number.isNaN(date.valueOf());
}

export function formatHumanDate(value: string | null | undefined): string {
  if (!value) return "unavailable";
  const date = new Date(`${value}T00:00:00Z`);
  if (!dateIsValid(date)) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function formatCheckDate(value: string): string {
  const date = new Date(value);
  if (!dateIsValid(date)) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function ageOnDate(birthDate: string | null | undefined, onDate: Date): number | null {
  if (!birthDate || !dateIsValid(onDate)) return null;
  const birth = new Date(`${birthDate}T00:00:00Z`);
  if (!dateIsValid(birth)) return null;
  let age = onDate.getUTCFullYear() - birth.getUTCFullYear();
  const birthdayHasPassed = onDate.getUTCMonth() > birth.getUTCMonth()
    || (onDate.getUTCMonth() === birth.getUTCMonth() && onDate.getUTCDate() >= birth.getUTCDate());
  if (!birthdayHasPassed) age -= 1;
  return age >= 0 ? age : null;
}

export function decimalOdds(americanOdds: string | null | undefined): string | null {
  if (String(americanOdds).toUpperCase() === "EVEN") return "2.00";
  const odds = Number(americanOdds);
  if (!Number.isFinite(odds) || odds === 0) return null;
  const decimal = odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
  return decimal.toFixed(2);
}

export function shortFighterName(fighter: Pick<Fighter, "name" | "familyName">): string {
  if (fighter.familyName) return fighter.familyName;
  const parts = cleanText(fighter.name).split(" ");
  if (/^(?:jr\.?|sr\.?|ii|iii|iv)$/i.test(parts.at(-1) ?? "") && parts.length > 1) parts.pop();
  return parts.at(-1) || fighter.name;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
