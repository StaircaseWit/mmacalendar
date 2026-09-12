# Detailed UFC Calendar

A free, automatically updated UFC calendar subscription. It generates separate calendar entries for **Early Prelims**, **Prelims**, and the **Main Card** instead of putting an entire UFC event into one oversized entry.

No website, database, paid host, Chrome extension, or Google API is required. GitHub Actions runs the generator, and GitHub Pages serves the resulting `ufc.ics` file.

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
  BOUTS
  --------------------------------

  🥊 6. 𝗝𝗲𝗮𝗻 𝗦𝗶𝗹𝘃𝗮 (#6) 🇧🇷 vs. 𝗝𝗼𝘀𝗲 𝗠𝗶𝗴𝘂𝗲𝗹 𝗗𝗲𝗹𝗴𝗮𝗱𝗼 🇲🇽 - 145lbs/66kg Featherweight
      Silva: 17-3-0 | 29yo | Odds 🟢 -425 (1.24)
      Delgado: 12-2-0 | 28yo | Odds 🔴 +325 (4.25)
      Odds history:
        12 Sep: Silva 🟢 -425 (1.24) | Delgado 🔴 +325 (4.25)
  ```

- A link to the source UFC event and to the complete odds-change log.

Event/card times, venue, fights, rankings, countries, records, birth dates, and displayed odds are collected from UFC.com. If UFC has not published a field, the calendar says `unavailable`; it does not guess.

The standard calendar description uses the `🥊` marker, bout order, and bold Unicode fighter names to make matchup rows easy to scan. A bold HTML alternative is also included for calendar clients that support rich descriptions.

## Update policy

- The workflow checks event and card details every Monday and Friday at 06:17 UTC.
- Once an event has been discovered, it remains in the feed permanently. This preserves an expanding archive rather than a rolling window.
- Fighter records, birth dates, and family names are cached for seven days. Birth dates are used only to calculate age on the event date.
- Odds are accepted into the calendar **no more than once every seven days**.
- `data/odds-history.json` stores only the first snapshot and subsequent changes. The same history appears in each relevant calendar entry and in `docs/odds-history.html`.
- Stable event IDs mean a changed time or fight card updates the existing calendar entry instead of creating a duplicate.
- Every entry ends with a verified schedule status. Explicit UFC cancellations and postponements are preserved, date changes are labelled as reschedules, and events missing from two consecutive UFC listings remain visible as unconfirmed rather than silently disappearing.
- When an announced bout disappears from a UFC card, it is retained under **Cancelled or withdrawn bouts**. `data/cancellations.json` provides a small backfill for cancellations that happened before this project began tracking the card.

## Calendar choices

- `docs/ufc.ics`: separate Early Prelims, Prelims, and Main Card events.
- `docs/ufc-combined.ics`: one complete event containing every section and announced bout.
- `docs/ufc-fights.ics`: optional estimated individual fight events that adapt to the calendar client's time zone.

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

## Scope of this first version

This phase supports UFC only. "Follow a fighter" notifications are deliberately deferred. The project is a generator and public calendar feed, not a full web application.
