import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { CARD_DEFINITIONS, DAY_MS, UFC_ORIGIN } from "./config.js";
import type { AthleteProfile, Fighter, Fight, UfcEvent } from "./types.js";
import {
  absoluteUrl,
  cleanText,
  countryCodeFromFlag,
  parseTimestamp,
  slugFromUrl,
} from "../../utils.js";
import { fetchText } from "../../http.js";

interface EventListing {
  url: string;
  start: Date;
}

interface DiscoveryOptions {
  now?: Date;
  pages?: number[];
  maxEvents?: number;
  pastDays?: number;
}

interface SchemaPerson {
  "@type"?: string;
  birthDate?: string;
  familyName?: string;
}

interface StructuredDataEntry {
  "@type"?: string;
  "@graph"?: StructuredDataEntry[];
  mainEntity?: SchemaPerson;
  birthDate?: string;
  familyName?: string;
}

export function parseEventsListing(html: string, now = new Date(), futureDays = 180, pastDays = 120): EventListing[] {
  const $ = cheerio.load(html);
  const found = new Map();
  const earliest = now.valueOf() - pastDays * DAY_MS;
  const latest = now.valueOf() + futureDays * DAY_MS;

  $(".c-card-event--result__headline a[href*='/event/']").each((_, link) => {
    const url = absoluteUrl($(link).attr("href"), UFC_ORIGIN);
    const container = $(link).closest(".c-card-event--result");
    const dateElement = container.find(".c-card-event--result__date").first();
    const start = parseTimestamp(dateElement.attr("data-main-card-timestamp"));
    if (!url || !start || start.valueOf() < earliest || start.valueOf() > latest) return;
    found.set(url, { url, start });
  });

  return [...found.values()].sort((a, b) => a.start.valueOf() - b.start.valueOf());
}

export async function discoverUpcomingEventUrls({ now = new Date(), pages = [0, 1, 2], maxEvents = 50, pastDays = 120 }: DiscoveryOptions = {}): Promise<string[]> {
  const batches = await Promise.all(
    pages.map(async (page) => parseEventsListing(await fetchText(`${UFC_ORIGIN}/events?page=${page}`), now, 180, pastDays)),
  );
  const merged = new Map(batches.flat().map((event) => [event.url, event]));
  return [...merged.values()].sort((a, b) => a.start.valueOf() - b.start.valueOf()).slice(0, maxEvents).map(({ url }) => url);
}

