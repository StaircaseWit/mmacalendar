import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverUpcomingEventUrls, scrapeEvent } from "./ufc.js";
import { mapWithConcurrency } from "./utils.js";
import { attachStoredOdds, oddsRefreshIsDue, updateOddsStore } from "./odds.js";
import { enrichFighterProfiles } from "./profiles.js";
import { applyCancellationOverrides, reconcileEvents } from "./events.js";
import { readJson, writeJson } from "./state.js";
import { renderCalendar, renderCombinedCalendar, renderEstimatedFightCalendar } from "./ics.js";
import { renderOddsPage } from "./odds-page.js";
import { enrichOneEventDetails, mergeOneEvents, renderOneCalendar, scrapeOneCalendar, type OneEvent } from "./one.js";
import { enrichRizinFighters, mergeRizinEvents, renderRizinCalendar, scrapeRizinEvents, type RizinEvent, type RizinFighterStore } from "./rizin.js";
import { enrichPflFighters, mergePflEvents, renderPflCalendar, scrapePflEvents, type PflEvent, type PflFighterStore } from "./pfl.js";
import {
  promotionOddsForBout,
  promotionOddsKey,
  promotionOddsRefreshIsDue,
  scrapeBestFightOddsMarkets,
  updatePromotionOddsStore,
  type PromotionOddsStore,
} from "./promotion-odds.js";
import type { CancelledBout, EventStore, FighterStore, OddsStore } from "./types.js";

const root = process.cwd();
const outputDirectory = resolve(root, "docs");
const fighterStorePath = resolve(root, "data/fighters.json");
const oddsStorePath = resolve(root, "data/odds-history.json");
const eventStorePath = resolve(root, "data/events.json");
const cancellationOverridesPath = resolve(root, "data/cancellations.json");
const oneEventStorePath = resolve(root, "data/one-events.json");
const rizinEventStorePath = resolve(root, "data/rizin-events.json");
const rizinFighterStorePath = resolve(root, "data/rizin-fighters.json");
const pflEventStorePath = resolve(root, "data/pfl-events.json");
const pflFighterStorePath = resolve(root, "data/pfl-fighters.json");
const promotionOddsStorePath = resolve(root, "data/promotion-odds.json");
const now = new Date();

