const DIVISION_BY_WEIGHT = new Map([
  ["49", "Women's Super Atomweight"],
  ["57", "Flyweight"],
  ["61", "Bantamweight"],
  ["66", "Featherweight"],
  ["71", "Lightweight"],
  ["77", "Welterweight"],
  ["84", "Middleweight"],
  ["93", "Light Heavyweight"],
  ["120", "Heavyweight"],
]);

export function rizinDivisionForKilograms(value: string): string | undefined {
  return DIVISION_BY_WEIGHT.get(value.replace(/\.0$/, ""));
}
