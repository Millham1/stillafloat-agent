import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// COMMENTARY TRACTION — is anyone actually arguing about this story?
//
// Mark, 2026-09-04: "find a topic within the week's approved stories that is
// rating high on youtube or cruise media outlets."
//
// The old picker ranked on internal flags alone (featured/pinned/impact), which
// measures what the newsroom thought was important, not what the audience is
// chasing. These signals measure the outside world:
//
//   • YouTube   — how much recent view volume the topic is pulling. On-box via
//                 the existing YOUTUBE_API_KEY.
//   • Outlets   — how many distinct cruise outlets ran the same subject this
//                 week. Derived from the week's own scan, so it costs nothing.
//                 (Note: the per-story `sources` array cannot be used for this —
//                 it is 1 for effectively every story because same-story/two-
//                 source dedup was deferred in August. We cluster titles instead.)
// Semrush was evaluated and REJECTED as a third signal (2026-09-04). Two reasons,
// the second decisive: its API needs a subscription Mark priced as not worth it,
// and — tested through the MCP connector on the real candidates — it structurally
// cannot measure a news story. It reports established MONTHLY search demand, so
// two of six candidates returned NO DATA (the events were days old), and the one
// with the most volume ("royal caribbean labadee", 590/mo) was the weakest topic
// of the week: lowest YouTube traction, a schedule story with no argument in it.
// Search volume measures durable interest, not what people are arguing about now.
//
// EVERY signal is optional and independently degradable. A missing key, a spent
// quota or a timeout drops that signal and renormalises the weights across the
// ones that answered — the Tuesday run must never fail because a third party did.
// A candidate with no signals at all scores 0 and falls back to editorial rank.
// ─────────────────────────────────────────────────────────────────────────────

export interface TractionSignals {
  youtubeViews: number | null;
  youtubeVideos: number | null;
  outletPickup: number;
  score: number; // 0–100, comparable across candidates in the same run
  basis: string; // one line, for Mark's review card
  query?: string; // what was actually searched, so a bad score can be diagnosed
}

const STOP = new Set(
  "the a an and or for of in on at to with after as is are was were over under new more most from by this that its it's you your".split(
    " ",
  ),
);

// Headline verbs and filler. They survive every frequency test — "urges" is rare
// across a week of cruise news — but nobody searches for them, and they crowd out
// the words that identify the story ("Greenland Urges Certain" vs "Greenland
// Fjords Cruise"). Kept deliberately short: only words that are never the subject.
const HEADLINE_FILLER = new Set(
  ("urges confirms cancels announces reveals unveils says said starts launches extends adds " +
    "brings gets sets makes takes plans opens closes calls warns faces sees expects reports " +
    "amid after before certain biggest largest latest another every more most first next " +
    "could would should will can now just still even back down out off through when where " +
    "what which their they them these those than then here there").split(" "),
);

/** The one tokenizer. Phrase-building and document frequency MUST agree, or a word
 *  the frequency map never saw scores as maximally rare and wins every time. */
