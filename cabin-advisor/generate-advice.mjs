#!/usr/bin/env node
// Cabin Advisor — advice generator (the "cliffnotes" batch job).
//
// For each traveler archetype, ask the AI (in Mark's voice) to reason the cabin
// recommendations for a ship, once. Store the result. The site then serves these
// pre-generated write-ups for free — no LLM call when a customer searches.
//
// Run: node generate-advice.mjs [ship-slug] [--estimate] [--approved-cost <$>] [--no-batch "<reason>"]
//      (default ship: wonder-of-the-seas)
// Env: ANTHROPIC_API_KEY (Haiku), or ~/.config/saf-secrets/env.txt. The OpenAI fallback
// was removed 2026-09-09 when the service dropped OpenAI entirely.
//
// COST (Mark, 2026-10-02 — the bulk-run rule, enforced in ../server/src/lib/claude-core.mjs):
// the estimate prints before any call. A run over 20 calls or a $2 ceiling goes through the
// Message Batches API and needs --approved-cost; --estimate prints the figure and stops.
// The 2026-09-14 Aura run put the whole ~110K-token cabin grid into EVERY archetype prompt,
// uncached, after a line that differed per archetype — so nothing could ever be cached. The
// grid now sits in the system prompt, identical for every archetype, marked cache_control:
// the first call writes it and the rest read it at a tenth of the price.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bulkFlags, openBulkRun, messageText, MODELS } from "../server/src/lib/claude-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLAGS_WITH_VALUES = new Set(["--approved-cost", "--no-batch"]);
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !FLAGS_WITH_VALUES.has(all[i - 1]));
const ship = positional[0] || "wonder-of-the-seas";
const ESTIMATE_ONLY = process.argv.includes("--estimate");
const MODEL = MODELS.CHEAP; // Haiku 4.5 — unchanged
const MAX_OUTPUT = 1600;

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

// The part every archetype shares: the voice, then the ship's cabin grid. Identical bytes in
// every call and marked for caching — the grid is most of every prompt.
const SYSTEM = [
  { type: "text", text: VOICE },
  {
    type: "text",
    text: `Ship: ${shipData.ship}.\n\nCandidate cabins (all real, with the quirks that matter):\n${JSON.stringify(cabins)}`,
    cache_control: { type: "ephemeral" },
  },
];

function userPrompt(traveler) {
  return `Traveler: ${traveler}. Ship: ${shipData.ship}. The candidate cabins are in your instructions above.

Recommend the best 4-6 cabins for THIS traveler, ranked (rank 1 = book first). Each reason must be distinct and tied to what they told you; where two cabins are nearly identical, say so and give the honest tie-breaker. Then list 2-3 cabins you would steer them clear of, with the honest reason.

For each recommendation also write "hook": a short headline (5-10 words) that names the room TYPE and ties it to what THIS traveler wants — the reason-to-care, not a spec. Like: "Boardwalk balcony to watch the action from your own roost" or "An ocean balcony for your quiet morning coffee". Never "Ocean View Balcony on Deck 8" — that is a brochure line, not you. Every hook must be different in wording AND structure from the others; no template reuse.

Fidelity rules:
- Speak ONLY to concerns this traveler actually told you. If they never mentioned seasickness, do not bring up motion, steadiness or stomachs. If they never mentioned noise, don't lead with quiet.
- The voice example in your instructions is a TONE reference, not content — do not reuse its phrases ("tummy troubles", "the bonus is waking up") unless this traveler genuinely has that concern.
- Vary your openings. Do not start every reason with "Cabin NNNN is..."

Respond with ONLY a JSON object:
{"recommendations":[{"cabin":<number>,"rank":<number>,"hook":"<5-10 words>","reason":"<2-4 sentences in your voice>"}],"steerClear":[{"cabin":<number>,"reason":"<1-2 sentences>"}]}`;
}

function parse(text) {
  const m = text && text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model response");
  return JSON.parse(m[0]);
}

const requests = archetypes.map((a) => ({
  custom_id: String(a.id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
  params: { model: MODEL, max_tokens: MAX_OUTPUT, system: SYSTEM, messages: [{ role: "user", content: userPrompt(a.traveler) }] },
}));

console.log(`Generating advice for ${shipData.ship} across ${archetypes.length} archetypes...`);
let run;
try {
  run = openBulkRun({
    job: "cabin.advice",
    paramsList: requests.map((r) => r.params),
    expectedOutputTokens: 900,
    ...bulkFlags(),
    ...(ESTIMATE_ONLY ? { approvedCost: undefined } : {}),
  });
} catch (e) {
  console.error(e.message);
  process.exit(ESTIMATE_ONLY ? 0 : 2);
}
if (ESTIMATE_ONLY) { console.log("(--estimate: nothing sent)"); process.exit(0); }

const results = await run.execute(requests);
const byArchetype = {};
let modelUsed = null, failures = 0;
for (const [i, a] of archetypes.entries()) {
  const r = results.get(requests[i].custom_id);
  process.stdout.write(`  ${a.id} ... `);
  if (!r?.ok) { console.log(`SKIPPED (${r?.error ?? "no result"})`); failures++; continue; }
  try {
    if (r.message.stop_reason === "refusal") throw new Error("Anthropic refusal");
    byArchetype[a.id] = { label: a.label, ...parse(messageText(r.message)) };
    modelUsed = r.message.model ?? MODEL;
    console.log(`ok ($${(r.cost ?? 0).toFixed(4)})`);
  } catch (e) {
    console.log(`SKIPPED (${e.message})`); failures++;
  }
}

const out = { ship: shipData.ship, class: shipData.class, model: modelUsed, archetypes: archetypes.length, generatedCount: Object.keys(byArchetype).length, byArchetype };
await mkdir(join(HERE, "advice"), { recursive: true });
const outName = useFull && existsSync(curatedPath) ? `${ship}-fullgrid` : ship;
await writeFile(join(HERE, `advice/${outName}.json`), JSON.stringify(out, null, 2));
// Every call that billed is in this figure, including any that failed to parse.
console.log(`\nDone. ${Object.keys(byArchetype).length}/${archetypes.length} archetypes, ${failures} failed. Total cost ≈ $${run.spent().toFixed(3)} (${modelUsed}).`);
console.log(`Wrote advice/${outName}.json`);
