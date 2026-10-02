// claude-core.test.ts — the bulk-run rule, proved with mocks. No network, no spend.
//
// The G6-style controls Mark asked for on 2026-10-02:
//   * a fake 25-call job WITHOUT batch is refused; the same job WITH batch passes;
//   * the cabin-advice shape (a ~110K-token grid shared by every archetype prompt)
//     trips the cache_control requirement, and the cached shape passes it.
// Every fetch is a stub; the audit log goes to an array; batch state to a temp dir.

import { test, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BULK_MIN_CALLS, BulkRuleError, CACHE_MIN_SHARED_TOKENS, MODELS, analyseRequests, bulkFlags,
  claudeSync, gateBulkRun, jobUserId, openBulkRun, rejectsForcedToolChoice, runBulk,
  structuredCallShape, usageCost, withJobTag, _resetSyncCounter, priceFor,
} from "./claude-core.mjs";

type Params = Record<string, unknown>;
interface Seen { method: string; url: string; body?: Record<string, unknown> }

let seen: Seen[] = [];
let audit: Record<string, unknown>[] = [];
let lines: string[] = [];
const log = (l: string) => { lines.push(l); };
const collect = (e: Record<string, unknown>) => { audit.push(e); };

beforeEach(() => {
  seen = []; audit = []; lines = [];
  _resetSyncCounter();
});

/** A stub of the Messages + Message Batches endpoints. Batches end on the second poll. */
function fakeApi(opts: { messageText?: string } = {}) {
  const batches = new Map<string, { requests: { custom_id: string; params: Params }[]; polls: number }>();
  let n = 0;
  const reply = (status: number, payload: unknown, raw = false) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (raw ? String(payload) : JSON.stringify(payload)),
  }) as unknown as Response;
  const message = (id: string) => ({
    id, type: "message", role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text: opts.messageText ?? `{"ok":"${id}"}` }],
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  const impl = (async (url: string, init: { method?: string; body?: string }) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    seen.push({ method, url, body });
    if (method === "POST" && url.endsWith("/v1/messages")) return reply(200, message(`sync-${++n}`));
    if (method === "POST" && url.endsWith("/v1/messages/batches")) {
      const id = `msgbatch_test${++n}`;
      batches.set(id, { requests: body!["requests"] as { custom_id: string; params: Params }[], polls: 0 });
      return reply(200, { id, type: "message_batch", processing_status: "in_progress", request_counts: { processing: 1 } });
    }
    const m = url.match(/\/v1\/messages\/batches\/([^/]+)$/);
    if (method === "GET" && m) {
      const b = batches.get(m[1]!)!;
      b.polls += 1;
      return reply(200, {
        id: m[1], processing_status: b.polls >= 2 ? "ended" : "in_progress",
        request_counts: { processing: b.polls >= 2 ? 0 : b.requests.length, succeeded: b.polls >= 2 ? b.requests.length : 0 },
        results_url: `https://api.anthropic.com/v1/messages/batches/${m[1]}/results`,
      });
    }
    const r = url.match(/\/v1\/messages\/batches\/([^/]+)\/results$/);
    if (method === "GET" && r) {
      const b = batches.get(r[1]!)!;
      return reply(200, b.requests.map((q) => JSON.stringify({ custom_id: q.custom_id, result: { type: "succeeded", message: message(q.custom_id) } })).join("\n"), true);
    }
    return reply(404, { error: { message: `unexpected ${method} ${url}` } });
  }) as unknown as typeof fetch;
  return { impl, batches };
}

/** The fake 25-call job: 25 short classification prompts, Sonnet 5.5. */
function fakeJob(n = 25) {
  return Array.from({ length: n }, (_, i) => ({
    custom_id: `lead-${i}`,
    params: {
      model: MODELS.DEFAULT, max_tokens: 4000,
      system: "Classify each numbered research claim by kind and polarity. Return a JSON array.",
      messages: [{ role: "user", content: `${i + 1}. cabin ${9200 + i} sits under the pool deck (claim ${i})` }],
    },
  }));
}

function common() {
  return { stateDir: mkdtempSync(join(tmpdir(), "llm-bulk-")), pollMs: 0, log, audit: collect, apiKey: "sk-test" };
}

