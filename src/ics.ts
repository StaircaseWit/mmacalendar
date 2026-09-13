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
import { BEST_FIGHT_ODDS_URL } from "./promotion-odds.js";
import type { CancelledBout, CardSection, Fight, Fighter, UfcEvent } from "./types.js";

interface RenderCalendarOptions {
  generatedAt?: Date;
  calendarName?: string;
  publicBaseUrl?: string;
  displayTimeZone?: string;
  displayTimeZoneLabel?: string;
}

const SECTION_BORDER = "--------------------------------";
const BOUTS_HEADING = unicodeBold("BOUTS");
const CANCELLED_HEADING = unicodeBold("CANCELLED OR WITHDRAWN BOUTS");

function hasBestFightOddsHistory(fight: Fight): boolean {
  return (fight.oddsHistory ?? []).some((snapshot) => snapshot.sourceUrl?.startsWith(BEST_FIGHT_ODDS_URL));
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
  const rank = fighter.rank ? fighter.rank.toUpperCase() === "C" ? " (C)" : ` (#${fighter.rank})` : "";
  const flag = flagEmoji(fighter.countryCode);
  return `${boldName ? unicodeBold(fighter.name) : fighter.name}${rank}${flag ? ` ${flag}` : ""}`;
}

function displayOdds(value: string | null | undefined): string {
  if (!value) return "unavailable";
  const decimal = decimalOdds(value);
  return decimal ? `${value} (${decimal})` : value;
}

function oddsMarker(value: string | null | undefined, opponentValue: string | null | undefined): string {
  const decimalValue = decimalOdds(value);
  const opponentDecimalValue = decimalOdds(opponentValue);
  if (!decimalValue) return "";
  const decimal = Number(decimalValue);
  const opponentDecimal = opponentDecimalValue ? Number(opponentDecimalValue) : null;
  if (opponentDecimal !== null && decimal !== opponentDecimal) return decimal < opponentDecimal ? "🟢 " : "🔴 ";
  const american = Number(value);
  if (!Number.isFinite(american)) return "";
  return american < 0 ? "🟢 " : "🔴 ";
}

function markedOdds(value: string | null | undefined, opponentValue: string | null | undefined): string {
  return `${oddsMarker(value, opponentValue)}${displayOdds(value)}`;
}

