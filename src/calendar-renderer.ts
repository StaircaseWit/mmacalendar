import { unicodeBold } from "./utils.js";
import { fallbackRevision } from "./revision.js";
import type {
  CalendarBoutModel,
  CalendarCancellationModel,
  CalendarDescriptionModel,
  CalendarEventModel,
  CalendarFeedModel,
} from "./calendar-model.js";

export const SECTION_BORDER = "--------------------------------";
export const BOUTS_HEADING = unicodeBold("BOUTS");

export function escapeCalendarText(value: unknown = ""): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

export function foldCalendarLine(line: string): string {
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

export function calendarUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function compactDate(value: string): string {
  return value.replaceAll("-", "");
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function calendarDateTime(value: Date | string): string {
  return value instanceof Date ? calendarUtc(value) : value;
}

function fighterLabel(fighter: CalendarBoutModel["red"]): string {
  return `${unicodeBold(fighter.name)}${fighter.rank ?? ""}${fighter.flag ? ` ${fighter.flag}` : ""}`;
}

export function renderCalendarBout(bout: CalendarBoutModel): string {
  const order = bout.order === undefined ? "" : `${bout.order}. `;
  const history = bout.oddsHistoryRows?.length
    ? ["• Odds history:", ...bout.oddsHistoryRows.map((row) => `  ◦ ${row}`)]
    : bout.oddsHistoryEmptyText ? [`• Odds history: ${bout.oddsHistoryEmptyText}`] : [];
  return [
    `🥊 ${order}${fighterLabel(bout.red)} vs. ${fighterLabel(bout.blue)}`,
    bout.details ? `• ${bout.details}` : null,
    bout.red.facts.length ? `• ${bout.red.shortName}: ${bout.red.facts.join(" | ")}` : null,
    bout.blue.facts.length ? `• ${bout.blue.shortName}: ${bout.blue.facts.join(" | ")}` : null,
    ...history,
  ].filter(Boolean).join("\n");
}

function renderCancellation(bout: CalendarCancellationModel): string {
  if (bout.layout === "inline") {
    const details = bout.details ? ` · ${bout.details}` : "";
    const note = bout.note ? ` | ${bout.note}` : "";
    return `✕ ${bout.redName} vs. ${bout.blueName}${details}${note}`;
  }
  const details = bout.details ? ` · ${bout.details}` : "";
  return [
    `✕ ${bout.redName} vs. ${bout.blueName}${details}`,
    bout.note ? `• ${bout.note}` : null,
  ].filter(Boolean).join("\n");
}

export function renderCalendarDescription(model: CalendarDescriptionModel): string {
  const sectionBlocks = model.sections.flatMap((section) => {
    const body = section.bouts.length
      ? section.bouts.map(renderCalendarBout).join("\n\n")
      : section.emptyText ?? "";
    if (!section.heading) return body ? [body] : [];
    return [`${unicodeBold(section.heading)}${body ? `\n\n${body}` : ""}`];
  });
  const bouts = sectionBlocks.length ? sectionBlocks : [model.emptyText ?? "No bouts announced yet."];
  const cancellations = model.cancelledBouts?.length ? (() => {
    const inline = model.cancelledBouts.every((bout) => bout.layout === "inline");
    const spacing = inline ? "\n" : "\n\n";
    const heading = `${SECTION_BORDER}\n${unicodeBold(model.cancelledHeading ?? "CANCELLED OR POSTPONED BOUTS")}\n${SECTION_BORDER}`;
    return [`${heading}${spacing}${model.cancelledBouts.map(renderCancellation).join(spacing)}`];
  })() : [];
  return [
    model.overview.join("\n"),
    model.showBoutsHeading === false ? null : `${SECTION_BORDER}\n${BOUTS_HEADING}\n${SECTION_BORDER}`,
    ...bouts,
    ...cancellations,
    model.footer?.length ? `${SECTION_BORDER}\n${model.footer.join("\n")}` : null,
  ].filter(Boolean).join("\n\n");
}

function defaultRevisionContent(event: CalendarEventModel, description: string): unknown {
  return {
    timing: event.timing,
    summary: event.summary,
    description,
    html: event.htmlDescription,
    location: event.location,
    url: event.url,
    categories: event.categories,
    status: event.status,
    relatedTo: event.relatedTo,
  };
}

function eventLines(event: CalendarEventModel, feed: CalendarFeedModel): string[] {
  const description = typeof event.description === "string"
    ? event.description
    : renderCalendarDescription(event.description);
  const revision = feed.revisionProvider?.(
    event.revisionKey,
    event.revisionContent ?? defaultRevisionContent(event, description),
  ) ?? fallbackRevision(feed.generatedAt);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeCalendarText(event.uid)}`,
    `DTSTAMP:${calendarUtc(revision.createdAt)}`,
    `LAST-MODIFIED:${calendarUtc(revision.lastModified)}`,
    `SEQUENCE:${revision.sequence}`,
  ];
  if (event.timing.kind === "timed") {
    lines.push(
      `DTSTART:${calendarDateTime(event.timing.start)}`,
      `DTEND:${calendarDateTime(event.timing.end)}`,
    );
  } else {
    lines.push(
      `DTSTART;VALUE=DATE:${compactDate(event.timing.startDate)}`,
      `DTEND;VALUE=DATE:${compactDate(event.timing.endDate ?? nextDate(event.timing.startDate))}`,
      "TRANSP:TRANSPARENT",
    );
  }
  lines.push(
    `SUMMARY:${escapeCalendarText(event.summary)}`,
    `DESCRIPTION:${escapeCalendarText(description)}`,
  );
  if (event.htmlDescription) {
    lines.push(`X-ALT-DESC;FMTTYPE=text/html:${escapeCalendarText(event.htmlDescription)}`);
  }
  lines.push(
    `LOCATION:${escapeCalendarText(event.location)}`,
    `URL:${escapeCalendarText(event.url)}`,
    `CATEGORIES:${event.categories.map(escapeCalendarText).join(",")}`,
  );
  if (event.relatedTo) lines.push(`RELATED-TO:${escapeCalendarText(event.relatedTo)}`);
  lines.push(`STATUS:${event.status}`, "END:VEVENT");
  return lines;
}

export function renderCalendarFeed(feed: CalendarFeedModel): string {
  const refreshInterval = feed.refreshInterval ?? "PT6H";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${feed.productId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeCalendarText(feed.name)}`,
    `X-WR-CALDESC:${escapeCalendarText(feed.description)}`,
    `COLOR:${feed.color}`,
    `X-APPLE-CALENDAR-COLOR:${feed.color}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${refreshInterval}`,
    `X-PUBLISHED-TTL:${refreshInterval}`,
    ...feed.events.flatMap((event) => eventLines(event, feed)),
    "END:VCALENDAR",
  ];
  return `${lines.map(foldCalendarLine).join("\r\n")}\r\n`;
}