// ── G6 control 1: no batch -> refused; batch -> passes ───────────────────────

test("G6: a 25-call job WITHOUT the Batch API is refused, before any request is sent", async () => {
  const api = fakeApi();
  await assert.rejects(
    runBulk({ job: "cabin.leads", requests: fakeJob(), batch: false, approvedCost: 50, fetchImpl: api.impl, ...common() }),
    (err: unknown) => {
      assert.ok(err instanceof BulkRuleError);
      assert.equal((err as BulkRuleError).rule, "batch");
      assert.match((err as Error).message, /must use the Message Batches API/);
      return true;
    },
  );
  assert.equal(seen.length, 0, "refused before the network");
  assert.ok(lines.some((l) => /cost estimate — 25 calls/.test(l)), "the estimate is printed even when the run is refused");
});

test("G6: the SAME 25-call job WITH the Batch API passes — one batch, every request tagged, no one-off calls", async () => {
  const api = fakeApi();
  const dir = common();
  const { results, plan } = await runBulk({ job: "cabin.leads", requests: fakeJob(), batch: true, approvedCost: 5, fetchImpl: api.impl, ...dir });
  assert.equal(plan.bulk, true);
  assert.equal(plan.mode, "batch");
  assert.equal(results.size, 25);
  assert.ok([...results.values()].every((r) => r.ok));
  assert.equal(seen.filter((s) => s.method === "POST" && s.url.endsWith("/v1/messages")).length, 0, "no one-off Messages calls");
  const submit = seen.filter((s) => s.method === "POST" && s.url.endsWith("/v1/messages/batches"));
  assert.equal(submit.length, 1);
  const reqs = submit[0]!.body!["requests"] as { params: { metadata: { user_id: string } } }[];
  assert.equal(reqs.length, 25);
  assert.ok(reqs.every((r) => r.params.metadata.user_id === "site:cabin.leads"));
  assert.equal(audit[0]!["event"], "approved");
  assert.equal(audit[0]!["mode"], "batch");
  rmSync(dir.stateDir, { recursive: true, force: true });
});

test("G6: --no-batch with a reason runs one call at a time, and the reason is printed and audited", async () => {
  const api = fakeApi();
  const { results, plan } = await runBulk({
    job: "cabin.leads", requests: fakeJob(), batch: false, noBatchReason: "Mark is watching the first 25 live", approvedCost: 10,
    fetchImpl: api.impl, ...common(),
  });
  assert.equal(plan.mode, "sync");
  assert.equal(results.size, 25);
  assert.equal(seen.filter((s) => s.url.endsWith("/v1/messages")).length, 25);
  assert.ok(lines.some((l) => l.includes("--no-batch: Mark is watching the first 25 live")));
  assert.equal(audit[0]!["noBatchReason"], "Mark is watching the first 25 live");
});

test("a bulk run without --approved-cost is refused and told the figure to quote", async () => {
  const api = fakeApi();
  await assert.rejects(
    runBulk({ job: "cabin.leads", requests: fakeJob(), batch: true, fetchImpl: api.impl, ...common() }),
    (err: unknown) => (err as BulkRuleError).rule === "approval" && /re-run with --approved-cost \d+\.\d\d/.test((err as Error).message),
  );
  assert.equal(seen.length, 0);
});

test("an approval below the ceiling is refused", async () => {
  await assert.rejects(
    runBulk({ job: "cabin.leads", requests: fakeJob(), batch: true, approvedCost: 0.01, fetchImpl: fakeApi().impl, ...common() }),
    (err: unknown) => (err as BulkRuleError).rule === "approval" && /below this run's ceiling/.test((err as Error).message),
  );
});

test("a small run (≤ N calls, ≤ $2) needs no batch and no approval", async () => {
  const api = fakeApi();
  const { results, plan } = await runBulk({ job: "cabin.leads", requests: fakeJob(5), batch: false, fetchImpl: api.impl, ...common() });
  assert.equal(plan.bulk, false);
  assert.equal(results.size, 5);
});