function fighterDetail(fighter: Fighter, _opponent: Fighter, eventDate: Date): string {
  const record = fighter.record ?? "record unavailable";
  const age = ageOnDate(fighter.birthDate, eventDate);
  const details = [
    record,
    age === null ? "age unavailable" : `${age}yo`,
    fighter.fightingStyle,
    fighter.odds ? displayOdds(fighter.odds) : null,
  ].filter(Boolean);
  return `• ${shortFighterName(fighter)}: ${details.join(" | ")}`;
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

function localDate(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "2-digit",
    year: "numeric",
    timeZone,
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(parts.day)} ${months[Number(parts.month) - 1]} ${parts.year}`;
}

function scheduleStatusLine(event: UfcEvent, generatedAt: Date, displayTimeZone: string): string {
  const status = event.scheduleStatus;
  const checkedAt = new Date(status?.checkedAt ?? generatedAt);
  const verified = `verified ${localDate(checkedAt, displayTimeZone)}`;
  switch (status?.state) {
    case "cancelled": return `Event status: Cancelled · ${verified}`;
    case "postponed": return `Event status: Postponed; new date TBD · ${verified}`;
    case "rescheduled": {
      const previous = status.previousStart ? new Date(status.previousStart) : null;
      return `Event status: Rescheduled${previous ? `; previously ${localDate(previous, displayTimeZone)}` : ""} · ${verified}`;
    }
    case "unlisted": return `Event status: No longer listed by UFC; cancellation or postponement not yet confirmed · ${verified}`;
    default: return `Event status: Scheduled · ${verified}`;
  }
}

function calendarEventStatus(event: UfcEvent, provisional = false): "CANCELLED" | "TENTATIVE" | "CONFIRMED" {
  if (event.scheduleStatus?.state === "cancelled") return "CANCELLED";
  if (provisional || ["postponed", "unlisted"].includes(event.scheduleStatus?.state ?? "")) return "TENTATIVE";
  return "CONFIRMED";
}

function estimatedFightTime(event: UfcEvent, section: CardSection, sourceIndex: number): Date {
  const useWholeEventWindow = section.provisional
    && section.fights.length > 0
    && event.sections.some((candidate) => candidate.start && candidate.start < section.start!);
  const start = useWholeEventWindow
    ? event.sections.map(({ start }) => start).filter((value): value is Date => Boolean(value)).sort((a, b) => a.valueOf() - b.valueOf())[0]!
    : section.start!;
  const end = sectionEnd(event, section);
  const boutNumber = section.fights.length - sourceIndex;
  const interval = (end.valueOf() - start.valueOf()) / Math.max(section.fights.length, 1);
  const estimate = start.valueOf() + (boutNumber - 1) * interval;
  const fiveMinutes = 5 * 60 * 1000;
  return new Date(Math.round(estimate / fiveMinutes) * fiveMinutes);
}

function fightDescription(
  _event: UfcEvent,
  section: CardSection,
  fight: Fight,
  sourceIndex: number,
  _displayTimeZone: string,
  _displayTimeZoneLabel: string,
  boutNumberOverride?: number,
): string {
  const boutNumber = boutNumberOverride ?? section.fights.length - sourceIndex;
  const summary = `🥊 ${boutNumber}. ${fighterLabel(fight.red, true)} vs. ${fighterLabel(fight.blue, true)}`;
  const history = fight.oddsHistory ?? [];
  const historyLines = history.length
    ? ["• Odds history:", ...history.slice(-3).map((snapshot) => {
        const red = snapshot.odds?.[normalizedName(fight.red.name)] ?? "unavailable";
        const blue = snapshot.odds?.[normalizedName(fight.blue.name)] ?? "unavailable";
        return `  ◦ ${formatShortCheckDate(snapshot.checkedAt)}: ${shortFighterName(fight.red)} ${markedOdds(red, blue)} | ${shortFighterName(fight.blue)} ${markedOdds(blue, red)}`;
      }), ...(history.length > 3 ? ["  ◦ Earlier changes: see full odds log"] : [])]
    : ["• Odds history: not checked yet"];
  return [
    summary,
    `• ${describeWeightClass(fight.weightClass)}`,
    fighterDetail(fight.red, fight.blue, section.start!),
    fighterDetail(fight.blue, fight.red, section.start!),
    ...historyLines,
  ].join("\n");
}

function cancelledBoutDescription(bout: CancelledBout): string {
  const weight = bout.weightClass ? ` · ${describeWeightClass(bout.weightClass)}` : "";
  const reason = bout.reason ? ` | ${bout.reason}` : "";
  return `✕ ${bout.redName} vs. ${bout.blueName}${weight}${reason}`;
}

function cancelledBoutBlock(event: UfcEvent): string {
  if (!event.cancelledBouts?.length) return "";
  return [
    SECTION_BORDER,
    CANCELLED_HEADING,
    SECTION_BORDER,
    ...event.cancelledBouts.map(cancelledBoutDescription),
  ].join("\n");
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
  const cardStatus = section.provisional
    ? section.fights.length ? `${boutLabel} announced · placement TBD` : "fight card TBD"
    : boutLabel;
  const overview = [
    `UFC · ${section.label} · ${cardStatus}`,
    `📍 ${event.location || "Venue to be announced"}`,
    `🕒 ${localTime(section.start!, displayTimeZone)}–${endLabel} ${displayTimeZoneLabel}`,
  ];
  if (section.provisional) overview.push("This provisional entry updates automatically as UFC finalises the card.");
  return overview;
}

function htmlDescription(event: UfcEvent, section: CardSection, generatedAt: Date, publicBaseUrl: string, displayTimeZone: string, displayTimeZoneLabel: string): string {
  const overview = `<p>${eventOverview(event, section, displayTimeZone, displayTimeZoneLabel).map(htmlEscape).join("<br>")}</p>`;
  const boutsHeading = `<p>${SECTION_BORDER}<br><strong>${BOUTS_HEADING}</strong><br>${SECTION_BORDER}</p>`;
  const fights = section.fights.map((fight, index) => {
    const [matchup = "", ...details] = fightDescription(event, section, fight, index, displayTimeZone, displayTimeZoneLabel).split("\n");
    return `<p><strong>${htmlEscape(matchup)}</strong><br>${details.map((line) => htmlEscape(line.trimStart())).join("<br>")}</p>`;
  }).join("");
  const cancellations = event.cancelledBouts?.length
    ? `<p>${SECTION_BORDER}<br><strong>${CANCELLED_HEADING}</strong><br>${SECTION_BORDER}<br>${event.cancelledBouts.map((bout) => htmlEscape(cancelledBoutDescription(bout))).join("<br>")}</p>`
    : "";
  const hasOdds = section.fights.some(hasBestFightOddsHistory);
  const source = `<p>${SECTION_BORDER}<br>Source: <a href="${htmlEscape(event.url)}">UFC.com</a>${hasOdds ? `<br>Odds source: <a href="${BEST_FIGHT_ODDS_URL}">BestFightOdds</a> · best available line · checked Monday and Friday` : ""}`;
  const oddsLog = publicBaseUrl
    ? `<br>Full odds log: <a href="${htmlEscape(`${publicBaseUrl.replace(/\/$/, "")}/odds-history.html`)}">view history</a>`
    : "";
  return `<html><body>${overview}${boutsHeading}${fights || "<p>No bouts announced yet.</p>"}${cancellations}${source}${oddsLog}<br>Calendar updated: ${htmlEscape(generatedAt.toISOString())}<br>${htmlEscape(scheduleStatusLine(event, generatedAt, displayTimeZone))}</p></body></html>`;
}

export function renderCalendar(events: UfcEvent[], {
  generatedAt = new Date(),
  calendarName = "Detailed UFC Calendar",
  publicBaseUrl = "",
  displayTimeZone = "Europe/Dublin",
  displayTimeZoneLabel = "Ireland",
}: RenderCalendarOptions = {}): string {
  const revision = Math.floor(generatedAt.valueOf() / 1000);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Detailed UFC Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(calendarName)}`,
    "X-WR-CALDESC:Automatically updated UFC cards with fighter details and twice-weekly odds history.",
    "COLOR:#D8070C",
    "X-APPLE-CALENDAR-COLOR:#D8070C",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  for (const event of events) {
    for (const section of event.sections) {
      if (!section.start) continue;
      const description = [
        eventOverview(event, section, displayTimeZone, displayTimeZoneLabel).join("\n"),
        `${SECTION_BORDER}\n${BOUTS_HEADING}\n${SECTION_BORDER}`,
        section.fights.length ? "" : "No bouts announced yet.",
        ...section.fights.map((fight, index) => fightDescription(event, section, fight, index, displayTimeZone, displayTimeZoneLabel)),
        cancelledBoutBlock(event),
        [
          SECTION_BORDER,
          `Source: ${event.url}`,
          section.fights.some(hasBestFightOddsHistory) ? `Odds source: ${BEST_FIGHT_ODDS_URL} · best available line · checked Monday and Friday` : "",
          publicBaseUrl ? `Full odds log: ${publicBaseUrl.replace(/\/$/, "")}/odds-history.html` : "",
          `Calendar updated: ${generatedAt.toISOString()}`,
          scheduleStatusLine(event, generatedAt, displayTimeZone),
        ].filter(Boolean).join("\n"),
      ].filter(Boolean).join("\n\n");
      lines.push(
        "BEGIN:VEVENT",
        `UID:${escapeIcs(`${event.slug}-${section.key}@ufc-detailed-calendar`)}`,
        `DTSTAMP:${icsDate(generatedAt)}`,
        `LAST-MODIFIED:${icsDate(generatedAt)}`,
        `SEQUENCE:${revision}`,
        `DTSTART:${icsDate(section.start)}`,
        `DTEND:${icsDate(sectionEnd(event, section))}`,
        `SUMMARY:${escapeIcs(`${section.label} – ${event.title}`)}`,
        `DESCRIPTION:${escapeIcs(description)}`,
        `X-ALT-DESC;FMTTYPE=text/html:${escapeIcs(htmlDescription(event, section, generatedAt, publicBaseUrl, displayTimeZone, displayTimeZoneLabel))}`,
        `LOCATION:${escapeIcs(event.location)}`,
        `URL:${escapeIcs(event.url)}`,
        `CATEGORIES:UFC,${escapeIcs(section.label)}`,
        `STATUS:${calendarEventStatus(event, Boolean(section.provisional))}`,
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function eventBounds(event: UfcEvent): { start: Date; end: Date } | null {
  const sections = event.sections.filter((section): section is CardSection & { start: Date } => Boolean(section.start));
  if (!sections.length) return null;
  const start = sections.map(({ start }) => start).sort((left, right) => left.valueOf() - right.valueOf())[0]!;
  const end = sections.map((section) => sectionEnd(event, section)).sort((left, right) => right.valueOf() - left.valueOf())[0]!;
  return { start, end };
}

export function renderCombinedCalendar(events: UfcEvent[], {
  generatedAt = new Date(),
  calendarName = "Complete UFC Events",
  publicBaseUrl = "",
  displayTimeZone = "Europe/Dublin",
  displayTimeZoneLabel = "Ireland",
}: RenderCalendarOptions = {}): string {
  const revision = Math.floor(generatedAt.valueOf() / 1000);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Detailed UFC Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(calendarName)}`,
    "X-WR-CALDESC:One complete calendar entry per UFC event with all announced bouts.",
    "COLOR:#D8070C",
    "X-APPLE-CALENDAR-COLOR:#D8070C",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  for (const event of events) {
    const bounds = eventBounds(event);
    if (!bounds) continue;
    const sections = [...event.sections].filter(({ start }) => Boolean(start)).reverse();
    const totalFights = sections.reduce((total, section) => total + section.fights.length, 0);
    let boutNumber = totalFights;
    const crossesDate = localDateKey(bounds.start, displayTimeZone) !== localDateKey(bounds.end, displayTimeZone);
    const sectionBlocks: string[] = [];
    for (const section of sections) {
      const sectionStatus = section.provisional
        ? section.fights.length ? `${section.fights.length} announced · placement TBD` : "fight card TBD"
        : section.fights.length === 1 ? "1 bout" : `${section.fights.length} bouts`;
      sectionBlocks.push(unicodeBold(`── ${section.label.toUpperCase()} · ${sectionStatus} ──`));
      if (!section.fights.length) {
        sectionBlocks.push("No bouts assigned yet.");
        continue;
      }
      for (let index = 0; index < section.fights.length; index += 1) {
        sectionBlocks.push(fightDescription(event, section, section.fights[index]!, index, displayTimeZone, displayTimeZoneLabel, boutNumber));
        boutNumber -= 1;
      }
    }
    const description = [
      [
        `UFC · Complete Event · ${totalFights ? `${totalFights} announced bouts` : "fight card TBD"}`,
        `📍 ${event.location || "Venue to be announced"}`,
        `🕒 ${localTime(bounds.start, displayTimeZone)}–${localTime(bounds.end, displayTimeZone, crossesDate)} ${displayTimeZoneLabel}`,
      ].join("\n"),
      `${SECTION_BORDER}\n${BOUTS_HEADING}\n${SECTION_BORDER}`,
      ...sectionBlocks,
      cancelledBoutBlock(event),
      [
        SECTION_BORDER,
        `Source: ${event.url}`,
        sections.some((section) => section.fights.some(hasBestFightOddsHistory)) ? `Odds source: ${BEST_FIGHT_ODDS_URL} · best available line · checked Monday and Friday` : "",
        publicBaseUrl ? `Full odds log: ${publicBaseUrl.replace(/\/$/, "")}/odds-history.html` : "",
        `Calendar updated: ${generatedAt.toISOString()}`,
        scheduleStatusLine(event, generatedAt, displayTimeZone),
      ].filter(Boolean).join("\n"),
    ].filter(Boolean).join("\n\n");
    const html = `<html><body><p>${htmlEscape(description).replace(/\n/g, "<br>")}</p></body></html>`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcs(`${event.slug}-combined@ufc-detailed-calendar`)}`,
      `DTSTAMP:${icsDate(generatedAt)}`,
      `LAST-MODIFIED:${icsDate(generatedAt)}`,
      `SEQUENCE:${revision}`,
      `DTSTART:${icsDate(bounds.start)}`,
      `DTEND:${icsDate(bounds.end)}`,
      `SUMMARY:${escapeIcs(event.title)}`,
      `DESCRIPTION:${escapeIcs(description)}`,
      `X-ALT-DESC;FMTTYPE=text/html:${escapeIcs(html)}`,
      `LOCATION:${escapeIcs(event.location)}`,
      `URL:${escapeIcs(event.url)}`,
      "CATEGORIES:UFC,Complete Event",
      `STATUS:${calendarEventStatus(event, sections.some(({ provisional }) => provisional))}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function fightUid(event: UfcEvent, fight: Fight): string {
  if (fight.id) return `${event.slug}-fight-${fight.id}@ufc-detailed-calendar`;
  const names = [fight.red.name, fight.blue.name]
    .map(normalizedName)
    .sort()
    .join("-")
    .replace(/[^a-z0-9-]+/g, "-");
  return `${event.slug}-fight-${names}@ufc-detailed-calendar`;
}

export function renderEstimatedFightCalendar(events: UfcEvent[], {
  generatedAt = new Date(),
  calendarName = "UFC Estimated Fight Times",
  publicBaseUrl = "",
  displayTimeZone = "Europe/Dublin",
  displayTimeZoneLabel = "Ireland",
}: RenderCalendarOptions = {}): string {
  const revision = Math.floor(generatedAt.valueOf() / 1000);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Detailed UFC Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(calendarName)}`,
    "X-WR-CALDESC:Optional estimated UFC bout times that adapt to the calendar client's time zone.",
    "COLOR:#D8070C",
    "X-APPLE-CALENDAR-COLOR:#D8070C",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  for (const event of events) {
    for (const section of event.sections) {
      if (!section.start) continue;
      if (sectionEnd(event, section) < generatedAt) continue;
      section.fights.forEach((fight, index) => {
        const boutNumber = section.fights.length - index;
        const start = estimatedFightTime(event, section, index);
        const end = new Date(start.valueOf() + 30 * 60 * 1000);
        const [, ...details] = fightDescription(event, section, fight, index, displayTimeZone, displayTimeZoneLabel).split("\n");
        const description = [
          `Estimated bout time · UFC · ${section.provisional ? "card placement TBD" : section.label}`,
          "The scheduled time may move as earlier fights finish.",
          "",
          ...details,
          "",
          `Event: ${event.title}`,
          `Source: ${event.url}`,
          publicBaseUrl ? `Main calendar: ${publicBaseUrl.replace(/\/$/, "")}/ufc.ics` : "",
          `Calendar updated: ${generatedAt.toISOString()}`,
          scheduleStatusLine(event, generatedAt, displayTimeZone),
        ].filter(Boolean).join("\n");
        lines.push(
          "BEGIN:VEVENT",
          `UID:${escapeIcs(fightUid(event, fight))}`,
          `DTSTAMP:${icsDate(generatedAt)}`,
          `LAST-MODIFIED:${icsDate(generatedAt)}`,
          `SEQUENCE:${revision}`,
          `DTSTART:${icsDate(start)}`,
          `DTEND:${icsDate(end)}`,
          `SUMMARY:${escapeIcs(`🥊 ${boutNumber}. ${fight.red.name} vs. ${fight.blue.name} (estimated)`)}`,
          `DESCRIPTION:${escapeIcs(description)}`,
          `LOCATION:${escapeIcs(event.location)}`,
          `URL:${escapeIcs(event.url)}`,
          `CATEGORIES:UFC,Estimated Fight,${escapeIcs(section.label)}`,
          `RELATED-TO:${escapeIcs(`${event.slug}-${section.key}@ufc-detailed-calendar`)}`,
          `STATUS:${calendarEventStatus(event, true)}`,
          "END:VEVENT",
        );
      });
    }
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
