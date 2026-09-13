export type SourceName = "ufc" | "one" | "rizin" | "pfl" | "bestfightodds";

export interface SourceHealth {
  status: "fresh" | "cached" | "failed" | "skipped";
  checkedAt: string;
  lastSuccessAt?: string;
  message?: string;
  eventCount?: number;
  boutCount?: number;
  previousEventCount?: number;
  previousBoutCount?: number;
}

export interface FeedHealth {
  status: "valid" | "invalid";
  eventCount: number;
  bytes: number;
  message?: string;
}

export interface CalendarStatus {
  schemaVersion: 1;
  generatedAt: string;
  overall: "healthy" | "degraded";
  sources: Partial<Record<SourceName, SourceHealth>>;
  feeds: Record<string, FeedHealth>;
}

export interface CandidateAdapter<T> {
  id: (event: T) => string;
  date: (event: T) => Date | null;
  activeBouts: (event: T) => number;
  cancelledBouts?: (event: T) => number;
}

export interface CandidateMetrics {
  eventCount: number;
  boutCount: number;
  previousEventCount: number;
  previousBoutCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function countBouts<T>(events: T[], adapter: CandidateAdapter<T>): number {
  return events.reduce(
    (total, event) =>
      total + adapter.activeBouts(event) + (adapter.cancelledBouts?.(event) ?? 0),
    0,
  );
}

/**
 * Rejects candidates that look like a partial or blocked scrape. Stored data is
 * intentionally compared only within the source's normal rolling window.
 */
export function assertCandidateQuality<T>(
  source: SourceName,
  candidate: T[],
  stored: T[],
  adapter: CandidateAdapter<T>,
  now: Date,
  pastDays: number,
): CandidateMetrics {
  if (candidate.length === 0) {
    throw new Error(`${source} returned no events`);
  }

  const lowerBound = now.getTime() - pastDays * DAY_MS;
  const upperBound = now.getTime() + 730 * DAY_MS;
  const inWindow = (event: T): boolean => {
    const date = adapter.date(event);
    return Boolean(date && Number.isFinite(date.getTime()) && date.getTime() >= lowerBound && date.getTime() <= upperBound);
  };

  const comparableStored = stored.filter(inWindow);
  const candidateIds = new Set<string>();
  for (const event of candidate) {
    const id = adapter.id(event);
    if (!id) throw new Error(`${source} returned an event without an identity`);
    if (candidateIds.has(id)) throw new Error(`${source} returned duplicate event ${id}`);
    candidateIds.add(id);
    const date = adapter.date(event);
    if (!date || !Number.isFinite(date.valueOf())) throw new Error(`${source} returned event ${id} without a valid date`);
  }

  const metrics: CandidateMetrics = {
    eventCount: candidate.length,
    boutCount: countBouts(candidate, adapter),
    previousEventCount: comparableStored.length,
    previousBoutCount: countBouts(comparableStored, adapter),
  };

  if (
    comparableStored.length >= 4 &&
    candidate.length < Math.max(1, Math.floor(comparableStored.length * 0.35))
  ) {
    throw new Error(
      `${source} event count fell from ${comparableStored.length} to ${candidate.length}`,
    );
  }

  const storedById = new Map(comparableStored.map((event) => [adapter.id(event), event]));
  let matchedPreviousBouts = 0;
  let matchedCandidateBouts = 0;
  for (const event of candidate) {
    const previous = storedById.get(adapter.id(event));
    if (!previous) continue;
    const previousActive = adapter.activeBouts(previous);
    const currentActive = adapter.activeBouts(event);
    const currentCancelled = adapter.cancelledBouts?.(event) ?? 0;
    if (previousActive >= 4 && currentActive === 0 && currentCancelled === 0) {
      throw new Error(
        `${source} event ${adapter.id(event)} lost all ${previousActive} active bouts`,
      );
    }
    matchedPreviousBouts += previousActive;
    matchedCandidateBouts += currentActive + currentCancelled;
  }

  if (
    matchedPreviousBouts >= 10 &&
    matchedCandidateBouts < Math.floor(matchedPreviousBouts * 0.4)
  ) {
    throw new Error(
      `${source} matched bout count fell from ${matchedPreviousBouts} to ${matchedCandidateBouts}`,
    );
  }

  return metrics;
}

export function freshSourceHealth(
  checkedAt: Date,
  metrics: CandidateMetrics,
  message?: string,
): SourceHealth {
  const timestamp = checkedAt.toISOString();
  return {
    status: "fresh",
    checkedAt: timestamp,
    lastSuccessAt: timestamp,
    message,
    ...metrics,
  };
}

export function cachedSourceHealth(
  checkedAt: Date,
  previous: SourceHealth | undefined,
  message: string,
  eventCount?: number,
  boutCount?: number,
): SourceHealth {
  return {
    status: "cached",
    checkedAt: checkedAt.toISOString(),
    lastSuccessAt: previous?.lastSuccessAt,
    message,
    eventCount,
    boutCount,
    previousEventCount: previous?.eventCount,
    previousBoutCount: previous?.boutCount,
  };
}