test("retries count: 8 prompts x 3 attempts is a 24-call run and needs the gate", () => {
  assert.throws(
    () => gateBulkRun({ job: "cabin.advice", paramsList: fakeJob(8).map((r) => r.params), attempts: 3, batch: false, log, audit: collect }),
    (err: unknown) => (err as BulkRuleError).rule === "batch",
  );
});

test("a run that is small in calls but over $2 is still a bulk run", () => {
  // 6 calls, each with ~200K tokens of context on Sonnet: ~$2.40 before output.
  const big = Array.from({ length: 6 }, (_, i) => ({
    model: MODELS.DEFAULT, max_tokens: 1000,
    messages: [{ role: "user", content: `${i}${"z".repeat(600_000).replace(/z/g, () => String.fromCharCode(97 + Math.floor(Math.random() * 26)))}` }],
  }));
  assert.throws(() => gateBulkRun({ job: "cabin.advice", paramsList: big, batch: false, log, audit: collect }), BulkRuleError);
});

// ── G6 control 2: the cabin-advice grid ──────────────────────────────────────

const VOICE = "You are Mark, a working travel advisor. Warm, direct, a little dry. ".repeat(10);
// ~1,949 cabins of the shape generate-advice.mjs sends: ~330K characters ≈ 110K tokens.
const GRID = JSON.stringify(Array.from({ length: 1949 }, (_, i) => ({
  id: 4000 + i, deck: 4 + (i % 12), kind: i % 3 ? "Balcony" : "Interior", view: i % 3 ? "ocean" : "none",
  realOcean: i % 2 === 0, hump: false, steady: i % 5 === 0, obstruction: null, flaggedByLine: false,
  sleeps: 2 + (i % 3), position: ["forward", "mid", "aft"][i % 3], side: i % 2 ? "port" : "starboard", note: null,
})));
const ARCHETYPES = Array.from({ length: 12 }, (_, i) => `archetype ${i}: a traveler who wants ${["quiet", "a view", "value", "space"][i % 4]}`);

test("CACHE: the old generate-advice shape (110K-token grid after the traveler line, in every prompt) is refused", () => {
  // Exactly how generate-advice.mjs built it before 2026-10-02.
  const old = ARCHETYPES.map((t) => ({
    model: MODELS.CHEAP, max_tokens: 1600, system: VOICE,
    messages: [{ role: "user", content: `Traveler: ${t}. Ship: Norwegian Aura.\n\nCandidate cabins (all real, with the quirks that matter):\n${GRID}\n\nRecommend the best 4-6 cabins.` }],
  }));
  const a = analyseRequests(old);
  assert.ok(a.maxSharedUncachedTokens > 100_000, `shared uncached ${a.maxSharedUncachedTokens}`);
  assert.throws(
    () => gateBulkRun({ job: "cabin.advice", paramsList: old, attempts: 3, batch: true, approvedCost: 1000, log, audit: collect }),
    (err: unknown) => {
      assert.equal((err as BulkRuleError).rule, "cache");
      assert.match((err as Error).message, /repeat across calls outside a cached prefix/);
      assert.match((err as Error).message, /cache_control/);
      return true;
    },
    "even with batch on and a generous approval, the uncached grid is refused",
  );
});