function contentTokens(title: string): string[] {
  return title
    .replace(/[’']s\b/g, "") // Carnival’s → Carnival
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^\d+$/.test(w)) // bare years/counts
    .filter((w) => w.length > 2)
    .filter((w) => !STOP.has(w.toLowerCase()) && !HEADLINE_FILLER.has(w.toLowerCase()));
}

const normalize = (w: string): string => w.toLowerCase().replace(/s$/, "");

/**
 * A short, searchable phrase for the story: its three most DISTINCTIVE words,
 * left in headline order.
 *
 * Picking the first few capitalised words does not work — cruise headlines are
 * Title Case, so "Royal Caribbean Confirms Labadee Cancellations" yields "Royal
 * Caribbean Confirms", which searches the verb and misses the subject. Ranking
 * by how rare each word is across the week surfaces "Labadee Cancellations
 * Extended" instead, which is what someone would actually type.
 *
 * Without a pool to compare against, falls back to proper nouns.
 */
export function topicPhrase(title: string, pool: Array<Record<string, unknown>> = []): string {
  const tokens = contentTokens(title);
  if (tokens.length === 0) return "";

  if (pool.length > 0) {
    const df = new Map<string, number>();
    for (const s of pool) {
      // Same tokenizer as the phrase, so every word the phrase can pick has a
      // frequency. Set semantics: a word repeated in one headline counts once.
      for (const w of new Set(contentTokens(String(s["title"] ?? "")).map(normalize))) {
        df.set(w, (df.get(w) ?? 0) + 1);
      }
    }
    // Drop only the words that say nothing because they are everywhere this week
    // ("cruise", "ship", and whichever line is dominating the news), then keep
    // headline order. Ranking purely by rarity over-corrects — it discards the
    // brand, and "Carnival Loyalty" is the query a viewer would actually type
    // while "Shakeup History Tomorrow" is not.
    const common = Math.max(3, Math.ceil(pool.length * 0.2));
    const kept = tokens.filter(
      (w) => BRANDS.has(normalize(w)) || (df.get(normalize(w)) ?? 1) <= common,
    );
    // If a headline is nothing but common words, rarity is all we have left.
    const usable = kept.length >= 2 ? kept : tokens;
    return usable.slice(0, 3).join(" ");
  }

  const proper = tokens.filter((w) => /^[A-Z]/.test(w));
  return (proper.length >= 2 ? proper : tokens).slice(0, 3).join(" ");
}

// Words that place a query inside cruising. Without one of these the search
// leaves the domain entirely: a dry run of "Crew Members Arrested" (the Boston
// story's distinctive words) returned a Cyprus ferry disaster, a rapper's
// entourage and an Australian hacking case — 236k views of traction belonging to
// somebody else's story. The domain anchor is not optional.
// Brand names are the highest-value search words there are, and they are also the
// most common words in a cruise-news corpus — so the "drop what is everywhere this
// week" rule deletes exactly the wrong thing. A dry run proved it: the Carnival
// loyalty overhaul became "Shakeup Loyalty History cruise" and returned ZERO
// videos, for a topic cruise YouTube covers heavily. Brands are exempt.
const BRANDS = new Set(
  ("carnival royal caribbean norwegian ncl msc princess celebrity disney holland cunard virgin " +
    "viking oceania regent seabourn silversea windstar azamara costa aida tui aroya explora " +
    "hurtigruten ponant margaritaville").split(" "),
);

// Generic words that place a query inside cruising. Safe to drop from the phrase,
// because searchQuery() re-attaches "cruise" when nothing else anchors it.
const GENERIC_DOMAIN = new Set(
  "cruise cruises cruising ship ships sailing sail shipboard port ports cabin cabins onboard".split(" "),
);

/**
 * The string actually sent to YouTube: the distinctive phrase, kept
 * inside cruising. A phrase that already names a line or a ship is anchored; one
 * that does not gets "cruise" appended.
 */
export function searchQuery(phrase: string): string {
  if (!phrase.trim()) return "";
  const anchored = phrase
    .toLowerCase()
    .split(/\s+/)
    .some((w) => {
      const stem = w.replace(/s$/, "");
      return BRANDS.has(stem) || BRANDS.has(w) || GENERIC_DOMAIN.has(stem) || GENERIC_DOMAIN.has(w);
    });
  return anchored ? phrase : `${phrase} cruise`;
}

function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
      .map((w) => w.replace(/s$/, "")),
  );
}

/**
 * How many DISTINCT outlets ran this subject in the supplied window. The story's
 * own outlet counts as one; others join when their headline is about the same
 * thing.
 *
 * "Same thing" is decided by how RARE the shared words are this week, not by how
 * many there are. A flat two-word threshold missed "Labadee Closure Leaves Port
 * Workers Unpaid" against "Royal Caribbean Extends Labadee Cancellations" — the
 * same story, one shared word. A flat one-word threshold matches every Carnival
 * headline to every other one. So a word shared by only a handful of the week's
 * stories ("labadee") is a match on its own, while a common one ("carnival")
 * still needs a second word beside it.
 *
 * Three outlets on one subject in a week is cruise media chasing it.
 */
export function outletPickup(
  story: Record<string, unknown>,
  weekStories: Array<Record<string, unknown>>,
): number {
  // Document frequency across the week — how ordinary is each word right now.
  const df = new Map<string, number>();
  for (const s of weekStories) {
    for (const w of words(String(s["title"] ?? ""))) df.set(w, (df.get(w) ?? 0) + 1);
  }
  // "Rare" scales with the week: 10% of the pool, never below 2 so a tiny pool
  // (or a test fixture) does not declare every word common.
  const rareMax = Math.max(2, Math.floor(weekStories.length * 0.1));

  const subjectWords = words(String(story["title"] ?? ""));
  const outlets = new Set<string>();
  const own = String(story["source"] ?? "").trim();
  if (own) outlets.add(own.toLowerCase());

  for (const other of weekStories) {
    if (String(other["id"] ?? "") === String(story["id"] ?? "")) continue;
    const src = String(other["source"] ?? "").trim();
    if (!src) continue;

    const shared: string[] = [];
    for (const w of words(String(other["title"] ?? ""))) if (subjectWords.has(w)) shared.push(w);
    const sharedRare = shared.filter((w) => (df.get(w) ?? 0) <= rareMax);

    if (shared.length >= 2 || sharedRare.length >= 1) outlets.add(src.toLowerCase());
  }
  return outlets.size;
}

