import {
  ageOnDate,
  decimalOdds,
  describeWeightClass,
  flagEmoji,
  formatShortCheckDate,
  normalizedName,
  shortFighterName,
  unicodeBold,
} from "./utils.js";
import type { CardSection, Fight, Fighter, UfcEvent } from "./types.js";

interface RenderCalendarOptions {
  generatedAt?: Date;
  calendarName?: string;
  publicBaseUrl?: string;
  displayTimeZone?: string;
  displayTimeZoneLabel?: string;
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
  let byteLimit = 75;
  for (const character of line) {
    if (Buffer.byteLength(current + character, "utf8") > byteLimit) {
      output.push(current);
      current = ` ${character}`;
      byteLimit = 75;
    } else {
      current += character;
    }
  }
  output.push(current);
  return output.join("\r\n");
}

function icsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function fighterLabel(fighter: Fighter, boldName = false): string {
  const rank = fighter.rank ? ` (#${fighter.rank})` : "";
  const flag = flagEmoji(fighter.countryCode);
  return `${boldName ? unicodeBold(fighter.name) : fighter.name}${rank}${flag ? ` ${flag}` : ""}`;
}

function displayOdds(value: string | null | undefined): string {
  if (!value) return "unavailable";
  const decimal = decimalOdds(value);
  return decimal ? `${value} (${decimal})` : value;
}

function fighterDetail(fighter: Fighter, eventDate: Date): string {
  const record = fighter.record ?? "record unavailable";
  const age = ageOnDate(fighter.birthDate, eventDate);
  return `    ${shortFighterName(fighter)}: ${record} | ${age === null ? "age unavailable" : `${age}yo`} | Odds ${displayOdds(fighter.odds)}`;
}

function localDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(date);
}

