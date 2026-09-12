import test from "node:test";
import assert from "node:assert/strict";
import { parseAthletePage, parseEventPage } from "../src/ufc.js";
import { renderCalendar } from "../src/ics.js";
import { ageOnDate, decimalOdds, describeWeightClass, flagEmoji, shortFighterName } from "../src/utils.js";
import { oddsRefreshIsDue, updateOddsStore } from "../src/odds.js";
import type { OddsStore } from "../src/types.js";

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
  assert.equal(event.sections.length, 1);
  assert.equal(event.sections[0].label, "Prelims");
  assert.equal(event.sections[0].fights[0].red.rank, "6");
  assert.equal(event.sections[0].fights[0].blue.countryCode, "MX");
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
});

test("renders UTC calendar data so calendar clients localise it", () => {
  const event = parseEventPage(eventHtml, "https://www.ufc.com/event/noche-test");
  const fight = event.sections[0].fights[0];
  Object.assign(fight.red, { familyName: "Silva", record: "17-3-0", birthDate: "1996-12-13", odds: "-425", oddsHistory: [] });
  Object.assign(fight.blue, { familyName: "Delgado", record: "10-1-0", birthDate: "1998-11-17", odds: "+325", oddsHistory: [] });
  fight.oddsHistory = [];
  const output = renderCalendar([event], { generatedAt: new Date("2026-09-12T12:00:00Z") });
  const unfolded = output.replace(/\r\n[ \t]/g, "");
  assert.match(unfolded, /DTSTART:20260912T180000Z/);
  assert.match(unfolded, /SUMMARY:Prelims/);
  assert.match(unfolded, /🥊 Jean Silva/);
  assert.match(unfolded, /145lbs\/66kg Featherweight/);
  assert.match(unfolded, /Silva: 17-3-0 \| Odds -425 \(1.24\) \| Age 29/);
  assert.match(unfolded, /Delgado: 10-1-0 \| Odds \+325 \(4.25\) \| Age 27/);
  assert.match(unfolded, /X-ALT-DESC;FMTTYPE=text\/html:<html><body><p><strong>🥊 Jean Silva/);
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
