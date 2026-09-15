#!/usr/bin/env node
// Cabin Advisor — advice generator (the "cliffnotes" batch job).
//
// For each traveler archetype, ask the AI (in Mark's voice) to reason the cabin
// recommendations for a ship, once. Store the result. The site then serves these
// pre-generated write-ups for free — no LLM call when a customer searches.
//
// Run: node generate-advice.mjs [ship-slug]     (default: wonder-of-the-seas)
// Env: ANTHROPIC_API_KEY (Haiku). The OpenAI fallback was removed 2026-09-09 when
// the service dropped OpenAI entirely (its key had been rejected since 09-05).
//
// Cost model: ~a dollar for a whole fleet, ONE TIME. Re-run only when cabin data
// or the voice guide changes. See README.md.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactCandidates, CostLedger, estimateTokens, projectCost } from "./advice-prompt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ship = process.argv[2] || "wonder-of-the-seas";
// --only=a,b regenerates just those archetypes and merges them into the existing
// advice file, so one weak archetype can be redone without re-rolling (and re-translating)
// the eleven that were already reviewed. translate-advice.mjs takes the same flag.
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
// --estimate prints what the run would cost and exits before any call is made (Mark,
// 2026-09-14: no model run without a dollar figure first). Needs no API key.
const ESTIMATE = process.argv.includes("--estimate");
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5";
const MAX_OUTPUT = 1600;
const ATTEMPTS = 3;

const voice = await readFile(join(HERE, "voice-guide.md"), "utf8");
// Use only the prompt body (after the '---' separator) as the system prompt.
const VOICE = voice.includes("\n---\n") ? voice.split("\n---\n").slice(1).join("\n---\n").trim() : voice.trim();
// Input: the curated fixture if one exists (the 23-cabin Wonder test case the engine was
// built against), otherwise the REAL full grid. FULL_GRID=1 forces the real grid so the
// engine can be tested at ship scale rather than fixture scale.
const curatedPath = join(HERE, `data/cabins/${ship}.json`);
const fullPath = join(HERE, `data/cabins/${ship}-full.json`);
const useFull = process.env.FULL_GRID === "1" || !existsSync(curatedPath);
const shipData = JSON.parse(await readFile(useFull ? fullPath : curatedPath, "utf8"));
if (useFull) console.log(`(using the FULL grid: ${shipData.cabins.length} cabins)`);
const { archetypes } = JSON.parse(await readFile(join(HERE, "data/archetypes.json"), "utf8"));

// Trim cabin objects to what the model needs to reason (keep tokens down).
const cabins = shipData.cabins.map((c) => ({
  id: c.id ?? c.num, deck: c.deck, kind: c.category, view: c.view, realOcean: c.realOcean,
  hump: !!c.hump, steady: c.steady, obstruction: c.obstruction, flaggedByLine: c.flaggedByLine,
  sleeps: c.sleeps, position: c.position ?? c.section, side: c.side, note: c.note,
  obstructedFlag: c.obstructed,
}));

// Norwegian's Studios are the one cabin kind whose meaning is not in its name: a room sized
// and priced for ONE guest, with no single supplement, opening onto a keycard-only Studio
// Lounge. Without this line the model treated them as small insides and sent a budget solo
// to an oceanview (Aura, 2026-09-14). Stated only when the ship has them.
const MOTION_ASKED_RE = /\b(queasy|seasick|motion|steady|steadiest|stomach|sway|rough seas)\b/i;
const hasStudios = cabins.some((c) => /studio/i.test(c.kind ?? ""));
// The Haven is Norwegian's suite complex; the category name does not say "suite", and on
// 2026-09-14 the anniversary couple asking for "the suite perks" was given six balconies.
const hasHaven = cabins.some((c) => /\bhaven\b/i.test(c.kind ?? ""));
const HAVEN_FACT = hasHaven
  ? `\nHouse fact: cabins of kind "The Haven" are Norwegian's suites — the private keycard-only Haven complex with its own lounge, restaurant, sundeck and butler/concierge service. They ARE "the suite perks"; a "Balcony" is not a suite.\n`
  : "";
const STUDIO_FACT = hasStudios
  ? `\nHouse fact: cabins of kind "Studio" are Norwegian's solo staterooms — sized and priced for one guest with no single supplement, with access to the private Studio Lounge. For a solo traveler watching cost they are the first cabins to weigh, and you say so plainly; for two people they are not an option.\n`
  : "";

