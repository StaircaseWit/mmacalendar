import { createHash } from "node:crypto";

export interface RevisionRecord {
  hash: string;
  sequence: number;
  createdAt: string;
  lastModified: string;
}

export interface RevisionStore {
  schemaVersion: 1;
  events: Record<string, RevisionRecord>;
}

export interface RevisionMetadata {
  sequence: number;
  createdAt: Date;
  lastModified: Date;
}

export type RevisionProvider = (key: string, content: unknown) => RevisionMetadata;

export function emptyRevisionStore(): RevisionStore {
  return { schemaVersion: 1, events: {} };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function contentHash(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex");
}

export function createRevisionProvider(store: RevisionStore, now: Date): RevisionProvider {
  return (key, content) => {
    const hash = contentHash(content);
    const previous = store.events[key];
    if (!previous) {
      store.events[key] = {
        hash,
        sequence: 0,
        createdAt: now.toISOString(),
        lastModified: now.toISOString(),
      };
    } else if (previous.hash !== hash) {
      store.events[key] = {
        ...previous,
        hash,
        sequence: previous.sequence + 1,
        lastModified: now.toISOString(),
      };
    }
    const record = store.events[key]!;
    return {
      sequence: record.sequence,
      createdAt: new Date(record.createdAt),
      lastModified: new Date(record.lastModified),
    };
  };
}

export function fallbackRevision(date: Date): RevisionMetadata {
  return { sequence: 0, createdAt: date, lastModified: date };
}

