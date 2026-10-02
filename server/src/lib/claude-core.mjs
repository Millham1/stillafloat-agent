// claude-core.mjs — the rules every Claude call in this repo obeys.
//
// Plain JavaScript on purpose: the server imports it through llm.ts (esbuild
// bundles it), and the cabin-advisor scripts import it with a bare `node x.mjs`.
// One copy of the rules, so a script cannot drift from the server.
// The Python scripts carry the same rules in cabin-advisor/claude_bulk.py.
//
// THREE RULES, all decided by Mark on 2026-10-02 ("do both"):
//
// 1. MODEL. The workhorse is Claude Sonnet 5.5 (`claude-sonnet-5-5`). Checked on
//    platform.claude.com/docs/en/about-claude/pricing the same day: identical per-token
//    prices to Sonnet 5 — $2 in / $10 out per million tokens, $2.50 5-minute cache
//    write, $4 1-hour write, $0.20 cache read, $1 / $5 on the Batch API. The cheap
//    model stays Claude Haiku 4.5.
//
// 2. JOB TAG. Every request carries metadata.user_id = "site:<job>", so the Console's
//    Logs page attributes each call. The tags are listed in llm-jobs.json; an unlisted
//    tag is refused here before anything is sent.
//
// 3. BULK RUNS. A run that will make more than BULK_MIN_CALLS calls (retries counted),
//    or whose unbatched ceiling is over BULK_MIN_DOLLARS, must:
//      a. print a cost estimate before anything is sent (tokens x calls x price, with
//         every retry counted in the ceiling);
//      b. go through the Message Batches API (50% off) — or carry an explicit
//         --no-batch "<reason>", which is printed and written to the audit log — and
//         mark any content of 1,024+ tokens that repeats across calls with
//         cache_control in a prefix that is identical across calls;
//      c. carry --approved-cost <dollars> at or above the ceiling, i.e. Mark's quoted yes.
//    runBulk() does all of it, so a script gets batching, caching and the gate for free.
//
// WHY N = 20. Every live job in the server makes fewer than 20 calls in one pass
// (the hub classifier's batches of 15 stories, the storm-intel summaries, a weekly
// newsletter), while every run that has hurt the bill was far above it: the Aura advice
// regeneration (~75 calls, 2026-09-14), apply-leads (33), zone-polarity (40), the Carnival
// geometry vision reads (hundreds, $91 on 2026-08-19..21). Below 20 calls the Batch API's
// wait (minutes, up to a day) costs more than the half-price saves; above it the saving is
// real money. WHY $2: a handful of calls with a 100K-token context costs dollars without
// ever reaching 20 calls — the Aura grid was 110K tokens per call — and $2 is the point at
// which Mark has asked for a quote before (mark-quote-cost-before-paid-runs).

import JOBS from "./llm-jobs.json" with { type: "json" };
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const API_BASE = "https://api.anthropic.com/v1";
export const API_VERSION = "2023-06-01";

export const MODELS = Object.freeze({
  DEFAULT: "claude-sonnet-5-5",
  CHEAP: "claude-haiku-4-5",
});

export const BULK_MIN_CALLS = 20;
export const BULK_MIN_DOLLARS = 2;
export const CACHE_MIN_SHARED_TOKENS = 1024;

/** Assumptions the "expected" figure rests on; the ceiling assumes none of them. */
export const ASSUME = Object.freeze({
  // Batch cache hits are best-effort: the batch docs quote 30%-98%. Take the low end.
  batchCacheHitRate: 0.3,
  // Sequential calls inside the 5-minute window hit almost every time.
  syncCacheHitRate: 0.9,
  // Share of calls that need a second attempt when a script re-rolls or retries.
  retryRate: 0.25,
});

/**
 * $ per million tokens, first-party Claude API, from the pricing page on 2026-10-02.
 * Batch API = 50% of every line; cache multipliers stack on top of it.
 */
export const PRICES = Object.freeze({
  "claude-sonnet-5-5": { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, write5m: 5, write1h: 8, read: 0.2 },
  "claude-opus-5": { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 },
});
export const BATCH_FACTOR = 0.5;
export const WEB_SEARCH_DOLLARS = 0.01; // $10 per 1,000 searches

/** Below these a cache_control marker is accepted by the API but caches nothing. */
export const CACHE_MIN_PREFIX_TOKENS = Object.freeze({
  "claude-sonnet-5-5": 512,
  "claude-opus-5-5": 512,
  "claude-opus-5": 512,
  "claude-sonnet-5": 1024,
  "claude-sonnet-4-6": 1024,
  "claude-haiku-4-5": 4096,
});

// ── models ───────────────────────────────────────────────────────────────────

/** "anthropic.claude-haiku-4-5-20251001" -> "claude-haiku-4-5". */
export function canonicalModel(model) {
  return String(model ?? "").replace(/^anthropic\./, "").replace(/-\d{8}$/, "");
}

