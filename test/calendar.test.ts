import test from "node:test";
import assert from "node:assert/strict";
import { parseAthletePage, parseEventPage, parseEventsListing } from "../src/ufc.js";
import { renderCalendar, renderCombinedCalendar, renderEstimatedFightCalendar } from "../src/ics.js";
import { applyCancellationOverrides, reconcileEvents } from "../src/events.js";
import { ageOnDate, countryFlags, decimalOdds, describeWeightClass, flagEmoji, shortFighterName, unicodeBold } from "../src/utils.js";
import { oddsRefreshIsDue, updateOddsStore } from "../src/odds.js";
import { mergeOneEvents, parseOneCalendar, parseOneEventPage, parseOneEventsListing, renderOneCalendar } from "../src/one.js";
import { mergeRizinEvents, parseRizinCardPage, parseRizinEventListing, parseRizinEventPage, parseRizinFighterPage, renderRizinCalendar } from "../src/rizin.js";
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
  assert.match(output, /Event status: Cancelled · verified 12 Sep 2026/);
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
  assert.match(unfolded, /• Silva: 17-3-0 \| 29yo \| Odds 🟢 -425 \(1.24\) \| Striker/);
  assert.match(unfolded, /• Delgado: 10-1-0 \| 27yo \| Odds 🔴 \+325 \(4.25\) \| Grappler/);
  assert.match(unfolded, /◦ 12 Sep: Silva 🟢 -425 \(1.24\) \| Delgado 🔴 \+325 \(4.25\)/);
  assert.match(unfolded, new RegExp(`--------------------------------\\\\n${unicodeBold("BOUTS")}`));
  assert.match(unfolded, /X-ALT-DESC;FMTTYPE=text\/html:<html><body><p>UFC/);
  assert.match(unfolded, /Event status: Scheduled · verified 12 Sep 2026/);
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
  assert.match(output, /🥊 2\. 𝗡𝗮𝗱𝗮𝗸𝗮 vs\. 𝗛𝗮𝗿 𝗟𝗶𝗻𝗴 𝗢𝗺\\n• Atomweight Kickboxing/);

  const historical = { ...parsed[0], uid: "older", start: "20250912T003000Z" };
  assert.deepEqual(mergeOneEvents([historical], parsed).map(({ uid }) => uid), ["older", "stable-one-id"]);
});

test("adds official ONE Championship country flags to matching bouts", () => {
  const listing = `<a class="title" href="https://www.onefc.com/events/one-friday-fights-170/"><h3>ONE Friday Fights 170 &amp; The Inner Circle 30</h3></a>`;
  assert.equal(parseOneEventsListing(listing).get("one friday fights 170"), "https://www.onefc.com/events/one-friday-fights-170/");
  const eventPage = `<div class="event-matchup"><div class="title">Flyweight Muay Thai</div><div class="stats"><table><tr class="vs"><td>Yodlekpet Or Atchariya</td><th>VS</th><td>Pompet Pongsuphan PK</td></tr><tr><td>Thailand</td><th>Country</th><td>Thailand</td></tr></table></div></div>`;
  const bouts = parseOneEventPage(eventPage);
  assert.deepEqual(bouts[0], {
    redName: "Yodlekpet Or Atchariya",
    blueName: "Pompet Pongsuphan PK",
    details: "Flyweight Muay Thai",
    redCountry: "Thailand",
    blueCountry: "Thailand",
  });
  const event = {
    uid: "one-170", start: "20260911T113000Z", end: "20260911T173000Z", summary: "ONE Friday Fights 170", location: "Bangkok",
    description: "", url: "https://watch.onefc.com", status: "CONFIRMED", bouts,
  };
  const output = renderOneCalendar([event], new Date("2026-09-12T12:00:00Z")).replace(/\r\n[ \t]/g, "");
  assert.match(output, /𝗬𝗼𝗱𝗹𝗲𝗸𝗽𝗲𝘁 𝗢𝗿 𝗔𝘁𝗰𝗵𝗮𝗿𝗶𝘆𝗮 🇹🇭 vs\. 𝗣𝗼𝗺𝗽𝗲𝘁 𝗣𝗼𝗻𝗴𝘀𝘂𝗽𝗵𝗮𝗻 𝗣𝗞 🇹🇭/);
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
    <h2 class="article-heading">【試合中止】冨澤大智 vs. ドンマイ川端</h2>
    <div class="raw-html"><p><a href="/_tags/tomizawa">冨澤大智</a> vs. <a href="/_tags/kawabata">ドンマイ川端</a></p></div>
  </div>`;
  const parsed = parseRizinCardPage(cardHtml);
  assert.equal(parsed.bouts.length, 1);
  assert.equal(parsed.bouts[0]!.order, 2);
  assert.equal(parsed.bouts[0]!.section, "Main Card");
  assert.equal(parsed.bouts[0]!.details, "66kg Featherweight · RIZIN MMA · 3 × 5 min rounds");
  assert.equal(parsed.bouts[0]!.red.style, "Grappler");
  assert.equal(parsed.bouts[0]!.blue.style, "Striker");
  assert.equal(parsed.cancelledBouts[0]!.note, "Cancelled by RIZIN");

  const profile = parseRizinFighterPage(`<div class="fighter_profile"><table><tr><th>名前：</th><td>クレベル・コイケ<br>Kleber Koike</td></tr><tr><th>出身地：</th><td>ブラジル</td></tr><tr><th>生年月日：</th><td>1989年10月16日</td></tr></table></div>`, new Date("2026-09-13T12:00:00Z"));
  assert.deepEqual(profile, { name: "Kleber Koike", origin: "ブラジル", countryCode: "BR", birthDate: "1989-10-16", checkedAt: "2026-09-13T12:00:00.000Z" });

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
  assert.match(output, /• Koike: 36yo \| Grappler/);
  assert.match(output, new RegExp(unicodeBold("CANCELLED OR POSTPONED BOUTS")));

  const placeholder = { ...event, uid: "future", date: "2026-12-31", start: null, end: null, status: "TENTATIVE" as const, bouts: [], cancelledBouts: [] };
  const allDayOutput = renderRizinCalendar([placeholder], new Date("2026-09-13T12:00:00Z")).replace(/\r\n[ \t]/g, "");
  assert.match(allDayOutput, /DTSTART;VALUE=DATE:20261231/);
  assert.match(allDayOutput, /DTEND;VALUE=DATE:20270101/);
  assert.match(allDayOutput, /Start time has not been announced/);

  const historical = { ...event, uid: "older", date: "2025-12-31" };
  assert.deepEqual(mergeRizinEvents([historical], [event]).map(({ uid }) => uid), ["older", "17852438"]);
});
