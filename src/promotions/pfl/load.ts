import { validatePflEvents, validatePflFighterStore } from "../../schema.js";
import { isoDate } from "../types.js";
import { defineStoredPromotionLoader } from "../stored-loader.js";
import {
  enrichPflFighters,
  mergePflEvents,
  scrapePflEvents,
  type PflEvent,
  type PflFighterStore,
} from "./source.js";

export const loadPflPromotion = defineStoredPromotionLoader<PflEvent, PflFighterStore>({
  id: "pfl",
  label: "PFL",
  eventFile: "pfl-events.json",
  fighterFile: "pfl-fighters.json",
  emptyFighterStore: { profiles: {} },
  validateEvents: validatePflEvents,
  validateFighterStore: validatePflFighterStore,
  mergeEvents: mergePflEvents,
  scrapeEvents: (now, settings) => scrapePflEvents(now, {
    pastDays: settings.pflPastDays,
    maxEvents: settings.pflMaxEvents,
  }),
  quality: {
    id: (event) => event.uid,
    date: (event) => isoDate(event.date),
    activeBouts: (event) => event.bouts.length,
    cancelledBouts: (event) => event.cancelledBouts.length,
  },
  pastDays: (settings) => settings.pflPastDays,
  enrich: enrichPflFighters,
  fighterKeys: (event) => [...event.bouts, ...event.cancelledBouts]
    .flatMap((bout) => [bout.red.profileUrl, bout.blue.profileUrl]),
});