// Facts the model is not handed cannot be sold. A traveler who never raised motion gets the
// cabins WITHOUT the steadiness fields: with `steady` on every Aura room, three re-rolls in a
// row still pitched budget oceanviews on "gentle sway" (2026-09-14). The check below stays as
// the backstop.
// The grid is sent COMPACTED (advice-prompt.mjs): rooms that share every shown attribute
// appear once with their cabin numbers listed, so every room stays choosable at a fraction
// of the tokens; Studios are removed for any party that cannot book one, and that is said.
const candidatesFor = (a) => compactCandidates(cabins, { motionAsked: MOTION_ASKED_RE.test(a.traveler), party: a.match?.party ?? "two" });

function userPrompt(a) {
  const { rows } = candidatesFor(a);
  return `Traveler: ${a.traveler}. Ship: ${shipData.ship}.${STUDIO_FACT}${HAVEN_FACT}

Candidate cabins (all real, with the quirks that matter). Rooms that share every listed attribute are grouped: each entry's "cabins" are the individual cabin numbers in that group, and you recommend SPECIFIC cabin numbers from those lists.
${JSON.stringify(rows)}

Recommend the best 4-6 cabins for THIS traveler, ranked (rank 1 = book first). Each reason must be distinct and tied to what they told you; where two cabins are nearly identical, say so and give the honest tie-breaker. Then list 2-3 cabins you would steer them clear of, with the honest reason.

For each recommendation also write "hook": a short headline (5-10 words) that names the room TYPE and ties it to what THIS traveler wants — the reason-to-care, not a spec. Like: "Boardwalk balcony to watch the action from your own roost" or "An ocean balcony for your quiet morning coffee". Never "Ocean View Balcony on Deck 8" — that is a brochure line, not you. Every hook must be different in wording AND structure from the others; no template reuse.

Fidelity rules:
- Speak ONLY to concerns this traveler actually told you. If they never mentioned seasickness, do not bring up motion, steadiness or stomachs. If they never mentioned noise, don't lead with quiet.
- The voice example in your instructions is a TONE reference, not content — do not reuse its phrases ("tummy troubles", "the bonus is waking up") unless this traveler genuinely has that concern.
- Vary your openings. Do not start every reason with "Cabin NNNN is..."
- Where a cabin sits comes ONLY from its "position" (forward / mid / aft) and "side" (port / starboard / center) fields. If a cabin has no such field, do not say where on the ship it is — never infer it from the cabin number.
- Position is a fact about a room, not a reason to pick it. Rank by what THIS traveler asked for. Midship and steadiness only matter to someone who raised motion or seasickness; for anyone else, do not choose rooms for being midship and do not mention motion at all.

Respond with ONLY a JSON object:
{"recommendations":[{"cabin":<number>,"rank":<number>,"hook":"<5-10 words>","reason":"<2-4 sentences in your voice>"}],"steerClear":[{"cabin":<number>,"reason":"<1-2 sentences>"}]}`;
}

function parse(text) {
  const m = text && text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model response");
  return scrub(JSON.parse(m[0]));
}

