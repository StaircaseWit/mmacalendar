# Building an MMA calendar service from scratch

This guide explains how to build a project like MMA Calendar from an empty directory. It is written for a junior developer who understands basic JavaScript or TypeScript but may not have built a scraper, calendar feed or scheduled publishing pipeline before.

The goal is not to reproduce every line in this repository. It is to explain the decisions, boundaries and safety checks that make the service reliable over time.

## 1. Define the product before writing code

Start with a short list of behaviours:

- Publish calendar subscription URLs for selected MMA promotions.
- Include future events even when the card is incomplete.
- Update existing calendar entries when times, venues or bouts change.
- Display times in the subscriber's own calendar time zone.
- Preserve cancelled, withdrawn and postponed bouts when known.
- Retain completed events for one year.
- Include fighter records, ages, styles, countries and odds when available.
- Keep working when a live source temporarily fails.
- Run without a database or permanent application server.

These requirements drive the architecture. In particular, automatic updates require stable event identities and subscription feeds. A downloaded calendar file alone would not satisfy that requirement.

## 2. Choose a deliberately small architecture

This project uses:

- TypeScript for parsing, data processing and feed generation.
- Static HTML for the subscription page.
- JSON files for retained state and last-known-good source data.
- GitHub Actions for scheduled execution.
- GitHub Pages for hosting the website and `.ics` feeds.

This is a good fit when updates happen a few times per week and the generated files are small enough to keep in Git. A framework, database and application server would add deployment and maintenance work without improving the user experience.

The complete data flow is:

```text
Live websites
    |
    v
Source fetchers and parsers
    |
    v
Promotion-specific event models
    |
    +--> validate and compare with stored data
    |        |
    |        +--> reject suspicious or malformed updates
    |        +--> retain last-known-good data
    |
    v
Shared calendar model
    |
    v
Shared iCalendar renderer
    |
    +--> validate every generated feed
    |
    v
GitHub Pages subscription URLs
```

The most important boundary is between source parsing and calendar rendering. Website-specific HTML should never leak into the renderer. Each parser converts its source into ordinary typed data first.

## 3. Create the project

Install Node.js 20 or newer and enable pnpm:

```bash
corepack enable
mkdir mma-calendar
cd mma-calendar
pnpm init
pnpm add cheerio
pnpm add -D typescript @types/node
```

Use ES modules and strict TypeScript. A minimal `tsconfig.json` is:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Add scripts for building, testing, previewing and generating. Keep generation separate from preview because generation contacts live sources and changes stored files, while preview should be deterministic and offline.

## 4. Organise the repository by responsibility

A practical layout is:

```text
src/
  calendar-model.ts
  calendar-renderer.ts
  health.ts
  http.ts
  index.ts
  retention.ts
  revision.ts
  schema.ts
  settings.ts
  state.ts
  validate.ts
  promotions/
    definition.ts
    ids.ts
    registry.ts
    stored-loader.ts
    ufc/
      source.ts
      load.ts
      adapter.ts
      calendar.ts
      index.ts
    one/
    rizin/
    pfl/
data/
docs/
test/
  fixtures/
.github/workflows/
```

The files inside a promotion directory have distinct jobs:

- `source.ts` understands the external source and its HTML or calendar format.
- `load.ts` reads stored data, runs the scraper and reconciles old and new results.
- `adapter.ts` exposes the promotion to shared odds and rendering logic.
- `calendar.ts` maps promotion-specific events into the shared calendar model.
- `index.ts` is the public entry point for that promotion.

Do not place promotion-specific selectors or rules in shared files. Keeping those details local makes a source change much easier to review.

## 5. Build the HTTP layer

Put all network behaviour behind a small helper. It should:

- Set a clear user agent.
- Apply a timeout.
- Retry temporary failures with a short delay.
- Reject non-successful HTTP responses.
- Return text without trying to interpret it.

A simplified shape is:

```ts
export async function fetchText(url: string, attempts = 3): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "MMA Calendar/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
```

Keep concurrency limited. Fetching many athlete pages simultaneously can overload a source and make the workflow less reliable.

## 6. Parse sources into typed data

Define a source model for each promotion. The model should describe what the rest of the application needs, not the structure of the HTML.

For example:

