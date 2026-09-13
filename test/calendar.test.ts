import test from "node:test";
import assert from "node:assert/strict";
import { parseAthletePage, parseEventPage, parseEventsListing } from "../src/ufc.js";
import { renderCalendar, renderCombinedCalendar, renderEstimatedFightCalendar } from "../src/ics.js";
import { applyCancellationOverrides, reconcileEvents } from "../src/events.js";
import { ageOnDate, countryFlags, decimalOdds, describeWeightClass, flagEmoji, shortFighterName, unicodeBold } from "../src/utils.js";
import { attachStoredOdds, discardPostStartBestFightOddsSnapshots, oddsRefreshIsDue, updateOddsStore, updateOddsStoreFromBestFightOdds } from "../src/odds.js";
import { describeOneBout, mergeOneEvents, parseOneCalendar, parseOneEventPage, parseOneEventsListing, parseOneFighterPage, renderOneCalendar } from "../src/one.js";
import { describeRizinBout, mergeRizinEvents, parseRizinCardPage, parseRizinEventListing, parseRizinEventPage, parseRizinFighterPage, renderRizinCalendar } from "../src/rizin.js";
import { mergePflEvents, parsePflEventListing, parsePflEventPage, parsePflFighterPage, renderPflCalendar } from "../src/pfl.js";
import {
  canonicalOddsName,
  BEST_FIGHT_ODDS_URL,
  bestFightOddsSearchTerm,
  findBestFightOddsEventUrl,
  fighterPairKey,
  formatPromotionOdds,
  matchBestFightOddsMarkets,
  migratePromotionOddsStore,
  parseBestFightOdds,
  promotionOddsKey,
  promotionOddsForBout,
  promotionOddsRefreshIsDue,
  updatePromotionOddsStore,
  type PromotionOddsStore,
} from "../src/promotion-odds.js";
import { assertCandidateQuality } from "../src/health.js";
import { createRevisionProvider, emptyRevisionStore } from "../src/revision.js";
import { validateCalendar } from "../src/validate.js";
import type { EventStore, OddsStore } from "../src/types.js";

const eventHtml = `
<div class="c-hero__headline-prefix"><h1>Noche UFC</h1></div>
<div class="c-hero__headline"><span class="e-divider__top">Silva</span><span>vs</span><span class="e-divider__bottom">Delgado</span></div>
<div class="c-hero__headline-suffix" data-timestamp="1789246800"></div>
<div class="c-hero__text"><div class="field--name-venue">Desert Diamond Arena, Glendale, United States</div></div>
<div id="prelims-card--2" class="fight-card-prelims">
  <div class="c-event-fight-card-broadcaster__time" data-timestamp="1789236000"></div>
  <div class="c-listing-fight" data-fmid="1">
    <div class="c-listing-fight__class--desktop"><div class="c-listing-fight__corner-rank"><span>#6</span></div><div class="c-listing-fight__class-text">Featherweight Bout</div><div class="c-listing-fight__corner-rank"></div></div>
    <div class="c-listing-fight__corner-name--red"><a href="/athlete/jean-silva">Jean Silva</a></div>
    <div class="c-listing-fight__corner-name--blue"><a href="/athlete/jose-delgado">Jose Miguel Delgado</a></div>
    <div class="c-listing-fight__country--red"><img src="/images/flags/BR.PNG"><div class="c-listing-fight__country-text">Brazil</div></div>
    <div class="c-listing-fight__country--blue"><img src="/images/flags/MX.PNG"><div class="c-listing-fight__country-text">Mexico</div></div>
    <span class="c-listing-fight__odds-amount">-425</span><span class="c-listing-fight__odds-amount">+325</span>
  </div>
</div>
<div id="main-card--2" class="main-card"><div class="c-event-fight-card-broadcaster__time" data-timestamp="1789246800"></div><div class="c-listing-fight"></div></div>`;

test("parses a UFC card even when UFC adds numeric ID suffixes", () => {
  const event = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  assert.equal(event.title, "Noche UFC: Silva vs Delgado");
  assert.equal(event.location, "Desert Diamond Arena, Glendale, United States");
  assert.equal(event.sections.length, 2);
  assert.equal(event.sections[0].label, "Prelims");
  assert.equal(event.sections[0].fights[0].red.rank, "6");
  assert.equal(event.sections[0].fights[0].blue.countryCode, "MX");
  assert.equal(event.sections[1].provisional, true);
});

