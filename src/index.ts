import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverUpcomingEventUrls, scrapeEvent } from "./ufc.js";
import { mapWithConcurrency } from "./utils.js";
import { attachStoredOdds, oddsRefreshIsDue, updateOddsStore } from "./odds.js";
import { enrichFighterProfiles } from "./profiles.js";
import { readJson, writeJson } from "./state.js";
import { renderCalendar } from "./ics.js";
import { renderOddsPage } from "./odds-page.js";
import type { FighterStore, OddsStore } from "./types.js";

const root = process.cwd();
const outputDirectory = resolve(root, "docs");
const fighterStorePath = resolve(root, "data/fighters.json");
const oddsStorePath = resolve(root, "data/odds-history.json");
const now = new Date();

const configuredUrls = (process.env.UFC_EVENT_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const eventUrls = configuredUrls.length
  ? configuredUrls
  : await discoverUpcomingEventUrls({
      now,
      pages: (process.env.UFC_EVENT_PAGES ?? "0").split(",").map(Number).filter(Number.isFinite),
      maxEvents: Number(process.env.MAX_EVENTS ?? 12),
    });

console.log(`Found ${eventUrls.length} current/upcoming UFC event(s).`);
const events = (await mapWithConcurrency(eventUrls, 4, scrapeEvent))
  .filter((event) => event.title && event.sections.some((section) => section.start))
  .sort((left, right) => (left.heroStart?.valueOf() ?? Infinity) - (right.heroStart?.valueOf() ?? Infinity));
if (!events.length) throw new Error("No usable UFC events were found; the existing published calendar was not overwritten.");

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
await Promise.all([
  writeFile(resolve(outputDirectory, "ufc.ics"), renderCalendar(events, {
    generatedAt: now,
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  })),
  writeFile(resolve(outputDirectory, "odds-history.html"), renderOddsPage(oddsStore)),
]);

const sectionCount = events.reduce((total, event) => total + event.sections.filter((section) => section.start).length, 0);
console.log(`Wrote ${sectionCount} separate card entries to docs/ufc.ics.`);
