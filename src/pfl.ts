import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { fetchText } from "./http.js";
import {
  absoluteUrl,
  ageOnDate,
  cleanText,
  countryCodesFromName,
  describeWeightClass,
  flagEmoji,
  mapWithConcurrency,
  normalizedName,
  unicodeBold,
} from "./utils.js";
import {
  BEST_FIGHT_ODDS_URL,
  formatPromotionOdds,
  formatPromotionOddsHistory,
  type PromotionOddsSnapshot,
} from "./promotion-odds.js";

export const PFL_EVENTS_URL = "https://pflmma.com/events";

export interface PflFighter {
  name: string;
  profileUrl?: string;
  countryCode?: string | null;
  birthDate?: string | null;
  record?: string | null;
  style?: string | null;
  odds?: string | null;
}

export interface PflBout {
  id: string;
  order: number;
  red: PflFighter;
  blue: PflFighter;
  details: string;
  note?: string;
  oddsHistory?: PromotionOddsSnapshot[];
}

export interface PflListing {
  uid: string;
  date: string;
  summary: string;
  location: string;
  url: string;
}

export interface PflEvent extends PflListing {
  start: string | null;
  end: string | null;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  bouts: PflBout[];
  cancelledBouts: PflBout[];
}

export interface PflFighterProfile {
  name?: string;
  countryCode?: string | null;
  birthDate?: string | null;
  record?: string | null;
  style?: string | null;
  checkedAt: string;
}

export interface PflFighterStore {
  profiles: Record<string, PflFighterProfile>;
}

interface JsonLdNode {
  "@type"?: string | string[];
  "@id"?: string;
  name?: string;
  description?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  eventStatus?: string;
  nationality?: string;
  birthDate?: string;
  location?: { name?: string; address?: { name?: string; addressLocality?: string } } | string;
  competitor?: JsonLdNode | JsonLdNode[];
  subEvent?: JsonLdNode | JsonLdNode[];
  itemListElement?: Array<{ item?: JsonLdNode }>;
  mainEntity?: JsonLdNode;
  "@graph"?: JsonLdNode[];
}

function escapeIcs(value: unknown = ""): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldLine(line: string): string {
  const output: string[] = [];
  let current = "";
  for (const character of line) {
    if (Buffer.byteLength(current + character, "utf8") > 75) {
      output.push(current);
      current = ` ${character}`;
    } else {
      current += character;
    }
  }
  output.push(current);
  return output.join("\r\n");
}

function basicUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function compactDate(value: string): string {
  return value.replaceAll("-", "");
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return dateOnly(date);
}

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function hasType(node: JsonLdNode, type: string): boolean {
  return arrayOf(node["@type"]).includes(type);
}

function jsonLdNodes(source: string): JsonLdNode[] {
  const $ = cheerio.load(source);
  const nodes: JsonLdNode[] = [];
  $("script[type='application/ld+json']").each((_, script) => {
    try {
      const parsed = JSON.parse($(script).text()) as JsonLdNode | JsonLdNode[];
      for (const root of arrayOf(parsed)) nodes.push(...(root["@graph"] ?? [root]));
    } catch {
      // Ignore unrelated or temporarily malformed metadata blocks.
    }
  });
  return nodes;
}

function eventUid(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? url;
}

function locationName(value: JsonLdNode["location"]): string {
  if (typeof value === "string") return cleanText(value);
  return cleanText(value?.name || value?.address?.name || value?.address?.addressLocality || "");
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function cardMonthDay(value: string): { month: number; day: number } | null {
  const match = cleanText(value).match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+([A-Za-z]{3})\s+(\d{1,2})/i);
  const month = match?.[1] ? MONTHS[match[1].toLowerCase()] : undefined;
  return month && match?.[2] ? { month, day: Number(match[2]) } : null;
}

