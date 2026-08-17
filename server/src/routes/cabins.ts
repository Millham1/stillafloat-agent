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
import {
  normalizeAnswers, pickArchetype, selectCabins, selectionNote,
  shipTypeInventory, zonesForCabin, classifyCategory,
  type Answers, type PoolCabin, type Zone,
} from "../lib/cabin-match";

const router: IRouter = Router();

interface CabinRow {
  cabin_num: string; deck: number | null; category: string | null; section: string | null;
  side: string | null; view: string | null; sleeps: number | null;
  obstructed: boolean | null; obstruction: string | null; note: string | null;
  x: string | number | null;
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
  const key = JSON.stringify([
    shipName, answers.party, answers.room, answers.priority, answers.budget, answers.seasick, lang,
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
    const { data: rows, error } = await supabase
      .from("cabins")
      .select("cabin_num,deck,category,section,side,view,sleeps,obstructed,obstruction,note,x")
      .eq("ship_slug", ship);
    if (error) throw new Error(error.message);
    const all = (rows ?? []) as CabinRow[];
    const hit = all.find((c) => String(c.cabin_num).toUpperCase().replace(/\s+/g, "") === raw);

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
      if (hit.obstruction) lines.push(String(hit.obstruction));
      lines.push(es
        ? "Sigue siendo luz natural y aire — mucha gente lo reserva a propósito por el precio. Solo conviene saberlo antes de subir a bordo, no después."
        : "You still get natural light and air, and plenty of people book these on purpose for the price. It's just worth knowing before you board rather than after.");
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
        confidence = 0.75;
        headline = es ? "Nada indica un problema de vista" : "Nothing here points to a view problem";
        lines.push(es
          ? "Con lo que tenemos de este barco, nada sugiere que algo bloquee tu ventana."
          : "From what we have on this ship, nothing suggests anything is blocking your window.");
      }
    }

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
        : "Want me to look at whether there's a better cabin on this same sailing?",
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
              ? "vale saber que este barco tiene una experiencia de siguiente nivel si la quieres"
              : "worth knowing this ship has a next-level experience if you want it" } : null;
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
    if (destination && destination !== "surprise" && picks.some((p) => p.regions.includes(destination))) {
      reasonBits.unshift(es ? "navegan hacia donde tú vas" : "they sail where you're headed");
    }
    const joiner = es ? " y " : " and ";
    const reason = reasonBits.length
      ? (es ? `Elegidos porque ${reasonBits.slice(0, 2).join(joiner)}.` : `Picked because ${reasonBits.slice(0, 2).join(joiner)}.`)
      : (es ? "Elegidos según cómo respondiste." : "Picked to fit how you answered.");

    return res.json({ picks, reason });
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
      .select("slug,ship,line,class,category_counts,derived_from,numbering_verified")
      .eq("slug", ship).maybeSingle();
    const shipRow = shipRowData as {
      slug: string; ship: string; line: string; class: string;
      category_counts: Record<string, number> | null;
      derived_from: string | null; numbering_verified: boolean;
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

    // Every cabin number any archetype names for this ship, plus the ones it
    // would steer people away from. This is what we look up — NOT the whole grid.
    //
    // Reading the full grid here is wrong twice over: PostgREST caps a response at
    // 1000 rows (`.limit()` does not raise that cap), and 121 of 138 ships carry
    // more than 1000 cabins — so `knownCabins` would be silently incomplete and
    // the phantom guard would start discarding REAL cabins and logging them as
    // invented. Caught in review 2026-08-17. Asking for the ~100 numbers we
    // actually care about is both correct and a smaller query than the original.
    const wanted = new Set<string>();
    for (const r of rows) {
      for (const rec of (r.recommendations ?? []) as { cabin: number | string }[]) wanted.add(String(rec.cabin));
      for (const sc of (r.steer_clear ?? []) as { cabin?: string }[]) if (sc?.cabin) wanted.add(String(sc.cabin));
    }
    const nums = [...wanted];
    const { data: gridData } = nums.length
      ? await supabase
          .from("cabins")
          .select("cabin_num,deck,category,section,side,view,sleeps,obstructed,obstruction,tour")
          .eq("ship_slug", ship)
          .in("cabin_num", nums)
      : { data: [] as unknown[] };
    const grid = (gridData ?? []) as (Omit<CabinRow, "x"> & { tour?: string | null })[];
    const factByNum = new Map(grid.map((f) => [String(f.cabin_num), f]));
    // A cabin is real for this ship if, and only if, the database returned it.
    const knownCabins = new Set(grid.map((f) => String(f.cabin_num)));
    if (nums.length > 900) {
      // Still under the 1000 cap today (largest pool is ~100), but if the advice
      // corpus ever grows past it this read would truncate the same way.
      logger.warn({ ship, wanted: nums.length }, "cabin concierge: pool approaching the PostgREST row cap");
    }

    // The obstruction research for this hull class — the moat layer. Absent until
    // cabin_context_zones is loaded, in which case the tool simply says less.
    const { data: zoneData } = await supabase
      .from("cabin_context_zones")
      .select("factor,decks,sections,sides,what,effect,matters_to,severity,confidence,source")
      .eq("rep_slug", adviceSlug);
    const zones = ((zoneData ?? []) as Record<string, unknown>[]).map((z) => ({
      factor: String(z["factor"]), decks: (z["decks"] as number[]) ?? [],
      sections: (z["sections"] as string[]) ?? [], sides: (z["sides"] as string[]) ?? [],
      what: (z["what"] as string) ?? null, effect: (z["effect"] as string) ?? null,
      mattersTo: (z["matters_to"] as string) ?? null,
      severity: z["severity"], confidence: z["confidence"], source: String(z["source"]),
    })) as Zone[];

    const chosen = pickArchetype(rows, answers);
    const advice = rows.find((r) => r.archetype_id === chosen) ?? rows[0] ?? null;

    // THE POOL IS EVERY ARCHETYPE'S PICKS, not just the winner's. The stored picks
    // are themselves mixed-type — the balcony archetype recommends 208 balcony
    // cabins and 50 ocean-view ones — so filtering only the winner's list could
    // leave a balcony-asker with nothing of the right kind and no honest way to
    // say so. Pooling first, filtering second, is what makes the type guarantee real.
    const pool: PoolCabin[] = [];
    for (const r of rows) {
      for (const rec of (r.recommendations ?? []) as { cabin: number | string; rank?: number; reason?: string }[]) {
        const num = String(rec.cabin);
        const f = factByNum.get(num);
        pool.push({
          cabin: num, rank: rec.rank ?? null, reason: rec.reason ?? null,
          archetypeId: r.archetype_id, category: f?.category ?? null,
          deck: f?.deck ?? null, section: f?.section ?? null, side: f?.side ?? null,
        });
      }
    }

    const selection = selectCabins({
      pool, chosenArchetypeId: chosen, answers, zones, knownCabins,
      inventory: shipTypeInventory(shipRow.category_counts),
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

    // Steer-clear: cabin numbers come from the grid, never from a model. The live
    // pass may rewrite the REASONS; it may not introduce or rename a cabin.
    const storedSteer = ((advice?.steer_clear ?? []) as { cabin?: string; area?: string; reason?: string }[])
      .filter((sc) => !sc.cabin || knownCabins.has(String(sc.cabin)));
    let steerClear = storedSteer;

    const live = picks.length
      ? await reasonLive(shipRow.ship ?? ship, answers, picks, steerClear, lang)
      : null;
    if (live) {
      const byCabin = new Map(live.recommendations.map((r) => [String(r.cabin), r]));
      picks = picks.map((p) => {
        const lr = byCabin.get(p.cabin);
        return lr ? { ...p, hook: scrubBanned(lr.hook), reason: scrubBanned(lr.reason) || p.reason } : p;
      });
      if (Array.isArray(live.steerClear) && live.steerClear.length) {
        // Match the model's rewritten reasons back onto OUR cabins by number. Anything
        // it invented is discarded; anything it dropped keeps its stored reason. Before
        // this the returned array replaced ours wholesale, so a hallucinated cabin number
        // went straight to the visitor as "a room I'd skip".
        const byNum = new Map(live.steerClear.filter((sc) => sc.cabin).map((sc) => [String(sc.cabin), sc]));
        steerClear = storedSteer.map((sc) => {
          const lr = sc.cabin ? byNum.get(String(sc.cabin)) : undefined;
          return lr ? { ...sc, reason: scrubBanned(lr.reason) ?? sc.reason } : sc;
        });
      }
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
