import {
  assertCandidateQuality,
  cachedSourceHealth,
  freshSourceHealth,
  type CandidateAdapter,
} from "../health.js";
import { pruneRecordToKeys } from "../retention.js";
import { readJsonValidated, writeJson } from "../state.js";
import type { RuntimeSettings } from "../settings.js";
import type { LoadedPromotion, PromotionLoadContext } from "./types.js";
import type { PromotionId } from "./ids.js";
import { sourceErrorMessage } from "./types.js";

type Validator<T> = (value: unknown, source: string) => T;

export interface StoredPromotionDefinition<TEvent, TFighterStore extends { profiles: Record<string, unknown> }> {
  id: PromotionId;
  label: string;
  eventFile: string;
  fighterFile: string;
  emptyFighterStore: TFighterStore;
  validateEvents: Validator<TEvent[]>;
  validateFighterStore: Validator<TFighterStore>;
  mergeEvents: (stored: TEvent[], current: TEvent[], now: Date) => TEvent[];
  scrapeEvents: (now: Date, settings: RuntimeSettings) => Promise<TEvent[]>;
  quality: CandidateAdapter<TEvent>;
  pastDays: (settings: RuntimeSettings) => number;
  enrich: (events: TEvent[], fighterStore: TFighterStore, now: Date) => Promise<void>;
  fighterKeys: (event: TEvent) => Array<string | null | undefined>;
}

export type LoadedStoredPromotion<TEvent, TFighterStore extends { profiles: Record<string, unknown> }> =
  LoadedPromotion<TEvent> & { fighterStore: TFighterStore };

export function defineStoredPromotionLoader<
  TEvent,
  TFighterStore extends { profiles: Record<string, unknown> },
>(definition: StoredPromotionDefinition<TEvent, TFighterStore>) {
  return async function loadStoredPromotion(
    context: PromotionLoadContext,
  ): Promise<LoadedStoredPromotion<TEvent, TFighterStore>> {
    const { now, previousStatus, dataPath, settings } = context;
    const eventPath = dataPath(definition.eventFile);
    const fighterPath = dataPath(definition.fighterFile);
    const stored = definition.mergeEvents(
      await readJsonValidated<TEvent[]>(eventPath, [], definition.validateEvents),
      [],
      now,
    );
    const fighterStore = await readJsonValidated<TFighterStore>(
      fighterPath,
      definition.emptyFighterStore,
      definition.validateFighterStore,
    );
    let events = stored;
    let health;

    try {
      const current = definition.validateEvents(
        await definition.scrapeEvents(now, settings),
        `${definition.label} live source`,
      );
      const metrics = assertCandidateQuality(
        definition.id,
        current,
        stored,
        definition.quality,
        now,
        definition.pastDays(settings),
      );
      events = definition.mergeEvents(stored, current, now);
      await definition.enrich(events, fighterStore, now);
      health = freshSourceHealth(now, metrics);
      console.log(`Accepted ${current.length} ${definition.label} event(s).`);
    } catch (error: unknown) {
      if (!events.length) {
        throw new Error(`${definition.label} calendar could not be generated: ${sourceErrorMessage(error)}`);
      }
      const boutCount = events.reduce(
        (total, event) => total + definition.quality.activeBouts(event) + (definition.quality.cancelledBouts?.(event) ?? 0),
        0,
      );
      health = cachedSourceHealth(
        now,
        previousStatus.sources[definition.id],
        sourceErrorMessage(error),
        events.length,
        boutCount,
      );
      console.warn(`Keeping the last-known-good ${definition.label} calendar: ${sourceErrorMessage(error)}`);
    }

    const retainedFighterKeys = new Set(
      events.flatMap(definition.fighterKeys).filter((value): value is string => Boolean(value)),
    );
    pruneRecordToKeys(fighterStore.profiles, retainedFighterKeys);

    return {
      id: definition.id,
      events,
      health,
      fighterStore,
      persist: async () => {
        await Promise.all([writeJson(eventPath, events), writeJson(fighterPath, fighterStore)]);
      },
    };
  };
}
