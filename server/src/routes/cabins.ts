// cabins.ts — the Cabin Concierge API (Room Engine).
//
// Architecture (Mark, 2026-08-18): THE ADVISOR HOLDS NO CABIN LISTS.
//   1. SELECTION reads the ROOM DATA, which is the fact layer: every room on the
//      hull is a candidate, ranked on the researched obstruction zones plus each
//      room's own derived facts (what sits above and below it — migrations
//      0019/0020). Until today candidates were the pre-written picks in
//      cabin_advice, so ~45 of a ship's 2,000 rooms could ever be shown; Norwegian
//      Aqua had 140 ocean-view cabins with 11 reachable, and a mislabelled room
//      could hide for months behind a list that never mentioned it. Mark: "no
//      preset lists for the advisor — every cabin needs to be accurate, if nothing
//      else because the user can ask about it by entering the room number."
//      cabin_advice survives ONLY as pre-written wording and a tie-break between
//      rooms the facts cannot separate. It can never gate what is offered.
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
import { obstructionLine, placementLines } from "../lib/cabin-placement.js";
import { logger } from "../lib/logger";
import {
  normalizeAnswers, pickArchetype, selectCabins, selectionNote,
  shipTypeInventory, zonesForCabin, zoneSign, classifyCategory, satisfies,
  buildSteerClear, zoneDecks, validateSteerProse, plainSteerLine, steerPromptFacts,
  type Answers, type PoolCabin, type Zone, type SteerCandidate, type SteerFacts,
  type CabinType,
} from "../lib/cabin-match";

const router: IRouter = Router();

// Per-ship cabin grid cache. The grid is static between data loads, so a lookup
// should not re-read thousands of rows every time someone types a cabin number.
const gridCache = new Map<string, { at: number; rows: CabinRow[] }>();
const GRID_TTL_MS = 10 * 60 * 1000;
const GRID_CACHE_MAX = 40;

// The hull's research zones, cached the same way and for the same reason: a few
// dozen rows per class that change only when the research is reloaded, read on
// every single cabin lookup otherwise.
const zoneCache = new Map<string, { at: number; rep: string; zones: Zone[] }>();

/** The whole grid for one ship, paged and cached. The ONLY way to read it. */
async function shipGrid(ship: string): Promise<CabinRow[]> {
  const hit = gridCache.get(ship);
  if (hit && Date.now() - hit.at < GRID_TTL_MS) return hit.rows;
  const supabase = getSupabase();
  const rows = await readAll<CabinRow>((from, to) => supabase
    .from("cabins")
    .select("cabin_num,deck,category,section,side,view,real_ocean,sleeps,obstructed,obstruction,view_blocked,note,x,tour,above_kind,below_kind,noise_nearby,noise_kind")
    .eq("ship_slug", ship)
    .order("cabin_num")
    .range(from, to));
  if (gridCache.size >= GRID_CACHE_MAX) {
    const oldest = gridCache.keys().next().value;
    if (oldest !== undefined) gridCache.delete(oldest);
  }
  gridCache.set(ship, { at: Date.now(), rows });
  return rows;
}

async function zonesForShip(ship: string): Promise<{ rep: string; zones: Zone[] }> {
  const hit = zoneCache.get(ship);
  if (hit && Date.now() - hit.at < GRID_TTL_MS) return { rep: hit.rep, zones: hit.zones };
  const supabase = getSupabase();
  const { data: ctxShip } = await supabase
    .from("cabin_context_ships").select("rep_slug").eq("ship_slug", ship).maybeSingle();
  const rep = (ctxShip as { rep_slug: string } | null)?.rep_slug ?? ship;
  const { data, error } = await supabase
    .from("cabin_context_zones")
    .select("factor,decks,sections,sides,what,effect,what_es,effect_es,matters_to,severity,sign,confidence,source")
    .eq("rep_slug", rep);
  // A schema mismatch (e.g. a box whose DB missed migration 0025/0026) must not
  // silently disable the whole moat layer as an empty zone list.
  if (error) console.error(`zonesForShip ${ship}: zone select failed - ${error.message}`);
  const zones = ((data ?? []) as Record<string, unknown>[]).map((z) => ({
    factor: String(z["factor"]), decks: (z["decks"] as number[]) ?? [],
    sections: (z["sections"] as string[]) ?? [], sides: (z["sides"] as string[]) ?? [],
    what: (z["what"] as string) ?? null, effect: (z["effect"] as string) ?? null,
    whatEs: (z["what_es"] as string) ?? null, effectEs: (z["effect_es"] as string) ?? null,
    mattersTo: (z["matters_to"] as string) ?? null,
    // missing => "penalty", so an un-reviewed zone behaves exactly as it did before 0025.
    sign: (z["sign"] as "penalty" | "benefit" | "neutral") ?? "penalty",
    severity: z["severity"], confidence: z["confidence"], source: String(z["source"]),
  })) as Zone[];
  if (zoneCache.size >= GRID_CACHE_MAX) {
    const oldest = zoneCache.keys().next().value;
    if (oldest !== undefined) zoneCache.delete(oldest);
  }
  zoneCache.set(ship, { at: Date.now(), rep, zones });
  return { rep, zones };
}

/**
 * Read every row of a query, 1000 at a time.
 *
 * PostgREST caps a response at 1000 rows and `.limit(n)` does NOT raise that cap.
 * Wonder of the Seas has 2,886 cabins and 121 of 138 ships carry more than 1,000,
 * so any unpaged whole-ship read silently returns a fraction. That produced two
 * bugs found on 2026-08-17: the fleet list reporting "no rooms" for 137 of 138
 * ships, and /cabins/check telling a booked cruiser their real cabin does not
 * exist because it sat beyond row 1000.
 */
async function readAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}



interface CabinRow {
  cabin_num: string; deck: number | null; category: string | null; section: string | null;
  side: string | null; view: string | null; sleeps: number | null;
  /** Does it actually face open sea? Filled fleet-wide 2026-08-19; null = category unreadable. */
  real_ocean: boolean | null;
  obstructed: boolean | null; obstruction: string | null; note: string | null;
  /** Structured obstruction kind when known ("lifeboat" | "taper") — drives the guest wording. */
  view_blocked: string | null;
  x: string | number | null;
  /** Derived per room (migrations 0019/0020): what is on the deck above/below AT THIS SPOT. */
  above_kind: "cabins" | "open" | "unknown" | null;
  below_kind: "cabins" | "open" | "unknown" | null;
  /** A lift lobby or stairwell within four rooms, read off the deck plan (0021). */
  noise_nearby: string | null;
  noise_kind: "lift" | "stairs" | "venue" | null;
}

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
- Warm, reassuring, conversational, second person ("you," "your"). Complete, flowing sentences; 2 to 4 is fine when there is something to explain, but do not pad.

Personality — the "Laugh More" half of the brand:

