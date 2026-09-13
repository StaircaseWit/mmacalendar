# MMA Calendar

A free, automatically updated set of MMA calendar subscriptions. The feeds provide detailed cards, fighter information and twice-weekly odds history where a market is available. ONE Championship, RIZIN and PFL events include official venues, times and announced bouts.

No database, paid host, Chrome extension, or Google API is required. GitHub Actions runs the generator, and GitHub Pages serves the resulting calendar feeds.

The generator is written in strict TypeScript. Its event, card, fighter, profile, and odds-history structures are type-checked before every automated update.

## What each calendar entry contains

- The correct card start and end time. Times are stored in UTC, so Google Calendar, Apple Calendar, and Outlook display them in the subscriber's own time zone.
- Announced events remain visible even while fights or card placements are still TBD. They are marked tentative and update automatically when UFC publishes more detail.
- UFC venue in the calendar's location field.
- One block per fight, for example:

  ```text
  UFC · Main Card · 6 bouts
  📍 Desert Diamond Arena, Glendale, United States
  🕒 22:00–Sun 01:00 Ireland
  --------------------------------
  𝗕𝗢𝗨𝗧𝗦
  --------------------------------

  🥊 6. 𝗝𝗲𝗮𝗻 𝗦𝗶𝗹𝘃𝗮 (#6) 🇧🇷 vs. 𝗝𝗼𝘀𝗲 𝗠𝗶𝗴𝘂𝗲𝗹 𝗗𝗲𝗹𝗴𝗮𝗱𝗼 🇲🇽
  • 145lbs/66kg Featherweight
  • Silva: 17-3-0 | 29yo | Striker | -425 (1.24)
  • Delgado: 12-2-0 | 28yo | +325 (4.25)
  • Odds history:
    ◦ 12 Sep: Silva 🟢 -425 (1.24) | Delgado 🔴 +325 (4.25)
  ```

- A link to the source UFC event and to the complete odds-change log.

Event/card times, venue, fights, rankings, countries, records, birth dates and fighting styles are collected from UFC.com. Displayed moneylines are collected from BestFightOdds. If a source has not published a field, the calendar does not guess.

The standard calendar description uses the `🥊` marker, bout order, and bold Unicode fighter names to make matchup rows easy to scan. A bold HTML alternative is also included for calendar clients that support rich descriptions.

## Update policy

- The workflow checks event and card details every Monday and Friday at 06:17 UTC.
- Once an event has been discovered, it remains in the feed permanently. This preserves an expanding archive rather than a rolling window.
- Fighter records, birth dates, and family names are cached for seven days. Birth dates are used only to calculate age on the event date.
- Available UFC, ONE Championship, RIZIN and PFL moneylines come from BestFightOdds. They are checked every Monday and Friday and shown in American and decimal formats. A history row is added only when a line changes.
- `data/odds-history.json` stores only the first snapshot and subsequent changes. The same history appears in each relevant calendar entry and in `docs/odds-history.html`.
- `data/promotion-odds.json` applies the same change-only history policy to ONE Championship, RIZIN and PFL.
- Stable event IDs mean a changed time or fight card updates the existing calendar entry instead of creating a duplicate.
- Every entry ends with a schedule status. Explicit UFC cancellations and postponements are preserved, date changes are labelled as reschedules, and events missing from two consecutive UFC listings remain visible as unconfirmed rather than silently disappearing.
- When an announced bout disappears from a UFC card, it is retained under **Cancelled or withdrawn bouts**. `data/cancellations.json` provides a small backfill for cancellations that happened before this project began tracking the card.

## Resilience and data integrity

