// cabins.ts — the Cabin Concierge API (Room Engine).
//
// Cost architecture, revised (Mark, 2026-08-12): TWO layers.
//   1. SELECTION stays pre-computed (2026-07-26 cliffnotes pattern): which cabins
//      suit which traveller archetype was reasoned ONCE over the full grid and
//      stored in public.cabin_advice. That full-grid reasoning is the expensive
//      part and never runs at request time.
//   2. PRESENTATION is reasoned LIVE per search (Mark's direction: "the agent
//      should REASON a description, not regurgitate something stored in the
//      table"). A scoped Haiku call sees ONLY the selected cabins' saved facts +
//      the visitor's actual answers and writes the hook + reasoning fresh for
//      that client — so the words respond to what THIS person said (someone who
//      said seasickness doesn't matter never reads about tummy troubles).
//      Scoped cost ≈ a penny per search; identical answer-sets are cached in
//      memory so repeats are free; and on any failure the stored per-archetype
//      text serves as the fallback, so the page never breaks and never blocks.
//
// The funnel ends at /api/contact — this is lead-gen for Mark's agency, not a
// booking engine. Voice is advisory, never sales: the trust IS the sell.
//
// cabins/cabin_ships/cabin_advice are all service-role-only by RLS, so the page
// can never read them directly; everything goes through here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// The locked voice guide is the system prompt for live presentation reasoning —
// the same asset the batch generator uses, read from the repo when present.
// The deploy boxes don't always carry cabin-advisor/, so a full inline copy is
// the fallback. ⚠️ If voice-guide.md changes, update this constant in the same
// commit — same rule as DESIGN.md.
const VOICE_FALLBACK = `You are Mark, a cruise advisor and the voice of Still Afloat. A traveler has described their trip; recommend specific cabins on the named ship. You are an ADVISOR who has earned trust by being straight with people — including telling them what is wrong with a room. Never sound like a pitch.

How Mark talks — match this closely:

- Open each recommendation with a plain, warm verdict spoken to the client ("Cabin 8280 is a good choice for you"). No clipped spec fragments, no coined cleverness, no dramatic flourishes, no dashes used for effect.
- Explain the reason in plain, flowing sentences — cause, then effect, then what it means for them.
- Ground every benefit in something they can feel, and TEACH BY CONTRAST — name what makes lesser cabins worse so the upside lands.
- Never cite raw specs (square footage, category codes) — translate them to what they mean.
- Frame nice extras casually as a bonus.
- Differentiate every cabin. When two cabins are nearly the same room, say so plainly and give the honest tie-breaker. Never repeat yourself.
- Rank with a reason; be clear which you would book first and why, tied to what THIS traveler told you.
- Be honest about downsides, plainly and kindly — steering someone away from a poor-fit or quietly-obstructed cabin is central to your value.
- Use plain, everyday words only — the kind you'd use talking to a friend, not writing a brochure. Say "a little" not "fractionally," "basically" not "essentially," "real" not "genuine," "extras" not "amenities," "a steel wall" not "superstructure." Simple always beats fancy.
- For seasickness, mix your words the way a real person talks — mostly the gentle "tummy", sometimes "queasy". Skip the clinical "nausea".
- Warm, reassuring, conversational, second person ("you," "your"). Complete, flowing sentences; 2 to 4 is fine when there is something to explain, but do not pad.`;

function loadVoice(): string {
  for (const p of [
    join(process.cwd(), "..", "cabin-advisor", "voice-guide.md"),
    join(process.cwd(), "cabin-advisor", "voice-guide.md"),
  ]) {
    try {
      const raw = readFileSync(p, "utf8");
      return raw.includes("\n---\n") ? raw.split("\n---\n").slice(1).join("\n---\n").trim() : raw.trim();
    } catch { /* try next */ }
  }
  return VOICE_FALLBACK;
}
const VOICE = loadVoice();

// ── Answers → archetype ──────────────────────────────────────────────────────
// The archetypes (cabin-advisor/data/archetypes.json) are the 12 traveller types
// the advice was written for. We score each on how well its tags match the
// visitor's answers and take the best. Deliberately simple and inspectable —
// a wrong match shows the wrong *reasoning*, so it must be debuggable.
type Answers = {
  party?: string;      // solo | couple | family | group | solo-group
  room?: string;       // inside | oceanview | balcony | suite — what they're picturing.
                       // Replaced the budget question (Mark, 2026-08-12): we show no
                       // prices, so asking about money promised a price-shaped answer
                       // this tool can't give. Room type is how an advisor asks it.
  budget?: string;     // legacy: lean | middle | treat | sky (still honored if sent)
  priority?: string;   // ocean | quiet | action | space | value
  motion?: boolean;    // prone to seasickness
};

