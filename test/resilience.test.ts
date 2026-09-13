import test from "node:test";
import assert from "node:assert/strict";
import { assertCandidateQuality } from "../src/health.js";
import { createRevisionProvider, emptyRevisionStore } from "../src/revision.js";
import { validateCalendar } from "../src/validate.js";
import { parseOneCalendar, renderOneCalendar } from "../src/promotions/one/index.js";
import { defineStoredPromotionLoader } from "../src/promotions/stored-loader.js";
import { loadRuntimeSettings } from "../src/settings.js";
import { resolve } from "node:path";

test("reuses the standard stored-source lifecycle for promotion loaders", async () => {
  type SampleEvent = { uid: string; date: Date; bouts: number; fighterUrl?: string };
  type SampleStore = { profiles: Record<string, { checkedAt: string }> };
  let enriched = false;
  const load = defineStoredPromotionLoader<SampleEvent, SampleStore>({
    id: "one",
    label: "Sample",
    eventFile: "events.json",
    fighterFile: "fighters.json",
    emptyFighterStore: { profiles: {} },
    validateEvents: (value) => value as SampleEvent[],
    validateFighterStore: (value) => value as SampleStore,
    mergeEvents: (stored, current) => current.length ? current : stored,
    scrapeEvents: async () => [{ uid: "sample", date: new Date("2026-10-01T12:00:00Z"), bouts: 1 }],
    quality: {
      id: (event) => event.uid,
      date: (event) => event.date,
      activeBouts: (event) => event.bouts,
    },
    pastDays: () => 180,
    enrich: async () => { enriched = true; },
    fighterKeys: (event) => [event.fighterUrl],
  });
  const loaded = await load({
    now: new Date("2026-09-13T12:00:00Z"),
    previousStatus: { schemaVersion: 1, generatedAt: "2026-09-13T12:00:00Z", overall: "healthy", sources: {}, feeds: {} },
    dataPath: (name) => resolve(process.cwd(), "work", "missing-loader-fixture", name),
    settings: loadRuntimeSettings({}),
  });
  assert.equal(loaded.events[0]?.uid, "sample");
  assert.equal(loaded.health.status, "fresh");
  assert.equal(enriched, true);
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