function visibleEventCards(source: string, now: Date): PflListing[] {
  const $ = cheerio.load(source);
  const listings: PflListing[] = [];
  const addCard = (card: AnyNode, year: number): void => {
    const root = $(card);
    const info = root.find(".event-card-info").first();
    const monthDay = cardMonthDay(info.find("h6").first().text());
    const url = absoluteUrl(info.find("a[href*='/event/']").first().attr("href"), "https://pflmma.com");
    const summary = cleanText(info.find("h3").first().text());
    if (!monthDay || !url || !summary) return;
    const date = `${year}-${String(monthDay.month).padStart(2, "0")}-${String(monthDay.day).padStart(2, "0")}`;
    listings.push({
      uid: eventUid(url),
      date,
      summary,
      location: cleanText(info.find("p").first().text()),
      url,
    });
  };

  const nowValue = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  $("#nav-upcoming .event-hub").each((_, card) => {
    const monthDay = cardMonthDay($(card).find(".event-card-info h6").first().text());
    if (!monthDay) return;
    let year = now.getUTCFullYear();
    const candidate = Date.UTC(year, monthDay.month - 1, monthDay.day);
    if (candidate < nowValue - 7 * 24 * 60 * 60 * 1000) year += 1;
    addCard(card, year);
  });

  let pastYear = now.getUTCFullYear();
  let previousMonthDay = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  $("#nav-past .event-hub").slice(0, 40).each((_, card) => {
    const monthDay = cardMonthDay($(card).find(".event-card-info h6").first().text());
    if (!monthDay) return;
    const monthDayNumber = monthDay.month * 100 + monthDay.day;
    const candidate = Date.UTC(pastYear, monthDay.month - 1, monthDay.day);
    if (candidate > nowValue + 7 * 24 * 60 * 60 * 1000 || monthDayNumber > previousMonthDay) pastYear -= 1;
    addCard(card, pastYear);
    previousMonthDay = monthDayNumber;
  });
  return listings;
}

export function parsePflEventListing(source: string, now = new Date()): PflListing[] {
  const listings = new Map<string, PflListing>();
  for (const listing of visibleEventCards(source, now)) listings.set(listing.url, listing);
  const itemLists = jsonLdNodes(source).flatMap((node) => {
    if (hasType(node, "ItemList")) return [node];
    return node.mainEntity && hasType(node.mainEntity, "ItemList") ? [node.mainEntity] : [];
  });
  for (const node of itemLists) {
    for (const entry of node.itemListElement ?? []) {
      const item = entry.item;
      const url = absoluteUrl(item?.url, "https://pflmma.com");
      const date = item?.startDate?.slice(0, 10);
      if (!item || !hasType(item, "SportsEvent") || !url || !date || !item.name) continue;
      if (listings.has(url)) continue;
      listings.set(url, {
        uid: eventUid(url),
        date,
        summary: cleanText(item.name),
        location: locationName(item.location) || cleanText(item.description),
        url,
      });
    }
  }
  return [...listings.values()].sort((left, right) => left.date.localeCompare(right.date));
}

const TIME_ZONES: Record<string, string> = {
  ET: "America/New_York",
  EST: "America/New_York",
  EDT: "America/New_York",
  SAST: "Africa/Johannesburg",
  GMT: "Etc/GMT",
  BST: "Europe/London",
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
  GST: "Asia/Dubai",
  AST: "Asia/Riyadh",
};

function partsInZone(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
}

function localTimeToUtc(date: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const wallClock = Date.UTC(year!, month! - 1, day!, hour, minute);
  let instant = new Date(wallClock);
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = partsInZone(instant, timeZone);
    const represented = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
    instant = new Date(instant.valueOf() + wallClock - represented);
  }
  return instant;
}

