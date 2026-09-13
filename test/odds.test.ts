import test from "node:test";
import assert from "node:assert/strict";
import { eventHtml } from "./helpers/ufc-fixture.js";
import { parseEventPage } from "../src/promotions/ufc/source.js";
import { attachStoredOdds, discardPostStartBestFightOddsSnapshots, oddsRefreshIsDue, updateOddsStore, updateOddsStoreFromBestFightOdds } from "../src/promotions/ufc/odds.js";
import type { OddsStore } from "../src/promotions/ufc/types.js";
import {
  canonicalOddsName, BEST_FIGHT_ODDS_URL, bestFightOddsSearchTerm, findBestFightOddsEventUrl,
  fighterPairKey, formatPromotionOdds, matchBestFightOddsMarkets, migratePromotionOddsStore,
  parseBestFightOdds, promotionOddsKey, promotionOddsForBout, promotionOddsRefreshIsDue,
  updatePromotionOddsStore, type PromotionOddsStore,
} from "../src/promotion-odds.js";

test("odds are checked on the Monday and Friday cadence and unchanged values do not inflate history", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  const store: OddsStore = { lastCheckedAt: "2026-09-10T12:00:01Z", fights: {}, source: BEST_FIGHT_ODDS_URL };
  assert.equal(oddsRefreshIsDue(store, now), false);
  store.lastCheckedAt = "2026-09-09T12:00:00Z";
  assert.equal(oddsRefreshIsDue(store, now), true);

  const event = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  updateOddsStore(store, [event], now);
  const history = Object.values(store.fights)[0];
  updateOddsStore(store, [event], new Date("2026-09-19T12:00:00Z"));
  assert.equal(history.length, 1);
  event.sections[0].fights[0].red.sourceOdds = "-450";
  updateOddsStore(store, [event], new Date("2026-09-26T12:00:00Z"));
  assert.equal(history.length, 2);
});

test("collects the best available BestFightOdds lines and keeps change-only history", () => {
  const source = `<div class="table-outer-wrapper">
    <div class="table-header"><a href="/events/pfl-test-4000"><h1>PFL Test</h1></a></div>
    <div class="table-inner-wrapper"><table><tbody>
      <tr><th><span class="t-b-fcc">A.J. McKee Jr.</span></th><td><span id="oID1">-138</span></td><td><span id="oID2" class="bestbet">-130</span></td></tr>
      <tr><th><span class="t-b-fcc">Adam Borics</span></th><td><span id="oID3">+104</span></td><td><span id="oID4" class="bestbet">+109</span></td></tr>
    </tbody></table></div>
  </div>`;
  const markets = parseBestFightOdds(source);
  assert.deepEqual(markets, [{
    eventName: "PFL Test",
    sourceUrl: "https://www.bestfightodds.com/events/pfl-test-4000",
    redName: "A.J. McKee Jr.",
    blueName: "Adam Borics",
    redOdds: "-130",
    blueOdds: "+109",
  }]);
  assert.equal(canonicalOddsName("A.J. McKee Jr."), canonicalOddsName("AJ McKee"));
  assert.equal(bestFightOddsSearchTerm("ONE Friday Fights 170 & The Inner Circle 30"), "ONE Friday Fights 170");
  assert.equal(bestFightOddsSearchTerm("超RIZIN.5 浪速の超復活祭り"), "Super RIZIN 5");
  assert.equal(findBestFightOddsEventUrl(
    `<a href="/events/one-friday-fights-169-4300">One Friday Fights 169</a><a href="/events/one-friday-fights-170-4350">One Friday Fights 170</a>`,
    "ONE Friday Fights 170 & The Inner Circle 30",
  ), "https://www.bestfightodds.com/events/one-friday-fights-170-4350");
  assert.equal(formatPromotionOdds("-130", "+109"), "-130 (1.77)");
  assert.equal(formatPromotionOdds("+109", "-130"), "+109 (2.09)");

  assert.deepEqual(matchBestFightOddsMarkets([{
    ...markets[0]!, redName: "Jose Delgado", blueName: "Jean Silva", redOdds: "+325", blueOdds: "-425",
  }], [{ promotion: "ufc", eventId: "noche-test", eventName: "Noche UFC", redName: "Jean Silva", blueName: "Jose Miguel Delgado" }]), [{
    ...markets[0]!, promotion: "ufc", eventId: "noche-test", eventName: "Noche UFC",
    redName: "Jean Silva", blueName: "Jose Miguel Delgado", redOdds: "-425", blueOdds: "+325",
  }]);

  const store: PromotionOddsStore = { lastCheckedAt: null, fights: {} };
  const firstCheck = new Date("2026-09-13T12:00:00Z");
  const pflMarkets = matchBestFightOddsMarkets(markets, [{
    promotion: "pfl", eventId: "pfl-test", eventName: "PFL Test",
    redName: "AJ McKee", blueName: "Adam Borics",
  }]);
  updatePromotionOddsStore(store, pflMarkets, firstCheck);
  assert.equal(promotionOddsRefreshIsDue(store, new Date("2026-09-16T11:59:59Z")), false);
  assert.equal(promotionOddsRefreshIsDue(store, new Date("2026-09-16T12:00:00Z")), true);
  assert.deepEqual(promotionOddsForBout("pfl", "pfl-test", "AJ McKee", "Adam Borics", store), {
    redOdds: "-130",
    blueOdds: "+109",
    oddsHistory: Object.values(store.fights)[0],
  });
  updatePromotionOddsStore(store, pflMarkets, new Date("2026-09-20T12:00:00Z"));
  assert.equal(Object.values(store.fights)[0]!.length, 1);
  pflMarkets[0]!.redOdds = "-125";
  updatePromotionOddsStore(store, pflMarkets, new Date("2026-09-27T12:00:00Z"));
  assert.equal(Object.values(store.fights)[0]!.length, 2);
});

