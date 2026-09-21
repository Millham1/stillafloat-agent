#!/usr/bin/env node
// Find the NOISE SOURCES on a deck plan — lifts, stairs, and the venues people
// hear through the floor — and record where they sit along the hull.
//
// Mark, 2026-08-18: "we have all the deck plans. you should be able to visualize
// the room on the deck plan and scan nearby for elevator lobbies and other noise
// issues based on that plan."
//
// WHY THE PREVIOUS ATTEMPT FAILED. I tried to infer lift lobbies from gaps in a
// cabin run and it did not work: rooms inside the researched elevator zones came
// out LESS likely to be near a detected gap, and Escape deck 12 produced zero
// gaps on a deck whose plan clearly shows lifts. The reason is structural — a
// lobby sits INBOARD, reached by a cross-corridor, so the outboard cabin run runs
// straight past it. The lifts were never absent from the plan, only from the
// cabin coordinates. So read the plan.
//
// WHAT IT RETURNS. Positions are fractions of the IMAGE (0..1), the same frame the
// cabin geometry was read in, so a feature's x maps onto cabins.pos_along without
// any registration step. Nothing is invented: the model is told to report only
// what is drawn or labelled, and to return an empty list rather than guess.
//
// Usage:
//   node read-deck-features.mjs <image.png> [--deck 12] [--ship norwegian-escape]
// Env: ANTHROPIC_API_KEY

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const AKEY = process.env.ANTHROPIC_API_KEY;
if (!AKEY) { console.error("ANTHROPIC_API_KEY required"); process.exit(1); }
const file = process.argv[2];
if (!file) { console.error("usage: read-deck-features.mjs <image> [--deck N] [--ship slug]"); process.exit(1); }
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };

const SYSTEM = `You read cruise-ship deck plans and report the fixed features that make noise for the cabins around them.

Report ONLY these, and only where the plan actually draws or labels them:
  lift      — a lift/elevator bank. Usually a hatched or cross-hatched box, often labelled "Lift", "Lifts", "Elevators", "Panoramic Lifts".
  stair     — a stairwell/staircase symbol (the drawn flight of steps).
  venue     — a named public room whose noise carries: bar, lounge, club, disco, theatre, casino, restaurant, buffet, galley, kitchen, pool, gym, kids club, arcade, laundry.
  service   — crew door, service lift, pantry, laundry, engine/technical space, where labelled.
  lifeboat  — a lifeboat or tender in its davits: a capsule/rounded-rectangle drawn OUTBOARD of the hull
              outline, in a repeating row along the ship's side. Report each boat separately, not the row.

Rules:
- Report the CENTRE of each feature as x and y, each a fraction of the image: x from 0 at the far LEFT edge to 1 at the far RIGHT edge; y from 0 at the TOP edge to 1 at the BOTTOM edge. Be precise.
- Use the printed label when there is one, verbatim, in "label".
- A row of cabin numbers is NOT a feature. Corridors are not features. Do not report cabins.
- If you cannot tell what something is, leave it out. An empty list is a correct answer.
- Do not infer a lift from a gap between cabins. Only report what is drawn.

Return ONLY JSON: {"features":[{"kind":"lift|stair|venue|service","label":"<printed text or null>","x":<0..1>,"y":<0..1>}]}`;

// --lifeboat-cabins: the frame-free way to answer "which cabins have a boat over them".
// Mapping a boat's coordinate onto a cabin's coordinate needs the two to share a frame, and on
// Carnival's plan the fit came out good to about seven cabin rows (2026-09-20) — useless when being
// one boat out is the whole question. So instead the image carries BOTH decks and the model reads the
// alignment the way a person would, returning CABIN NUMBERS, which are checkable against the grid.
const PAIR = process.argv.includes("--lifeboat-cabins");
const PAIR_SYSTEM = `You read a cruise-ship deck plan showing TWO decks side by side: a cabin deck and, next to it, the public deck above it. Lifeboats hang in davits along the public deck's outer edges, drawn as grey capsules outboard of the hull outline.

For EACH lifeboat, report the cabin numbers on the cabin deck that sit directly alongside it — the cabins a plumb line from that boat would pass. Work strictly from the drawing: the two decks are drawn to the same scale and aligned, so a boat at a given point along the hull sits over the cabins at that same point.

Rules:
- Report cabin numbers exactly as printed. If a number is not legible, leave it out.
- Give the boats in order along the hull, and say which side each is on: the two long edges are the two sides of the ship.
- A boat spans several cabins. List them all, in order.
- If you cannot align a boat to any cabin with confidence, return an empty "cabins" list for it. An empty answer is correct; a guess is not.

Return ONLY JSON under the SAME key the other mode uses, so one parser reads both:
{"features":[{"kind":"lifeboat","side":"edge-A|edge-B","order":<1-based along the hull>,"cabins":["5203","5207"]}]}`;

const b64 = readFileSync(file).toString("base64");
const media = file.toLowerCase().endsWith(".jpg") || file.toLowerCase().endsWith(".jpeg")
  ? "image/jpeg" : "image/png";

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
  body: JSON.stringify({
    model: "claude-sonnet-5",
    max_tokens: 8000,
    system: PAIR ? PAIR_SYSTEM : SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: media, data: b64 } },
        { type: "text", text: PAIR
            ? "For each lifeboat on the public deck, list the cabin numbers on the cabin deck that sit directly alongside it."
            : "List every lift, stair, noisy venue and service space on this deck plan, with its centre as image fractions." },
      ],
    }],
  }),
  signal: AbortSignal.timeout(180000),
});
const j = await res.json();
if (!res.ok) { console.error(`Anthropic ${res.status}:`, JSON.stringify(j).slice(0, 300)); process.exit(1); }
const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
const m = text.match(/\{[\s\S]*\}/);
if (!m) { console.error("no JSON in response:", text.slice(0, 300)); process.exit(1); }
const out = JSON.parse(m[0]);

const ship = arg("--ship"), deck = arg("--deck");
const rows = (out.features ?? []).map((f) => ({
  ship_slug: ship, deck: deck ? Number(deck) : null,
  kind: f.kind, label: f.label ?? null,
  img_x: f.x, img_y: f.y, source_image: basename(file),
  // --lifeboat-cabins answers in cabin numbers, not coordinates; carry them through instead of
  // dropping them on the floor with the rest of the unknown keys.
  ...(f.cabins ? { side: f.side ?? null, order: f.order ?? null, cabins: f.cabins } : {}),
}));
console.log(JSON.stringify({ image: basename(file), ship, deck, count: rows.length, features: rows }, null, 1));
console.error(`${basename(file)}: ${rows.length} features  (in ${j.usage.input_tokens} / out ${j.usage.output_tokens} tokens)`);
