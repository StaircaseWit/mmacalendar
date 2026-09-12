# Detailed UFC Calendar

A free, automatically updated UFC calendar subscription. It generates separate calendar entries for **Early Prelims**, **Prelims**, and the **Main Card** instead of putting an entire UFC event into one oversized entry.

No website, database, paid host, Chrome extension, or Google API is required. GitHub Actions runs the generator, and GitHub Pages serves the resulting `ufc.ics` file.

The generator is written in strict TypeScript. Its event, card, fighter, profile, and odds-history structures are type-checked before every automated update.

## What each calendar entry contains

- The correct card start and end time. Times are stored in UTC, so Google Calendar, Apple Calendar, and Outlook display them in the subscriber's own time zone.
- UFC venue in the calendar's location field.
- One block per fight, for example:

  ```text
  🥊 Jean Silva (#6) 🇧🇷 vs. Jose Miguel Delgado 🇲🇽 - 145lbs/66kg Featherweight
      Silva: 17-3-0 | Odds -425 (1.24) | Age 29
      Delgado: 12-2-0 | Odds +325 (4.25) | Age 28
      Odds history:
        12 Sep 2026: Jean Silva -425 (1.24) | Jose Miguel Delgado +325 (4.25)
  ```

- A link to the source UFC event and to the complete odds-change log.

Event/card times, venue, fights, rankings, countries, records, birth dates, and displayed odds are collected from UFC.com. If UFC has not published a field, the calendar says `unavailable`; it does not guess.

The standard calendar description uses the `🥊` marker to make matchup rows easy to scan. A bold HTML alternative is included for calendar clients that support rich descriptions; clients that implement only the standard plain-text iCalendar description still receive the readable marked version.

## Update policy

- The workflow checks event and card details every six hours.
- Fighter records, birth dates, and family names are cached for seven days. Birth dates are used only to calculate age on the event date.
- Odds are accepted into the calendar **no more than once every seven days**.
- `data/odds-history.json` stores only the first snapshot and subsequent changes. The same history appears in each relevant calendar entry and in `docs/odds-history.html`.
- Stable event IDs mean a changed time or fight card updates the existing calendar entry instead of creating a duplicate.

## Publish it for free

1. Create a public GitHub repository and add these files.
2. In **Settings → Actions → General**, give workflows read and write permission.
3. In **Settings → Pages**, set **Source** to **GitHub Actions**.
4. Run **Actions → Update UFC calendar → Run workflow** once. The workflow regenerates the feed, saves its state, and deploys the `/docs` files directly to GitHub Pages.
5. Your subscription URL will be:

   ```text
   https://YOUR-GITHUB-NAME.github.io/YOUR-REPOSITORY/ufc.ics
   ```

In Google Calendar, use **Other calendars → From URL** and paste that address. Google decides how quickly subscribed calendars refresh, so a source update may not appear immediately.

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
