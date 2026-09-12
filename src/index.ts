import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverUpcomingEventUrls, scrapeEvent } from "./ufc.js";
import { mapWithConcurrency } from "./utils.js";
import { attachStoredOdds, oddsRefreshIsDue, updateOddsStore } from "./odds.js";
import { enrichFighterProfiles } from "./profiles.js";
import { reconcileEvents } from "./events.js";
import { readJson, writeJson } from "./state.js";
import { renderCalendar, renderCombinedCalendar, renderEstimatedFightCalendar } from "./ics.js";
import { renderOddsPage } from "./odds-page.js";
import type { EventStore, FighterStore, OddsStore } from "./types.js";

const root = process.cwd();
const outputDirectory = resolve(root, "docs");
const fighterStorePath = resolve(root, "data/fighters.json");
const oddsStorePath = resolve(root, "data/odds-history.json");
const eventStorePath = resolve(root, "data/events.json");
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
  writeFile(resolve(outputDirectory, "odds-history.html"), renderOddsPage(oddsStore)),
]);

const sectionCount = events.reduce((total, event) => total + event.sections.filter((section) => section.start).length, 0);
console.log(`Wrote ${sectionCount} separate card entries to docs/ufc.ics.`);