```ts
interface Fighter {
  name: string;
  profileUrl?: string;
  countryCode?: string;
  birthDate?: string;
  record?: string;
  style?: string;
}

interface Bout {
  order?: number;
  red: Fighter;
  blue: Fighter;
  details?: string;
}

interface Event {
  uid: string;
  date: string;
  start?: string;
  end?: string;
  summary: string;
  location?: string;
  url: string;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  bouts: Bout[];
  cancelledBouts: Bout[];
}
```

Write pure parsing functions whenever possible:

```ts
export function parseEventPage(html: string, url: string): Event {
  const $ = cheerio.load(html);
  // Read fields, normalise whitespace and return a typed event.
}
```

A pure parser is easy to test with a saved HTML fixture. The network function should only fetch the page and pass its contents to the parser.

Avoid using a display name as the only identity when a source provides a stable event ID. Names and promotional titles can change. If the source URL is used as an identity, preserve an alias or migration path before changing data providers.

## 7. Validate data at the storage boundary

TypeScript types disappear when the program runs. JSON and scraped content still need runtime validation.

Validate stored JSON as soon as it is loaded. Errors should include both the filename and field path:

```text
data/pfl-events.json: root[2].bouts[4].red.name must be a non-empty string
```

This is much easier to diagnose than a later error in the renderer.

Keep validators focused on structural correctness:

- Required strings are present.
- Dates can be parsed.
- Arrays and objects have the expected shape.
- Numeric values are finite.
- Enumerated statuses use supported values.

Business rules such as minimum event counts belong in source-quality checks rather than structural schemas.

## 8. Store state safely

JSON storage is sufficient, but writes must be atomic. Write to a temporary file and rename it only after the write succeeds:

```ts
await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
await rename(`${path}.tmp`, path);
```

This prevents an interrupted run from leaving half-written JSON.

Separate human-authored data from generated state. For example, a small cancellation override file can be edited deliberately, while scraped event caches and generated calendars should only be changed by the generator.

## 9. Merge rather than replace

Never replace stored events with a scrape result without comparison. Live pages can be empty, incomplete or temporarily blocked.

For each run:

1. Load and validate stored events.
2. Scrape current events.
3. Validate the candidate result.
4. Compare its event and bout counts with the stored data.
5. Reject suspicious drops.
6. Merge accepted events into the stored set.
7. Retain recently completed events.
8. Preserve removed bouts as cancelled or withdrawn when appropriate.

A useful quality gate rejects conditions such as:

- No events returned.
- Duplicate event identities.
- Invalid event dates.
- A large event-count collapse.
- A previously populated event losing every bout without cancellation information.

When a candidate is rejected, use the last-known-good snapshot and report a degraded source status.

## 10. Apply a bounded retention policy

Historical calendar entries are useful, but retained data should not grow forever. Calculate a one-year cutoff and apply it consistently to:

- Events.
- Event-specific odds.
- Event revision records.
- Fighter profiles no longer referenced by a retained event.

Use calendar-year subtraction rather than a fixed number of milliseconds so leap years are handled correctly.

## 11. Create the shared calendar model

Promotion code should not construct raw iCalendar text. It should return a shared model such as:

```ts
interface CalendarEventModel {
  uid: string;
  revisionKey: string;
  timing:
    | { kind: "timed"; start: Date | string; end: Date | string }
    | { kind: "all-day"; startDate: string; endDate?: string };
  summary: string;
  description: CalendarDescriptionModel | string;
  location: string;
  url: string;
  categories: string[];
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
}
```

This makes formatting changes apply uniformly to every promotion. A promotion calendar mapper decides what the event means; the shared renderer decides how valid `.ics` text is produced.

## 12. Implement the iCalendar renderer carefully

iCalendar has several details that are easy to miss:

- Escape backslashes, commas, semicolons and line breaks.
- Fold physical lines at 75 UTF-8 bytes, not 75 JavaScript characters.
- Use CRLF line endings.
- Store timed events as UTC so clients localise them.
- Use `VALUE=DATE` for events without an announced time.
- Keep a stable `UID` for the lifetime of an event.
- Increment `SEQUENCE` only when meaningful event content changes.
- Keep `LAST-MODIFIED` stable when nothing changed.
- Include refresh hints, while remembering that calendar clients control their own refresh timing.

Build one renderer and test it directly. Do not create separate escaping or line-folding implementations for each promotion.

## 13. Preserve revisions and subscriber identity

Calendar clients decide whether an item is new or updated primarily from its UID and revision fields.

Store a semantic hash for each event. The hash should include meaningful fields such as timing, title, description, location, URL and status. Do not include the generator's current time.