- Every fresh source result must pass event and bout-count quality gates before it can replace stored data. Empty pages, suspicious card drops, and partial fetches keep the last-known-good snapshot instead.
- Each promotion is isolated. A problem with one source does not stop the other calendars from updating or prevent cached, validated feeds from being published.
- Fighter and card metadata is snapshotted once an event starts, so later changes to a fighter profile do not rewrite historical calendar entries.
- Odds are keyed by promotion, event, and matchup. Rematches therefore keep separate histories, and ambiguous bookmaker matches are ignored instead of guessed.
- Calendar `SEQUENCE` and `LAST-MODIFIED` values change only when that specific event changes. Routine workflow runs no longer make every calendar entry look newly edited.
- All six generated calendars are parsed and validated before publication. `docs/status.json` reports source freshness, fallback use, feed sizes, and validation results; a degraded source is published safely and then marks the workflow as failed so GitHub can notify the maintainer.

## Architecture

Each promotion keeps its own source adapter because UFC, ONE Championship, RIZIN and PFL publish different data. After collection and reconciliation, every adapter maps its events, sections, bouts, fighters and cancellations into the same calendar model. A shared renderer then produces the descriptions and iCalendar structure for every feed.

This keeps source-specific parsing isolated while giving all promotions the same formatting, escaping, line folding, revision handling and timed or date-only event behaviour. Adding another promotion requires a source adapter and a mapping into the common model rather than another calendar serializer.

## Calendar choices

- `docs/ufc.ics`: separate Early Prelims, Prelims, and Main Card events.
- `docs/ufc-combined.ics`: one complete event containing every section and announced bout.
- `docs/ufc-fights.ics`: optional estimated individual fight events that adapt to the calendar client's time zone.
- `docs/one.ics`: one complete event per ONE Championship show, including the official venue, times, announced bouts, ONE division limits, available athlete ages, ONE records, styles, country flags and odds.
- `docs/rizin.ics`: one complete event per RIZIN show, including official venues, localised start times, rule sets, weights in pounds and kilograms, available athlete ages, RIZIN records, styles, odds and cancellation notices. Events without an announced start time begin as date-only placeholders and update later.
- `docs/pfl.ics`: one complete event per PFL show, including published card times, venues, announced matchups, fighter records, ages, available odds and country flags where available.

## Optional local-time fight calendar

`docs/ufc-fights.ics` contains one tentative calendar entry per current or upcoming announced fight at its estimated start time. Unlike a time written inside an event description, these are real UTC calendar times, so the calendar client can display them in the device or account's selected time zone while travelling. The estimates assume an even pace within each card section. When UFC has not assigned bouts to sections yet, they are spread across the entire published event window and labelled accordingly. All estimates may move as the card is finalised or progresses live.

## Publish it for free

1. Create a public GitHub repository and add these files.
2. In **Settings → Actions → General**, give workflows read and write permission.
3. In **Settings → Pages**, set **Source** to **GitHub Actions**.
4. Run **Actions → Update UFC calendar → Run workflow** once. The workflow regenerates the feed, saves its state, and deploys the `/docs` files directly to GitHub Pages.
5. Your subscription URL will be:

   ```text
   https://YOUR-GITHUB-NAME.github.io/YOUR-REPOSITORY/ufc.ics
   ```

In Google Calendar, use **Other calendars → From URL** and paste the full address ending in `/ufc.ics`—not the GitHub Pages homepage. Importing a downloaded file makes a one-time copy; subscribing from the URL receives future updates. Google decides how quickly subscribed calendars refresh, so a source update may not appear immediately.

The odds log is available at:

```text
https://YOUR-GITHUB-NAME.github.io/YOUR-REPOSITORY/odds-history.html
```

## Run it locally

Requires Node.js 20 or newer:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm run generate
```

To generate only selected events while developing:

```bash
UFC_EVENT_URLS=https://www.ufc.com/event/example pnpm run generate
```

The subscription is written to `docs/ufc.ics`.

## Current scope

UFC, ONE Championship, RIZIN and PFL are supported. UFC data is collected from UFC.com. ONE event schedules and announced bouts come from ONE Championship's official calendar. RIZIN schedules, cards, fighter countries and cancellation notices come from RIZIN's official event and fighter pages. PFL schedules, cards, records, ages and countries come from PFL's official event and fighter pages. Available moneylines for every promotion are aggregated by BestFightOdds; a bout stays uncluttered when no market has been posted. "Follow a fighter" notifications are deliberately deferred.
