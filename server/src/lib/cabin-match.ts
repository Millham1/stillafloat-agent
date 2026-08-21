// cabin-match.ts — the deterministic decision layer of the Room Concierge.
//
// WHY THIS FILE EXISTS (2026-08-17). The concierge came off production on
// 8/16 because the matcher was only ever reachable through routes/cabins.ts,
// which needs Supabase and a live LLM call to run. So it was never swept
// against the answer space a real visitor can produce — it was "tested" by
// exercising the twelve archetypes, which cannot reveal that the twelve don't
// cover the answers. Mark found it in ninety seconds by clicking through it.
//
// Everything here is PURE — no network, no database, no clock. cabin-match.test.ts
// walks every combination every question pool can produce, on every ship, and
// asserts the visitor gets what they asked for. That test is the gate now, not
// anyone's assurance that it was checked.
//
// The presentation layer (reasonLive) rewrites the WORDING of a pick. It can
// never change WHICH cabins are picked — that is decided entirely here — which
// is why a complete sweep of selection needs no API calls at all.

// ── The visitor's answers ────────────────────────────────────────────────────

export type CabinType = "inside" | "oceanview" | "balcony" | "suite";

/** Exactly what arrives on the wire, before we've made sense of it. */
export type RawAnswers = {
  party?: string | null;
  room?: string | null;
  budget?: string | null;
  priority?: string | null;
  motion?: boolean | string | null;
};

/** The shape everything downstream is allowed to see. */
export type Answers = {
  party: string | null;
  room: CabinType | null;
  budget: string | null;
  priority: string | null;
  seasick: boolean;
};

/**
 * One place, and only one place, that decides what an answer means.
 *
 * The motion answer has burned us twice in two days, in opposite directions,
 * because two layers each guessed at its type:
 *   8/15  `a.motion ? "steady" : ""`   → every answer is truthy, so EVERYONE
 *                                        was treated as seasick.
 *   8/16  `a.motion === "yes"`         → the page sends a boolean, so a string
 *                                        compare is never true and NOBODY was
 *                                        treated as seasick. The seasick
 *                                        archetype became unreachable, and
 *                                        `tsc` flagged it (TS2367) in a commit
 *                                        that shipped without a typecheck.
 * So: accept every shape a client might legitimately send, collapse it here,
 * and let nothing downstream see the raw value.
 */
export function normalizeAnswers(raw: RawAnswers | null | undefined): Answers {
  const r = raw ?? {};
  return {
    party: clean(r.party),
    room: asCabinType(r.room),
    budget: clean(r.budget),
    priority: clean(r.priority),
    seasick: r.motion === true || r.motion === "yes",
  };
}

