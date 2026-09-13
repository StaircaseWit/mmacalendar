import { validateRizinEvents, validateRizinFighterStore } from "../../schema.js";
import { isoDate } from "../types.js";
import { defineStoredPromotionLoader } from "../stored-loader.js";
import {
  enrichRizinFighters,
  mergeRizinEvents,
  scrapeRizinEvents,
  type RizinEvent,
  type RizinFighterStore,
} from "./source.js";

export const loadRizinPromotion = defineStoredPromotionLoader<RizinEvent, RizinFighterStore>({
  id: "rizin",
  label: "RIZIN",
  eventFile: "rizin-events.json",
  fighterFile: "rizin-fighters.json",
  emptyFighterStore: { profiles: {} },
  validateEvents: validateRizinEvents,
  validateFighterStore: validateRizinFighterStore,
  mergeEvents: mergeRizinEvents,
  scrapeEvents: (now, settings) => scrapeRizinEvents(now, {
    pastDays: settings.rizinPastDays,
    maxEvents: settings.rizinMaxEvents,
  }),
  quality: {
    id: (event) => event.uid,
    date: (event) => isoDate(event.date),
    activeBouts: (event) => event.bouts.length,
    cancelledBouts: (event) => event.cancelledBouts.length,
  },
  pastDays: (settings) => settings.rizinPastDays,
  enrich: enrichRizinFighters,
  fighterKeys: (event) => [...event.bouts, ...event.cancelledBouts]
    .flatMap((bout) => [bout.red.profileUrl, bout.blue.profileUrl]),
});
