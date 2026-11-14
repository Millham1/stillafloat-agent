// protection-store.ts — the coverages of travel protection plans, kept in the database for reuse (Mark 2026-11-13: "you should be able to pull
// coverage off the sites as needed, then store them for future use"). Tables: protection_plans + protection_plan_benefits (migration 0073).
// One plan is kept once for the residents of one state; reading it again replaces its benefit lines. Prices are never kept here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanBenefit } from "./allianz-quote";

export interface StoredCoverage {
  provider: "allianz" | "cruise-line";
  cruise_line: string | null;
  plan_name: string;
  product_code: string | null;
  state: string | null;
  about: string | null;
  source_en: string;
  source_es: string;
  source_url: string | null;
  benefits: PlanBenefit[];
}
type Row = Record<string, any>;
const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** Keep a plan's coverages: the plan's row is made or refreshed, and its benefit lines are replaced by the ones just read. */
export async function saveCoverage(db: SupabaseClient, c: StoredCoverage, now: Date = new Date()): Promise<void> {
  if (!c.plan_name.trim() || !c.benefits.length) return;
  const { data: rows, error } = await db.from("protection_plans").select("id, provider, cruise_line, plan_name, state").eq("provider", c.provider);
  if (error) throw new Error(error.message);
  const have = ((rows ?? []) as Row[]).find((r) => same(r["plan_name"], c.plan_name) && same(r["cruise_line"], c.cruise_line) && same(r["state"], c.state));
  const fields = { provider: c.provider, cruise_line: c.cruise_line, plan_name: c.plan_name.trim(), product_code: c.product_code, state: c.state, about: c.about, source_en: c.source_en, source_es: c.source_es, source_url: c.source_url, read_at: now.toISOString(), updated_at: now.toISOString() };
  let id: string;
  if (have) {
    id = String(have["id"]);
    const { error: ue } = await db.from("protection_plans").update(fields).eq("id", id);
    if (ue) throw new Error(ue.message);
    const { error: de } = await db.from("protection_plan_benefits").delete().eq("plan_id", id);
    if (de) throw new Error(de.message);
  } else {
    const { data: made, error: ie } = await db.from("protection_plans").insert(fields).select("id").single();
    if (ie) throw new Error(ie.message);
    id = String((made as Row)["id"]);
  }
  const lines: Row[] = [];
  let position = 0;
  for (const b of c.benefits) {
    const at = position++;
    lines.push({ plan_id: id, position: at, parent_position: null, name: b.name, value: b.coverage });
    for (const l of b.limits) lines.push({ plan_id: id, position: position++, parent_position: at, name: l.name, value: l.value });
  }
  const { error: le } = await db.from("protection_plan_benefits").insert(lines);
  if (le) throw new Error(le.message);
}

/** Every plan kept for the residents of a state, with its benefit table put back together in order. */
export async function loadCoverages(db: SupabaseClient, state: string | null): Promise<StoredCoverage[]> {
  if (!state) return [];
  const { data: plans, error } = await db.from("protection_plans").select("id, provider, cruise_line, plan_name, product_code, state, about, source_en, source_es, source_url").eq("state", state);
  if (error) throw new Error(error.message);
  const list = (plans ?? []) as Row[];
  if (!list.length) return [];
  const { data: lines, error: le } = await db.from("protection_plan_benefits").select("plan_id, position, parent_position, name, value").in("plan_id", list.map((p) => String(p["id"])));
  if (le) throw new Error(le.message);
  return list.map((p) => {
    const mine = ((lines ?? []) as Row[]).filter((l) => l["plan_id"] === p["id"]).sort((a, b) => Number(a["position"]) - Number(b["position"]));
    const benefits: PlanBenefit[] = mine.filter((l) => l["parent_position"] === null || l["parent_position"] === undefined)
      .map((l) => ({ name: String(l["name"]), coverage: String(l["value"] ?? ""), limits: mine.filter((x) => x["parent_position"] === l["position"]).map((x) => ({ name: String(x["name"]), value: String(x["value"] ?? "") })) }));
    return { provider: p["provider"], cruise_line: p["cruise_line"] ?? null, plan_name: String(p["plan_name"]), product_code: p["product_code"] ?? null, state: p["state"] ?? null, about: p["about"] ?? null, source_en: String(p["source_en"]), source_es: String(p["source_es"]), source_url: p["source_url"] ?? null, benefits };
  }).filter((c) => c.benefits.length > 0);
}

/** The kept coverages of a cruise line's own plan, or of an Allianz plan by its name ("Classic Plan" or "Classic Plan (Allianz)"). */
export const lineCoverage = (all: readonly StoredCoverage[], cruiseLine: unknown): StoredCoverage | null =>
  (typeof cruiseLine === "string" && cruiseLine.trim() ? all.find((c) => c.provider === "cruise-line" && same(c.cruise_line, cruiseLine)) ?? null : null);
export const allianzCoverage = (all: readonly StoredCoverage[], planName: string): StoredCoverage | null =>
  all.find((c) => c.provider === "allianz" && (same(c.plan_name, planName) || same(`${c.plan_name} (Allianz)`, planName))) ?? null;
