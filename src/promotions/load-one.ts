import { assertCandidateQuality, cachedSourceHealth, freshSourceHealth } from "../health.js";
import {
  enrichOneEventDetails,
  enrichOneFighters,
  mergeOneEvents,
  scrapeOneCalendar,
  type OneEvent,
  type OneFighterStore,
} from "../one.js";
import { pruneRecordToKeys } from "../retention.js";
import { validateOneEvents, validateOneFighterStore } from "../schema.js";
import { readJsonValidated, writeJson } from "../state.js";
import type { LoadedPromotion, PromotionLoadContext } from "./types.js";
import { sourceErrorMessage } from "./types.js";

export interface LoadedOnePromotion extends LoadedPromotion<OneEvent> {
  fighterStore: OneFighterStore;
}

export function oneDate(event: OneEvent): Date | null {
  const match = event.start.match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
}

export async function loadOnePromotion(context: PromotionLoadContext): Promise<LoadedOnePromotion> {
  const { now, previousStatus, dataPath } = context;
  const eventPath = dataPath("one-events.json");
  const fighterPath = dataPath("one-fighters.json");
  const stored = mergeOneEvents(await readJsonValidated<OneEvent[]>(eventPath, [], validateOneEvents), [], now);
  const fighterStore = await readJsonValidated<OneFighterStore>(fighterPath, { profiles: {} }, validateOneFighterStore);
  let events = stored;
  let health;
  try {
    const current = validateOneEvents(await scrapeOneCalendar(), "ONE live source");
    const metrics = assertCandidateQuality("one", current, stored, {
      id: (event) => event.uid,
      date: oneDate,
      activeBouts: (event) => event.bouts.length,
    }, now, 180);
    events = mergeOneEvents(stored, current, now);
    await enrichOneEventDetails(events, [1, 2, 3], now);
    await enrichOneFighters(events, fighterStore, now);
    health = freshSourceHealth(now, metrics);
    console.log(`Accepted ${current.length} ONE Championship event(s).`);
  } catch (error: unknown) {
    if (!events.length) throw new Error(`ONE Championship calendar could not be generated: ${sourceErrorMessage(error)}`);
    const bouts = events.reduce((total, event) => total + event.bouts.length, 0);
    health = cachedSourceHealth(now, previousStatus.sources.one, sourceErrorMessage(error), events.length, bouts);
    console.warn(`Keeping the last-known-good ONE Championship calendar: ${sourceErrorMessage(error)}`);
  }
  pruneRecordToKeys(fighterStore.profiles, new Set(events.flatMap((event) =>
    event.bouts.flatMap((bout) => [bout.redProfileUrl, bout.blueProfileUrl].filter((url): url is string => Boolean(url)))
  )));
  return {
    id: "one",
    events,
    health,
    fighterStore,
    persist: async () => {
      await Promise.all([writeJson(eventPath, events), writeJson(fighterPath, fighterStore)]);
    },
  };
}
