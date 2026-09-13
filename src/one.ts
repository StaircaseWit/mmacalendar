import * as cheerio from "cheerio";
import { fetchText } from "./http.js";
import { absoluteUrl, cleanText, countryFlags, normalizedName, unicodeBold } from "./utils.js";
import {
  BEST_FIGHT_ODDS_URL,
  formatPromotionOdds,
  formatPromotionOddsHistory,
  shortPromotionFighterName,
  type PromotionOddsSnapshot,
} from "./promotion-odds.js";
import { fallbackRevision, type RevisionProvider } from "./revision.js";

export const ONE_CALENDAR_URL = "https://calendar.onefc.com/ONE-Championship-events.ics";
export const ONE_EVENTS_URL = "https://www.onefc.com/events/";

export interface OneBout {
  redName: string;
  blueName: string;
  details: string;
  redProfileUrl?: string;
  blueProfileUrl?: string;
  redCountry?: string | null;
  blueCountry?: string | null;
  redAge?: number | null;
  blueAge?: number | null;
  redRecord?: string | null;
  blueRecord?: string | null;
  redStyle?: string | null;
  blueStyle?: string | null;
  redOdds?: string | null;
  blueOdds?: string | null;
  oddsHistory?: PromotionOddsSnapshot[];
}

export interface OneFighterProfile {
  country?: string | null;
  age?: number | null;
  record?: string | null;
  style?: string | null;
  checkedAt: string;
}

export interface OneFighterStore {
  profiles: Record<string, OneFighterProfile>;
}

export interface OneEvent {
  uid: string;
  start: string;
  end: string;
  summary: string;
  location: string;
  description: string;
  url: string;
  detailsUrl?: string;
  status: string;
  bouts: OneBout[];
}

function unfoldIcs(source: string): string[] {
  return source.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
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

function propertyName(line: string): string {
  return line.slice(0, line.indexOf(":"));
}

function propertyValue(line: string): string {
  return unescapeIcs(line.slice(line.indexOf(":") + 1));
}

function parseBouts(description: string): OneBout[] {
  return description.split(/\n{2,}/).flatMap((paragraph) => {
    const text = cleanText(paragraph);
    if (!text.includes("|") || !/\s+vs\.?\s+/i.test(text)) return [];
    const [matchup = "", ...parts] = text.split("|").map(cleanText);
    const names = matchup.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (!names?.[1] || !names[2]) return [];
    const [first = "", second = ""] = parts;
    const disciplineFirst = /^(?:Mixed Martial Arts|Muay Thai|Kickboxing|Submission Grappling|Boxing)$/i.test(first);
    const details = disciplineFirst && second ? `${second} ${first}` : parts.join(" · ");
    return [{ redName: cleanText(names[1]), blueName: cleanText(names[2]), details }];
  });
}

export function parseOneCalendar(source: string): OneEvent[] {
  const events: OneEvent[] = [];
  let properties: Record<string, string> | null = null;
  let insideAlarm = false;

  for (const line of unfoldIcs(source)) {
    if (line === "BEGIN:VEVENT") {
      properties = {};
      continue;
    }
    if (line === "BEGIN:VALARM") {
      insideAlarm = true;
      continue;
    }
    if (line === "END:VALARM") {
      insideAlarm = false;
      continue;
    }
    if (line === "END:VEVENT" && properties) {
      const description = properties.DESCRIPTION ?? "";
      const uid = properties["X-UID"] || properties.UID;
      if (uid && properties.DTSTART && properties.DTEND && properties.SUMMARY) {
        events.push({
          uid,
          start: properties.DTSTART,
          end: properties.DTEND,
          summary: properties.SUMMARY,
          location: properties.LOCATION ?? "",
          description,
          url: properties.URL ?? "https://www.onefc.com/events/",
          status: properties.STATUS ?? "CONFIRMED",
          bouts: parseBouts(description),
        });
      }
      properties = null;
      continue;
    }
    if (!properties || insideAlarm || !line.includes(":")) continue;
    const name = propertyName(line).split(";", 1)[0]!;
    properties[name] = propertyValue(line);
  }

  return events.sort((left, right) => left.start.localeCompare(right.start));
}

function oneStartDate(event: OneEvent): Date | null {
  const match = event.start.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?/);
  if (!match) return null;
  return new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0),
  ));
}

