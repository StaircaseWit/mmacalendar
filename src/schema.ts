import type { CalendarStatus } from "./health.js";
import type { OneEvent, OneFighterStore } from "./one.js";
import type { PflEvent, PflFighterStore } from "./pfl.js";
import type { PromotionOddsStore } from "./promotion-odds.js";
import type { RevisionStore } from "./revision.js";
import type { RizinEvent, RizinFighterStore } from "./rizin.js";
import type { CancelledBout, EventStore, FighterStore, OddsStore } from "./types.js";

type JsonObject = Record<string, unknown>;

function fail(source: string, path: string, expectation: string): never {
  throw new Error(`${source}: ${path} must be ${expectation}`);
}

function object(value: unknown, source: string, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, path, "an object");
  return value as JsonObject;
}

function array(value: unknown, source: string, path: string): unknown[] {
  if (!Array.isArray(value)) fail(source, path, "an array");
  return value;
}

function string(value: unknown, source: string, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) fail(source, path, "a non-empty string");
  return value;
}

function nullableString(value: unknown, source: string, path: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") fail(source, path, "a string or null");
}

function optionalNumber(value: unknown, source: string, path: string): void {
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    fail(source, path, "a finite number or null");
  }
}

function record(value: unknown, source: string, path: string): JsonObject {
  return object(value, source, path);
}

function validateFighter(value: unknown, source: string, path: string): void {
  const fighter = object(value, source, path);
  string(fighter.name, source, `${path}.name`);
  for (const key of ["profileUrl", "countryCode", "country", "birthDate", "record", "style", "odds"]) {
    nullableString(fighter[key], source, `${path}.${key}`);
  }
}

function validatePromotionBout(value: unknown, source: string, path: string): void {
  const bout = object(value, source, path);
  if ("red" in bout) {
    validateFighter(bout.red, source, `${path}.red`);
    validateFighter(bout.blue, source, `${path}.blue`);
  } else {
    string(bout.redName, source, `${path}.redName`);
    string(bout.blueName, source, `${path}.blueName`);
  }
  nullableString(bout.details, source, `${path}.details`);
  optionalNumber(bout.order, source, `${path}.order`);
  for (const key of ["redAge", "blueAge"]) optionalNumber(bout[key], source, `${path}.${key}`);
  for (const key of ["redProfileUrl", "blueProfileUrl", "redCountry", "blueCountry", "redRecord", "blueRecord", "redStyle", "blueStyle", "redOdds", "blueOdds"]) {
    nullableString(bout[key], source, `${path}.${key}`);
  }
  if (bout.oddsHistory !== undefined) validateOddsSnapshots(bout.oddsHistory, source, `${path}.oddsHistory`);
}

function validateOddsSnapshots(value: unknown, source: string, path: string): void {
  array(value, source, path).forEach((snapshot, index) => {
    const candidate = object(snapshot, source, `${path}[${index}]`);
    string(candidate.checkedAt, source, `${path}[${index}].checkedAt`);
    record(candidate.odds, source, `${path}[${index}].odds`);
    if (candidate.names !== undefined) record(candidate.names, source, `${path}[${index}].names`);
    for (const key of ["eventName", "sourceUrl", "promotion", "eventId"]) {
      nullableString(candidate[key], source, `${path}[${index}].${key}`);
    }
  });
}

export function validateOneEvents(value: unknown, source: string): OneEvent[] {
  const events = array(value, source, "root");
  events.forEach((candidate, index) => {
    const event = object(candidate, source, `root[${index}]`);
    for (const key of ["uid", "start", "end", "summary", "status"]) {
      string(event[key], source, `root[${index}].${key}`);
    }
    for (const key of ["location", "description", "url", "detailsUrl"]) {
      nullableString(event[key], source, `root[${index}].${key}`);
    }
    const bouts = array(event.bouts, source, `root[${index}].bouts`);
    bouts.forEach((bout, boutIndex) => validatePromotionBout(bout, source, `root[${index}].bouts[${boutIndex}]`));
  });
  return value as OneEvent[];
}

