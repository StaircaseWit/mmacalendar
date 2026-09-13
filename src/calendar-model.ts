import type { RevisionProvider } from "./revision.js";

export type CalendarEventStatus = "CONFIRMED" | "TENTATIVE" | "CANCELLED";

export interface CalendarFighterModel {
  name: string;
  shortName: string;
  rank?: string;
  flag?: string;
  facts: string[];
}

export interface CalendarBoutModel {
  order?: number;
  red: CalendarFighterModel;
  blue: CalendarFighterModel;
  details?: string;
  oddsHistoryRows?: string[];
  oddsHistoryEmptyText?: string;
}

export interface CalendarBoutSectionModel {
  heading?: string;
  bouts: CalendarBoutModel[];
  emptyText?: string;
}

export interface CalendarCancellationModel {
  redName: string;
  blueName: string;
  details?: string;
  note?: string;
  layout?: "inline" | "stacked";
}

export interface CalendarDescriptionModel {
  overview: string[];
  sections: CalendarBoutSectionModel[];
  emptyText?: string;
  cancelledBouts?: CalendarCancellationModel[];
  cancelledHeading?: string;
  footer?: string[];
  showBoutsHeading?: boolean;
}

export type CalendarTiming =
  | { kind: "timed"; start: Date | string; end: Date | string }
  | { kind: "all-day"; startDate: string; endDate?: string };

export interface CalendarEventModel {
  uid: string;
  revisionKey: string;
  timing: CalendarTiming;
  summary: string;
  description: CalendarDescriptionModel | string;
  htmlDescription?: string;
  location: string;
  url: string;
  categories: string[];
  status: CalendarEventStatus;
  relatedTo?: string;
  revisionContent?: unknown;
}

export interface CalendarFeedModel {
  productId: string;
  name: string;
  description: string;
  color: string;
  events: CalendarEventModel[];
  generatedAt: Date;
  revisionProvider?: RevisionProvider;
  refreshInterval?: string;
}
