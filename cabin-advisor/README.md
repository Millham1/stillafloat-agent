# Cabin Advisor (the "Room Engine")

An AI advisor that reasons cabin recommendations **in Mark's voice** and hands the
customer off to Mark for the live price — a lead-generation engine for the agency.
A customer answers a short interview; the tool recommends specific cabins on a
ship, explains *why* each fits them, warns them off the wrong ones, and ends in a
"Get Mark's live price" hand-off.

Started 2026-07-26. This directory is the captured foundation — **not yet wired
into the live site.** It is isolated (no route, not a workspace package, not
typechecked by CI). Nothing here affects production.

## Why it's different from a price-sorter (e.g. CruisePlum)
The wedge is **tailoring + reasoning + lead capture**, which a self-serve deal
search structurally can't do. The advisor differentiates each cabin, gives honest
tie-breakers, and steers people away from bad-fit or quietly-obstructed cabins —
that honesty is the whole conversion mechanism.

## The cost architecture — the "cliffnotes" model (important)
Do **not** call the LLM live on every customer search (that scales cost with
traffic). Instead, exactly like the news cliffnotes: **pre-generate the advice
once, on a cheap model, store it, and serve it free.**

- Generate the full ranked recommendation set **per traveler archetype** (so the
  model sees all cabins together and keeps the differentiation / tie-breakers).
- One-time cost: **~7¢ per ship on Haiku** (~1¢ on gpt-4o-mini). A whole fleet is
  a one-time dollar or two. Half that on the Batch API.
- Runtime = deterministic cabin selection from the customer's answers + serve the
  matched archetype's pre-written reasoning. A traffic spike costs the same as a
  quiet day: nothing.
- Regenerate only when cabin data or the voice guide changes.

> ⚠️ **REVISIT if this engine takes off.** If real volume/engagement justifies it,
> revisit live *per-person* reasoning on a stronger model (claude-opus-5 produced
> truly bespoke output in testing; archetype pre-generation is the cheap
> approximation). Flagged by Mark 2026-07-26.

## Layout
```
cabin-advisor/
  voice-guide.md              The system prompt — makes it sound like Mark. THE key asset.
  data/
    archetypes.json           ~12 traveler types advice is pre-generated for.
    cabins/<ship>.json         Per-cabin facts (view, obstruction, steadiness, tour, ...).
  advice/<ship>.json          Generated output (served free). Produced by the generator.
  generate-advice.mjs         The batch job: voice + cabins + archetypes -> AI -> advice.
  finder.html                 Working prototype UI (interview -> picks -> tour -> CTA).
```

## Generate
```
ANTHROPIC_API_KEY=... node cabin-advisor/generate-advice.mjs wonder-of-the-seas
```
Crash-proof ladder: Haiku → OpenAI (gpt-4o-mini) → skip. Writes `advice/<ship>.json`.

## Model & voice
- Model: **Claude Haiku 4.5** (near-Opus quality for this, pennies). gpt-4o-mini
  works but is flatter and mis-ranked once in testing.
- Voice: `voice-guide.md`, developed with Mark and anchored to his own rewrite of a
  cabin blurb. Advisory, not salesy; plain words; teaches by contrast; honest.

## Data (the moat) and how it's sourced
Per-cabin facts: deck, position, real ocean vs interior-facing "balcony" (Central
Park / Boardwalk), obstruction incl. **unlabeled** + graded, above/below noise,
YouTube tour. Ethical sourcing only ("whatever we can ethically pull"): public deck
plans, cruiser-knowledge for obstruction, YouTube Data API for tours. DeckMaps is
the cleanest geometry source but was blocked in-tooling; RC's endpoint is
Akamai-walled (do **not** evade). **Full authoritative inventory should come from
Mark's own Cruising Power / agent booking access** — the clean, scalable pipe.
Facts aren't copyrightable; don't rehost artwork.

## Status & next steps
- ✅ Voice guide locked; Wonder sample data (~24 cabins); archetypes; generator;
  generated Wonder advice; prototype UI. (This commit.)
- ▢ Wire `finder.html` to serve the generated advice (replace its template engine).
- ▢ **Launch set = the Oasis class** (Wonder + Symphony + Oasis + Harmony + Allure
  + Utopia) — one shared data model covers all six; per-ship deltas = cabin numbers.
  Mark won't go live with only one ship.
- ▢ Data pipe: pull full cabin inventory from Cruising Power to scale beyond the sample.
- ▢ Productionize: Supabase table, a page on the site, "Get Mark's price" → /api/contact.

Build on dev; Mark approves before prod; never merge dev→main without his GO.
