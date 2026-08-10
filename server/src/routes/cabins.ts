// cabins.ts — the Cabin Concierge API (Room Engine).
//
// Cost architecture (Mark, 2026-07-26): the advisor's reasoning is written ONCE,
// up front, per ship per traveller archetype, by a cheap model, and stored in
// public.cabin_advice. NOTHING here calls an LLM. A traffic spike costs the same
// as a quiet day — that was the whole point.
//
// Runtime is deterministic: map the visitor's answers to the nearest archetype,
// serve that archetype's pre-written reasoning, and join it to the live cabin
// facts in public.cabins so we show deck/category/view alongside the why.
//
// The funnel ends at /api/contact — this is lead-gen for Mark's agency, not a
// booking engine. Voice is advisory, never sales: the trust IS the sell.
//
// cabins/cabin_ships/cabin_advice are all service-role-only by RLS, so the page
// can never read them directly; everything goes through here.

import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Answers → archetype ──────────────────────────────────────────────────────
// The archetypes (cabin-advisor/data/archetypes.json) are the 12 traveller types
// the advice was written for. We score each on how well its tags match the
// visitor's answers and take the best. Deliberately simple and inspectable —
// a wrong match shows the wrong *reasoning*, so it must be debuggable.
type Answers = {
  party?: string;      // solo | couple | family | group | solo-group
  budget?: string;     // lean | middle | treat | sky
  priority?: string;   // ocean | quiet | action | space | value
  motion?: boolean;    // prone to seasickness
};

const ARCHETYPE_TAGS: Record<string, string[]> = {
  "first-couple-ocean-steady":   ["couple", "middle", "ocean", "steady"],
  "couple-ocean-balcony-treat":  ["couple", "treat", "ocean"],
  "anniversary-suite-splurge":   ["couple", "sky", "space"],
  "family-action-boardwalk":     ["family", "middle", "action"],
};

function pickArchetype(rows: { archetype_id: string }[], a: Answers): string | null {
  if (!rows.length) return null;
  const want = new Set<string>([
    a.party || "", a.budget || "", a.priority || "", a.motion ? "steady" : "",
  ].filter(Boolean));
  let best = rows[0]!.archetype_id, bestScore = -1;
  for (const r of rows) {
    const tags = ARCHETYPE_TAGS[r.archetype_id] ?? r.archetype_id.split("-");
    let score = 0;
    for (const t of tags) if (want.has(t)) score += 1;
    // party is the strongest signal — a family must never get a couple's advice
    if (a.party && tags.includes(a.party)) score += 2;
    if (score > bestScore) { bestScore = score; best = r.archetype_id; }
  }
  return best;
}

// ── Ships the concierge can actually advise on ───────────────────────────────
// Only ships that HAVE generated advice — offering a ship with no reasoning
// behind it would be a dead end.
router.get("/cabins/ships", async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: advice, error: aErr } = await supabase.from("cabin_advice").select("ship_slug");
    if (aErr) throw new Error(aErr.message);
    const slugs = [...new Set((advice ?? []).map((r: { ship_slug: string }) => r.ship_slug))];
    if (!slugs.length) return res.json({ ships: [] });

    const { data: ships, error: sErr } = await supabase
      .from("cabin_ships").select("slug,ship,line,class,total_cabins").in("slug", slugs);
    if (sErr) throw new Error(sErr.message);
    res.json({ ships: ships ?? [] });
  } catch (err) {
    logger.error({ err }, "cabins/ships failed");
    res.status(500).json({ error: "Could not load ships" });
  }
});

// ── The recommendation ───────────────────────────────────────────────────────
router.post("/cabins/recommend", async (req: Request, res: Response) => {
  try {
    const { ship, ...answers } = (req.body ?? {}) as Answers & { ship?: string };
    if (!ship) return res.status(400).json({ error: "ship is required" });

    const supabase = getSupabase();
    const { data: rows, error } = await supabase
      .from("cabin_advice")
      .select("archetype_id,label,recommendations,steer_clear")
      .eq("ship_slug", ship);
    if (error) throw new Error(error.message);
    if (!rows?.length) return res.status(404).json({ error: "No advice for that ship yet" });

    const chosen = pickArchetype(rows, answers);
    const advice = rows.find((r) => r.archetype_id === chosen) ?? rows[0]!;

    // Join the reasoning to the real cabin facts so the page can show deck,
    // category and view next to the why.
    const recs = (advice.recommendations ?? []) as { cabin: number | string; rank?: number; reason?: string }[];
    const nums = recs.map((r) => String(r.cabin));
    const { data: facts } = await supabase
      .from("cabins")
      .select("cabin_num,deck,category,section,side,view,sleeps,obstruction,tour")
      .eq("ship_slug", ship)
      .in("cabin_num", nums);

    const factByNum = new Map((facts ?? []).map((f: { cabin_num: string | number }) => [String(f.cabin_num), f]));
    const picks = recs
      .sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99))
      .map((r) => ({ ...r, cabin: String(r.cabin), facts: factByNum.get(String(r.cabin)) ?? null }));

    const { data: shipRow } = await supabase
      .from("cabin_ships").select("ship,line,class").eq("slug", ship).maybeSingle();

    res.json({
      ship: shipRow ?? { ship },
      archetype: { id: advice.archetype_id, label: advice.label },
      picks,
      steerClear: advice.steer_clear ?? [],
    });
  } catch (err) {
    logger.error({ err }, "cabins/recommend failed");
    res.status(500).json({ error: "Could not build a recommendation" });
  }
});

export default router;
