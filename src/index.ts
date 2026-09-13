import { resolve } from "node:path";
import { cachedSourceHealth, type CalendarStatus, type SourceHealth } from "./health.js";
import { renderOddsPage } from "./odds-page.js";
import {
  discardPostStartBestFightOddsSnapshots,
  oddsRefreshIsDue,
  pruneUfcOddsStore,
  updateOddsStoreFromBestFightOdds,
} from "./promotions/ufc/odds.js";
import {
  compactPromotionOddsStore,
  matchBestFightOddsMarkets,
  migratePromotionOddsStore,
  promotionOddsKey,
  promotionOddsRefreshIsDue,
  prunePromotionOddsStore,
  scrapeBestFightOddsMarkets,
  updatePromotionOddsStore,
  type KnownOddsBout,
  type PromotionOddsStore,
} from "./promotion-odds.js";
import { loadOnePromotion } from "./promotions/one/load.js";
import { loadPflPromotion } from "./promotions/pfl/load.js";
import { loadRizinPromotion } from "./promotions/rizin/load.js";
import { loadUfcPromotion } from "./promotions/ufc/load.js";
import { createPromotionRegistry } from "./promotions/registry.js";
import { sourceErrorMessage, type LoadedPromotion } from "./promotions/types.js";
import { createRevisionProvider, emptyRevisionStore, pruneRevisionStore, type RevisionStore } from "./revision.js";
import {
  validateCalendarStatus,
  validateOddsStore,
  validatePromotionOddsStore,
  validateRevisionStore,
} from "./schema.js";
import { readJsonValidated, writeJson, writeText } from "./state.js";
import { loadRuntimeSettings } from "./settings.js";
import type { OddsStore } from "./promotions/ufc/types.js";
import { assertValidCalendar } from "./validate.js";

const root = process.cwd();
const settings = loadRuntimeSettings();
const outputDirectory = resolve(root, "docs");
const dataPath = (name: string) => resolve(root, "data", name);
const now = new Date();
const defaultStatus: CalendarStatus = {
  schemaVersion: 1,
  generatedAt: now.toISOString(),
  overall: "healthy",
  sources: {},
  feeds: {},
};
const previousStatus = await readJsonValidated(dataPath("status.json"), defaultStatus, validateCalendarStatus);

const loadContext = { now, previousStatus, dataPath, settings };
const [ufc, one, rizin, pfl] = await Promise.all([
  loadUfcPromotion(loadContext),
  loadOnePromotion(loadContext),
  loadRizinPromotion(loadContext),
  loadPflPromotion(loadContext),
]);
const loadedPromotions: LoadedPromotion<unknown>[] = [ufc, one, rizin, pfl];
const sourceHealth = Object.fromEntries(
  loadedPromotions.map(({ id, health }) => [id, health]),
) as CalendarStatus["sources"];

const oddsStorePath = dataPath("odds-history.json");
const promotionOddsStorePath = dataPath("promotion-odds.json");
const oddsStore = await readJsonValidated<OddsStore>(
  oddsStorePath,
  { lastCheckedAt: null, fights: {} },
  validateOddsStore,
);
pruneUfcOddsStore(oddsStore, new Set(ufc.events.map(({ slug }) => slug)));
discardPostStartBestFightOddsSnapshots(ufc.events, oddsStore);

const registry = createPromotionRegistry({
  ufc: ufc.events,
  one: one.events,
  rizin: rizin.events,
  pfl: pfl.events,
  ufcOdds: oddsStore,
});
const knownBouts = registry.knownBouts();
const promotionOddsStore = await readJsonValidated<PromotionOddsStore>(
  promotionOddsStorePath,
  { lastCheckedAt: null, fights: {} },
  validatePromotionOddsStore,
);
migratePromotionOddsStore(promotionOddsStore, knownBouts);
prunePromotionOddsStore(promotionOddsStore, registry.retainedEventKeys());
compactPromotionOddsStore(promotionOddsStore);

if (oddsRefreshIsDue(oddsStore, now) || promotionOddsRefreshIsDue(promotionOddsStore, now)) {
  try {
    const windowStart = new Date(now.valueOf() - 14 * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(now.valueOf() + 45 * 24 * 60 * 60 * 1000);
    const markets = matchBestFightOddsMarkets(
      await scrapeBestFightOddsMarkets(registry.eventNamesBetween(windowStart, windowEnd)),
      knownBouts,
    );
    if (!markets.length) throw new Error("no matching BestFightOdds moneyline markets were found");
    const previousMarketCount = previousStatus.sources.bestfightodds?.boutCount ?? 0;
    if (previousMarketCount >= 10 && markets.length < Math.floor(previousMarketCount * 0.2)) {
      throw new Error(`BestFightOdds market count fell from ${previousMarketCount} to ${markets.length}`);
    }

    const keyFor = (bout: KnownOddsBout) => promotionOddsKey(bout.promotion, bout.eventId, bout.redName, bout.blueName);
    const ufcBoutKeys = new Set(knownBouts.filter(({ promotion }) => promotion === "ufc").map(keyFor));
    const otherBoutKeys = new Set(knownBouts.filter(({ promotion }) => promotion !== "ufc").map(keyFor));
    const currentOtherBoutKeys = registry.currentBoutKeys(now, ["ufc"]);
    const ufcMarkets = markets.filter((market) =>
      Boolean(market.eventId && ufcBoutKeys.has(promotionOddsKey("ufc", market.eventId, market.redName, market.blueName)))
    );
    const otherMarkets = markets.filter((market) => {
      if (!market.promotion || !market.eventId || market.promotion === "ufc") return false;
      const key = promotionOddsKey(market.promotion, market.eventId, market.redName, market.blueName);
      return otherBoutKeys.has(key) && (currentOtherBoutKeys.has(key) || !promotionOddsStore.fights[key]?.length);
    });
    updateOddsStoreFromBestFightOdds(oddsStore, ufc.events, ufcMarkets, now);
    updatePromotionOddsStore(promotionOddsStore, otherMarkets, now);
    sourceHealth.bestfightodds = {
      status: "fresh",
      checkedAt: now.toISOString(),
      lastSuccessAt: now.toISOString(),
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

registry.attachOdds(promotionOddsStore);
const revisionStorePath = dataPath("revisions.json");
const revisionStore = await readJsonValidated<RevisionStore>(revisionStorePath, emptyRevisionStore(), validateRevisionStore);
const usedRevisionKeys = new Set<string>();
const revisionProvider = createRevisionProvider(revisionStore, now, usedRevisionKeys);
const feeds = registry.renderFeeds({
  generatedAt: now,
  publicBaseUrl: settings.publicBaseUrl,
  displayTimeZone: settings.displayTimeZone,
  displayTimeZoneLabel: settings.displayTimeZoneLabel,
  revisionProvider,
});
const feedHealth: CalendarStatus["feeds"] = {};
for (const [name, contents] of feeds) feedHealth[name] = assertValidCalendar(name, contents);
pruneRevisionStore(revisionStore, usedRevisionKeys);
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
  writeJson(dataPath("status.json"), status),
  writeJson(revisionStorePath, revisionStore),
  writeJson(oddsStorePath, oddsStore),
  writeJson(promotionOddsStorePath, promotionOddsStore),
  ...loadedPromotions.map(({ persist }) => persist()),
]);

const sectionCount = ufc.events.reduce((total, event) => total + event.sections.filter((section) => section.start).length, 0);
console.log(`Published ${feeds.size} validated feeds, including ${sectionCount} separate UFC card entries. Status: ${status.overall}.`);
