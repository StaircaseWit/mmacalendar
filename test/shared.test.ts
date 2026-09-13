import test from "node:test";
import assert from "node:assert/strict";
import { ageOnDate, countryFlags, decimalOdds, describeWeightClass, flagEmoji, shortFighterName, unicodeBold } from "../src/utils.js";
import { renderCalendarDescription, renderCalendarFeed } from "../src/calendar-renderer.js";
import type { CalendarDescriptionModel, CalendarEventModel } from "../src/calendar-model.js";
import { eventHistoryCutoff, isWithinEventHistory, pruneRecordToKeys } from "../src/retention.js";
import { mergeOneEvents, parseOneCalendar } from "../src/promotions/one/source.js";
import { mergeRizinEvents } from "../src/promotions/rizin/source.js";
import { mergePflEvents } from "../src/promotions/pfl/source.js";
import { pruneUfcOddsStore } from "../src/promotions/ufc/odds.js";
import { createRevisionProvider, emptyRevisionStore, pruneRevisionStore } from "../src/revision.js";
import { promotionEventKey, prunePromotionOddsStore, type PromotionOddsStore } from "../src/promotion-odds.js";
import type { OddsStore } from "../src/promotions/ufc/types.js";
import { canonicalPublicBaseUrl, loadRuntimeSettings } from "../src/settings.js";

test("uses one canonical runtime configuration in generation and previews", () => {
  assert.equal(
    canonicalPublicBaseUrl("https://StaircaseWit.github.io/mmacalendar/"),
    "https://staircasewit.github.io/mmacalendar",
  );
  const settings = loadRuntimeSettings({
    PUBLIC_BASE_URL: "https://StaircaseWit.github.io/mmacalendar/",
    RIZIN_MAX_EVENTS: "25",
    PFL_PAST_DAYS: "invalid",
  });
  assert.equal(settings.publicBaseUrl, "https://staircasewit.github.io/mmacalendar");
  assert.equal(settings.rizinMaxEvents, 25);
  assert.equal(settings.pflPastDays, 180);
});

test("formats weight and country fields", () => {
  assert.equal(describeWeightClass("Featherweight Bout"), "145lbs/66kg Featherweight");
  assert.equal(describeWeightClass("Featherweight Title Bout"), "145lbs/66kg Featherweight · Title Bout");
  assert.equal(flagEmoji("BR"), "🇧🇷");
  assert.equal(countryFlags("France / Thailand"), "🇫🇷/🇹🇭");
  assert.equal(countryFlags("Myanmar [Burma]"), "🇲🇲");
  assert.equal(decimalOdds("-425"), "1.24");
  assert.equal(decimalOdds("+325"), "4.25");
  assert.equal(ageOnDate("1996-12-13", new Date("2026-09-12T21:00:00Z")), 29);
  assert.equal(shortFighterName({ name: "Raul Rosas Jr." }), "Rosas");
  assert.equal(shortFighterName({ name: "Regina Tarin", familyName: "Malpica Rivera" }), "Tarin");
  assert.equal(unicodeBold("Jean Silva"), "𝗝𝗲𝗮𝗻 𝗦𝗶𝗹𝘃𝗮");
});

test("renders every promotion through the shared calendar model", () => {
  const description: CalendarDescriptionModel = {
    overview: ["Example Promotion · Complete Event · 1 bout", "📍 Test Arena"],
    sections: [{
      heading: "── MAIN CARD · 1 bout ──",
      bouts: [{
        order: 1,
        red: { name: "Red Fighter", shortName: "Fighter", flag: "🇮🇪", facts: ["5-0-0", "Grappler"] },
        blue: { name: "Blue Fighter", shortName: "Fighter", flag: "🇯🇵", facts: ["4-1-0", "Striker"] },
        details: "155lbs/70kg Lightweight",
        oddsHistoryRows: ["13 Sep: Fighter 🟢 -150 (1.67) | Fighter 🔴 +130 (2.30)"],
      }],
    }],
    cancelledBouts: [{ redName: "Old Red", blueName: "Old Blue", note: "Withdrawn", layout: "stacked" }],
    footer: ["Source: https://example.com/event"],
  };
  const events: CalendarEventModel[] = [{
    uid: "timed@example",
    revisionKey: "example:timed",
    timing: { kind: "timed", start: new Date("2026-09-13T12:00:00Z"), end: new Date("2026-09-13T18:00:00Z") },
    summary: "Example, Main Event",
    description,
    location: "Test Arena; Dublin",
    url: "https://example.com/event",
    categories: ["Example Promotion", "Main Card"],
    status: "CONFIRMED",
  }, {
    uid: "placeholder@example",
    revisionKey: "example:placeholder",
    timing: { kind: "all-day", startDate: "2026-10-01" },
    summary: "Future Event",
    description: "Card details to be announced.",
    location: "",
    url: "https://example.com/future",
    categories: ["Example Promotion"],
    status: "TENTATIVE",
  }];
  const output = renderCalendarFeed({
    productId: "-//MMA Calendar//Example Promotion//EN",
    name: "Example Promotion",
    description: "Example events and announced bouts.",
    color: "#123456",
    events,
    generatedAt: new Date("2026-09-13T12:00:00Z"),
  });
  const unfolded = output.replace(/\r\n[ \t]/g, "");

  assert.match(renderCalendarDescription(description), new RegExp(unicodeBold("BOUTS")));
  assert.match(unfolded, /DTSTART:20260913T120000Z/);
  assert.match(unfolded, /DTSTART;VALUE=DATE:20261001/);
  assert.match(unfolded, /DTEND;VALUE=DATE:20261002/);
  assert.match(unfolded, /SUMMARY:Example\\, Main Event/);
  assert.match(unfolded, /LOCATION:Test Arena\\; Dublin/);
  assert.match(unfolded, new RegExp(unicodeBold("CANCELLED OR POSTPONED BOUTS")));
  assert.ok(output.split("\r\n").every((line) => Buffer.byteLength(line, "utf8") <= 75));
});

