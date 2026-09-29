// brief-schedule.ts — when the daily brief is assembled and pushed.
//
// Mark, 2026-09-28: "the daily brief needs to update 3 times during the work
// day". It used to fire once, at DAILY_BRIEF_HOUR (7am). Now it fires at each
// hour in DAILY_BRIEF_HOURS (local time, default 7am, noon, 4pm). The first
// slot is the morning brief; later slots push as an update. Pure, so the
// scheduler in index.ts stays a thin timer around it.

export const DEFAULT_BRIEF_HOURS = [7, 12, 16];

/** "7,12,16" → [7, 12, 16]. Bad or empty input falls back to the default. */
export function parseBriefHours(raw: string | null | undefined): number[] {
  if (!raw || !raw.trim()) return [...DEFAULT_BRIEF_HOURS];
  const hours = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
  const unique = [...new Set(hours)].sort((a, b) => a - b);
  return unique.length ? unique : [...DEFAULT_BRIEF_HOURS];
}

/**
 * The slot hour that is due now, or null. A slot is due during its local hour
 * and fires once per date: `sent` holds "YYYY-MM-DD@H" keys already delivered.
 */
export function dueBriefHour(hour: number, date: string, hours: number[], sent: Set<string>): number | null {
  if (!hours.includes(hour)) return null;
  return sent.has(`${date}@${hour}`) ? null : hour;
}

export function slotKey(date: string, hour: number): string {
  return `${date}@${hour}`;
}