// Mark's banned-words rule for anything published in his voice (2026-09-14: three
// "actually"s reached the Aura preview). The word is filler in every sentence the model
// writes it into, so it is removed rather than the archetype re-rolled; the surrounding
// spacing and capitalisation are repaired. Extend BANNED as the list grows.
const BANNED = [/\b[Aa]ctually,?\s*/g];
export function scrubText(t) {
  if (typeof t !== "string") return t;
  let out = t;
  for (const re of BANNED) out = out.replace(re, "");
  out = out.replace(/\s{2,}/g, " ").replace(/\(\s+/g, "(").replace(/\s+([,.;:!?])/g, "$1").trim();
  // a sentence that lost its first word gets its capital back
  return out.replace(/(^|[.!?]\s+)([a-z])/g, (_, a, b) => a + b.toUpperCase());
}
function scrub(o) {
  for (const r of o.recommendations ?? []) { r.hook = scrubText(r.hook); r.reason = scrubText(r.reason); }
  for (const s of o.steerClear ?? []) s.reason = scrubText(s.reason);
  return o;
}

async function viaClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_OUTPUT, system: VOICE, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(40000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  if (j.stop_reason === "refusal") throw Object.assign(new Error("Anthropic refusal"), { usage: j.usage, model: j.model });
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return { out: parse(text), model: j.model, usage: j.usage };
  } catch (e) {
    throw Object.assign(e, { usage: j.usage, model: j.model }); // a bad reply still cost tokens
  }
}
// POSITION CLAIMS MUST MATCH THE GRID. On Norwegian Aura (2026-09-14) the grid carried no
// section or side, and the model called two forward inside cabins "starboard aft" — it
// guessed from the numbers. A recommendation that names its own cabin's end of the ship or
// side is checked against that cabin's section/side; a contradiction re-rolls the archetype
// once, and a second contradiction is printed so it never ships unseen.
const byId = new Map(cabins.map((c) => [String(c.id), c]));
const SECTION_WORDS = [["forward", /\b(forward|bow|front of the ship)\b/i], ["aft", /\b(aft|stern|back of the ship|rear)\b/i], ["mid", /\b(a?mid-?ships?|mid-deck|middle of the ship|in the middle|dead cent(er|re)|cent(er|re)d? fore)\b/i]];
// Phrases that name ends of the ship as a CONTRAST or a relative step, not as where the cabin
// is: "centered fore-to-aft", "costs less than one forward or aft", "a couple doors forward".
const CONTRAST = /\b(fore[- ]to[- ]aft|forward (?:or|and) aft|aft (?:or|and) forward|bow (?:or|and|to) stern|(?:doors?|cabins?|rooms?|steps?) (?:forward|aft))\b/gi;
const SIDE_WORDS = [["port", /\bport(?:[- ]side)?\b(?! (of call|stop|city|day|talk))/i], ["starboard", /\bstarboard\b/i]];
export function positionProblems(out) {
  const probs = [];
  const check = (cabin, text) => {
    const c = byId.get(String(cabin));
    if (!c || !text) return;
    // Only the sentence(s) naming this cabin, or the whole reason when no other cabin number appears.
    const others = (text.match(/\b\d{4,5}\b/g) ?? []).filter((n) => n !== String(cabin));
    const scope = (others.length ? text.split(/(?<=[.!?])\s+/).filter((sen) => sen.includes(String(cabin))).join(" ") : text).replace(CONTRAST, " ");
    // A sentence that names the RIGHT place may also name others by way of contrast
    // ("midship, away from the bow and stern"), so it is only a contradiction when the
    // cabin's own section/side is never named and a different one is.
    const sec = String(c.position ?? "").toLowerCase().replace("midship", "mid");
    const secRe = SECTION_WORDS.find(([w]) => w === sec)?.[1];
    if (sec && secRe && !secRe.test(scope)) for (const [word, re] of SECTION_WORDS) if (word !== sec && re.test(scope)) probs.push(`${cabin} is ${sec}, text says ${word}`);
    const side = String(c.side ?? "").toLowerCase();
    const sideRe = SIDE_WORDS.find(([w]) => w === side)?.[1];
    if (sideRe && !sideRe.test(scope)) for (const [word, re] of SIDE_WORDS) if (word !== side && re.test(scope)) probs.push(`${cabin} is ${side}, text says ${word}`);
  };
  for (const r of out.recommendations ?? []) check(r.cabin, `${r.hook ?? ""}. ${r.reason ?? ""}`);
  for (const r of out.steerClear ?? []) check(r.cabin, r.reason ?? "");
  return probs;
}

// FIDELITY: MOTION ONLY FOR THOSE WHO RAISED IT. The prompt already says so; on 2026-09-14 the
// model still sold Haven suites and budget oceanviews on "gentle sway". A traveler whose own
// words never touch motion gets an output with no motion words, or a re-roll. Separately, one
// claim is simply false and is never allowed for anyone: higher decks do NOT move less.
const MOTION_ASKED = MOTION_ASKED_RE;
const MOTION_WORDS = /\b(motion|seasick\w*|queasy|steady|steadiest|steadier|stability|stable|rocking|rocks?|pitch(?:ing)?|roll(?:ing)?|sway\w*|stomach)\b/i;
const FALSE_MOTION = /\b(higher|upper|top)\b[^.!?]{0,60}\b(less|reduces?|minimi[sz]es?|lower)\b[^.!?]{0,20}\b(motion|sway|rocking|movement)\b|\b(less|reduced)\s+(motion|sway|rocking)\b[^.!?]{0,40}\b(higher|upper)\s+deck/i;
export function fidelityProblems(out, traveler) {
  const probs = [];
  const asked = MOTION_ASKED.test(traveler ?? "");
  for (const r of [...(out.recommendations ?? []), ...(out.steerClear ?? [])]) {
    const text = `${r.hook ?? ""}. ${r.reason ?? ""}`;
    if (FALSE_MOTION.test(text)) probs.push(`${r.cabin}: says higher decks move less (false)`);
    else if (!asked && MOTION_WORDS.test(text)) probs.push(`${r.cabin}: talks motion ("${text.match(MOTION_WORDS)[0]}") to a traveler who never raised it`);
  }
  return probs;
}

