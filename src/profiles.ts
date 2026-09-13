import { DAY_MS } from "./config.js";
import { scrapeAthlete } from "./ufc.js";
import { mapWithConcurrency } from "./utils.js";
import type { AthleteProfile, FighterStore, UfcEvent } from "./types.js";

function profileIsFresh(profile: AthleteProfile | undefined, now: Date): boolean {
  const checkedAt = new Date(profile?.checkedAt ?? 0);
  return Object.hasOwn(profile ?? {}, "familyName")
    && Object.hasOwn(profile ?? {}, "fightingStyle")
    && !Number.isNaN(checkedAt.valueOf())
    && now.valueOf() - checkedAt.valueOf() < 7 * DAY_MS;
}

export async function enrichFighterProfiles(events: UfcEvent[], store: FighterStore, now = new Date()): Promise<UfcEvent[]> {
  store.fighters ??= {};
  const urls = new Set<string>();
  for (const event of events) {
    for (const section of event.sections) {
      for (const fight of section.fights) {
        for (const fighter of [fight.red, fight.blue]) {
          if (fighter.profileUrl && !profileIsFresh(store.fighters[fighter.profileUrl], now)) urls.add(fighter.profileUrl);
        }
      }
    }
  }

  await mapWithConcurrency([...urls], 6, async (url) => {
    try {
      store.fighters[url] = { ...(await scrapeAthlete(url)), checkedAt: now.toISOString() };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Keeping cached profile after fetch failure for ${url}: ${message}`);
    }
  });

  for (const event of events) {
    for (const section of event.sections) {
      for (const fight of section.fights) {
        for (const fighter of [fight.red, fight.blue]) {
          const profile: Partial<AthleteProfile> = fighter.profileUrl ? store.fighters[fighter.profileUrl] ?? {} : {};
          if (profile.record) profile.record = profile.record.replace(/\s*\(W-L-D\)$/i, "");
          fighter.record = profile.record ?? null;
          fighter.birthDate = profile.birthDate ?? null;
          fighter.familyName = profile.familyName ?? null;
          fighter.fightingStyle = profile.fightingStyle ?? null;
        }
      }
    }
  }
  return events;
}
