#!/usr/bin/env node
// Translate one ship's advisor reasoning into Latin American Spanish.
//
// WHY THIS EXISTS. The ES columns on cabin_advice were populated once by a
// script that no longer exists in the repo, and the route serves them WHOLESALE
// for Spanish visitors (`recommendations_es ?? recommendations`) — cabin numbers
// included. So the moment the English advice is regenerated, the Spanish rows
// point at the OLD rooms and a Spanish visitor is sent somewhere no one chose
// for them. Regenerating English without this is a silent ES regression.
//
// Spanish is a first-class surface here, not a courtesy copy: the ES site serves
// a predominantly Spanish-speaking following, so falling back to English text is
// not an acceptable answer either.
//
// THE ONE STRUCTURAL GUARANTEE. The model never sees or returns a cabin number.
// It is handed an array of text fields and must return the same array, translated,
// in order. Numbers and ranks are re-attached from the English source afterwards,
// so a translation cannot move anybody to a different room. Length is asserted;
// a mismatch fails the archetype rather than writing a scrambled set.
//
// Run: node translate-advice.mjs <ship-slug> [--approved-cost <$>] [--no-batch "<reason>"]
//      (reads advice/<slug>.json)
// Env: ANTHROPIC_API_KEY. One call per archetype (12): under the bulk-run line, so it runs
// one call at a time with no flags; claude-core.mjs prints the estimate first regardless.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bulkFlags, runBulk, messageText, MODELS } from "../server/src/lib/claude-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLAGS_WITH_VALUES = new Set(["--approved-cost", "--no-batch"]);
const slug = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !FLAGS_WITH_VALUES.has(all[i - 1]))[0];
if (!slug) { console.error("usage: node translate-advice.mjs <ship-slug>"); process.exit(1); }

const doc = JSON.parse(await readFile(join(HERE, `advice/${slug}.json`), "utf8"));

const SYSTEM = `You translate cruise-cabin advice into LATIN AMERICAN Spanish (es-419) for Still Afloat Cruising.

The voice is Mark's: a working travel advisor talking to one person. Warm, direct, a
little dry. Advisory, never a sales pitch — the trust IS the sell.

Rules:
- es-419, not Castilian. "tú", never "vosotros". No "coger".
- Translate MEANING, not word order. It must read as though written in Spanish.
- Keep cabin/room references exactly as written if any appear inside the text.
- Never add, drop or reorder items. Same count, same order.
- No brochure language: no "ideal para", "cuenta con", "ofrece", "disfrute de".
- Keep hooks SHORT (5-10 words), like the English.
- Return ONLY a JSON array of translated strings, same length and order as the input.`;

function translateParams(strings) {
  return {
    model: MODELS.CHEAP, max_tokens: 4000, system: SYSTEM,
    messages: [{ role: "user", content: `Translate each string. Return ONLY a JSON array of ${strings.length} strings, same order.\n\n${JSON.stringify(strings, null, 1)}` }],
  };
}

function readTranslation(message, strings) {
  const m = messageText(message).match(/\[[\s\S]*\]/);
  if (!m) throw new Error("no JSON array in response");
  const out = JSON.parse(m[0]);
  if (!Array.isArray(out) || out.length !== strings.length)
    throw new Error(`length mismatch: sent ${strings.length}, got ${Array.isArray(out) ? out.length : "non-array"}`);
  return out.map(String);
}

// Flatten every archetype to a strict, positional list of text-only fields, up front, so
// the whole run is estimated (and gated) before the first call.
const jobs = Object.entries(doc.byArchetype).map(([aid, a]) => {
  const recs = a.recommendations ?? [];
  const steer = a.steerClear ?? a.steer_clear ?? [];
  const strings = [a.label ?? "", ...recs.flatMap((r) => [r.hook ?? "", r.reason ?? ""]), ...steer.map((s) => s.reason ?? "")];
  return { aid, recs, steer, strings, custom_id: `es-${aid}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) };
});
let results;
try {
  ({ results } = await runBulk({
    job: "cabin.advice-es",
    requests: jobs.map((j) => ({ custom_id: j.custom_id, params: translateParams(j.strings) })),
    expectedOutputTokens: 1500,
    ...bulkFlags(),
  }));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const outByArchetype = {};
let failed = 0;
for (const { aid, recs, steer, strings, custom_id } of jobs) {
  process.stdout.write(`  ${aid} ... `);
  try {
    const r = results.get(custom_id);
    if (!r?.ok) throw new Error(r?.error ?? "no result");
    const t = readTranslation(r.message, strings);
    let i = 0;
    const label_es = t[i++];
    const recommendations_es = recs.map((rec) => ({
      cabin: rec.cabin, rank: rec.rank,            // ← re-attached from English, never translated
      hook: t[i++], reason: t[i++],
    }));
    const steer_clear_es = steer.map((x) => ({ cabin: x.cabin, reason: t[i++] }));
    outByArchetype[aid] = { label_es, recommendations_es, steer_clear_es };
    console.log("ok");
  } catch (e) {
    console.log(`FAILED (${e.message})`);
    failed++;
  }
}

// The guarantee, asserted rather than assumed.
let checked = 0;
for (const [aid, es] of Object.entries(outByArchetype)) {
  const en = doc.byArchetype[aid];
  const a = (en.recommendations ?? []).map((r) => String(r.cabin));
  const b = es.recommendations_es.map((r) => String(r.cabin));
  if (a.join(",") !== b.join(",")) throw new Error(`${aid}: ES cabin list differs from EN`);
  const c = (en.steerClear ?? en.steer_clear ?? []).map((s) => String(s.cabin));
  const d = es.steer_clear_es.map((s) => String(s.cabin));
  if (c.join(",") !== d.join(",")) throw new Error(`${aid}: ES steer-clear list differs from EN`);
  checked += a.length + c.length;
}

await writeFile(join(HERE, `advice/${slug}.es.json`), JSON.stringify({ ship: doc.ship, byArchetype: outByArchetype }, null, 2));
console.log(`\n${Object.keys(outByArchetype).length}/${Object.keys(doc.byArchetype).length} archetypes, ${failed} failed.`);
console.log(`${checked} cabin references verified identical to the English.`);
console.log(`Wrote advice/${slug}.es.json`);