// Every archetype needs a row here. The fallback (splitting the id) produced a
// real mis-match: "quiet-retirees-calm" split to [quiet, retirees, calm] — no
// "couple" tag — so a quiet-seeking couple lost the party bonus against
// "first-couple-ocean-steady" and was served sensitive-stomach reasoning they
// never asked for (caught 2026-08-12 walking the UI). All 12 covered; the
// id-split fallback below stays only as a net for archetypes added later.
const ARCHETYPE_TAGS: Record<string, string[]> = {
  "first-couple-ocean-steady":   ["couple", "middle", "ocean", "steady", "oceanview", "balcony"],
  "couple-ocean-balcony-treat":  ["couple", "treat", "ocean", "balcony"],
  "anniversary-suite-splurge":   ["couple", "sky", "treat", "space", "suite"],
  "family-action-boardwalk":     ["family", "middle", "action", "balcony"],
  "family-value-space":          ["family", "lean", "space", "inside", "oceanview"],
  "quiet-retirees-calm":         ["couple", "quiet", "middle", "balcony"],
  "value-hunter-ocean":          ["lean", "ocean", "oceanview", "inside"],
  "solo-first-value":            ["solo", "lean", "inside", "oceanview"],
  "solo-with-group":             ["solo-group"],
  "big-group-together":          ["group", "space"],
  "experienced-ocean-midship":   ["couple", "ocean", "middle", "steady", "balcony"],
  "seasick-priority-steady":     ["steady", "quiet"],
};