export function priceFor(model) {
  const p = PRICES[canonicalModel(model)];
  if (!p) {
    throw new Error(`No price on file for model "${model}" — add it to PRICES in claude-core.mjs before running it in bulk`);
  }
  return p;
}

/**
 * Sonnet 5.5, Opus 5.5 and Fable/Mythos 5.1 return a 400 for tool_choice "any"/"tool".
 * Haiku 4.5 and Sonnet 5 still accept a forced tool call.
 */
export function rejectsForcedToolChoice(model) {
  return /^claude-(?:(?:sonnet|opus)-5-[5-9]|(?:fable|mythos)-5-[1-9])(?:$|-)/.test(canonicalModel(model));
}

/** temperature / top_p / top_k are a hard 400 on every Claude 5 model (and Opus 4.7/4.8). */
export function rejectsSampling(model) {
  return /^claude-(?:(?:sonnet|opus|fable|mythos)-5|opus-4-[78])(?:$|-)/.test(canonicalModel(model));
}

/**
 * `thinking: {type: "between_tools"}` is Sonnet 5.5's thinking-off switch ("disabled" is a
 * 400 there) and no other model accepts it.
 */
export function supportsBetweenTools(model) {
  return canonicalModel(model) === "claude-sonnet-5-5";
}

/**
 * How to get exactly one structured answer out of `model` through a tool named `toolName`.
 *
 * Where a forced tool call is still accepted it is used, unchanged. Where it is a 400
 * (Sonnet 5.5) the call becomes tool_choice "auto" with at most one call, an explicit
 * instruction to answer through the tool, and thinking off — Sonnet 5 never thought
 * during a forced tool call, and the max_tokens budgets in this repo were sized for the
 * answer alone. The caller must check that a tool call came back and retry once if not.
 */
export function structuredCallShape(model, toolName) {
  if (!rejectsForcedToolChoice(model)) {
    return { tool_choice: { type: "tool", name: toolName }, instruction: "", forced: true };
  }
  const shape = {
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    instruction: `Give your answer by calling the ${toolName} tool exactly once. Do not answer in prose.`,
    forced: false,
  };
  if (supportsBetweenTools(model)) shape.thinking = { type: "between_tools" };
  return shape;
}

// ── job tags ─────────────────────────────────────────────────────────────────

export class JobTagError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobTagError";
  }
}

export function registeredJobs(service = "site") {
  return Object.keys(JOBS[service] ?? {});
}

/** "site:cabin.advice". Throws on a missing or unregistered tag — nothing is sent untagged. */
export function jobUserId(job, service = "site") {
  if (typeof job !== "string" || !job.trim()) {
    throw new JobTagError("Every Claude request needs a job tag (e.g. \"cabin.advice\") so the Console can attribute it");
  }
  const table = JOBS[service];
  if (!table) throw new JobTagError(`Unknown service "${service}" for a job tag`);
  if (!Object.prototype.hasOwnProperty.call(table, job)) {
    throw new JobTagError(`Job tag "${job}" is not registered — add it to server/src/lib/llm-jobs.json`);
  }
  return `${service}:${job}`;
}

/** A copy of `body` carrying metadata.user_id for `job`. */
export function withJobTag(body, job, service = "site") {
  return { ...body, metadata: { ...(body.metadata ?? {}), user_id: jobUserId(job, service) } };
}

/**
 * Refuse, before it costs a round trip, any request the API would reject or that would
 * reach the Console untagged.
 */
export function assertRequestAllowed(body) {
  const model = body?.model;
  if (!model) throw new Error("Claude request has no model");
  if (!body.metadata?.user_id) {
    throw new JobTagError("Claude request has no job tag (metadata.user_id) — use withJobTag()");
  }
  if (rejectsSampling(model)) {
    for (const k of ["temperature", "top_p", "top_k"]) {
      if (k in body) throw new Error(`${k} is rejected by ${model} (a hard 400) — remove it`);
    }
    if (body.thinking && body.thinking.budget_tokens !== undefined) {
      throw new Error(`thinking.budget_tokens is rejected by ${model} — use adaptive thinking or effort`);
    }
  }
  if (rejectsForcedToolChoice(model) && ["any", "tool"].includes(body.tool_choice?.type)) {
    throw new Error(`${model} rejects a forced tool_choice ("${body.tool_choice.type}") — use structuredCallShape()`);
  }
  if (supportsBetweenTools(model) && body.thinking?.type === "disabled") {
    throw new Error(`${model} rejects thinking "disabled" — use { type: "between_tools" }`);
  }
}

// ── token estimates (offline, deliberately generous) ─────────────────────────

/** ~3 characters per token: English prose runs ~4, JSON and numbers ~2.5-3. Round up. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 3);
}
/** A 1568px image is ~1,600 tokens; newer models read larger images. Assume more. */
export const IMAGE_TOKENS = 3000;
/** The tool-use system prompt plus definition overhead, per request with tools. */
export const TOOL_OVERHEAD_TOKENS = 600;
const UNIT_CHARS = 2000;

