import { Buffer } from "node:buffer";
import type { FeedHealth } from "./health.js";

function unfold(contents: string): string[] {
  const physical = contents.slice(0, -2).split("\r\n");
  const logical: string[] = [];
  for (const line of physical) {
    if (/^[ \t]/.test(line) && logical.length > 0) {
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  return logical;
}

function parseCalendarDate(value: string): number | null {
  const compact = value.replace(/Z$/, "");
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/.exec(compact);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isNaN(timestamp) ? null : timestamp;
}

/** A parser-level check that is deliberately separate from the renderers. */
export function validateCalendar(name: string, contents: string): FeedHealth {
  const bytes = Buffer.byteLength(contents, "utf8");
  try {
    if (!contents.endsWith("\r\n")) throw new Error("missing final CRLF");
    if (!contents.startsWith("BEGIN:VCALENDAR\r\n")) throw new Error("missing VCALENDAR start");
    if (!contents.endsWith("END:VCALENDAR\r\n")) throw new Error("missing VCALENDAR end");
    for (const line of contents.slice(0, -2).split("\r\n")) {
      if (Buffer.byteLength(line, "utf8") > 75) {
        throw new Error("contains a physical line longer than 75 bytes");
      }
    }

    const lines = unfold(contents);
    const uids = new Set<string>();
    let eventCount = 0;
    let event: Record<string, string[]> | null = null;
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") {
        if (event) throw new Error("nested VEVENT");
        event = {};
        continue;
      }
      if (line === "END:VEVENT") {
        if (!event) throw new Error("VEVENT end without start");
        for (const required of ["UID", "SUMMARY", "DTSTART", "DTEND"]) {
          if (event[required]?.length !== 1) throw new Error(`VEVENT requires one ${required}`);
        }
        const uid = event.UID![0]!;
        if (uids.has(uid)) throw new Error(`duplicate UID ${uid}`);
        uids.add(uid);
        const start = parseCalendarDate(event.DTSTART![0]!);
        const end = parseCalendarDate(event.DTEND![0]!);
        if (start === null || end === null || end <= start) {
          throw new Error(`invalid date range for ${uid}`);
        }
        eventCount += 1;
        event = null;
        continue;
      }
      if (!event) continue;
      const colon = line.indexOf(":");
      if (colon < 1) throw new Error("invalid content line");
      const property = line.slice(0, colon).split(";", 1)[0]!;
      const value = line.slice(colon + 1);
      (event[property] ??= []).push(value);
    }
    if (event) throw new Error("unterminated VEVENT");
    if (eventCount === 0) throw new Error("calendar contains no events");
    return { status: "valid", eventCount, bytes };
  } catch (error) {
    return {
      status: "invalid",
      eventCount: 0,
      bytes,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function assertValidCalendar(name: string, contents: string): FeedHealth {
  const result = validateCalendar(name, contents);
  if (result.status === "invalid") {
    throw new Error(`${name} calendar is invalid: ${result.message}`);
  }
  return result;
}

