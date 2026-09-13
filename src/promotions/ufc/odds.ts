import { DAY_MS } from "../../settings.js";
import { fightKey, normalizedName } from "../../utils.js";
import { BEST_FIGHT_ODDS_URL, canonicalOddsName, promotionOddsKey, type PromotionOddsMarket } from "../../promotion-odds.js";
import type { Fight, OddsSnapshot, OddsStore, UfcEvent } from "./types.js";

export function oddsRefreshIsDue(store: OddsStore, now = new Date()): boolean {
  if (store.source !== BEST_FIGHT_ODDS_URL) return true;
  if (!store.lastCheckedAt) return true;
  const lastCheck = new Date(store.lastCheckedAt);
  return Number.isNaN(lastCheck.valueOf()) || now.valueOf() - lastCheck.valueOf() >= 3 * DAY_MS;
}

export function pruneUfcOddsStore(store: OddsStore, retainedEventSlugs: ReadonlySet<string>): OddsStore {
  store.fights ??= {};
  for (const key of Object.keys(store.fights)) {
    const eventSlug = key.split("::", 1)[0] ?? "";
    if (!retainedEventSlugs.has(eventSlug)) delete store.fights[key];
  }
  return store;
}

function sourceSnapshot(fight: Fight, checkedAt: string): OddsSnapshot {
  const redKey = normalizedName(fight.red.name);
  const blueKey = normalizedName(fight.blue.name);
  return {
    checkedAt,
    odds: {
      [redKey]: fight.red.sourceOdds,
      [blueKey]: fight.blue.sourceOdds,
    },
    names: {
      [redKey]: fight.red.name,
      [blueKey]: fight.blue.name,
    },
  };
}

function snapshotsDiffer(left: OddsSnapshot | undefined, right: OddsSnapshot): boolean {
  return JSON.stringify(left?.odds ?? {}) !== JSON.stringify(right?.odds ?? {});
}

export function updateOddsStore(store: OddsStore, events: UfcEvent[], now = new Date()): OddsStore {
  const checkedAt = now.toISOString();
  store.fights ??= {};
  for (const event of events) {
    for (const section of event.sections) {
      for (const fight of section.fights) {
        if (!fight.red.sourceOdds && !fight.blue.sourceOdds) continue;
        const key = fightKey(event.slug, fight.red.name, fight.blue.name);
        const history = store.fights[key] ?? [];
        const snapshot = sourceSnapshot(fight, checkedAt);
        if (!history.length || snapshotsDiffer(history.at(-1), snapshot)) history.push(snapshot);
        store.fights[key] = history;
      }
    }
  }
  store.lastCheckedAt = checkedAt;
  return store;
}

export function updateOddsStoreFromBestFightOdds(
  store: OddsStore,
  events: UfcEvent[],
  markets: PromotionOddsMarket[],
  now = new Date(),
): OddsStore {
  const checkedAt = now.toISOString();
  const marketsByBout = new Map(markets.flatMap((market) =>
    market.promotion === "ufc" && market.eventId
      ? [[promotionOddsKey("ufc", market.eventId, market.redName, market.blueName), market] as const]
      : []
  ));
  store.fights ??= {};
  for (const event of events) {
    const eventStart = event.sections
      .map((section) => section.start)
      .filter((start): start is Date => Boolean(start))
      .sort((left, right) => left.valueOf() - right.valueOf())[0];
    if (eventStart && eventStart <= now) continue;
    for (const section of event.sections) {
      for (const fight of section.fights) {
        const market = marketsByBout.get(promotionOddsKey("ufc", event.slug, fight.red.name, fight.blue.name));
        if (!market) continue;
        const redKey = normalizedName(fight.red.name);
        const blueKey = normalizedName(fight.blue.name);
        const marketOdds = new Map([
          [canonicalOddsName(market.redName), market.redOdds],
          [canonicalOddsName(market.blueName), market.blueOdds],
        ]);
        const snapshot: OddsSnapshot = {
          checkedAt,
          eventName: market.eventName,
          sourceUrl: market.sourceUrl,
          odds: {
            [redKey]: marketOdds.get(canonicalOddsName(fight.red.name)) ?? null,
            [blueKey]: marketOdds.get(canonicalOddsName(fight.blue.name)) ?? null,
          },
          names: { [redKey]: fight.red.name, [blueKey]: fight.blue.name },
        };
        const key = fightKey(event.slug, fight.red.name, fight.blue.name);
        const history = store.fights[key] ?? [];
        if (!history.length || snapshotsDiffer(history.at(-1), snapshot)) history.push(snapshot);
        store.fights[key] = history;
      }
    }
  }
  store.lastCheckedAt = checkedAt;
  store.source = BEST_FIGHT_ODDS_URL;
  return store;
}

export function discardPostStartBestFightOddsSnapshots(events: UfcEvent[], store: OddsStore): OddsStore {
  for (const event of events) {
    const eventStart = event.sections
      .map((section) => section.start)
      .filter((start): start is Date => Boolean(start))
      .sort((left, right) => left.valueOf() - right.valueOf())[0];
    if (!eventStart) continue;
    for (const section of event.sections) {
      for (const fight of section.fights) {
        const key = fightKey(event.slug, fight.red.name, fight.blue.name);
        const history = store.fights[key];
        if (!history) continue;
        store.fights[key] = history.filter((snapshot) => {
          if (!snapshot.sourceUrl?.startsWith(BEST_FIGHT_ODDS_URL)) return true;
          const checkedAt = new Date(snapshot.checkedAt);
          return !Number.isFinite(checkedAt.valueOf()) || checkedAt < eventStart;
        });
      }
    }
  }
  return store;
}

export function attachStoredOdds(events: UfcEvent[], store: OddsStore): UfcEvent[] {
  for (const event of events) {
    for (const section of event.sections) {
      for (const fight of section.fights) {
        const key = fightKey(event.slug, fight.red.name, fight.blue.name);
        fight.oddsHistory = store.fights?.[key] ?? [];
        for (const snapshot of fight.oddsHistory) {
          snapshot.names ??= {
            [normalizedName(fight.red.name)]: fight.red.name,
            [normalizedName(fight.blue.name)]: fight.blue.name,
          };
          for (const [name, odds] of Object.entries(snapshot.odds ?? {})) {
            if (!/^[+-]\d+$|^EVEN$/i.test(odds ?? "")) snapshot.odds[name] = null;
          }
        }
        const latest = fight.oddsHistory.at(-1)?.odds ?? {};
        const redOdds = latest[normalizedName(fight.red.name)];
        const blueOdds = latest[normalizedName(fight.blue.name)];
        fight.red.odds = /^[+-]\d+$|^EVEN$/i.test(redOdds ?? "") ? redOdds : null;
        fight.blue.odds = /^[+-]\d+$|^EVEN$/i.test(blueOdds ?? "") ? blueOdds : null;
      }
    }
  }
  return events;
}
