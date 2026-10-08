// storm-escalation.ts — pure transition logic for the storm-alert agent.
//
// Decides what one NHC system observation means for its storm_alerts row.
// Kept free of I/O so the invest→named-storm upgrade path is unit-testable:
// this exact transition was silently swallowed when TD Two became TS Bertha
// and TD Six-E became Hurricane Fausto (2026-07, task 3c349235) — once a row
// left "draft" status, every later upgrade was a data-only update with no
// re-draft and no notification.

export interface ExistingAlertState {
  status: string | null;
  classification: string | null;
  name: string | null;
  content_hash: string | null;
}

export interface IncomingSystem {
  classification: string;
  name: string;
}

export type ScanAction =
  | { kind: "insert" }                             // never seen → draft + notify
  | { kind: "touch" }                              // unchanged → bump last_updated only
  | { kind: "escalate"; from: string; to: string } // upgraded → re-draft + notify, even if sent/dismissed
  | { kind: "redraft" }                            // material change on a live draft → re-draft
  | { kind: "refresh" };                           // material change on a sent/dismissed row → data-only update

// Severity ladder. "Landfall watch" is not a CurrentStorms.json classification,
// so classification rank — plus a rename at named-storm strength — is the
// escalation signal available from the feed.
const SEVERITY: Array<[RegExp, number]> = [
  [/major hurricane/i, 5],
  [/hurricane/i, 4],
  [/storm/i, 3], // Tropical Storm / Subtropical Storm / Storm Warning (NWS marine)
  [/depression/i, 2],
  [/gale/i, 2], // Gale Warning (NWS marine) — enough to pin ships, below a Storm Warning
  [/potential tropical cyclone/i, 1],
];

export function severityRank(classification: string | null | undefined): number {
  if (!classification) return 0;
  for (const [re, rank] of SEVERITY) if (re.test(classification)) return rank;
  return 0; // Disturbance / unknown
}

export function planScanAction(
  existing: ExistingAlertState | null,
  sys: IncomingSystem,
  contentHash: string,
): ScanAction {
  if (!existing) return { kind: "insert" };
  // A system back in the feed after its alert ended (3+ absent scans) is a
  // regeneration — revive the alert through the escalation path even if the
  // content hash happens to match.
  if (existing.status === "ended") {
    return { kind: "escalate", from: `${existing.classification ?? "unknown"} (ended)`, to: sys.classification };
  }
  if (existing.content_hash === contentHash) return { kind: "touch" };

  const prev = severityRank(existing.classification);
  const next = severityRank(sys.classification);
  // A rename at storm strength or above (e.g. "Two" → "Bertha") is an upgrade
  // even if NHC skipped straight past the rank we last recorded.
  const renamedAtStormStrength =
    next >= 3 && !!existing.name && !!sys.name && existing.name !== sys.name;

  if (next > prev || renamedAtStormStrength) {
    return { kind: "escalate", from: existing.classification ?? "unknown", to: sys.classification };
  }
  return existing.status === "draft" ? { kind: "redraft" } : { kind: "refresh" };
}

// ── Public text refresh (Mark, 2026-10-07: "go with option one") ─────────────
// A sent alert's Storm Watch text used to freeze at whatever was approved:
// Isaias read "35 kt, 300 miles west of Progreso" all evening while NHC had her
// at 55 kt and closing. A same-strength change on an APPROVED/SENT row now
// re-writes the PUBLIC headline and text in place — status unchanged, nobody
// emailed. Subscriber email stays Mark's decision; the page just stays true.

/** What makes a system "materially changed". Position is rounded to whole
 *  degrees (~60 nm), so the text follows a storm that moves, not every wobble. */
export function scanHashKey(
  sys: { nhcId: string; classification: string; intensity?: string | null; formationChance?: string | number | null; lat?: number | null; lon?: number | null },
  grounds: string[],
): string {
  const deg = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "");
  return [sys.nhcId, sys.classification, sys.intensity ?? "", sys.formationChance ?? "",
    grounds.slice().sort().join("|"), deg(sys.lat), deg(sys.lon)].join("::");
}

/** Statuses whose headline/body are on the public Storm Watch. */
export const PUBLIC_STATUSES = ["approved", "sent"] as const;

export interface RefreshedText { headline: string; body_md: string; problems?: string[]; fallback?: boolean }

/**
 * The headline/body to write over a live alert's public text, or null to leave
 * it alone. Only a "refresh" on a public row qualifies, and only a real draft:
 * never the no-AI placeholder, never one that still fails its fact check — an
 * unreviewed page must not get worse than the reviewed text it replaces.
 */
export function publicTextRefresh(
  action: ScanAction,
  existingStatus: string | null | undefined,
  content: RefreshedText | null,
): { headline: string; body_md: string } | null {
  if (action.kind !== "refresh") return null;
  if (!existingStatus || !(PUBLIC_STATUSES as readonly string[]).includes(existingStatus)) return null;
  if (!content || content.fallback || (content.problems?.length ?? 0) > 0) return null;
  const headline = content.headline.trim();
  const body_md = content.body_md.trim();
  if (!headline || !body_md) return null;
  return { headline, body_md };
}
