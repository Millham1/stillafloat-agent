#!/usr/bin/env node
// Cabin Advisor — LAYER 2: per-class context research (the moat).
//
// See DESIGN.md §4. Obstruction is REASONING, not a boolean. DeckMaps gives us a complete
// grid but every cabin comes back obstructed:false, because the source carries no such field.
// What a customer actually needs to know is what KIND of compromise a cabin has and whether
// they would care:
//
//   lifeboats  — block the view DOWN but leave the horizon clean
//   above/below— pool deck overhead means 6am chairs; a late venue below means bass
//   elevators  — convenience traded against foot traffic and door noise
//   I-95       — the crew corridor; service traffic near its access points
//   engines    — vibration low and aft, thrusters low and forward, anchor chain in the bow
//
// These are GEOMETRIC FACTS ABOUT A HULL CLASS, so they are researched ONCE per class and
// reused across every sister ship. That is what makes 42 classes tractable instead of 138 ships.
//
// This does NOT write a sentence per cabin — 2,886 bespoke paragraphs would be waste and
// invention. It produces ZONES: a deck/section range plus the factor that applies there and
// what it means. Zones then attach to every real cabin deterministically, so all 2,886 cabins
// are covered from one research pass.
//
// ANTI-FABRICATION: the model is told to return only what it is confident is true for this
// specific hull class, to mark its own confidence, and to leave a factor out entirely rather
// than guess. Invented cabin trivia is worse than silence — honesty is the conversion
// mechanism (DESIGN.md §6).
//
// Usage: ANTHROPIC_API_KEY=... node research-class-context.mjs wonder-of-the-seas
// Writes: context/<slug>.json

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const slug = process.argv[2];
if (!slug) { console.error("usage: node research-class-context.mjs <ship-slug>"); process.exit(1); }
const AKEY = process.env.ANTHROPIC_API_KEY;
if (!AKEY) { console.error("ANTHROPIC_API_KEY required"); process.exit(1); }

const MODEL = process.env.CONTEXT_MODEL || "claude-sonnet-4-5";

/** Ground the research in the real grid: which decks exist, how many cabins, what categories. */
function deckProfile(cabins) {
  const byDeck = new Map();
  for (const c of cabins) {
    if (c.deck == null) continue;
    if (!byDeck.has(c.deck)) byDeck.set(c.deck, { deck: c.deck, count: 0, cats: new Map(), sections: new Map() });
    const d = byDeck.get(c.deck);
    d.count++;
    d.cats.set(c.category, (d.cats.get(c.category) || 0) + 1);
    const s = (c.section || "unknown").toLowerCase();
    d.sections.set(s, (d.sections.get(s) || 0) + 1);
  }
  return [...byDeck.values()].sort((a, b) => a.deck - b.deck).map((d) => ({
    deck: d.deck,
    cabins: d.count,
    categories: [...d.cats.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`),
    sections: Object.fromEntries(d.sections),
  }));
}

const raw = JSON.parse(await readFile(join(HERE, `data/cabins/${slug}-full.json`), "utf8"));
const cabins = raw.cabins || [];
const profile = deckProfile(cabins);
const decks = profile.map((d) => d.deck);

const SYSTEM = `You are a cruise ship naval-architecture researcher building reference data for a
cabin advisor. You produce only facts you are confident are true for the specific hull class in
question. You never invent cabin numbers, venue names, or deck assignments. If you are not
confident about a factor for this class, you omit it — an omission is correct, a plausible guess
is a defect. The output is used to advise real customers, and its honesty is the product.`;

const prompt = `Ship: ${raw.ship} (${raw.line}${raw.class ? `, ${raw.class} class` : ""}).
Guest cabin decks present in the real inventory: ${decks.join(", ")}.
Total cabins: ${cabins.length}.

Per-deck profile extracted from the actual deck plans:
${JSON.stringify(profile, null, 1)}

Produce the CONTEXT ZONES for this hull class — the geometry that changes how a cabin actually
feels, which is not in the deck plan data. Cover these factors where, and ONLY where, you are
confident they apply to this class:

- "lifeboat": which decks sit directly above the lifeboat/tender line. State plainly whether the
  view down is blocked while the horizon stays clear, and who would or would not care.
- "above" / "below": a deck (and section) whose neighbour overhead or underneath materially
  changes the experience — pool deck, buffet, theatre, nightclub, galley, promenade. Include how
  far away it is (directly above, two decks down) because distance matters as much as identity.
- "elevator": the elevator/stair banks — where they fall along the hull and the convenience vs
  noise trade.
- "i95": the crew corridor and where its access points create service traffic near guest cabins.
- "engine": propulsion vibration (low and aft), bow thrusters (low and forward), and the anchor
  chain (bow, every port morning).
- "hump": if this class has a hump — balconies cantilevered past the hull line — which decks and
  sections, and what it buys.
- "connecting"/"accessible"/other quirks only if genuinely characteristic of this class.

Return ONLY JSON:
{
 "class": "<hull class>",
 "sisterShips": ["<other ships sharing this layout>"],
 "zones": [
   {
    "factor": "lifeboat|above|below|elevator|i95|engine|hump|other",
    "decks": [<deck numbers this applies to>],
    "sections": ["forward"|"mid"|"aft"] ,
    "what": "<the physical fact, one sentence>",
    "effect": "<what it means for someone staying there, in plain words>",
    "mattersTo": "<who should care and who should not>",
    "severity": "minor|moderate|significant",
    "confidence": "high|medium|low"
   }
 ],
 "unknowns": ["<anything you could not establish for this class and would need checking>"]
}

Only include zones with confidence high or medium. Put anything shakier in "unknowns" instead.`;

console.log(`Researching context for ${raw.ship} (${raw.class || "?"} class), ${cabins.length} cabins, decks ${decks.join(",")}...`);

const r = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
  body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
  signal: AbortSignal.timeout(180000),
});
const j = await r.json();
if (!r.ok) { console.error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 300)}`); process.exit(1); }
const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
const m = text.match(/\{[\s\S]*\}/);
if (!m) { console.error("no JSON in response"); process.exit(1); }
const out = JSON.parse(m[0]);

// Coverage check: how many real cabins does this research actually reach?
const zoneDecks = new Set(out.zones.flatMap((z) => z.decks || []));
const covered = cabins.filter((c) => zoneDecks.has(c.deck)).length;

out.ship = raw.ship;
out.shipSlug = slug;
out.line = raw.line;
out.totalCabins = cabins.length;
out.cabinsTouchedByAZone = covered;
out.model = j.model;
out.cost = j.usage.input_tokens * 3e-6 + j.usage.output_tokens * 15e-6;

await mkdir(join(HERE, "context"), { recursive: true });
await writeFile(join(HERE, `context/${slug}.json`), JSON.stringify(out, null, 2));

console.log(`\n${out.zones.length} zones, covering ${covered}/${cabins.length} cabins (${Math.round(covered / cabins.length * 100)}%)`);
for (const z of out.zones) {
  console.log(`  [${z.severity}/${z.confidence}] ${z.factor} — decks ${(z.decks || []).join(",")} ${(z.sections || []).join("/")}`);
  console.log(`      ${z.effect}`);
}
if (out.unknowns?.length) {
  console.log(`\nUnknowns flagged (need checking, NOT guessed):`);
  for (const u of out.unknowns) console.log(`  - ${u}`);
}
console.log(`\nWrote context/${slug}.json  (≈$${out.cost.toFixed(3)}, ${j.model})`);
