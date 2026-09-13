import type { CalendarStatus, SourceHealth, SourceName } from "../health.js";

export interface PromotionLoadContext {
  now: Date;
  previousStatus: CalendarStatus;
  dataPath: (name: string) => string;
}

export interface LoadedPromotion<TEvent> {
  id: Exclude<SourceName, "bestfightodds">;
  events: TEvent[];
  health: SourceHealth;
  persist: () => Promise<void>;
}

export function sourceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isoDate(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.valueOf()) ? parsed : null;
}