function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => k !== "cache_control").sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function digest(s) {
  return createHash("sha1").update(s).digest("hex");
}

/** Text a block contributes to the prompt, or null for non-text (images, documents). */
function blockText(block) {
  if (typeof block === "string") return block;
  if (block?.type === "text") return String(block.text ?? "");
  if (block?.type === "tool_result") {
    const c = block.content;
    return typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => blockText(x) ?? "").join("\n") : "";
  }
  return null;
}

/** Comparison units: text split into lines (long lines into 2,000-char pieces). */
function textUnits(text) {
  const units = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    for (let i = 0; i < line.length; i += UNIT_CHARS) {
      const piece = line.slice(i, i + UNIT_CHARS);
      units.push({ key: digest(piece), tokens: estimateTokens(piece), sample: piece });
    }
  }
  return units;
}

/**
 * The prompt in the order the API renders it — tools, then system, then messages — as a
 * list of blocks, each with a stable key (cache markers excluded), a token estimate,
 * whether it carries a cache_control marker, and its comparison units.
 */
export function renderBlocks(params) {
  const blocks = [];
  const push = (where, block, cached) => {
    const text = blockText(block);
    if (text !== null) {
      blocks.push({ key: digest(`${where}|${text}`), tokens: estimateTokens(text), cached, units: textUnits(text) });
    } else {
      const raw = stableJson(block);
      const isImage = block?.type === "image";
      const tokens = isImage ? IMAGE_TOKENS : estimateTokens(raw);
      const key = digest(`${where}|${raw}`);
      blocks.push({ key, tokens, cached, units: [{ key, tokens, sample: `[${block?.type ?? "block"}]` }] });
    }
  };
  for (const tool of params.tools ?? []) {
    const raw = stableJson(tool);
    const key = digest(`tool|${raw}`);
    const tokens = estimateTokens(raw);
    blocks.push({ key, tokens, cached: Boolean(tool.cache_control), units: [{ key, tokens, sample: `[tool ${tool.name ?? tool.type}]` }] });
  }
  const sys = params.system;
  if (typeof sys === "string" && sys) push("system", { type: "text", text: sys }, false);
  else if (Array.isArray(sys)) for (const b of sys) push("system", b, Boolean(b?.cache_control));
  for (const m of params.messages ?? []) {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    for (const b of content) push(m.role, b, Boolean(b?.cache_control));
  }
  return blocks;
}

/**
 * Which content repeats across calls, and how much of it is NOT inside a cached prefix.
 *
 * A cache_control marker only pays when everything up to it is byte-identical across
 * calls, so the cached region is the blocks up to the last marker — and only if that
 * run of blocks is the same in every request. Content that repeats outside it (the
 * 110K-token cabin grid pasted after a different traveler line in every archetype
 * prompt, 2026-09-14) is billed in full on every call; that is what the rule refuses.
 */
export function analyseRequests(paramsList) {
  const rendered = paramsList.map(renderBlocks);
  const n = rendered.length;
  let common = n ? Math.min(...rendered.map((r) => r.length)) : 0;
  for (let i = 0; i < common; i++) {
    const k = rendered[0][i].key;
    if (!rendered.every((r) => r[i].key === k)) { common = i; break; }
  }
  const problems = [];
  const cachedUpTo = rendered.map((blocks, ri) => {
    let last = -1;
    blocks.forEach((b, i) => { if (b.cached) last = i; });
    if (paramsList[ri].cache_control && last < 0) last = common - 1; // top-level automatic caching
    if (last >= 0 && last >= common && n > 1) {
      problems.push(`request ${ri}: a cache_control marker sits after content that differs between calls, so it can never be read back`);
      return -1;
    }
    return last;
  });

  const seenIn = new Map();
  rendered.forEach((blocks) => {
    const mine = new Set();
    for (const b of blocks) for (const u of b.units) mine.add(u.key);
    for (const k of mine) seenIn.set(k, (seenIn.get(k) ?? 0) + 1);
  });

  let maxShared = 0;
  let worst = null;
  const perRequest = rendered.map((blocks, ri) => {
    let input = 0, cached = 0, shared = 0;
    let biggest = null;
    blocks.forEach((b, i) => {
      input += b.tokens;
      if (i <= cachedUpTo[ri]) { cached += b.tokens; return; }
      for (const u of b.units) {
        if ((seenIn.get(u.key) ?? 0) >= 2) {
          shared += u.tokens;
          if (!biggest || u.tokens > biggest.tokens) biggest = u;
        }
      }
    });
    if (paramsList[ri].tools?.length) input += TOOL_OVERHEAD_TOKENS;
    if (shared > maxShared) { maxShared = shared; worst = biggest; }
    return { inputTokens: input, cachedPrefixTokens: cached, sharedUncachedTokens: shared };
  });
  return {
    perRequest,
    maxSharedUncachedTokens: maxShared,
    sharedSample: worst ? worst.sample.slice(0, 80) : "",
    problems: [...new Set(problems)].slice(0, 5),
  };
}

