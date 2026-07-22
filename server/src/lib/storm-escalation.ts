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
  [/storm/i, 3], // Tropical Storm / Subtropical Storm
  [/depression/i, 2],
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
