import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderCombinedCalendar } from "../src/ics.js";
import { reconcileEvents } from "../src/events.js";
import { mergeOneEvents, parseOneCalendar } from "../src/one.js";
import { mergePflEvents, parsePflEventListing, parsePflEventPage } from "../src/pfl.js";
import { renderOneCalendar } from "../src/promotions/one/calendar.js";
import { renderPflCalendar } from "../src/promotions/pfl/calendar.js";
import { renderRizinCalendar } from "../src/promotions/rizin/calendar.js";
import { mergeRizinEvents, parseRizinCardPage, parseRizinEventListing, parseRizinEventPage } from "../src/rizin.js";
import { validateOneEvents } from "../src/schema.js";
import { parseEventPage } from "../src/ufc.js";
import { assertValidCalendar } from "../src/validate.js";
import { calendarEventSnapshots } from "../src/tools/calendar-diff.js";

interface GoldenEvent {
  uid: string;
  summary: string;
  semanticHash: string;
}

const fixtureRoot = resolve(process.cwd(), "test", "fixtures");
const generatedAt = new Date("2026-09-13T12:00:00Z");

async function fixture(path: string): Promise<string> {
  return readFile(resolve(fixtureRoot, path), "utf8");
}

function snapshots(feed: string): GoldenEvent[] {
  return [...calendarEventSnapshots(feed).values()];
}

test("offline source fixtures reproduce the approved calendar contracts", async () => {
  const ufc = parseEventPage(await fixture("ufc/event.html"), "https://www.ufc.com/event/fixture-ufc");
  Object.assign(ufc.sections[0]!.fights[0]!.red, { familyName: "Alpha", record: "10-1-0", birthDate: "1998-01-02", fightingStyle: "Striker", odds: "-150" });
  Object.assign(ufc.sections[0]!.fights[0]!.blue, { familyName: "Bravo", record: "8-2-0", birthDate: "1997-02-03", fightingStyle: "Grappler", odds: "+130" });
  const ufcEvents = reconcileEvents({ events: {} }, [ufc], generatedAt);
  const ufcFeed = renderCombinedCalendar(ufcEvents, { generatedAt, displayTimeZone: "Europe/Dublin", displayTimeZoneLabel: "Ireland" });

  const one = parseOneCalendar(await fixture("one/calendar.ics"))[0]!;
  Object.assign(one.bouts[0]!, {
    redCountry: "Thailand", blueCountry: "Japan", redRecord: "5-1-0", blueRecord: "4-2-0",
    redAge: 27, blueAge: 29, redStyle: "Striker", blueStyle: "Striker", redOdds: "-120", blueOdds: "+100",
  });
  const oneFeed = renderOneCalendar(mergeOneEvents([], [one], generatedAt), generatedAt);

  const rizinListing = parseRizinEventListing(await fixture("rizin/listing.html"))[0]!;
  const rizin = parseRizinEventPage(await fixture("rizin/event.html"), rizinListing);
  Object.assign(rizin, parseRizinCardPage(await fixture("rizin/card.html")));
  Object.assign(rizin.bouts[0]!.red, { countryCode: "JP", birthDate: "1995-01-01", record: "6-1-0", odds: "-135" });
  Object.assign(rizin.bouts[0]!.blue, { countryCode: "US", birthDate: "1994-01-01", record: "5-2-0", odds: "+115" });
  const rizinFeed = renderRizinCalendar(mergeRizinEvents([], [rizin], generatedAt), generatedAt);

  const pflListing = parsePflEventListing(await fixture("pfl/listing.html"), generatedAt)[0]!;
  const pfl = parsePflEventPage(await fixture("pfl/event.html"), pflListing);
  Object.assign(pfl.bouts[0]!.red, { countryCode: "US", birthDate: "1996-01-01", record: "9-1-0", style: "Striker", odds: "-110" });
  Object.assign(pfl.bouts[0]!.blue, { countryCode: "CA", birthDate: "1995-01-01", record: "8-2-0", style: "Grappler", odds: "-110" });
  const pflFeed = renderPflCalendar(mergePflEvents([], [pfl], generatedAt), generatedAt);

  const feeds = { ufc: ufcFeed, one: oneFeed, rizin: rizinFeed, pfl: pflFeed };
  for (const [name, feed] of Object.entries(feeds)) assert.equal(assertValidCalendar(`${name}.ics`, feed).status, "valid");
  const golden = JSON.parse(await fixture("golden/calendar-events.json")) as Record<string, GoldenEvent[]>;
  assert.deepEqual(Object.fromEntries(Object.entries(feeds).map(([name, feed]) => [name, snapshots(feed)])), golden);
});

test("stored-data schemas reject malformed promotion data with a precise path", () => {
  assert.throws(
    () => validateOneEvents([{ uid: "event", start: "20261001T120000Z", end: "20261001T180000Z", summary: "ONE Test", status: "CONFIRMED", bouts: [{ redName: "Red", details: "MMA" }] }], "one-events.json"),
    /one-events\.json: root\[0\]\.bouts\[0\]\.blueName must be a non-empty string/,
  );
});
