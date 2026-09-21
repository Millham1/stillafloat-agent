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
// Run: node translate-advice.mjs <ship-slug>       (reads advice/<slug>.json)
// Env: ANTHROPIC_API_KEY

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const slug = process.argv[2];
if (!slug) { console.error("usage: node translate-advice.mjs <ship-slug>"); process.exit(1); }
const AKEY = process.env.ANTHROPIC_API_KEY;
if (!AKEY) { console.error("ANTHROPIC_API_KEY required"); process.exit(1); }

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

async function translateBatch(strings) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5", max_tokens: 4000, system: SYSTEM,
      messages: [{ role: "user", content: `Translate each string. Return ONLY a JSON array of ${strings.length} strings, same order.\n\n${JSON.stringify(strings, null, 1)}` }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("no JSON array in response");
  const out = JSON.parse(m[0]);
  if (!Array.isArray(out) || out.length !== strings.length)
    throw new Error(`length mismatch: sent ${strings.length}, got ${Array.isArray(out) ? out.length : "non-array"}`);
  return out.map(String);
}

const outByArchetype = {};
let cost = 0, failed = 0;
for (const [aid, a] of Object.entries(doc.byArchetype)) {
  process.stdout.write(`  ${aid} ... `);
  const recs = a.recommendations ?? [];
  const steer = a.steerClear ?? a.steer_clear ?? [];
  // Flatten to a strict, positional list of text-only fields.
  const strings = [a.label ?? "", ...recs.flatMap((r) => [r.hook ?? "", r.reason ?? ""]), ...steer.map((s) => s.reason ?? "")];
  try {
    const t = await translateBatch(strings);
    let i = 0;
    const label_es = t[i++];
    const recommendations_es = recs.map((r) => ({
      cabin: r.cabin, rank: r.rank,            // ← re-attached from English, never translated
      hook: t[i++], reason: t[i++],
    }));
    const steer_clear_es = steer.map((s) => ({ cabin: s.cabin, reason: t[i++] }));
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
