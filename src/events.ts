import { DAY_MS } from "./config.js";
import type {
  CancelledBout,
  EventScheduleState,
  EventStore,
  StoredUfcEvent,
  TrackedEvent,
  UfcEvent,
} from "./types.js";
import { normalizedName } from "./utils.js";

function boutKey(redName: string, blueName: string): string {
  return [normalizedName(redName), normalizedName(blueName)].sort().join("--");
}

function activeBoutKeys(event: UfcEvent): Set<string> {
  return new Set(event.sections.flatMap(({ fights }) => fights.map(({ red, blue }) => boutKey(red.name, blue.name))));
}

function mergeCancelledBouts(event: UfcEvent, previous: UfcEvent | null, checkedAt: string): void {
  const active = activeBoutKeys(event);
  const cancelled = new Map<string, CancelledBout>();

  for (const bout of [...(previous?.cancelledBouts ?? []), ...(event.cancelledBouts ?? [])]) {
    const key = boutKey(bout.redName, bout.blueName);
    if (!active.has(key)) cancelled.set(key, bout);
  }

  if (previous) {
    for (const section of previous.sections) {
      for (const fight of section.fights) {
        const key = boutKey(fight.red.name, fight.blue.name);
        if (active.has(key) || cancelled.has(key)) continue;
        cancelled.set(key, {
          id: fight.id,
          redName: fight.red.name,
          blueName: fight.blue.name,
          weightClass: fight.weightClass,
          reason: "Removed from the UFC card",
          detectedAt: checkedAt,
        });
      }
    }
  }

  event.cancelledBouts = [...cancelled.values()];
}

export function applyCancellationOverrides(
  events: UfcEvent[],
  overrides: Record<string, CancelledBout[]>,
): void {
  for (const event of events) {
    const configured = overrides[event.slug] ?? [];
    if (!configured.length) continue;
    const merged = new Map((event.cancelledBouts ?? []).map((bout) => [boutKey(bout.redName, bout.blueName), bout]));
    for (const bout of configured) merged.set(boutKey(bout.redName, bout.blueName), bout);
    event.cancelledBouts = [...merged.values()];
  }
}

function eventStart(event: UfcEvent): Date | null {
  return event.sections
    .map(({ start }) => start)
    .filter((start): start is Date => Boolean(start))
    .sort((left, right) => left.valueOf() - right.valueOf())[0] ?? event.heroStart;
}

function serializeEvent(event: UfcEvent): StoredUfcEvent {
  const { scheduleStatus: _scheduleStatus, ...rest } = event;
  return {
    ...rest,
    heroStart: event.heroStart?.toISOString() ?? null,
    sections: event.sections.map((section) => ({
      ...section,
      start: section.start?.toISOString() ?? null,
    })),
  };
}

function hydrateEvent(event: StoredUfcEvent): UfcEvent {
  return {
    ...event,
    heroStart: event.heroStart ? new Date(event.heroStart) : null,
    sections: event.sections.map((section) => ({
      ...section,
      start: section.start ? new Date(section.start) : null,
    })),
  };
}

function timesDiffer(left: Date | null, right: Date | null): boolean {
  if (!left || !right) return Boolean(left) !== Boolean(right);
  return Math.abs(left.valueOf() - right.valueOf()) >= 5 * 60 * 1000;
}

function attachStatus(event: UfcEvent, tracked: TrackedEvent, checkedAt: string): UfcEvent {
  event.scheduleStatus = {
    state: tracked.status,
    checkedAt,
    previousStart: tracked.previousStart,
    missingChecks: tracked.missingChecks,
  };
  return event;
}

export function reconcileEvents(
  store: EventStore,
  currentEvents: UfcEvent[],
  now = new Date(),
  { trackMissing = true, retentionDays = 120 }: { trackMissing?: boolean; retentionDays?: number } = {},
): UfcEvent[] {
  store.events ??= {};
  const checkedAt = now.toISOString();
  const seen = new Set<string>();
  const output: UfcEvent[] = [];

  for (const event of currentEvents) {
    seen.add(event.slug);
    const previous = store.events[event.slug];
    const previousEvent = previous ? hydrateEvent(previous.event) : null;
    mergeCancelledBouts(event, previousEvent, checkedAt);
    const previousStart = previousEvent ? eventStart(previousEvent) : null;
    const currentStart = eventStart(event);
    let status: EventScheduleState = event.sourceStatus ?? "scheduled";
    let originalStart = previous?.previousStart ?? null;

    if (status === "scheduled" && previous && timesDiffer(previousStart, currentStart)) {
      status = "rescheduled";
      originalStart ??= previousStart?.toISOString() ?? null;
    } else if (status === "scheduled" && previous?.status === "rescheduled") {
      status = "rescheduled";
    }

    const tracked: TrackedEvent = {
      event: serializeEvent(event),
      status,
      firstSeenAt: previous?.firstSeenAt ?? checkedAt,
      lastSeenAt: checkedAt,
      previousStart: originalStart,
      missingChecks: 0,
    };
    store.events[event.slug] = tracked;
    output.push(attachStatus(event, tracked, checkedAt));
  }

  if (trackMissing) {
    for (const [slug, tracked] of Object.entries(store.events)) {
      if (seen.has(slug)) continue;
      const cached = hydrateEvent(tracked.event);
      const start = eventStart(cached);
      if (!start || start.valueOf() < now.valueOf() - retentionDays * DAY_MS) {
        delete store.events[slug];
        continue;
      }
      tracked.missingChecks += 1;
      if (!["cancelled", "postponed"].includes(tracked.status) && tracked.missingChecks >= 2) tracked.status = "unlisted";
      store.events[slug] = tracked;
      output.push(attachStatus(cached, tracked, checkedAt));
    }
  }

  return output.sort((left, right) => (eventStart(left)?.valueOf() ?? Infinity) - (eventStart(right)?.valueOf() ?? Infinity));
}