function localTime(date: Date, timeZone: string, includeWeekday = false): string {
  return new Intl.DateTimeFormat("en-GB", {
    ...(includeWeekday ? { weekday: "short" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(date);
}

function estimatedFightTime(event: UfcEvent, section: CardSection, sourceIndex: number): Date {
  const end = sectionEnd(event, section);
  const boutNumber = section.fights.length - sourceIndex;
  const interval = (end.valueOf() - section.start!.valueOf()) / Math.max(section.fights.length, 1);
  const estimate = section.start!.valueOf() + (boutNumber - 1) * interval;
  const fiveMinutes = 5 * 60 * 1000;
  return new Date(Math.round(estimate / fiveMinutes) * fiveMinutes);
}

function fightDescription(
  event: UfcEvent,
  section: CardSection,
  fight: Fight,
  sourceIndex: number,
  displayTimeZone: string,
  displayTimeZoneLabel: string,
): string {
  const boutNumber = section.fights.length - sourceIndex;
  const estimate = estimatedFightTime(event, section, sourceIndex);
  const includeWeekday = localDateKey(estimate, displayTimeZone) !== localDateKey(section.start!, displayTimeZone);
  const estimatedLabel = `${localTime(estimate, displayTimeZone, includeWeekday)} ${displayTimeZoneLabel}`;
  const summary = `🥊 ${boutNumber}. ${fighterLabel(fight.red, true)} vs. ${fighterLabel(fight.blue, true)} - ${describeWeightClass(fight.weightClass)} · Est. ${estimatedLabel}`;
  const history = fight.oddsHistory ?? [];
  const historyLines = history.length
    ? ["    Odds history:", ...history.slice(-3).map((snapshot) => {
        const red = snapshot.odds?.[normalizedName(fight.red.name)] ?? "unavailable";
        const blue = snapshot.odds?.[normalizedName(fight.blue.name)] ?? "unavailable";
        return `      ${formatShortCheckDate(snapshot.checkedAt)}: ${shortFighterName(fight.red)} ${displayOdds(red)} | ${shortFighterName(fight.blue)} ${displayOdds(blue)}`;
      }), ...(history.length > 3 ? ["      Earlier changes: see full odds log"] : [])]
    : ["    Odds history: not checked yet"];
  return [summary, fighterDetail(fight.red, section.start!), fighterDetail(fight.blue, section.start!), ...historyLines].join("\n");
}

function sectionEnd(event: UfcEvent, section: CardSection): Date {
  const laterStarts = event.sections
    .map((candidate) => candidate.start)
    .filter((start): start is Date => Boolean(start && section.start && start > section.start))
    .sort((a, b) => a.valueOf() - b.valueOf());
  return laterStarts[0] ?? new Date(section.start!.valueOf() + section.fallbackDurationHours * 60 * 60 * 1000);
}

function htmlEscape(value: unknown): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

function eventOverview(event: UfcEvent, section: CardSection, displayTimeZone: string, displayTimeZoneLabel: string): string[] {
  const end = sectionEnd(event, section);
  const crossesDate = localDateKey(section.start!, displayTimeZone) !== localDateKey(end, displayTimeZone);
  const endLabel = localTime(end, displayTimeZone, crossesDate);
  const boutLabel = section.fights.length === 1 ? "1 bout" : `${section.fights.length} bouts`;
  return [
    `UFC · ${section.label} · ${boutLabel}`,
    `📍 ${event.location || "Venue to be announced"}`,
    `🕒 ${localTime(section.start!, displayTimeZone)}–${endLabel} ${displayTimeZoneLabel}`,
    "Bout times are estimates and may shift as the card progresses.",
  ];
}

function htmlDescription(event: UfcEvent, section: CardSection, generatedAt: Date, publicBaseUrl: string, displayTimeZone: string, displayTimeZoneLabel: string): string {
  const overview = `<p>${eventOverview(event, section, displayTimeZone, displayTimeZoneLabel).map(htmlEscape).join("<br>")}</p>`;
  const fights = section.fights.map((fight, index) => {
    const [matchup = "", ...details] = fightDescription(event, section, fight, index, displayTimeZone, displayTimeZoneLabel).split("\n");
    return `<p><strong>${htmlEscape(matchup)}</strong><br>${details.map((line) => htmlEscape(line.trimStart())).join("<br>")}</p>`;
  }).join("");
  const source = `<p>Source: <a href="${htmlEscape(event.url)}">UFC.com</a>`;
  const oddsLog = publicBaseUrl
    ? `<br>Full odds log: <a href="${htmlEscape(`${publicBaseUrl.replace(/\/$/, "")}/odds-history.html`)}">view history</a>`
    : "";
  return `<html><body>${overview}${fights}${source}${oddsLog}<br>Calendar updated: ${htmlEscape(generatedAt.toISOString())}</p></body></html>`;
}

export function renderCalendar(events: UfcEvent[], {
  generatedAt = new Date(),
  calendarName = "Detailed UFC Calendar",
  publicBaseUrl = "",
  displayTimeZone = "Europe/Dublin",
  displayTimeZoneLabel = "Ireland",
}: RenderCalendarOptions = {}): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Detailed UFC Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(calendarName)}`,
    "X-WR-CALDESC:Automatically updated UFC cards with fighter details and weekly odds history.",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  for (const event of events) {
    for (const section of event.sections) {
      if (!section.start) continue;
      const description = [
        eventOverview(event, section, displayTimeZone, displayTimeZoneLabel).join("\n"),
        ...section.fights.map((fight, index) => fightDescription(event, section, fight, index, displayTimeZone, displayTimeZoneLabel)),
        "",
        `Source: ${event.url}`,
        publicBaseUrl ? `Full odds log: ${publicBaseUrl.replace(/\/$/, "")}/odds-history.html` : "",
        `Calendar updated: ${generatedAt.toISOString()}`,
      ].filter(Boolean).join("\n\n");
      lines.push(
        "BEGIN:VEVENT",
        `UID:${escapeIcs(`${event.slug}-${section.key}@ufc-detailed-calendar`)}`,
        `DTSTAMP:${icsDate(generatedAt)}`,
        `DTSTART:${icsDate(section.start)}`,
        `DTEND:${icsDate(sectionEnd(event, section))}`,
        `SUMMARY:${escapeIcs(`${section.label} – ${event.title}`)}`,
        `DESCRIPTION:${escapeIcs(description)}`,
        `X-ALT-DESC;FMTTYPE=text/html:${escapeIcs(htmlDescription(event, section, generatedAt, publicBaseUrl, displayTimeZone, displayTimeZoneLabel))}`,
        `LOCATION:${escapeIcs(event.location)}`,
        `URL:${escapeIcs(event.url)}`,
        `CATEGORIES:UFC,${escapeIcs(section.label)}`,
        "STATUS:CONFIRMED",
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
