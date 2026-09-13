import { DAY_MS } from "../settings.js";
import {
  VALID_ODDS,
  canonicalOddsName,
  eventNameScore,
  fighterPairKey,
  promotionEventKey,
  promotionOddsKey,
  type AttachedPromotionOdds,
  type KnownOddsBout,
  type PromotionOddsMarket,
  type PromotionOddsSnapshot,
  type PromotionOddsStore,
} from "./model.js";

export function promotionOddsRefreshIsDue(store: PromotionOddsStore, now = new Date()): boolean {
  if (!store.lastCheckedAt) return true;
  const lastCheck = new Date(store.lastCheckedAt);
  return Number.isNaN(lastCheck.valueOf()) || now.valueOf() - lastCheck.valueOf() >= 3 * DAY_MS;
}

export function prunePromotionOddsStore(
  store: PromotionOddsStore,
  retainedEvents: ReadonlySet<string>,
): PromotionOddsStore {
  store.fights ??= {};
  for (const [key, history] of Object.entries(store.fights)) {
    const latest = history.at(-1);
    const promotion = latest?.promotion;
    const eventId = latest?.eventId;
    if (promotion && eventId && !retainedEvents.has(promotionEventKey(promotion, eventId))) {
      delete store.fights[key];
    }
  }
  return store;
}

function snapshotsDiffer(left: PromotionOddsSnapshot | undefined, right: PromotionOddsSnapshot): boolean {
  const values = (snapshot: PromotionOddsSnapshot | undefined): string => JSON.stringify(
    Object.entries(snapshot?.odds ?? {}).sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
  );
  return values(left) !== values(right);
}

export function compactPromotionOddsStore(store: PromotionOddsStore): PromotionOddsStore {
  for (const [key, history] of Object.entries(store.fights ?? {})) {
    store.fights[key] = history.filter((snapshot, index) => index === 0 || snapshotsDiffer(history[index - 1], snapshot));
  }
  return store;
}

/** Move unambiguous legacy fighter-pair histories into event-specific keys. */
export function migratePromotionOddsStore(
  store: PromotionOddsStore,
  knownBouts: KnownOddsBout[],
): PromotionOddsStore {
  store.fights ??= {};
  for (const [legacyKey, history] of Object.entries({ ...store.fights })) {
    if (legacyKey.includes("::")) continue;
    const candidates = knownBouts.filter((bout) => fighterPairKey(bout.redName, bout.blueName) === legacyKey);
    if (!candidates.length) continue;
    let selected: KnownOddsBout | undefined;
    if (candidates.length === 1) {
      selected = candidates[0];
    } else {
      const eventName = history.at(-1)?.eventName ?? "";
      const ranked = candidates
        .map((bout) => ({ bout, score: eventNameScore(eventName, bout.eventName) }))
        .sort((left, right) => right.score - left.score);
      if (ranked[0] && ranked[0].score >= 75 && ranked[0].score > (ranked[1]?.score ?? -1)) {
        selected = ranked[0].bout;
      }
    }
    if (!selected) continue;
    const key = promotionOddsKey(selected.promotion, selected.eventId, selected.redName, selected.blueName);
    const migrated = history.map((snapshot) => ({
      ...snapshot,
      promotion: selected!.promotion,
      eventId: selected!.eventId,
      eventName: selected!.eventName,
    }));
    store.fights[key] = [...(store.fights[key] ?? []), ...migrated]
      .filter((snapshot, index, snapshots) =>
        index === 0
        || snapshots[index - 1]!.checkedAt !== snapshot.checkedAt
        || snapshotsDiffer(snapshots[index - 1], snapshot)
      );
    delete store.fights[legacyKey];
  }
  return compactPromotionOddsStore(store);
}

export function updatePromotionOddsStore(
  store: PromotionOddsStore,
  markets: PromotionOddsMarket[],
  now = new Date(),
): PromotionOddsStore {
  const checkedAt = now.toISOString();
  store.fights ??= {};
  const seen = new Set<string>();
  for (const market of markets) {
    if (!market.promotion || !market.eventId) continue;
    const key = promotionOddsKey(market.promotion, market.eventId, market.redName, market.blueName);
    if (seen.has(key)) continue;
    seen.add(key);
    const redKey = canonicalOddsName(market.redName);
    const blueKey = canonicalOddsName(market.blueName);
    const snapshot: PromotionOddsSnapshot = {
      checkedAt,
      eventName: market.eventName,
      sourceUrl: market.sourceUrl,
      promotion: market.promotion,
      eventId: market.eventId,
      odds: { [redKey]: market.redOdds, [blueKey]: market.blueOdds },
      names: { [redKey]: market.redName, [blueKey]: market.blueName },
    };
    const history = store.fights[key] ?? [];
    if (!history.length || snapshotsDiffer(history.at(-1), snapshot)) history.push(snapshot);
    store.fights[key] = history;
  }
  store.lastCheckedAt = checkedAt;
  return store;
}

export function promotionOddsForBout(
  promotion: string,
  eventId: string,
  redName: string,
  blueName: string,
  store: PromotionOddsStore,
): AttachedPromotionOdds {
  const oddsHistory = store.fights?.[promotionOddsKey(promotion, eventId, redName, blueName)] ?? [];
  const latest = oddsHistory.at(-1)?.odds ?? {};
  const redOdds = latest[canonicalOddsName(redName)] ?? null;
  const blueOdds = latest[canonicalOddsName(blueName)] ?? null;
  return {
    redOdds: VALID_ODDS.test(redOdds ?? "") ? redOdds : null,
    blueOdds: VALID_ODDS.test(blueOdds ?? "") ? blueOdds : null,
    oddsHistory,
  };
}
