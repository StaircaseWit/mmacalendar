import test from "node:test";
import assert from "node:assert/strict";
import { describeRizinBout, mergeRizinEvents, parseRizinCardPage, parseRizinEventListing, parseRizinEventPage, parseRizinFighterPage, renderRizinCalendar } from "../src/promotions/rizin/index.js";
import { unicodeBold } from "../src/utils.js";

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