// ── YouTube ──────────────────────────────────────────────────────────────────
// search.list (100 quota units) + videos.list (1) per candidate. Six candidates
// a week is ~600 of the 10,000/day default quota.
export async function youtubeTraction(
  phrase: string,
  windowDays = 14,
): Promise<{ views: number; videos: number } | null> {
  const key = process.env["YOUTUBE_API_KEY"];
  if (!key || !phrase.trim()) return null;

  const publishedAfter = new Date(Date.now() - windowDays * 24 * 3600_000).toISOString();
  try {
    const searchUrl =
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video` +
      `&order=viewCount&maxResults=10&relevanceLanguage=en` +
      `&publishedAfter=${encodeURIComponent(publishedAfter)}` +
      `&q=${encodeURIComponent(phrase)}&key=${key}`;
    const sRes = await fetch(searchUrl, { signal: AbortSignal.timeout(15_000) });
    if (!sRes.ok) throw new Error(`search HTTP ${sRes.status}`);
    const sJson = (await sRes.json()) as { items?: { id?: { videoId?: string } }[] };
    const ids = (sJson.items ?? []).map((i) => i.id?.videoId).filter(Boolean) as string[];
    if (ids.length === 0) return { views: 0, videos: 0 };

    const vRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.join(",")}&key=${key}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!vRes.ok) throw new Error(`videos HTTP ${vRes.status}`);
    const vJson = (await vRes.json()) as { items?: { statistics?: { viewCount?: string } }[] };
    const views = (vJson.items ?? []).reduce(
      (n, v) => n + Number(v.statistics?.viewCount ?? 0),
      0,
    );
    return { views, videos: ids.length };
  } catch (error) {
    logger.warn({ err: (error as Error).message, phrase }, "Commentary traction: YouTube signal unavailable");
    return null;
  }
}

// ── combining ────────────────────────────────────────────────────────────────
// Log scales, because view counts and search volumes are long-tailed: the gap
// between 1k and 10k matters as much as 100k to 1M.
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Weighted blend over whichever signals answered. Weights renormalise across the
 * present signals, so a YouTube outage cannot quietly cap every score at 40%.
 */
export function combineSignals(input: {
  youtubeViews: number | null;
  outletPickup: number;
}): number {
  const parts: { weight: number; value: number }[] = [];
  if (input.youtubeViews !== null) {
    parts.push({ weight: 0.6, value: clamp01(Math.log10(1 + input.youtubeViews) / 6) }); // 1M ≈ 1.0
  }
  // Outlet pickup always answers — it is computed from data we already hold.
  parts.push({ weight: 0.4, value: clamp01((input.outletPickup - 1) / 3) }); // 4+ outlets ≈ 1.0

  // Weights renormalise over whoever answered, so a YouTube outage cannot quietly
  // cap every score — the ranking stays comparable within the run.
  const totalWeight = parts.reduce((n, p) => n + p.weight, 0);
  if (totalWeight === 0) return 0;
  return Math.round((parts.reduce((n, p) => n + p.weight * p.value, 0) / totalWeight) * 100);
}

export function describeSignals(s: Omit<TractionSignals, "score" | "basis">): string {
  const bits: string[] = [];
  if (s.youtubeViews !== null) {
    bits.push(
      s.youtubeVideos
        ? `${s.youtubeViews.toLocaleString()} YouTube views across ${s.youtubeVideos} recent videos`
        : "no recent YouTube coverage",
    );
  }
  bits.push(
    s.outletPickup > 1 ? `${s.outletPickup} cruise outlets ran it` : "one outlet so far",
  );
  return bits.join(" · ");
}

/**
 * Score one candidate. Signals are fetched in parallel and every one of them is
 * allowed to fail.
 */
export async function scoreCandidate(
  story: Record<string, unknown>,
  weekStories: Array<Record<string, unknown>>,
  suppliedQuery?: string,
): Promise<TractionSignals> {
  // A written query beats a derived one by orders of magnitude — measured, not
  // assumed: "Carnival Loyalty" returned 290k views of on-topic coverage where the
  // heuristic's "Shakeup Carnival Loyalty" returned 8. Knowing that "loyalty" is
  // the word people search and "shakeup" is not is judgement, so the caller passes
  // one in. The heuristic stays as the fallback for when that call fails.
  const query =
    suppliedQuery?.trim() ||
    searchQuery(topicPhrase(String(story["title"] ?? ""), weekStories));
  const yt = await youtubeTraction(query);
  const pickup = outletPickup(story, weekStories);

  const base = {
    youtubeViews: yt ? yt.views : null,
    youtubeVideos: yt ? yt.videos : null,
    outletPickup: pickup,
  };
  return {
    ...base,
    query,
    score: combineSignals({ youtubeViews: base.youtubeViews, outletPickup: pickup }),
    basis: describeSignals(base),
  };
}
