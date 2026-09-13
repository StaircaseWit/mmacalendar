import { resolve } from "node:path";
import { discoverUpcomingEventUrls, scrapeEvent } from "./ufc.js";
import { mapWithConcurrency } from "./utils.js";
import { attachStoredOdds, discardPostStartBestFightOddsSnapshots, oddsRefreshIsDue, updateOddsStoreFromBestFightOdds } from "./odds.js";
import { enrichFighterProfiles } from "./profiles.js";
import { applyCancellationOverrides, cachedEvents, persistEventSnapshots, reconcileEvents } from "./events.js";
import { readJson, writeJson, writeText } from "./state.js";
import { renderCalendar, renderCombinedCalendar, renderEstimatedFightCalendar } from "./ics.js";
import { renderOddsPage } from "./odds-page.js";
import { enrichOneEventDetails, enrichOneFighters, mergeOneEvents, renderOneCalendar, scrapeOneCalendar, type OneEvent, type OneFighterStore } from "./one.js";
import { enrichRizinFighters, mergeRizinEvents, renderRizinCalendar, scrapeRizinEvents, type RizinEvent, type RizinFighterStore } from "./rizin.js";
import { enrichPflFighters, mergePflEvents, renderPflCalendar, scrapePflEvents, type PflEvent, type PflFighterStore } from "./pfl.js";
import {
  promotionOddsForBout,
  promotionOddsKey,
  promotionOddsRefreshIsDue,
  compactPromotionOddsStore,
  matchBestFightOddsMarkets,
  migratePromotionOddsStore,
  scrapeBestFightOddsMarkets,
  updatePromotionOddsStore,
  type KnownOddsBout,
  type PromotionOddsStore,
} from "./promotion-odds.js";
import {
  assertCandidateQuality,
  cachedSourceHealth,
  freshSourceHealth,
  type CalendarStatus,
  type SourceHealth,
} from "./health.js";
import { createRevisionProvider, emptyRevisionStore, type RevisionStore } from "./revision.js";
import { assertValidCalendar } from "./validate.js";
import type { CancelledBout, EventStore, FighterStore, OddsStore, UfcEvent } from "./types.js";

const root = process.cwd();
const outputDirectory = resolve(root, "docs");
const dataPath = (name: string) => resolve(root, "data", name);
const fighterStorePath = dataPath("fighters.json");
const oddsStorePath = dataPath("odds-history.json");
const eventStorePath = dataPath("events.json");
const cancellationOverridesPath = dataPath("cancellations.json");
const oneEventStorePath = dataPath("one-events.json");
const oneFighterStorePath = dataPath("one-fighters.json");
const rizinEventStorePath = dataPath("rizin-events.json");
const rizinFighterStorePath = dataPath("rizin-fighters.json");
const pflEventStorePath = dataPath("pfl-events.json");
const pflFighterStorePath = dataPath("pfl-fighters.json");
const promotionOddsStorePath = dataPath("promotion-odds.json");
const revisionStorePath = dataPath("revisions.json");
const statusStorePath = dataPath("status.json");
const now = new Date();
const previousStatus = await readJson<CalendarStatus>(statusStorePath, {
  schemaVersion: 1,
  generatedAt: now.toISOString(),
  overall: "healthy",
  sources: {},
  feeds: {},
});
const sourceHealth: CalendarStatus["sources"] = {};

function sourceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ufcStart(event: UfcEvent): Date | null {
  return event.sections
    .map((section) => section.start)
    .filter((start): start is Date => Boolean(start))
    .sort((left, right) => left.valueOf() - right.valueOf())[0] ?? event.heroStart;
}

function oneDate(event: OneEvent): Date | null {
  const match = event.start.match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
}

function isoDate(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.valueOf()) ? parsed : null;
}