test("parses record, family name, DOB and official fighting style from an athlete page", () => {
  const profile = parseAthletePage(`<script type="application/ld+json">{"@graph":[{"mainEntity":{"@type":"Person","familyName":"Silva","birthDate":"1996-12-13"}}]}</script><p class="hero-profile__division-body">17-3-0 (W-L-D)</p><div class="c-bio__field"><div class="c-bio__label">Fighting style</div><div class="c-bio__text">Striker</div></div>`);
  assert.deepEqual(profile, { birthDate: "1996-12-13", familyName: "Silva", record: "17-3-0", fightingStyle: "Striker" });
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

test("keeps a bounded window of historical events", () => {
  const listing = `<div class="c-card-event--result"><div class="c-card-event--result__date" data-main-card-timestamp="1789156800"></div><div class="c-card-event--result__headline"><a href="/event/recent">Recent</a></div></div>
  <div class="c-card-event--result"><div class="c-card-event--result__date" data-main-card-timestamp="1777944000"></div><div class="c-card-event--result__headline"><a href="/event/too-old">Old</a></div></div>`;
  const events = parseEventsListing(listing, new Date("2026-09-12T12:00:00Z"), 180, 120);
  assert.deepEqual(events.map(({ url }) => url), ["https://www.ufc.com/event/recent"]);
});

test("keeps announced cards whose fight placement is not final", () => {
  const provisionalHtml = `
  <div class="c-hero__headline-prefix"><h1>UFC 333</h1></div>
  <div class="c-hero__headline"><span class="e-divider__top">Volkanovski</span><span class="e-divider__bottom">Evloev</span></div>
  <div class="c-hero__headline-suffix" data-timestamp="1792864800"></div>
  <div class="field--name-venue">Etihad Arena, Abu Dhabi</div>
  <div class="c-listing-viewing-option"><div class="c-listing-viewing-option__fight-card">Early Prelims</div><div class="c-listing-viewing-option__time" data-timestamp="1792850400"></div></div>
  <div class="c-listing-viewing-option"><div class="c-listing-viewing-option__fight-card">Prelims</div><div class="c-listing-viewing-option__time" data-timestamp="1792857600"></div></div>
  <div class="c-listing-viewing-option"><div class="c-listing-viewing-option__fight-card">Main Card</div><div class="c-listing-viewing-option__time" data-timestamp="1792864800"></div></div>
  <div class="view-event-fights"><div class="c-listing-fight" data-fmid="333">
    <div class="c-listing-fight__class--desktop"><div class="c-listing-fight__corner-rank">C</div><div class="c-listing-fight__class-text">Featherweight Title Bout</div><div class="c-listing-fight__corner-rank">#1</div></div>
    <div class="c-listing-fight__corner-name--red">Alexander Volkanovski</div><div class="c-listing-fight__corner-name--blue">Movsar Evloev</div>
  </div></div>`;
  const event = parseEventPage(provisionalHtml, "https://www.ufc.com/event/ufc-333");
  assert.deepEqual(event.sections.map(({ key }) => key), ["early-prelims", "prelims", "main-card"]);
  assert.equal(event.sections[0].fights.length, 0);
  assert.equal(event.sections[2].fights.length, 1);
  assert.equal(event.sections[2].provisional, true);
  assert.equal(event.sections[2].start?.toISOString(), "2026-10-24T18:00:00.000Z");
});

test("tracks reschedules and retains events missing from consecutive listings", () => {
  const store: EventStore = { events: {} };
  const first = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  const initial = reconcileEvents(store, [first], new Date("2026-09-01T12:00:00Z"));
  assert.equal(initial[0].scheduleStatus?.state, "scheduled");

  const moved = parseEventPage(eventHtml.replace("1789236000", "1789322400"), "https://www.ufc.com/event/noche-test");
  const rescheduled = reconcileEvents(store, [moved], new Date("2026-09-02T12:00:00Z"));
  assert.equal(rescheduled[0].scheduleStatus?.state, "rescheduled");
  assert.equal(rescheduled[0].scheduleStatus?.previousStart, "2026-09-12T18:00:00.000Z");

  reconcileEvents(store, [], new Date("2026-09-03T12:00:00Z"));
  const missingTwice = reconcileEvents(store, [], new Date("2026-09-04T12:00:00Z"));
  assert.equal(missingTwice[0].scheduleStatus?.state, "unlisted");
});

test("keeps established UFC fighter profile links when live card markup changes", () => {
  const store: EventStore = { events: {} };
  const first = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  reconcileEvents(store, [first], new Date("2026-09-01T12:00:00Z"));

  const changedMarkup = eventHtml.replace("/athlete/jean-silva", "/athlete/unrelated-fighter");
  const updated = parseEventPage(changedMarkup, "https://www.ufc.com/event/noche-test");
  const events = reconcileEvents(store, [updated], new Date("2026-09-02T12:00:00Z"));

  assert.equal(events[0].sections[0].fights[0].red.profileUrl, "https://www.ufc.com/athlete/jean-silva");
});

test("keeps completed events permanently when they leave the UFC listing", () => {
  const store: EventStore = { events: {} };
  const event = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  reconcileEvents(store, [event], new Date("2026-09-12T12:00:00Z"));

  const retained = reconcileEvents(store, [], new Date("2028-09-12T12:00:00Z"));
  assert.equal(retained.length, 1);
  assert.equal(retained[0].title, "Noche UFC: Silva vs Delgado");
  assert.equal(retained[0].scheduleStatus?.state, "scheduled");
});

test("retains bouts that disappear from an active UFC card", () => {
  const store: EventStore = { events: {} };
  const first = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  reconcileEvents(store, [first], new Date("2026-09-01T12:00:00Z"));

  const updatedHtml = eventHtml.replace(/<div class="c-listing-fight" data-fmid="1">[\s\S]*?<\/div>\n<\/div>\n<div id="main-card/, '<div id="main-card');
  const updated = parseEventPage(updatedHtml, "https://www.ufc.com/event/noche-test");
  const events = reconcileEvents(store, [updated], new Date("2026-09-02T12:00:00Z"));

  assert.deepEqual(events[0].cancelledBouts, [{
    id: "1",
    redName: "Jean Silva",
    blueName: "Jose Miguel Delgado",
    weightClass: "Featherweight Bout",
    reason: "Removed from the UFC card",
    detectedAt: "2026-09-02T12:00:00.000Z",
  }]);
});

test("renders configured cancelled bouts at the bottom of event descriptions", () => {
  const event = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  applyCancellationOverrides([event], {
    "noche-test": [{ redName: "Yair Rodriguez", blueName: "Jean Silva", reason: "Rodriguez injury" }],
  });
  const output = renderCalendar([event], { generatedAt: new Date("2026-09-12T12:00:00Z") }).replace(/\r\n[ \t]/g, "");
  assert.match(output, new RegExp(unicodeBold("CANCELLED OR WITHDRAWN BOUTS")));
  assert.match(output, /✕ Yair Rodriguez vs\. Jean Silva \| Rodriguez injury/);
});

test("preserves an explicit UFC cancellation in calendar status", () => {
  const cancelledPage = eventHtml.replace("<h1>Noche UFC</h1>", "<h1>Noche UFC Cancelled</h1>");
  const event = parseEventPage(cancelledPage, "https://www.ufc.com/event/noche-cancelled");
  const events = reconcileEvents({ events: {} }, [event], new Date("2026-09-12T12:00:00Z"));
  const output = renderCalendar(events, { generatedAt: new Date("2026-09-12T12:00:00Z") }).replace(/\r\n[ \t]/g, "");
  assert.match(output, /Event status: Cancelled/);
  assert.match(output, /STATUS:CANCELLED/);
});

test("renders UTC calendar data so calendar clients localise it", () => {
  const event = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  const fight = event.sections[0].fights[0];
  Object.assign(fight.red, { familyName: "Silva", record: "17-3-0", birthDate: "1996-12-13", fightingStyle: "Striker", odds: "-425", oddsHistory: [] });
  Object.assign(fight.blue, { familyName: "Delgado", record: "10-1-0", birthDate: "1998-11-17", fightingStyle: "Grappler", odds: "+325", oddsHistory: [] });
  fight.oddsHistory = [{
    checkedAt: "2026-09-12T12:00:00Z",
    odds: { "jean silva": "-425", "jose miguel delgado": "+325" },
  }];
  const output = renderCalendar([event], { generatedAt: new Date("2026-09-12T12:00:00Z") });
  const unfolded = output.replace(/\r\n[ \t]/g, "");
  assert.match(unfolded, /DTSTART:20260912T180000Z/);
  assert.match(unfolded, /SUMMARY:Prelims/);
  assert.match(unfolded, /UFC · Prelims · 1 bout/);
  assert.match(unfolded, /🥊 1\. 𝗝𝗲𝗮𝗻 𝗦𝗶𝗹𝘃𝗮/);
  assert.match(unfolded, /145lbs\/66kg Featherweight/);
  assert.doesNotMatch(unfolded, /Est\. 19:00 Ireland/);
  assert.match(unfolded, /• 145lbs\/66kg Featherweight/);
  assert.match(unfolded, /• Silva: 17-3-0 \| 29yo \| Striker \| -425 \(1.24\)/);
  assert.match(unfolded, /• Delgado: 10-1-0 \| 27yo \| Grappler \| \+325 \(4.25\)/);
  assert.match(unfolded, /◦ 12 Sep: Silva 🟢 -425 \(1.24\) \| Delgado 🔴 \+325 \(4.25\)/);
  assert.match(unfolded, new RegExp(`--------------------------------\\\\n${unicodeBold("BOUTS")}`));
  assert.match(unfolded, /X-ALT-DESC;FMTTYPE=text\/html:<html><body><p>UFC/);
  assert.match(unfolded, /Event status: Scheduled/);
  assert.doesNotMatch(unfolded, /TRANSP:TRANSPARENT/);

  const combinedOutput = renderCombinedCalendar([event], { generatedAt: new Date("2026-09-12T12:00:00Z") }).replace(/\r\n[ \t]/g, "");
  assert.equal((combinedOutput.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  assert.match(combinedOutput, /SUMMARY:Noche UFC: Silva vs Delgado/);
  assert.match(combinedOutput, new RegExp(unicodeBold("── PRELIMS · 1 bout ──")));

  const fightsOutput = renderEstimatedFightCalendar([event], { generatedAt: new Date("2026-09-12T12:00:00Z") }).replace(/\r\n[ \t]/g, "");
  assert.match(fightsOutput, /X-WR-CALNAME:UFC Estimated Fight Times/);
  assert.match(fightsOutput, /DTSTART:20260912T180000Z/);
  assert.match(fightsOutput, /SUMMARY:🥊 1\. Jean Silva vs\. Jose Miguel Delgado \(estimated\)/);
});

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

test("formats ONE Championship's official calendar as a permanent detailed feed", () => {
  const source = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:official-uid\r\nDTSTART:20260912T003000Z\r\nDTEND:20260912T063000Z\r\nSUMMARY:ONE SAMURAI 3\r\nLOCATION:Yokohama Buntai\\, Yokohama\r\nDESCRIPTION:Watch at https://watch.onefc.com/events/one-samurai-3\\n\\nNadaka vs. Har Ling Om | Kickboxing | Atomweight\\n\\nYuya Wakamatsu vs. Willie van Rooyen | Mixed Martial Arts | Flyweight\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nURL;VALUE=URI:https://watch.onefc.com/events/one-samurai-3\r\nSTATUS:CONFIRMED\r\nX-UID:stable-one-id\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const parsed = parseOneCalendar(source);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].location, "Yokohama Buntai, Yokohama");
  assert.deepEqual(parsed[0].bouts[0], {
    redName: "Nadaka",
    blueName: "Har Ling Om",
    details: "Atomweight Kickboxing",
  });

  const output = renderOneCalendar(parsed, new Date("2026-09-12T12:00:00Z")).replace(/\r\n[ \t]/g, "");
  assert.match(output, /X-WR-CALNAME:ONE Championship/);
  assert.match(output, /DTSTART:20260912T003000Z/);
  assert.match(output, /🥊 2\. 𝗡𝗮𝗱𝗮𝗸𝗮 vs\. 𝗛𝗮𝗿 𝗟𝗶𝗻𝗴 𝗢𝗺\\n• 115lbs\/52\.2kg Atomweight Kickboxing/);
  assert.equal(describeOneBout("102 LBS Muay Thai"), "102lbs/46.3kg Muay Thai");

  const historical = { ...parsed[0], uid: "older", start: "20250912T003000Z" };
  assert.deepEqual(mergeOneEvents([historical], parsed).map(({ uid }) => uid), ["older", "stable-one-id"]);
});

test("adds official ONE Championship country flags to matching bouts", () => {
  const listing = `<a class="title" href="https://www.onefc.com/events/one-friday-fights-170/"><h3>ONE Friday Fights 170 &amp; The Inner Circle 30</h3></a>`;
  assert.equal(parseOneEventsListing(listing).get("one friday fights 170"), "https://www.onefc.com/events/one-friday-fights-170/");
  const eventPage = `<div class="event-matchup"><div class="title">Flyweight Muay Thai</div><div class="stats"><table><tr class="vs"><td><a href="/athletes/yodlekpet-or-atchariya/">Yodlekpet Or Atchariya</a></td><th>VS</th><td><a href="/athletes/pompet/">Pompet Pongsuphan PK</a></td></tr><tr><td>Thailand</td><th>Country</th><td>Thailand</td></tr></table></div></div>`;
  const bouts = parseOneEventPage(eventPage);
  assert.deepEqual(bouts[0], {
    redName: "Yodlekpet Or Atchariya",
    blueName: "Pompet Pongsuphan PK",
    details: "Flyweight Muay Thai",
    redProfileUrl: "https://www.onefc.com/athletes/yodlekpet-or-atchariya/",
    blueProfileUrl: "https://www.onefc.com/athletes/pompet/",
    redCountry: "Thailand",
    blueCountry: "Thailand",
  });
  const athlete = parseOneFighterPage(`
    <div class="athlete-banner"><div class="attributes">
      <div class="attr"><h5 class="title">Country</h5><div class="value">Thailand</div></div>
      <div class="attr"><h5 class="title">Age</h5><div class="value">31 Y</div></div>
    </div></div>
    <div class="container"><div class="editor-content">A dangerous southpaw with powerful punches, kicks and elbows.</div></div>
    <div class="athlete-bout-breakdown"><div class="wins">Wins - 11</div><div class="losses">Losses - 7</div></div>
  `, new Date("2026-09-13T12:00:00Z"));
  assert.deepEqual(athlete, { country: "Thailand", age: 31, record: "11-7-0", style: "Striker", checkedAt: "2026-09-13T12:00:00.000Z" });
  Object.assign(bouts[0], {
    redAge: athlete.age, redRecord: athlete.record, redStyle: athlete.style,
    blueAge: 28, blueRecord: "9-3-0", blueStyle: "Striker",
    redOdds: "+120", blueOdds: "-163",
    oddsHistory: [{
      checkedAt: "2026-09-13T12:00:00Z",
      eventName: "One Friday Fights 170 Odds",
      sourceUrl: "https://www.bestfightodds.com/events/one-friday-fights-170-4350",
      odds: { "yodlekpet or atchariya": "+120", "pompet pongsuphan pk": "-163" },
      names: { "yodlekpet or atchariya": "Yodlekpet Or Atchariya", "pompet pongsuphan pk": "Pompet Pongsuphan PK" },
    }],
  });
  const event = {
    uid: "one-170", start: "20260911T113000Z", end: "20260911T173000Z", summary: "ONE Friday Fights 170", location: "Bangkok",
    description: "", url: "https://watch.onefc.com", status: "CONFIRMED", bouts,
  };
  const output = renderOneCalendar([event], new Date("2026-09-12T12:00:00Z")).replace(/\r\n[ \t]/g, "");
  assert.match(output, /𝗬𝗼𝗱𝗹𝗲𝗸𝗽𝗲𝘁 𝗢𝗿 𝗔𝘁𝗰𝗵𝗮𝗿𝗶𝘆𝗮 🇹🇭 vs\. 𝗣𝗼𝗺𝗽𝗲𝘁 𝗣𝗼𝗻𝗴𝘀𝘂𝗽𝗵𝗮𝗻 𝗣𝗞 🇹🇭/);
  assert.match(output, /• 135lbs\/61\.2kg Flyweight Muay Thai\\n• Atchariya: ONE 11-7-0 \| 31yo \| Striker \| \+120 \(2.20\)/);
  assert.match(output, /◦ 13 Sep: Atchariya 🔴 \+120 \(2.20\) \| PK 🟢 -163 \(1.61\)/);
});

test("discovers RIZIN events and reads official schedule details", () => {
  const listingHtml = `<div id="member-list"><div class="person"><a href="/_ct/17852438"><h4>2026年10月3日<br>RIZIN LANDMARK 16 in NAGASAKI</h4></a></div></div>`;
  const listing = parseRizinEventListing(listingHtml)[0]!;
  assert.deepEqual(listing, {
    uid: "17852438",
    date: "2026-10-03",
    summary: "RIZIN LANDMARK 16 in NAGASAKI",
    url: "https://jp.rizinff.com/_ct/17852438",
  });

  const eventHtml = `<div class="content-body-body article">
    <h3>開催日時</h3><p>2026年10月3日（土）12:00開場（予定）／14:00開始（予定）</p>
    <h3>会場</h3><p><strong><a>長崎スタジアムシティ HAPPINESS ARENA</a></strong></p>
    <h3>アクセス</h3><p>Directions</p>
    <h2>対戦カード</h2><div class="cite-box"><a href="/_ct/17857720"><h4>RIZIN LANDMARK 16 in NAGASAKI 対戦カード</h4></a></div>
  </div>`;
  const event = parseRizinEventPage(eventHtml, listing);
  assert.equal(event.start, "20261003T050000Z");
  assert.equal(event.end, "20261003T110000Z");
  assert.equal(event.status, "TENTATIVE");
  assert.equal(event.location, "長崎スタジアムシティ HAPPINESS ARENA");
  assert.equal(event.cardUrl, "https://jp.rizinff.com/_ct/17857720");
});

test("formats RIZIN cards, profiles and cancellation notices", () => {
  const cardHtml = `<div class="content-body-body article">
    <h2 class="article-heading">第2試合／クレベル・コイケ vs. 秋元強真</h2>
    <div class="raw-html"><p><br>RIZIN MMAルール：5分3R（66.0kg）<br><a href="/_tags/koike">クレベル・コイケ</a> vs. <a href="/_tags/akimoto">秋元強真</a></p></div>
    <div class="block-lbox box-color-bgyellow"><div class="lbox-child"><p><strong>クレベル・コイケ</strong></p><p>グラウンド力｜サブミッション</p></div><div class="lbox-child"><p><strong>秋元強真</strong></p><p>打撃｜打撃スピード</p></div></div>
    <p>RIZINフェザー級の一戦。</p>
    <h2 class="article-heading">第1試合／Fighter One vs. Fighter Two</h2>
    <div class="raw-html"><p><br>RIZIN MMAルール：5分3R（71.0kg）<br><a href="/_tags/one">Fighter One</a> vs. <a href="/_tags/two">Fighter Two</a></p></div>
    <h2 class="article-heading">【試合中止】冨澤大智 vs. ドンマイ川端</h2>
    <div class="raw-html"><p><a href="/_tags/tomizawa">冨澤大智</a> vs. <a href="/_tags/kawabata">ドンマイ川端</a></p></div>
  </div>`;
  const parsed = parseRizinCardPage(cardHtml);
  assert.equal(parsed.bouts.length, 2);
  assert.equal(parsed.bouts[0]!.order, 2);
  assert.equal(parsed.bouts[0]!.section, "Main Card");
  assert.equal(parsed.bouts[0]!.details, "66kg Featherweight · RIZIN MMA · 3 × 5 min rounds");
  assert.equal(parsed.bouts[0]!.red.style, "Grappler");
  assert.equal(parsed.bouts[0]!.blue.style, "Striker");
  assert.equal(parsed.bouts[1]!.details, "71kg Lightweight · RIZIN MMA · 3 × 5 min rounds");
  assert.equal(parsed.cancelledBouts[0]!.note, "Cancelled by RIZIN");

  const profile = parseRizinFighterPage(`<div class="fighter_profile"><table><tr><th>名前：</th><td>クレベル・コイケ<br>Kleber Koike</td></tr><tr><th>出身地：</th><td>ブラジル</td></tr><tr><th>生年月日：</th><td>1989年10月16日</td></tr></table><div class="profile_desc">柔術とサブミッションを得意とする。</div><div class="match_record"><table><tr><td class="under">WIN</td></tr><tr><td class="under">WIN</td></tr><tr><td class="under">LOSE</td></tr></table></div></div>`, new Date("2026-09-13T12:00:00Z"));
  assert.deepEqual(profile, { name: "Kleber Koike", origin: "ブラジル", countryCode: "BR", birthDate: "1989-10-16", record: "2-1-0", style: "Grappler", checkedAt: "2026-09-13T12:00:00.000Z" });
  assert.equal(describeRizinBout(parsed.bouts[0]!.details), "145.5lbs/66kg Featherweight · RIZIN MMA · 3 × 5 min rounds");
  assert.equal(describeRizinBout("71kg · RIZIN MMA · 3 × 5 min rounds"), "156.5lbs/71kg Lightweight · RIZIN MMA · 3 × 5 min rounds");
  assert.equal(describeRizinBout("65kg · RIZIN Kickboxing · 3 × 3 min rounds"), "143.3lbs/65kg Catchweight · RIZIN Kickboxing · 3 × 3 min rounds");

  Object.assign(parsed.bouts[0]!.red, profile);
  Object.assign(parsed.bouts[0]!.blue, { name: "Kyoma Akimoto", countryCode: "JP", birthDate: "2006-05-10" });
  const event = {
    uid: "17852438", date: "2026-10-03", start: "20261003T050000Z", end: "20261003T110000Z",
    summary: "RIZIN LANDMARK 16", location: "HAPPINESS ARENA", url: "https://jp.rizinff.com/_ct/17852438",
    cardUrl: "https://jp.rizinff.com/_ct/17857720", status: "TENTATIVE" as const, timeIsTentative: true,
    bouts: parsed.bouts, cancelledBouts: parsed.cancelledBouts,
  };
  const output = renderRizinCalendar([event], new Date("2026-09-13T12:00:00Z")).replace(/\r\n[ \t]/g, "");
  assert.match(output, /X-WR-CALNAME:RIZIN Fighting Federation/);
  assert.match(output, /DTSTART:20261003T050000Z/);
  assert.match(output, /🥊 2\. 𝗞𝗹𝗲𝗯𝗲𝗿 𝗞𝗼𝗶𝗸𝗲 🇧🇷 vs\. 𝗞𝘆𝗼𝗺𝗮 𝗔𝗸𝗶𝗺𝗼𝘁𝗼 🇯🇵/);
  assert.match(output, /• 145\.5lbs\/66kg Featherweight · RIZIN MMA · 3 × 5 min rounds/);
  assert.match(output, /• Koike: RIZIN 2-1-0 \| 36yo \| Grappler/);
  assert.match(output, new RegExp(unicodeBold("CANCELLED OR POSTPONED BOUTS")));

  const placeholder = { ...event, uid: "future", date: "2026-12-31", start: null, end: null, status: "TENTATIVE" as const, bouts: [], cancelledBouts: [] };
  const allDayOutput = renderRizinCalendar([placeholder], new Date("2026-09-13T12:00:00Z")).replace(/\r\n[ \t]/g, "");
  assert.match(allDayOutput, /DTSTART;VALUE=DATE:20261231/);
  assert.match(allDayOutput, /DTEND;VALUE=DATE:20270101/);
  assert.match(allDayOutput, /Start time has not been announced/);

  const historical = { ...event, uid: "older", date: "2025-12-31" };
  assert.deepEqual(mergeRizinEvents([historical], [event]).map(({ uid }) => uid), ["older", "17852438"]);
});

test("discovers PFL events and converts published card times to UTC", () => {
  const listingHtml = `<script type="application/ld+json">${JSON.stringify({
    "@graph": [{
      "@type": "ItemList",
      itemListElement: [{ item: {
        "@type": "SportsEvent",
        name: "PFL Chicago 2",
        description: "Wintrust Arena",
        startDate: "2026-10-16T00:00:00-04:00",
        location: { name: "Wintrust Arena, Chicago" },
        url: "https://pflmma.com/event/2026-chicago2",
      } }],
    }],
  })}</script>`;
  const listing = parsePflEventListing(listingHtml)[0]!;
  assert.deepEqual(listing, {
    uid: "2026-chicago2",
    date: "2026-10-16",
    summary: "PFL Chicago 2",
    location: "Wintrust Arena, Chicago",
    url: "https://pflmma.com/event/2026-chicago2",
  });

  const visibleListing = parsePflEventListing(`
    <div id="nav-upcoming"><article class="event-hub"><div class="event-card-info">
      <h6>Fri, Oct 16</h6><h3>PFL Chicago 2</h3><p>Wintrust Arena</p>
      <a href="/event/pfl-chicago-2">Event details</a>
    </div></article></div>
    <div id="nav-past"><article class="event-hub"><div class="event-card-info">
      <h6>Sat, Sep 5</h6><h3>PFL Europe Paris</h3><p>Accor Arena</p>
      <a href="/event/pfl-europe-paris">Event details</a>
    </div></article></div>
  `, new Date("2026-09-13T12:00:00Z"));
  assert.deepEqual(visibleListing.map(({ date, summary }) => ({ date, summary })), [
    { date: "2026-09-05", summary: "PFL Europe Paris" },
    { date: "2026-10-16", summary: "PFL Chicago 2" },
  ]);

  const eventHtml = `<script type="application/ld+json">${JSON.stringify({
    "@graph": [{
      "@type": "SportsEvent",
      "@id": "https://pflmma.com/event/2026-chicago2#event",
      name: "PFL Chicago 2",
      startDate: "2026-10-16T00:00:00-04:00",
      eventStatus: "https://schema.org/EventScheduled",
      location: { name: "Wintrust Arena, Chicago" },
      subEvent: [{
        "@type": "SportsEvent",
        "@id": "https://pflmma.com/event/2026-chicago2#fight-42",
        name: "Liz Carmouche vs Jena Bishop",
        description: "Liz Carmouche vs Jena Bishop - Women's Flyweight Semifinal",
        eventStatus: "https://schema.org/EventScheduled",
        competitor: [
          { "@type": "Person", name: "Liz Carmouche", url: "https://pflmma.com/wt-fighter/liz-carmouche" },
          { "@type": "Person", name: "Jena Bishop", url: "https://pflmma.com/wt-fighter/jena-bishop" },
        ],
      }],
    }],
  })}</script>
  <p class="event-info-time">Main Card</p><p class="event-info-time-text">3:00 AM ET</p>
  <p class="event-info-time">Early Card</p><p class="event-info-time-text">11:00 PM ET</p>`;
  const event = parsePflEventPage(eventHtml, listing);
  assert.equal(event.start, "20261017T030000Z");
  assert.equal(event.end, "20261017T100000Z");
  assert.equal(event.status, "CONFIRMED");
  assert.equal(event.bouts[0]!.details, "125lbs/57kg Women's Flyweight · Semifinal");
});

test("formats PFL fighter details and permanently tracks removed bouts", () => {
  const profile = parsePflFighterPage(`<script type="application/ld+json">${JSON.stringify({
    "@graph": [{
      "@type": "Person",
      name: "Liz Carmouche",
      nationality: "United States",
      birthDate: "1984-02-17T00:00:00+00:00",
      description: "A wrestler and submission grappler known for her ground game.",
    }],
  })}</script><h4>Career Record: 26-8-0</h4>`, new Date("2026-09-13T12:00:00Z"));
  assert.deepEqual(profile, {
    name: "Liz Carmouche",
    countryCode: "US",
    birthDate: "1984-02-17",
    record: "26-8-0",
    style: "Grappler",
    checkedAt: "2026-09-13T12:00:00.000Z",
  });

  const invalidBirthDate = parsePflFighterPage(`<script type="application/ld+json">${JSON.stringify({
    "@type": "Person", name: "Bad Source Date", birthDate: "2026-04-01T00:00:00+00:00",
  })}</script>`, new Date("2026-09-13T12:00:00Z"));
  assert.equal(invalidBirthDate.birthDate, null);

  const bout = {
    id: "42", order: 1, details: "125lbs/57kg Women's Flyweight",
    red: { ...profile, name: "Liz Carmouche", profileUrl: "https://pflmma.com/wt-fighter/liz-carmouche" },
    blue: { name: "Jena Bishop", countryCode: "US" },
  };
  const event = {
    uid: "chicago", date: "2026-10-16", summary: "PFL Chicago 2", location: "Wintrust Arena",
    url: "https://pflmma.com/event/2026-chicago2", start: "20261017T030000Z", end: "20261017T100000Z",
    status: "CONFIRMED" as const, bouts: [bout], cancelledBouts: [],
  };
  const output = renderPflCalendar([event], new Date("2026-09-13T12:00:00Z")).replace(/\r\n[ \t]/g, "");
  assert.match(output, /X-WR-CALNAME:Professional Fighters League/);
  assert.match(output, /DTSTART:20261017T030000Z/);
  assert.match(output, /🥊 1\. 𝗟𝗶𝘇 𝗖𝗮𝗿𝗺𝗼𝘂𝗰𝗵𝗲 🇺🇸 vs\. 𝗝𝗲𝗻𝗮 𝗕𝗶𝘀𝗵𝗼𝗽 🇺🇸/);
  assert.match(output, /• Carmouche: 26-8-0 \| 42yo \| Grappler/);

  const updated = { ...event, bouts: [], cancelledBouts: [] };
  const merged = mergePflEvents([event], [updated]);
  assert.equal(merged[0]!.bouts.length, 1);
  assert.equal(merged[0]!.cancelledBouts.length, 0);

  const placeholder = { ...event, uid: "future", start: null, end: null, status: "TENTATIVE" as const, bouts: [], cancelledBouts: [] };
  const placeholderOutput = renderPflCalendar([placeholder], new Date("2026-09-13T12:00:00Z")).replace(/\r\n[ \t]/g, "");
  assert.match(placeholderOutput, /DTSTART;VALUE=DATE:20261016/);
});

test("rejects suspicious source drops before they can replace stored data", () => {
  type Sample = { id: string; date: Date; bouts: number; cancelled?: number };
  const adapter = {
    id: (event: Sample) => event.id,
    date: (event: Sample) => event.date,
    activeBouts: (event: Sample) => event.bouts,
    cancelledBouts: (event: Sample) => event.cancelled ?? 0,
  };
  const now = new Date("2026-09-13T12:00:00Z");
  const stored = Array.from({ length: 6 }, (_, index) => ({
    id: `event-${index}`,
    date: new Date(`2026-09-${String(13 + index).padStart(2, "0")}T12:00:00Z`),
    bouts: 10,
  }));
  assert.throws(
    () => assertCandidateQuality("ufc", [stored[0]!], stored, adapter, now, 120),
    /event count fell/,
  );
  assert.throws(
    () => assertCandidateQuality("ufc", [{ ...stored[0]!, bouts: 0 }], [stored[0]!], adapter, now, 120),
    /lost all 10 active bouts/,
  );
  assert.doesNotThrow(() => assertCandidateQuality(
    "ufc",
    [{ ...stored[0]!, bouts: 0, cancelled: 10 }],
    [stored[0]!],
    adapter,
    now,
    120,
  ));
});

test("keeps calendar revisions stable until semantic event content changes", () => {
  const event = parseOneCalendar(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:stable\r\nDTSTART:20261001T120000Z\r\nDTEND:20261001T180000Z\r\nSUMMARY:ONE Test\r\nLOCATION:Bangkok\r\nDESCRIPTION:A vs. B | Mixed Martial Arts | Flyweight\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0]!;
  const store = emptyRevisionStore();
  const first = renderOneCalendar([event], new Date("2026-09-13T12:00:00Z"), createRevisionProvider(store, new Date("2026-09-13T12:00:00Z")));
  const unchanged = renderOneCalendar([event], new Date("2026-09-17T12:00:00Z"), createRevisionProvider(store, new Date("2026-09-17T12:00:00Z")));
  assert.equal(unchanged, first);
  const changed = renderOneCalendar([{ ...event, summary: "ONE Test Updated" }], new Date("2026-09-17T12:00:00Z"), createRevisionProvider(store, new Date("2026-09-17T12:00:00Z")));
  assert.match(changed, /SEQUENCE:1/);
  assert.match(changed, /LAST-MODIFIED:20260917T120000Z/);
});

test("validates generated feeds independently from their renderers", () => {
  const event = parseOneCalendar(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:valid\r\nDTSTART:20261001T120000Z\r\nDTEND:20261001T180000Z\r\nSUMMARY:ONE Test\r\nDESCRIPTION:A vs. B | MMA | Flyweight\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0]!;
  const rendered = renderOneCalendar([event], new Date("2026-09-13T12:00:00Z"));
  assert.deepEqual(validateCalendar("one.ics", rendered).status, "valid");
  assert.deepEqual(validateCalendar("one.ics", rendered.replace("UID:valid@", "UID:duplicate@") + "broken").status, "invalid");
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

test("preserves a UFC identity and event-time fighter snapshot when the source slug changes", () => {
  const before = parseEventPage(eventHtml, "https://www.ufc.com/event/original-slug");
  before.sections[0]!.fights[0]!.red.record = "17-3-0";
  before.sections[0]!.fights[0]!.red.fightingStyle = "Striker";
  const store: EventStore = { events: {} };
  reconcileEvents(store, [before], new Date("2026-09-12T17:00:00Z"));

  const renamed = parseEventPage(eventHtml, "https://www.ufc.com/event/replacement-slug");
  const [result] = reconcileEvents(store, [renamed], new Date("2026-09-12T19:00:00Z"));
  assert.equal(result!.slug, "original-slug");
  assert.equal(result!.sections[0]!.fights[0]!.red.record, "17-3-0");
  assert.equal(result!.sections[0]!.fights[0]!.red.fightingStyle, "Striker");
  assert.deepEqual(store.events["original-slug"]!.aliases, ["replacement-slug"]);
});