If the semantic hash is unchanged:

- Keep the existing sequence number.
- Keep the previous last-modified value.

If it changed:

- Increment the sequence.
- Set a new last-modified value.

This prevents routine workflow runs from making every event appear newly edited.

## 14. Add promotion adapters and a registry

A promotion adapter gives shared systems a consistent way to ask questions:

```ts
interface PromotionAdapter {
  id: PromotionId;
  name: string;
  knownBouts(): KnownOddsBout[];
  retainedEventKeys(): string[];
  currentBoutKeys(now: Date): string[];
  eventNamesBetween(start: Date, end: Date): string[];
  attachOdds(store: PromotionOddsStore): void;
  renderFeeds(context: PromotionRenderContext): Record<string, string>;
}
```

The registry can then gather bouts for odds matching, attach odds and render every feed without containing promotion-specific calendar logic.

Keep the list of supported promotion IDs in one file. This avoids slightly different unions appearing in health, loading and rendering code.

## 15. Add odds as a separate subsystem

Odds processing has four separate responsibilities:

1. Fetch and parse bookmaker markets.
2. Normalise event and fighter names.
3. Match markets to known promotion bouts.
4. Store and format change-only history.

Keep those responsibilities in separate modules. This makes it possible to replace an odds provider without touching history retention or calendar formatting.

Matching should be conservative. Exact names are ideal, but middle names, suffixes and initials can be normalised. If two possible bouts are equally plausible, ignore the market rather than attaching odds to the wrong event.

Key odds histories by promotion, event and fighter pair. The event identity is required because rematches must have separate histories.

Only append a snapshot when the actual prices change. Repeated identical checks should not grow the repository.

## 16. Build the generator

The main program should orchestrate rather than parse or format:

```text
load settings
load previous health status
load all promotions
load and prune odds
create promotion registry
refresh odds when due
attach odds
render feeds
validate feeds
write feeds, status and retained state atomically
```

Load independent promotions concurrently. Write all successful outputs together near the end so it is easy to see which files generation can modify.

Keep environment-variable parsing in one settings module. Tests and preview tools should use the same defaults and canonical public URL as production.

## 17. Validate generated feeds

Do not assume that a renderer always produces valid output. Parse or inspect every generated feed before publishing it.

At minimum, verify:

- The calendar begins and ends correctly.
- Every event has a UID and valid timing.
- Timed events have both start and end values.
- All-day events use date values.
- Physical line lengths comply with iCalendar folding rules.
- Every event block closes correctly.

Write feed validation results into a public status file. Include the number of events and output byte size so unexpected changes are visible.

## 18. Test at three levels

### Unit tests

Use these for small deterministic functions such as:

- Date retention.
- Weight conversion.
- Country flags.
- Odds conversion and name normalisation.
- Calendar escaping and line folding.

### Source fixture tests

Save representative source HTML or ICS files under `test/fixtures/`. Feed them through the real parser. Never make ordinary tests depend on a live website.

Include fixtures for awkward cases:

- Incomplete future cards.
- Events without start times.
- Cancelled or withdrawn bouts.
- Names containing accents, initials and suffixes.
- Rematches.
- Mixed-discipline cards.
- Multilingual pages.
- Missing fighter profiles or odds.

### Golden contract tests

Map fixture events through the real calendar adapter and compare their semantic output with a reviewed expected contract. These tests detect accidental changes to the final user-facing format.

Keep promotion-focused test commands so a developer can get quick feedback before running the full suite.

## 19. Build an offline preview

A preview command should read tracked JSON and produce candidate feeds without making network requests or modifying published files.

Compare events by UID and semantic contents, then report:

```text
ufc.ics: +0 ~0 -0 =59
```

Here `+` means added, `~` changed, `-` removed and `=` unchanged.

Also produce a readable HTML report so calendar descriptions can be inspected before publication. The same stored inputs should always produce the same preview.

## 20. Add the subscription page

The public page only needs to explain the available promotions and provide subscription URLs. Static HTML and CSS are sufficient.

For each feed:

- Explain what one calendar entry represents.
- Display the exact `.ics` subscription URL.
- Provide a copy button.
- Explain how to add a calendar from a URL.
- Avoid presenting file download as the normal workflow, because importing creates a one-time copy rather than a live subscription.

Make promotion sections independently collapsible so the page remains usable as more organisations are added.

## 21. Automate generation and publication

