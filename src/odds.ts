import { DAY_MS } from "./config.js";
import { fightKey, normalizedName } from "./utils.js";
import type { Fight, OddsSnapshot, OddsStore, UfcEvent } from "./types.js";

export function oddsRefreshIsDue(store: OddsStore, now = new Date()): boolean {
  if (!store.lastCheckedAt) return true;
  const lastCheck = new Date(store.lastCheckedAt);
  return Number.isNaN(lastCheck.valueOf()) || now.valueOf() - lastCheck.valueOf() >= 7 * DAY_MS;
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
