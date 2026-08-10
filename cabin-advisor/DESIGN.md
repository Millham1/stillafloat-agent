# Room Engine — locked design

**Read this before touching anything in `cabin-advisor/`.** These decisions were made with
Mark on 2026-07-26/27 and are not open for re-derivation from the code. Reconstructing intent
from artifacts is exactly how this project drifted on 2026-08-10 — a stale test fixture was
mistaken for the input format, and a sampling scheme was proposed that would have thrown away
the entire point of the data capture.

If something here is wrong or has moved on, **change this file in the same commit** as the code.

---

## 1. Scope — final

**7 lines · 42 classes · 138 ships.** Carnival, Royal Caribbean, Norwegian, MSC, Princess,
Celebrity, Margaritaville at Sea.

**Mainstream ocean ships only.** Expedition and luxury outliers are permanently out of scope —
the Celebrity Galápagos trio (Flora, Xpedition, Xploration) was explicitly struck. Mark's
reasoning: *"the luxury/expedition market is a more hands-on group than one who would use this
tool."* They book through a specialist, not a self-serve advisor.

**The build unit is the CLASS, not the ship.** ~138 ships are built from 42 hull classes. Every
Oasis ship shares a layout; every Excel-class Carnival shares one. Build each class once, then
apply to sister ships with per-ship number swaps. This is what makes the campaign finite.

**Completeness over speed. No launch until the lines are built in full — every ship, every
cabin.** Nothing partial gets called done, and there is no clock on it.

## 2. Every cabin. Never a sample.

The advisor reasons over **the complete cabin grid** for a class — 2,886 cabins for Wonder,
61,529 across the 40 classes captured so far. The README says it plainly: generate per traveler
archetype *"so the model sees all cabins together and keeps the differentiation / tie-breakers."*

**Do not sample, cluster, or select "representative" cabins.** The whole reason for the
extraction campaign is that the model can reason across the real inventory. A representative set
defeats the purpose of the work. (Proposed 2026-08-10, rejected immediately.)

If prompt size or cost is a problem, the answer is prompt caching or a batch API — **not**
throwing away cabins.

## 3. Three layers per class

Every class needs all three before it is done:

| Layer | What | Status |
|---|---|---|
| **1. Grid + categories** | Every cabin: number, deck, position, side, category. DeckMaps SVG extraction, proven end-to-end on Wonder (2,886 cabins, 18 categories, zero unknowns). | 40 classes captured |
| **2. Obstruction & context** | **The moat.** Not in DeckMaps — this is the research/reasoning layer. Class-shared, so one pass covers all sisters. | Wonder only |
| **3. Tour links** | YouTube cabin tours per cabin, via the YouTube Data API Mark already has. | Wonder only |

## 4. Layer 2 — obstruction is REASONING, not a boolean

Mark, 2026-08-10: *"the obstruction isn't a classification, it's reasoning, as is the distance
and impact of decks above and below, elevators, I-95, engine rooms and the like."*

And 2026-07-27: *"how bad is the obstruction — can you see the water, just not below?"*

A `true/false` obstructed flag is useless to a customer. What matters is **what kind of
compromise it is and whether they'd care**:

- **Lifeboats** — on Oasis they cantilever from Deck 5, affecting roughly decks 6–8. They block
  the *downward* view but leave a clean horizon. For a couple who want to watch the sea that is
  nearly irrelevant; for someone who wants to look down at the water it is not.
- **Decks above and below** — what is directly overhead and underneath, and how far. Pool deck
  above means 6am chair-scraping. A late-night venue below means bass through the floor. The
  *distance* matters as much as the neighbour.
- **Elevator and stair banks** — foot traffic and door noise; the trade is convenience against quiet.
- **"I-95"** — the crew corridor running the ship's length; cabins near its access points get
  service traffic.
- **Engine rooms / thrusters / anchor** — vibration low and aft, thruster rumble low and forward,
  anchor chain in the bow at every port morning.

These are **per-class geometric facts** that get researched once and reused across sisters.
Position + deck alone cannot produce them; the model must be given the class's real geometry, or
it will invent plausible-sounding noise. Do not let it infer these silently.

## 5. Cost model — the "cliffnotes" pattern

Pre-generate advice **once per class per archetype**, store it, serve it free. **Never call the
LLM live per customer** — that scales cost with traffic.

Runtime = deterministic cabin selection from the customer's answers + serve the matched
archetype's pre-written reasoning. A traffic spike costs the same as a quiet day: nothing.

Model: **Claude Haiku 4.5** (near-Opus quality here for pennies). gpt-4o-mini is the fallback —
flatter, and mis-ranked once in testing. Regenerate only when cabin data or the voice guide
changes.

> **REVISIT if this takes off.** If real volume justifies it, revisit live *per-person* reasoning
> on a stronger model — claude-opus-5 produced truly bespoke output in testing. Archetype
> pre-generation is the cheap approximation. Flagged by Mark 2026-07-26.

## 6. Voice and honesty

`voice-guide.md` is **the key asset** — developed with Mark and anchored to his own rewrite of a
cabin blurb. Advisory, not salesy. Plain words. Teaches by contrast. Honest.

The differentiator over a price-sorter is **tailoring + reasoning + lead capture**: differentiate
each cabin, give honest tie-breakers, and steer people away from bad-fit or quietly-obstructed
cabins. **That honesty is the conversion mechanism** — not a nice-to-have.

**No live pricing** until a paid API exists. The CTA is "Work with Mark" and hands the ship plus
top-3 cabins to the enquiry form.

**Never promise coverage we don't have.** The ship list on the finder is driven by
`/api/cabins/ships`, which returns only ships that actually have advice loaded, so it
structurally cannot over-promise.

## 7. Sourcing ethics

Ethical sourcing only: public deck plans, cruiser knowledge for obstruction, YouTube Data API
for tours. DeckMaps serves its own SVG path fine to `curl` — **no header spoofing, no evading
Akamai walls**. Keep facts, never rehost artwork; delete downloaded source files after
extraction. Facts aren't copyrightable.

The clean long-term pipe is **Mark's own Cruising Power / agent booking access**.

## 8. Known open items

- **Port/starboard is a geometric guess** from the DeckMaps extraction and could be uniformly
  mirrored. Validate against one known cabin before ever telling a customer "port side."
- **`section` is a geometric hull-thirds split**, so it skews "forward" and won't match marketing
  "mid-ship" exactly.
- **Line names are inconsistent** in the captured data — "Royal Caribbean" on three ships,
  "Royal Caribbean International" on four. Normalise or the coverage block splits one brand in two.
- **Princess "Grand" is really three layouts** (1998 original / Caribbean-Crown-Emerald-Ruby /
  Japan-built Diamond-Sapphire). Split it rather than pretend seven ships are identical.
- **Carnival Adventure & Encounter** (ex-P&O) are in the fleet today, but Carnival is exiting
  Australia — revisit if they move or sell.
