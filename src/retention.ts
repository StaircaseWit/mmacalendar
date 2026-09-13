export const EVENT_HISTORY_YEARS = 1;

export function eventHistoryCutoff(now = new Date()): Date {
  const targetYear = now.getUTCFullYear() - EVENT_HISTORY_YEARS;
  const month = now.getUTCMonth();
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    month,
    Math.min(now.getUTCDate(), lastDayOfTargetMonth),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  ));
}

export function isWithinEventHistory(eventDate: Date | null | undefined, now = new Date()): boolean {
  if (!eventDate || !Number.isFinite(eventDate.valueOf())) return true;
  return eventDate >= eventHistoryCutoff(now);
}

export function retainEventHistory<T>(
  events: T[],
  eventDate: (event: T) => Date | null | undefined,
  now = new Date(),
): T[] {
  return events.filter((event) => isWithinEventHistory(eventDate(event), now));
}

export function pruneRecordToKeys<T>(record: Record<string, T>, retainedKeys: ReadonlySet<string>): void {
  for (const key of Object.keys(record)) {
    if (!retainedKeys.has(key)) delete record[key];
  }
}
