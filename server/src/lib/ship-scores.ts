// ship-scores.ts — what cruisers say about each ship, category by category, and what that is worth to
// one particular traveler. Pure functions: no database, no network. routes/cabins.ts reads the rows
// (table ship_cruiser_scores, migration 0076) and hands them here.
//
// WHY (Mark, 2026-11-24): the Conga Line rating is one number per ship. The Vacation Genie places a
// traveler on food, things to do, service, value and so on, so the ship side has to exist per ship AND
// per category. The rows are the category scores cruisers gave each ship on the two review sites.
//
// THREE RULES THE NUMBERS FORCED
//   1. The two sites do not measure alike. One runs about half a point higher across the board, and
//      "children's programs" sits a full point apart fleet-wide. So a score is never used raw: each is
//      read against that same site's fleet average for that same category ("how far above or below the
//      fleet is this ship, on this site, for this thing").
//   2. A handful of reviews is not a verdict. Each site's reading is pulled toward "average" by how few
//      reviews stand behind it (reviews / (reviews + halfTrustReviews)): 5 reviews count for almost
//      nothing, 500 count nearly in full.
//   3. Two sites, one answer: blended by the square root of the review count, the same rule Mark chose
//      for the Conga Line blend on 2026-08-14.
//
//   4. One site alone is not confirmed. A ship that only one site really knows keeps just part of its
//      lead or its deficit (oneSiteShare, half by default); it comes back as the second site's review
//      count climbs to halfTrustReviews, and a ship both sites know is not touched. Mark, 2026-11-25, having sailed Margaritaville Islander: "the food was
//      good, not great... we need to dial down margaritaville". She led the fleet on nearly every topic
//      on the word of one site (459 reviews there, a single review on the other).
//
//   5. Mark's own verdict outranks the reviews. Where he has sailed a ship and says how one thing was,
//      that replaces what the reviewers scored for that ship and that thing ("firsthand" in the dial),
//      the same principle as shipAdjust for the whole ship. First entries, 2026-11-25: Islander's food
//      "good, not great"; MSC Seaside's food better than Islander's, against reviews that put Seaside's
//      food well below the fleet.
//
// The sources stay invisible plumbing. Nothing here is worded for a visitor and no site is ever named
// to one (the rule baked into the Conga Line prompt).

/** One captured row: one ship on one review site. */
export interface CruiserScoreRow {
  ship_slug: string;
  source: string;
  review_count: number;
  categories: Record<string, number>;
}

/** The things we can say about a ship, in our own words. */
export const SCORE_TOPICS = ["dining", "service", "entertainment", "things_to_do", "kids", "value", "cabins", "ship"] as const;
export type ScoreTopic = (typeof SCORE_TOPICS)[number];

/** Which of each site's own categories speak to each topic. More than one = averaged within the site. */
const TOPIC_FIELDS: Record<string, Partial<Record<ScoreTopic, string[]>>> = {
  cruise_critic: {
    dining: ["dining"], service: ["service"], entertainment: ["entertainment"],
    things_to_do: ["fitness_recreation"], kids: ["children_programs", "family"],
    value: ["value"], cabins: ["cabins"], ship: ["public_rooms"],
  },
  cruiseline_com: {
    dining: ["dining"], service: ["service"], entertainment: ["entertainment"],
    things_to_do: ["onboard_activities"], kids: ["children_programs"],
    cabins: ["cabins"], ship: ["ship_quality"],
  },
};

