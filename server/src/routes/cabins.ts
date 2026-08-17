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
  picks: { cabin: string; reason?: string; facts: Record<string, unknown> | null }[],
  steerClear: { cabin?: string; area?: string; reason?: string }[],
  lang: "en" | "es" = "en",
): Promise<LiveOut | null> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || !picks.length) return null;

  const key = JSON.stringify([shipName, answers.party, answers.room, answers.priority, !!answers.motion, lang]);
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
    const hasWindow = !interior;

    // INTERNAL confidence only — never returned to the client.
    let confidence = 0;
    const lines: string[] = [];
    let headline: string;

    if (interior) {
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

function kebab(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function loadFleetJson(): { lines: Record<string, { classes: Record<string, { ships: string[] }> }> } | null {
  for (const p of [
    join(process.cwd(), "..", "cabin-advisor", "fleet.json"),
    join(process.cwd(), "cabin-advisor", "fleet.json"),
  ]) {
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { /* next */ }
  }
  return null;
}

async function buildFleet(includeUnpublishedRatings: boolean): Promise<{ ships: FleetShip[]; internalRating: Map<string, number> }> {
  const fleet = loadFleetJson();
  const supabase = getSupabase();
  const { data: reps } = await supabase.from("cabin_ships").select("slug,ship,line,class");
  const { data: adviceRows } = await supabase.from("cabin_advice").select("ship_slug");
  const adviceSlugs = new Set((adviceRows ?? []).map((r: { ship_slug: string }) => r.ship_slug));

  // class name → rep slug (class names are unique enough across the harvest;
  // where two lines reuse a name, the line check below disambiguates)
  const repByClass = new Map<string, { slug: string; line: string }>();
  for (const r of (reps ?? []) as { slug: string; line: string; class: string }[]) {
    repByClass.set(r.class.toLowerCase(), { slug: r.slug, line: r.line });
  }

  const { data: depRows } = await supabase.from("ship_deployments").select("ship_slug,region");
  const regionsBySlug = new Map<string, string[]>();
  for (const d of (depRows ?? []) as { ship_slug: string; region: string }[]) {
    const arr = regionsBySlug.get(d.ship_slug) ?? [];
    if (!arr.includes(d.region)) arr.push(d.region);
    regionsBySlug.set(d.ship_slug, arr);
  }

  const ratingQuery = supabase.from("conga_line_ratings").select("ship_slug,rating,status,comment_status");
  const { data: ratingRows } = await ratingQuery;
  const publicRating = new Map<string, number>();
  const internalRating = new Map<string, number>();
  for (const r of (ratingRows ?? []) as { ship_slug: string; rating: number | null; status: string; comment_status: string }[]) {
    if (r.rating == null) continue;
    if (r.comment_status === "approved") internalRating.set(r.ship_slug, Number(r.rating));
    if (r.status === "published" && r.comment_status === "approved") publicRating.set(r.ship_slug, Number(r.rating));
  }

  const ships: FleetShip[] = [];
  if (fleet?.lines) {
    for (const [lineName, line] of Object.entries(fleet.lines)) {
      for (const [className, klass] of Object.entries(line.classes ?? {})) {
        const rep = repByClass.get(className.toLowerCase()) ?? null;
        for (const raw of klass.ships ?? []) {
          if (/\(on order\)/i.test(raw)) continue;      // not sailing yet
          const ship = raw.replace(/\s*\((?:2026|on order)\)\s*/gi, "").trim();
          const slug = kebab(ship);
          ships.push({
            ship, slug, line: lineName, shipClass: className,
            repSlug: rep?.slug ?? null,
            hasRooms: rep ? adviceSlugs.has(rep.slug) : false,
            rating: publicRating.get(slug) ?? null,
            regions: regionsBySlug.get(slug) ?? [],
          });
        }
      }
    }
  }
  return { ships, internalRating };
}

router.get("/cabins/fleet", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  try {
    const { ships } = await buildFleet(false);
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
    const { ships, internalRating } = await buildFleet(true);

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
    const { ship, lang: langRaw, ...answers } = (req.body ?? {}) as Answers & { ship?: string; lang?: string };
    if (!ship) return res.status(400).json({ error: "ship is required" });
    const lang: "en" | "es" = langRaw === "es" || req.query["lang"] === "es" ? "es" : "en";

    const supabase = getSupabase();
    type AdviceRow = { archetype_id: string; label: string; recommendations: unknown; steer_clear: unknown;
      label_es?: string | null; recommendations_es?: unknown; steer_clear_es?: unknown };
    const { data, error } = await supabase
      .from("cabin_advice")
      .select("archetype_id,label,recommendations,steer_clear,label_es,recommendations_es,steer_clear_es")
      .eq("ship_slug", ship);
    let rows = (data ?? []) as AdviceRow[];
    // ES: the translated corpus becomes the stored base (grounding + fallback);
    // rows missing a translation keep English rather than serving nothing.
    if (lang === "es") {
      rows = rows.map((r) => ({
        ...r,
        label: r.label_es || r.label,
        recommendations: r.recommendations_es ?? r.recommendations,
        steer_clear: r.steer_clear_es ?? r.steer_clear,
      }));
    }
    if (error) throw new Error(error.message);
    if (!rows.length) return res.status(404).json({ error: "No advice for that ship yet" });

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

    const { data: shipRowData } = await supabase
      .from("cabin_ships").select("ship,line,class").eq("slug", ship).maybeSingle();
    const shipRow = shipRowData as { ship: string; line: string; class: string } | null;

    // Whether this ship's grid carries geometry — gates the "show me where it
    // sits" deck view in the UI (only claim what we can actually draw).
    const { count: geomCount } = await supabase
      .from("cabins")
      .select("id", { count: "exact", head: true })
      .eq("ship_slug", ship)
      .not("x", "is", null);

    // Live pass: rewrite hook + reason for THIS visitor's answers. Stored text
    // is the grounding and the fallback — the response never blocks on failure.
    let steerClear = (advice.steer_clear ?? []) as { cabin?: string; area?: string; reason?: string }[];
    const live = await reasonLive((shipRow?.ship as string) ?? ship, answers, picks, steerClear, lang);
    if (live) {
      const byCabin = new Map(live.recommendations.map((r) => [String(r.cabin), r]));
      picks = picks.map((p) => {
        const lr = byCabin.get(p.cabin);
        return lr ? { ...p, hook: scrubBanned(lr.hook), reason: scrubBanned(lr.reason) || p.reason } : p;
      });
      if (Array.isArray(live.steerClear) && live.steerClear.length) {
        steerClear = live.steerClear.map((sc) => ({ ...sc, reason: scrubBanned(sc.reason) }));
      }
    }

    return res.json({
      ship: { ...(shipRow ?? { ship }), slug: ship },
      archetype: { id: advice.archetype_id, label: advice.label },
      picks,
      steerClear,
      reasonedLive: !!live,
      hasDeckMap: (geomCount ?? 0) > 0,
    });
  } catch (err) {
    logger.error({ err }, "cabins/recommend failed");
    return res.status(500).json({ error: "Could not build a recommendation" });
  }
});

export default router;
