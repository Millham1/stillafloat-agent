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
// GROUNDED, NOT FROM MEMORY (upgraded 2026-08-12): the first version of this script asked the
// model to answer from its own knowledge, and it invented the hump twice. The Oasis proof run
// (17 match / 4 partial / 0 miss vs the 23-cabin Wonder benchmark) showed what works: live web
// research with a boilerplate control-check on aggregator claims. This script now runs the
// model WITH the web_search server tool and requires a source per zone. The whole run happens
// inside the API call — it burns API dollars, never Claude Code usage credits, and can run
// unattended via run-all-context.sh (nohup/caffeinate).
//
// ANTI-FABRICATION: only zones the research actually supports, each with its source; anything
// shakier goes to "unknowns" or "leads". Invented cabin trivia is worse than silence — honesty
// is the conversion mechanism (DESIGN.md §6).
//
// Usage: ANTHROPIC_API_KEY=... node research-class-context.mjs <ship-slug>
// Writes: context/<slug>.json

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const slug = process.argv[2];
if (!slug) { console.error("usage: node research-class-context.mjs <ship-slug>"); process.exit(1); }
const AKEY = process.env.ANTHROPIC_API_KEY;
if (!AKEY) { console.error("ANTHROPIC_API_KEY required"); process.exit(1); }

const MODEL = process.env.CONTEXT_MODEL || "claude-sonnet-5";
const MAX_SEARCHES = Number(process.env.CONTEXT_MAX_SEARCHES || 25);

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
cabin advisor. Every claim you record must be grounded in a source you found through web search
in THIS session — you never answer from memory alone, and you never invent cabin numbers, venue
names, or deck assignments. If the research does not support a factor for this class, you omit
it — an omission is correct, a plausible guess is a defect. Do not attempt to access pages that
block you; skip them, other sources exist. The output is used to advise real customers, and its
honesty is the product.`;

const prompt = `Ship: ${raw.ship} (${raw.line}${raw.class ? `, ${raw.class} class` : ""}).
Guest cabin decks present in the real inventory: ${decks.join(", ")}.
Total cabins: ${cabins.length}.

Per-deck profile extracted from the actual deck plans:
${JSON.stringify(profile, null, 1)}

RESEARCH this hull class on the web — public deck plans, cruiser forums (CruiseCritic and the
like), cabin-review sites and blogs, YouTube cabin-tour write-ups — then produce the CONTEXT
ZONES for the class: the geometry that changes how a cabin actually feels, which is not in the
deck plan data. Cover these factors where, and ONLY where, the research supports them:

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
- "taper": hull taper on the highest decks — suites/cabins whose balcony sits atop the inward
  step of the hull, hiding the view straight down while the horizon stays clear.
- "motion": the high-deck / far-forward / far-aft motion penalty for this class, where cruisers
  actually report it.
- "connecting"/"accessible"/other quirks only if genuinely characteristic of this class.

METHOD RULES (each one exists because its absence produced a wrong or weak result in testing):

1. BOILERPLATE CONTROL-CHECK. Deck-plan aggregators (cruisedeckplans, CruiseMapper, etc.) print
   near-identical text across many ships. Before trusting a ship-specific claim that only an
   aggregator makes — especially a hump claim — check the SAME page/claim for a ship of a
   DIFFERENT class; if the same wording appears there, it is boilerplate: discard it. A claim
   confirmed by a first-person review or forum thread does not need this check.
2. NEVER make class-absolute claims about what the cruise line labels. Record labeling status
   ("flagged by the line as obstructed" vs "sold unlabeled") per cabin-range, each with its own
   confidence — lines label some ranges and not others on the same deck.
3. RECORD LEADS. When a listicle, forum post, or review names SPECIFIC cabin numbers or ranges
   (unlabeled steel walls, blocked balconies, noise complaints), record them in "leads" even at
   low confidence — they are the most valuable output and get verified later; do not discard
   them just because only one source names them.
4. RECORD INTERACTIONS. When zones interact — e.g. hump balconies that jut past the lifeboat
   line and so ESCAPE the obstruction affecting their straight-hull neighbours — record it as a
   zone whose "what" states the exception explicitly.
5. Lifeboat span: state the full range of decks the boats affect, not just the deck they sit
   on; boats typically obstruct the two or three guest decks above to differing degrees — give
   the range and say which decks are worst.
6. Sister ships: list EVERY ship sharing this hull layout, including recent additions. An
   incomplete list means sister ships silently miss out on this research.
7. MINIMUM SEARCH COVERAGE — run ALL of these for THIS ship (not just a sister) before
   finishing; the crown-jewel findings (unlabeled steel walls, blocked balconies) live in
   ship-specific listicles and forum threads that generic queries miss:
   - "<ship name> cabins to avoid"
   - "<ship name> obstructed view balcony"
   - "<ship name> balcony steel wall" (or "solid balcony" / "metal wall")
   - "<ship name> cabin noise problem" site/forum results
   You have the search budget — use it; stopping early loses the most valuable findings.

