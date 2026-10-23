import { logger } from "./logger";
import { readJson, PATHS } from "./persistence";
import { selectFreshStories, type FreshnessRecord } from "./newsletter-freshness";

// dev-news-feeder.ts — keeps the DEV mirror's approved-story pool supplied.
//
// Mark approves stories by hand on prod (the Editorial Queue); on dev nobody does, so the pool went
// stale and the 2026-10-22 Thursday draft was saved with ZERO stories: three release-gate checks went
// red and promotions stopped — the second time (the 2026-10-16 handoff already carried "one dev
// newsletter red"). Mark's 2026-10-04 mirror ruling: dev carries the conditions prod can have, by a
// seed or a feeder, never a waiver. Same pattern as the sink-mode social poster's feeder
// (lib/social-sink.ts pickBatchToFeed): when fewer than MIN_FRESH approved stories are inside the
// newsletter's freshness window, the top candidates from the news agent's own queue are approved
// THROUGH THE NEWS AGENT'S OWN APPROVE ACTION (GET /api/agent-action?action=approve, the same code
// path as Mark's button), so the approved list, the archive, the homepage feed, the news index and
// the story details are all written exactly as on prod — nothing is forged into a store. Only
// candidates with a Spanish twin are picked (the gate holds every approved story to one,
// editorial.approved-stories-for-newsletter). It runs right before the hourly news prerender, so the
// stories' pages exist within the same tick, and it refuses to run on a box whose PUBLIC_URL is the
// production site, so a stray flag on prod can never approve anything.

const PRODUCTION_HOST = /(^|[/.])stillafloatcruising\.com(?=[/:]|$)/i;
/** Approved stories inside the newsletter's window that dev keeps at all times (the letter carries 2–4 quick hits). */
export const MIN_FRESH = 3;
// The same window the newsletter draws from (lib/newsletter.ts).
const STORY_MAX_AGE_HOURS = Number(process.env["NEWSLETTER_STORY_MAX_AGE_HOURS"] ?? "48");
const NEWS_AGENT = process.env["NEWS_AGENT_URL"] ?? "http://127.0.0.1:3003";
// The feeder runs hourly, and the stories it approved together leave the window together. Replacements
// are approved this long BEFORE that, so the pool never dips to zero between two ticks.
const LOOK_AHEAD_HOURS = 2;

export function devNewsFeederEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env["DEV_NEWS_FEEDER"] !== "1") return false;
  const url = env["PUBLIC_URL"] ?? "";
  return url.length > 0 && !PRODUCTION_HOST.test(url);
}

export interface CandidateRecord extends FreshnessRecord {
  id?: unknown;
  status?: unknown;
  title_es?: unknown;
  summary_es?: unknown;
}

const text = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

/**
 * Which candidates the feeder approves next: none while `minFresh` approved stories are still inside
 * the newsletter's window; otherwise the first candidates in the queue's own order (the scan ranks
 * them) that are still undecided, carry a Spanish twin and are not already approved — just enough to
 * reach `minFresh`. Pure.
 */
export function pickStoriesToFeed(
  candidates: CandidateRecord[],
  approved: Array<FreshnessRecord & { id?: unknown }>,
  nowMs: number,
  maxAgeHours: number,
  minFresh = MIN_FRESH,
): string[] {
  const fresh = selectFreshStories(approved, nowMs, maxAgeHours).length;
  if (fresh >= minFresh) return [];
  const approvedIds = new Set(approved.map((s) => String(s.id ?? "")));
  const picks: string[] = [];
  for (const c of candidates) {
    const id = String(c.id ?? "").trim();
    if (!id || approvedIds.has(id) || picks.includes(id)) continue;
    if (c.status !== undefined && c.status !== "candidate") continue; // rejected, held or already decided
    if (!text(c.title_es) || !text(c.summary_es)) continue; // no Spanish twin: the gate would refuse it
    picks.push(id);
    if (picks.length >= minFresh - fresh) break;
  }
  return picks;
}

/** Approve what the pool is short of, through the news agent. Returns the ids it approved. */
export async function feedDevNewsPool(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (!devNewsFeederEnabled()) return [];
  const token = process.env["AGENT_APPROVAL_TOKEN"] ?? "";
  if (!token) {
    logger.warn("dev news feeder: no AGENT_APPROVAL_TOKEN on this box, so nothing can be approved through the news agent");
    return [];
  }
  const [cand, appr] = await Promise.all([
    readJson<{ stories?: CandidateRecord[] }>(PATHS.candidates, { stories: [] }),
    readJson<{ stories?: Array<FreshnessRecord & { id?: unknown }> }>(PATHS.approved, { stories: [] }),
  ]);
  const picks = pickStoriesToFeed(cand.stories ?? [], appr.stories ?? [], Date.now(), STORY_MAX_AGE_HOURS - LOOK_AHEAD_HOURS);
  const done: string[] = [];
  for (const id of picks) {
    const res = await fetchImpl(`${NEWS_AGENT}/api/agent-action?action=approve&id=${encodeURIComponent(id)}`, {
      headers: { "x-affiliate-token": token },
    });
    if (res.ok) done.push(id);
    else logger.warn({ id, status: res.status }, "dev news feeder: the news agent refused this approval (skipped; the next tick tries the next candidate)");
  }
  if (done.length) logger.info({ approved: done.length, ids: done }, "dev news feeder: approved candidates to keep the newsletter's story pool supplied");
  return done;
}