function validateDatedPromotionEvents<T>(value: unknown, source: string, name: string): T[] {
  const events = array(value, source, "root");
  events.forEach((candidate, index) => {
    const event = object(candidate, source, `root[${index}]`);
    for (const key of ["uid", "date", "summary", "status"]) {
      string(event[key], source, `root[${index}].${key}`);
    }
    for (const key of ["start", "end", "location", "url", "cardUrl"]) {
      nullableString(event[key], source, `root[${index}].${key}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(event.date))) fail(source, `root[${index}].date`, "an ISO date");
    for (const key of ["bouts", "cancelledBouts"]) {
      const bouts = array(event[key], source, `root[${index}].${key}`);
      bouts.forEach((bout, boutIndex) => validatePromotionBout(bout, source, `root[${index}].${key}[${boutIndex}]`));
    }
  });
  return value as T[];
}

export function validateRizinEvents(value: unknown, source: string): RizinEvent[] {
  return validateDatedPromotionEvents<RizinEvent>(value, source, "RIZIN");
}

export function validatePflEvents(value: unknown, source: string): PflEvent[] {
  return validateDatedPromotionEvents<PflEvent>(value, source, "PFL");
}

function validateProfilesStore<T>(value: unknown, source: string): T {
  const root = object(value, source, "root");
  const profiles = record(root.profiles, source, "root.profiles");
  for (const [key, value] of Object.entries(profiles)) {
    const profile = object(value, source, `root.profiles.${key}`);
    string(profile.checkedAt, source, `root.profiles.${key}.checkedAt`);
    for (const field of ["name", "origin", "country", "countryCode", "birthDate", "record", "style"]) {
      nullableString(profile[field], source, `root.profiles.${key}.${field}`);
    }
    optionalNumber(profile.age, source, `root.profiles.${key}.age`);
  }
  return value as T;
}

export const validateOneFighterStore = (value: unknown, source: string): OneFighterStore =>
  validateProfilesStore<OneFighterStore>(value, source);
export const validateRizinFighterStore = (value: unknown, source: string): RizinFighterStore =>
  validateProfilesStore<RizinFighterStore>(value, source);
export const validatePflFighterStore = (value: unknown, source: string): PflFighterStore =>
  validateProfilesStore<PflFighterStore>(value, source);

export function validateEventStore(value: unknown, source: string): EventStore {
  const root = object(value, source, "root");
  const events = record(root.events, source, "root.events");
  for (const [key, value] of Object.entries(events)) {
    const tracked = object(value, source, `root.events.${key}`);
    for (const field of ["status", "firstSeenAt", "lastSeenAt"]) string(tracked[field], source, `root.events.${key}.${field}`);
    const event = object(tracked.event, source, `root.events.${key}.event`);
    for (const field of ["slug", "url", "title"]) string(event[field], source, `root.events.${key}.event.${field}`);
    nullableString(event.location, source, `root.events.${key}.event.location`);
    nullableString(event.heroStart, source, `root.events.${key}.event.heroStart`);
    array(event.sections, source, `root.events.${key}.event.sections`).forEach((section, sectionIndex) => {
      const card = object(section, source, `root.events.${key}.event.sections[${sectionIndex}]`);
      for (const field of ["key", "label", "selector"]) string(card[field], source, `root.events.${key}.event.sections[${sectionIndex}].${field}`);
      nullableString(card.start, source, `root.events.${key}.event.sections[${sectionIndex}].start`);
      array(card.fights, source, `root.events.${key}.event.sections[${sectionIndex}].fights`).forEach((fight, fightIndex) => {
        const bout = object(fight, source, `root.events.${key}.event.sections[${sectionIndex}].fights[${fightIndex}]`);
        string(bout.weightClass, source, `root.events.${key}.event.sections[${sectionIndex}].fights[${fightIndex}].weightClass`, true);
        validateFighter(bout.red, source, `root.events.${key}.event.sections[${sectionIndex}].fights[${fightIndex}].red`);
        validateFighter(bout.blue, source, `root.events.${key}.event.sections[${sectionIndex}].fights[${fightIndex}].blue`);
      });
    });
  }
  return value as EventStore;
}

export function validateFighterStore(value: unknown, source: string): FighterStore {
  const root = object(value, source, "root");
  const fighters = record(root.fighters, source, "root.fighters");
  for (const [key, value] of Object.entries(fighters)) {
    const profile = object(value, source, `root.fighters.${key}`);
    for (const field of ["birthDate", "familyName", "record", "fightingStyle", "checkedAt"]) {
      nullableString(profile[field], source, `root.fighters.${key}.${field}`);
    }
  }
  return value as FighterStore;
}

export function validateOddsStore(value: unknown, source: string): OddsStore {
  const root = object(value, source, "root");
  const fights = record(root.fights, source, "root.fights");
  for (const [key, snapshots] of Object.entries(fights)) validateOddsSnapshots(snapshots, source, `root.fights.${key}`);
  nullableString(root.lastCheckedAt, source, "root.lastCheckedAt");
  return value as OddsStore;
}

export function validateCancellationOverrides(value: unknown, source: string): Record<string, CancelledBout[]> {
  const root = record(value, source, "root");
  for (const [slug, bouts] of Object.entries(root)) {
    array(bouts, source, `root.${slug}`).forEach((bout, index) => {
      const candidate = object(bout, source, `root.${slug}[${index}]`);
      string(candidate.redName, source, `root.${slug}[${index}].redName`);
      string(candidate.blueName, source, `root.${slug}[${index}].blueName`);
    });
  }
  return value as Record<string, CancelledBout[]>;
}

export function validatePromotionOddsStore(value: unknown, source: string): PromotionOddsStore {
  const root = object(value, source, "root");
  const fights = record(root.fights, source, "root.fights");
  for (const [key, snapshots] of Object.entries(fights)) validateOddsSnapshots(snapshots, source, `root.fights.${key}`);
  nullableString(root.lastCheckedAt, source, "root.lastCheckedAt");
  return value as PromotionOddsStore;
}

export function validateRevisionStore(value: unknown, source: string): RevisionStore {
  const root = object(value, source, "root");
  if (root.schemaVersion !== 1) fail(source, "root.schemaVersion", "the supported version 1");
  const events = record(root.events, source, "root.events");
  for (const [key, value] of Object.entries(events)) {
    const revision = object(value, source, `root.events.${key}`);
    string(revision.hash, source, `root.events.${key}.hash`);
    optionalNumber(revision.sequence, source, `root.events.${key}.sequence`);
    string(revision.createdAt, source, `root.events.${key}.createdAt`);
    string(revision.lastModified, source, `root.events.${key}.lastModified`);
  }
  return value as RevisionStore;
}

export function validateCalendarStatus(value: unknown, source: string): CalendarStatus {
  const root = object(value, source, "root");
  if (root.schemaVersion !== 1) fail(source, "root.schemaVersion", "the supported version 1");
  string(root.generatedAt, source, "root.generatedAt");
  record(root.sources, source, "root.sources");
  record(root.feeds, source, "root.feeds");
  return value as unknown as CalendarStatus;
}