- You are funny the way a well-traveled friend at the bar is funny: dry, a little self-deprecating, one well-placed line — never jokey, never a comedian doing bits. A set of recommendations with zero smiles in it is a FAILURE. Land at least one genuine dry line somewhere in every set.
- Humor targets SITUATIONS — buffets, conga lines, pool-chair hogs, karaoke night, your own habits — never the traveler, never the crew.
- These are the register (tone reference only — do not copy them verbatim): "You keep the sun lounger — the homework part is mine." / "Steps from the pool, the shows, and the occasional conga line." / "Nobody judges the pajamas at sea." / "Close enough to find each other, far enough to escape each other."
- BANNED brochure-speak — if a cruise brochure would print the sentence, rewrite it: "your best match", "perfect for", "boasts", "offers", "features", "nestled", "ideally positioned", "ideally situated", "exactly what you're after", "look no further". Openers like "Cabin NNNN is positioned..." read like a spec sheet — talk like you'd talk.`;

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
// The answer shape, the archetype table and the matcher all live in
// lib/cabin-match.ts now. They were moved out on 2026-08-17 for one reason: in
// here they are unreachable by a test (the route needs Supabase and a live LLM
// call), so the whole answer space was never swept and the tool shipped with a
// balcony request being answered with ocean-view rooms. lib/cabin-match.test.ts
// now walks 1,315,200 selections — every answer to every question on all 138
// ships — with no network at all.
//
// The local `motion?: boolean` type and its `a.motion === "yes"` compare are
// deliberately gone: that line was a live `TS2367`, and it meant nobody who said
// "yes, keep us steady" was treated as seasick. One normaliser owns that field.

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
  bits.push(a.seasick
    ? "Someone in the cabin gets seasick — steadiness genuinely matters to them."
    : "Nobody gets seasick. Do NOT mention motion, sway, steadiness, queasiness, stomachs or seasickness at all — not even to reassure them.");
  return bits.join(" ");
}

// Banned-word scrub for LIVE-generated text — the model occasionally slips
// "genuine(ly)"/"actually" despite the voice guide (caught on staging 8/14).
// Surgical word removal, sentence untouched.
function scrubBanned(t: string | undefined): string | undefined {
  if (!t) return t;
  return t
    .replace(/sleep like the dead/gi, "sleep soundly")
    .replace(/dead quiet/gi, "truly quiet")
    .replace(/to die for/gi, "worth the trip alone")
    .replace(/dormir como (?:un )?muerto/gi, "dormir profundo")
    .replace(/\s(?:genuinely|genuine|actually)\s/gi, " ")
    .replace(/\sde hecho[,]?\s/gi, " ")
    .replace(/\s{2,}/g, " ");
}

async function reasonLive(
  shipName: string,
  answers: Answers,
  // `facts` is only JSON-stringified into the prompt, so the row shape is
  // irrelevant here — and an interface is not assignable to Record<string, unknown>.
  picks: { cabin: string; reason?: string; facts: unknown }[],
  steerClear: { cabin?: string; area?: string; reason?: string }[],
  lang: "en" | "es" = "en",
): Promise<LiveOut | null> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || !picks.length) return null;

  // Every field that changes the words must be in the key. This previously read
  // the motion field a third way (`!!answers.motion`, different from both the type
  // and the matcher) and left `budget` out, so two visitors who answered the budget
  // question differently could be served each other's cached copy.
  // The SHORTLIST SIZE belongs in the key. Without it the 5-room call and the
  // 24-room "Show me More Options" call shared one entry, so whichever ran first
  // won: the long list was served reasoning for five cabins and the other nineteen
  // rendered as bare numbers (Mark saw this on Wonder of the Seas, 2026-08-21).
  const key = JSON.stringify([
    shipName, answers.party, answers.room, answers.priority, answers.budget, answers.seasick, lang,
    picks.length,
  ]);
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

Speak ONLY to concerns they actually told you. REQUIRED, not optional: at least one genuinely funny dry line across the set, in your register (situational — buffets, conga lines, pool-chair hogs, pajamas at sea — never at the traveler). Final check before answering: if any sentence contains "best match", "perfect for", "exactly what you're after", "boasts", "offers", "features", or could run in a cruise brochure unchanged, rewrite it first.${lang === "es" ? `

Write EVERYTHING (hooks, reasons, steer-clear reasons) in neutral Latin American Spanish (es-419) — Mark's same warm, plain-spoken, slightly salty voice, never textbook Spanish, never brochure Spanish ("perfecto para", "ofrece", "cuenta con" banned; no "de hecho" as filler). Cabin numbers, deck numbers, ship names and enclave names stay exactly as-is.` : ""} Respond with ONLY a JSON object:
{"recommendations":[{"cabin":"<number>","hook":"...","reason":"..."}],"steerClear":[{"cabin":"<number or area>","reason":"..."}]}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        // A hook plus 2-4 sentences per cabin: 1800 truncates well before 24 rooms,
        // which is the other half of why the long list came back unwritten.
        model: "claude-haiku-4-5", max_tokens: picks.length > 8 ? 6000 : 1800, system: VOICE,
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


/**
 * Let the model write the skip-list in Mark's voice — from facts, never from
 * research text.
 *
 * Mark, 2026-08-17: "use option one as long as it stays within the style and
 * voice of the site. facts, mixed with a little fun."
 *
 * It is handed structured facts only (cabin, deck, section, category, what is
 * physically there, how bad). Everything it returns goes through
 * validateSteerProse, which rejects any line that invents a cabin or deck,
 * quotes a review site, blames the line, leaks confidence, or runs long. A
 * rejected line falls back to the plain composed sentence — dull and true beats
 * lively and wrong.
 */