function clean(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

function asCabinType(v: unknown): CabinType | null {
  const s = clean(v);
  return s === "inside" || s === "oceanview" || s === "balcony" || s === "suite" ? s : null;
}

// ── Cabin categories → the four types a visitor can ask for ──────────────────
//
// The grid carries the cruise line's own category names, 63,632 of 74,014 rows
// populated. Order matters: a "Grand Suite with Balcony" is a suite, not a
// balcony, so suite is tested first.

// A cabin is not ONE type. It has ATTRIBUTES.
//
// Mark, 2026-08-17: "paradise has balcony cabins. They are suites and there are 10."
// He is right and the old single-label classifier was wrong. It tested `suite`
// first and returned on the first hit, so "Grand Terrace Suite" classified as a
// suite and its terrace vanished — and a visitor asking for a balcony on
// Margaritaville Paradise was told the ship has none, when it has ten. Fleet-wide
// that hid 429 cabins across 24 ships whose own category name says both.
//
// So: a category maps to a SET. A balcony request is satisfied by anything with
// private outdoor space, suite or not. `primaryType` is kept only for wording.
const ATTR_PATTERNS: readonly (readonly [CabinType, RegExp])[] = [
  ["suite", /\b(suite|haven|yacht club|retreat|villa|penthouse|owner'?s)\b/i],
  ["balcony", /(balcon|veranda|terrace|infinite)/i],
  ["inside", /(interior|inside)/i],
  ["oceanview", /(ocean ?view|sea ?view|outside|window|porthole)/i],
];

// Line-specific names carrying no type word. Only UNAMBIGUOUS ones are mapped;
// "Family Harbor", "Cloud 9 Spa" and "Edge Single Stateroom" exist in both
// interior AND balcony variants, so guessing there would repeat the failure that
// took this off production. Unknown is honest; wrong is not.
const ATTR_ALIASES: Readonly<Record<string, readonly CabinType[]>> = {
  studio: ["inside"],                 // NCL solo cabin — interior, no window
  aquaclass: ["balcony"],             // Celebrity — always a veranda category
  "grand terrace suite": ["suite", "balcony"],   // Margaritaville — the Paradise ten
  // Celebrity's Concierge Class is a veranda tier, never sold windowless. Verified against the
  // grid 2026-08-19: all 3,250 rooms carrying the name sit on 14 ships, every one Celebrity.
  "concierge class": ["balcony"],
};

/**
 * Every attribute this category satisfies. Empty set = we do not know.
 *
 * A suite whose NAME does not mention outdoor space (a plain "Junior Suite",
 * "Owner's Suite") cannot be resolved from the string — it is left without the
 * balcony attribute rather than guessed either way, and the caller must treat
 * that as unknown, never as "no balcony".
 */
export function cabinAttributes(category: string | null | undefined): Set<CabinType> {
  const c = clean(category);
  const out = new Set<CabinType>();
  if (!c) return out;
  const alias = ATTR_ALIASES[c.toLowerCase()];
  if (alias) { for (const a of alias) out.add(a); return out; }
  for (const [type, re] of ATTR_PATTERNS) if (re.test(c)) out.add(type);
  // Deliberately NO inference beyond what the name states. A bare "Suite" is not
  // assumed to have an ocean view or a balcony: most do, but "most" is how the
  // 8/16 failure happened. An unstated attribute stays unknown, which the caller
  // reports honestly instead of serving a room the visitor did not ask for.
  return out;
}

/** Does this cabin satisfy what the visitor asked for? */
export function satisfies(category: string | null | undefined, want: CabinType): boolean {
  return cabinAttributes(category).has(want);
}

/**
 * The single label to USE IN WORDING (not for matching). Matching goes through
 * `satisfies`, which is attribute-based.
 */
export function classifyCategory(category: string | null | undefined): CabinType | null {
  const a = cabinAttributes(category);
  if (!a.size) return null;
  for (const t of ["suite", "balcony", "oceanview", "inside"] as CabinType[]) if (a.has(t)) return t;
  return null;
}

/** What types this ship actually HAS, from its stored category counts. */
export function shipTypeInventory(
  categoryCounts: Record<string, number> | null | undefined,
): Record<CabinType, number> & { unknown: number } {
  const out = { inside: 0, oceanview: 0, balcony: 0, suite: 0, unknown: 0 };
  for (const [name, n] of Object.entries(categoryCounts ?? {})) {
    const attrs = cabinAttributes(name);
    const count = Number(n) || 0;
    if (!attrs.size) { out.unknown += count; continue; }
    // counted under EVERY attribute it satisfies — the Paradise ten are both a
    // suite and a balcony, and "does this ship have balconies" must see them.
    for (const t of attrs) out[t] += count;
  }
  return out;
}

// ── Answers → archetype ──────────────────────────────────────────────────────
//
// The twelve archetypes are the traveller types the stored reasoning was
// written for. The archetype no longer decides which cabins are served — it
// only decides whose REASONING is the closest fit among cabins that already
// passed the hard filter below. That inversion is the whole fix.

export const ARCHETYPE_TAGS: Readonly<Record<string, readonly string[]>> = {
  // Deliberately NOT tagged "balcony": it recommends Ocean View cabins, and
  // carrying the balcony tag let it beat the real balcony archetype on a tie —
  // Mark asked for coffee on the balcony and was handed ocean-view rooms (8/16).
  "first-couple-ocean-steady": ["couple", "middle", "ocean", "steady", "oceanview"],
  "couple-ocean-balcony-treat": ["couple", "treat", "ocean", "balcony"],
  "anniversary-suite-splurge": ["couple", "sky", "treat", "space", "suite"],
  "family-action-boardwalk": ["family", "middle", "action", "balcony"],
  "family-value-space": ["family", "lean", "space", "inside", "oceanview"],
  "quiet-retirees-calm": ["couple", "quiet", "middle", "balcony"],
  "value-hunter-ocean": ["lean", "ocean", "oceanview", "inside"],
  "solo-first-value": ["solo", "lean", "inside", "oceanview"],
  "solo-with-group": ["solo-group"],
  "big-group-together": ["group", "space"],
  "experienced-ocean-midship": ["couple", "ocean", "middle", "steady", "balcony"],
  "seasick-priority-steady": ["steady", "quiet"],
};

export function pickArchetype(
  rows: readonly { archetype_id: string }[],
  a: Answers,
): string | null {
  if (!rows.length) return null;
  const want = new Set<string>(
    [a.party ?? "", a.room ?? "", a.budget ?? "", a.priority ?? "", a.seasick ? "steady" : ""].filter(Boolean),
  );
  let best = rows[0]!.archetype_id;
  let bestScore = -1;
  for (const r of rows) {
    const tags = ARCHETYPE_TAGS[r.archetype_id] ?? r.archetype_id.split("-");
    let score = 0;
    for (const t of tags) if (want.has(t)) score += 1;
    // party is the strongest signal — a family must never get a couple's advice
    if (a.party && tags.includes(a.party)) score += 2;
    // the room answer is the cabin-type signal: if they said balcony, they meant it
    if (a.room && tags.includes(a.room)) score += 2;
    // someone who told us they get seasick must not lose the steady archetype
    // to a tie-break — this is the answer with a medical consequence attached
    if (a.seasick && tags.includes("steady")) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = r.archetype_id;
    }
  }
  return best;
}

// ── The hard filter: type first, archetype second ────────────────────────────

export type PoolCabin = {
  cabin: string;
  /**
   * Where the pre-written reasoning put this cabin, when there IS any for it.
   * NOT a gate on eligibility — see selectCabins. Null for the great majority of
   * a ship's rooms, which no archetype was ever written about.
   */
  archetypeId?: string | null;
  rank?: number | null;
  reason?: string | null;
  category: string | null;
  /** Where it sits — needed to answer the seasick question honestly. */
  deck?: number | null;
  section?: string | null;
  side?: string | null;
  /**
   * What is directly above / below THIS room, not its block: "cabins" (a quiet
   * neighbour), "open" (that deck carries no cabin at this spot, so it is public
   * space — pool, buffet, galley, theatre), or "unknown".
   *
   * Derived per room from pos_along (migrations 0019/0020). The researched zones
   * are area facts covering a whole block; this says which rooms inside the block
   * actually have something over them. Measured against the 78 hand-written
   * "above" zones, rooms in one are 2.4x likelier to be "open" — the two agree
   * without either being derived from the other.
   */
  aboveKind?: "cabins" | "open" | "unknown" | null;
  belowKind?: "cabins" | "open" | "unknown" | null;
  /**
   * A fixed noise source within four rooms — "lift lobby", "stairwell" — READ OFF
   * the ship's own deck plan (migration 0021), not computed. Two attempts to
   * derive lobby positions failed, so these are transcribed from the picture and
   * every row records which plan it came from.
   *
   * NULL means nothing has been recorded, NOT that the room is quiet: most decks
   * have not been read yet. So it may push a room DOWN the order and must never
   * be spoken as "this one is quiet".
   */
  noiseNearby?: string | null;
  /**
   * Does this room actually see open sea? (`cabins.real_ocean`, filled 2026-08-19.)
   *
   * A "Central Park Balcony" and a "Boardwalk Balcony" are balconies — `satisfies` is right
   * to serve them for a balcony request — but they face INWARD, into the ship. Someone whose
   * priority is the ocean was being handed one with nothing said, which is the single most
   * damaging thing this tool can get wrong. FALSE is a fact; null only means we could not
   * read the category, and is never held against the room.
   */
  realOcean?: boolean | null;
  /**
   * What our own research says sits in THIS room's view (`cabins.obstruction`), as opposed to
   * the area zones. Free text with a severity lead: "heavy: …", "partial-low: …",
   * "partial-side: …". Null means nothing recorded — NOT that the view is clear.
   */
  obstruction?: string | null;
};

export type SelectOutcome =
  | "no-request"      // they didn't say — anything goes
  | "exact"           // they asked, we served exactly that
  | "ship-has-none"   // a true fact about the ship, not a data gap
  | "none-researched" // the ship has them; we have no reasoned picks yet
  | "type-not-mapped" // we mapped none of that type AND cannot say the ship lacks it
  | "type-unknown"    // we can't tell this ship's cabins apart at all
  | "no-data";        // we hold nothing for this ship — say so, borrow nobody's

export type Selection = {
  picks: PoolCabin[];
  asked: CabinType | null;
  outcome: SelectOutcome;
  /** Cabins dropped because they are not on this ship. Log these; never show them. */
  dropped: string[];
};

/**
 * Choose the cabins to show.
 *
 * THE INVERSION (Mark's call, task acce7482): candidates are hard-filtered to
 * the cabin type the visitor asked for FIRST, and the archetype only orders
 * what survives. Before this, the archetype picked outright — and since the
 * stored picks are themselves mixed-type (the balcony archetype recommends 208
 * balcony cabins and 50 ocean-view ones), even a perfect archetype match could
 * hand a balcony-asker an ocean-view room.
 *
 * The pool is the union of ALL twelve archetypes' picks for the ship, not just
 * the chosen one's, so filtering by type still leaves a real set to rank.
 *
 * Party size is NOT filtered here: `cabins.sleeps` is populated on 23 of 74,014
 * rows, so there is no capacity data to filter against. Party continues to
 * steer the archetype (and therefore the reasoning). Tracked separately.
 */
export function selectCabins(opts: {
  pool: readonly PoolCabin[];
  chosenArchetypeId: string | null;
  answers: Answers;
  inventory: Record<CabinType, number> & { unknown: number };
  /**
   * Every cabin number that actually exists on this ship. REQUIRED in production.
   *
   * The stored advice corpus was written by a model that was asked to name cabins
   * while being shown almost no obstruction data (411 facts across 63,344 cabins),
   * so it invented some: 6 of 3,081 recommended and 10 of 1,506 steer-clear cabin
   * numbers are not on their ship. Cabin numbers are SELECTED from the grid, never
   * AUTHORED — this is where that rule is enforced, so no caller can forget it.
   */
  knownCabins?: ReadonlySet<string>;
  /**
   * This ship's class research. Used for one thing here: keeping a visitor who
   * told us they get seasick out of the parts of the hull that move most.
   *
   * Seasickness cannot be handled at the archetype level — only 3 of the 12
   * archetypes carry a "steady" tag and all 3 are couple-shaped, so party weight
   * beats it and 928 of 3,200 seasick answer sets were landing on advice with no
   * steadiness in it (measured 2026-08-17 across the full sweep). Steadiness is a
   * property of WHERE THE CABIN IS, not of who the traveller is, so it belongs
   * here alongside the cabin-type filter.
   */
  zones?: readonly Zone[];
  /**
   * The cabin kinds the LINE ITSELF says it sells on this hull, from its own
   * published deck plan — NOT from our grid, which is what `inventory` is.
   *
   * This is the only thing that licenses us to say a ship HASN'T GOT something.
   * Null (the default, and most of the fleet) means we hold no such statement,
   * so an absence in our data stays our gap and is never voiced as a fact about
   * the ship. Getting that backwards is expensive in exactly one direction:
   * telling someone a ship lacks the room they want, when it has it, sends them
   * elsewhere — the kind of confident error that took the concierge off
   * production. Saying "I haven't mapped those" when the ship truly has none
   * costs a follow-up email.
   */
  lineTypes?: readonly CabinType[] | null;
  limit?: number;
}): Selection {
  const { chosenArchetypeId, answers, inventory, knownCabins } = opts;
  const limit = opts.limit ?? 5;
  const asked = answers.room;
  const zones = opts.zones ?? [];

  const dropped: string[] = [];
  const pool = knownCabins
    ? opts.pool.filter((c) => knownCabins.has(c.cabin) || (dropped.push(c.cabin), false))
    : opts.pool;

  /**
   * How much this room will move, for someone who told us motion is a problem.
   *
   * WHY THIS IS NOT RESEARCH-GATED — Mark, 2026-08-19: "when the user picks they get seasick
   * the room selection needs to be low and mid-ship." Until now this asked only whether a
   * researched motion zone happened to cover the room, so on a hull with no motion research it
   * did NOTHING: Norwegian Escape served a seasick couple deck 12 aft, then deck 10 forward.
   * Five hull classes have no motion zone, so the one answer with a medical consequence was
   * silently inert on 11 ships.
   *
   * A ship pitches about its centre and rolls about its axis. Low and midship is steadier on
   * EVERY hull — it needs no research, and the deck and section are already in the row. The
   * zones now REFINE this rather than gate it.
   *
   * Lower is steadier. 0 means nothing about this room worries us.
   */
  const decks = pool.map((c) => c.deck).filter((d): d is number => typeof d === "number");
  const lowDeck = decks.length ? Math.min(...decks) : 0;
  const highDeck = decks.length ? Math.max(...decks) : 0;
  const deckSpan = Math.max(highDeck - lowDeck, 1);

  const movesFor = (c: PoolCabin): number => {
    if (!answers.seasick) return 0;
    let m = 0;
    // the ends pitch; midship barely does. normSection, not the raw string:
    // the grid writes both "forward" and "fwd" (240 rooms on the Excel class),
    // and the raw comparison silently exempted every "fwd" bow room from pitch.
    const section = normSection(c.section);
    if (section === "forward" || section === "aft") m += 2;
    else if (section === "mid") m -= 1;
    // height rolls: how far up this ship's own cabin decks the room sits, 0..1
    if (typeof c.deck === "number") m += 2 * ((c.deck - lowDeck) / deckSpan);
    // and only THEN what the research knows about this particular hull
    if (zones.length) {
      const hit = zonesForCabin(
        { deck: c.deck ?? null, section: c.section ?? null, side: c.side ?? null, category: c.category },
        zones,
      ).filter((z) => z.factor === "motion");
      for (const z of hit) {
        // "Deck 5 is a low, mostly-midship deck close to the waterline" is filed under `motion`
        // but is the STEADIEST spot on the hull. A benefit-signed motion zone REDUCES movement.
        const sign = zoneSign(z);
        if (sign === "neutral") continue;
        const w = z.severity === "significant" ? 3 : z.severity === "moderate" ? 2 : 1;
        m += sign === "benefit" ? -w : w;
      }
    }
    return Math.round(m * 100) / 100;
  };

  /**
   * How much the research holds against this room. Lower is better.
   *
   * Selection used to be ordered by which archetype had pre-picked a cabin, which
   * only worked because candidates WERE the pre-picked list. Now that every room
   * on the ship competes (Mark, 2026-08-18: "no preset lists for the advisor"),
   * order has to come from what we actually know about the room — the 478 sourced
   * obstruction zones — or a visitor would be handed whichever cabin sorted first
   * by number.
   *
   * Weighted by what THEY said matters. Someone who came for the view cares that
   * a lifeboat sits outside it; someone who asked for quiet cares about the galley
   * below and the pool deck above. Both are in the zone data, so neither is a guess.
   */
  const NOISE_FACTORS = new Set(["above", "below", "engine", "elevator", "i95", "crew"]);
  const penaltyCache = new Map<string, number>();
  const placementPenalty = (c: PoolCabin): number => {
    const hit = penaltyCache.get(c.cabin);
    if (hit !== undefined) return hit;
    let score = 0;
    if (zones.length) {
      const applicable = zonesForCabin(
        { deck: c.deck ?? null, section: c.section ?? null, side: c.side ?? null, category: c.category },
        zones,
      );
      for (const z of applicable) {
        const sign = zoneSign(z);
        // Descriptive, no verdict either way — it must not move the room in either direction.
        if (sign === "neutral") continue;
        const base = z.severity === "significant" ? 6 : z.severity === "moderate" ? 3 : 1;
        // A zone we are only mildly sure of should not outweigh one we sourced well.
        const trust = z.confidence === "high" ? 1 : z.confidence === "medium" ? 0.7 : 0.4;
        // Research that PRAISES this area — the hump, a clear view past the lifeboat line, a
        // quiet stretch by the elevators. It EARNS its way up rather than being penalised, and
        // is worth double to whoever came for the thing it praises, mirroring the penalty side.
        if (sign === "benefit") {
          const matters = (answers.priority === "ocean" && VIEW_FACTORS.has(z.factor))
                       || (answers.priority === "quiet" && NOISE_FACTORS.has(z.factor));
          score -= 4 * trust * (matters ? 2 : 1);
          continue;
        }
        let weight = 1;
        if (answers.priority === "ocean" && VIEW_FACTORS.has(z.factor)) weight = 2;
        if (answers.priority === "quiet" && NOISE_FACTORS.has(z.factor)) weight = 2;
        score += base * trust * weight;
      }
    }
    // Per-room, not per-block: something other than a cabin directly overhead is
    // the pool deck, the buffet or the theatre, and directly below is usually a
    // galley or crew alleyway. A zone can only say "this block is under the pool";
    // this says which rooms in the block actually are. Weighted hard for someone
    // who asked for quiet, and still counted for everyone else, because the noise
    // is a property of the room rather than of the request.
    if (c.aboveKind === "open") score += answers.priority === "quiet" ? 6 : 2.5;
    if (c.belowKind === "open") score += answers.priority === "quiet" ? 4 : 1.5;

    // A lift lobby or stairwell within four rooms, transcribed from the deck plan.
    // Ranks the room down; never claims the unflagged ones are quiet, because
    // most decks have not been read.
    if (c.noiseNearby) score += answers.priority === "quiet" ? 7 : 3;

    // An inward-facing balcony is still a balcony, so it stays ELIGIBLE — but it must not
    // lead for someone who came for the sea. Only an explicit false counts: null means the
    // category could not be read, and an unknown is never held against a room.
    if (c.realOcean === false) score += answers.priority === "ocean" ? 8 : 2;

    // This room's OWN researched view finding, which the area zones do not carry. Weighted
    // like a view zone: it costs the ocean-seeker double. "heavy:" is a blocked view, the
    // partials crop it.
    if (c.obstruction) {
      const base = /^heavy/i.test(c.obstruction) ? 6 : 3;
      score += base * (answers.priority === "ocean" ? 2 : 1);
    }

    // Deliberately NOT using the grid's `obstructed` flag: it is set on 388 of
    // 225,924 rows, so treating it as a signal would mostly rank on its absence.
    const rounded = Math.round(score * 10) / 10;
    penaltyCache.set(c.cabin, rounded);
    return rounded;
  };

  /**
   * Order the candidates and take the best few.
   *
   * SCORE ONCE, THEN SORT NUMBERS. This used to score inside the comparator and
   * de-duplicate with `findIndex` — O(n²). That was harmless while candidates
   * were the ~45 pre-written picks, but the pool is now every room on the hull
   * (Mark, 2026-08-18: "no preset lists"), so on a 2,000-cabin ship it became
   * ~4M operations per request and pushed the 1.3M-case sweep past ten minutes.
   * Same ordering, O(n log n), with the dedupe done by a Set on the way out.
   */
  const rank = (list: readonly PoolCabin[]) => {
    const scored = list.map((c) => ({
      c,
      // Steadiness outranks everything: someone who said they get seasick should
      // not be led with a bow cabin on deck 17 because some other signal liked it.
      moves: movesFor(c),
      // Then the ship's own facts — what the research says sits around the room.
      // This is what lets EVERY cabin compete, not just pre-picked ones.
      pen: placementPenalty(c),
      // Only then the pre-written reasoning, as a tie-break among equals: a room
      // an advisor already thought about is a slightly safer lead. It orders
      // candidates; it never decides which ones are allowed.
      arch: c.archetypeId && c.archetypeId === chosenArchetypeId ? 0 : c.archetypeId ? 1 : 2,
      rk: c.rank ?? 99,
    }));
    scored.sort((a, b) =>
      a.moves - b.moves || a.pen - b.pen || a.arch - b.arch || a.rk - b.rk ||
      a.c.cabin.localeCompare(b.c.cabin));
    /**
     * Spread the shortlist. Mark, 2026-08-21, looking at Celebrity Ascent:
     * five picks came back 6170 / 6171 / 6163 / 6166 / 6168 — one deck, one
     * category, near-consecutive numbers. That is not five options, it is one
     * option with five numbers, because neighbours score identically on motion
     * and placement and the sort then falls through to cabin number.
     *
     * So take the best of each distinct (deck, category) first, in score order,
     * and only then backfill with runners-up. Ordering is untouched — the best
     * room is still first; we just stop showing it to the visitor five times.
     */
    const out: PoolCabin[] = [];
    const seen = new Set<string>();
    const usedGroup = new Set<string>();
    const groupOf = (c: PoolCabin) => `${c.deck ?? "?"}|${classifyCategory(c.category) ?? c.category ?? "?"}`;
    for (const pass of [0, 1]) {
      for (const s of scored) {
        if (out.length === limit) break;
        if (seen.has(s.c.cabin)) continue;
        const g = groupOf(s.c);
        if (pass === 0 && usedGroup.has(g)) continue;   // first pass: one per deck+type
        seen.add(s.c.cabin);
        usedGroup.add(g);
        out.push(s.c);
      }
      if (out.length === limit) break;
    }
    return out;
  };

  // Two ships in the fleet (Carnival Adventure and Encounter, the ex-P&O "Grand"
  // hulls) have no deck plan sourced at all. Before 2026-08-17 a class-name lookup
  // handed them Grand Princess's cabins. Now they own nothing and we say nothing.
  if (!pool.length) return { picks: [], asked, outcome: "no-data", dropped };

  if (!asked) return { picks: rank(pool), asked: null, outcome: "no-request", dropped };

  const survivors = pool.filter((c) => satisfies(c.category, asked));
  if (survivors.length) return { picks: rank(survivors), asked, outcome: "exact", dropped };

  // Nothing of the requested type survived. Several very different reasons, and
  // the visitor is owed the right one.
  //
  // 2026-08-18 — "ship-has-none" USED TO FIRE ON AN ASSUMPTION WE NEVER HELD.
  // It read `inventory[asked] === 0` as a fact about the ship. But `inventory`
  // comes from cabin_ships.category_counts, which is only ever as complete as
  // whatever our grid extraction happened to capture — so an absence in it means
  // "we didn't map any", not "the ship hasn't got any". Fleet-wide that put a
  // confident falsehood in front of visitors on ~20 ship/type pairs: six Royal-
  // class Princess hulls and Norwegian Aqua/Luna were told they have no ocean-view
  // cabins, and nine Carnival and MSC ships were told they have no suites. All of
  // them sell exactly what we were denying. It is the same shape as the failure
  // that took this tool off production — Mark asked for a balcony and was told a
  // ship that has ten hadn't got one.
  //
  // So absence is now only ever asserted from the LINE'S OWN statement of what it
  // sells on that hull (`lineTypes`, see cabin-advisor/extract-deck-legends.mjs).
  // Without one, we say we haven't mapped any and decline to rule on the ship.
  const knowsItsCabins = inventory.inside + inventory.oceanview + inventory.balcony + inventory.suite > 0;
  const outcome: SelectOutcome = !knowsItsCabins
    ? "type-unknown"
    : inventory[asked] > 0
      ? "none-researched"
      : !opts.lineTypes
        ? "type-not-mapped"
        : opts.lineTypes.includes(asked)
          ? "none-researched"   // the line lists it; we just haven't mapped it
          : "ship-has-none";    // the line's own deck plan lists it nowhere

  return { picks: rank(pool), asked, outcome, dropped };
}

// ── The moat: what sits outside that window ──────────────────────────────────
//
// This is the layer the tool was built for and the one that was never wired up.
// `cabin-advisor/context/*.json` holds 478 sourced obstruction zones across 41
// hull classes — lifeboats, the deck above, engine vibration, hull taper, crew
// corridors. A zone is an AREA fact: these decks, these sections.
//
// Two rules from Mark (2026-08-16) are enforced here, not left to prose:
//   1. Never position this against the cruise line. We report what is outside
//      the window and what to expect — never that anything was mislabelled,
//      hidden or undisclosed.
//   2. Confidence is INTERNAL. It decides how firmly we speak, or whether we
//      speak at all. It is never returned to the client.

export type Zone = {
  factor: string;
  decks: number[];
  sections: string[];
  sides: string[];
  what: string | null;
  effect: string | null;
  /**
   * Spanish (es-419) renderings of what/effect (migration 0026). ES is first-class: this prose
   * is guest-facing, and before these existed the Spanish page quoted English research. Null
   * falls back to EN — a warning in the wrong language beats no warning.
   */
  whatEs?: string | null;
  effectEs?: string | null;
  mattersTo: string | null;
  severity: "minor" | "moderate" | "significant";
  /**
   * The FACTOR is the topic; SIGN is the verdict (migration 0025).
   *
   * 79 of 367 downside-filed zones turned out to say the OPPOSITE of their factor — "midship
   * cabins feel the least motion" filed under `motion`, "heard NOTHING in the cabin itself"
   * filed under `elevator`. The loader recorded the TOPIC of each finding and dropped whether
   * the finding was good or bad, so the advisor penalised rooms its own research recommends.
   * The e2e sweep caught it on msc-magnifica 5063 — the steadiest room on that hull, indicted
   * by its own motion zone.
   *
   * Missing/undefined is read as "penalty", so an un-reviewed zone behaves exactly as before.
   */
  sign?: "penalty" | "benefit" | "neutral";
  confidence: "low" | "medium" | "high";
  source: string;
};

/** The verdict, defaulting to the historical behaviour when a zone has not been reviewed. */
export function zoneSign(z: Pick<Zone, "sign">): "penalty" | "benefit" | "neutral" {
  return z.sign ?? "penalty";
}

export type CabinPlacement = {
  deck: number | null;
  section: string | null;
  side: string | null;
  category: string | null;
};

/** The grid writes both "fwd"/"forward" and "mid"/"midship". Collapse or the join misses. */
export function normSection(s: string | null | undefined): string | null {
  const v = String(s ?? "").trim().toLowerCase();
  if (v === "fwd" || v === "forward") return "forward";
  if (v === "mid" || v === "midship" || v === "middle") return "mid";
  if (v === "aft") return "aft";
  return null;
}

/** Display token for a section. The ES concierge voice uses proa/popa/central. */
export function sectionLabel(s: string | null | undefined, lang: "en" | "es" = "en"): string | null {
  const n = normSection(s);
  if (!n) return null;
  if (lang === "es") return n === "forward" ? "proa" : n === "aft" ? "popa" : "central";
  return n;
}

// A lifeboat cannot block the view from an interior cabin. Applying view zones
// to windowless rooms would produce exactly the kind of confident nonsense that
// took this tool down, so the factors are split by what they physically act on.
// The HUMP IS NOT AN OBSTRUCTION — Mark, 2026-08-19: "drop the hump ... favor the hump".
// It is where the hull steps OUTWARD, and our own research is unambiguous that those balconies
// are the good ones: "extra-large balconies that project far enough to see straight down to the
// sea, escaping the lifeboat-line obstruction" (Royal Princess E101-E109), "noticeably wider
// sightlines, with good views both straight down" (Radiance 7596-7606). Listing it here told
// 13,644 rooms on 64 ships that something may sit in their view, and then printed that text
// underneath — a headline arguing with its own evidence. It is scored as a BONUS below instead.
const VIEW_FACTORS = new Set(["lifeboat", "taper", "obstruction"]);
// `hump` used to be listed here as a hardcoded bonus factor, in TWO places that could drift
// apart. It is no longer special: a hump zone is simply a zone whose SIGN is "benefit", the
// same as the 59 lifeboat/motion/elevator zones whose text turned out to praise their area.

/** Zones that actually apply to this cabin. Order: worst first. */
export function zonesForCabin(cabin: CabinPlacement, zones: readonly Zone[]): Zone[] {
  const deck = cabin.deck;
  const section = normSection(cabin.section);
  const side = String(cabin.side ?? "").trim().toLowerCase() || null;
  const type = classifyCategory(cabin.category);
  if (deck == null) return [];

  const rank = { significant: 0, moderate: 1, minor: 2 } as const;
  return zones
    .filter((z) => {
      if (!z.decks.includes(deck)) return false;
      // a zone with no sections is a whole-deck fact; one with sections needs a match.
      // An unknown section can't be matched, so a sectioned zone is NOT applied —
      // silence beats a guess about someone's actual booked room.
      if (z.sections.length && (!section || !z.sections.includes(section))) return false;
      if (z.sides.length && (!side || !z.sides.includes(side))) return false;
      // view-blocking factors only mean something for a cabin with a window;
      // if we don't know the type, we don't claim the view is affected.
      if (VIEW_FACTORS.has(z.factor) && (type === null || type === "inside")) return false;
      return true;
    })
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export type ViewVerdict = {
  /** null when we have nothing worth saying — silence is a valid answer. */
  headline: string | null;
  detail: string[];
  zones: Zone[];
  /** INTERNAL. Drives how firmly we speak. Never serialise this to a client. */
  confidence: number;
};

const CONF = { high: 0.9, medium: 0.6, low: 0.3 } as const;

/**
 * What we can honestly say about this cabin, given the research.
 *
 * Deliberately conservative: a cabin with no matching zone gets NO all-clear,
 * because the absence of a researched zone is not evidence of a clear view. The
 * tool says nothing rather than something reassuring it can't stand behind.
 */
export function viewVerdict(
  cabin: CabinPlacement,
  zones: readonly Zone[],
  lang: "en" | "es" = "en",
): ViewVerdict {
  // A benefit or neutral zone must never produce a WARNING headline — that was the hump bug,
  // where the headline said "something may sit in your view" and the evidence printed
  // underneath said the balcony sees past the lifeboats.
  const applicable = zonesForCabin(cabin, zones).filter((z) => zoneSign(z) === "penalty");
  const es = lang === "es";
  if (!applicable.length) {
    return { headline: null, detail: [], zones: [], confidence: 0 };
  }
  const worst = applicable[0]!;
  const confidence = CONF[worst.confidence];
  const viewish = applicable.filter((z) => VIEW_FACTORS.has(z.factor));
  const noise = applicable.filter((z) => ["above", "below", "engine", "elevator", "i95"].includes(z.factor));
  const motion = applicable.filter((z) => z.factor === "motion");

  const detail: string[] = [];
  let headline: string | null = null;

  if (viewish.length) {
    headline = es ? "Algo puede aparecer en tu vista" : "Something may sit in your view";
    // Mark's rule 1: describe what is there, never accuse the line of anything.
    detail.push(es
      ? "Por lo que hay afuera de esa ventana, tu vista puede verse afectada. Esto es lo que hay:"
      : "Based on what sits outside that window, your view may be affected. Here's what's there:");
    for (const z of viewish.slice(0, 2)) {
      const t = es ? (z.whatEs ?? z.what) : z.what;
      if (t) detail.push(t);
    }
  }
  if (noise.length) {
    headline ??= es ? "Vale saber qué tienes cerca" : "Worth knowing what's near you";
    for (const z of noise.slice(0, 2)) {
      const t = es ? (z.effectEs ?? z.effect) : z.effect;
      if (t) detail.push(t);
    }
  }
  if (motion.length && !viewish.length && !noise.length) {
    headline = es ? "Notarás más movimiento aquí" : "You'll feel more movement here";
    for (const z of motion.slice(0, 1)) {
      const t = es ? (z.effectEs ?? z.effect) : z.effect;
      if (t) detail.push(t);
    }
  }

  // Thin evidence earns softer language, never a number on the page.
  if (confidence < 0.5) {
    detail.push(es
      ? "Tómalo como una orientación: en este barco la información es parcial."
      : "Treat that as a steer rather than the last word — what we have on this ship is partial.");
  }
  return { headline, detail, zones: applicable, confidence };
}

// ── Saying so, in Mark's voice ───────────────────────────────────────────────
//
// A substitution the visitor isn't told about is the bug. Whenever we serve
// something other than what was asked for, we say why — plainly, without
// blaming the cruise line (Mark, 8/16: "i dont want to piss off the lines").

const TYPE_WORDS: Record<CabinType, { en: string; es: string }> = {
  inside: { en: "interior cabins", es: "camarotes interiores" },
  oceanview: { en: "ocean-view cabins", es: "camarotes con vista al mar" },
  balcony: { en: "balcony cabins", es: "camarotes con balcón" },
  suite: { en: "suites", es: "suites" },
};

export function selectionNote(
  sel: Selection,
  shipName: string,
  lang: "en" | "es" = "en",
): string | null {
  if (sel.outcome === "exact" || sel.outcome === "no-request") return null;
  const es = lang === "es";
  if (sel.outcome === "no-data") {
    return es
      ? `Todavía no tengo los camarotes de ${shipName} cargados, y no voy a mandarte los de otro barco. Dime qué salida te interesa y lo reviso a mano.`
      : `I don't have ${shipName}'s cabins loaded yet, and I'm not going to show you another ship's. Tell me the sailing you're looking at and I'll go through it by hand.`;
  }
  if (!sel.asked) return null;
  const w = TYPE_WORDS[sel.asked][lang];
  switch (sel.outcome) {
    case "ship-has-none":
      return es
        ? `Antes que nada: ${shipName} no tiene ${w}. No es un detalle que se nos escapó — ese barco se construyó así. Esto es lo que sí elegiría a bordo.`
        : `First things first — ${shipName} doesn't have ${w}. That's not something we missed, it's how the ship was built. Here's what I'd pick on it instead.`;
    case "none-researched":
      return es
        ? `${shipName} sí tiene ${w}, pero todavía no he estudiado cuáles valen la pena en ese barco, y no voy a inventarlo. Mientras tanto, estos son los que sí conozco — o dime y lo reviso a mano.`
        : `${shipName} does have ${w} — I just haven't done the room-by-room work on them for this ship yet, and I'm not going to guess. These are the ones I do know. Or say the word and I'll go through them by hand.`;
    case "type-not-mapped":
      // Says what WE are missing, never what the ship is missing. Mark's rule
      // (8/16): the tool reads as helpful, never as a verdict on the line.
      return es
        ? `Todavía no tengo ${w} mapeados en ${shipName}, y no te voy a decir que el barco no los tiene cuando no he revisado cubierta por cubierta. Estos son los que sí puedo respaldar — o dime y lo reviso a mano.`
        : `I haven't got any ${w} mapped on ${shipName} yet — and I'm not going to tell you the ship hasn't got them when I haven't been through it deck by deck. These are the ones I can vouch for. Or say the word and I'll go through it by hand.`;
    case "type-unknown":
      return es
        ? `Todavía no tengo el detalle de categorías de ${shipName}, así que no puedo confirmar cuáles son ${w}. Prefiero decírtelo a mandarte al camarote equivocado.`
        : `I don't have the category detail for ${shipName} yet, so I can't confirm which of these are ${w}. I'd rather tell you that than send you to the wrong room.`;
    default:
      return null;
  }
}

// ── The rooms to walk past ───────────────────────────────────────────────────
//
// REBUILT 2026-08-17 after Mark checked it: "the cabins to stay clear do not
// reflect the category the engine returns as suggested."
//
// The old list was model-authored prose generated per archetype, independently
// of the picks and with no positional data to work from. Measured against the
// grid it was wrong at scale:
//   • 370 of 540 archetype sets warned about a DIFFERENT cabin type than they
//     had just recommended — shown interiors, warned off balconies.
//   • 346 of 1,079 positional claims (32%) contradicted the ship's own grid,
//     including one cabin called "midship" by one archetype and "forward" by
//     another.
//
// So the rules here are absolute:
//   1. Same type the visitor asked for. A skip-list is only useful if it is
//      about the room they are actually choosing between.
//   2. Every fact — deck, section, side, category, what sits outside — is READ
//      from the grid and the sourced research zones. Nothing is authored.
//   3. No reason in the data means no entry. Silence beats invention.
//   4. Never warn about a cabin we just recommended.

export type SteerCandidate = PoolCabin & { category: string | null };

export type SteerEntry = {
  cabin: string;
  deck: number | null;
  section: string | null;
  category: string | null;
  /** Composed from the zone's own sourced text — never model-written. */
  reason: string;
  factor: string;
  severity: "minor" | "moderate" | "significant";
  /** INTERNAL: the source URL behind the claim. Never rendered (Mark, 8/16). */
  source: string;
};

const SEVERITY_RANK = { significant: 0, moderate: 1, minor: 2 } as const;

/**
 * Cabins of the requested type that the research says have a real problem.
 *
 * `candidates` must already be cabins on THIS ship (read from the grid). The
 * caller decides how to fetch them; this function decides which deserve a
 * warning and what the warning may say.
 */
export function buildSteerClear(opts: {
  candidates: readonly SteerCandidate[];
  picked: readonly string[];
  answers: Answers;
  zones: readonly Zone[];
  lang?: "en" | "es";
  limit?: number;
  /**
   * The type actually SHOWN, when it differs from the one asked for.
   *
   * On a ship with no balconies we serve ocean-view substitutes — and a skip-list
   * filtered on "balcony" then returns nothing at all, leaving the visitor with
   * substitutes and no warnings. The list must describe the rooms on screen.
   */
  servedType?: CabinType | null;
}): SteerEntry[] {
  const { candidates, picked, answers, zones } = opts;
  const lang = opts.lang ?? "en";
  const limit = opts.limit ?? 3;
  const asked = opts.servedType ?? answers.room;
  const already = new Set(picked);
  const out: SteerEntry[] = [];

  for (const c of candidates) {
    if (already.has(c.cabin)) continue;                       // rule 4
    if (asked && !satisfies(c.category, asked)) continue;      // rule 1
    // Penalty zones only — the same sign filter the other three verdict paths
    // carry. Without it a benefit-signed hump zone put its PRAISE on a warning
    // card ("the balcony sees straight down to the water" as a reason to skip).
    const hits = zonesForCabin(
      { deck: c.deck ?? null, section: c.section ?? null, side: c.side ?? null, category: c.category },
      zones,
    ).filter((z) => zoneSign(z) === "penalty");
    if (!hits.length) continue;                                // rule 3

    // Motion is kept for EVERY visitor. Mark, 2026-08-17: "riding the bow and
    // feeling every wave are not tied to seasickness. they are legitimate issues
    // depending on where the room is. even if they do not get sick, they will
    // still feel the motion in the bow and stern."
    //
    // Two different things were being conflated. WHERE THE ROOM SITS is a physical
    // fact everyone experiences and deserves to know. SEASICKNESS is a medical
    // concern that is only raised with someone who raised it — that is the rule
    // the voice guide states, and it governs the WORDING, not whether the warning
    // exists. Dropping these warnings (as I briefly did) hid a real downside.
    const relevant = answers.seasick ? hits.find((z) => z.factor === "motion") ?? hits[0]! : hits[0]!;
    // Rule 2: the sentence is assembled from the zone's own sourced wording plus
    // the grid's own position. Nothing here is invented.
    const where = [c.deck != null ? (lang === "es" ? `Cubierta ${c.deck}` : `Deck ${c.deck}`) : null,
                   sectionLabel(c.section, lang)].filter(Boolean).join(" ");
    const body = lang === "es"
      ? (relevant.effectEs ?? relevant.whatEs ?? relevant.effect ?? relevant.what ?? "")
      : (relevant.effect || relevant.what || "");
    out.push({
      cabin: c.cabin, deck: c.deck ?? null, section: normSection(c.section), category: c.category,
      reason: where ? `${where}. ${body}` : body,
      factor: relevant.factor, severity: relevant.severity, source: relevant.source,
    });
  }

  /**
   * Three DIFFERENT problems, or one honest one. Mark, 2026-08-21: "all 3 rooms
   * you said to stay clear of are all on the same deck and all are listed for
   * exactly the same reason." They were: sorting by severity then cabin number
   * hands back the neighbours either side of the worst room, and neighbours share
   * a zone, so all three sentences restate that single zone.
   *
   * A skip-list earns its space by naming distinct things to avoid. So we take
   * the worst room per (factor, deck, section) — a different problem, or the same
   * problem in a different part of the ship — and if the hull only has one real
   * problem we return one line rather than padding to three near-identical ones.
   */
  const ranked = out
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.cabin.localeCompare(b.cabin))
    .filter((e, i, arr) => arr.findIndex((o) => o.cabin === e.cabin) === i);

  const picks: SteerEntry[] = [];
  const usedProblem = new Set<string>();
  for (const e of ranked) {
    if (picks.length === limit) break;
    const key = `${e.factor}|${e.deck ?? "?"}|${e.section ?? "?"}`;
    if (usedProblem.has(key)) continue;
    usedProblem.add(key);
    picks.push(e);
  }
  return picks;
}

/** Decks a zone touches — lets the caller fetch a BOUNDED slice of the grid. */
export function zoneDecks(zones: readonly Zone[]): number[] {
  return [...new Set(zones.flatMap((z) => z.decks))].sort((a, b) => a - b);
}

// ── Letting the model write the warning, without letting it invent one ───────
//
// Mark, 2026-08-17: "use option one as long as it stays within the style and
// voice of the site. facts, mixed with a little fun."
//
// So the model writes the SENTENCE from facts we hand it, and this gate decides
// whether what came back is allowed near a customer. It exists because both
// previous approaches failed in opposite directions: model-authored prose got
// 32% of its positional claims wrong, and raw research text put "a Tripadvisor
// reviewer complained about a herd of elephants" in front of a visitor, quoted a
// deck the cabin isn't on, and ran to 220+ characters.

/** Facts the model is given. It may rephrase these; it may not add to them. */
export type SteerFacts = {
  cabin: string;
  deck: number | null;
  section: string | null;
  category: string | null;
  factor: string;
  severity: "minor" | "moderate" | "significant";
  /** What is physically there, from the sourced research. */
  what: string;
};

// Mark speaks as the advisor from his own knowledge. Naming a site is obviously
// out, but so is hedged attribution ("cruisers consistently report…") — it reads
// like a survey summary, not like him.
const CITES_A_SOURCE = /(tripadvisor|cruise ?critic|reddit|a reviewer|reviewers|forum|poster|thread|blog|(cruisers|guests|passengers|travell?ers|people)\s+(consistently\s+|often\s+|frequently\s+)?(report|complain|say|mention))/i;
const BLAMES_THE_LINE = /(undisclosed|did ?n['’]?t tell|do ?n['’]?t tell|mislabel|misclassif|hid |hiding|they wo ?n['’]?t tell|fails? to disclose)/i;
const BROCHURE = /(best match|perfect for|boasts|nestled|ideally (positioned|situated)|look no further|exactly what you['’]re after)/i;

/**
 * Returns the text if it is safe to show, or null if the model wandered.
 *
 * Rejection is not a failure mode — the caller falls back to a plain composed
 * line. A dull true sentence beats a lively wrong one.
 */
export function validateSteerProse(
  text: string | null | undefined,
  f: SteerFacts,
  /** Other cabins in the same list — naming one of those is fine and reads well. */
  alsoAllowed: readonly string[] = [],
): string | null {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  if (t.length > 220) return null;                       // too long for a card
  if (CITES_A_SOURCE.test(t)) return null;               // research notes, not copy
  if (BLAMES_THE_LINE.test(t)) return null;              // Mark's binding rule, 8/16
  if (BROCHURE.test(t)) return null;                     // the voice guide's banned list
  if (/\d+\s*%|confidence/i.test(t)) return null;        // confidence is internal

  // It may name OUR deck and no other.
  for (const m of t.matchAll(/\bdeck\s+(\d{1,2})\b/gi)) {
    if (f.deck == null || Number(m[1]) !== f.deck) return null;
  }
  // It may name OUR cabin, or another cabin from the same list, and no other.
  //
  // Cabin numbers are not always bare digits: Carnival Elation uses E1/R102/M80,
  // so a digits-only check let an invented letter-prefixed cabin straight through.
  // Deck phrases are removed first so "Deck 10" is never read as cabin 10.
  const allowed = new Set([f.cabin.toUpperCase(), ...alsoAllowed.map((c) => c.toUpperCase())]);
  const withoutDecks = t.replace(/\bdeck\s+\d{1,2}\b/gi, " ");
  for (const m of withoutDecks.matchAll(/\b[A-Z]{0,2}\d{2,5}[A-Z]?\b/gi)) {
    if (!allowed.has(m[0].toUpperCase())) return null;
  }
  return t;
}

// Neutral, customer-safe wording per factor. Used when the research text itself
// is not fit to show — which is often: of the 478 zones, 53 quote a review site,
// 96 run past 220 characters, and 9 name a deck the cabin is not on. The research
// is EVIDENCE; this is the plain way to say what it found.
const FACTOR_LINE: Record<string, { en: string; es: string }> = {
  lifeboat: { en: "A lifeboat sits in the sightline below this one, so the view down is blocked even though the horizon isn't.",
              es: "Un bote salvavidas queda en la línea de visión, así que pierdes la vista hacia abajo aunque el horizonte siga ahí." },
  above:    { en: "There's an activity deck directly overhead, and that noise carries down more than people expect.",
              es: "Justo arriba hay una cubierta de actividades, y ese ruido baja más de lo que la gente espera." },
  below:    { en: "There's a lounge or public room directly underneath, which tends to run later than you'd like.",
              es: "Justo debajo hay un salón o área pública, y suele terminar más tarde de lo que te gustaría." },
  engine:   { en: "You're near the engine spaces here, so expect a low hum and some vibration at night.",
              es: "Estás cerca de la sala de máquinas, así que espera un zumbido bajo y algo de vibración de noche." },
  elevator: { en: "This one sits close to the lifts, which means foot traffic and conversation at odd hours.",
              es: "Queda cerca de los ascensores: paso de gente y conversación a horas raras." },
  i95:      { en: "The crew corridor runs behind this stretch, and it's busiest when you're trying to sleep.",
              es: "El pasillo de la tripulación corre por detrás, y es más activo justo cuando quieres dormir." },
  // Placement, not stomachs — true for every traveller, phrased for the one who
  // never mentioned seasickness.
  motion:   { en: "This is one of the ends of the ship, so you feel the sea working more here than you would midship.",
              es: "Estás en una punta del barco, así que sientes más el trabajo del mar que en el centro." },
  taper:    { en: "The hull narrows here, so the balcony is a shallower slice than the same category elsewhere.",
              es: "El casco se angosta aquí, así que el balcón es más estrecho que en la misma categoría en otra zona." },
  // Said as the good news it is. This line used to hedge — "changes what you can actually
  // see" — while sitting under a headline that called it an obstruction.
  hump:     { en: "The hull steps out along this stretch, so the balcony is deeper than the same category elsewhere and you can see past the lifeboat line straight down to the water.",
              es: "El casco sobresale en este tramo, así que el balcón es más profundo que en la misma categoría en otra zona y puedes ver más allá de los botes, directo al agua." },
  other:    { en: "There's something about this stretch of the ship worth knowing before you commit to it.",
              es: "Hay algo en este tramo del barco que conviene saber antes de decidirte." },
};

/**
 * The plain fallback, used when the model is rejected or unavailable.
 *
 * It must ALWAYS be safe to show — it is the last line of defence, so it can
 * never simply pass the raw research text through. If that text is fit for a
 * customer it is used; otherwise the neutral per-factor sentence is.
 */
export function plainSteerLine(f: SteerFacts, lang: "en" | "es" = "en"): string {
  const where = [f.deck != null ? (lang === "es" ? `Cubierta ${f.deck}` : `Deck ${f.deck}`) : null,
    sectionLabel(f.section, lang)].filter(Boolean).join(" ");
  const raw = (f.what ?? "").trim();
  const rawOk = raw && raw.length <= 180 && !CITES_A_SOURCE.test(raw) && !BLAMES_THE_LINE.test(raw)
    && ![...raw.matchAll(/\b(?:deck|cubierta)\s+(\d{1,2})\b/gi)].some((m) => f.deck == null || Number(m[1]) !== f.deck)
    && ![...raw.matchAll(/\b\d{3,5}[A-Z]?\b/g)].some((m) => m[0] !== f.cabin);
  const body = rawOk ? raw : (FACTOR_LINE[f.factor] ?? FACTOR_LINE["other"]!)[lang];
  return where ? `${where}. ${body}` : body;
}

/** What the model is told it may work with — facts only, never free text. */
export function steerPromptFacts(entries: readonly SteerFacts[]): string {
  return JSON.stringify(entries.map((f) => ({
    cabin: f.cabin, deck: f.deck, section: f.section, category: f.category,
    whatIsThere: f.what, howBad: f.severity,
  })));
}