const configuredUrls = (process.env.UFC_EVENT_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const eventStore = await readJson<EventStore>(eventStorePath, { events: {} });
const previousUfcEvents = cachedEvents(eventStore);
let events: UfcEvent[];
try {
  const eventUrls = configuredUrls.length
    ? configuredUrls
    : await discoverUpcomingEventUrls({
        now,
        pages: (process.env.UFC_EVENT_PAGES ?? "0,1,2").split(",").map(Number).filter(Number.isFinite),
        maxEvents: Number(process.env.MAX_EVENTS ?? 50),
        pastDays: Number(process.env.PAST_DAYS ?? 120),
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
  const metrics = assertCandidateQuality(
    "ufc",
    scrapedEvents,
    configuredUrls.length ? [] : previousUfcEvents,
    {
      id: (event) => event.slug,
      date: ufcStart,
      activeBouts: (event) => event.sections.reduce((total, section) => total + section.fights.length, 0),
      cancelledBouts: (event) => event.cancelledBouts?.length ?? 0,
    },
    now,
    Number(process.env.PAST_DAYS ?? 120),
  );
  events = reconcileEvents(eventStore, scrapedEvents, now, {
    trackMissing: configuredUrls.length === 0 && failedEventPages === 0,
  });
  sourceHealth.ufc = failedEventPages
    ? cachedSourceHealth(
        now,
        previousStatus.sources.ufc,
        `${failedEventPages} event page(s) failed; stored entries were retained`,
        metrics.eventCount,
        metrics.boutCount,
      )
    : freshSourceHealth(now, metrics);
} catch (error: unknown) {
  if (!previousUfcEvents.length) throw new Error(`UFC calendar could not be generated: ${sourceErrorMessage(error)}`);
  events = previousUfcEvents;
  const boutCount = events.reduce((total, event) => total + event.sections.reduce((sum, section) => sum + section.fights.length, 0), 0);
  sourceHealth.ufc = cachedSourceHealth(now, previousStatus.sources.ufc, sourceErrorMessage(error), events.length, boutCount);
  console.warn(`Keeping the last-known-good UFC calendar: ${sourceErrorMessage(error)}`);
}

const cancellationOverrides = await readJson<Record<string, CancelledBout[]>>(cancellationOverridesPath, {});
applyCancellationOverrides(events, cancellationOverrides);
const fighterStore = await readJson<FighterStore>(fighterStorePath, { fighters: {} });
await enrichFighterProfiles(events, fighterStore, now);
persistEventSnapshots(eventStore, events);
await Promise.all([writeJson(eventStorePath, eventStore), writeJson(fighterStorePath, fighterStore)]);

const oddsStore = await readJson<OddsStore>(oddsStorePath, { lastCheckedAt: null, fights: {} });
discardPostStartBestFightOddsSnapshots(events, oddsStore);

const storedOneEvents = await readJson<OneEvent[]>(oneEventStorePath, []);
const oneFighterStore = await readJson<OneFighterStore>(oneFighterStorePath, { profiles: {} });
let oneEvents = storedOneEvents;
try {
  const current = await scrapeOneCalendar();
  const metrics = assertCandidateQuality("one", current, storedOneEvents, {
    id: (event) => event.uid,
    date: oneDate,
    activeBouts: (event) => event.bouts.length,
  }, now, 180);
  oneEvents = mergeOneEvents(storedOneEvents, current, now);
  await enrichOneEventDetails(oneEvents, [1, 2, 3], now);
  await enrichOneFighters(oneEvents, oneFighterStore, now);
  await Promise.all([writeJson(oneEventStorePath, oneEvents), writeJson(oneFighterStorePath, oneFighterStore)]);
  sourceHealth.one = freshSourceHealth(now, metrics);
  console.log(`Accepted ${current.length} ONE Championship event(s).`);
} catch (error: unknown) {
  if (!oneEvents.length) throw new Error(`ONE Championship calendar could not be generated: ${sourceErrorMessage(error)}`);
  const bouts = oneEvents.reduce((total, event) => total + event.bouts.length, 0);
  sourceHealth.one = cachedSourceHealth(now, previousStatus.sources.one, sourceErrorMessage(error), oneEvents.length, bouts);
  console.warn(`Keeping the last-known-good ONE Championship calendar: ${sourceErrorMessage(error)}`);
}

const storedRizinEvents = await readJson<RizinEvent[]>(rizinEventStorePath, []);
const rizinFighterStore = await readJson<RizinFighterStore>(rizinFighterStorePath, { profiles: {} });
let rizinEvents = storedRizinEvents;
try {
  const current = await scrapeRizinEvents(now, {
    pastDays: Number(process.env.RIZIN_PAST_DAYS ?? 180),
    maxEvents: Number(process.env.RIZIN_MAX_EVENTS ?? 20),
  });
  const metrics = assertCandidateQuality("rizin", current, storedRizinEvents, {
    id: (event) => event.uid,
    date: (event) => isoDate(event.date),
    activeBouts: (event) => event.bouts.length,
    cancelledBouts: (event) => event.cancelledBouts.length,
  }, now, Number(process.env.RIZIN_PAST_DAYS ?? 180));
  rizinEvents = mergeRizinEvents(storedRizinEvents, current, now);
  await enrichRizinFighters(rizinEvents, rizinFighterStore, now);
  await Promise.all([writeJson(rizinEventStorePath, rizinEvents), writeJson(rizinFighterStorePath, rizinFighterStore)]);
  sourceHealth.rizin = freshSourceHealth(now, metrics);
  console.log(`Accepted ${current.length} RIZIN event(s).`);
} catch (error: unknown) {
  if (!rizinEvents.length) throw new Error(`RIZIN calendar could not be generated: ${sourceErrorMessage(error)}`);
  const bouts = rizinEvents.reduce((total, event) => total + event.bouts.length + event.cancelledBouts.length, 0);
  sourceHealth.rizin = cachedSourceHealth(now, previousStatus.sources.rizin, sourceErrorMessage(error), rizinEvents.length, bouts);
  console.warn(`Keeping the last-known-good RIZIN calendar: ${sourceErrorMessage(error)}`);
}

const storedPflEvents = await readJson<PflEvent[]>(pflEventStorePath, []);
const pflFighterStore = await readJson<PflFighterStore>(pflFighterStorePath, { profiles: {} });
let pflEvents = storedPflEvents;
try {
  const current = await scrapePflEvents(now, {
    pastDays: Number(process.env.PFL_PAST_DAYS ?? 180),
    maxEvents: Number(process.env.PFL_MAX_EVENTS ?? 30),
  });
  const metrics = assertCandidateQuality("pfl", current, storedPflEvents, {
    id: (event) => event.uid,
    date: (event) => isoDate(event.date),
    activeBouts: (event) => event.bouts.length,
    cancelledBouts: (event) => event.cancelledBouts.length,
  }, now, Number(process.env.PFL_PAST_DAYS ?? 180));
  pflEvents = mergePflEvents(storedPflEvents, current, now);
  await enrichPflFighters(pflEvents, pflFighterStore, now);
  await Promise.all([writeJson(pflEventStorePath, pflEvents), writeJson(pflFighterStorePath, pflFighterStore)]);
  sourceHealth.pfl = freshSourceHealth(now, metrics);
  console.log(`Accepted ${current.length} PFL event(s).`);
} catch (error: unknown) {
  if (!pflEvents.length) throw new Error(`PFL calendar could not be generated: ${sourceErrorMessage(error)}`);
  const bouts = pflEvents.reduce((total, event) => total + event.bouts.length + event.cancelledBouts.length, 0);
  sourceHealth.pfl = cachedSourceHealth(now, previousStatus.sources.pfl, sourceErrorMessage(error), pflEvents.length, bouts);
  console.warn(`Keeping the last-known-good PFL calendar: ${sourceErrorMessage(error)}`);
}

const knownBouts: KnownOddsBout[] = [
  ...events.flatMap((event) => event.sections.flatMap((section) => section.fights.map((fight) => ({
    promotion: "ufc", eventId: event.slug, eventName: event.title,
    redName: fight.red.name, blueName: fight.blue.name,
  })))),
  ...oneEvents.flatMap((event) => event.bouts.map((bout) => ({
    promotion: "one", eventId: event.uid, eventName: event.summary,
    redName: bout.redName, blueName: bout.blueName,
  }))),
  ...rizinEvents.flatMap((event) => [...event.bouts, ...event.cancelledBouts].map((bout) => ({
    promotion: "rizin", eventId: event.uid, eventName: event.summary,
    redName: bout.red.name, blueName: bout.blue.name,
  }))),
  ...pflEvents.flatMap((event) => [...event.bouts, ...event.cancelledBouts].map((bout) => ({
    promotion: "pfl", eventId: event.uid, eventName: event.summary,
    redName: bout.red.name, blueName: bout.blue.name,
  }))),
];

const promotionOddsStore = await readJson<PromotionOddsStore>(promotionOddsStorePath, { lastCheckedAt: null, fights: {} });
migratePromotionOddsStore(promotionOddsStore, knownBouts);
compactPromotionOddsStore(promotionOddsStore);
if (oddsRefreshIsDue(oddsStore, now) || promotionOddsRefreshIsDue(promotionOddsStore, now)) {
  try {
    const windowStart = new Date(now.valueOf() - 14 * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(now.valueOf() + 45 * 24 * 60 * 60 * 1000);
    const eventNames = [
      ...events.filter((event) => event.heroStart && event.heroStart >= windowStart && event.heroStart <= windowEnd).map(({ title }) => title),
      ...oneEvents.filter((event) => oneDate(event) && oneDate(event)! >= windowStart && oneDate(event)! <= windowEnd).map(({ summary }) => summary),
      ...rizinEvents.filter((event) => isoDate(event.date) && isoDate(event.date)! >= windowStart && isoDate(event.date)! <= windowEnd).map(({ summary }) => summary),
      ...pflEvents.filter((event) => isoDate(event.date) && isoDate(event.date)! >= windowStart && isoDate(event.date)! <= windowEnd).map(({ summary }) => summary),
    ];
    const markets = matchBestFightOddsMarkets(await scrapeBestFightOddsMarkets(eventNames), knownBouts);
    if (!markets.length) throw new Error("no matching BestFightOdds moneyline markets were found");
    const previousMarketCount = previousStatus.sources.bestfightodds?.boutCount ?? 0;
    if (previousMarketCount >= 10 && markets.length < Math.floor(previousMarketCount * 0.2)) {
      throw new Error(`BestFightOdds market count fell from ${previousMarketCount} to ${markets.length}`);
    }
    const keyFor = (bout: KnownOddsBout) => promotionOddsKey(bout.promotion, bout.eventId, bout.redName, bout.blueName);
    const ufcBoutKeys = new Set(knownBouts.filter(({ promotion }) => promotion === "ufc").map(keyFor));
    const otherBoutKeys = new Set(knownBouts.filter(({ promotion }) => promotion !== "ufc").map(keyFor));
    const ufcMarkets = markets.filter((market) =>
      Boolean(market.eventId && ufcBoutKeys.has(promotionOddsKey("ufc", market.eventId, market.redName, market.blueName)))
    );
    const currentOtherBoutKeys = new Set([
      ...oneEvents.filter((event) => oneDate(event) && oneDate(event)! >= now).flatMap((event) => event.bouts.map((bout) => promotionOddsKey("one", event.uid, bout.redName, bout.blueName))),
      ...rizinEvents.filter((event) => new Date(`${event.date}T23:59:59Z`) >= now).flatMap((event) => [...event.bouts, ...event.cancelledBouts].map((bout) => promotionOddsKey("rizin", event.uid, bout.red.name, bout.blue.name))),
      ...pflEvents.filter((event) => new Date(`${event.date}T23:59:59Z`) >= now).flatMap((event) => [...event.bouts, ...event.cancelledBouts].map((bout) => promotionOddsKey("pfl", event.uid, bout.red.name, bout.blue.name))),
    ]);
    const otherMarkets = markets.filter((market) => {
      if (!market.promotion || !market.eventId || market.promotion === "ufc") return false;
      const key = promotionOddsKey(market.promotion, market.eventId, market.redName, market.blueName);
      return otherBoutKeys.has(key) && (currentOtherBoutKeys.has(key) || !promotionOddsStore.fights[key]?.length);
    });
    updateOddsStoreFromBestFightOdds(oddsStore, events, ufcMarkets, now);
    updatePromotionOddsStore(promotionOddsStore, otherMarkets, now);
    sourceHealth.bestfightodds = {
      status: "fresh", checkedAt: now.toISOString(), lastSuccessAt: now.toISOString(),
      eventCount: new Set(markets.map((market) => `${market.promotion}:${market.eventId}`)).size,
      boutCount: markets.length,
    };
    console.log(`Recorded ${ufcMarkets.length} UFC and ${otherMarkets.length} other matching BestFightOdds market(s).`);
  } catch (error: unknown) {
    sourceHealth.bestfightodds = cachedSourceHealth(
      now,
      previousStatus.sources.bestfightodds,
      sourceErrorMessage(error),
      undefined,
      Object.keys(promotionOddsStore.fights).length,
    );
    console.warn(`Keeping the last-known-good odds: ${sourceErrorMessage(error)}`);
  }
} else {
  sourceHealth.bestfightodds = {
    status: "skipped",
    checkedAt: now.toISOString(),
    lastSuccessAt: previousStatus.sources.bestfightodds?.lastSuccessAt ?? promotionOddsStore.lastCheckedAt ?? undefined,
    message: "Twice-weekly refresh is not due yet",
    boutCount: Object.keys(promotionOddsStore.fights).length,
  };
}

attachStoredOdds(events, oddsStore);
for (const event of oneEvents) {
  for (const bout of event.bouts) Object.assign(bout, promotionOddsForBout("one", event.uid, bout.redName, bout.blueName, promotionOddsStore));
}
for (const event of rizinEvents) {
  for (const bout of [...event.bouts, ...event.cancelledBouts]) {
    const odds = promotionOddsForBout("rizin", event.uid, bout.red.name, bout.blue.name, promotionOddsStore);
    bout.red.odds = odds.redOdds;
    bout.blue.odds = odds.blueOdds;
    bout.oddsHistory = odds.oddsHistory;
  }
}
for (const event of pflEvents) {
  for (const bout of [...event.bouts, ...event.cancelledBouts]) {
    const odds = promotionOddsForBout("pfl", event.uid, bout.red.name, bout.blue.name, promotionOddsStore);
    bout.red.odds = odds.redOdds;
    bout.blue.odds = odds.blueOdds;
    bout.oddsHistory = odds.oddsHistory;
  }
}
await Promise.all([writeJson(oddsStorePath, oddsStore), writeJson(promotionOddsStorePath, promotionOddsStore)]);

const revisionStore = await readJson<RevisionStore>(revisionStorePath, emptyRevisionStore());
const revisionProvider = createRevisionProvider(revisionStore, now);
const calendarOptions = {
  generatedAt: now,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  displayTimeZone: process.env.DISPLAY_TIME_ZONE ?? "Europe/Dublin",
  displayTimeZoneLabel: process.env.DISPLAY_TIME_ZONE_LABEL ?? "Ireland",
  revisionProvider,
};
const feeds = new Map<string, string>([
  ["ufc.ics", renderCalendar(events, calendarOptions)],
  ["ufc-combined.ics", renderCombinedCalendar(events, calendarOptions)],
  ["ufc-fights.ics", renderEstimatedFightCalendar(events, calendarOptions)],
  ["one.ics", renderOneCalendar(oneEvents, now, revisionProvider)],
  ["rizin.ics", renderRizinCalendar(rizinEvents, now, revisionProvider)],
  ["pfl.ics", renderPflCalendar(pflEvents, now, revisionProvider)],
]);
const feedHealth: CalendarStatus["feeds"] = {};
for (const [name, contents] of feeds) feedHealth[name] = assertValidCalendar(name, contents);
const status: CalendarStatus = {
  schemaVersion: 1,
  generatedAt: now.toISOString(),
  overall: Object.values(sourceHealth).some((source: SourceHealth | undefined) => source?.status === "cached" || source?.status === "failed")
    ? "degraded"
    : "healthy",
  sources: sourceHealth,
  feeds: feedHealth,
};

await Promise.all([
  ...[...feeds].map(([name, contents]) => writeText(resolve(outputDirectory, name), contents)),
  writeText(resolve(outputDirectory, "odds-history.html"), renderOddsPage(oddsStore, promotionOddsStore)),
  writeJson(resolve(outputDirectory, "status.json"), status),
  writeJson(statusStorePath, status),
  writeJson(revisionStorePath, revisionStore),
]);

const sectionCount = events.reduce((total, event) => total + event.sections.filter((section) => section.start).length, 0);
console.log(`Published ${feeds.size} validated feeds, including ${sectionCount} separate UFC card entries. Status: ${status.overall}.`);