async function writeSteerLines(
  shipName: string, facts: SteerFacts[], answers: Answers, lang: "en" | "es",
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of facts) out.set(f.cabin, plainSteerLine(f, lang));   // safe default
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || !facts.length) return out;

  const key = JSON.stringify(["steer", shipName, lang, answers.seasick, facts.map((f) => f.cabin + f.factor)]);
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_CACHE_TTL_MS) {
    for (const r of hit.out.recommendations) {
      const f = facts.find((x) => x.cabin === String(r.cabin));
      const ok = f && validateSteerProse(r.reason, f);
      if (f && ok) out.set(f.cabin, ok);
    }
    return out;
  }

  // Same negation discipline as the room cards: someone who said motion is not a
  // problem must never read about stomachs. The voice guide is explicit that this
  // has to be an absolute instruction, not a hint — it leaked otherwise.
  // Two different things, and conflating them cost a real warning (Mark, 8/17):
  // WHERE the room sits is a physical fact every traveller feels and should hear
  // about. SEASICKNESS is a medical concern raised only by someone who raised it.
  const motionRule = answers.seasick
    ? "This traveler DOES get seasick. You may connect the ship's movement to that directly."
    : "This traveler said seasickness is NOT a problem for them. You SHOULD still tell them plainly when a room sits where the ship moves most — the bow and the stern genuinely move more, and that is useful to know. But describe it as the room's position and what it feels like, and do NOT mention seasickness, stomachs, queasiness or nausea at all.";
  const prompt = `Ship: ${shipName}. These are rooms you would steer this traveler AWAY from.

${motionRule}

${steerPromptFacts(facts)}

For each, write ONE sentence (max 200 characters) in your own voice explaining why you would walk past it.
Rules that are not negotiable:
- Use ONLY the facts given. Do not mention any cabin number except the one on that entry, and do not mention any deck except that entry's deck.
- Never say or imply the cruise line hid, mislabelled or failed to disclose anything. Describe what is there and what it means.
- Never cite a review site, a forum, or "a reviewer".
- Facts with a little fun: one dry, warm line — the well-travelled friend at the bar, not a comedian and not a brochure.${lang === "es" ? "\n- Write in neutral Latin American Spanish (es-419), Mark's same plain, warm voice." : ""}

Respond with ONLY JSON: {"lines":[{"cabin":"<number>","reason":"..."}]}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 700, system: VOICE,
        messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(20000),
    });
    const j = (await r.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
    if (!r.ok || j.stop_reason === "refusal") throw new Error(`anthropic ${r.status}`);
    const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON");
    const parsed = JSON.parse(m[0]) as { lines?: { cabin?: string; reason?: string }[] };
    let kept = 0, rejected = 0;
    const cacheable: LiveRec[] = [];
    // "Differentiate every cabin… Never repeat yourself" is in the voice guide, and
    // the model does repeat itself — two adjacent cabins came back with a
    // byte-identical sentence. A duplicate is rejected so the second falls back to
    // the plain line, which at least reads differently.
    const seen = new Set<string>();
    for (const line of parsed.lines ?? []) {
      const f = facts.find((x) => x.cabin === String(line.cabin));
      if (!f) { rejected++; continue; }
      const safe = validateSteerProse(scrubBanned(line.reason), f, facts.map((x) => x.cabin));
      const fingerprint = safe?.toLowerCase().replace(/\b\d{3,5}[a-z]?\b/g, "#").replace(/[^a-z# ]/g, "");
      if (safe && fingerprint && !seen.has(fingerprint)) {
        seen.add(fingerprint);
        out.set(f.cabin, safe); cacheable.push({ cabin: f.cabin, reason: safe }); kept++;
      } else rejected++;
    }
    if (rejected) logger.info({ ship: shipName, kept, rejected }, "steer-clear: lines rejected by the fact gate");
    liveCache.set(key, { at: Date.now(), out: { recommendations: cacheable } });
  } catch (err) {
    logger.warn({ err }, "steer-clear: writer unavailable — serving the plain lines");
  }
  return out;
}

// ── Our own deck map ─────────────────────────────────────────────────────────
// Mark, 2026-08-12: don't send visitors to the cruise line's site for deck
// plans — "it's throwing the other company a bone." We extracted every cabin's
// real position into public.cabins (x = across the beam, y = bow→stern), so we
// draw our OWN schematic from our own facts. Nothing rehosted, nobody boned.
router.get("/cabins/deckmap", async (req: Request, res: Response) => {
  try {
    const ship = String(req.query["ship"] || "");
    const deck = Number(req.query["deck"]);
    if (!ship || !deck) return res.status(400).json({ error: "ship and deck are required" });
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("cabins")
      .select("cabin_num,x,y,category")
      .eq("ship_slug", ship)
      .eq("deck", deck)
      .not("x", "is", null);
    if (error) throw new Error(error.message);
    return res.json({ deck, cabins: data ?? [] });
  } catch (err) {
    logger.error({ err }, "cabins/deckmap failed");
    return res.status(500).json({ error: "Could not load the deck map" });
  }
});

// ── "I'm already booked — is my view OK?" ────────────────────────────────────
// The highest-intent question a booked cruiser has, and the one the booking engine
// never answers. Two HARD rules from Mark (2026-08-16), both about tone and moat:
//   1. NEVER position this against the cruise line. We do not say a cabin was
//      mislabelled, undisclosed or hidden. We say what sits outside the window and
//      what to expect. Mark works WITH the lines; this has to read as helpful.
//   2. The confidence score is INTERNAL. It decides how firmly we speak (or whether
//      we speak at all) — it is never rendered. Publishing it gives away the method.
router.post("/cabins/check", async (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as { ship?: string; cabin?: string; lang?: string };
    const ship = String(b.ship || "").trim();
    const raw = String(b.cabin || "").trim().toUpperCase().replace(/\s+/g, "");
    const es = b.lang === "es" || req.query["lang"] === "es";
    if (!ship || !raw) return res.status(400).json({ error: "ship and cabin are required" });

    const supabase = getSupabase();
    const all = await shipGrid(ship);
    const hit = all.find((c) => String(c.cabin_num).toUpperCase().replace(/\s+/g, "") === raw);

    // THE MOAT. Until 2026-08-17 this endpoint answered purely from the cruise
    // line's own `obstructed` flag — present on 388 of 225,924 cabins (0.17%) —
    // so it handed out 74,303 all-clears from the absence of a disclosure that
    // barely exists, and never once consulted the 478 sourced research zones
    // that are the entire reason this feature has an edge.
    const { zones } = await zonesForShip(ship);
    const research = hit ? zonesForCabin(
      { deck: hit.deck, section: hit.section, side: hit.side, category: hit.category }, zones)
      // Only penalty zones may WARN. Without this, the 83 benefit-signed zones ("the horizon
      // view is unaffected", the hump) headline as problems on this page — the same inversion
      // fixed in viewVerdict, living on in this hand-rolled third copy of the verdict logic.
      .filter((z) => zoneSign(z) === "penalty") : [];

    if (!hit) {
      // near matches so a typo does not dead-end the visitor
      const near = all
        .filter((c) => String(c.cabin_num).toUpperCase().startsWith(raw.slice(0, 2)))
        .slice(0, 8)
        .map((c) => c.cabin_num);
      return res.json({
        found: false,
        message: es
          ? "No encuentro ese camarote en este barco. Revisa el número, o sigue y te ayudo a elegir uno."
          : "I can't find that cabin on this ship. Check the number, or carry on and I'll help you choose one.",
        near,
      });
    }

    const cat = String(hit.category || "").toLowerCase();
    const interior = /interior|inside/.test(cat);
    const knownType = Boolean(cat) || Boolean(hit.view);
    const hasWindow = !interior;

    // INTERNAL confidence only — never returned to the client.
    let confidence = 0;
    const lines: string[] = [];
    let headline: string;

    if (!knownType) {
      // We do not even know if this cabin HAS a window. Saying "nothing is blocking your
      // window" here would be a confident answer built on nothing — the one failure mode
      // Mark ruled out. Say what we have and hand it to a human.
      confidence = 0.2;
      headline = es ? "Necesito confirmarlo" : "I'd want to confirm this one";
      lines.push(es
        ? "Tengo tu camarote en el plano del barco, pero no el detalle de categoría que necesito para hablarte de la vista con seguridad. Prefiero decírtelo a adivinar."
        : "I have your cabin on the ship's plan, but not the category detail I'd need to talk about the view with any confidence. I'd rather tell you that than guess.");
      lines.push(es
        ? "Si me dices tu salida, lo reviso a mano y te confirmo qué esperar."
        : "Tell me your sailing and I'll check it by hand and confirm what to expect.");
    } else if (interior) {
      confidence = 0.95;
      headline = es ? "Sin ventana que preocuparte" : "No window to worry about";
      lines.push(es
        ? "Es un camarote interior, así que la vista no entra en la ecuación. Lo que importa aquí es la ubicación: qué tan lejos estás de los ascensores y qué tienes encima y debajo."
        : "This is an interior cabin, so the view isn't part of the equation. What matters here is placement — how far you are from the elevators, and what sits above and below you.");
    } else if (hit.obstructed) {
      confidence = 0.9;
      headline = es ? "Espera algo delante de la ventana" : "Expect something in front of the window";
      lines.push(es
        ? "Según lo que hay afuera de esa ventana, tu vista puede verse afectada. Suele ser un bote salvavidas, una estructura del casco o un saliente de la cubierta de arriba."
        : "Based on what sits outside that window, your view may be affected. Usually that means a lifeboat, part of the ship's structure, or an overhang from the deck above.");
      // Rendered, never raw: the column stores research ("heavy: lifeboat", prose that cites
      // its sources); the guest line is built from the structured parts in the guest's language.
      const ob = obstructionLine(hit.obstruction, hit.view_blocked, es);
      if (ob) lines.push(ob);
      lines.push(es
        ? "Sigue siendo luz natural y aire — mucha gente lo reserva a propósito por el precio. Solo conviene saberlo antes de subir a bordo, no después."
        : "You still get natural light and air, and plenty of people book these on purpose for the price. It's just worth knowing before you board rather than after.");
    } else {
      // Sourced research first — it is the thing we actually studied.
      if (research.length) {
        const worst = research[0]!;
        confidence = worst.confidence === "high" ? 0.9 : worst.confidence === "medium" ? 0.6 : 0.35;
        // "hump" deliberately absent: the hull steps OUT there and the balcony is better for
        // it, so it must never lead with "something may sit in your view".
        const viewish = research.find((z) => ["lifeboat", "taper", "obstruction"].includes(z.factor));
        headline = viewish
          ? (es ? "Algo puede aparecer en tu vista" : "Something may sit in your view")
          : (es ? "Vale saber qué tienes cerca" : "Worth knowing what's near you");
        if (viewish) lines.push(es
          ? "Por lo que hay afuera de esa ventana, tu vista puede verse afectada:"
          : "Based on what sits outside that window, your view may be affected:");
        for (const z of research.slice(0, 2)) {
          const t = es ? (z.whatEs ?? z.effectEs ?? z.what ?? z.effect) : (z.what || z.effect);
          if (t) lines.push(t);
        }
      } else {
      // Soft signal: same deck, same side, close along the hull — neighbours flagged?
      const x = Number(hit.x);
      const neighbours = all.filter(
        (c) => c.deck === hit.deck && c.side === hit.side && c.obstructed &&
               Number.isFinite(x) && Number.isFinite(Number(c.x)) &&
               Math.abs(Number(c.x) - x) < 40);
      if (neighbours.length) {
        confidence = 0.55;
        headline = es ? "Vale la pena revisarlo" : "Worth a second look";
        lines.push(es
          ? "Tu camarote no aparece con la vista comprometida, pero algunos camarotes muy cerca del tuyo, en la misma cubierta y el mismo costado, sí. En esa zona la vista puede variar de un camarote a otro."
          : "Your cabin doesn't come up as having a compromised view, but some cabins very close to yours — same deck, same side — do. Along that stretch the view can change from one cabin to the next.");
        lines.push(es
          ? "Si la vista te importa, vale la pena confirmarlo antes de la fecha de pago final."
          : "If the view matters to you, it's worth confirming before your final payment date.");
      } else {
        // Honest framing: we checked the research and it flags nothing HERE. That
        // is not the same as promising a clear view, and it must not read like one.
        const checked = zones.length > 0;
        confidence = checked ? 0.75 : 0.35;
        headline = checked
          ? (es ? "Nada en nuestra investigación marca este camarote" : "Nothing in our research flags this one")
          : (es ? "No tengo investigación de este barco" : "I don't have research on this ship yet");
        lines.push(checked
          ? (es
            ? "Revisamos lo que hay alrededor de este camarote en este casco y no aparece nada que bloquee la ventana. No es una garantía de vista despejada, pero no hay señales."
            : "We checked what sits around this cabin on this hull and nothing came up against it. That isn't a promise of a clear view, but there's nothing pointing the other way.")
          : (es
            ? "Todavía no tengo el estudio de este casco, así que no puedo decirte gran cosa sobre la vista. Prefiero decírtelo a inventarlo."
            : "I don't have the hull study for this ship yet, so I can't tell you much about the view. I'd rather say that than make something up."));
      }
    }
    }

    // WHAT IS AROUND YOU. Everything above answers the window. Mark's reason for wanting
    // every room right was the other half — "the user can ask about it by entering the room
    // number" — and until 2026-08-19 this endpoint told interior guests that placement is
    // what matters here and then said nothing whatever about it.
    lines.push(...placementLines(hit, es));

    // Honest about our own limits when the ship's data is thin — Mark's rule: a wrong
    // "you're fine" is worse than no answer.
    const coverage = all.filter((c) => c.x !== null && c.x !== undefined).length / Math.max(all.length, 1);
    if (hasWindow && coverage < 0.5) {
      confidence = Math.min(confidence, 0.4);
      lines.push(es
        ? "Dicho eso: nuestros datos de este barco son parciales, así que tómalo como una orientación y no como la última palabra."
        : "That said — our data on this ship is partial, so treat this as a steer rather than the last word.");
    }

    const where: string[] = [];
    if (hit.deck) where.push(es ? `Cubierta ${hit.deck}` : `Deck ${hit.deck}`);
    if (hit.category) where.push(String(hit.category));
    if (hit.section) where.push(String(hit.section));
    if (hit.side) where.push(String(hit.side));

    return res.json({
      found: true,
      cabin: hit.cabin_num,
      where,
      headline,
      body: lines,          // confidence deliberately NOT included
      cta: es
        ? "¿Quieres que revise si hay un camarote mejor en esta misma salida?"
        : "Want me to see if there's a better cabin on this same sailing?",
    });
  } catch (err) {
    logger.error({ err }, "cabins/check failed");
    return res.status(500).json({ error: "Could not check that cabin" });
  }
});

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
    return res.json({ ships: ships ?? [] });
  } catch (err) {
    logger.error({ err }, "cabins/ships failed");
    return res.status(500).json({ error: "Could not load ships" });
  }
});


// ── The real fleet: every sailing ship → its class → the geometry rep ─────────
// fleet.json (cabin-advisor/, version-controlled, compiled July 2026) is the
// canonical real-ship→class mapping: sister ships share a hull/cabin layout, so
// each maps to the one class rep we harvested in cabin_ships. Ratings are
// per-REAL-ship (sisters score differently with cruisers) and only surface here
// once published+approved — internal ranking may use more (see suggest-ships).
type FleetShip = {
  ship: string; slug: string; line: string; shipClass: string;
  repSlug: string | null; hasRooms: boolean; rating: number | null;
  regions: string[];          // from ship_deployments (empty until captured)
};

// The fleet comes from the DATABASE, not from matching names at request time.
//
// This used to read cabin-advisor/fleet.json and resolve each ship to a hull grid
// by CLASS NAME:
//     repByClass.set(r.class.toLowerCase(), ...)   // last write wins
//     const rep = repByClass.get(className.toLowerCase())
// Class names are not unique across lines. Carnival and Norwegian both have a
// "Spirit"; Carnival (ex-P&O) and Princess both have a "Grand". NCL loaded last,
// so five Carnival ships resolved to Norwegian Spirit and two to Grand Princess —
// and since those hulls share ZERO cabin numbers, every recommendation shown for
// Carnival Spirit named a room that does not exist on it.
//
// Every ship now owns a row (migration 0017). `in_fleet` says whether to offer it,
// `derived_from` says where its reasoning came from. fleet.json is now only an
// input to the materialisation script, never a runtime lookup.
// Both rating maps are always built; the caller decides which to use (/cabins/fleet
// ignores internalRating, suggest-ships uses it). The old boolean parameter was
// dead after the rewrite and implied a gate that did not exist.
async function buildFleet(): Promise<{ ships: FleetShip[]; internalRating: Map<string, number> }> {
  const supabase = getSupabase();
  const { data: shipRows } = await supabase
    .from("cabin_ships")
    .select("slug,ship,line,class,fleet_class,derived_from,numbering_verified")
    .eq("in_fleet", true);
  const ships0 = (shipRows ?? []) as {
    slug: string; ship: string; line: string; class: string; fleet_class: string | null;
    derived_from: string | null; numbering_verified: boolean;
  }[];

  const { data: adviceRows } = await supabase.from("cabin_advice").select("ship_slug");
  const adviceSlugs = new Set((adviceRows ?? []).map((r: { ship_slug: string }) => r.ship_slug));

  // NOTE: do NOT try to learn "which ships hold cabins" by reading the cabins
  // table here. PostgREST caps every response at 1000 rows and `.limit(100000)`
  // does NOT raise that cap — the read comes back with 1000 rows covering a
  // single ship, so the derived set is wrong for 137 of 138 ships and every one
  // of them reports "no rooms available". (Caught in review 2026-08-17, before
  // it shipped.) It is also unnecessary: advice only exists for hulls that had a
  // grid to reason over, so `adviceSlugs` already excludes the two ships with no
  // deck plan sourced (Carnival Adventure and Encounter have neither).

  const { data: depRows } = await supabase.from("ship_deployments").select("ship_slug,region");
  const regionsBySlug = new Map<string, string[]>();
  for (const d of (depRows ?? []) as { ship_slug: string; region: string }[]) {
    const arr = regionsBySlug.get(d.ship_slug) ?? [];
    if (!arr.includes(d.region)) arr.push(d.region);
    regionsBySlug.set(d.ship_slug, arr);
  }

  const { data: ratingRows } = await supabase
    .from("conga_line_ratings").select("ship_slug,rating,status,comment_status");
  const publicRating = new Map<string, number>();
  const internalRating = new Map<string, number>();
  for (const r of (ratingRows ?? []) as
       { ship_slug: string; rating: number | null; status: string; comment_status: string }[]) {
    if (r.rating == null) continue;
    if (r.comment_status === "approved") internalRating.set(r.ship_slug, Number(r.rating));
    if (r.status === "published" && r.comment_status === "approved") publicRating.set(r.ship_slug, Number(r.rating));
  }

  const ships: FleetShip[] = ships0.map((s) => {
    const adviceSlug = s.derived_from ?? s.slug;
    return {
      ship: s.ship, slug: s.slug, line: s.line,
      shipClass: s.fleet_class ?? s.class,
      repSlug: s.slug,                       // a ship reads its OWN rows now
      hasRooms: adviceSlugs.has(adviceSlug),
      rating: publicRating.get(s.slug) ?? null,
      regions: regionsBySlug.get(s.slug) ?? [],
    };
  }).sort((a, b) => a.line.localeCompare(b.line) || a.ship.localeCompare(b.ship));

  return { ships, internalRating };
}

router.get("/cabins/fleet", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  try {
    const { ships } = await buildFleet();
    return res.json({ ships });
  } catch (err) {
    logger.error({ err }, "cabins/fleet failed");
    return res.status(500).json({ error: "Could not load the fleet" });
  }
});

// ── Personality → ship suggestions ───────────────────────────────────────────
// Deterministic and inspectable, same philosophy as pickArchetype: a wrong
// suggestion must be debuggable. Internal ranking uses approved-but-unpublished
// ratings (our own data, never exposed); the response carries only published
// scores. Reasons are built from the visitor's own answers, never from
// unpublished rating text.
type Personality = { energy?: string; social?: string; structure?: string; splurge?: string; crowds?: string };
type Traits = Record<string, number>;

// The virtue matrix (cabin-advisor/matrix.json): line-level virtues, class-level
// overrides, and the premium enclaves (Yacht Club / Haven / Retreat / Star
// Class...). Energy column approved by Mark 8/14; other values drafted for his
// correction — tune the JSON, not this code.
type Matrix = {
  lines: Record<string, Record<string, number>>;
  classOverrides: Record<string, Record<string, number>>;
  enclaves: Record<string, { name: string; classes: string[]; note?: string }>;
  shipAdjust?: Record<string, { adjust: number; why: string }>;
  /** Lines presented first-class in suggestions — excluded from the worth-a-look
   *  slot. Mark's dial (matrix.json), not code. Margaritaville at Sea IS on it
   *  (Mark, 2026-08-21: up-and-coming, rates well in our rankings — presented
   *  alongside the majors, never as the wildcard). */
  mainstream?: string[];
};
function loadMatrix(): Matrix | null {
  for (const p of [
    join(process.cwd(), "..", "cabin-advisor", "matrix.json"),
    join(process.cwd(), "cabin-advisor", "matrix.json"),
  ]) {
    try { return JSON.parse(readFileSync(p, "utf8")) as Matrix; } catch { /* next */ }
  }
  return null;
}

// fleet.json names some lines differently than the matrix ("Royal Caribbean
// International" vs "Royal Caribbean") — without this, those ships silently
// scored on a bland default profile and lost enclave eligibility (caught by
// the 8/14 staging test run).
const LINE_ALIASES: Record<string, string> = {
  "Royal Caribbean International": "Royal Caribbean",
  "Margaritaville at Sea Cruises": "Margaritaville at Sea",
  "Norwegian": "Norwegian Cruise Line",
};
function canonLine(line: string): string { return LINE_ALIASES[line] ?? line; }

function virtuesFor(matrix: Matrix, line: string, shipClass: string): Record<string, number> {
  line = canonLine(line);
  const base = matrix.lines[line] ?? { energy: 1, price: 1, family: 1, dining: 1, activity: 1, structure: 1, scale: 1, warmth: 1 };
  const override = matrix.classOverrides[`${line}|${shipClass}`] ?? {};   // line already canonical here
  return { ...base, ...override };
}

function enclaveFor(matrix: Matrix, line: string, shipClass: string): { name: string; note?: string } | null {
  const e = matrix.enclaves[canonLine(line)];
  if (!e) return null;
  return e.classes.includes(shipClass) ? { name: e.name, note: e.note } : null;
}

router.post("/cabins/suggest-ships", async (req: Request, res: Response) => {
  try {
    const { personality = {}, party, traits = {}, budget, destination, lang: langRaw } = (req.body ?? {}) as
      { personality?: Personality; party?: string; traits?: Traits; raw?: Record<string, string>; budget?: string; destination?: string; lang?: string };
    const lang: "en" | "es" = langRaw === "es" || req.query["lang"] === "es" ? "es" : "en";
    const matrix = loadMatrix();
    if (!matrix) return res.status(500).json({ error: "matrix unavailable" });
    const { ships, internalRating } = await buildFleet();

    const t = (k: string) => Number(traits[k] ?? 0);
    // What this visitor is reaching for, per virtue (same 0-2 space as the matrix).
    const target = {
      energy:  personality.energy === "party" ? 2 : personality.energy === "social" ? 1 : 0,
      price:   personality.splurge === "cabin" ? 2 : personality.splurge === "value" ? 0 : 1,
      family:  party === "family" ? 2 : party === "group" ? 1.5 : 0.5,
      dining:  Math.min(2, t("food")),
      activity: Math.min(2, t("active")),
      structure: personality.structure === "planner" ? 0.5 : 1.5,
      scale:   personality.crowds === "avoids" ? 0 : personality.crowds === "loves-it" ? 2 : 1,
      warmth:  t("extrovert") >= 2 || t("social") >= 3 ? 2 : 1,
    };
    // How much each virtue matters to THIS visitor — a foodie's dining gap
    // costs more than a grazer's.
    const weight = {
      energy: 2.0, price: 1.5,
      family: party === "family" ? 1.5 : 0.75,
      dining: 0.5 + Math.min(1.5, t("food") * 0.75),
      activity: 0.5 + Math.min(1.5, t("active") * 0.75),
      structure: 1.25,   // freestyle IS the product answer for wing-its — equal pull both ways
      scale: personality.crowds === "avoids" ? 2.0 : 1.0,
      warmth: t("extrovert") >= 2 ? 1.25 : 0.5,
    };
    // Never pitch the enclave to someone who just said they respect a number —
    // the disposition gates the upsell, no pricing data needed (Mark, 8/14).
    const wantsEnclave = budget !== "lean" && (personality.splurge === "cabin" ||
      (personality.social === "introvert" && personality.crowds === "avoids"));

    // Destination: a strong prior, not a silent hard filter — until the
    // deployment capture covers the fleet, an empty regions list means
    // "unknown", which must not blank the suggestions. Ships KNOWN to sail
    // the chosen waters get a real boost; ships known NOT to, a real penalty.
    const anyDeployments = ships.some((sh) => sh.regions.length > 0);
    const scored = ships
      .filter((sh) => sh.repSlug)
      .map((sh) => {
        const v = virtuesFor(matrix, sh.line, sh.shipClass);
        const enclave = enclaveFor(matrix, sh.line, sh.shipClass);
        let score = 0;
        for (const k of Object.keys(target) as (keyof typeof target)[]) {
          let gap = Math.abs((v[k] ?? 1) - target[k]);
          // The enclave rescue: a private complex neutralizes most of a big
          // loud ship's scale/energy penalty for the splurge-capable quiet
          // type — the advisor move behind "next level".
          if (enclave && wantsEnclave && (k === "scale" || k === "energy")) gap *= 0.35;
          score -= gap * weight[k];
        }
        // availability prior: a two-ship short-run line can win a vibe contest
        // but can't take you to Alaska — advisors carry this prior implicitly.
        score += ((v["breadth"] ?? 1.5) - 1.5) * 1.5;
        const r = internalRating.get(sh.slug);
        if (r != null) score += (r - 3.5) * 1.6;
        if (sh.hasRooms) score += 0.75;
        // The advisor's thumb: Mark's firsthand per-ship verdicts outrank any model.
        const adj = matrix.shipAdjust?.[sh.slug];
        if (adj && typeof adj.adjust === "number") score += adj.adjust;
        if (destination && destination !== "surprise" && anyDeployments && sh.regions.length) {
          score += sh.regions.includes(destination) ? 3.0 : -3.0;
        }
        const nextLevel = enclave && wantsEnclave
          ? { name: enclave.name, why: lang === "es"
              ? "la versión tranquila y bien atendida de este barco — espacios privados, y la multitud se queda afuera"
              : "the quiet, looked-after version of this ship — private spaces, and the crowd stays outside" }
          : enclave ? { name: enclave.name, why: lang === "es"
              ? "vale la pena saber que tiene un lado más tranquilo y bien atendido, por si algún día lo quieres"
              : "worth knowing she has a quieter, looked-after side if you ever want it" } : null;
        return { s: sh, score, nextLevel };
      })
      .sort((a, b) => b.score - a.score);

    const picks: (FleetShip & { nextLevel: { name: string; why: string } | null })[] = [];
    const usedLines = new Set<string>();
    for (const { s: sh, nextLevel } of scored) {
      if (usedLines.has(sh.line)) continue;
      usedLines.add(sh.line);
      picks.push({ ...sh, nextLevel });
      if (picks.length === 2) break;
    }

    // The under-considered opportunity — the advisor's "have you thought about…".
    // Mark, 2026-08-21: "our own rating is high and comparable to royal, carnival,
    // ncl and msc. we need to fine tune to bring opportunities out that they might
    // not be thinking about and then explain why." Surfaced ONLY when our own
    // internal verdict backs it (>= 4), never from vibes; the response carries the
    // published rating alone, per the rule at the top of this section.
    const mainstream = new Set((matrix.mainstream ??
      ["Royal Caribbean", "Carnival Cruise Line", "Norwegian Cruise Line", "MSC Cruises"]).map(canonLine));
    let worthALook: (FleetShip & { nextLevel: { name: string; why: string } | null; why: string }) | null = null;
    const floor = picks.length ? (scored.find((x) => x.s.slug === picks[picks.length - 1]!.slug)?.score ?? 0) - 4 : -Infinity;
    for (const { s: sh, score, nextLevel } of scored) {
      if (usedLines.has(sh.line)) continue;
      if (mainstream.has(canonLine(sh.line))) continue;  // an opportunity is off the beaten path
      const own = internalRating.get(sh.slug);
      if (own == null || own < 4) continue;              // only when our review backs it
      if (!sh.hasRooms) continue;                        // must be able to finish the job here
      if (score < floor) continue;                       // still has to genuinely fit
      const esW = lang === "es";
      const ratingBit = sh.rating != null
        ? (esW ? `nuestra propia reseña Conga Line le da ${sh.rating}/5 — al nivel de las líneas grandes`
               : `our own Conga Line review puts her at ${sh.rating}/5 — right alongside the big lines`)
        : (esW ? "nuestra propia reseña la pone al nivel de las líneas grandes"
               : "our own review puts her right alongside the big lines");
      // The fare clause must match the line's actual market position — "smaller
      // fare" is true of Margaritaville, false of Celebrity. The matrix's own
      // price virtue decides (0 = value line, 2 = premium).
      const priceV = virtuesFor(matrix, sh.line, sh.shipClass)["price"] ?? 1;
      const fareBit = priceV <= 0.75
        ? (esW ? "con una tarifa más pequeña por la misma agua" : "at a smaller fare for the same water")
        : priceV >= 1.25
          ? (esW ? "un escalón más de pulido — y nuestra reseña dice que se lo gana" : "a step up in polish — and our review says she earns it")
          : (esW ? "y el valor se sostiene" : "and the value holds up");
      const why = esW
        ? `Quizá no la tenías en el radar: ${ratingBit}, ${fareBit}. Y encaja con lo que me contaste.`
        : `Probably not on your radar: ${ratingBit}, ${fareBit}. And she fits what you told me.`;
      worthALook = { ...sh, nextLevel, why };
      break;
    }

    const es = lang === "es";
    const reasonBits: string[] = [];
    if (personality.energy === "party") reasonBits.push(es ? "quieres la energía a tope" : "you want the energy turned up");
    if (personality.energy === "quiet") reasonBits.push(es ? "quieres espacio para respirar" : "you want room to breathe");
    if (personality.energy === "social") reasonBits.push(es ? "te gusta el punto medio — animado, sin caos" : "you like the middle gear — lively, not chaos");
    if (t("food") >= 2) reasonBits.push(es ? "la comida claramente te importa" : "the food clearly matters to you");
    if (t("active") >= 2) reasonBits.push(es ? "viniste a hacer cosas, no a mirarlas" : "you came to do things, not watch them");
    if (personality.crowds === "avoids") reasonBits.push(es ? "las multitudes te desgastan" : "crowds wear on you");
    if (personality.splurge === "cabin") reasonBits.push(es ? "la habitación te importa" : "the room matters to you");
    if (personality.splurge === "value") reasonBits.push(es ? "quieres que la tarifa haga el trabajo" : "you want the fare to do the work");
    const one = picks.length === 1;
    if (destination && destination !== "surprise" && picks.some((p) => p.regions.includes(destination))) {
      reasonBits.unshift(one
        ? (es ? "navega hacia donde tú vas" : "she sails where you're headed")
        : (es ? "navegan hacia donde tú vas" : "they sail where you're headed"));
    }
    const joiner = es ? " y " : " and ";
    const iPicked = one ? (es ? "La elegí" : "I picked her") : (es ? "Las elegí" : "I picked them");
    const reason = reasonBits.length
      ? `${iPicked} ${es ? "porque" : "because"} ${reasonBits.slice(0, 2).join(joiner)}.`
      : (es ? `${iPicked} para encajar con lo que me contaste.` : `${iPicked} to fit what you told me.`);

    return res.json({ picks, reason, worthALook });
  } catch (err) {
    logger.error({ err }, "cabins/suggest-ships failed");
    return res.status(500).json({ error: "Could not suggest ships" });
  }
});

// ── The recommendation ───────────────────────────────────────────────────────
router.post("/cabins/recommend", async (req: Request, res: Response) => {
  try {
    const { ship, lang: langRaw, ...raw } = (req.body ?? {}) as Record<string, unknown> & { ship?: string; lang?: string };
    if (!ship) return res.status(400).json({ error: "ship is required" });
    const lang: "en" | "es" = langRaw === "es" || req.query["lang"] === "es" ? "es" : "en";
    // ONE place decides what the answers mean. See lib/cabin-match.ts — the field
    // that broke this twice in two days is normalised here and nowhere else.
    const answers: Answers = normalizeAnswers(raw);

    const supabase = getSupabase();

    // Which ship's rows do we read? The ship's OWN. Before 2026-08-17 this was a
    // class-NAME lookup performed per request, and because class names are not
    // unique across lines ("Spirit" is both Carnival and Norwegian) five Carnival
    // ships were served Norwegian Spirit's cabins — zero of which exist on them.
    // Now every ship in the fleet owns its rows; `derived_from` says where the
    // reasoning came from, as data.
    const { data: shipRowData } = await supabase
      .from("cabin_ships")
      .select("slug,ship,line,class,category_counts,derived_from,numbering_verified,line_types")
      .eq("slug", ship).maybeSingle();
    const shipRow = shipRowData as {
      slug: string; ship: string; line: string; class: string;
      category_counts: Record<string, number> | null;
      derived_from: string | null; numbering_verified: boolean;
      line_types: string[] | null;
    } | null;
    if (!shipRow) return res.status(404).json({ error: "Unknown ship" });

    // Advice is class-level reasoning, reached by an explicit column — never by
    // matching a name at request time.
    const adviceSlug = shipRow.derived_from ?? shipRow.slug;
    type AdviceRow = { archetype_id: string; label: string; recommendations: unknown; steer_clear: unknown;
      label_es?: string | null; recommendations_es?: unknown; steer_clear_es?: unknown };
    const { data, error } = await supabase
      .from("cabin_advice")
      .select("archetype_id,label,recommendations,steer_clear,label_es,recommendations_es,steer_clear_es")
      .eq("ship_slug", adviceSlug);
    if (error) throw new Error(error.message);
    let rows = (data ?? []) as AdviceRow[];
    if (lang === "es") {
      rows = rows.map((r) => ({
        ...r,
        label: r.label_es || r.label,
        recommendations: r.recommendations_es ?? r.recommendations,
        steer_clear: r.steer_clear_es ?? r.steer_clear,
      }));
    }

    // One cached, paged read of this ship's grid serves everything below: the
    // facts on each pick, the authority on which cabin numbers are real, and the
    // steer-clear candidates. Reading it per-request (or unpaged) is what produced
    // the 1000-row truncation bugs found on 2026-08-17.
    const grid = await shipGrid(ship);
    const factByNum = new Map(grid.map((f) => [String(f.cabin_num), f]));
    const knownCabins = new Set(grid.map((f) => String(f.cabin_num)));

    // The obstruction research for this hull class — the moat layer. Absent until
    // cabin_context_zones is loaded, in which case the tool simply says less.
    const { data: zoneData } = await supabase
      .from("cabin_context_zones")
      .select("factor,decks,sections,sides,what,effect,what_es,effect_es,matters_to,severity,sign,confidence,source")
      .eq("rep_slug", adviceSlug);
    const zones = ((zoneData ?? []) as Record<string, unknown>[]).map((z) => ({
      factor: String(z["factor"]), decks: (z["decks"] as number[]) ?? [],
      sections: (z["sections"] as string[]) ?? [], sides: (z["sides"] as string[]) ?? [],
      what: (z["what"] as string) ?? null, effect: (z["effect"] as string) ?? null,
      whatEs: (z["what_es"] as string) ?? null, effectEs: (z["effect_es"] as string) ?? null,
      mattersTo: (z["matters_to"] as string) ?? null,
      // missing => "penalty", so an un-reviewed zone behaves exactly as it did before 0025.
      sign: (z["sign"] as "penalty" | "benefit" | "neutral") ?? "penalty",
      severity: z["severity"], confidence: z["confidence"], source: String(z["source"]),
    })) as Zone[];

    const chosen = pickArchetype(rows, answers);
    const advice = rows.find((r) => r.archetype_id === chosen) ?? rows[0] ?? null;

    // THE CANDIDATES ARE THE WHOLE SHIP.
    //
    // Until 2026-08-18 they were the union of the twelve archetypes' pre-written
    // picks — roughly 45 cabins out of 2,000. That made the stored corpus a
    // gate on what a visitor could ever be shown: Norwegian Aqua has 140 ocean-view
    // cabins and exactly 11 were reachable, and a room could be mislabelled for
    // months without the recommendations revealing it. Mark's call: "no preset
    // lists for the advisor — every cabin needs to be accurate, if nothing else
    // because the user can ask about it by entering the room number."
    //
    // So every room on the hull competes, ranked on the obstruction research
    // (selectCabins), and the pre-written reasoning is attached where it happens
    // to exist — as wording and a tie-break, never as eligibility. Wording for
    // everything else comes from reasonLive, which already writes from cabin
    // facts rather than reciting a stored line.
    const storedByCabin = new Map<string, { archetypeId: string; rank: number | null; reason: string | null }>();
    for (const r of rows) {
      for (const rec of (r.recommendations ?? []) as { cabin: number | string; rank?: number; reason?: string }[]) {
        const num = String(rec.cabin);
        // The winner's own reasoning wins the slot; otherwise first writer keeps it.
        if (!storedByCabin.has(num) || r.archetype_id === chosen) {
          storedByCabin.set(num, { archetypeId: r.archetype_id, rank: rec.rank ?? null, reason: rec.reason ?? null });
        }
      }
    }
    const pool: PoolCabin[] = grid.map((f) => {
      const num = String(f.cabin_num);
      const stored = storedByCabin.get(num);
      return {
        cabin: num,
        archetypeId: stored?.archetypeId ?? null,
        rank: stored?.rank ?? null,
        reason: stored?.reason ?? null,
        category: f.category ?? null,
        deck: f.deck ?? null, section: f.section ?? null, side: f.side ?? null,
        aboveKind: f.above_kind ?? null, belowKind: f.below_kind ?? null,
        noiseNearby: f.noise_nearby ?? null,
        realOcean: f.real_ocean ?? null, obstruction: f.obstruction ?? null,
      };
    });

    /**
     * "Show me More Options" (Mark, 2026-08-21). The visitor gets the same
     * reasoning over the same pool, just a longer shortlist — this is not a
     * different algorithm, so a second screen can never contradict the first.
     * The diversity pass in rank() still applies, so a long list stays a list of
     * genuinely different rooms rather than one deck enumerated.
     */
    const more = raw["more"] === true || raw["more"] === "1" || req.query["more"] === "1";
    const selection = selectCabins({
      pool, chosenArchetypeId: chosen, answers, zones, knownCabins,
      limit: more ? 24 : 5,
      inventory: shipTypeInventory(shipRow.category_counts),
      // Only the line's own account of what it sells lets us speak for a ship in
      // the negative. Everywhere else an absence is ours, not the ship's — see
      // the outcome block in cabin-match.ts.
      lineTypes: (shipRow.line_types as CabinType[] | null) ?? null,
    });
    if (selection.dropped.length) {
      // The advice corpus is model-written, so it names cabins that do not exist
      // (19 of 9,211 fleet-wide). They are dropped, not shown — and logged, because
      // a rising count means the corpus needs regenerating.
      logger.warn({ ship, dropped: selection.dropped }, "cabin concierge: advice named cabins not on this ship");
    }

    let picks = selection.picks.map((p) => ({
      cabin: p.cabin, rank: p.rank ?? undefined, reason: p.reason ?? undefined,
      facts: factByNum.get(p.cabin) ?? null,
    }));

    // ── Steer-clear, REBUILT from facts (2026-08-17) ──────────────────────────
    // The stored corpus is deliberately NOT used. It was model-authored per
    // archetype with no positional data: 370 of 540 sets warned about a
    // different cabin type than they recommended, and 346 of 1,079 positional
    // claims contradicted the grid. Instead we read the cabins the research
    // actually flags, on the decks its zones touch, of the type this visitor
    // asked for — so every fact in the warning is one we hold a source for.
    let steerClear: { cabin?: string; area?: string; reason?: string }[] = [];
    const decks = new Set(zoneDecks(zones));
    if (decks.size) {
      const candidates: SteerCandidate[] = grid
        .filter((c) => c.deck != null && decks.has(c.deck))
        .map((c) => ({
        cabin: String(c.cabin_num), archetypeId: "", rank: null, category: c.category,
        deck: c.deck, section: c.section, side: c.side,
      }));
      // Warn about the rooms actually on screen. When the requested type could not
      // be served (a ship with no balconies), the picks are substitutes and the
      // skip-list must describe THOSE, not the type that does not exist here.
      const servedType = selection.outcome === "exact"
        ? answers.room
        : classifyCategory(selection.picks[0]?.category ?? null);
      const entries = buildSteerClear({
        candidates, picked: selection.picks.map((p) => p.cabin), answers, zones, lang, servedType,
      });
      // The facts are fixed here; the model only supplies the wording, and only
      // if it clears the gate. severity/source stay internal (Mark, 8/16).
      const facts: SteerFacts[] = entries.map((e) => ({
        cabin: e.cabin, deck: e.deck, section: e.section, category: e.category,
        factor: e.factor, severity: e.severity, what: e.reason.replace(/^[^.]*\.\s*/, ""),
      }));
      const written = await writeSteerLines(shipRow.ship ?? ship, facts, answers, lang);
      steerClear = entries.map((e) => ({ cabin: e.cabin, reason: written.get(e.cabin) ?? e.reason }));
    }

    const live = picks.length
      ? await reasonLive(shipRow.ship ?? ship, answers, picks, steerClear, lang)
      : null;
    if (live) {
      const byCabin = new Map(live.recommendations.map((r) => [String(r.cabin), r]));
      picks = picks.map((p) => {
        const lr = byCabin.get(p.cabin);
        return lr ? { ...p, hook: scrubBanned(lr.hook), reason: scrubBanned(lr.reason) || p.reason } : p;
      });
      // The model does NOT touch the steer-clear list any more. Its reasons are
      // now composed from the grid's own position and the research zone's own
      // sourced wording, and letting the model restate them is exactly how the
      // old list came to contradict the grid on a third of its positional claims
      // (346 of 1,079, measured 2026-08-17). It writes the room cards; the
      // warnings are facts we can point at a source for.
    }

    // What sits outside the window, per cabin — Mark's two rules are enforced in
    // lib/cabin-match.ts: never blame the line, never render confidence.
    const withZones = picks.map((p) => {
      const f = p.facts;
      const hits = f ? zonesForCabin(
        { deck: f.deck, section: f.section, side: f.side, category: f.category }, zones) : [];
      return {
        ...p,
        heads_up: hits.slice(0, 2).map((z) => ({ what: z.what, effect: z.effect, severity: z.severity })),
      };
    });

    const { count: geomCount } = await supabase
      .from("cabins").select("cabin_num", { count: "exact", head: true })
      .eq("ship_slug", ship).not("x", "is", null);

    return res.json({
      ship: { ship: shipRow.ship, line: shipRow.line, class: shipRow.class, slug: ship },
      archetype: advice ? { id: advice.archetype_id, label: advice.label } : null,
      picks: withZones,
      steerClear,
      // Never a silent substitution: when we could not serve the type asked for,
      // the visitor is told why, in Mark's voice.
      note: selectionNote(selection, shipRow.ship ?? ship, lang),
      outcome: selection.outcome,
      // An honest flag for copy: this hull's numbering was inherited from a sister
      // and has not been confirmed. Never present a copy as verified.
      numberingVerified: shipRow.numbering_verified,
      reasonedLive: !!live,
      hasDeckMap: (geomCount ?? 0) > 0,
    });
  } catch (err) {
    logger.error({ err }, "cabins/recommend failed");
    return res.status(500).json({ error: "Could not build a recommendation" });
  }
});

export default router;