Work quietly: do NOT write commentary between searches — a few words at most. Save your output
budget for the final answer. When the research is done, return ONLY JSON (no prose before or after):
{
 "class": "<hull class>",
 "sisterShips": ["<other ships sharing this layout>"],
 "zones": [
   {
    "factor": "lifeboat|above|below|elevator|i95|engine|hump|taper|motion|other",
    "decks": [<deck numbers this applies to>],
    "sections": ["forward"|"mid"|"aft"] ,
    "what": "<the physical fact, one sentence>",
    "effect": "<what it means for someone staying there, in plain words>",
    "mattersTo": "<who should care and who should not>",
    "severity": "minor|moderate|significant",
    "confidence": "high|medium|low",
    "source": "<domain + one clause on what it said; the source found THIS session>"
   }
 ],
 "leads": [
   { "cabins": "<numbers or range>", "claim": "<what is claimed>",
     "source": "<where>", "confidence": "high|medium|low" }
 ],
 "unknowns": ["<anything you could not establish for this class and would need checking>"]
}

Only include zones with confidence high or medium AND a source. Put anything shakier in
"leads" (if it names cabins) or "unknowns" (if it does not). A gap recorded in "unknowns"
costs nothing; a confident wrong answer costs Mark's credibility.`;

console.log(`Researching context for ${raw.ship} (${raw.class || "?"} class), ${cabins.length} cabins, decks ${decks.join(",")}... [grounded: web_search x${MAX_SEARCHES} max, ${MODEL}]`);

// Long web-search turns can (a) pause mid-turn (stop_reason "pause_turn" — the client must
// send the partial turn back to continue) and (b) fail transiently (429/5xx/network). Both
// killed classes in the first fleet run; handle them here.
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let messages = [{ role: "user", content: prompt }];
let j;
for (let attempt = 1, continuations = 0; ; ) {
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 24000,
        system: SYSTEM,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
      }),
      signal: AbortSignal.timeout(900000),
    });
    j = await r.json();
  } catch (e) {
    if (attempt >= 4) { console.error(`fetch failed after ${attempt} attempts: ${e.message}`); process.exit(1); }
    console.log(`  (network error, retry ${attempt}: ${e.message})`);
    attempt++; await sleep(20000 * attempt); continue;
  }
  if (!r.ok) {
    if ((r.status === 429 || r.status >= 500) && attempt < 4) {
      console.log(`  (Anthropic ${r.status}, retry ${attempt})`);
      attempt++; await sleep(30000 * attempt); continue;
    }
    console.error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 300)}`); process.exit(1);
  }
  if (j.stop_reason === "pause_turn" && continuations < 8) {
    continuations++;
    console.log(`  (pause_turn — continuing, ${continuations})`);
    messages = [...messages, { role: "assistant", content: j.content }];
    continue;
  }
  break;
}
const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
// The JSON is the LAST braced block (search narration may precede it).
const start = text.lastIndexOf('{\n "class"') >= 0 ? text.lastIndexOf('{\n "class"') : text.indexOf("{");
const m = start >= 0 ? text.slice(start).match(/\{[\s\S]*\}/) : null;
if (!m) {
  await mkdir(join(HERE, "logs"), { recursive: true });
  await writeFile(join(HERE, `logs/context-debug-${slug}.json`), JSON.stringify(j, null, 1));
  console.error(`no JSON in response (stop_reason=${j.stop_reason}, ${(j.content || []).length} blocks, ` +
    `${j.usage?.output_tokens} out tokens) — raw response dumped to logs/context-debug-${slug}.json`);
  process.exit(1);
}
const out = JSON.parse(m[0]);

// Coverage check: how many real cabins does this research actually reach?
const zoneDecks = new Set(out.zones.flatMap((z) => z.decks || []));
const covered = cabins.filter((c) => zoneDecks.has(c.deck)).length;

const searches = j.usage?.server_tool_use?.web_search_requests || 0;
out.ship = raw.ship;
out.shipSlug = slug;
out.line = raw.line;
out.totalCabins = cabins.length;
out.cabinsTouchedByAZone = covered;
out.model = j.model;
out.grounded = { webSearches: searches, maxAllowed: MAX_SEARCHES };
out.cost = j.usage.input_tokens * 3e-6 + j.usage.output_tokens * 15e-6 + searches * 0.01;

await mkdir(join(HERE, "context"), { recursive: true });
await writeFile(join(HERE, `context/${slug}.json`), JSON.stringify(out, null, 2));

console.log(`\n${out.zones.length} zones, covering ${covered}/${cabins.length} cabins (${Math.round(covered / cabins.length * 100)}%); ${(out.leads || []).length} leads; ${searches} web searches`);
for (const z of out.zones) {
  console.log(`  [${z.severity}/${z.confidence}] ${z.factor} — decks ${(z.decks || []).join(",")} ${(z.sections || []).join("/")}`);
  console.log(`      ${z.effect}`);
  if (z.source) console.log(`      src: ${z.source}`);
}
if (out.leads?.length) {
  console.log(`\nLeads (specific cabins named by sources — verify before use):`);
  for (const l of out.leads) console.log(`  - [${l.confidence}] ${l.cabins}: ${l.claim} (${l.source})`);
}
if (out.unknowns?.length) {
  console.log(`\nUnknowns flagged (need checking, NOT guessed):`);
  for (const u of out.unknowns) console.log(`  - ${u}`);
}
console.log(`\nWrote context/${slug}.json  (≈$${out.cost.toFixed(3)}, ${j.model})`);
