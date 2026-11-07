// The FlexPay appointment a guest picks on our own page (Mark 2026-11-05): "it should bring up a scheduler for a video conference. M-S 10-8 and doesn't
// conflict with any meetings on my schedule already." No outside scheduling service ("I'm not paying for another service"): the page is ours, the
// meetings come from the ops-manager (which holds the calendar), and the rule of the hours lives here, pure, so it is tested without a calendar.
//
// The rule: Monday to Saturday, 10:00 AM to 8:00 PM on Mark's clock (Eastern), in half-hour appointments that start on the hour or the half hour and
// end by 8:00 PM. Not sooner than two hours from now (he needs to see it coming), not further out than two weeks. A time is offered only when no
// meeting touches any part of it.

export const CALL = {
  tz: "America/New_York",
  /** 0 = Sunday. Monday to Saturday. */
  days: [1, 2, 3, 4, 5, 6] as readonly number[],
  openHour: 10,
  closeHour: 20,
  minutes: 30,
  /** Mark 2026-11-07: "the call needs to happen within 24 hours of the request." Half an hour's notice; every open time
   *  within the next 24 hours. When none of those is open (a request late on Saturday), the first open day after it. */
  leadMinutes: 30,
  withinHours: 24,
  /** How far the fallback may look for that first open day. */
  horizonDays: 7,
} as const;

export interface Busy { start: string; end: string }
export interface CallDay { date: string; slots: string[] }

const MIN = 60_000;

/** The wall-clock parts of an instant on Mark's clock. */
function parts(t: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(t)) p[x.type] = x.value;
  return { y: Number(p["year"]), mo: Number(p["month"]), d: Number(p["day"]), h: Number(p["hour"]), mi: Number(p["minute"]), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p["weekday"] ?? "") };
}

/** The instant at which Mark's clock reads y-mo-d h:mi (two passes, so the hour is right on both sides of a clock change). */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, tz: string = CALL.tz): Date {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(t), tz);
    t += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Every appointment start the rule allows from `now`, by day on Mark's clock, before any meeting is taken out. */
export function ruleSlots(now: Date): CallDay[] {
  const earliest = now.getTime() + CALL.leadMinutes * MIN;
  const latest = now.getTime() + CALL.withinHours * 60 * MIN;
  const today = parts(now, CALL.tz);
  const out: CallDay[] = [];
  for (let i = 0; i <= CALL.horizonDays; i++) {
    // noon of the i-th day from today on Mark's clock: a safe anchor to read that day's date and weekday from
    const anchor = parts(new Date(Date.UTC(today.y, today.mo - 1, today.d + i, 12)), "UTC");
    const dow = new Date(Date.UTC(anchor.y, anchor.mo - 1, anchor.d)).getUTCDay();
    if (!CALL.days.includes(dow)) continue;
    const slots: string[] = [];
    for (let m = CALL.openHour * 60; m + CALL.minutes <= CALL.closeHour * 60; m += CALL.minutes) {
      const t = zonedTime(anchor.y, anchor.mo, anchor.d, Math.floor(m / 60), m % 60);
      if (t.getTime() >= earliest) slots.push(t.toISOString());
    }
    if (!slots.length) continue;
    const date = `${anchor.y}-${pad(anchor.mo)}-${pad(anchor.d)}`;
    const inside = slots.filter((s) => new Date(s).getTime() <= latest);
    if (inside.length) { out.push({ date, slots: inside }); continue; }
    // the first open day past the 24 hours, only when nothing inside them was open
    if (!out.length) out.push({ date, slots });
    break;
  }
  return out;
}

/** The window the rule can ever offer from `now`: what to ask the calendar about. */
export function ruleWindow(now: Date): { start: string; end: string } {
  const days = ruleSlots(now);
  const lastSlot = days.length ? days[days.length - 1]!.slots.slice(-1)[0]! : now.toISOString();
  return { start: now.toISOString(), end: new Date(new Date(lastSlot).getTime() + CALL.minutes * MIN).toISOString() };
}

const overlaps = (start: number, busy: Busy[]): boolean => {
  const end = start + CALL.minutes * MIN;
  return busy.some((b) => {
    const bs = Date.parse(b.start), be = Date.parse(b.end);
    return Number.isFinite(bs) && Number.isFinite(be) && bs < end && be > start;
  });
};

/** The times a guest may pick: the rule's times with every one a meeting touches taken out. Days left empty are not listed. */
export function freeSlots(now: Date, busy: Busy[]): CallDay[] {
  return ruleSlots(now)
    .map((d) => ({ date: d.date, slots: d.slots.filter((s) => !overlaps(Date.parse(s), busy)) }))
    .filter((d) => d.slots.length > 0);
}

/** True when `start` is one of the rule's own times from `now` (the guest's browser sends back a time the page showed; anything else is refused). */
export function isRuleSlot(start: unknown, now: Date): start is string {
  if (typeof start !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(start)) return false;
  const t = Date.parse(start);
  if (!Number.isFinite(t)) return false;
  const iso = new Date(t).toISOString();
  return ruleSlots(now).some((d) => d.slots.includes(iso));
}

/** "Tuesday, November 10 at 2:00 PM Eastern" / "martes, 10 de noviembre a las 2:00 p. m., hora del Este": the appointment in words, on Mark's clock. */
export function callWhenText(startIso: string, lang: "en" | "es"): string {
  const t = new Date(startIso);
  if (!Number.isFinite(t.getTime())) return "";
  if (lang === "es") {
    const day = t.toLocaleDateString("es-US", { timeZone: CALL.tz, weekday: "long", day: "numeric", month: "long" });
    const clock = t.toLocaleTimeString("es-US", { timeZone: CALL.tz, hour: "numeric", minute: "2-digit" });
    return `${day} a las ${clock}, hora del Este`;
  }
  const day = t.toLocaleDateString("en-US", { timeZone: CALL.tz, weekday: "long", month: "long", day: "numeric" });
  const clock = t.toLocaleTimeString("en-US", { timeZone: CALL.tz, hour: "numeric", minute: "2-digit" });
  return `${day} at ${clock} Eastern`;
}
