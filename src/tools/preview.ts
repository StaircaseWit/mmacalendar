import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cachedEvents } from "../promotions/ufc/events.js";
import { mergeOneEvents, type OneEvent } from "../promotions/one/source.js";
import { mergePflEvents, type PflEvent } from "../promotions/pfl/source.js";
import { createPromotionRegistry } from "../promotions/registry.js";
import type { PromotionOddsStore } from "../promotion-odds.js";
import { mergeRizinEvents, type RizinEvent } from "../promotions/rizin/source.js";
import {
  validateEventStore,
  validateOddsStore,
  validateOneEvents,
  validatePflEvents,
  validatePromotionOddsStore,
  validateRizinEvents,
} from "../schema.js";
import { readJsonValidated, writeJson, writeText } from "../state.js";
import { loadRuntimeSettings } from "../settings.js";
import type { EventStore, OddsStore } from "../promotions/ufc/types.js";
import { assertValidCalendar } from "../validate.js";
import { compareCalendarFeeds, type CalendarDiff } from "./calendar-diff.js";

const root = process.cwd();
const settings = loadRuntimeSettings();
const dataPath = (name: string) => resolve(root, "data", name);
const now = new Date();
const outputDirectory = resolve(root, process.env.CALENDAR_PREVIEW_DIR ?? "work/calendar-preview");

async function previousFeed(name: string): Promise<string> {
  try {
    return await readFile(resolve(root, "docs", name), "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function diffList(values: string[], empty: string): string {
  if (!values.length) return `<p>${empty}</p>`;
  return `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function previewHtml(report: Record<string, CalendarDiff>): string {
  const sections = Object.entries(report).map(([name, diff]) => `
    <section>
      <div class="feed-heading"><h2>${escapeHtml(name)}</h2><a href="./${encodeURIComponent(name)}">Open preview feed</a></div>
      <div class="metrics"><span><strong>${diff.added.length}</strong> added</span><span><strong>${diff.changed.length}</strong> changed</span><span><strong>${diff.removed.length}</strong> removed</span><span><strong>${diff.unchanged}</strong> unchanged</span></div>
      <details ${diff.added.length || diff.changed.length || diff.removed.length ? "open" : ""}>
        <summary>Entry changes</summary>
        <h3>Added</h3>${diffList(diff.added, "None")}
        <h3>Changed</h3>${diffList(diff.changed, "None")}
        <h3>Removed</h3>${diffList(diff.removed, "None")}
      </details>
    </section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calendar preview</title><style>
    :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f1f4f1;color:#18201b}body{max-width:980px;margin:0 auto;padding:48px 24px 80px}h1{font-size:clamp(2rem,5vw,4rem);margin:0 0 12px}header p{color:#5b665e;margin:0 0 36px}section{background:#fff;border:1px solid #d9e0da;border-radius:18px;padding:24px;margin:18px 0;box-shadow:0 8px 24px #1b2d2110}.feed-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.feed-heading h2{margin:0}.feed-heading a{color:#176c4b}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:20px 0}.metrics span{background:#edf3ef;border-radius:12px;padding:14px}.metrics strong{display:block;font-size:1.5rem}summary{cursor:pointer;font-weight:700}h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;margin:20px 0 6px}ul,p{margin:6px 0;color:#47524b}@media(max-width:650px){body{padding:28px 16px}.feed-heading{align-items:flex-start;flex-direction:column}.metrics{grid-template-columns:repeat(2,1fr)}}@media(prefers-color-scheme:dark){:root{background:#101512;color:#edf4ef}header p,ul,p{color:#aebbb2}section{background:#18201b;border-color:#2f3d34}.metrics span{background:#202b24}.feed-heading a{color:#7ed2ad}}
  </style></head><body><header><h1>Calendar preview</h1><p>Generated entirely from the saved project data. Nothing was scraped or published.</p></header>${sections}</body></html>`;
}

const eventStore = await readJsonValidated<EventStore>(dataPath("events.json"), { events: {} }, validateEventStore);
const ufcEvents = cachedEvents(eventStore, now);
const oneEvents = mergeOneEvents(await readJsonValidated<OneEvent[]>(dataPath("one-events.json"), [], validateOneEvents), [], now);
const rizinEvents = mergeRizinEvents(await readJsonValidated<RizinEvent[]>(dataPath("rizin-events.json"), [], validateRizinEvents), [], now);
const pflEvents = mergePflEvents(await readJsonValidated<PflEvent[]>(dataPath("pfl-events.json"), [], validatePflEvents), [], now);
const ufcOdds = await readJsonValidated<OddsStore>(dataPath("odds-history.json"), { lastCheckedAt: null, fights: {} }, validateOddsStore);
const promotionOdds = await readJsonValidated<PromotionOddsStore>(dataPath("promotion-odds.json"), { lastCheckedAt: null, fights: {} }, validatePromotionOddsStore);
const registry = createPromotionRegistry({ ufc: ufcEvents, one: oneEvents, rizin: rizinEvents, pfl: pflEvents, ufcOdds });
registry.attachOdds(promotionOdds);
const feeds = registry.renderFeeds({
  generatedAt: now,
  publicBaseUrl: settings.publicBaseUrl,
  displayTimeZone: settings.displayTimeZone,
  displayTimeZoneLabel: settings.displayTimeZoneLabel,
});
const report: Record<string, CalendarDiff> = {};
for (const [name, contents] of feeds) {
  assertValidCalendar(name, contents);
  report[name] = compareCalendarFeeds(await previousFeed(name), contents);
  await writeText(resolve(outputDirectory, name), contents);
}
await Promise.all([
  writeJson(resolve(outputDirectory, "report.json"), { generatedAt: now.toISOString(), feeds: report }),
  writeText(resolve(outputDirectory, "index.html"), previewHtml(report)),
]);
for (const [name, diff] of Object.entries(report)) {
  console.log(`${name}: +${diff.added.length} ~${diff.changed.length} -${diff.removed.length} =${diff.unchanged}`);
}
console.log(`Preview written to ${outputDirectory}`);
