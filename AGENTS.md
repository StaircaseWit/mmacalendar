# MMA Calendar change map

Keep changes narrow. The project deliberately uses TypeScript, static HTML, JSON caches, and GitHub Actions without a frontend framework or database.

## Where changes belong

- Shared calendar layout: `src/calendar-model.ts` and `src/calendar-renderer.ts`
- Shared runtime defaults: `src/settings.ts`
- Promotion registration and odds wiring: `src/promotions/registry.ts`
- Generic stored-source lifecycle: `src/promotions/stored-loader.ts`
- UFC: `src/promotions/ufc/`
- ONE Championship: `src/promotions/one/`
- RIZIN: `src/promotions/rizin/`
- PFL: `src/promotions/pfl/`
- Cross-promotion odds: `src/promotion-odds.ts`
- Persisted-data validation: `src/schema.ts`
- Feed validation and health checks: `src/validate.ts` and `src/health.ts`
- Subscription page: `docs/index.html`
- Workflow and publishing: `.github/workflows/update-calendar.yml`

Each promotion folder contains its source parser/scraper, loader, calendar adapter, and public `index.ts`. Keep promotion-specific behavior there instead of adding it to shared files.

## Generated files

Do not hand-edit `docs/*.ics`, `docs/odds-history.html`, `docs/status.json`, or scraper caches under `data/`. The generator updates them. Human-authored exceptions such as `data/cancellations.json` are safe to edit deliberately.

Historical events and their related cache entries are retained for one year. Stable event UIDs and revision records must be preserved so subscribers receive updates rather than duplicates.

## Fast validation

Use the narrowest relevant check first:

- `pnpm test:shared`
- `pnpm test:ufc`
- `pnpm test:one`
- `pnpm test:rizin`
- `pnpm test:pfl`
- `pnpm test:odds`

Before committing, run `pnpm check`. Before publishing a calendar-format change, also run `pnpm preview` and inspect `work/calendar-preview/index.html`.

`pnpm preview` is offline and must remain deterministic. It compares saved data with tracked feeds and must use the same canonical public URL as production.

## Publishing

Push source changes to `main`. The workflow tests, generates, validates, commits generated data, and deploys GitHub Pages. Do not manually push generated calendar edits. Confirm `docs/status.json` is healthy and all six feeds are valid after the workflow finishes.
