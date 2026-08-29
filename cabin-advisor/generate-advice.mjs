#!/usr/bin/env node
// Cabin Advisor — advice generator (the "cliffnotes" batch job).
//
// For each traveler archetype, ask the AI (in Mark's voice) to reason the cabin
// recommendations for a ship, once. Store the result. The site then serves these
// pre-generated write-ups for free — no LLM call when a customer searches.
//
// Run: node generate-advice.mjs [ship-slug]     (default: wonder-of-the-seas)
// Env: ANTHROPIC_API_KEY (preferred, Haiku) and/or OPENAI_API_KEY (fallback).
//
// Cost model: ~a dollar for a whole fleet, ONE TIME. Re-run only when cabin data
// or the voice guide changes. See README.md.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ship = process.argv[2] || "wonder-of-the-seas";
const AKEY = process.env.ANTHROPIC_API_KEY;
const OKEY = process.env.OPENAI_API_KEY;

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

function userPrompt(traveler) {
  return `Traveler: ${traveler}. Ship: ${shipData.ship}.

Candidate cabins (all real, with the quirks that matter):
${JSON.stringify(cabins)}

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

async function viaClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1600, system: VOICE, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(40000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  if (j.stop_reason === "refusal") throw new Error("Anthropic refusal");
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { out: parse(text), model: j.model, cost: j.usage.input_tokens * 1e-6 + j.usage.output_tokens * 5e-6 };
}
async function viaOpenAI(prompt) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${OKEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.4, response_format: { type: "json_object" },
      messages: [{ role: "system", content: VOICE }, { role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(40000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  const text = j.choices?.[0]?.message?.content ?? "";
  return { out: parse(text), model: "gpt-4o-mini", cost: j.usage.prompt_tokens * 0.15e-6 + j.usage.completion_tokens * 0.6e-6 };
}

async function generateOne(prompt) {
  // Crash-proof ladder: Haiku -> OpenAI. Never throws up the stack.
  if (AKEY) { try { return await viaClaude(prompt); } catch (e) { console.warn("  Haiku failed:", e.message); } }
  if (OKEY) { try { return await viaOpenAI(prompt); } catch (e) { console.warn("  OpenAI failed:", e.message); } }
  return null;
}

if (!AKEY && !OKEY) { console.error("No ANTHROPIC_API_KEY or OPENAI_API_KEY in env."); process.exit(1); }

console.log(`Generating advice for ${shipData.ship} across ${archetypes.length} archetypes...`);
const byArchetype = {};
let totalCost = 0, modelUsed = null, failures = 0;
for (const a of archetypes) {
  process.stdout.write(`  ${a.id} ... `);
  const res = await generateOne(userPrompt(a.traveler));
  if (!res) { console.log("SKIPPED (both providers failed)"); failures++; continue; }
  byArchetype[a.id] = { label: a.label, ...res.out };
  totalCost += res.cost; modelUsed = res.model;
  console.log(`ok ($${res.cost.toFixed(4)})`);
}

const out = { ship: shipData.ship, class: shipData.class, model: modelUsed, archetypes: archetypes.length, generatedCount: Object.keys(byArchetype).length, byArchetype };
await mkdir(join(HERE, "advice"), { recursive: true });
const outName = useFull && existsSync(curatedPath) ? `${ship}-fullgrid` : ship;
await writeFile(join(HERE, `advice/${outName}.json`), JSON.stringify(out, null, 2));
console.log(`\nDone. ${Object.keys(byArchetype).length}/${archetypes.length} archetypes, ${failures} failed. Total cost ≈ $${totalCost.toFixed(3)} (${modelUsed}).`);
console.log(`Wrote advice/${outName}.json`);
