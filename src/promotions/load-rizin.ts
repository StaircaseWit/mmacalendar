import { assertCandidateQuality, cachedSourceHealth, freshSourceHealth } from "../health.js";
import { enrichRizinFighters, mergeRizinEvents, scrapeRizinEvents, type RizinEvent, type RizinFighterStore } from "../rizin.js";
import { pruneRecordToKeys } from "../retention.js";
import { validateRizinEvents, validateRizinFighterStore } from "../schema.js";
import { readJsonValidated, writeJson } from "../state.js";
import type { LoadedPromotion, PromotionLoadContext } from "./types.js";
import { isoDate, sourceErrorMessage } from "./types.js";

export interface LoadedRizinPromotion extends LoadedPromotion<RizinEvent> {
  fighterStore: RizinFighterStore;
}

export async function loadRizinPromotion(context: PromotionLoadContext): Promise<LoadedRizinPromotion> {
  const { now, previousStatus, dataPath } = context;
  const eventPath = dataPath("rizin-events.json");
  const fighterPath = dataPath("rizin-fighters.json");
  const stored = mergeRizinEvents(await readJsonValidated<RizinEvent[]>(eventPath, [], validateRizinEvents), [], now);
  const fighterStore = await readJsonValidated<RizinFighterStore>(fighterPath, { profiles: {} }, validateRizinFighterStore);
  let events = stored;
  let health;
  try {
    const current = validateRizinEvents(await scrapeRizinEvents(now, {
      pastDays: Number(process.env.RIZIN_PAST_DAYS ?? 180),
      maxEvents: Number(process.env.RIZIN_MAX_EVENTS ?? 20),
    }), "RIZIN live source");
    const metrics = assertCandidateQuality("rizin", current, stored, {
      id: (event) => event.uid,
      date: (event) => isoDate(event.date),
      activeBouts: (event) => event.bouts.length,
      cancelledBouts: (event) => event.cancelledBouts.length,
    }, now, Number(process.env.RIZIN_PAST_DAYS ?? 180));
    events = mergeRizinEvents(stored, current, now);
    await enrichRizinFighters(events, fighterStore, now);
    health = freshSourceHealth(now, metrics);
    console.log(`Accepted ${current.length} RIZIN event(s).`);
  } catch (error: unknown) {
    if (!events.length) throw new Error(`RIZIN calendar could not be generated: ${sourceErrorMessage(error)}`);
    const bouts = events.reduce((total, event) => total + event.bouts.length + event.cancelledBouts.length, 0);
    health = cachedSourceHealth(now, previousStatus.sources.rizin, sourceErrorMessage(error), events.length, bouts);
    console.warn(`Keeping the last-known-good RIZIN calendar: ${sourceErrorMessage(error)}`);
  }
  pruneRecordToKeys(fighterStore.profiles, new Set(events.flatMap((event) =>
    [...event.bouts, ...event.cancelledBouts].flatMap((bout) =>
      [bout.red.profileUrl, bout.blue.profileUrl].filter((url): url is string => Boolean(url))
    )
  )));
  return {
    id: "rizin",
    events,
    health,
    fighterStore,
    persist: async () => {
      await Promise.all([writeJson(eventPath, events), writeJson(fighterPath, fighterStore)]);
    },
  };
}
