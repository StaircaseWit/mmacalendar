import { promotionOddsForBout } from "../../promotion-odds.js";
import { definePromotion, type PromotionAdapter } from "../definition.js";
import { isCurrentUtcDate, isoDate } from "../types.js";
import { renderPflCalendar } from "./calendar.js";
import type { PflBout, PflEvent } from "./source.js";

export function createPflPromotion(events: PflEvent[]): PromotionAdapter {
  return definePromotion<PflEvent, PflBout>({
    id: "pfl",
    name: "Professional Fighters League",
    events,
    eventId: (event) => event.uid,
    eventName: (event) => event.summary,
    eventDate: (event) => isoDate(event.date),
    eventIsCurrent: (event, now) => isCurrentUtcDate(event.date, now),
    bouts: (event) => [...event.bouts, ...event.cancelledBouts],
    boutNames: (bout) => ({ redName: bout.red.name, blueName: bout.blue.name }),
    attachBoutOdds: (bout, event, store) => {
      const odds = promotionOddsForBout("pfl", event.uid, bout.red.name, bout.blue.name, store);
      bout.red.odds = odds.redOdds;
      bout.blue.odds = odds.blueOdds;
      bout.oddsHistory = odds.oddsHistory;
    },
    renderFeeds: ({ generatedAt, revisionProvider }) => ({
      "pfl.ics": renderPflCalendar(events, generatedAt, revisionProvider),
    }),
  });
}
