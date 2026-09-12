import { fetchText } from "./http.js";
import { cleanText, unicodeBold } from "./utils.js";

export const ONE_CALENDAR_URL = "https://calendar.onefc.com/ONE-Championship-events.ics";

export interface OneBout {
  redName: string;
  blueName: string;
  details: string;
}

export interface OneEvent {
  uid: string;
  start: string;
  end: string;
  summary: string;
  location: string;
  description: string;
  url: string;
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
  for (const event of currentEvents) merged.set(event.uid, event);
  return [...merged.values()].sort((left, right) => left.start.localeCompare(right.start));
}

export async function scrapeOneCalendar(): Promise<OneEvent[]> {
  return parseOneCalendar(await fetchText(ONE_CALENDAR_URL));
}

function descriptionFor(event: OneEvent, generatedAt: Date): string {
  const header = [
    `ONE Championship · Complete Event · ${event.bouts.length ? `${event.bouts.length} bouts` : "card details to be announced"}`,
    `📍 ${event.location || "Venue to be announced"}`,
    "Times display automatically in your calendar time zone.",
  ].join("\n");
  const bouts = event.bouts.length
    ? event.bouts.map((bout, index) => {
        const number = event.bouts.length - index;
        const details = bout.details ? ` - ${bout.details}` : "";
        return `🥊 ${number}. ${unicodeBold(bout.redName)} vs. ${unicodeBold(bout.blueName)}${details}`;
      }).join("\n\n")
    : "No bouts announced yet.";
  return [
    header,
    "--------------------------------\nBOUTS\n--------------------------------",
    bouts,
    `--------------------------------\nSource: ${event.url}\nCalendar updated: ${generatedAt.toISOString()}`,
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
    "REFRESH-INTERVAL;VALUE=DURATION:P3D",
    "X-PUBLISHED-TTL:P3D",
  ];
  const stamp = generatedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  for (const event of events) {
    const status = /^(?:CONFIRMED|TENTATIVE|CANCELLED)$/.test(event.status) ? event.status : "CONFIRMED";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcs(`${event.uid}@mma-calendar-one`)}`,
      `DTSTAMP:${stamp}`,
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
