import test from "node:test";
import assert from "node:assert/strict";
import { eventHtml } from "./helpers/ufc-fixture.js";
import { parseAthletePage, parseEventPage, parseEventsListing } from "../src/promotions/ufc/source.js";
import { renderCalendar, renderCombinedCalendar, renderEstimatedFightCalendar } from "../src/promotions/ufc/calendar.js";
import { applyCancellationOverrides, reconcileEvents } from "../src/promotions/ufc/events.js";
import { unicodeBold } from "../src/utils.js";
import type { EventStore } from "../src/promotions/ufc/types.js";

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

test("keeps completed UFC events for one year, then removes them", () => {
  const store: EventStore = { events: {} };
  const event = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  reconcileEvents(store, [event], new Date("2026-09-12T12:00:00Z"));

  const retained = reconcileEvents(store, [], new Date("2027-09-12T17:59:00Z"));
  assert.equal(retained.length, 1);
  assert.equal(retained[0].title, "Noche UFC: Silva vs Delgado");
  assert.equal(retained[0].scheduleStatus?.state, "scheduled");

  const expired = reconcileEvents(store, [], new Date("2027-09-12T18:01:00Z"));
  assert.equal(expired.length, 0);
  assert.deepEqual(store.events, {});
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
