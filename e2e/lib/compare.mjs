// e2e/lib/compare.mjs — before/after. Mark, 2026-07-12: "when I ask for an end to end test,
// I also want a comparison to the old." A release report names what DISAPPEARED or CHANGED,
// not only what works.

/** Flatten a run result into { "check-id » key": {value, kind} }. */
export function snapshotOf(run) {
  const snap = {};
  for (const c of run.checks) {
    snap[`${c.id} » status`] = { value: c.status === "pass" ? "pass" : "FAILING", kind: "exact" };
    for (const [k, o] of Object.entries(c.observations || {})) snap[`${c.id} » ${k}`] = o;
  }
  return snap;
}

/** Compare two snapshots. Returns { disappeared, changed, dropped, appeared }. */
export function compareSnapshots(before, after) {
  const out = { disappeared: [], changed: [], dropped: [], appeared: [] };
  for (const [k, b] of Object.entries(before)) {
    if (b.kind === "info") continue;
    const a = after[k];
    if (a === undefined) { out.disappeared.push({ key: k, was: b.value }); continue; }
    if (b.kind === "exact" && JSON.stringify(a.value) !== JSON.stringify(b.value)) out.changed.push({ key: k, was: b.value, now: a.value });
    if (b.kind === "min" && typeof a.value === "number" && typeof b.value === "number" && a.value < b.value) out.dropped.push({ key: k, was: b.value, now: a.value });
  }
  for (const k of Object.keys(after)) if (!(k in before) && after[k].kind !== "info") out.appeared.push({ key: k, now: after[k].value });
  return out;
}

export function describeComparison(cmp) {
  const lines = [];
  const show = (v) => (typeof v === "string" && v.length > 90 ? `${v.slice(0, 90)}…` : JSON.stringify(v));
  for (const d of cmp.disappeared) lines.push(`GONE     ${d.key} (was ${show(d.was)})`);
  for (const d of cmp.dropped) lines.push(`DROPPED  ${d.key}: ${d.was} → ${d.now}`);
  for (const d of cmp.changed) lines.push(`CHANGED  ${d.key}: ${show(d.was)} → ${show(d.now)}`);
  for (const d of cmp.appeared) lines.push(`NEW      ${d.key} = ${show(d.now)}`);
  return lines;
}
