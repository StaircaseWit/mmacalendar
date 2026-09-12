import test from "node:test";
import assert from "node:assert/strict";
import { parseAthletePage, parseEventPage, parseEventsListing } from "../src/ufc.js";
import { renderCalendar, renderCombinedCalendar, renderEstimatedFightCalendar } from "../src/ics.js";
import { applyCancellationOverrides, reconcileEvents } from "../src/events.js";
import { ageOnDate, decimalOdds, describeWeightClass, flagEmoji, shortFighterName, unicodeBold } from "../src/utils.js";
import { oddsRefreshIsDue, updateOddsStore } from "../src/odds.js";
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

test("parses record, family name and exact DOB from an athlete page", () => {
  const profile = parseAthletePage(`<script type="application/ld+json">{"@graph":[{"mainEntity":{"@type":"Person","familyName":"Silva","birthDate":"1996-12-13"}}]}</script><p class="hero-profile__division-body">17-3-0 (W-L-D)</p>`);
  assert.deepEqual(profile, { birthDate: "1996-12-13", familyName: "Silva", record: "17-3-0" });
});

test("formats weight and country fields", () => {
  assert.equal(describeWeightClass("Featherweight Bout"), "145lbs/66kg Featherweight");
  assert.equal(describeWeightClass("Featherweight Title Bout"), "145lbs/66kg Featherweight · Title Bout");
  assert.equal(flagEmoji("BR"), "🇧🇷");
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
  assert.match(output, /CANCELLED OR WITHDRAWN BOUTS/);
  assert.match(output, /✕ Yair Rodriguez vs\. Jean Silva \| Rodriguez injury/);
});

test("preserves an explicit UFC cancellation in calendar status", () => {
  const cancelledPage = eventHtml.replace("<h1>Noche UFC</h1>", "<h1>Noche UFC Cancelled</h1>");
  const event = parseEventPage(cancelledPage, "https://www.ufc.com/event/noche-cancelled");
  const events = reconcileEvents({ events: {} }, [event], new Date("2026-09-12T12:00:00Z"));
  const output = renderCalendar(events, { generatedAt: new Date("2026-09-12T12:00:00Z") }).replace(/\r\n[ \t]/g, "");
  assert.match(output, /Event status: Cancelled · verified 12 Sep 2026/);
  assert.match(output, /STATUS:CANCELLED/);
});

test("renders UTC calendar data so calendar clients localise it", () => {
  const event = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  const fight = event.sections[0].fights[0];
  Object.assign(fight.red, { familyName: "Silva", record: "17-3-0", birthDate: "1996-12-13", odds: "-425", oddsHistory: [] });
  Object.assign(fight.blue, { familyName: "Delgado", record: "10-1-0", birthDate: "1998-11-17", odds: "+325", oddsHistory: [] });
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
  assert.match(unfolded, /Silva: 17-3-0 \| 29yo \| Odds 🟢 -425 \(1.24\)/);
  assert.match(unfolded, /Delgado: 10-1-0 \| 27yo \| Odds 🔴 \+325 \(4.25\)/);
  assert.match(unfolded, /12 Sep: Silva 🟢 -425 \(1.24\) \| Delgado 🔴 \+325 \(4.25\)/);
  assert.match(unfolded, /--------------------------------\\nBOUTS/);
  assert.match(unfolded, /X-ALT-DESC;FMTTYPE=text\/html:<html><body><p>UFC/);
  assert.match(unfolded, /Event status: Scheduled · verified 12 Sep 2026/);
  assert.doesNotMatch(unfolded, /TRANSP:TRANSPARENT/);

  const combinedOutput = renderCombinedCalendar([event], { generatedAt: new Date("2026-09-12T12:00:00Z") }).replace(/\r\n[ \t]/g, "");
  assert.equal((combinedOutput.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  assert.match(combinedOutput, /SUMMARY:Noche UFC: Silva vs Delgado/);
  assert.match(combinedOutput, /── PRELIMS · 1 bout ──/);

  const fightsOutput = renderEstimatedFightCalendar([event], { generatedAt: new Date("2026-09-12T12:00:00Z") }).replace(/\r\n[ \t]/g, "");
  assert.match(fightsOutput, /X-WR-CALNAME:UFC Estimated Fight Times/);
  assert.match(fightsOutput, /DTSTART:20260912T180000Z/);
  assert.match(fightsOutput, /SUMMARY:🥊 1\. Jean Silva vs\. Jose Miguel Delgado \(estimated\)/);
});

test("odds are checked weekly and unchanged values do not inflate history", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  const store: OddsStore = { lastCheckedAt: "2026-09-06T12:00:01Z", fights: {} };
  assert.equal(oddsRefreshIsDue(store, now), false);
  store.lastCheckedAt = "2026-09-05T12:00:00Z";
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
