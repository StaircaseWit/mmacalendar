export interface OddsSnapshot {
  checkedAt: string;
  odds: Record<string, string | null>;
  names?: Record<string, string>;
}

export interface Fighter {
  name: string;
  rank: string | null;
  profileUrl: string | null;
  country: string | null;
  countryCode: string | null;
  sourceOdds: string | null;
  record?: string | null;
  birthDate?: string | null;
  familyName?: string | null;
  odds?: string | null;
  oddsHistory?: OddsSnapshot[];
}

export interface Fight {
  id: string | null;
  weightClass: string;
  red: Fighter;
  blue: Fighter;
  oddsHistory?: OddsSnapshot[];
}

export interface CardDefinition {
  key: string;
  label: string;
  selector: string;
  fallbackDurationHours: number;
}

export interface CardSection extends CardDefinition {
  start: Date | null;
  fights: Fight[];
  provisional?: boolean;
}

export interface UfcEvent {
  slug: string;
  url: string;
  title: string;
  location: string;
  heroStart: Date | null;
  sections: CardSection[];
  sourceStatus?: "scheduled" | "postponed" | "cancelled";
  scheduleStatus?: EventScheduleStatus;
}

export type EventScheduleState = "scheduled" | "rescheduled" | "postponed" | "cancelled" | "unlisted";

export interface EventScheduleStatus {
  state: EventScheduleState;
  checkedAt: string;
  previousStart?: string | null;
  missingChecks?: number;
}

export interface StoredCardSection extends Omit<CardSection, "start"> {
  start: string | null;
}

export interface StoredUfcEvent extends Omit<UfcEvent, "heroStart" | "sections" | "scheduleStatus"> {
  heroStart: string | null;
  sections: StoredCardSection[];
}

export interface TrackedEvent {
  event: StoredUfcEvent;
  status: EventScheduleState;
  firstSeenAt: string;
  lastSeenAt: string;
  previousStart?: string | null;
  missingChecks: number;
}

export interface EventStore {
  events: Record<string, TrackedEvent>;
}

export interface AthleteProfile {
  birthDate: string | null;
  familyName: string | null;
  record: string | null;
  checkedAt?: string;
}

export interface FighterStore {
  fighters: Record<string, AthleteProfile>;
}

export interface OddsStore {
  lastCheckedAt: string | null;
  fights: Record<string, OddsSnapshot[]>;
}
