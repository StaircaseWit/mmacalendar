import {
  promotionEventKey,
  promotionOddsKey,
  type KnownOddsBout,
  type PromotionOddsStore,
} from "../promotion-odds.js";
import type { RevisionProvider } from "../revision.js";

export type PromotionId = "ufc" | "one" | "rizin" | "pfl";

export interface PromotionRenderContext {
  generatedAt: Date;
  publicBaseUrl: string;
  displayTimeZone: string;
  displayTimeZoneLabel: string;
  revisionProvider?: RevisionProvider;
}

export interface PromotionAdapter {
  id: PromotionId;
  name: string;
  knownBouts: () => KnownOddsBout[];
  retainedEventKeys: () => string[];
  currentBoutKeys: (now: Date) => string[];
  eventNamesBetween: (start: Date, end: Date) => string[];
  attachOdds: (store: PromotionOddsStore) => void;
  renderFeeds: (context: PromotionRenderContext) => Record<string, string>;
}

export interface PromotionDefinition<TEvent, TBout> {
  id: PromotionId;
  name: string;
  events: TEvent[];
  eventId: (event: TEvent) => string;
  eventName: (event: TEvent) => string;
  eventDate: (event: TEvent) => Date | null;
  bouts: (event: TEvent) => TBout[];
  boutNames: (bout: TBout) => { redName: string; blueName: string };
  eventIsCurrent?: (event: TEvent, now: Date) => boolean;
  attachBoutOdds?: (bout: TBout, event: TEvent, store: PromotionOddsStore) => void;
  attachAllOdds?: (store: PromotionOddsStore) => void;
  renderFeeds: (context: PromotionRenderContext) => Record<string, string>;
}

export function definePromotion<TEvent, TBout>(definition: PromotionDefinition<TEvent, TBout>): PromotionAdapter {
  const eventIsCurrent = definition.eventIsCurrent
    ?? ((event: TEvent, now: Date) => {
      const date = definition.eventDate(event);
      return Boolean(date && date >= now);
    });
  const boutIdentity = (event: TEvent, bout: TBout) => {
    const { redName, blueName } = definition.boutNames(bout);
    return { redName, blueName, eventId: definition.eventId(event) };
  };

  return {
    id: definition.id,
    name: definition.name,
    knownBouts: () => definition.events.flatMap((event) => definition.bouts(event).map((bout) => {
      const identity = boutIdentity(event, bout);
      return {
        promotion: definition.id,
        eventId: identity.eventId,
        eventName: definition.eventName(event),
        redName: identity.redName,
        blueName: identity.blueName,
      };
    })),
    retainedEventKeys: () => definition.events.map((event) => promotionEventKey(definition.id, definition.eventId(event))),
    currentBoutKeys: (now) => definition.events.filter((event) => eventIsCurrent(event, now)).flatMap((event) =>
      definition.bouts(event).map((bout) => {
        const { eventId, redName, blueName } = boutIdentity(event, bout);
        return promotionOddsKey(definition.id, eventId, redName, blueName);
      })
    ),
    eventNamesBetween: (start, end) => definition.events
      .filter((event) => {
        const date = definition.eventDate(event);
        return Boolean(date && date >= start && date <= end);
      })
      .map(definition.eventName),
    attachOdds: (store) => {
      definition.attachAllOdds?.(store);
      if (!definition.attachBoutOdds) return;
      for (const event of definition.events) {
        for (const bout of definition.bouts(event)) definition.attachBoutOdds(bout, event, store);
      }
    },
    renderFeeds: definition.renderFeeds,
  };
}
