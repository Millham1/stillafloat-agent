// storm-diversion.ts — PURE course-change classification for storm-pinned ships
// (Mark, 2026-09-05). No I/O; unit-tested in storm-diversion.test.ts.
//
// WHY THIS EXISTS: the first detector called ANY change of AIS-declared
// destination a "diversion". A ship on a two-port loop changes destination every
// leg, so 22 of 22 nudges between 07-22 and 09-04 were scheduled port rotation
// (Navigator of the Seas: LA → Cabo → Puerto Vallarta → LA → Ensenada — its
// published itinerary). Mark cleared every one. The signal was real; the
// detector could not tell a timetable from a course change.
//
// WHAT SEPARATES THEM (AIS-only — no itinerary feed required):
//   • A ship on rotation ARRIVES at the port it declared, then declares the next.
//   • A ship diverting changes its declared destination BEFORE arriving, or
//     arrives somewhere it never declared          → "reroute"      (high)
//   • A known ship heading for a port it has never been seen at, during a
//     named storm                                   → "new_port"     (high)
//   • A known port, but not one that normally follows the port it just left
//     (Mark 09-05: a port-ORDER swap during a named storm counts)
//                                                   → "order_change" (medium)
//     Needs history — ≥ MIN_TRANSITIONS prior departures from that port — so a
//     ship's alternating 3-night / 7-night pattern is learned, not flagged.
//   • Otherwise                                     → "rotation"     (no event)
//
// EVIDENCE RULES keep it honest. A mid-leg re-route is only claimed when the
// tracker watched the whole leg: the destination was declared after the
// observation window opened, at least MIN_LEG_HOURS ago (a flip minutes after
// declaring is a crew correction), and the ship is still reporting (silence can
// hide a port call). Anything unprovable is "unknown": re-baseline, no nudge.
// A restart gap or a typo must never become a headline.

export interface PortCall {
  slug: string;
  arrivedAt: string;
  departedAt: string | null;
}

export type ChangeKind = "rotation" | "order_change" | "new_port" | "reroute" | "unknown";

/** Prior departures from a port before its usual successors count as "known". */
export const MIN_TRANSITIONS = 2;
/** Port calls in the log before a never-visited port can be called "new". */
export const MIN_HISTORY_CALLS = 3;
/** A destination flipped sooner than this after being declared is a correction. */
export const MIN_LEG_HOURS = 2;
/** A ship silent longer than this cannot support a mid-leg claim. */
export const MAX_SILENCE_HOURS = 6;

export const EVENT_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>(["reroute", "new_port", "order_change"]);

export interface ChangeInput {
  /** Previously declared destination slug (the leg the ship was on). */
  baseline: string | null;
  /** When `baseline` was first observed declared. */
  baselineDeclaredAt: string | null;
  /** Destination slug declared now. */
  current: string | null;
  now: string;
  inPortSlug: string | null;
  lastPortSlug: string | null;
  lastPortDepartedAt: string | null;
  lastPosAt: string | null;
  /** The ship's own observed port-call log, any order. */
  portCalls: PortCall[];
  /** Ports known from other sources (homeport, sailing depart port). */
  knownExtra?: string[];
  /** When continuous observation began (tracker), null = unknown. */
  observedSince: string | null;
}

export interface ChangeVerdict {
  kind: ChangeKind;
  newBaseline: string | null;
  newBaselineDeclaredAt: string | null;
  change: { from: string; to: string } | null;
  /** One plain sentence — goes into the log and, for events, the nudge. */
  reason: string;
}

const HOUR_MS = 3_600_000;

function ms(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : NaN;
}

export function sortedCalls(calls: PortCall[]): PortCall[] {
  return [...(calls ?? [])].filter((c) => c && c.slug).sort((a, b) => ms(a.arrivedAt) - ms(b.arrivedAt));
}

/** Ports observed to follow `port` in this ship's own history, and how many
 *  departures from `port` that is based on. */
export function successorsOf(calls: PortCall[], port: string): { ports: string[]; departures: number } {
  const s = sortedCalls(calls);
  const ports = new Set<string>();
  let departures = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const here = s[i];
    const next = s[i + 1];
    if (!here || !next || here.slug !== port) continue;
    departures++;
    if (next.slug !== port) ports.add(next.slug);
  }
  return { ports: [...ports], departures };
}

export function knownPorts(calls: PortCall[], extra: string[] = []): string[] {
  const k = new Set<string>(extra.filter(Boolean));
  for (const c of calls ?? []) if (c?.slug) k.add(c.slug);
  return [...k];
}