const configuredUrls = (process.env.UFC_EVENT_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const eventUrls = configuredUrls.length
  ? configuredUrls
  : await discoverUpcomingEventUrls({
      now,
      pages: (process.env.UFC_EVENT_PAGES ?? "0,1,2").split(",").map(Number).filter(Number.isFinite),
      maxEvents: Number(process.env.MAX_EVENTS ?? 50),
      pastDays: Number(process.env.PAST_DAYS ?? 120),
    });

console.log(`Found ${eventUrls.length} recent/upcoming UFC event(s).`);
const scrapedEvents = (await mapWithConcurrency(eventUrls, 4, scrapeEvent))
  .filter((event) => event.title && event.sections.some((section) => section.start))
  .sort((left, right) => (left.heroStart?.valueOf() ?? Infinity) - (right.heroStart?.valueOf() ?? Infinity));
if (!scrapedEvents.length) throw new Error("No usable UFC events were found; the existing published calendar was not overwritten.");

const cancellationOverrides = await readJson<Record<string, CancelledBout[]>>(cancellationOverridesPath, {});
applyCancellationOverrides(scrapedEvents, cancellationOverrides);

const eventStore = await readJson<EventStore>(eventStorePath, { events: {} });
const events = reconcileEvents(eventStore, scrapedEvents, now, { trackMissing: configuredUrls.length === 0 });
await writeJson(eventStorePath, eventStore);

const fighterStore = await readJson<FighterStore>(fighterStorePath, { fighters: {} });
await enrichFighterProfiles(events, fighterStore, now);
await writeJson(fighterStorePath, fighterStore);

const oddsStore = await readJson<OddsStore>(oddsStorePath, { lastCheckedAt: null, fights: {} });
if (oddsRefreshIsDue(oddsStore, now)) {
  updateOddsStore(oddsStore, events, now);
  console.log("Recorded the weekly odds snapshot.");
} else {
  console.log(`Kept the existing odds snapshot from ${oddsStore.lastCheckedAt}.`);
}
attachStoredOdds(events, oddsStore);
await writeJson(oddsStorePath, oddsStore);

const storedOneEvents = await readJson<OneEvent[]>(oneEventStorePath, []);
let oneEvents = storedOneEvents;
try {
  const currentOneEvents = await scrapeOneCalendar();
  if (!currentOneEvents.length) throw new Error("the official calendar did not contain any events");
  oneEvents = mergeOneEvents(storedOneEvents, currentOneEvents);
  await enrichOneEventDetails(oneEvents);
  await writeJson(oneEventStorePath, oneEvents);
  console.log(`Found ${currentOneEvents.length} ONE Championship event(s).`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (!oneEvents.length) throw new Error(`ONE Championship calendar could not be generated: ${message}`);
  console.warn(`Keeping the stored ONE Championship calendar after a source error: ${message}`);
}

const storedRizinEvents = await readJson<RizinEvent[]>(rizinEventStorePath, []);
const rizinFighterStore = await readJson<RizinFighterStore>(rizinFighterStorePath, { profiles: {} });
let rizinEvents = storedRizinEvents;
try {
  const currentRizinEvents = await scrapeRizinEvents(now, {
    pastDays: Number(process.env.RIZIN_PAST_DAYS ?? 180),
    maxEvents: Number(process.env.RIZIN_MAX_EVENTS ?? 20),
  });
  if (!currentRizinEvents.length) throw new Error("the official events page did not contain any recent or upcoming events");
  await enrichRizinFighters(currentRizinEvents, rizinFighterStore, now);
  rizinEvents = mergeRizinEvents(storedRizinEvents, currentRizinEvents);
  await Promise.all([
    writeJson(rizinEventStorePath, rizinEvents),
    writeJson(rizinFighterStorePath, rizinFighterStore),
  ]);
  console.log(`Found ${currentRizinEvents.length} recent/upcoming RIZIN event(s).`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (!rizinEvents.length) throw new Error(`RIZIN calendar could not be generated: ${message}`);
  console.warn(`Keeping the stored RIZIN calendar after a source error: ${message}`);
}

const storedPflEvents = await readJson<PflEvent[]>(pflEventStorePath, []);
const pflFighterStore = await readJson<PflFighterStore>(pflFighterStorePath, { profiles: {} });
let pflEvents = storedPflEvents;
try {
  const currentPflEvents = await scrapePflEvents(now, {
    pastDays: Number(process.env.PFL_PAST_DAYS ?? 180),
    maxEvents: Number(process.env.PFL_MAX_EVENTS ?? 30),
  });
  if (!currentPflEvents.length) throw new Error("the official events page did not contain any recent or upcoming events");
  await enrichPflFighters(currentPflEvents, pflFighterStore, now);
  pflEvents = mergePflEvents(storedPflEvents, currentPflEvents);
  await Promise.all([
    writeJson(pflEventStorePath, pflEvents),
    writeJson(pflFighterStorePath, pflFighterStore),
  ]);
  console.log(`Found ${currentPflEvents.length} recent/upcoming PFL event(s).`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (!pflEvents.length) throw new Error(`PFL calendar could not be generated: ${message}`);
  console.warn(`Keeping the stored PFL calendar after a source error: ${message}`);
}

const promotionOddsStore = await readJson<PromotionOddsStore>(promotionOddsStorePath, { lastCheckedAt: null, fights: {} });
if (promotionOddsRefreshIsDue(promotionOddsStore, now)) {
  try {
    const windowStart = new Date(now.valueOf() - 14 * 24 * 60 * 60 * 1000);
    // The live page supplies most upcoming markets. A modest future window also
    // catches promotion pages that are searchable before they reach that page.
    const windowEnd = new Date(now.valueOf() + 45 * 24 * 60 * 60 * 1000);
    const inOddsWindow = (value: string): boolean => {
      const date = new Date(`${value}T12:00:00Z`);
      return Number.isFinite(date.valueOf()) && date >= windowStart && date <= windowEnd;
    };
    const eventNames = [
      ...oneEvents.filter((event) => inOddsWindow(`${event.start.slice(0, 4)}-${event.start.slice(4, 6)}-${event.start.slice(6, 8)}`)).map(({ summary }) => summary),
      ...rizinEvents.filter((event) => inOddsWindow(event.date)).map(({ summary }) => summary),
      ...pflEvents.filter((event) => inOddsWindow(event.date)).map(({ summary }) => summary),
    ];
    const markets = await scrapeBestFightOddsMarkets(eventNames);
    if (!markets.length) throw new Error("no current moneyline markets were found");
    const knownBoutKeys = new Set([
      ...oneEvents.flatMap((event) => event.bouts.map((bout) => promotionOddsKey(bout.redName, bout.blueName))),
      ...rizinEvents.flatMap((event) => [...event.bouts, ...event.cancelledBouts].map((bout) => promotionOddsKey(bout.red.name, bout.blue.name))),
      ...pflEvents.flatMap((event) => [...event.bouts, ...event.cancelledBouts].map((bout) => promotionOddsKey(bout.red.name, bout.blue.name))),
    ]);
    const matchedMarkets = markets.filter((market) => knownBoutKeys.has(promotionOddsKey(market.redName, market.blueName)));
    updatePromotionOddsStore(promotionOddsStore, matchedMarkets, now);
    await writeJson(promotionOddsStorePath, promotionOddsStore);
    console.log(`Recorded ${matchedMarkets.length} matching weekly non-UFC odds market(s).`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Keeping the stored non-UFC odds after a source error: ${message}`);
  }
} else {
  console.log(`Kept the existing non-UFC odds snapshot from ${promotionOddsStore.lastCheckedAt}.`);
}

for (const event of oneEvents) {
  for (const bout of event.bouts) Object.assign(bout, promotionOddsForBout(bout.redName, bout.blueName, promotionOddsStore));
}
for (const event of rizinEvents) {
  for (const bout of [...event.bouts, ...event.cancelledBouts]) {
    const odds = promotionOddsForBout(bout.red.name, bout.blue.name, promotionOddsStore);
    bout.red.odds = odds.redOdds;
    bout.blue.odds = odds.blueOdds;
    bout.oddsHistory = odds.oddsHistory;
  }
}
for (const event of pflEvents) {
  for (const bout of [...event.bouts, ...event.cancelledBouts]) {
    const odds = promotionOddsForBout(bout.red.name, bout.blue.name, promotionOddsStore);
    bout.red.odds = odds.redOdds;
    bout.blue.odds = odds.blueOdds;
    bout.oddsHistory = odds.oddsHistory;
  }
}

await mkdir(outputDirectory, { recursive: true });
const calendarOptions = {
  generatedAt: now,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  displayTimeZone: process.env.DISPLAY_TIME_ZONE ?? "Europe/Dublin",
  displayTimeZoneLabel: process.env.DISPLAY_TIME_ZONE_LABEL ?? "Ireland",
};
await Promise.all([
  writeFile(resolve(outputDirectory, "ufc.ics"), renderCalendar(events, calendarOptions)),
  writeFile(resolve(outputDirectory, "ufc-combined.ics"), renderCombinedCalendar(events, calendarOptions)),
  writeFile(resolve(outputDirectory, "ufc-fights.ics"), renderEstimatedFightCalendar(events, calendarOptions)),
  writeFile(resolve(outputDirectory, "one.ics"), renderOneCalendar(oneEvents, now)),
  writeFile(resolve(outputDirectory, "rizin.ics"), renderRizinCalendar(rizinEvents, now)),
  writeFile(resolve(outputDirectory, "pfl.ics"), renderPflCalendar(pflEvents, now)),
  writeFile(resolve(outputDirectory, "odds-history.html"), renderOddsPage(oddsStore, promotionOddsStore)),
]);

const sectionCount = events.reduce((total, event) => total + event.sections.filter((section) => section.start).length, 0);
console.log(`Wrote ${sectionCount} separate card entries to docs/ufc.ics.`);
