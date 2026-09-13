import type { PromotionOddsStore } from "../promotion-odds.js";
import { createOnePromotion, type OneEvent } from "./one/index.js";
import { createPflPromotion, type PflEvent } from "./pfl/index.js";
import { createRizinPromotion, type RizinEvent } from "./rizin/index.js";
import { createUfcPromotion, type OddsStore, type UfcEvent } from "./ufc/index.js";
import type { PromotionAdapter, PromotionId, PromotionRenderContext } from "./definition.js";

export type { PromotionAdapter, PromotionId, PromotionRenderContext } from "./definition.js";

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

  knownBouts() {
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

export interface PromotionRegistryInput {
  ufc: UfcEvent[];
  one: OneEvent[];
  rizin: RizinEvent[];
  pfl: PflEvent[];
  ufcOdds: OddsStore;
}

export function createPromotionRegistry(input: PromotionRegistryInput): PromotionRegistry {
  return new PromotionRegistry()
    .register(createUfcPromotion(input.ufc, input.ufcOdds))
    .register(createOnePromotion(input.one))
    .register(createRizinPromotion(input.rizin))
    .register(createPflPromotion(input.pfl));
}