const ledger = new CostLedger();
async function generateOne(prompt, traveler) {
  // Never throws up the stack: a failed archetype is skipped and counted. EVERY attempt —
  // rejected by the checks, unparseable, refused — goes on the ledger; only a request the
  // API rejected outright (no usage returned) is free.
  if (!AKEY) return null;
  let spent = 0, calls = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await viaClaude(prompt);
      const probs = [...positionProblems(res.out), ...fidelityProblems(res.out, traveler)];
      calls += 1; spent += ledger.add(res.usage, res.model, !probs.length);
      if (!probs.length) return { ...res, cost: spent, calls };
      console.warn(`  check failed (attempt ${attempt}): ${probs.join("; ")}`);
      if (attempt === ATTEMPTS) { res.out.qcWarnings = probs; return { ...res, cost: spent, calls }; }
    } catch (e) {
      if (e.usage) { calls += 1; spent += ledger.add(e.usage, e.model ?? MODEL, false); }
      console.warn("  Haiku failed:", e.message);
    }
  }
  return null;
}

const selected = archetypes.filter((a) => !ONLY.length || ONLY.includes(a.id));
const systemTokens = estimateTokens(VOICE);
if (ESTIMATE) {
  console.log(`Estimate for ${shipData.ship} (${cabins.length} cabins, ${selected.length} archetype${selected.length === 1 ? "" : "s"}, ${MODEL}):`);
  let totalMin = 0, totalMax = 0;
  for (const a of selected) {
    const { rows, dropped } = candidatesFor(a);
    const promptTokens = estimateTokens(userPrompt(a));
    const c = projectCost({ promptTokens, systemTokens, outputTokens: MAX_OUTPUT, calls: 1, attempts: ATTEMPTS, model: MODEL });
    totalMin += c.min; totalMax += c.max;
    console.log(`  ${a.id.padEnd(28)} ~${(promptTokens + systemTokens).toLocaleString().padStart(7)} tokens in  ${rows.length} groups${dropped.length ? ` (${dropped.length} Studios not offered)` : ""}  $${c.min.toFixed(3)} – $${c.max.toFixed(3)}`);
  }
  console.log(`\nProjected: $${totalMin.toFixed(2)} if every archetype passes first time, up to $${totalMax.toFixed(2)} if each needs all ${ATTEMPTS} attempts. No call was made.`);
  process.exit(0);
}
if (!AKEY) { console.error("No ANTHROPIC_API_KEY in env."); process.exit(1); }

console.log(`Generating advice for ${shipData.ship} across ${selected.length} archetypes...`);
const outName = useFull && existsSync(curatedPath) ? `${ship}-fullgrid` : ship;
const outPath = join(HERE, `advice/${outName}.json`);
let byArchetype = {};
if (ONLY.length) {
  if (!existsSync(outPath)) { console.error(`--only needs an existing ${outPath} to merge into`); process.exit(1); }
  byArchetype = JSON.parse(await readFile(outPath, "utf8")).byArchetype ?? {};
  const unknown = ONLY.filter((id) => !archetypes.some((a) => a.id === id));
  if (unknown.length) { console.error(`unknown archetype(s): ${unknown.join(", ")}`); process.exit(1); }
}
let totalCost = 0, modelUsed = null, failures = 0;
for (const a of archetypes) {
  if (ONLY.length && !ONLY.includes(a.id)) continue;
  process.stdout.write(`  ${a.id} ... `);
  const res = await generateOne(userPrompt(a), a.traveler);
  if (!res) { console.log("SKIPPED (every attempt failed)"); failures++; continue; }
  byArchetype[a.id] = { label: a.label, ...res.out, costUsd: Math.round(res.cost * 10000) / 10000, calls: res.calls };
  totalCost += res.cost; modelUsed = res.model;
  console.log(`ok (${res.calls} call${res.calls === 1 ? "" : "s"}, $${res.cost.toFixed(4)})`);
}

const out = { ship: shipData.ship, class: shipData.class, model: modelUsed ?? (ONLY.length ? JSON.parse(await readFile(outPath, "utf8")).model : null), archetypes: archetypes.length, generatedCount: Object.keys(byArchetype).length, lastRun: { at: new Date().toISOString(), archetypes: selected.map((a) => a.id), ...ledger.summary() }, byArchetype };
await mkdir(join(HERE, "advice"), { recursive: true });
await writeFile(outPath, JSON.stringify(out, null, 2));
const L = ledger.summary();
console.log(`\nDone. ${Object.keys(byArchetype).length}/${archetypes.length} archetypes, ${failures} failed. This run: ${L.calls} calls (${L.failed} rejected or failed), ${L.inputTokens.toLocaleString()} tokens in, ${L.outputTokens.toLocaleString()} out, $${L.usd.toFixed(3)} charged (${modelUsed}).`);
console.log(`Wrote advice/${outName}.json`);
