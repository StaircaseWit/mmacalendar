import { createHash } from "node:crypto";

export interface CalendarEventSnapshot {
  uid: string;
  summary: string;
  semanticHash: string;
}

export interface CalendarDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

function unfoldedLines(contents: string): string[] {
  const lines: string[] = [];
  for (const physical of contents.split(/\r?\n/)) {
    if (/^[ \t]/.test(physical) && lines.length) lines[lines.length - 1] += physical.slice(1);
    else lines.push(physical);
  }
  return lines;
}

function property(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(":");
  if (colon < 1) return null;
  return { name: line.slice(0, colon).split(";", 1)[0]!, value: line.slice(colon + 1) };
}

export function calendarEventSnapshots(contents: string): Map<string, CalendarEventSnapshot> {
  const snapshots = new Map<string, CalendarEventSnapshot>();
  let eventLines: string[] | null = null;
  for (const line of unfoldedLines(contents)) {
    if (line === "BEGIN:VEVENT") {
      eventLines = [];
      continue;
    }
    if (line === "END:VEVENT" && eventLines) {
      const properties = eventLines.map(property).filter((value): value is NonNullable<typeof value> => Boolean(value));
      const uid = properties.find(({ name }) => name === "UID")?.value;
      if (uid) {
        const summary = properties.find(({ name }) => name === "SUMMARY")?.value ?? uid;
        const semantic = properties
          .filter(({ name }) => !["DTSTAMP", "LAST-MODIFIED", "SEQUENCE"].includes(name))
          .map(({ name, value }) => `${name}:${value}`)
          .sort()
          .join("\n");
        snapshots.set(uid, {
          uid,
          summary,
          semanticHash: createHash("sha256").update(semantic).digest("hex"),
        });
      }
      eventLines = null;
      continue;
    }
    if (eventLines) eventLines.push(line);
  }
  return snapshots;
}

export function compareCalendarFeeds(previous: string, next: string): CalendarDiff {
  const before = calendarEventSnapshots(previous);
  const after = calendarEventSnapshots(next);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const [uid, event] of after) {
    const old = before.get(uid);
    if (!old) added.push(event.summary);
    else if (old.semanticHash !== event.semanticHash) changed.push(event.summary);
    else unchanged += 1;
  }
  for (const [uid, event] of before) if (!after.has(uid)) removed.push(event.summary);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged };
}