/** Per ship, per topic: rating points above (+) or below (-) the fleet. 0 = fleet average or unknown. */
export type ShipStandings = Map<string, Partial<Record<ScoreTopic, number>>>;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** A site's reading of one topic for one ship (its categories for that topic, averaged), or null. */
function topicValue(row: CruiserScoreRow, topic: ScoreTopic): number | null {
  const fields = TOPIC_FIELDS[row.source]?.[topic];
  if (!fields) return null;
  const xs = fields.map((f) => row.categories?.[f]).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Every ship's standing on every topic, from the captured rows.
 *
 * halfTrustReviews: the review count at which a site's reading counts for half. Rows from a source this
 * file does not know, or with no reviews, are ignored.
 * oneSiteShare: how much of its standing a ship keeps when only one site knows it (rule 4). 1 = no discount.
 */
export function shipStandings(rows: readonly CruiserScoreRow[], halfTrustReviews = 50, oneSiteShare = 0.5): ShipStandings {
  const usable = rows.filter((r) => TOPIC_FIELDS[r.source] && r.review_count > 0);
  // The fleet average per site per topic. Weighted by the same trust as rule 2, so a five-review ship
  // cannot drag the yardstick.
  const fleet = new Map<string, number>();
  for (const source of Object.keys(TOPIC_FIELDS)) {
    for (const topic of SCORE_TOPICS) {
      let sum = 0, w = 0;
      for (const r of usable) {
        if (r.source !== source) continue;
        const v = topicValue(r, topic);
        if (v === null) continue;
        const trust = r.review_count / (r.review_count + halfTrustReviews);
        sum += v * trust; w += trust;
      }
      if (w > 0) fleet.set(`${source}|${topic}`, sum / w);
    }
  }
  const acc = new Map<string, Partial<Record<ScoreTopic, { sum: number; w: number }>>>();
  for (const r of usable) {
    for (const topic of SCORE_TOPICS) {
      const v = topicValue(r, topic);
      const avg = fleet.get(`${r.source}|${topic}`);
      if (v === null || avg === undefined) continue;
      const trust = r.review_count / (r.review_count + halfTrustReviews);
      const say = Math.sqrt(r.review_count);
      const ship = acc.get(r.ship_slug) ?? {};
      const cur = ship[topic] ?? { sum: 0, w: 0 };
      cur.sum += (v - avg) * trust * say; cur.w += say;
      ship[topic] = cur; acc.set(r.ship_slug, ship);
    }
  }
  // Rule 4: the review count on the LESS-reviewed site decides how much of the standing is kept:
  // oneSiteShare with none, all of it from halfTrustReviews upward. A ship both sites know is untouched
  // (a first version scaled by trust instead and quietly shaved thirty well-covered ships).
  const knownSites = Object.keys(TOPIC_FIELDS);
  const countBySite = new Map<string, Map<string, number>>();
  for (const r of usable) {
    const m = countBySite.get(r.ship_slug) ?? new Map<string, number>();
    m.set(r.source, r.review_count);
    countBySite.set(r.ship_slug, m);
  }
  const out: ShipStandings = new Map();
  for (const [slug, topics] of acc) {
    const sites = countBySite.get(slug)!;
    const weaker = Math.min(...knownSites.map((k) => sites.get(k) ?? 0));
    const kept = oneSiteShare + (1 - oneSiteShare) * Math.min(1, weaker / halfTrustReviews);
    const o: Partial<Record<ScoreTopic, number>> = {};
    for (const topic of SCORE_TOPICS) { const c = topics[topic]; if (c && c.w > 0) o[topic] = r3((c.sum / c.w) * kept); }
    out.set(slug, o);
  }
  return out;
}

/**
 * Mark's dial, kept in cabin-advisor/matrix.json under "cruiserScores" (tune the JSON, not this code).
 *   strength          how many matcher points one full rating point above the fleet is worth, on the
 *                     things the traveler cares about (averaged across them; see cruiserFit)
 *   halfTrustReviews  see shipStandings
 *   oneSiteShare      how much of its standing a ship keeps when only one site knows it (see rule 4)
 *   counts            which topic answers for which ship virtue of the traveler's profile
 */
export interface CruiserScoreDial {
  strength: number;
  halfTrustReviews: number;
  oneSiteShare: number;
  counts: Partial<Record<string, ScoreTopic>>;
  /** Mark's firsthand verdicts: ship slug -> topic -> standing (rating points above or below the fleet). Replaces the reviews. */
  firsthand: Record<string, Partial<Record<ScoreTopic, number>>>;
}
export const DEFAULT_DIAL: CruiserScoreDial = {
  strength: 2.5,
  halfTrustReviews: 50,
  oneSiteShare: 0.5,
  counts: { dining: "dining", activity: "things_to_do", family: "kids", warmth: "service", energy: "entertainment", price: "value" },
  firsthand: {},
};

/** Reads the dial out of the matrix file's own object; anything missing or malformed falls back to the default. */
export function readDial(raw: unknown): CruiserScoreDial {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  const counts: Partial<Record<string, ScoreTopic>> = {};
  if (o["counts"] && typeof o["counts"] === "object") {
    for (const [virtue, topic] of Object.entries(o["counts"] as Record<string, unknown>)) {
      if ((SCORE_TOPICS as readonly string[]).includes(topic as string)) counts[virtue] = topic as ScoreTopic;
    }
  }
  // firsthand: { "<ship slug>": { "<topic>": { "standing": 0.25, "why": "..." } } }. A verdict with no
  // "why", an unknown topic or a standing that is not a number is dropped: every verdict carries its reason.
  const firsthand: Record<string, Partial<Record<ScoreTopic, number>>> = {};
  if (o["firsthand"] && typeof o["firsthand"] === "object") {
    for (const [slug, topics] of Object.entries(o["firsthand"] as Record<string, unknown>)) {
      if (!topics || typeof topics !== "object") continue;
      for (const [topic, v] of Object.entries(topics as Record<string, unknown>)) {
        const e = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
        if (!(SCORE_TOPICS as readonly string[]).includes(topic)) continue;
        if (typeof e["standing"] !== "number" || !Number.isFinite(e["standing"])) continue;
        if (typeof e["why"] !== "string" || !e["why"].trim()) continue;
        (firsthand[slug] ??= {})[topic as ScoreTopic] = Math.min(1.5, Math.max(-1.5, e["standing"]));
      }
    }
  }
  return {
    firsthand,
    strength: num(o["strength"], DEFAULT_DIAL.strength, 0, 10),
    halfTrustReviews: num(o["halfTrustReviews"], DEFAULT_DIAL.halfTrustReviews, 1, 1000),
    oneSiteShare: num(o["oneSiteShare"], DEFAULT_DIAL.oneSiteShare, 0, 1),
    counts: Object.keys(counts).length ? counts : DEFAULT_DIAL.counts,
  };
}

/**
 * How much THIS traveler cares about a topic, 0 to 1, read off their profile for the virtue it answers.
 *
 * A virtue is a place on a line (0 to 2), not a wish for quality, so "cares" is how far toward the end
 * that needs the quality they sit: a destination-dining answer (2) cares about food scores in full,
 * a "food is fuel" answer (0.5 or less) not at all. Price runs the other way: the further toward
 * value-first, the more the cruisers' value-for-money score counts. Then scaled by how firmly they
 * answered (the profile's own weight; 1.5 or more = in full).
 */
export function caresAbout(virtue: string, target: number, weight: number): number {
  const lean = virtue === "price" ? (1.5 - target) / 1.5 : (target - 0.5) / 1.5;
  return Math.max(0, Math.min(1, lean)) * Math.max(0, Math.min(1, weight / 1.5));
}

/** A ship's standing as the matcher should see it: the reviews, with Mark's firsthand verdicts laid over them (rule 5). */
export function standingFor(
  slug: string, standings: ShipStandings, dial: CruiserScoreDial,
): Partial<Record<ScoreTopic, number>> | undefined {
  const reviews = standings.get(slug), own = dial.firsthand[slug];
  return own ? { ...(reviews ?? {}), ...own } : reviews;
}

export interface FitPart { virtue: string; topic: ScoreTopic; standing: number; cares: number; points: number }

/**
 * The matcher points a ship earns or loses for how cruisers rate it on the things this traveler cares
 * about, with the working shown (a wrong ship must be traceable).
 */
export function cruiserFit(
  standing: Partial<Record<ScoreTopic, number>> | undefined,
  target: Partial<Record<string, number>>,
  weight: Partial<Record<string, number>>,
  dial: CruiserScoreDial = DEFAULT_DIAL,
): { points: number; parts: FitPart[] } {
  const parts: FitPart[] = [];
  if (!standing) return { points: 0, parts };
  for (const [virtue, topic] of Object.entries(dial.counts)) {
    if (!topic) continue;
    const s = standing[topic];
    if (typeof s !== "number") continue;
    const cares = caresAbout(virtue, target[virtue] ?? 1, weight[virtue] ?? 0);
    if (cares <= 0) continue;
    parts.push({ virtue, topic, standing: s, cares: r3(cares), points: 0 });
  }
  // A ship that is good tends to be good at everything, so adding the topics up would count "a good
  // ship" once per topic and drown the rest of the matcher (measured on the 2026-11-24 capture: a
  // plain sum ran from -3.4 to +4.2, twice the whole-ship rating). So the topics are AVERAGED by how
  // much the traveler cares once they care about more than one thing's worth: the answer is "how does
  // this ship stand on what you care about", not "how many things do you care about".
  const total = parts.reduce((a, p) => a + p.cares, 0);
  const share = dial.strength / Math.max(1, total);
  let points = 0;
  for (const p of parts) { const raw = p.standing * p.cares * share; points += raw; p.points = r3(raw); }
  return { points: r3(points), parts };
}
