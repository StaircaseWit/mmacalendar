import { promotionOddsForBout } from "../../promotion-odds.js";
import { definePromotion, type PromotionAdapter } from "../definition.js";
import { renderOneCalendar } from "./calendar.js";
import { oneDate } from "./load.js";
import type { OneBout, OneEvent } from "./source.js";

export function createOnePromotion(events: OneEvent[]): PromotionAdapter {
  return definePromotion<OneEvent, OneBout>({
    id: "one",
    name: "ONE Championship",
    events,
    eventId: (event) => event.uid,
    eventName: (event) => event.summary,
    eventDate: oneDate,
    bouts: (event) => event.bouts,
    boutNames: (bout) => ({ redName: bout.redName, blueName: bout.blueName }),
    attachBoutOdds: (bout, event, store) => {
      Object.assign(bout, promotionOddsForBout("one", event.uid, bout.redName, bout.blueName, store));
    },
    renderFeeds: ({ generatedAt, revisionProvider }) => ({
      "one.ics": renderOneCalendar(events, generatedAt, revisionProvider),
    }),
  });
}