function oneAliasCandidate(storedEvents: OneEvent[], event: OneEvent): OneEvent | undefined {
  const start = oneStartDate(event);
  if (!start) return undefined;
  const candidates = storedEvents.filter((stored) => {
    const storedStart = oneStartDate(stored);
    return oneEventKey(stored.summary) === oneEventKey(event.summary)
      && Boolean(storedStart && Math.abs(storedStart.valueOf() - start.valueOf()) <= 14 * 24 * 60 * 60 * 1000);
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function freezeOneBout(current: OneBout, stored: OneBout | undefined, frozen: boolean): OneBout {
  if (!stored) return current;
  if (!frozen) return { ...stored, ...current };
  return {
    ...current,
    ...stored,
    redName: current.redName,
    blueName: current.blueName,
    details: stored.details || current.details,
  };
}

export function mergeOneEvents(storedEvents: OneEvent[], currentEvents: OneEvent[], now = new Date()): OneEvent[] {
  const merged = new Map(storedEvents.map((event) => [event.uid, event]));
  for (const event of currentEvents) {
    const stored = merged.get(event.uid) ?? oneAliasCandidate(storedEvents, event);
    const uid = stored?.uid ?? event.uid;
    const frozen = Boolean(stored && oneStartDate(stored) && oneStartDate(stored)! <= now);
    const storedBouts = new Map((stored?.bouts ?? []).map((bout) => [oneBoutKey(bout.redName, bout.blueName), bout]));
    const bouts = event.bouts.length
      ? event.bouts.map((bout) => freezeOneBout(bout, storedBouts.get(oneBoutKey(bout.redName, bout.blueName)), frozen))
      : (stored?.bouts ?? []);
    merged.set(uid, { ...stored, ...event, uid, bouts, detailsUrl: event.detailsUrl ?? stored?.detailsUrl });
  }
  return [...merged.values()].sort((left, right) => left.start.localeCompare(right.start));
}

export async function scrapeOneCalendar(): Promise<OneEvent[]> {
  return parseOneCalendar(await fetchText(ONE_CALENDAR_URL));
}

function oneBoutKey(redName: string, blueName: string): string {
  return [normalizedName(redName), normalizedName(blueName)].sort().join("--");
}

function oneEventKey(value: string): string {
  const normalized = normalizedName(value);
  return normalized.match(/one friday fights \d+/)?.[0]
    ?? normalized.match(/one fight night \d+/)?.[0]
    ?? normalized.match(/one samurai \d+/)?.[0]
    ?? normalized.match(/one qatar/)?.[0]
    ?? normalized.split(/[:&]/, 1)[0]!.trim();
}

function eventDistance(start: string, now: Date): number {
  const match = start.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return Number.POSITIVE_INFINITY;
  return Math.abs(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - now.valueOf());
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseOneEventsListing(source: string): Map<string, string> {
  const $ = cheerio.load(source);
  const events = new Map<string, string>();
  $("a.title[href*='/events/']").each((_, link) => {
    const title = cleanText($(link).find("h3").text() || $(link).attr("title") || $(link).text());
    const url = absoluteUrl($(link).attr("href"), "https://www.onefc.com");
    if (title && url) events.set(oneEventKey(title), url);
  });
  return events;
}

export function parseOneEventPage(source: string): OneBout[] {
  const $ = cheerio.load(source);
  return $(".event-matchup").toArray().flatMap((matchup) => {
    const root = $(matchup);
    const nameCells = root.find("tr.vs td").toArray();
    const names = nameCells.map((cell) => cleanText($(cell).text()));
    const profileUrls = nameCells.map((cell) => absoluteUrl($(cell).find("a[href*='/athletes/']").attr("href"), "https://www.onefc.com"));
    const countryRow = root.find("tr").filter((_, row) => cleanText($(row).find("th").text()).toLowerCase() === "country").first();
    const countries = countryRow.find("td").toArray().map((cell) => cleanText($(cell).text()));
    if (!names[0] || !names[1]) return [];
    return [{
      redName: names[0],
      blueName: names[1],
      details: cleanText(root.find(".title").first().text()),
      redProfileUrl: profileUrls[0] ?? undefined,
      blueProfileUrl: profileUrls[1] ?? undefined,
      redCountry: countries[0] || null,
      blueCountry: countries[1] || null,
    }];
  });
}

export async function enrichOneEventDetails(events: OneEvent[], pages = [1, 2, 3], now = new Date()): Promise<OneEvent[]> {
  const listings = await Promise.all(pages.map(async (page) => {
    try {
      return parseOneEventsListing(await fetchText(page === 1 ? ONE_EVENTS_URL : `${ONE_EVENTS_URL}page/${page}/`));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not read ONE Championship events page ${page}: ${message}`);
      return new Map<string, string>();
    }
  }));
  const urls = new Map(listings.flatMap((listing) => [...listing]));
  const candidates = events.filter((event) => {
    const frozen = Boolean(oneStartDate(event) && oneStartDate(event)! <= now);
    const hasHistoricalSnapshot = event.bouts.some((bout) =>
      Boolean(bout.redCountry || bout.blueCountry || bout.redRecord || bout.blueRecord || bout.redAge || bout.blueAge)
    );
    return (!frozen || !hasHistoricalSnapshot)
      && event.bouts.some((bout) => bout.redCountry === undefined || bout.blueCountry === undefined || !bout.redProfileUrl || !bout.blueProfileUrl)
      && urls.has(oneEventKey(event.summary));
  }).sort((left, right) => eventDistance(left.start, now) - eventDistance(right.start, now)).slice(0, 8);

  for (const event of candidates) {
    const detailsUrl = urls.get(oneEventKey(event.summary))!;
    try {
      const detailedBouts = parseOneEventPage(await fetchText(detailsUrl, { attempts: 1 }));
      const byMatchup = new Map(detailedBouts.map((bout) => [oneBoutKey(bout.redName, bout.blueName), bout]));
      event.bouts = event.bouts.map((bout) => ({ ...bout, ...byMatchup.get(oneBoutKey(bout.redName, bout.blueName)) }));
      event.detailsUrl = detailsUrl;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not add ONE Championship fighter countries for ${event.summary}: ${message}`);
      if (message.includes("429 Too Many Requests")) break;
    }
    await pause(750);
  }
  return events;
}

function attributeValue($: cheerio.CheerioAPI, label: string): string {
  const attribute = $(".athlete-banner .attributes .attr").filter((_, element) =>
    cleanText($(element).find(".title").text()).toLowerCase() === label.toLowerCase()
  ).first();
  return cleanText(attribute.find(".value").text());
}

function inferOneStyle(value: string): string | null {
  const text = value.toLowerCase();
  const allRound = /all[- ]round|complete fighter|well[- ]rounded/.test(text);
  const striking = (text.match(/strik|kickbox|boxing|muay thai|karate|punch|kick|elbow|southpaw/g) ?? []).length;
  const grappling = (text.match(/grappl|wrestl|submission|jiu-jitsu|judo|takedown|ground game/g) ?? []).length;
  if (allRound || (striking && grappling && Math.abs(striking - grappling) <= 1)) return "All-rounder";
  if (!striking && !grappling) return null;
  return grappling > striking ? "Grappler" : "Striker";
}

export function parseOneFighterPage(source: string, checkedAt = new Date()): OneFighterProfile {
  const $ = cheerio.load(source);
  const rawAge = Number(attributeValue($, "Age").match(/\d+/)?.[0]);
  const wins = Number(cleanText($(".athlete-bout-breakdown .wins").first().text()).match(/\d+/)?.[0]);
  const losses = Number(cleanText($(".athlete-bout-breakdown .losses").first().text()).match(/\d+/)?.[0]);
  const hasRecord = Number.isFinite(wins) && Number.isFinite(losses);
  const biography = cleanText($(".athlete-banner").nextAll(".container").find(".editor-content").first().text());
  return {
    country: attributeValue($, "Country") || null,
    age: Number.isFinite(rawAge) && rawAge >= 16 && rawAge <= 65 ? rawAge : null,
    record: hasRecord ? `${wins}-${losses}-0` : null,
    style: inferOneStyle(biography),
    checkedAt: checkedAt.toISOString(),
  };
}

function oneProfileIsFresh(profile: OneFighterProfile | undefined, now: Date): boolean {
  if (!profile) return false;
  const checkedAt = new Date(profile.checkedAt);
  return Boolean(profile.country || profile.age || profile.record)
    && Number.isFinite(checkedAt.valueOf())
    && now.valueOf() - checkedAt.valueOf() < 30 * 24 * 60 * 60 * 1000;
}

function disciplineStyle(details: string): string | null {
  if (/submission grappling/i.test(details)) return "Grappler";
  if (/muay thai|kickboxing|boxing/i.test(details)) return "Striker";
  return null;
}

export async function enrichOneFighters(events: OneEvent[], store: OneFighterStore, now = new Date()): Promise<void> {
  store.profiles ??= {};
  const prioritizedEvents = [...events].sort((left, right) => eventDistance(left.start, now) - eventDistance(right.start, now));
  const urls = [...new Set(prioritizedEvents.flatMap((event) => {
    const frozen = Boolean(oneStartDate(event) && oneStartDate(event)! <= now);
    return event.bouts.flatMap((bout) => {
      const hasSnapshot = Boolean(bout.redRecord || bout.redAge || bout.redCountry || bout.blueRecord || bout.blueAge || bout.blueCountry);
      return frozen && hasSnapshot ? [] : [bout.redProfileUrl, bout.blueProfileUrl];
    });
  }).filter((url): url is string => Boolean(url)))];
  const due = urls.filter((url) => !oneProfileIsFresh(store.profiles[url], now)).slice(0, 24);
  for (const url of due) {
    try {
      store.profiles[url] = parseOneFighterPage(await fetchText(url, { attempts: 1 }), now);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not add a ONE Championship fighter profile from ${url}: ${message}`);
      if (message.includes("429 Too Many Requests")) break;
    }
    await pause(750);
  }
  for (const event of events) {
    const frozen = Boolean(oneStartDate(event) && oneStartDate(event)! <= now);
    for (const bout of event.bouts) {
      const red = bout.redProfileUrl ? store.profiles[bout.redProfileUrl] : undefined;
      const blue = bout.blueProfileUrl ? store.profiles[bout.blueProfileUrl] : undefined;
      if (!frozen || !(bout.redRecord || bout.redAge || bout.redCountry)) {
        bout.redCountry = red?.country || bout.redCountry;
        bout.redAge = red?.age ?? bout.redAge;
        bout.redRecord = red?.record ?? bout.redRecord;
        bout.redStyle = disciplineStyle(bout.details) ?? red?.style ?? bout.redStyle;
      }
      if (!frozen || !(bout.blueRecord || bout.blueAge || bout.blueCountry)) {
        bout.blueCountry = blue?.country || bout.blueCountry;
        bout.blueAge = blue?.age ?? bout.blueAge;
        bout.blueRecord = blue?.record ?? bout.blueRecord;
        bout.blueStyle = disciplineStyle(bout.details) ?? blue?.style ?? bout.blueStyle;
      }
    }
  }
}

const ONE_WEIGHT_LIMITS: Array<[RegExp, string]> = [
  [/Light Heavyweight/i, "225lbs/102.1kg Light Heavyweight"],
  [/Heavyweight/i, "265lbs/120.2kg Heavyweight"],
  [/Middleweight/i, "205lbs/93kg Middleweight"],
  [/Welterweight/i, "185lbs/83.9kg Welterweight"],
  [/Lightweight/i, "170lbs/77.1kg Lightweight"],
  [/Featherweight/i, "155lbs/70.3kg Featherweight"],
  [/Bantamweight/i, "145lbs/65.8kg Bantamweight"],
  [/Flyweight/i, "135lbs/61.2kg Flyweight"],
  [/Strawweight/i, "125lbs/56.7kg Strawweight"],
  [/Atomweight/i, "115lbs/52.2kg Atomweight"],
];

export function describeOneBout(details: string): string {
  const value = cleanText(details);
  const pounds = value.match(/\b([\d.]+)\s*LBS\b/i)?.[1];
  if (pounds) {
    const kilograms = (Number(pounds) * 0.45359237).toFixed(1).replace(/\.0$/, "");
    return value.replace(/\b[\d.]+\s*LBS\b/i, `${pounds}lbs/${kilograms}kg`);
  }
  const division = ONE_WEIGHT_LIMITS.find(([pattern]) => pattern.test(value));
  return division ? value.replace(division[0], division[1]) : value;
}

function oneFighterDetail(
  name: string,
  record: string | null | undefined,
  age: number | null | undefined,
  odds: string | null,
  style: string | null | undefined,
): string | null {
  const details = [record ? `ONE ${record}` : null, age ? `${age}yo` : null, style, odds].filter(Boolean);
  return details.length ? `• ${shortPromotionFighterName(name)}: ${details.join(" | ")}` : null;
}

function descriptionFor(event: OneEvent): string {
  const boutCount = event.bouts.length === 1 ? "1 bout" : `${event.bouts.length} bouts`;
  const header = [
    `ONE Championship · Complete Event · ${event.bouts.length ? boutCount : "card details to be announced"}`,
    `📍 ${event.location || "Venue to be announced"}`,
    "Times display automatically in your calendar time zone.",
  ].join("\n");
  const bouts = event.bouts.length
    ? event.bouts.map((bout, index) => {
        const number = event.bouts.length - index;
        const redFlag = countryFlags(bout.redCountry);
        const blueFlag = countryFlags(bout.blueCountry);
        const matchup = `🥊 ${number}. ${unicodeBold(bout.redName)}${redFlag ? ` ${redFlag}` : ""} vs. ${unicodeBold(bout.blueName)}${blueFlag ? ` ${blueFlag}` : ""}`;
        const redOdds = formatPromotionOdds(bout.redOdds, bout.blueOdds);
        const blueOdds = formatPromotionOdds(bout.blueOdds, bout.redOdds);
        return [
          matchup,
          bout.details ? `• ${describeOneBout(bout.details)}` : null,
          oneFighterDetail(bout.redName, bout.redRecord, bout.redAge, redOdds, bout.redStyle),
          oneFighterDetail(bout.blueName, bout.blueRecord, bout.blueAge, blueOdds, bout.blueStyle),
          formatPromotionOddsHistory(bout.oddsHistory, bout.redName, bout.blueName),
        ].filter(Boolean).join("\n");
      }).join("\n\n")
    : "No bouts announced yet.";
  const oddsSource = event.bouts.some((bout) => bout.oddsHistory?.length)
    ? `\nOdds source: ${BEST_FIGHT_ODDS_URL} · best available line · checked Monday and Friday`
    : "";
  return [
    header,
    `--------------------------------\n${unicodeBold("BOUTS")}\n--------------------------------`,
    bouts,
    `--------------------------------\nSource: ${event.detailsUrl ?? event.url}${oddsSource}`,
  ].join("\n\n");
}

export function renderOneCalendar(events: OneEvent[], generatedAt = new Date(), revisionProvider?: RevisionProvider): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MMA Calendar//ONE Championship//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:ONE Championship",
    "X-WR-CALDESC:ONE Championship events and announced bouts.",
    "COLOR:#202428",
    "X-APPLE-CALENDAR-COLOR:#202428",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  for (const event of events) {
    const status = /^(?:CONFIRMED|TENTATIVE|CANCELLED)$/.test(event.status) ? event.status : "CONFIRMED";
    const description = descriptionFor(event);
    const revision = revisionProvider?.(`one:${event.uid}`, {
      start: event.start, end: event.end, summary: event.summary, description,
      location: event.location, url: event.url, status,
    }) ?? fallbackRevision(generatedAt);
    const created = revision.createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const modified = revision.lastModified.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcs(`${event.uid}@mma-calendar-one`)}`,
      `DTSTAMP:${created}`,
      `LAST-MODIFIED:${modified}`,
      `SEQUENCE:${revision.sequence}`,
      `DTSTART:${event.start}`,
      `DTEND:${event.end}`,
      `SUMMARY:${escapeIcs(event.summary)}`,
      `DESCRIPTION:${escapeIcs(description)}`,
      `LOCATION:${escapeIcs(event.location)}`,
      `URL:${escapeIcs(event.url)}`,
      "CATEGORIES:ONE Championship",
      `STATUS:${status}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
