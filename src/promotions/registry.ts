import { renderCalendar, renderCombinedCalendar, renderEstimatedFightCalendar } from "../ics.js";
import { attachStoredOdds } from "../odds.js";
import type { OneEvent } from "../one.js";
import type { PflEvent } from "../pfl.js";
import {
  promotionEventKey,
  promotionOddsForBout,
  promotionOddsKey,
  type KnownOddsBout,
  type PromotionOddsStore,
} from "../promotion-odds.js";
import type { RevisionProvider } from "../revision.js";
import type { RizinEvent } from "../rizin.js";
import type { OddsStore, UfcEvent } from "../types.js";
import { oneDate } from "./load-one.js";
import { renderOneCalendar } from "./one/calendar.js";
import { renderPflCalendar } from "./pfl/calendar.js";
import { renderRizinCalendar } from "./rizin/calendar.js";
import { isoDate } from "./types.js";

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

export class PromotionRegistry {
  private readonly adapters = new Map<PromotionId, PromotionAdapter>();

  register(adapter: PromotionAdapter): this {
    if (this.adapters.has(adapter.id)) throw new Error(`Promotion ${adapter.id} is already registered`);
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  list(): PromotionAdapter[] {
    return [...this.adapters.values()];
  }

  knownBouts(): KnownOddsBout[] {
    return this.list().flatMap((adapter) => adapter.knownBouts());
  }

  retainedEventKeys(): Set<string> {
    return new Set(this.list().flatMap((adapter) => adapter.retainedEventKeys()));
  }

  currentBoutKeys(now: Date, except: PromotionId[] = []): Set<string> {
    const excluded = new Set(except);
    return new Set(this.list().filter(({ id }) => !excluded.has(id)).flatMap((adapter) => adapter.currentBoutKeys(now)));
  }

  eventNamesBetween(start: Date, end: Date): string[] {
    return this.list().flatMap((adapter) => adapter.eventNamesBetween(start, end));
  }

  attachOdds(store: PromotionOddsStore): void {
    for (const adapter of this.list()) adapter.attachOdds(store);
  }

  renderFeeds(context: PromotionRenderContext): Map<string, string> {
    return new Map(this.list().flatMap((adapter) => Object.entries(adapter.renderFeeds(context))));
  }
}

function isBetween(value: Date | null, start: Date, end: Date): boolean {
  return Boolean(value && value >= start && value <= end);
}

export interface PromotionRegistryInput {
  ufc: UfcEvent[];
  one: OneEvent[];
  rizin: RizinEvent[];
  pfl: PflEvent[];
  ufcOdds: OddsStore;
}

export function createPromotionRegistry(input: PromotionRegistryInput): PromotionRegistry {
  const registry = new PromotionRegistry();
  registry.register({
    id: "ufc",
    name: "Ultimate Fighting Championship",
    knownBouts: () => input.ufc.flatMap((event) => event.sections.flatMap((section) => section.fights.map((fight) => ({
      promotion: "ufc", eventId: event.slug, eventName: event.title,
      redName: fight.red.name, blueName: fight.blue.name,
    })))),
    retainedEventKeys: () => input.ufc.map((event) => promotionEventKey("ufc", event.slug)),
    currentBoutKeys: (now) => input.ufc.filter((event) => event.heroStart && event.heroStart >= now).flatMap((event) =>
      event.sections.flatMap((section) => section.fights.map((fight) => promotionOddsKey("ufc", event.slug, fight.red.name, fight.blue.name)))
    ),
    eventNamesBetween: (start, end) => input.ufc.filter((event) => isBetween(event.heroStart, start, end)).map((event) => event.title),
    attachOdds: () => { attachStoredOdds(input.ufc, input.ufcOdds); },
    renderFeeds: (context) => ({
      "ufc.ics": renderCalendar(input.ufc, context),
      "ufc-combined.ics": renderCombinedCalendar(input.ufc, context),
      "ufc-fights.ics": renderEstimatedFightCalendar(input.ufc, context),
    }),
  });
  registry.register({
    id: "one",
    name: "ONE Championship",
    knownBouts: () => input.one.flatMap((event) => event.bouts.map((bout) => ({
      promotion: "one", eventId: event.uid, eventName: event.summary,
      redName: bout.redName, blueName: bout.blueName,
    }))),
    retainedEventKeys: () => input.one.map((event) => promotionEventKey("one", event.uid)),
    currentBoutKeys: (now) => input.one.filter((event) => {
      const date = oneDate(event);
      return date && date >= now;
    }).flatMap((event) => event.bouts.map((bout) => promotionOddsKey("one", event.uid, bout.redName, bout.blueName))),
    eventNamesBetween: (start, end) => input.one.filter((event) => isBetween(oneDate(event), start, end)).map((event) => event.summary),
    attachOdds: (store) => {
      for (const event of input.one) for (const bout of event.bouts) {
        Object.assign(bout, promotionOddsForBout("one", event.uid, bout.redName, bout.blueName, store));
      }
    },
    renderFeeds: ({ generatedAt, revisionProvider }) => ({
      "one.ics": renderOneCalendar(input.one, generatedAt, revisionProvider),
    }),
  });
  registry.register({
    id: "rizin",
    name: "RIZIN Fighting Federation",
    knownBouts: () => input.rizin.flatMap((event) => [...event.bouts, ...event.cancelledBouts].map((bout) => ({
      promotion: "rizin", eventId: event.uid, eventName: event.summary,
      redName: bout.red.name, blueName: bout.blue.name,
    }))),
    retainedEventKeys: () => input.rizin.map((event) => promotionEventKey("rizin", event.uid)),
    currentBoutKeys: (now) => input.rizin.filter((event) => new Date(`${event.date}T23:59:59Z`) >= now).flatMap((event) =>
      [...event.bouts, ...event.cancelledBouts].map((bout) => promotionOddsKey("rizin", event.uid, bout.red.name, bout.blue.name))
    ),
    eventNamesBetween: (start, end) => input.rizin.filter((event) => isBetween(isoDate(event.date), start, end)).map((event) => event.summary),
    attachOdds: (store) => {
      for (const event of input.rizin) for (const bout of [...event.bouts, ...event.cancelledBouts]) {
        const odds = promotionOddsForBout("rizin", event.uid, bout.red.name, bout.blue.name, store);
        bout.red.odds = odds.redOdds;
        bout.blue.odds = odds.blueOdds;
        bout.oddsHistory = odds.oddsHistory;
      }
    },
    renderFeeds: ({ generatedAt, revisionProvider }) => ({
      "rizin.ics": renderRizinCalendar(input.rizin, generatedAt, revisionProvider),
    }),
  });
  registry.register({
    id: "pfl",
    name: "Professional Fighters League",
    knownBouts: () => input.pfl.flatMap((event) => [...event.bouts, ...event.cancelledBouts].map((bout) => ({
      promotion: "pfl", eventId: event.uid, eventName: event.summary,
      redName: bout.red.name, blueName: bout.blue.name,
    }))),
    retainedEventKeys: () => input.pfl.map((event) => promotionEventKey("pfl", event.uid)),
    currentBoutKeys: (now) => input.pfl.filter((event) => new Date(`${event.date}T23:59:59Z`) >= now).flatMap((event) =>
      [...event.bouts, ...event.cancelledBouts].map((bout) => promotionOddsKey("pfl", event.uid, bout.red.name, bout.blue.name))
    ),
    eventNamesBetween: (start, end) => input.pfl.filter((event) => isBetween(isoDate(event.date), start, end)).map((event) => event.summary),
    attachOdds: (store) => {
      for (const event of input.pfl) for (const bout of [...event.bouts, ...event.cancelledBouts]) {
        const odds = promotionOddsForBout("pfl", event.uid, bout.red.name, bout.blue.name, store);
        bout.red.odds = odds.redOdds;
        bout.blue.odds = odds.blueOdds;
        bout.oddsHistory = odds.oddsHistory;
      }
    },
    renderFeeds: ({ generatedAt, revisionProvider }) => ({
      "pfl.ics": renderPflCalendar(input.pfl, generatedAt, revisionProvider),
    }),
  });
  return registry;
}
