import { renderCalendarDescription, renderCalendarFeed } from "../../calendar-renderer.js";
import type { CalendarBoutModel, CalendarDescriptionModel, CalendarEventModel } from "../../calendar-model.js";
import type { PflEvent, PflFighter } from "./source.js";
import { BEST_FIGHT_ODDS_URL, formatPromotionOdds, promotionOddsHistoryRows } from "../../promotion-odds.js";
import type { RevisionProvider } from "../../revision.js";
import { ageOnDate, cleanText, flagEmoji } from "../../utils.js";

function shortName(name: string): string {
  const parts = cleanText(name).split(" ");
  if (/^(?:jr\.?|sr\.?|ii|iii|iv)$/i.test(parts.at(-1) ?? "") && parts.length > 1) parts.pop();
  return parts.at(-1) || name;
}

function fighterFacts(fighter: PflFighter, eventDate: string, opponentOdds: string | null | undefined): string[] {
  const age = ageOnDate(fighter.birthDate, new Date(`${eventDate}T12:00:00Z`));
  const plausibleAge = age !== null && age >= 16 && age <= 65 ? `${age}yo` : null;
  const odds = formatPromotionOdds(fighter.odds, opponentOdds);
  return [fighter.record, plausibleAge, fighter.style, odds].filter((value): value is string => Boolean(value));
}

function descriptionFor(event: PflEvent): CalendarDescriptionModel {
  const boutCount = event.bouts.length === 1 ? "1 announced bout" : `${event.bouts.length} announced bouts`;
  const timing = event.start
    ? "Times display automatically in your calendar time zone. End time is approximate."
    : "Card times have not been announced. This date-only entry will update automatically.";
  const bouts: CalendarBoutModel[] = event.bouts.map((bout) => ({
    order: bout.order,
    red: { name: bout.red.name, shortName: shortName(bout.red.name), flag: flagEmoji(bout.red.countryCode), facts: fighterFacts(bout.red, event.date, bout.blue.odds) },
    blue: { name: bout.blue.name, shortName: shortName(bout.blue.name), flag: flagEmoji(bout.blue.countryCode), facts: fighterFacts(bout.blue, event.date, bout.red.odds) },
    details: bout.details || undefined,
    oddsHistoryRows: promotionOddsHistoryRows(bout.oddsHistory, bout.red.name, bout.blue.name),
  }));
  const oddsSource = event.bouts.some((bout) => bout.oddsHistory?.length)
    ? `Odds source: ${BEST_FIGHT_ODDS_URL} · best available line · checked Monday and Friday`
    : null;
  return {
    overview: [
      `Professional Fighters League · Complete Event · ${event.bouts.length ? boutCount : "card details to be announced"}`,
      `📍 ${event.location || "Venue to be announced"}`,
      timing,
    ],
    sections: [{ bouts }],
    emptyText: "No bouts announced yet.",
    cancelledBouts: event.cancelledBouts.map((bout) => ({
      redName: bout.red.name, blueName: bout.blue.name,
      note: bout.note ?? "Removed from the official PFL card", layout: "stacked",
    })),
    footer: [`Source: ${event.url}`, ...(oddsSource ? [oddsSource] : [])],
  };
}

export function renderPflCalendar(events: PflEvent[], generatedAt = new Date(), revisionProvider?: RevisionProvider): string {
  const calendarEvents: CalendarEventModel[] = events.map((event) => {
    const description = descriptionFor(event);
    const descriptionText = renderCalendarDescription(description);
    return {
      uid: `${event.uid}@mma-calendar-pfl`, revisionKey: `pfl:${event.uid}`,
      timing: event.start && event.end ? { kind: "timed", start: event.start, end: event.end } : { kind: "all-day", startDate: event.date },
      summary: event.summary, description, location: event.location, url: event.url,
      categories: ["Professional Fighters League"], status: event.status,
      revisionContent: {
        date: event.date, start: event.start, end: event.end, summary: event.summary,
        description: descriptionText, location: event.location, url: event.url, status: event.status,
      },
    };
  });
  return renderCalendarFeed({
    productId: "-//MMA Calendar//Professional Fighters League//EN",
    name: "Professional Fighters League",
    description: "PFL events and announced bouts.",
    color: "#102A83",
    events: calendarEvents,
    generatedAt,
    revisionProvider,
  });
}