// ── the estimate ─────────────────────────────────────────────────────────────

function webSearchUses(params) {
  let uses = 0;
  for (const t of params.tools ?? []) {
    if (String(t.type ?? "").startsWith("web_search")) uses += Number(t.max_uses ?? 10);
  }
  return uses;
}

/**
 * Dollars for one pass over `paramsList`, ceiling and expected.
 *
 * CEILING: every call writes its cached prefix and never reads it back, every call
 * spends its whole max_tokens (thinking included), every search allowed is made, and
 * every attempt is used. A run cannot cost more than this.
 * EXPECTED: the first call writes the cache, later ones hit it at ASSUME's rate;
 * output at `expectedOutputTokens` when the caller knows its typical answer length;
 * ASSUME.retryRate of the extra attempts used.
 */
export function estimateRun({ paramsList, analysis, attempts = 1, batch, cacheTtl = "5m", expectedOutputTokens }) {
  const a = analysis ?? analyseRequests(paramsList);
  const factor = batch ? BATCH_FACTOR : 1;
  const hit = batch ? ASSUME.batchCacheHitRate : ASSUME.syncCacheHitRate;
  let ceiling = 0, expected = 0, inputTokens = 0, cachedTokens = 0, outputCeiling = 0;
  const notCaching = new Set();
  paramsList.forEach((params, i) => {
    const p = priceFor(params.model);
    const r = a.perRequest[i];
    const minCache = CACHE_MIN_PREFIX_TOKENS[canonicalModel(params.model)] ?? 1024;
    const cached = r.cachedPrefixTokens >= minCache ? r.cachedPrefixTokens : 0;
    if (r.cachedPrefixTokens && !cached) notCaching.add(`${canonicalModel(params.model)} caches nothing under ${minCache} tokens`);
    const uncached = r.inputTokens - cached;
    const write = cacheTtl === "1h" ? p.write1h : p.write5m;
    const outCeil = Number(params.max_tokens ?? 4096);
    const outExp = Math.min(outCeil, Number(expectedOutputTokens ?? outCeil));
    const searches = webSearchUses(params) * WEB_SEARCH_DOLLARS;
    const readOrWrite = i === 0 ? write : hit * p.read + (1 - hit) * write;
    ceiling += ((uncached * p.input + cached * write + outCeil * p.output) / 1e6) * factor + searches;
    expected += ((uncached * p.input + cached * readOrWrite + outExp * p.output) / 1e6) * factor + searches;
    inputTokens += r.inputTokens;
    cachedTokens += cached;
    outputCeiling += outCeil;
  });
  return {
    batch: Boolean(batch),
    calls: paramsList.length,
    maxCalls: paramsList.length * attempts,
    attempts,
    inputTokens,
    cachedTokens,
    outputCeilingTokens: outputCeiling,
    ceiling: round2(ceiling * attempts),
    expected: round2(expected * (1 + ASSUME.retryRate * (attempts - 1))),
    notes: [...notCaching],
  };
}

function round2(x) {
  return Math.ceil(x * 100) / 100;
}

function money(x) {
  return `$${x.toFixed(2)}`;
}

// ── the gate ─────────────────────────────────────────────────────────────────

export class BulkRuleError extends Error {
  /** rule: "cache" | "batch" | "approval" | "budget" */
  constructor(rule, message) {
    super(message);
    this.name = "BulkRuleError";
    this.rule = rule;
  }
}

/** Parse --approved-cost <dollars> and --no-batch "<reason>" (either "--x v" or "--x=v"). */
export function bulkFlags(argv = process.argv) {
  const value = (name) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) {
      const v = argv[i + 1];
      return v === undefined || v.startsWith("--") ? "" : v;
    }
    return undefined;
  };
  const cost = value("approved-cost");
  const reason = value("no-batch");
  let approvedCost;
  if (cost !== undefined) {
    approvedCost = Number(cost);
    if (!Number.isFinite(approvedCost) || approvedCost <= 0) {
      throw new BulkRuleError("approval", `--approved-cost must be a dollar amount, got "${cost}"`);
    }
  }
  if (reason !== undefined && !reason.trim()) {
    throw new BulkRuleError("batch", "--no-batch needs a reason in quotes, e.g. --no-batch \"re-reading 3 tiles while Mark watches\"");
  }
  return { approvedCost, noBatchReason: reason };
}

export function defaultAuditPath() {
  return process.env["LLM_BULK_AUDIT_LOG"] || join(homedir(), ".config", "saf", "llm-bulk-audit.jsonl");
}

export function fileAudit(entry) {
  try {
    const path = defaultAuditPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // The audit line is a record, never a reason to stop a run that already passed the gate.
  }
}

