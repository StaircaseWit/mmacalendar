import * as cheerio from "cheerio";
import { fetchText } from "./http.js";
import { absoluteUrl, cleanText, countryFlags, mapWithConcurrency, normalizedName, unicodeBold } from "./utils.js";
import {
  BEST_FIGHT_ODDS_URL,
  formatPromotionOdds,
  formatPromotionOddsHistory,
  shortPromotionFighterName,
  type PromotionOddsSnapshot,
} from "./promotion-odds.js";

export const ONE_CALENDAR_URL = "https://calendar.onefc.com/ONE-Championship-events.ics";
export const ONE_EVENTS_URL = "https://www.onefc.com/events/";

export interface OneBout {
  redName: string;
  blueName: string;
  details: string;
  redCountry?: string | null;
  blueCountry?: string | null;
  redOdds?: string | null;
  blueOdds?: string | null;
  oddsHistory?: PromotionOddsSnapshot[];
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

export function mergeOneEvents(storedEvents: OneEvent[], currentEvents: OneEvent[]): OneEvent[] {
  const merged = new Map(storedEvents.map((event) => [event.uid, event]));
  for (const event of currentEvents) {
    const stored = merged.get(event.uid);
    const storedBouts = new Map((stored?.bouts ?? []).map((bout) => [oneBoutKey(bout.redName, bout.blueName), bout]));
    const bouts = event.bouts.map((bout) => ({ ...storedBouts.get(oneBoutKey(bout.redName, bout.blueName)), ...bout }));
    merged.set(event.uid, { ...stored, ...event, bouts, detailsUrl: stored?.detailsUrl });
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
    const names = root.find("tr.vs td").toArray().map((cell) => cleanText($(cell).text()));
    const countryRow = root.find("tr").filter((_, row) => cleanText($(row).find("th").text()).toLowerCase() === "country").first();
    const countries = countryRow.find("td").toArray().map((cell) => cleanText($(cell).text()));
    if (!names[0] || !names[1]) return [];
    return [{
      redName: names[0],
      blueName: names[1],
      details: cleanText(root.find(".title").first().text()),
      redCountry: countries[0] || null,
      blueCountry: countries[1] || null,
    }];
  });
}

export async function enrichOneEventDetails(events: OneEvent[], pages = [1, 2, 3]): Promise<OneEvent[]> {
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
  const candidates = events.filter((event) =>
    event.bouts.some((bout) => bout.redCountry === undefined || bout.blueCountry === undefined)
    && urls.has(oneEventKey(event.summary))
  );

  await mapWithConcurrency(candidates, 4, async (event) => {
    const detailsUrl = urls.get(oneEventKey(event.summary))!;
    try {
      const detailedBouts = parseOneEventPage(await fetchText(detailsUrl));
      const byMatchup = new Map(detailedBouts.map((bout) => [oneBoutKey(bout.redName, bout.blueName), bout]));
      event.bouts = event.bouts.map((bout) => ({ ...bout, ...byMatchup.get(oneBoutKey(bout.redName, bout.blueName)) }));
      event.detailsUrl = detailsUrl;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not add ONE Championship fighter countries for ${event.summary}: ${message}`);
    }
  });
  return events;
}

function descriptionFor(event: OneEvent, generatedAt: Date): string {
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
          bout.details ? `• ${bout.details}` : null,
          redOdds ? `• ${shortPromotionFighterName(bout.redName)}: Odds ${redOdds}` : null,
          blueOdds ? `• ${shortPromotionFighterName(bout.blueName)}: Odds ${blueOdds}` : null,
          formatPromotionOddsHistory(bout.oddsHistory, bout.redName, bout.blueName),
        ].filter(Boolean).join("\n");
      }).join("\n\n")
    : "No bouts announced yet.";
  const oddsSource = event.bouts.some((bout) => bout.oddsHistory?.length)
    ? `\nOdds source: ${BEST_FIGHT_ODDS_URL} · best available line · checked weekly`
    : "";
  return [
    header,
    `--------------------------------\n${unicodeBold("BOUTS")}\n--------------------------------`,
    bouts,
    `--------------------------------\nSource: ${event.detailsUrl ?? event.url}${oddsSource}\nCalendar updated: ${generatedAt.toISOString()}`,
  ].join("\n\n");
}

export function renderOneCalendar(events: OneEvent[], generatedAt = new Date()): string {
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
  const stamp = generatedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const revision = Math.floor(generatedAt.valueOf() / 1000);
  for (const event of events) {
    const status = /^(?:CONFIRMED|TENTATIVE|CANCELLED)$/.test(event.status) ? event.status : "CONFIRMED";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcs(`${event.uid}@mma-calendar-one`)}`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      `SEQUENCE:${revision}`,
      `DTSTART:${event.start}`,
      `DTEND:${event.end}`,
      `SUMMARY:${escapeIcs(event.summary)}`,
      `DESCRIPTION:${escapeIcs(descriptionFor(event, generatedAt))}`,
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