function pickArchetype(rows: { archetype_id: string }[], a: Answers): string | null {
  if (!rows.length) return null;
  const want = new Set<string>([
    a.party || "", a.room || "", a.budget || "", a.priority || "", a.motion ? "steady" : "",
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

// ── Live presentation reasoning ──────────────────────────────────────────────
// Writes the hook + reasoning fresh for THIS visitor from the selected cabins'
// saved facts. Cached by (ship + answers) — identical needs get identical words,
// which is fine; the point is the words respond to the ANSWERS, not to an
// archetype's imagined persona.
type LiveRec = { cabin: string; hook?: string; reason?: string };
type LiveOut = { recommendations: LiveRec[]; steerClear?: { cabin?: string; reason?: string }[] };

const liveCache = new Map<string, { at: number; out: LiveOut }>();
const LIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // regenerating daily is plenty
const LIVE_CACHE_MAX = 500;

function answersAsSentences(a: Answers): string {
  const bits: string[] = [];
  if (a.party === "couple") bits.push("They are a couple — one cabin, two people.");
  else if (a.party === "family") bits.push("They are a family with kids and need room for everyone.");
  else if (a.party === "solo") bits.push("They are travelling solo.");
  else if (a.party === "solo-group") bits.push("They are travelling solo, alongside a group of friends in other cabins.");
  else if (a.party === "group") bits.push("They are a group booking several cabins who want to stay near each other.");
  if (a.room === "inside") bits.push("They're picturing an inside room — the ship is the destination.");
  else if (a.room === "oceanview") bits.push("They want a window on the water, without a balcony.");
  else if (a.room === "balcony") bits.push("They're picturing a balcony.");
  else if (a.room === "suite") bits.push("They want a suite — space to properly settle in.");
  if (a.priority === "ocean") bits.push("What matters most to them: waking up to a real ocean view.");
  else if (a.priority === "quiet") bits.push("What matters most to them: peace and quiet.");
  else if (a.priority === "action") bits.push("What matters most to them: being near the action.");
  else if (a.priority === "space") bits.push("What matters most to them: room to spread out.");
  bits.push(a.motion
    ? "Someone in the cabin gets seasick — steadiness genuinely matters to them."
    : "Nobody gets seasick. Do NOT mention motion, steadiness, queasiness or stomachs at all.");
  return bits.join(" ");
}

async function reasonLive(
  shipName: string,
  answers: Answers,
  picks: { cabin: string; reason?: string; facts: Record<string, unknown> | null }[],
  steerClear: { cabin?: string; area?: string; reason?: string }[],
): Promise<LiveOut | null> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || !picks.length) return null;

  const key = JSON.stringify([shipName, answers.party, answers.room, answers.priority, !!answers.motion]);
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_CACHE_TTL_MS) return hit.out;

  const cabinData = picks.map((p) => ({
    cabin: p.cabin,
    facts: p.facts,
    backgroundNotes: p.reason, // the archetype write-up: use as FACTS, not as copy
  }));

  const prompt = `The traveler in front of you: ${answersAsSentences(answers)}

Ship: ${shipName}.

The cabins you've already shortlisted for them, with saved facts and your background notes on each (the notes are research — take the facts from them, but write fresh for THIS traveler; do not copy their wording):
${JSON.stringify(cabinData)}

Cabins you'd steer them away from (same treatment):
${JSON.stringify(steerClear)}

Write, for each shortlisted cabin, in rank order:
- "hook": a 5-10 word headline naming the room type and tying it to what THIS traveler told you they want. Like "Boardwalk balcony to watch the action from your own roost" or "An ocean balcony for your quiet morning coffee". Never a spec line like "Ocean View Balcony on Deck 8". Every hook different in wording AND structure — no template reuse.
- "reason": 2-4 sentences in your voice, reasoned for this traveler's answers specifically. Differentiate every cabin; where two are nearly the same, say so and give the honest tie-breaker. Vary your openings — don't start each one the same way.
And rewrite each steer-clear reason for this traveler (1-2 sentences).

Speak ONLY to concerns they actually told you. Respond with ONLY a JSON object:
{"recommendations":[{"cabin":"<number>","hook":"...","reason":"..."}],"steerClear":[{"cabin":"<number or area>","reason":"..."}]}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5", max_tokens: 1800, system: VOICE,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(25000),
    });
    const j = (await r.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };
    if (!r.ok || j.stop_reason === "refusal") throw new Error(`anthropic ${r.status} ${j.stop_reason ?? ""}`);
    const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in live reasoning response");
    const out = JSON.parse(m[0]) as LiveOut;
    if (!Array.isArray(out.recommendations) || !out.recommendations.length) throw new Error("empty recommendations");
    const cost = (j.usage?.input_tokens ?? 0) * 1e-6 + (j.usage?.output_tokens ?? 0) * 5e-6;
    logger.info({ ship: shipName, cost: cost.toFixed(4) }, "cabin concierge: live reasoning generated");
    if (liveCache.size >= LIVE_CACHE_MAX) {
      const oldest = liveCache.keys().next().value;
      if (oldest !== undefined) liveCache.delete(oldest);
    }
    liveCache.set(key, { at: Date.now(), out });
    return out;
  } catch (err) {
    logger.warn({ err }, "cabin concierge: live reasoning failed — serving stored archetype text");
    return null;
  }
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
    let picks = recs
      .sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99))
      .map((r) => ({ ...r, cabin: String(r.cabin), facts: factByNum.get(String(r.cabin)) ?? null }));

    const { data: shipRow } = await supabase
      .from("cabin_ships").select("ship,line,class").eq("slug", ship).maybeSingle();

    // Live pass: rewrite hook + reason for THIS visitor's answers. Stored text
    // is the grounding and the fallback — the response never blocks on failure.
    let steerClear = (advice.steer_clear ?? []) as { cabin?: string; area?: string; reason?: string }[];
    const live = await reasonLive((shipRow?.ship as string) ?? ship, answers, picks, steerClear);
    if (live) {
      const byCabin = new Map(live.recommendations.map((r) => [String(r.cabin), r]));
      picks = picks.map((p) => {
        const lr = byCabin.get(p.cabin);
        return lr ? { ...p, hook: lr.hook, reason: lr.reason || p.reason } : p;
      });
      if (Array.isArray(live.steerClear) && live.steerClear.length) {
        steerClear = live.steerClear;
      }
    }

    res.json({
      ship: shipRow ?? { ship },
      archetype: { id: advice.archetype_id, label: advice.label },
      picks,
      steerClear,
      reasonedLive: !!live,
    });
  } catch (err) {
    logger.error({ err }, "cabins/recommend failed");
    res.status(500).json({ error: "Could not build a recommendation" });
  }
});

export default router;
