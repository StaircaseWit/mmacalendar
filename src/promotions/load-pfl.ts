import { assertCandidateQuality, cachedSourceHealth, freshSourceHealth } from "../health.js";
import { enrichPflFighters, mergePflEvents, scrapePflEvents, type PflEvent, type PflFighterStore } from "../pfl.js";
import { pruneRecordToKeys } from "../retention.js";
import { validatePflEvents, validatePflFighterStore } from "../schema.js";
import { readJsonValidated, writeJson } from "../state.js";
import type { LoadedPromotion, PromotionLoadContext } from "./types.js";
import { isoDate, sourceErrorMessage } from "./types.js";

export interface LoadedPflPromotion extends LoadedPromotion<PflEvent> {
  fighterStore: PflFighterStore;
}

export async function loadPflPromotion(context: PromotionLoadContext): Promise<LoadedPflPromotion> {
  const { now, previousStatus, dataPath } = context;
  const eventPath = dataPath("pfl-events.json");
  const fighterPath = dataPath("pfl-fighters.json");
  const stored = mergePflEvents(await readJsonValidated<PflEvent[]>(eventPath, [], validatePflEvents), [], now);
  const fighterStore = await readJsonValidated<PflFighterStore>(fighterPath, { profiles: {} }, validatePflFighterStore);
  let events = stored;
  let health;
  try {
    const current = validatePflEvents(await scrapePflEvents(now, {
      pastDays: Number(process.env.PFL_PAST_DAYS ?? 180),
      maxEvents: Number(process.env.PFL_MAX_EVENTS ?? 30),
    }), "PFL live source");
    const metrics = assertCandidateQuality("pfl", current, stored, {
      id: (event) => event.uid,
      date: (event) => isoDate(event.date),
      activeBouts: (event) => event.bouts.length,
      cancelledBouts: (event) => event.cancelledBouts.length,
    }, now, Number(process.env.PFL_PAST_DAYS ?? 180));
    events = mergePflEvents(stored, current, now);
    await enrichPflFighters(events, fighterStore, now);
    health = freshSourceHealth(now, metrics);
    console.log(`Accepted ${current.length} PFL event(s).`);
  } catch (error: unknown) {
    if (!events.length) throw new Error(`PFL calendar could not be generated: ${sourceErrorMessage(error)}`);
    const bouts = events.reduce((total, event) => total + event.bouts.length + event.cancelledBouts.length, 0);
    health = cachedSourceHealth(now, previousStatus.sources.pfl, sourceErrorMessage(error), events.length, bouts);
    console.warn(`Keeping the last-known-good PFL calendar: ${sourceErrorMessage(error)}`);
  }
  pruneRecordToKeys(fighterStore.profiles, new Set(events.flatMap((event) =>
    [...event.bouts, ...event.cancelledBouts].flatMap((bout) =>
      [bout.red.profileUrl, bout.blue.profileUrl].filter((url): url is string => Boolean(url))
    )
  )));
  return {
    id: "pfl",
    events,
    health,
    fighterStore,
    persist: async () => {
      await Promise.all([writeJson(eventPath, events), writeJson(fighterPath, fighterStore)]);
    },
  };
}
