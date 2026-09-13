import { promotionOddsForBout } from "../../promotion-odds.js";
import { definePromotion, type PromotionAdapter } from "../definition.js";
import { isCurrentUtcDate, isoDate } from "../types.js";
import { renderRizinCalendar } from "./calendar.js";
import type { RizinBout, RizinEvent } from "./source.js";

export function createRizinPromotion(events: RizinEvent[]): PromotionAdapter {
  return definePromotion<RizinEvent, RizinBout>({
    id: "rizin",
    name: "RIZIN Fighting Federation",
    events,
    eventId: (event) => event.uid,
    eventName: (event) => event.summary,
    eventDate: (event) => isoDate(event.date),
    eventIsCurrent: (event, now) => isCurrentUtcDate(event.date, now),
    bouts: (event) => [...event.bouts, ...event.cancelledBouts],
    boutNames: (bout) => ({ redName: bout.red.name, blueName: bout.blue.name }),
    attachBoutOdds: (bout, event, store) => {
      const odds = promotionOddsForBout("rizin", event.uid, bout.red.name, bout.blue.name, store);
      bout.red.odds = odds.redOdds;
      bout.blue.odds = odds.blueOdds;
      bout.oddsHistory = odds.oddsHistory;
    },
    renderFeeds: ({ generatedAt, revisionProvider }) => ({
      "rizin.ics": renderRizinCalendar(events, generatedAt, revisionProvider),
    }),
  });
}
