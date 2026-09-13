import { applyCancellationOverrides, cachedEvents, persistEventSnapshots, reconcileEvents } from "./events.js";
import { cachedSourceHealth, freshSourceHealth, assertCandidateQuality } from "../../health.js";
import { enrichFighterProfiles } from "./profiles.js";
import {
  validateCancellationOverrides,
  validateEventStore,
  validateFighterStore,
} from "../../schema.js";
import { readJsonValidated, writeJson } from "../../state.js";
import type { EventStore, FighterStore, UfcEvent } from "./types.js";
import { discoverUpcomingEventUrls, scrapeEvent } from "./source.js";
import { mapWithConcurrency } from "../../utils.js";
import { pruneRecordToKeys } from "../../retention.js";
import type { LoadedPromotion, PromotionLoadContext } from "../types.js";
import { sourceErrorMessage } from "../types.js";

export interface LoadedUfcPromotion extends LoadedPromotion<UfcEvent> {
  eventStore: EventStore;
  fighterStore: FighterStore;
}

function ufcStart(event: UfcEvent): Date | null {
  return event.sections
    .map((section) => section.start)
    .filter((start): start is Date => Boolean(start))
    .sort((left, right) => left.valueOf() - right.valueOf())[0] ?? event.heroStart;
}

export async function loadUfcPromotion(context: PromotionLoadContext): Promise<LoadedUfcPromotion> {
  const { now, previousStatus, dataPath, settings } = context;
  const eventStorePath = dataPath("events.json");
  const fighterStorePath = dataPath("fighters.json");
  const eventStore = await readJsonValidated<EventStore>(eventStorePath, { events: {} }, validateEventStore);
  const previousEvents = cachedEvents(eventStore, now);
  const configuredUrls = settings.ufcEventUrls;
  let events: UfcEvent[];
  let health;

  try {
    const eventUrls = configuredUrls.length
      ? configuredUrls
      : await discoverUpcomingEventUrls({
          now,
          pages: settings.ufcEventPages,
          maxEvents: settings.ufcMaxEvents,
          pastDays: settings.ufcPastDays,
        });
    console.log(`Found ${eventUrls.length} recent/upcoming UFC event URL(s).`);
    const results = await mapWithConcurrency(eventUrls, 4, async (url) => {
      try {
        return await scrapeEvent(url);
      } catch (error: unknown) {
        console.warn(`Could not read UFC event ${url}: ${sourceErrorMessage(error)}`);
        return null;
      }
    });
    const scrapedEvents = results
      .filter((event): event is UfcEvent => Boolean(event?.title && event.sections.some((section) => section.start)))
      .sort((left, right) => (left.heroStart?.valueOf() ?? Infinity) - (right.heroStart?.valueOf() ?? Infinity));
    const failedEventPages = results.length - scrapedEvents.length;
    const metrics = assertCandidateQuality("ufc", scrapedEvents, configuredUrls.length ? [] : previousEvents, {
      id: (event) => event.slug,
      date: ufcStart,
      activeBouts: (event) => event.sections.reduce((total, section) => total + section.fights.length, 0),
      cancelledBouts: (event) => event.cancelledBouts?.length ?? 0,
    }, now, settings.ufcPastDays);
    events = reconcileEvents(eventStore, scrapedEvents, now, {
      trackMissing: configuredUrls.length === 0 && failedEventPages === 0,
    });
    health = failedEventPages
      ? cachedSourceHealth(now, previousStatus.sources.ufc, `${failedEventPages} event page(s) failed; stored entries were retained`, metrics.eventCount, metrics.boutCount)
      : freshSourceHealth(now, metrics);
  } catch (error: unknown) {
    if (!previousEvents.length) throw new Error(`UFC calendar could not be generated: ${sourceErrorMessage(error)}`);
    events = previousEvents;
    const boutCount = events.reduce((total, event) => total + event.sections.reduce((sum, section) => sum + section.fights.length, 0), 0);
    health = cachedSourceHealth(now, previousStatus.sources.ufc, sourceErrorMessage(error), events.length, boutCount);
    console.warn(`Keeping the last-known-good UFC calendar: ${sourceErrorMessage(error)}`);
  }

  const cancellationOverrides = await readJsonValidated(
    dataPath("cancellations.json"),
    {},
    validateCancellationOverrides,
  );
  applyCancellationOverrides(events, cancellationOverrides);
  const fighterStore = await readJsonValidated<FighterStore>(fighterStorePath, { fighters: {} }, validateFighterStore);
  await enrichFighterProfiles(events, fighterStore, now);
  persistEventSnapshots(eventStore, events);
  pruneRecordToKeys(fighterStore.fighters, new Set(events.flatMap((event) =>
    event.sections.flatMap((section) => section.fights.flatMap((fight) =>
      [fight.red.profileUrl, fight.blue.profileUrl].filter((url): url is string => Boolean(url))
    ))
  )));

  return {
    id: "ufc",
    events,
    health,
    eventStore,
    fighterStore,
    persist: async () => {
      await Promise.all([
        writeJson(eventStorePath, eventStore),
        writeJson(fighterStorePath, fighterStore),
      ]);
    },
  };
}