function parsePublishedTime(value: string, date: string): Date | null {
  const match = cleanText(value).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*([A-Z]{2,5})/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (match[3]!.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (match[3]!.toLowerCase() === "am" && hour === 12) hour = 0;
  const timeZone = TIME_ZONES[match[4]!.toUpperCase()];
  return timeZone ? localTimeToUtc(date, hour, Number(match[2] ?? 0), timeZone) : null;
}

function publishedCardTimes(source: string, date: string): { early: Date | null; main: Date | null } {
  const $ = cheerio.load(source);
  const times: { early: Date | null; main: Date | null } = { early: null, main: null };
  $(".event-info-time").each((_, label) => {
    const name = cleanText($(label).text()).toLowerCase();
    const value = cleanText($(label).next(".event-info-time-text").text());
    if (!times.early && name.includes("early")) times.early = parsePublishedTime(value, date);
    if (!times.main && name.includes("main")) times.main = parsePublishedTime(value, date);
  });
  if (times.early && times.main && times.main.valueOf() < times.early.valueOf()) {
    times.main = new Date(times.main.valueOf() + 24 * 60 * 60 * 1000);
  }
  return times;
}

const DIVISIONS = [
  "Women's Flyweight",
  "Women's Featherweight",
  "Light Heavyweight",
  "Heavyweight",
  "Middleweight",
  "Welterweight",
  "Lightweight",
  "Featherweight",
  "Bantamweight",
  "Flyweight",
];

function formatBoutDetails(description: string, matchup: string): string {
  const escapedMatchup = matchup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const raw = cleanText(description).replace(new RegExp(`^${escapedMatchup}\\s*[-–:]\\s*`, "i"), "");
  const division = DIVISIONS.find((candidate) => raw.toLowerCase().includes(candidate.toLowerCase()));
  if (!division) return raw || "Weight class to be announced";
  const suffix = cleanText(raw.replace(new RegExp(division, "i"), "").replace(/^[-–·\s]+/, ""));
  return `${describeWeightClass(division)}${suffix ? ` · ${suffix}` : ""}`;
}

function eventStatus(value: string | undefined): "CONFIRMED" | "TENTATIVE" | "CANCELLED" {
  if (/cancel/i.test(value ?? "")) return "CANCELLED";
  if (/postpon|resched/i.test(value ?? "")) return "TENTATIVE";
  return "CONFIRMED";
}

export function parsePflEventPage(source: string, listing: PflListing): PflEvent {
  const event = jsonLdNodes(source).find((node) => hasType(node, "SportsEvent") && /#event$/.test(node["@id"] ?? ""));
  const date = event?.startDate?.slice(0, 10) ?? listing.date;
  const { early, main } = publishedCardTimes(source, date);
  const start = early ?? main;
  const finalCardStart = main ?? early;
  const end = finalCardStart ? new Date(finalCardStart.valueOf() + (main ? 3 : 6) * 60 * 60 * 1000) : null;
  const subEvents = arrayOf(event?.subEvent);
  const parsedBouts = subEvents.flatMap((bout, index): PflBout[] => {
    const competitors = arrayOf(bout.competitor);
    if (competitors.length < 2 || !competitors[0]?.name || !competitors[1]?.name) return [];
    const redUrl = absoluteUrl(competitors[0].url, "https://pflmma.com") ?? undefined;
    const blueUrl = absoluteUrl(competitors[1].url, "https://pflmma.com") ?? undefined;
    return [{
      id: bout["@id"]?.split("#fight-")[1] ?? `${listing.uid}-${index + 1}`,
      order: subEvents.length - index,
      red: { name: cleanText(competitors[0].name), profileUrl: redUrl },
      blue: { name: cleanText(competitors[1].name), profileUrl: blueUrl },
      details: formatBoutDetails(bout.description ?? "", bout.name ?? `${competitors[0].name} vs ${competitors[1].name}`),
      note: /cancel/i.test(bout.eventStatus ?? "") ? "Cancelled by PFL" : /postpon|resched/i.test(bout.eventStatus ?? "") ? "Postponed by PFL" : undefined,
    }];
  });
  const cancelledBouts = parsedBouts.filter(({ note }) => Boolean(note));
  const bouts = parsedBouts.filter(({ note }) => !note);
  const status = eventStatus(event?.eventStatus);
  return {
    ...listing,
    date,
    summary: cleanText(event?.name) || listing.summary,
    location: locationName(event?.location) || listing.location,
    start: start ? basicUtc(start) : null,
    end: end ? basicUtc(end) : null,
    status: status === "CONFIRMED" && !start ? "TENTATIVE" : status,
    bouts,
    cancelledBouts,
  };
}

function inferStyle(description: string): string | null {
  const value = description.toLowerCase();
  const striking = (value.match(/strik|kickbox|boxing|muay thai|karate/g) ?? []).length;
  const grappling = (value.match(/grappl|wrestl|submission|jiu-jitsu|judo|takedown|ground game/g) ?? []).length;
  if (!striking && !grappling) return null;
  if (striking && grappling && Math.abs(striking - grappling) <= 1) return "All-rounder";
  return grappling > striking ? "Grappler" : "Striker";
}

export function parsePflFighterPage(source: string, checkedAt = new Date()): PflFighterProfile {
  const person = jsonLdNodes(source).find((node) => hasType(node, "Person"));
  const nationality = cleanText(person?.nationality);
  const record = source.match(/Career Record:\s*([0-9]+-[0-9]+-[0-9]+)/i)?.[1] ?? null;
  const rawBirthDate = person?.birthDate?.slice(0, 10) ?? null;
  const currentAge = ageOnDate(rawBirthDate, checkedAt);
  const birthDate = currentAge !== null && currentAge >= 16 && currentAge <= 65 ? rawBirthDate : null;
  return {
    name: cleanText(person?.name) || undefined,
    countryCode: countryCodesFromName(nationality)[0] ?? null,
    birthDate,
    record,
    style: inferStyle(person?.description ?? ""),
    checkedAt: checkedAt.toISOString(),
  };
}

function profileIsFresh(profile: PflFighterProfile | undefined, now: Date): boolean {
  if (!profile) return false;
  const checkedAt = new Date(profile.checkedAt);
  return Boolean(profile.name || profile.record || profile.countryCode)
    && Number.isFinite(checkedAt.valueOf())
    && now.valueOf() - checkedAt.valueOf() < 30 * 24 * 60 * 60 * 1000;
}

export async function enrichPflFighters(events: PflEvent[], store: PflFighterStore, now = new Date()): Promise<void> {
  store.profiles ??= {};
  for (const profile of Object.values(store.profiles)) {
    const age = ageOnDate(profile.birthDate, now);
    if (age === null || age < 16 || age > 65) profile.birthDate = null;
  }
  const urls = [...new Set(events.flatMap((event) => [...event.bouts, ...event.cancelledBouts]
    .flatMap((bout) => [bout.red.profileUrl, bout.blue.profileUrl])).filter((url): url is string => Boolean(url)))];
  const due = urls.filter((url) => !profileIsFresh(store.profiles[url], now));
  await mapWithConcurrency(due, 6, async (url) => {
    try {
      const candidates = [
        url,
        url.replace(/-2$/, ""),
        /\/moustapha-diakhat$/.test(url) ? `${url}e` : url,
      ].filter((candidate, index, values) => values.indexOf(candidate) === index);
      let source: string | null = null;
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          source = await fetchText(candidate, { attempts: 2 });
          break;
        } catch (error: unknown) {
          lastError = error;
        }
      }
      if (!source) throw lastError ?? new Error("No working fighter profile URL");
      store.profiles[url] = parsePflFighterPage(source, now);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not add a PFL fighter profile from ${url}: ${message}`);
    }
  });
  for (const event of events) {
    for (const bout of [...event.bouts, ...event.cancelledBouts]) {
      for (const fighter of [bout.red, bout.blue]) {
        const profile = fighter.profileUrl ? store.profiles[fighter.profileUrl] : undefined;
        if (!profile) continue;
        fighter.name = profile.name || fighter.name;
        fighter.countryCode = profile.countryCode;
        fighter.birthDate = profile.birthDate;
        fighter.record = profile.record;
        fighter.style = profile.style;
      }
    }
  }
}

function boutKey(bout: PflBout): string {
  return [bout.red.profileUrl ?? normalizedName(bout.red.name), bout.blue.profileUrl ?? normalizedName(bout.blue.name)].sort().join("--");
}

export function mergePflEvents(storedEvents: PflEvent[], currentEvents: PflEvent[]): PflEvent[] {
  const merged = new Map(storedEvents.map((event) => [event.uid, event]));
  for (const current of currentEvents) {
    const stored = merged.get(current.uid);
    const currentKeys = new Set(current.bouts.map(boutKey));
    const removed = (stored?.bouts ?? [])
      .filter((bout) => !currentKeys.has(boutKey(bout)))
      .map((bout) => ({ ...bout, note: "Removed from the official PFL card" }));
    const cancelledByKey = new Map([...(stored?.cancelledBouts ?? []), ...removed, ...current.cancelledBouts]
      .map((bout) => [boutKey(bout), bout]));
    merged.set(current.uid, {
      ...stored,
      ...current,
      bouts: current.bouts,
      cancelledBouts: [...cancelledByKey.values()],
    });
  }
  return [...merged.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export async function scrapePflEvents(now = new Date(), options: { pastDays?: number; maxEvents?: number } = {}): Promise<PflEvent[]> {
  const all = parsePflEventListing(await fetchText(PFL_EVENTS_URL), now);
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - (options.pastDays ?? 180));
  const listings = all.filter((listing) => listing.date >= dateOnly(cutoff)).slice(-(options.maxEvents ?? 30));
  return mapWithConcurrency(listings, 4, async (listing) => parsePflEventPage(await fetchText(listing.url), listing));
}

function shortName(name: string): string {
  const parts = cleanText(name).split(" ");
  if (/^(?:jr\.?|sr\.?|ii|iii|iv)$/i.test(parts.at(-1) ?? "") && parts.length > 1) parts.pop();
  return parts.at(-1) || name;
}

function fighterDetail(fighter: PflFighter, eventDate: string, opponentOdds: string | null | undefined): string | null {
  const age = ageOnDate(fighter.birthDate, new Date(`${eventDate}T12:00:00Z`));
  const plausibleAge = age !== null && age >= 16 && age <= 65 ? `${age}yo` : null;
  const odds = formatPromotionOdds(fighter.odds, opponentOdds);
  const details = [fighter.record, plausibleAge, fighter.style, odds].filter(Boolean);
  return details.length ? `• ${shortName(fighter.name)}: ${details.join(" | ")}` : null;
}

function descriptionFor(event: PflEvent, generatedAt: Date): string {
  const boutCount = event.bouts.length === 1 ? "1 announced bout" : `${event.bouts.length} announced bouts`;
  const timing = event.start
    ? "Times display automatically in your calendar time zone. End time is approximate."
    : "Card times have not been announced. This date-only entry will update automatically.";
  const bouts = event.bouts.length
    ? event.bouts.map((bout) => {
      const redFlag = flagEmoji(bout.red.countryCode);
      const blueFlag = flagEmoji(bout.blue.countryCode);
      return [
        `🥊 ${bout.order}. ${unicodeBold(bout.red.name)}${redFlag ? ` ${redFlag}` : ""} vs. ${unicodeBold(bout.blue.name)}${blueFlag ? ` ${blueFlag}` : ""}`,
        bout.details ? `• ${bout.details}` : null,
        fighterDetail(bout.red, event.date, bout.blue.odds),
        fighterDetail(bout.blue, event.date, bout.red.odds),
        formatPromotionOddsHistory(bout.oddsHistory, bout.red.name, bout.blue.name),
      ].filter(Boolean).join("\n");
    }).join("\n\n")
    : "No bouts announced yet.";
  const cancelled = event.cancelledBouts.length ? [
    `--------------------------------\n${unicodeBold("CANCELLED OR POSTPONED BOUTS")}\n--------------------------------`,
    event.cancelledBouts.map((bout) => `✕ ${bout.red.name} vs. ${bout.blue.name}\n• ${bout.note ?? "Removed from the official PFL card"}`).join("\n\n"),
  ] : [];
  const oddsSource = event.bouts.some((bout) => bout.oddsHistory?.length)
    ? `\nOdds source: ${BEST_FIGHT_ODDS_URL} · best available line · checked Monday and Friday`
    : "";
  return [
    [
      `Professional Fighters League · Complete Event · ${event.bouts.length ? boutCount : "card details to be announced"}`,
      `📍 ${event.location || "Venue to be announced"}`,
      timing,
    ].join("\n"),
    `--------------------------------\n${unicodeBold("BOUTS")}\n--------------------------------`,
    bouts,
    ...cancelled,
    `--------------------------------\nSource: ${event.url}${oddsSource}\nCalendar updated: ${generatedAt.toISOString()}`,
  ].join("\n\n");
}

export function renderPflCalendar(events: PflEvent[], generatedAt = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MMA Calendar//Professional Fighters League//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Professional Fighters League",
    "X-WR-CALDESC:PFL events and announced bouts.",
    "COLOR:#102A83",
    "X-APPLE-CALENDAR-COLOR:#102A83",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  const stamp = basicUtc(generatedAt);
  const revision = Math.floor(generatedAt.valueOf() / 1000);
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcs(`${event.uid}@mma-calendar-pfl`)}`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      `SEQUENCE:${revision}`,
    );
    if (event.start && event.end) {
      lines.push(`DTSTART:${event.start}`, `DTEND:${event.end}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(event.date)}`, `DTEND;VALUE=DATE:${compactDate(nextDate(event.date))}`, "TRANSP:TRANSPARENT");
    }
    lines.push(
      `SUMMARY:${escapeIcs(event.summary)}`,
      `DESCRIPTION:${escapeIcs(descriptionFor(event, generatedAt))}`,
      `LOCATION:${escapeIcs(event.location)}`,
      `URL:${escapeIcs(event.url)}`,
      "CATEGORIES:Professional Fighters League",
      `STATUS:${event.status}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