test("caps promotion history and orphaned cache data at one year", () => {
  const now = new Date("2026-09-13T12:00:00Z");
  assert.equal(eventHistoryCutoff(now).toISOString(), "2025-09-13T12:00:00.000Z");
  assert.equal(eventHistoryCutoff(new Date("2028-02-29T12:00:00Z")).toISOString(), "2027-02-28T12:00:00.000Z");
  assert.equal(isWithinEventHistory(new Date("2025-09-13T12:00:00Z"), now), true);
  assert.equal(isWithinEventHistory(new Date("2025-09-13T11:59:59Z"), now), false);

  const oneBase = parseOneCalendar(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:base\r\nDTSTART:20261001T120000Z\r\nDTEND:20261001T180000Z\r\nSUMMARY:ONE Test\r\nDESCRIPTION:A vs. B | MMA | Flyweight\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0]!;
  const retainedOne = { ...oneBase, uid: "one-retained", start: "20250913T120000Z", end: "20250913T180000Z" };
  const expiredOne = { ...oneBase, uid: "one-expired", start: "20250913T115959Z", end: "20250913T175959Z" };
  assert.deepEqual(mergeOneEvents([expiredOne, retainedOne], [], now).map(({ uid }) => uid), ["one-retained"]);

  const rizinBase = {
    uid: "rizin-retained", date: "2025-09-13", start: null, end: null,
    summary: "RIZIN Test", location: "", url: "https://example.test/rizin",
    status: "TENTATIVE" as const, timeIsTentative: true, bouts: [], cancelledBouts: [],
  };
  assert.deepEqual(mergeRizinEvents([
    { ...rizinBase, uid: "rizin-expired", date: "2025-09-12" },
    rizinBase,
  ], [], now).map(({ uid }) => uid), ["rizin-retained"]);

  const pflBase = {
    uid: "pfl-retained", date: "2025-09-13", start: null, end: null,
    summary: "PFL Test", location: "", url: "https://example.test/pfl",
    status: "TENTATIVE" as const, bouts: [], cancelledBouts: [],
  };
  assert.deepEqual(mergePflEvents([
    { ...pflBase, uid: "pfl-expired", date: "2025-09-12" },
    pflBase,
  ], [], now).map(({ uid }) => uid), ["pfl-retained"]);

  const ufcOdds: OddsStore = {
    lastCheckedAt: null,
    fights: { "retained::a--b": [], "expired::c--d": [] },
  };
  pruneUfcOddsStore(ufcOdds, new Set(["retained"]));
  assert.deepEqual(Object.keys(ufcOdds.fights), ["retained::a--b"]);

  const promotionOdds: PromotionOddsStore = {
    lastCheckedAt: null,
    fights: {
      "one::retained::a--b": [{
        checkedAt: now.toISOString(), eventName: "Retained", sourceUrl: "https://example.test/odds",
        promotion: "one", eventId: "retained", odds: {}, names: {},
      }],
      "one::expired::c--d": [{
        checkedAt: now.toISOString(), eventName: "Expired", sourceUrl: "https://example.test/odds",
        promotion: "one", eventId: "expired", odds: {}, names: {},
      }],
    },
  };
  prunePromotionOddsStore(promotionOdds, new Set([promotionEventKey("one", "retained")]));
  assert.deepEqual(Object.keys(promotionOdds.fights), ["one::retained::a--b"]);

  const revisions = emptyRevisionStore();
  const usedRevisionKeys = new Set<string>();
  const revisionProvider = createRevisionProvider(revisions, now, usedRevisionKeys);
  revisionProvider("retained", { value: 1 });
  createRevisionProvider(revisions, now)("expired", { value: 2 });
  pruneRevisionStore(revisions, usedRevisionKeys);
  assert.deepEqual(Object.keys(revisions.events), ["retained"]);

  const profiles = { retained: { checkedAt: now.toISOString() }, expired: { checkedAt: now.toISOString() } };
  pruneRecordToKeys(profiles, new Set(["retained"]));
  assert.deepEqual(Object.keys(profiles), ["retained"]);
});
