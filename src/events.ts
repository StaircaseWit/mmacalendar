import type {
  CancelledBout,
  EventScheduleState,
  EventStore,
  StoredUfcEvent,
  TrackedEvent,
  UfcEvent,
} from "./types.js";
import { normalizedName } from "./utils.js";
import { isWithinEventHistory } from "./retention.js";

function boutKey(redName: string, blueName: string): string {
  return [normalizedName(redName), normalizedName(blueName)].sort().join("--");
}

function activeBoutKeys(event: UfcEvent): Set<string> {
  return new Set(event.sections.flatMap(({ fights }) => fights.map(({ red, blue }) => boutKey(red.name, blue.name))));
}

function preserveKnownProfileUrls(event: UfcEvent, previous: UfcEvent | null): void {
  if (!previous) return;
  const previousFights = new Map(
    previous.sections.flatMap(({ fights }) => fights.map((fight) => [boutKey(fight.red.name, fight.blue.name), fight] as const)),
  );

  for (const section of event.sections) {
    for (const fight of section.fights) {
      const previousFight = previousFights.get(boutKey(fight.red.name, fight.blue.name));
      if (!previousFight) continue;
      for (const fighter of [fight.red, fight.blue]) {
        const known = [previousFight.red, previousFight.blue]
          .find((candidate) => normalizedName(candidate.name) === normalizedName(fighter.name));
        if (known?.profileUrl) fighter.profileUrl = known.profileUrl;
      }
    }
  }
}

function preserveStartedFightMetadata(event: UfcEvent, previous: UfcEvent | null, now: Date): void {
  if (!previous || (eventStart(previous)?.valueOf() ?? Infinity) > now.valueOf()) return;
  const previousFights = new Map(
    previous.sections.flatMap(({ fights }) => fights.map((fight) => [boutKey(fight.red.name, fight.blue.name), fight] as const)),
  );
  for (const section of event.sections) {
    for (const fight of section.fights) {
      const knownFight = previousFights.get(boutKey(fight.red.name, fight.blue.name));
      if (!knownFight) continue;
      fight.weightClass = knownFight.weightClass || fight.weightClass;
      for (const fighter of [fight.red, fight.blue]) {
        const known = [knownFight.red, knownFight.blue]
          .find((candidate) => normalizedName(candidate.name) === normalizedName(fighter.name));
        if (!known) continue;
        for (const property of [
          "rank",
          "profileUrl",
          "country",
          "countryCode",
          "record",
          "birthDate",
          "familyName",
          "fightingStyle",
        ] as const) {
          if (known[property] !== undefined && known[property] !== null) {
            (fighter as unknown as Record<string, unknown>)[property] = known[property];
          }
        }
      }
    }
  }
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

export function pruneUfcEventHistory(store: EventStore, now = new Date()): void {
  for (const [slug, tracked] of Object.entries(store.events ?? {})) {
    if (!isWithinEventHistory(eventStart(hydrateEvent(tracked.event)), now)) delete store.events[slug];
  }
}

export function serializeEvent(event: UfcEvent): StoredUfcEvent {
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

export function hydrateEvent(event: StoredUfcEvent): UfcEvent {
  return {
    ...event,
    heroStart: event.heroStart ? new Date(event.heroStart) : null,
    sections: event.sections.map((section) => ({
      ...section,
      start: section.start ? new Date(section.start) : null,
    })),
  };
}

function tokens(value: string): Set<string> {
  return new Set(normalizedName(value).split(/\s+/).filter((token) => token.length > 2));
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? shared / union : 0;
}

function aliasCandidate(store: EventStore, event: UfcEvent): [string, TrackedEvent] | null {
  const directAlias = Object.entries(store.events).find(([, tracked]) => tracked.aliases?.includes(event.slug));
  if (directAlias) return directAlias;
  const currentStart = eventStart(event);
  if (!currentStart) return null;
  const candidates = Object.entries(store.events).filter(([, tracked]) => {
    const previous = hydrateEvent(tracked.event);
    const previousStart = eventStart(previous);
    if (!previousStart || Math.abs(previousStart.valueOf() - currentStart.valueOf()) > 12 * 60 * 60 * 1000) return false;
    const locationsMatch = normalizedName(previous.location) === normalizedName(event.location);
    return locationsMatch && titleSimilarity(previous.title, event.title) >= 0.4;
  });
  return candidates.length === 1 ? candidates[0]! : null;
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
  { trackMissing = true }: { trackMissing?: boolean } = {},
): UfcEvent[] {
  store.events ??= {};
  pruneUfcEventHistory(store, now);
  const checkedAt = now.toISOString();
  const seen = new Set<string>();
  const output: UfcEvent[] = [];

  for (const event of currentEvents) {
    if (!isWithinEventHistory(eventStart(event), now)) continue;
    const sourceSlug = event.slug;
    const matched = store.events[sourceSlug]
      ? [sourceSlug, store.events[sourceSlug]!] as [string, TrackedEvent]
      : aliasCandidate(store, event);
    const storeKey = matched?.[0] ?? sourceSlug;
    const previous = matched?.[1];
    event.slug = storeKey;
    seen.add(storeKey);
    const previousEvent = previous ? hydrateEvent(previous.event) : null;
    preserveKnownProfileUrls(event, previousEvent);
    preserveStartedFightMetadata(event, previousEvent, now);
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

    const aliases = [...new Set([...(previous?.aliases ?? []), ...(sourceSlug === storeKey ? [] : [sourceSlug])])];
    const tracked: TrackedEvent = {
      event: serializeEvent(event),
      ...(aliases.length ? { aliases } : {}),
      status,
      firstSeenAt: previous?.firstSeenAt ?? checkedAt,
      lastSeenAt: checkedAt,
      previousStart: originalStart,
      missingChecks: 0,
    };
    store.events[storeKey] = tracked;
    output.push(attachStatus(event, tracked, checkedAt));
  }

  if (trackMissing) {
    for (const [slug, tracked] of Object.entries(store.events)) {
      if (seen.has(slug)) continue;
      const cached = hydrateEvent(tracked.event);
      const start = eventStart(cached);
      if (!start) {
        delete store.events[slug];
        continue;
      }
      tracked.missingChecks += 1;
      if (
        start > now
        && !["cancelled", "postponed"].includes(tracked.status)
        && tracked.missingChecks >= 2
      ) tracked.status = "unlisted";
      store.events[slug] = tracked;
      output.push(attachStatus(cached, tracked, checkedAt));
    }
  }

  return output.sort((left, right) => (eventStart(left)?.valueOf() ?? Infinity) - (eventStart(right)?.valueOf() ?? Infinity));
}

export function cachedEvents(store: EventStore, now = new Date()): UfcEvent[] {
  pruneUfcEventHistory(store, now);
  return Object.values(store.events)
    .map((tracked) => attachStatus(hydrateEvent(tracked.event), tracked, tracked.lastSeenAt))
    .sort((left, right) => (eventStart(left)?.valueOf() ?? Infinity) - (eventStart(right)?.valueOf() ?? Infinity));
}

export function persistEventSnapshots(store: EventStore, events: UfcEvent[]): void {
  for (const event of events) {
    const tracked = store.events[event.slug];
    if (tracked) tracked.event = serializeEvent(event);
  }
}
