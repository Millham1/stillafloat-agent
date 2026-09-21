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

Rules:
- Report the CENTRE of each feature as x and y, each a fraction of the image: x from 0 at the far LEFT edge to 1 at the far RIGHT edge; y from 0 at the TOP edge to 1 at the BOTTOM edge. Be precise.
- Use the printed label when there is one, verbatim, in "label".
- A row of cabin numbers is NOT a feature. Corridors are not features. Do not report cabins.
- If you cannot tell what something is, leave it out. An empty list is a correct answer.
- Do not infer a lift from a gap between cabins. Only report what is drawn.

Return ONLY JSON: {"features":[{"kind":"lift|stair|venue|service","label":"<printed text or null>","x":<0..1>,"y":<0..1>}]}`;

const b64 = readFileSync(file).toString("base64");
const media = file.toLowerCase().endsWith(".jpg") || file.toLowerCase().endsWith(".jpeg")
  ? "image/jpeg" : "image/png";

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
  body: JSON.stringify({
    model: "claude-sonnet-5",
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: media, data: b64 } },
        { type: "text", text: "List every lift, stair, noisy venue and service space on this deck plan, with its centre as image fractions." },
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
}));
console.log(JSON.stringify({ image: basename(file), ship, deck, count: rows.length, features: rows }, null, 1));
console.error(`${basename(file)}: ${rows.length} features  (in ${j.usage.input_tokens} / out ${j.usage.output_tokens} tokens)`);