test("CACHE: the same grid moved into a cache_control-marked system prefix passes, and the estimate prices it as cached", () => {
  const cached = ARCHETYPES.map((t) => ({
    model: MODELS.CHEAP, max_tokens: 1600,
    system: [
      { type: "text", text: VOICE },
      { type: "text", text: `Ship: Norwegian Aura.\n\nCandidate cabins (all real, with the quirks that matter):\n${GRID}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: `Traveler: ${t}.\n\nRecommend the best 4-6 cabins.` }],
  }));
  const plan = gateBulkRun({ job: "cabin.advice", paramsList: cached, attempts: 3, batch: true, approvedCost: 1000, log, audit: collect });
  assert.equal(plan.mode, "batch");
  assert.ok(plan.estimate.cachedTokens > 1_000_000, "12 x ~110K tokens counted as cached");
  assert.ok(plan.analysis.maxSharedUncachedTokens < CACHE_MIN_SHARED_TOKENS);
});

test("CACHE: a marker after content that differs per call is called out — it can never be read back", () => {
  const wrong = ARCHETYPES.map((t) => ({
    model: MODELS.CHEAP, max_tokens: 1600, system: VOICE,
    messages: [{ role: "user", content: [
      { type: "text", text: `Traveler: ${t}.` },
      { type: "text", text: GRID, cache_control: { type: "ephemeral" } },
    ] }],
  }));
  const a = analyseRequests(wrong);
  assert.ok(a.problems.length > 0);
  assert.throws(() => gateBulkRun({ job: "cabin.advice", paramsList: wrong, attempts: 3, batch: true, approvedCost: 1000, log, audit: collect }),
    (err: unknown) => (err as BulkRuleError).rule === "cache");
});

test("in batch mode the shared prefix is written with the 1-hour cache (batches outlast 5 minutes)", async () => {
  const api = fakeApi();
  const requests = ARCHETYPES.slice(0, 3).map((t, i) => ({
    custom_id: `a${i}`,
    params: {
      model: MODELS.CHEAP, max_tokens: 1600,
      system: [{ type: "text", text: GRID, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: t }],
    },
  }));
  await runBulk({ job: "cabin.advice", requests, batch: true, approvedCost: 5, fetchImpl: api.impl, ...common() });
  const sent = seen.find((s) => s.url.endsWith("/v1/messages/batches"))!.body!["requests"] as { params: { system: { cache_control: unknown }[] } }[];
  assert.deepEqual(sent[0]!.params.system[0]!.cache_control, { type: "ephemeral", ttl: "1h" });
});

// ── the rest of the runner ───────────────────────────────────────────────────

test("re-running the same batch after a crash resumes it instead of paying twice", async () => {
  const api = fakeApi();
  const dir = common();
  await runBulk({ job: "cabin.leads", requests: fakeJob(), batch: true, approvedCost: 5, fetchImpl: api.impl, ...dir });
  const submitsBefore = seen.filter((s) => s.method === "POST").length;
  await runBulk({ job: "cabin.leads", requests: fakeJob(), batch: true, approvedCost: 5, fetchImpl: api.impl, ...dir });
  assert.equal(seen.filter((s) => s.method === "POST").length, submitsBefore, "no second submission");
  assert.ok(lines.some((l) => /resuming 1 batch/.test(l)));
  assert.equal(readdirSync(dir.stateDir).length, 1);
  rmSync(dir.stateDir, { recursive: true, force: true });
});

test("a later pass that would carry the run past the approved cost is refused", async () => {
  const api = fakeApi();
  const reqs = fakeJob();
  // Approve exactly the first pass's ceiling: the first pass fits, a second cannot.
  const ceiling = gateBulkRun({ job: "cabin.leads", paramsList: reqs.map((r) => r.params), batch: true, approvedCost: 100, log, audit: collect }).estimate.ceiling;
  const run = openBulkRun({ job: "cabin.leads", paramsList: reqs.map((r) => r.params), batch: true, approvedCost: ceiling, fetchImpl: api.impl, ...common() });
  await run.execute(reqs);
  await assert.rejects(run.execute(reqs.map((r) => ({ ...r, custom_id: `${r.custom_id}-again` }))),
    (err: unknown) => (err as BulkRuleError).rule === "budget");
});

test("a small gated run cannot quietly grow into a bulk one", async () => {
  const api = fakeApi();
  const run = openBulkRun({ job: "cabin.leads", paramsList: fakeJob(5).map((r) => r.params), batch: false, fetchImpl: api.impl, ...common() });
  await assert.rejects(run.execute(fakeJob(25)), (err: unknown) => (err as BulkRuleError).rule === "batch");
});

test("one-off calls from a script trip the wire at N+1", async () => {
  const api = fakeApi();
  const p = { model: MODELS.CHEAP, max_tokens: 10, messages: [{ role: "user", content: "x" }] };
  for (let i = 0; i < BULK_MIN_CALLS; i++) await claudeSync(p, { job: "cabin.advice-es", fetchImpl: api.impl, apiKey: "sk-test" });
  await assert.rejects(claudeSync(p, { job: "cabin.advice-es", fetchImpl: api.impl, apiKey: "sk-test" }),
    (err: unknown) => (err as BulkRuleError).rule === "batch" && /runBulk/.test((err as Error).message));
  assert.equal(seen.length, BULK_MIN_CALLS);
  assert.ok(seen.every((s) => (s.body!["metadata"] as { user_id: string }).user_id === "site:cabin.advice-es"));
});

test("job tags: required, registered, and stamped as site:<job>", async () => {
  assert.equal(jobUserId("cabin.advice"), "site:cabin.advice");
  assert.throws(() => jobUserId(""), /needs a job tag/);
  assert.throws(() => jobUserId("cabin.typo"), /not registered/);
  assert.deepEqual(withJobTag({ model: "m" }, "conga.draft")["metadata"], { user_id: "site:conga.draft" });
  await assert.rejects(runBulk({ job: "nope", requests: fakeJob(1), fetchImpl: fakeApi().impl, ...common() }), /not registered/);
  await assert.rejects(claudeSync({ model: MODELS.CHEAP, max_tokens: 1, messages: [] }, { job: undefined as unknown as string }), /needs a job tag/);
});

test("Claude 5 request rules are enforced before sending", async () => {
  const api = fakeApi();
  const base = { model: MODELS.DEFAULT, max_tokens: 10, messages: [{ role: "user", content: "x" }] };
  await assert.rejects(claudeSync({ ...base, temperature: 0 }, { job: "cabin.preview", fetchImpl: api.impl, apiKey: "k" }), /temperature is rejected/);
  await assert.rejects(claudeSync({ ...base, tool_choice: { type: "tool", name: "x" } }, { job: "cabin.preview", fetchImpl: api.impl, apiKey: "k" }), /forced tool_choice/);
  await assert.rejects(claudeSync({ ...base, thinking: { type: "disabled" } }, { job: "cabin.preview", fetchImpl: api.impl, apiKey: "k" }), /between_tools/);
  assert.equal(seen.length, 0);
});

test("models: Sonnet 5.5 rejects forcing, Haiku 4.5 and Sonnet 5 do not; structuredCallShape follows", () => {
  assert.equal(rejectsForcedToolChoice("claude-sonnet-5-5"), true);
  assert.equal(rejectsForcedToolChoice("claude-haiku-4-5"), false);
  assert.equal(rejectsForcedToolChoice("claude-haiku-4-5-20251001"), false);
  assert.equal(rejectsForcedToolChoice("claude-sonnet-5"), false);
  assert.deepEqual(structuredCallShape("claude-haiku-4-5", "emit").tool_choice, { type: "tool", name: "emit" });
  const s = structuredCallShape("claude-sonnet-5-5", "emit");
  assert.equal(s.tool_choice["type"], "auto");
  assert.deepEqual(s.thinking, { type: "between_tools" });
});

test("price table: Sonnet 5.5 costs exactly what Sonnet 5 did (pricing page, 2026-10-02)", () => {
  assert.deepEqual(priceFor("claude-sonnet-5-5"), priceFor("claude-sonnet-5"));
  assert.deepEqual(priceFor("claude-sonnet-5-5"), { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 });
  assert.throws(() => priceFor("claude-unknown-9"), /No price on file/);
  // 1M input + 1M output on the Batch API = ($2 + $10) / 2.
  assert.equal(usageCost("claude-sonnet-5-5", { input_tokens: 1e6, output_tokens: 1e6 }, { batch: true }), 6);
});

test("bulkFlags reads --approved-cost and --no-batch in both spellings, and refuses an empty reason", () => {
  assert.deepEqual(bulkFlags(["node", "x", "--approved-cost", "3.5"]), { approvedCost: 3.5, noBatchReason: undefined });
  assert.deepEqual(bulkFlags(["node", "x", "--approved-cost=2", "--no-batch=live demo"]), { approvedCost: 2, noBatchReason: "live demo" });
  assert.throws(() => bulkFlags(["--no-batch"]), /needs a reason/);
  assert.throws(() => bulkFlags(["--approved-cost", "lots"]), /dollar amount/);
});
