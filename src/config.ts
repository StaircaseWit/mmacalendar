export const UFC_ORIGIN = "https://www.ufc.com";
export const DAY_MS = 24 * 60 * 60 * 1000;

import type { CardDefinition } from "./types.js";

export const CARD_DEFINITIONS: CardDefinition[] = [
  {
    key: "early-prelims",
    label: "Early Prelims",
    selector: 'div.fight-card-prelims-early[id^="early-prelims"]',
    fallbackDurationHours: 2,
  },
  {
    key: "prelims",
    label: "Prelims",
    selector: 'div.fight-card-prelims[id^="prelims-card"]',
    fallbackDurationHours: 3,
  },
  {
    key: "main-card",
    label: "Main Card",
    selector: 'div.main-card[id^="main-card"]',
    fallbackDurationHours: 3,
  },
];

export const WEIGHT_CLASSES: ReadonlyArray<readonly [string, number, number]> = [
  ["Women's Strawweight", 115, 52],
  ["Women's Flyweight", 125, 57],
  ["Women's Bantamweight", 135, 61],
  ["Strawweight", 115, 52],
  ["Flyweight", 125, 57],
  ["Bantamweight", 135, 61],
  ["Featherweight", 145, 66],
  ["Lightweight", 155, 70],
  ["Welterweight", 170, 77],
  ["Middleweight", 185, 84],
  ["Light Heavyweight", 205, 93],
  ["Heavyweight", 265, 120],
];