test("stores UFC odds from BestFightOdds using official fighter names", () => {
  const event = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  const store: OddsStore = { lastCheckedAt: null, fights: {} };
  const markets = matchBestFightOddsMarkets([{
    eventName: "UFC Glendale Odds",
    sourceUrl: "https://www.bestfightodds.com/events/ufc-glendale-4328",
    redName: "Jean Silva",
    blueName: "Jose Delgado",
    redOdds: "-425",
    blueOdds: "+325",
  }], [{ promotion: "ufc", eventId: event.slug, eventName: event.title, redName: "Jean Silva", blueName: "Jose Miguel Delgado" }]);
  updateOddsStoreFromBestFightOdds(store, [event], markets, new Date("2026-09-12T12:00:00Z"));
  attachStoredOdds([event], store);
  assert.equal(event.sections[0]!.fights[0]!.red.odds, "-425");
  assert.equal(event.sections[0]!.fights[0]!.blue.odds, "+325");
  assert.equal(store.source, BEST_FIGHT_ODDS_URL);

  const history = Object.values(store.fights)[0]!;
  history.push({ ...history[0]!, checkedAt: "2026-09-13T12:00:00Z", odds: { "jean silva": "-200", "jose miguel delgado": "+170" } });
  discardPostStartBestFightOddsSnapshots([event], store);
  assert.equal(Object.values(store.fights)[0]!.length, 1);
});

test("stores rematch odds under event-specific identities", () => {
  const known = [
    { promotion: "pfl", eventId: "event-one", eventName: "PFL Final 1", redName: "Red Fighter", blueName: "Blue Fighter" },
    { promotion: "pfl", eventId: "event-two", eventName: "PFL Final 2", redName: "Red Fighter", blueName: "Blue Fighter" },
  ];
  const markets = matchBestFightOddsMarkets([
    { eventName: "PFL Final 1", sourceUrl: "https://example.test/1", redName: "Red Fighter", blueName: "Blue Fighter", redOdds: "-120", blueOdds: "+100" },
    { eventName: "PFL Final 2", sourceUrl: "https://example.test/2", redName: "Red Fighter", blueName: "Blue Fighter", redOdds: "+140", blueOdds: "-160" },
  ], known);
  const store: PromotionOddsStore = { lastCheckedAt: null, fights: {} };
  updatePromotionOddsStore(store, markets, new Date("2026-09-13T12:00:00Z"));
  assert.equal(promotionOddsForBout("pfl", "event-one", "Red Fighter", "Blue Fighter", store).redOdds, "-120");
  assert.equal(promotionOddsForBout("pfl", "event-two", "Red Fighter", "Blue Fighter", store).redOdds, "+140");
  assert.notEqual(
    promotionOddsKey("pfl", "event-one", "Red Fighter", "Blue Fighter"),
    promotionOddsKey("pfl", "event-two", "Red Fighter", "Blue Fighter"),
  );

  const legacy: PromotionOddsStore = {
    lastCheckedAt: null,
    fights: {
      [fighterPairKey("Red Fighter", "Blue Fighter")]: [{
        checkedAt: "2026-09-01T12:00:00Z", eventName: "PFL Final 1", sourceUrl: "https://example.test/1",
        odds: { "red fighter": "-110", "blue fighter": "-110" }, names: { "red fighter": "Red Fighter", "blue fighter": "Blue Fighter" },
      }],
    },
  };
  migratePromotionOddsStore(legacy, known);
  assert.ok(legacy.fights[promotionOddsKey("pfl", "event-one", "Red Fighter", "Blue Fighter")]);
});