/**
 * Decide whether a run may start. Prints the estimate first, always. Throws
 * BulkRuleError naming the broken rule; returns the plan when the run may go.
 */
export function gateBulkRun({
  job, service = "site", paramsList, attempts = 1, expectedOutputTokens,
  batch, noBatchReason, approvedCost, cacheTtl, log = console.log, audit = fileAudit,
}) {
  const userId = jobUserId(job, service);
  if (!paramsList.length) throw new Error(`${userId}: nothing to run`);
  const analysis = analyseRequests(paramsList);
  const sync = estimateRun({ paramsList, analysis, attempts, batch: false, cacheTtl: "5m", expectedOutputTokens });
  const batched = estimateRun({ paramsList, analysis, attempts, batch: true, cacheTtl: cacheTtl ?? "1h", expectedOutputTokens });
  const maxCalls = paramsList.length * attempts;
  const bulk = maxCalls > BULK_MIN_CALLS || sync.ceiling > BULK_MIN_DOLLARS;
  const models = [...new Set(paramsList.map((p) => canonicalModel(p.model)))].join(", ");

  log(`[${userId}] cost estimate — ${paramsList.length} calls x ${attempts} attempt(s) max = ${maxCalls} calls on ${models}`);
  log(`  input ~${Math.round(sync.inputTokens / 1000)}K tokens (${Math.round(batched.cachedTokens / 1000)}K of it in a cached prefix), output ceiling ${Math.round(sync.outputCeilingTokens / 1000)}K tokens per pass`);
  log(`  one call at a time: expected ${money(sync.expected)}, ceiling ${money(sync.ceiling)}`);
  log(`  Message Batches API: expected ${money(batched.expected)}, ceiling ${money(batched.ceiling)}`);
  log(`  (ceiling = every call uses all its max_tokens, no cache hit, every retry; expected assumes ${Math.round(ASSUME.batchCacheHitRate * 100)}% batch cache hits and ${Math.round(ASSUME.retryRate * 100)}% of retries)`);
  for (const note of [...sync.notes, ...analysis.problems]) log(`  note: ${note}`);

  if (!bulk) {
    // Small runs go one call at a time unless the caller asked for a batch outright.
    const mode = batch === true ? "batch" : "sync";
    log(`  small run (≤${BULK_MIN_CALLS} calls and ≤${money(BULK_MIN_DOLLARS)}): no approval needed${mode === "batch" ? " — batching anyway, as asked" : ""}`);
    return { bulk: false, mode, estimate: mode === "batch" ? batched : sync, analysis, userId };
  }

  if (analysis.maxSharedUncachedTokens >= CACHE_MIN_SHARED_TOKENS) {
    throw new BulkRuleError("cache",
      `[${userId}] REFUSED: ~${analysis.maxSharedUncachedTokens.toLocaleString("en-US")} tokens repeat across calls outside a cached prefix ` +
      `(e.g. "${analysis.sharedSample}…"). Move the shared content to the front of the prompt (system or the first user block), ` +
      `identical in every call, and mark its last block with cache_control: {type: "ephemeral"}.`);
  }

  if (batch === false && !(noBatchReason && noBatchReason.trim())) {
    throw new BulkRuleError("batch",
      `[${userId}] REFUSED: a run of ${maxCalls} calls / ${money(sync.ceiling)} ceiling must use the Message Batches API (half price). ` +
      `Run it in batch mode, or pass --no-batch "<reason>" to say why it cannot wait.`);
  }
  // A bulk run batches unless --no-batch "<reason>" was given.
  const useBatch = batch !== false;
  const mode = useBatch ? "batch" : "sync";
  const est = useBatch ? batched : sync;
  if (approvedCost === undefined || approvedCost === null) {
    throw new BulkRuleError("approval",
      `[${userId}] REFUSED: no --approved-cost. Quote Mark the ceiling (${money(est.ceiling)}; expected ${money(est.expected)}) ` +
      `and re-run with --approved-cost ${est.ceiling.toFixed(2)} once he says yes.`);
  }
  if (!(Number(approvedCost) >= est.ceiling)) {
    throw new BulkRuleError("approval",
      `[${userId}] REFUSED: --approved-cost ${money(Number(approvedCost))} is below this run's ceiling ${money(est.ceiling)}. ` +
      `Shrink the run (--only, fewer items, smaller max_tokens) or get a new quote approved.`);
  }
  if (!useBatch) log(`  --no-batch: ${noBatchReason}`);
  log(`  approved up to ${money(Number(approvedCost))} — running ${mode === "batch" ? "through the Message Batches API" : "one call at a time"}`);
  audit({
    at: new Date().toISOString(), event: "approved", userId, mode, calls: paramsList.length, maxCalls,
    ceiling: est.ceiling, expected: est.expected, approvedCost: Number(approvedCost),
    ...(useBatch ? {} : { noBatchReason }),
  });
  return { bulk: true, mode, estimate: est, analysis, userId, approvedCost: Number(approvedCost) };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** ANTHROPIC_API_KEY, else the Mac's ~/.config/saf-secrets/env.txt (the scripts' convention). */
