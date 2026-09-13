export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_PUBLIC_BASE_URL = "https://staircasewit.github.io/mmacalendar";
export const DEFAULT_DISPLAY_TIME_ZONE = "Europe/Dublin";
export const DEFAULT_DISPLAY_TIME_ZONE_LABEL = "Ireland";
export const DEFAULT_REFRESH_INTERVAL = "PT6H";

export interface RuntimeSettings {
  publicBaseUrl: string;
  displayTimeZone: string;
  displayTimeZoneLabel: string;
  ufcEventUrls: string[];
  ufcEventPages: number[];
  ufcMaxEvents: number;
  ufcPastDays: number;
  onePastDays: number;
  rizinMaxEvents: number;
  rizinPastDays: number;
  pflMaxEvents: number;
  pflPastDays: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function canonicalPublicBaseUrl(value = DEFAULT_PUBLIC_BASE_URL): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function loadRuntimeSettings(env: NodeJS.ProcessEnv = process.env): RuntimeSettings {
  return {
    publicBaseUrl: canonicalPublicBaseUrl(env.PUBLIC_BASE_URL),
    displayTimeZone: env.DISPLAY_TIME_ZONE?.trim() || DEFAULT_DISPLAY_TIME_ZONE,
    displayTimeZoneLabel: env.DISPLAY_TIME_ZONE_LABEL?.trim() || DEFAULT_DISPLAY_TIME_ZONE_LABEL,
    ufcEventUrls: (env.UFC_EVENT_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    ufcEventPages: (env.UFC_EVENT_PAGES ?? "0,1,2").split(",").map(Number).filter(Number.isFinite),
    ufcMaxEvents: positiveInteger(env.MAX_EVENTS, 50),
    ufcPastDays: positiveInteger(env.PAST_DAYS, 120),
    onePastDays: positiveInteger(env.ONE_PAST_DAYS, 180),
    rizinMaxEvents: positiveInteger(env.RIZIN_MAX_EVENTS, 20),
    rizinPastDays: positiveInteger(env.RIZIN_PAST_DAYS, 180),
    pflMaxEvents: positiveInteger(env.PFL_MAX_EVENTS, 30),
    pflPastDays: positiveInteger(env.PFL_PAST_DAYS, 180),
  };
}
