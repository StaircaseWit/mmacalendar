import { renderCalendarDescription, renderCalendarFeed } from "../../calendar-renderer.js";
import type { CalendarBoutModel, CalendarDescriptionModel, CalendarEventModel } from "../../calendar-model.js";
import {
  BEST_FIGHT_ODDS_URL,
  formatPromotionOdds,
  promotionOddsHistoryRows,
  shortPromotionFighterName,
} from "../../promotion-odds.js";
import type { RevisionProvider } from "../../revision.js";
import type { RizinEvent, RizinFighter } from "./source.js";
import { ageOnDate, cleanText, flagEmoji } from "../../utils.js";
import { rizinDivisionForKilograms } from "./divisions.js";

function fighterFacts(fighter: RizinFighter, eventDate: string): string[] {
  const age = ageOnDate(fighter.birthDate, new Date(`${eventDate}T12:00:00Z`));
  const odds = formatPromotionOdds(fighter.odds);
  return [fighter.record ? `RIZIN ${fighter.record}` : null, age === null ? null : `${age}yo`, fighter.style, odds]
    .filter((value): value is string => Boolean(value));
}

export function describeRizinBout(details: string): string {
  let value = cleanText(details);
  const kilograms = value.match(/^([\d.]+)kg\b/i)?.[1]?.replace(/\.0$/, "");
  if (kilograms && !/\b(?:Atomweight|Flyweight|Bantamweight|Featherweight|Lightweight|Welterweight|Middleweight|Heavyweight|Catchweight)\b/i.test(value)) {
    value = value.replace(/^([\d.]+kg)\b/i, `$1 ${rizinDivisionForKilograms(kilograms) ?? "Catchweight"}`);
  }
  return value.replace(/^([\d.]+)kg\b/i, (match, kilogramsValue: string) => {
    const pounds = (Number(kilogramsValue) * 2.2046226218).toFixed(1).replace(/\.0$/, "");
    return `${pounds}lbs/${match}`;
  });
}

function descriptionFor(event: RizinEvent): CalendarDescriptionModel {
  const boutCount = event.bouts.length === 1 ? "1 announced bout" : `${event.bouts.length} announced bouts`;
  const timing = event.start
    ? event.timeIsTentative ? "Start time is provisional and will update when RIZIN confirms it." : "Times display automatically in your calendar time zone. End time is approximate."
    : "Start time has not been announced. This date-only entry will update automatically.";
  const sections = (["Main Card", "Opening Fights"] as const).flatMap((sectionName) => {
    const sectionBouts = event.bouts.filter((bout) => bout.section === sectionName);
    if (!sectionBouts.length) return [];
    const count = sectionBouts.length === 1 ? "1 bout" : `${sectionBouts.length} bouts`;
    const bouts: CalendarBoutModel[] = sectionBouts.map((bout) => ({
      order: bout.order,
      red: { name: bout.red.name, shortName: shortPromotionFighterName(bout.red.name), flag: flagEmoji(bout.red.countryCode), facts: fighterFacts(bout.red, event.date) },
      blue: { name: bout.blue.name, shortName: shortPromotionFighterName(bout.blue.name), flag: flagEmoji(bout.blue.countryCode), facts: fighterFacts(bout.blue, event.date) },
      details: bout.details ? describeRizinBout(bout.details) : undefined,
      oddsHistoryRows: promotionOddsHistoryRows(bout.oddsHistory, bout.red.name, bout.blue.name),
    }));
    return [{ heading: `── ${sectionName.toUpperCase()} · ${count} ──`, bouts }];
  });
  const oddsSource = event.bouts.some((bout) => bout.oddsHistory?.length)
    ? `Odds source: ${BEST_FIGHT_ODDS_URL} · best available line · checked Monday and Friday`
    : null;
  return {
    overview: [
      `RIZIN Fighting Federation · Complete Event · ${event.bouts.length ? boutCount : "card details to be announced"}`,
      `📍 ${event.location || "Venue to be announced"}`,
      timing,
    ],
    sections,
    emptyText: "No bouts announced yet.",
    cancelledBouts: event.cancelledBouts.map((bout) => ({
      redName: bout.red.name, blueName: bout.blue.name,
      note: bout.note ?? "Removed from the official RIZIN card", layout: "stacked",
    })),
    footer: [`Source: ${event.cardUrl ?? event.url}`, ...(oddsSource ? [oddsSource] : [])],
  };
}

export function renderRizinCalendar(events: RizinEvent[], generatedAt = new Date(), revisionProvider?: RevisionProvider): string {
  const calendarEvents: CalendarEventModel[] = events.map((event) => {
    const description = descriptionFor(event);
    const descriptionText = renderCalendarDescription(description);
    return {
      uid: `${event.uid}@mma-calendar-rizin`, revisionKey: `rizin:${event.uid}`,
      timing: event.start && event.end ? { kind: "timed", start: event.start, end: event.end } : { kind: "all-day", startDate: event.date },
      summary: event.summary, description, location: event.location, url: event.url,
      categories: ["RIZIN Fighting Federation"], status: event.status,
      revisionContent: {
        date: event.date, start: event.start, end: event.end, summary: event.summary,
        description: descriptionText, location: event.location, url: event.url, status: event.status,
      },
    };
  });
  return renderCalendarFeed({
    productId: "-//MMA Calendar//RIZIN Fighting Federation//EN",
    name: "RIZIN Fighting Federation",
    description: "RIZIN events and announced bouts.",
    color: "#CF1F2B",
    events: calendarEvents,
    generatedAt,
    revisionProvider,
  });
}
