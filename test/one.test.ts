import test from "node:test";
import assert from "node:assert/strict";
import { describeOneBout, mergeOneEvents, parseOneCalendar, parseOneEventPage, parseOneEventsListing, parseOneFighterPage, renderOneCalendar } from "../src/promotions/one/index.js";

test("formats ONE Championship's official calendar as a detailed feed", () => {
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
  assert.deepEqual(
    mergeOneEvents([historical], parsed, new Date("2026-09-12T00:00:00Z")).map(({ uid }) => uid),
    ["older", "stable-one-id"],
  );
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
