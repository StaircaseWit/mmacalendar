import { renderCalendarDescription, renderCalendarFeed } from "../../calendar-renderer.js";
import type { CalendarBoutModel, CalendarDescriptionModel, CalendarEventModel } from "../../calendar-model.js";
import type { OneEvent } from "../../one.js";
import {
  BEST_FIGHT_ODDS_URL,
  formatPromotionOdds,
  promotionOddsHistoryRows,
  shortPromotionFighterName,
} from "../../promotion-odds.js";
import type { RevisionProvider } from "../../revision.js";
import { cleanText, countryFlags } from "../../utils.js";

const ONE_WEIGHT_LIMITS: Array<[RegExp, string]> = [
  [/Light Heavyweight/i, "225lbs/102.1kg Light Heavyweight"],
  [/Heavyweight/i, "265lbs/120.2kg Heavyweight"],
  [/Middleweight/i, "205lbs/93kg Middleweight"],
  [/Welterweight/i, "185lbs/83.9kg Welterweight"],
  [/Lightweight/i, "170lbs/77.1kg Lightweight"],
  [/Featherweight/i, "155lbs/70.3kg Featherweight"],
  [/Bantamweight/i, "145lbs/65.8kg Bantamweight"],
  [/Flyweight/i, "135lbs/61.2kg Flyweight"],
  [/Strawweight/i, "125lbs/56.7kg Strawweight"],
  [/Atomweight/i, "115lbs/52.2kg Atomweight"],
];

export function describeOneBout(details: string): string {
  const value = cleanText(details);
  const pounds = value.match(/\b([\d.]+)\s*LBS\b/i)?.[1];
  if (pounds) {
    const kilograms = (Number(pounds) * 0.45359237).toFixed(1).replace(/\.0$/, "");
    return value.replace(/\b[\d.]+\s*LBS\b/i, `${pounds}lbs/${kilograms}kg`);
  }
  const division = ONE_WEIGHT_LIMITS.find(([pattern]) => pattern.test(value));
  return division ? value.replace(division[0], division[1]) : value;
}

function fighterFacts(
  record: string | null | undefined,
  age: number | null | undefined,
  odds: string | null,
  style: string | null | undefined,
): string[] {
  return [record ? `ONE ${record}` : null, age ? `${age}yo` : null, style, odds]
    .filter((value): value is string => Boolean(value));
}

function descriptionFor(event: OneEvent): CalendarDescriptionModel {
  const boutCount = event.bouts.length === 1 ? "1 bout" : `${event.bouts.length} bouts`;
  const bouts: CalendarBoutModel[] = event.bouts.map((bout, index) => ({
    order: event.bouts.length - index,
    red: {
      name: bout.redName,
      shortName: shortPromotionFighterName(bout.redName),
      flag: countryFlags(bout.redCountry),
      facts: fighterFacts(bout.redRecord, bout.redAge, formatPromotionOdds(bout.redOdds, bout.blueOdds), bout.redStyle),
    },
    blue: {
      name: bout.blueName,
      shortName: shortPromotionFighterName(bout.blueName),
      flag: countryFlags(bout.blueCountry),
      facts: fighterFacts(bout.blueRecord, bout.blueAge, formatPromotionOdds(bout.blueOdds, bout.redOdds), bout.blueStyle),
    },
    details: bout.details ? describeOneBout(bout.details) : undefined,
    oddsHistoryRows: promotionOddsHistoryRows(bout.oddsHistory, bout.redName, bout.blueName),
  }));
  const oddsSource = event.bouts.some((bout) => bout.oddsHistory?.length)
    ? `Odds source: ${BEST_FIGHT_ODDS_URL} · best available line · checked Monday and Friday`
    : null;
  return {
    overview: [
      `ONE Championship · Complete Event · ${event.bouts.length ? boutCount : "card details to be announced"}`,
      `📍 ${event.location || "Venue to be announced"}`,
      "Times display automatically in your calendar time zone.",
    ],
    sections: [{ bouts }],
    emptyText: "No bouts announced yet.",
    footer: [`Source: ${event.detailsUrl ?? event.url}`, ...(oddsSource ? [oddsSource] : [])],
  };
}

export function renderOneCalendar(events: OneEvent[], generatedAt = new Date(), revisionProvider?: RevisionProvider): string {
  const calendarEvents: CalendarEventModel[] = events.map((event) => {
    const status = /^(?:CONFIRMED|TENTATIVE|CANCELLED)$/.test(event.status)
      ? event.status as CalendarEventModel["status"]
      : "CONFIRMED";
    const description = descriptionFor(event);
    const descriptionText = renderCalendarDescription(description);
    return {
      uid: `${event.uid}@mma-calendar-one`, revisionKey: `one:${event.uid}`,
      timing: { kind: "timed", start: event.start, end: event.end },
      summary: event.summary, description, location: event.location, url: event.url,
      categories: ["ONE Championship"], status,
      revisionContent: {
        start: event.start, end: event.end, summary: event.summary, description: descriptionText,
        location: event.location, url: event.url, status,
      },
    };
  });
  return renderCalendarFeed({
    productId: "-//MMA Calendar//ONE Championship//EN",
    name: "ONE Championship",
    description: "ONE Championship events and announced bouts.",
    color: "#202428",
    events: calendarEvents,
    generatedAt,
    revisionProvider,
  });
}