export function resolveApiKey() {
  const env = process.env["ANTHROPIC_API_KEY"];
  if (env) return env;
  const f = join(homedir(), ".config", "saf-secrets", "env.txt");
  if (existsSync(f)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (line.startsWith("ANTHROPIC_API_KEY=")) return line.slice("ANTHROPIC_API_KEY=".length).trim();
    }
  }
  throw new Error("ANTHROPIC_API_KEY not found (env or ~/.config/saf-secrets/env.txt)");
}

function redact(text, key) {
  let out = key ? String(text).split(key).join("***") : String(text);
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***");
  return out;
}

async function http(method, url, { body, apiKey, fetchImpl = fetch, timeoutMs = 300_000, raw = false } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text)?.error?.message ?? detail; } catch { /* not JSON */ }
    const err = new Error(redact(`Anthropic HTTP ${res.status}: ${detail}`, apiKey));
    err.status = res.status;
    throw err;
  }
  return raw ? text : JSON.parse(text);
}

/** One Messages call, retried once on 429/5xx. No counting, no gate — internal. */
async function postMessage(body, { apiKey, fetchImpl, timeoutMs, retries = 1 }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const payload = await http("POST", `${API_BASE}/messages`, { body, apiKey, fetchImpl, timeoutMs });
      return payload;
    } catch (err) {
      const s = err.status ?? 0;
      if (attempt < retries && (s === 429 || s >= 500)) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// ── one-off calls from scripts, with a tripwire ──────────────────────────────

let syncCallsThisProcess = 0;
let syncAllowance = BULK_MIN_CALLS;

/** Test hook: reset the per-process one-off call counter. */
export function _resetSyncCounter() {
  syncCallsThisProcess = 0;
  syncAllowance = BULK_MIN_CALLS;
}

/**
 * One tagged Messages call for a script that makes a few. The (N+1)th one-off call in
 * a process is refused: a loop that big is a bulk run and must go through runBulk.
 */
export async function claudeSync(params, { job, service = "site", apiKey, fetchImpl, timeoutMs = 300_000, retries = 1 } = {}) {
  const body = withJobTag(params, job, service);
  assertRequestAllowed(body);
  if (syncCallsThisProcess + 1 > syncAllowance) {
    throw new BulkRuleError("batch",
      `[${service}:${job}] REFUSED: this process has already made ${syncCallsThisProcess} one-off Claude calls. ` +
      `A run past ${BULK_MIN_CALLS} calls is a bulk run — build the requests up front and send them through runBulk().`);
  }
  syncCallsThisProcess += 1;
  return postMessage(body, { apiKey: apiKey ?? resolveApiKey(), fetchImpl, timeoutMs, retries });
}

// ── usage -> dollars ─────────────────────────────────────────────────────────

/** What a response actually cost, from its usage block. */
export function usageCost(model, usage, { batch = false } = {}) {
  if (!usage) return 0;
  const p = priceFor(model);
  const created = usage.cache_creation;
  const w1h = Number(created?.ephemeral_1h_input_tokens ?? 0);
  const w5m = created ? Number(created.ephemeral_5m_input_tokens ?? 0) : Number(usage.cache_creation_input_tokens ?? 0);
  const dollars =
    (Number(usage.input_tokens ?? 0) * p.input +
      w5m * p.write5m + w1h * p.write1h +
      Number(usage.cache_read_input_tokens ?? 0) * p.read +
      Number(usage.output_tokens ?? 0) * p.output) / 1e6;
  const searches = Number(usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_DOLLARS;
  return dollars * (batch ? BATCH_FACTOR : 1) + searches;
}

// ── the bulk runner ──────────────────────────────────────────────────────────

const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const BATCH_CHUNK_BYTES = 100 * 1024 * 1024; // the API caps a batch at 256 MB
const BATCH_CHUNK_REQUESTS = 10_000;

function withLongCacheTtl(params) {
  // Batches can take longer than 5 minutes, so the docs advise the 1-hour cache there.
  const mark = (b) => (b && b.cache_control && !b.cache_control.ttl ? { ...b, cache_control: { ...b.cache_control, ttl: "1h" } } : b);
  const out = { ...params };
  if (Array.isArray(out.system)) out.system = out.system.map(mark);
  if (Array.isArray(out.tools)) out.tools = out.tools.map(mark);
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.map(mark) } : m));
  }
  if (out.cache_control && !out.cache_control.ttl) out.cache_control = { ...out.cache_control, ttl: "1h" };
  return out;
}

