import { definePromotion, type PromotionAdapter } from "../definition.js";
import { renderCalendar, renderCombinedCalendar, renderEstimatedFightCalendar } from "./calendar.js";
import { attachStoredOdds } from "./odds.js";
import type { Fight, OddsStore, UfcEvent } from "./types.js";

export function createUfcPromotion(events: UfcEvent[], oddsStore: OddsStore): PromotionAdapter {
  return definePromotion<UfcEvent, Fight>({
    id: "ufc",
    name: "Ultimate Fighting Championship",
    events,
    eventId: (event) => event.slug,
    eventName: (event) => event.title,
    eventDate: (event) => event.heroStart,
    bouts: (event) => event.sections.flatMap((section) => section.fights),
    boutNames: (bout) => ({ redName: bout.red.name, blueName: bout.blue.name }),
    attachAllOdds: () => attachStoredOdds(events, oddsStore),
    renderFeeds: (context) => ({
      "ufc.ics": renderCalendar(events, context),
      "ufc-combined.ics": renderCombinedCalendar(events, context),
      "ufc-fights.ics": renderEstimatedFightCalendar(events, context),
    }),
  });
}
