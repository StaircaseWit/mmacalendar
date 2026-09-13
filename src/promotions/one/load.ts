import { validateOneEvents, validateOneFighterStore } from "../../schema.js";
import { defineStoredPromotionLoader } from "../stored-loader.js";
import {
  enrichOneEventDetails,
  enrichOneFighters,
  mergeOneEvents,
  scrapeOneCalendar,
  type OneEvent,
  type OneFighterStore,
} from "./source.js";

export function oneDate(event: OneEvent): Date | null {
  const match = event.start.match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
}

export const loadOnePromotion = defineStoredPromotionLoader<OneEvent, OneFighterStore>({
  id: "one",
  label: "ONE Championship",
  eventFile: "one-events.json",
  fighterFile: "one-fighters.json",
  emptyFighterStore: { profiles: {} },
  validateEvents: validateOneEvents,
  validateFighterStore: validateOneFighterStore,
  mergeEvents: mergeOneEvents,
  scrapeEvents: () => scrapeOneCalendar(),
  quality: {
    id: (event) => event.uid,
    date: oneDate,
    activeBouts: (event) => event.bouts.length,
  },
  pastDays: (settings) => settings.onePastDays,
  enrich: async (events, fighterStore, now) => {
    await enrichOneEventDetails(events, [1, 2, 3], now);
    await enrichOneFighters(events, fighterStore, now);
  },
  fighterKeys: (event) => event.bouts.flatMap((bout) => [bout.redProfileUrl, bout.blueProfileUrl]),
});