function chunkRequests(requests) {
  const chunks = [];
  let cur = [], bytes = 0;
  for (const r of requests) {
    const size = JSON.stringify(r).length;
    if (cur.length && (bytes + size > BATCH_CHUNK_BYTES || cur.length >= BATCH_CHUNK_REQUESTS)) {
      chunks.push(cur); cur = []; bytes = 0;
    }
    cur.push(r); bytes += size;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function defaultStateDir() {
  return process.env["LLM_BULK_STATE_DIR"] || join(homedir(), ".config", "saf", "llm-batches");
}

/**
 * Open a gated run. `paramsList` is the first pass (it is what gets estimated and
 * checked); `attempts` is how many passes a re-rolling script may make. Then call
 * `run.execute(requests)` once per pass. Spend is tracked from real usage, and a pass
 * whose ceiling would carry the run past --approved-cost is refused.
 */
export function openBulkRun(opts) {
  const {
    job, service = "site", paramsList, attempts = 1, expectedOutputTokens, batch,
    noBatchReason, approvedCost, cacheTtl, log = console.log, audit = fileAudit,
    fetchImpl = fetch, apiKey, pollMs = 30_000, maxWaitMs = 24 * 3600_000,
    stateDir = defaultStateDir(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const plan = gateBulkRun({ job, service, paramsList, attempts, expectedOutputTokens, batch, noBatchReason, approvedCost, cacheTtl, log, audit });
  let spent = 0;
  let executed = 0;
  let key = apiKey;
  const getKey = () => (key ??= resolveApiKey());

  async function execute(requests) {
    const seen = new Set();
    for (const r of requests) {
      if (!CUSTOM_ID.test(String(r.custom_id))) throw new Error(`custom_id "${r.custom_id}" must match ${CUSTOM_ID}`);
      if (seen.has(r.custom_id)) throw new Error(`custom_id "${r.custom_id}" is used twice`);
      seen.add(r.custom_id);
    }
    const tagged = requests.map((r) => {
      // A pass may tag some requests with a sibling job (e.g. a repair pass); default is the run's.
      const params = withJobTag(plan.mode === "batch" ? withLongCacheTtl(r.params) : r.params, r.job ?? job, service);
      assertRequestAllowed(params);
      return { custom_id: r.custom_id, params };
    });
    executed += requests.length;
    if (!plan.bulk && executed > Math.max(BULK_MIN_CALLS, plan.estimate.maxCalls)) {
      throw new BulkRuleError("batch",
        `[${plan.userId}] REFUSED: this run was gated as ${plan.estimate.maxCalls} calls and has now asked for ${executed}. ` +
        `Gate the whole run up front (paramsList + attempts) so it is estimated, batched and approved.`);
    }
    if (plan.bulk) {
      const pass = estimateRun({ paramsList: tagged.map((t) => t.params), batch: plan.mode === "batch", cacheTtl: plan.mode === "batch" ? "1h" : "5m", expectedOutputTokens });
      if (spent + pass.ceiling > plan.approvedCost + 1e-9) {
        throw new BulkRuleError("budget",
          `[${plan.userId}] REFUSED: this pass's ceiling ${money(pass.ceiling)} on top of ${money(spent)} already spent ` +
          `would pass the approved ${money(plan.approvedCost)}.`);
      }
    }
    const results = plan.mode === "batch"
      ? await runBatches(tagged)
      : await runSequential(tagged);
    let passCost = 0;
    for (const [, r] of results) passCost += r.cost ?? 0;
    spent += passCost;
    log(`[${plan.userId}] pass done: ${[...results.values()].filter((r) => r.ok).length}/${requests.length} ok, actual ${money(passCost)} (run total ${money(spent)})`);
    audit({ at: new Date().toISOString(), event: "pass", userId: plan.userId, mode: plan.mode, requests: requests.length, actual: round2(passCost), runTotal: round2(spent) });
    return results;
  }

  async function runSequential(tagged) {
    const out = new Map();
    for (const t of tagged) {
      if (plan.bulk && spent + [...out.values()].reduce((s, r) => s + (r.cost ?? 0), 0) >= plan.approvedCost) {
        out.set(t.custom_id, { ok: false, error: "stopped: the approved cost was reached" });
        continue;
      }
      try {
        const message = await postMessage(t.params, { apiKey: getKey(), fetchImpl, timeoutMs: 300_000 });
        out.set(t.custom_id, { ok: true, message, cost: usageCost(t.params.model, message.usage) });
      } catch (err) {
        out.set(t.custom_id, { ok: false, error: err.message });
      }
    }
    return out;
  }

  async function runBatches(tagged) {
    const fingerprint = digest(JSON.stringify(tagged)).slice(0, 16);
    const stateFile = stateDir ? join(stateDir, `${plan.userId.replace(/[^a-z0-9.-]/gi, "_")}-${fingerprint}.json`) : null;
    let state = null;
    if (stateFile && existsSync(stateFile)) {
      try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { state = null; }
      if (state?.batchIds?.length) log(`[${plan.userId}] resuming ${state.batchIds.length} batch(es) already submitted for these exact requests — not resubmitting`);
    }
    if (!state?.batchIds?.length) {
      const ids = [];
      for (const chunk of chunkRequests(tagged)) {
        const created = await http("POST", `${API_BASE}/messages/batches`, { body: { requests: chunk }, apiKey: getKey(), fetchImpl, timeoutMs: 900_000 });
        ids.push(created.id);
        log(`[${plan.userId}] submitted batch ${created.id} (${chunk.length} requests)`);
        state = { userId: plan.userId, fingerprint, batchIds: ids, submittedAt: new Date().toISOString() };
        if (stateFile) {
          mkdirSync(dirname(stateFile), { recursive: true });
          writeFileSync(stateFile, JSON.stringify(state, null, 1));
        }
      }
    }
    const modelOf = new Map(tagged.map((t) => [t.custom_id, t.params.model]));
    const out = new Map();
    const started = Date.now();
    for (const id of state.batchIds) {
      let b;
      for (;;) {
        b = await http("GET", `${API_BASE}/messages/batches/${id}`, { apiKey: getKey(), fetchImpl });
        if (b.processing_status === "ended") break;
        if (Date.now() - started > maxWaitMs) throw new Error(`batch ${id} did not end within ${Math.round(maxWaitMs / 60000)} min — re-run the same command later to collect it`);
        const c = b.request_counts ?? {};
        log(`[${plan.userId}] batch ${id}: ${b.processing_status} (processing ${c.processing ?? "?"}, succeeded ${c.succeeded ?? 0}, errored ${c.errored ?? 0})`);
        await sleep(pollMs);
      }
      const text = await http("GET", b.results_url, { apiKey: getKey(), fetchImpl, raw: true, timeoutMs: 600_000 });
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        const r = row.result ?? {};
        if (r.type === "succeeded") {
          out.set(row.custom_id, { ok: true, message: r.message, cost: usageCost(modelOf.get(row.custom_id) ?? MODELS.DEFAULT, r.message?.usage, { batch: true }) });
        } else {
          out.set(row.custom_id, { ok: false, error: r.type === "errored" ? (r.error?.error?.message ?? r.error?.message ?? "errored") : r.type ?? "unknown" });
        }
      }
    }
    if (stateFile) {
      try { writeFileSync(stateFile, JSON.stringify({ ...state, collectedAt: new Date().toISOString() }, null, 1)); } catch { /* record only */ }
    }
    for (const t of tagged) if (!out.has(t.custom_id)) out.set(t.custom_id, { ok: false, error: "missing from batch results" });
    return out;
  }

  return { plan, execute, spent: () => spent };
}

/** Gate + one pass. Returns Map custom_id -> { ok, message?, error?, cost? }. */
export async function runBulk(opts) {
  const run = openBulkRun({ ...opts, paramsList: opts.requests.map((r) => r.params) });
  const results = await run.execute(opts.requests);
  return { results, plan: run.plan, spent: run.spent() };
}

// ── helpers scripts share ────────────────────────────────────────────────────

/** Concatenated text blocks of a Messages response. */
export function messageText(message) {
  return (message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

/**
 * CLI gate for shell drivers that loop a script (run-all-context.sh). Prints the estimate
 * and exits 0 when the run may go, 2 when a rule refuses it.
 *   node claude-core.mjs gate --job cabin.context --model claude-sonnet-5-5 --calls 42 \
 *        --input-tokens 30000 --max-tokens 16000 [--web-searches 25] [--approved-cost 40] [--no-batch "why"]
 */
async function cli(argv) {
  const get = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  if (argv[0] !== "gate") {
    console.error("usage: node claude-core.mjs gate --job <tag> --model <id> --calls <n> --input-tokens <n> --max-tokens <n> [--web-searches <n>] [--approved-cost <$>] [--no-batch \"<reason>\"]");
    process.exit(64);
  }
  const calls = Number(get("calls", 0));
  const searches = Number(get("web-searches", 0));
  // Stand-in prompts of the stated size, each different, so only the size is estimated.
  const filler = (i) => {
    let out = "";
    for (let k = 0; out.length < Number(get("input-tokens", 1000)) * 3; k++) out += digest(`${i}:${k}`);
    return out;
  };
  const paramsList = Array.from({ length: calls }, (_, i) => ({
    model: get("model", MODELS.DEFAULT),
    max_tokens: Number(get("max-tokens", 4096)),
    messages: [{ role: "user", content: filler(i) }],
    ...(searches ? { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: searches }] } : {}),
  }));
  try {
    const flags = bulkFlags(argv);
    gateBulkRun({ job: get("job"), paramsList, batch: false, noBatchReason: flags.noBatchReason, approvedCost: flags.approvedCost });
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}

// Only when run as `node .../claude-core.mjs gate ...`. NOT an import.meta.url test: inside
// the server bundle import.meta.url IS the entry file, and this must never run there.
if (/(^|[\\/])claude-core\.mjs$/.test(process.argv[1] ?? "")) {
  await cli(process.argv.slice(2));
}