/** Did the ship ARRIVE at `slug` after `sinceIso`? (unknown since = any call counts)
 *  Arrival is the test, not departure: a call that ended as the next destination
 *  was declared is the port the ship just LEFT, not the new leg completed. */
function visitedSince(calls: PortCall[], slug: string, sinceIso: string | null): boolean {
  const since = ms(sinceIso);
  return (calls ?? []).some((c) => c.slug === slug && (Number.isNaN(since) || ms(c.arrivedAt) >= since));
}

export function classifyDestinationChange(i: ChangeInput): ChangeVerdict {
  const keep = (kind: ChangeKind, reason: string): ChangeVerdict =>
    ({ kind, newBaseline: i.baseline, newBaselineDeclaredAt: i.baselineDeclaredAt, change: null, reason });
  if (!i.current) return keep("unknown", "no declared destination");
  if (!i.baseline) {
    return { kind: "unknown", newBaseline: i.current, newBaselineDeclaredAt: i.now, change: null, reason: "first sighting sets the baseline" };
  }
  if (i.current === i.baseline) return keep("rotation", "unchanged");

  const baseline = i.baseline;
  const current = i.current;
  const moved = (kind: ChangeKind, reason: string): ChangeVerdict =>
    ({ kind, newBaseline: current, newBaselineDeclaredAt: i.now, change: { from: baseline, to: current }, reason });

  const declared = ms(i.baselineDeclaredAt);
  // Strictly later: a departure stamped at the declaration instant is the port it left.
  const afterDeclared = (t: string | null): boolean => Number.isNaN(declared) || ms(t) > declared;

  // Did the ship complete the leg it declared? Then this is the NEXT leg.
  const completedLeg =
    i.inPortSlug === baseline ||
    (i.lastPortSlug === baseline && afterDeclared(i.lastPortDepartedAt)) ||
    visitedSince(i.portCalls, baseline, i.baselineDeclaredAt);

  if (completedLeg) {
    const history = sortedCalls(i.portCalls);
    const known = knownPorts(history, i.knownExtra ?? []);
    if (history.length >= MIN_HISTORY_CALLS && !known.includes(current)) {
      return moved("new_port", `${current} is not a port this ship has been seen at (${history.length} calls on record)`);
    }
    const from = i.lastPortSlug ?? baseline;
    const succ = successorsOf(history, from);
    if (succ.departures >= MIN_TRANSITIONS && succ.ports.length && !succ.ports.includes(current)) {
      return moved("order_change", `after ${from} this ship has gone to ${succ.ports.join(" / ")} (${succ.departures} departures on record), not ${current}`);
    }
    return moved("rotation", "next port on its usual rotation");
  }

  // Never called at the declared port since declaring it → only a re-route if
  // we can PROVE we watched the whole leg.
  const now = ms(i.now);
  const observed = ms(i.observedSince);
  const lastPos = ms(i.lastPosAt);
  if (Number.isNaN(declared)) return moved("unknown", "no record of when the previous destination was declared");
  if (Number.isNaN(observed) || declared < observed) return moved("unknown", "the leg began before the tracker's observation window — a port call could have been missed");
  if (now - declared < MIN_LEG_HOURS * HOUR_MS) return moved("unknown", `changed within ${MIN_LEG_HOURS}h of declaring — treated as a correction`);
  if (Number.isNaN(lastPos) || now - lastPos > MAX_SILENCE_HOURS * HOUR_MS) return moved("unknown", "ship not reporting — cannot rule out a missed port call");
  const hours = Math.round((now - declared) / HOUR_MS);
  const where = i.inPortSlug && i.inPortSlug === i.lastPortSlug ? " while still in port" : "";
  return moved("reroute", `declared ${baseline} ${hours}h ago, never called there, now declares ${current}${where}`);
}

/** One event per ship movement per day, whichever storms it sits in. */
export function dedupKey(shipName: string, from: string | null, to: string, atIso: string): string {
  return `${shipName.trim().toLowerCase()}|${from ?? "?"}|${to}|${atIso.slice(0, 10)}`;
}

export function kindLabel(kind: ChangeKind): string {
  switch (kind) {
    case "reroute": return "re-routed mid-leg";
    case "new_port": return "is heading to a port it doesn't normally call at";
    case "order_change": return "changed its port order";
    case "rotation": return "moved to its next scheduled port";
    default: return "changed declared destination";
  }
}

export function kindConfidence(kind: ChangeKind): "high" | "medium" | "low" {
  if (kind === "reroute" || kind === "new_port") return "high";
  if (kind === "order_change") return "medium";
  return "low";
}
