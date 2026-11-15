// search-scorecard.ts — the Search page's scorecard, shaped for the dashboard.
//
// Mark, 2026-11-15: "put the scorecard on my dashboard and a synopsis of what the
// results mean." The numbers and the synopsis are written by the ops-manager's
// search worker every three days into platform_state "seo-worker"
// (saf-ops-manager agent/seo_worker.py: scorecard(), synopsis()). This module only
// turns that row into what the page draws: four tiles, each with its value in
// words a reader does not have to decode, and how it moved since the last run.
//
// Rules held here (and tested):
//   · a number that could not be measured is shown as "not measured", never as 0;
//   · "X of Y" tiles carry both numbers, so 0 of 24 is not mistaken for nothing checked;
//   · the first reading says so instead of claiming "no change".

export interface ScoreCard {
  at?: string;
  periodDays?: number | null;
  impressions?: number | null;
  clicks?: number | null;
  keyPagesInGoogle?: number | null;
  keyPagesChecked?: number | null;
  recentStoriesFetched?: number | null;
  recentStoriesChecked?: number | null;
}

export interface SeoWorkerState {
  history?: ScoreCard[];
  previous?: ScoreCard | null;
  synopsis?: string[];
  lastRun?: {
    at?: string;
    openAfter?: number;
    closedDead?: number;
    closedDuplicates?: number;
    batchId?: string | null;
    batchItems?: number;
    waitingBatchId?: string | null;
    sortedBy?: string;
    failed?: string[];
  };
}

export interface Tile {
  key: "impressions" | "clicks" | "keyPages" | "stories";
  label: string;
  /** What the page prints large: "125", "40 of 59", or "Not measured". */
  value: string;
  /** One short line under it: "+15 since the last run", "No change since the last run", "First reading". */
  change: string;
  /** up | down | same | none — for the colour of the change line only. */
  direction: "up" | "down" | "same" | "none";
}

export interface ScorecardView {
  /** false until the worker has run once: the page says so instead of drawing zeros. */
  ready: boolean;
  measuredAt: string | null;
  previousAt: string | null;
  periodDays: number;
  tiles: Tile[];
  synopsis: string[];
  /** One sentence on what the worker did and what is waiting. */
  status: string;
  sortedBy: string | null;
  history: { at: string; impressions: number | null; clicks: number | null; keyPages: number | null; stories: number | null }[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function change(now: unknown, before: unknown, hasPrevious: boolean): Pick<Tile, "change" | "direction"> {
  if (!isNum(now)) return { change: "", direction: "none" };
  if (!hasPrevious) return { change: "First reading", direction: "none" };
  if (!isNum(before)) return { change: "Not measured last run", direction: "none" };
  const diff = now - before;
  if (diff === 0) return { change: "No change since the last run", direction: "same" };
  return { change: `${diff > 0 ? "+" : "−"}${Math.abs(diff)} since the last run`, direction: diff > 0 ? "up" : "down" };
}

function tile(
  key: Tile["key"], label: string, now: unknown, of: unknown, before: unknown, hasPrevious: boolean,
): Tile {
  const measured = isNum(now) && (of === undefined || isNum(of));
  const value = !measured ? "Not measured" : of === undefined ? String(now) : `${now} of ${of}`;
  return { key, label, value, ...(measured ? change(now, before, hasPrevious) : { change: "", direction: "none" as const }) };
}

export function statusLine(last: SeoWorkerState["lastRun"]): string {
  if (!last) return "";
  const parts: string[] = [];
  if (last.failed?.length) parts.push(`The last run could not finish: ${last.failed.join(", ")}.`);
  if (last.batchId) parts.push(`A batch of ${last.batchItems ?? "several"} change(s) is waiting for your OK below.`);
  else if (last.waitingBatchId) parts.push("An earlier batch is still waiting for your OK below; no new one was filed.");
  else if (!last.failed?.length) parts.push("No batch was filed this run.");
  const closed = (last.closedDead ?? 0) + (last.closedDuplicates ?? 0);
  if (closed) parts.push(`${closed} stale task(s) were closed.`);
  if (isNum(last.openAfter)) parts.push(`${last.openAfter} task(s) are on the search list.`);
  return parts.join(" ");
}

export function scorecardView(state: SeoWorkerState | null | undefined): ScorecardView {
  const history = Array.isArray(state?.history) ? state!.history!.filter((c) => c && typeof c === "object") : [];
  const card = history.at(-1);
  if (!card) {
    return {
      ready: false, measuredAt: null, previousAt: null, periodDays: 28, tiles: [], synopsis: [],
      status: "The search worker has not run yet. It runs every three days.", sortedBy: null, history: [],
    };
  }
  const prev = history.length > 1 ? history.at(-2)! : null;
  const has = prev !== null;
  const days = isNum(card.periodDays) ? card.periodDays : 28;
  return {
    ready: true,
    measuredAt: card.at ?? null,
    previousAt: prev?.at ?? null,
    periodDays: days,
    tiles: [
      tile("impressions", `Times shown in Google, last ${days} days`, card.impressions, undefined, prev?.impressions, has),
      tile("clicks", `Clicks from Google, last ${days} days`, card.clicks, undefined, prev?.clicks, has),
      tile("keyPages", "Hub and guide pages Google holds", card.keyPagesInGoogle, card.keyPagesChecked, prev?.keyPagesInGoogle, has),
      tile("stories", "Newest story pages Google has fetched", card.recentStoriesFetched, card.recentStoriesChecked, prev?.recentStoriesFetched, has),
    ],
    synopsis: Array.isArray(state?.synopsis) ? state!.synopsis!.filter((s) => typeof s === "string" && s.trim() !== "") : [],
    status: statusLine(state?.lastRun),
    sortedBy: state?.lastRun?.sortedBy ?? null,
    history: history.slice(-20).map((c) => ({
      at: c.at ?? "",
      impressions: isNum(c.impressions) ? c.impressions : null,
      clicks: isNum(c.clicks) ? c.clicks : null,
      keyPages: isNum(c.keyPagesInGoogle) ? c.keyPagesInGoogle : null,
      stories: isNum(c.recentStoriesFetched) ? c.recentStoriesFetched : null,
    })),
  };
}