function parseFighter($: CheerioAPI, fight: Cheerio<AnyNode>, corner: "red" | "blue", rank: string, odds: string | undefined): Fighter {
  const root = fight.find(`.c-listing-fight__corner-name--${corner}`).first();
  const anchor = root.find("a").first();
  const country = fight.find(`.c-listing-fight__country--${corner}`).first();
  const countryCode = countryCodeFromFlag(country.find("img").attr("src"));
  return {
    name: cleanText(root.text()),
    rank: cleanText(rank).replace(/^#/, "") || null,
    profileUrl: absoluteUrl(anchor.attr("href"), UFC_ORIGIN),
    country: cleanText(country.find(".c-listing-fight__country-text").text()) || null,
    countryCode,
    sourceOdds: /^[+-]\d+$|^EVEN$/i.test(cleanText(odds)) ? cleanText(odds).toUpperCase() : null,
  };
}

function parseFight($: CheerioAPI, element: AnyNode): Fight | null {
  const fight = $(element);
  const rankElements = fight
    .find(".c-listing-fight__class--desktop .c-listing-fight__corner-rank")
    .toArray();
  const odds = fight.find(".c-listing-fight__odds-amount").toArray().map((node) => $(node).text());
  const red = parseFighter($, fight, "red", rankElements[0] ? $(rankElements[0]).text() : "", odds[0]);
  const blue = parseFighter($, fight, "blue", rankElements[1] ? $(rankElements[1]).text() : "", odds[1]);
  if (!red.name || !blue.name) return null;
  return {
    id: fight.attr("data-fmid") || null,
    weightClass: cleanText(fight.find(".c-listing-fight__class--desktop .c-listing-fight__class-text").first().text()),
    red,
    blue,
  };
}

function sectionStart(section: Cheerio<AnyNode>): Date | null {
  return parseTimestamp(section.find(".c-event-fight-card-broadcaster__time[data-timestamp]").first().attr("data-timestamp"));
}

function publishedCardStarts($: CheerioAPI): Map<string, Date> {
  const starts = new Map<string, Date>();
  $(".c-listing-viewing-option").each((_, option) => {
    const root = $(option);
    const label = cleanText(root.find(".c-listing-viewing-option__fight-card").text()).toLowerCase();
    const start = parseTimestamp(root.find(".c-listing-viewing-option__time[data-timestamp]").attr("data-timestamp"));
    if (!start) return;
    const definition = CARD_DEFINITIONS.find((candidate) => {
      if (candidate.key === "early-prelims") return /early\s+prelims?/.test(label);
      if (candidate.key === "prelims") return /^(?:the\s+)?prelims?$/.test(label);
      return /main\s+card/.test(label);
    });
    if (definition && !starts.has(definition.key)) starts.set(definition.key, start);
  });
  return starts;
}

export function parseEventPage(html: string, url: string): UfcEvent {
  const $ = cheerio.load(html);
  const prefix = cleanText($(".c-hero__headline-prefix").first().text());
  const headlineElement = $(".c-hero__headline").first();
  const topName = cleanText(headlineElement.find(".e-divider__top").text());
  const bottomName = cleanText(headlineElement.find(".e-divider__bottom").text());
  const headline = topName && bottomName
    ? `${topName} vs ${bottomName}`
    : cleanText(headlineElement.text()).replace(/\s+vs\s+/i, " vs ");
  const title = [prefix, headline].filter(Boolean).join(": ");
  const heroStart = parseTimestamp($(".c-hero__headline-suffix[data-timestamp]").first().attr("data-timestamp"));
  const locationElement = $(".c-hero__text .field--name-venue, .field--name-venue").first();
  const locationParts = locationElement.text().split(/\r?\n/).map(cleanText).filter(Boolean);
  const location = (locationParts.length > 1 ? locationParts.join(", ") : cleanText(locationElement.text()))
    .replace(/,\s*,+/g, ",");
  const statusText = cleanText([
    $(".c-hero__headline-prefix").first().text(),
    $(".c-hero__headline-suffix").first().text(),
    $(".field--name-field-event-status, .event-status").first().text(),
    $("meta[property='og:title']").attr("content") ?? "",
  ].join(" "));
  const sourceStatus = /\bcancel(?:led|ed)\b/i.test(statusText)
    ? "cancelled"
    : /\bpostponed\b/i.test(statusText) ? "postponed" : "scheduled";
  const announcedStarts = publishedCardStarts($);
  const sections: UfcEvent["sections"] = [];
  for (const definition of CARD_DEFINITIONS) {
    const section = $(definition.selector).first();
    if (!section.length) continue;
    const fights = section.find(".c-listing-fight").toArray()
      .map((node) => parseFight($, node))
      .filter((fight): fight is Fight => fight !== null);
    const start = sectionStart(section) ?? announcedStarts.get(definition.key) ?? (definition.key === "main-card" ? heroStart : null);
    if (!fights.length && !start) continue;
    sections.push({
      ...definition,
      start,
      fights,
      provisional: fights.length ? undefined : true,
    });
  }

  for (const definition of CARD_DEFINITIONS) {
    if (sections.some((section) => section.key === definition.key)) continue;
    const start = announcedStarts.get(definition.key);
    if (start) sections.push({ ...definition, start, fights: [], provisional: true });
  }

  if (!sections.length && heroStart) {
    const mainCard = CARD_DEFINITIONS.find(({ key }) => key === "main-card")!;
    sections.push({ ...mainCard, start: heroStart, fights: [], provisional: true });
  }

  if (!sections.some((section) => section.fights.length)) {
    const announcedFights = $(".view-event-fights .c-listing-fight").toArray()
      .map((node) => parseFight($, node))
      .filter((fight): fight is Fight => fight !== null);
    if (announcedFights.length) {
      const mainCard = sections.find(({ key }) => key === "main-card");
      if (mainCard) {
        mainCard.fights = announcedFights;
        mainCard.provisional = true;
      }
    }
  }

  sections.sort((left, right) => CARD_DEFINITIONS.findIndex(({ key }) => key === left.key) - CARD_DEFINITIONS.findIndex(({ key }) => key === right.key));

  return {
    slug: slugFromUrl(url),
    url,
    title,
    location,
    heroStart,
    sections,
    sourceStatus,
  };
}

export async function scrapeEvent(url: string): Promise<UfcEvent> {
  return parseEventPage(await fetchText(url), url);
}

export function parseAthletePage(html: string): AthleteProfile {
  const $ = cheerio.load(html);
  const people: SchemaPerson[] = [];
  $("script[type='application/ld+json']").each((_, script) => {
    if (people.length) return;
    try {
      const data = JSON.parse($(script).text()) as StructuredDataEntry;
      const graph = Array.isArray(data?.["@graph"]) ? data["@graph"] : [data];
      for (const entry of graph) {
        const candidate = entry?.mainEntity?.["@type"] === "Person" ? entry.mainEntity : entry?.["@type"] === "Person" ? entry : null;
        if (candidate) {
          people.push(candidate);
          break;
        }
      }
    } catch {
      // Ignore unrelated malformed structured-data blocks.
    }
  });
  const recordText = cleanText($(".hero-profile__division-body").first().text());
  const person = people[0];
  const record = recordText.match(/\d+\s*-\s*\d+\s*-\s*\d+/)?.[0]
    ?.replace(/\s*-\s*/g, "-") ?? null;
  const fightingStyleField = $(".c-bio__field").filter((_, field) =>
    cleanText($(field).find(".c-bio__label").text()).toLowerCase() === "fighting style"
  ).first();
  return {
    birthDate: person?.birthDate ?? null,
    familyName: cleanText(person?.familyName ?? "") || null,
    record,
    fightingStyle: cleanText(fightingStyleField.find(".c-bio__text").text()) || null,
  };
}

export async function scrapeAthlete(url: string): Promise<AthleteProfile> {
  return parseAthletePage(await fetchText(url));
}