Create a GitHub Actions workflow that runs:

1. On manual dispatch.
2. When relevant source files change on `main`.
3. On a twice-weekly schedule.

The workflow should:

```text
check out the repository
install the pinned pnpm and Node versions
install dependencies from the lockfile
run tests and type checking
generate live data and feeds
commit generated data if it changed
upload the docs directory
deploy GitHub Pages
fail visibly if a source used fallback data
```

Use a workflow concurrency group so two update jobs do not try to write generated state at the same time. Give the workflow only the permissions it needs for repository contents and Pages deployment.

Generated-data commits should not trigger an endless second workflow. Configure path filters so source changes trigger generation but ordinary cache updates do not.

## 22. Day-to-day maintenance

### Change calendar wording or layout

1. Update the shared renderer if the change applies everywhere.
2. Otherwise update the relevant promotion's `calendar.ts`.
3. Run the shared or promotion-specific test.
4. Run the offline preview and inspect the HTML report.
5. Run the complete check before publishing.

### Repair a changed website parser

1. Save a new representative source fixture.
2. Update only the affected promotion's parser.
3. Confirm the parser still returns the existing internal model.
4. Add a regression test for the changed markup.
5. Verify that candidate-quality gates still reject partial pages.
6. Run the promotion test, full check and preview.

### Add a field such as reach or gym

1. Add it to the promotion source type.
2. Parse it from the source.
3. Add it to runtime validation.
4. Decide whether it belongs in the calendar view.
5. Add fixture and rendering expectations.

Do not add fields to the shared calendar model unless more than one promotion benefits from them.

### Add another promotion

1. Add the promotion ID to the central ID list.
2. Create its source types and pure parsers.
3. Add stored-event and fighter validation.
4. Configure the generic stored loader.
5. Create its calendar mapper and adapter.
6. Register it with the promotion registry.
7. Add a source fixture and a golden calendar contract.
8. Add its feed to the subscription page and workflow health expectations.
9. Run all validation and inspect the preview.

### Change data providers

Treat a provider URL as source metadata, not the permanent event identity. Before switching:

1. Add parsers for the new provider behind the existing promotion model.
2. Save fixtures for every supported promotion.
3. Map new events to existing stable event identities.
4. Preserve calendar UIDs, revision keys, cancellations and odds history.
5. Compare old and new providers in an offline or shadow run.
6. Switch one promotion at a time.

This approach changes collection while leaving calendars and subscription URLs intact.

## 23. Common mistakes

- Using the workflow run time as `LAST-MODIFIED` for every event.
- Changing a UID when an event title or source URL changes.
- Treating an empty scrape as a valid empty calendar.
- Writing directly to a JSON file instead of using an atomic temporary file.
- Parsing live websites inside tests.
- Guessing unavailable times, fighter details or odds.
- Keying odds only by fighter names and mixing rematches together.
- Deleting historical events immediately after they finish.
- Hand-editing generated `.ics` files.
- Letting preview use different settings from production.
- Adding a framework before the static page actually needs one.

## 24. Release checklist

Before publishing a change:

- Run the narrowest relevant test while developing.
- Run `pnpm check`.
- Run `pnpm preview` for calendar-format or data-model changes.
- Inspect the preview report for unexpected additions, changes or removals.
- Confirm stable UIDs for existing events.
- Confirm no generated cache was edited by hand.
- Push source changes to `main`.
- Wait for the workflow to finish.
- Confirm the public status is healthy.
- Confirm all feed URLs remain valid.

## 25. Where to continue learning in this repository

Read the project in this order:

1. `src/calendar-model.ts` to understand the shared output model.
2. `src/calendar-renderer.ts` to see how valid feeds are produced.
3. One promotion's `calendar.ts` and `adapter.ts`.
4. The same promotion's `source.ts` and `load.ts`.
5. `src/promotions/stored-loader.ts` for the reusable source lifecycle.
6. `src/health.ts`, `src/schema.ts` and `src/retention.ts` for safety.
7. `src/promotion-odds/` for provider parsing, matching, storage and formatting.
8. `src/index.ts` for the complete orchestration flow.
9. `test/fixture-pipeline.test.ts` for the end-to-end offline contract.
10. `.github/workflows/update-calendar.yml` for publication.

The central design principle is simple: collect unreliable external data at the edges, convert it into stable validated models, and keep the calendar output deterministic. That separation is what makes the system safe to extend.
