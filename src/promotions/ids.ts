export const PROMOTION_IDS = ["ufc", "one", "rizin", "pfl"] as const;

export type PromotionId = typeof PROMOTION_IDS[number];

export const ODDS_SOURCE_ID = "bestfightodds" as const;

export type SourceName = PromotionId | typeof ODDS_SOURCE_ID;
