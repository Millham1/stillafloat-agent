// cabins.test.ts — the two live model calls behind the Cabin Concierge.
//
// Until 2026-09-09 reasonLive and writeSteerLines each carried their own fetch to
// api.anthropic.com and pulled the answer out of a text block with
// `text.match(/\{[\s\S]*\}/)` + JSON.parse. That is the pattern that failed 2 of 3
// real commentary runs on a raw newline or an unescaped quote inside a sentence
// (see lib/llm.ts), and every sentence here is prose in Mark's voice. Both now go
// through llmJson, which forces a schema-typed tool call.
//
// What this file pins is the OUTPUT SURFACE of that port: exactly what leaves the
// server on the wire (model, budget, system prompt, schema, forced tool) and what
// the visitor gets when the model is unavailable (the stored text, never a 500).
// fetch is stubbed; nothing here touches the network or spends a cent.

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { reasonLive, writeSteerLines, resolvePickReasons } from "./cabins";
import { normalizeAnswers, plainSteerLine, type SteerFacts } from "../lib/cabin-match";
import { factsSentence } from "../lib/cabin-facts-sentence";

const FAKE_KEY = "sk-ant-test-DEADBEEF-not-a-real-key";
const realFetch = globalThis.fetch;
let envKey: string | undefined;

interface Call { headers: Record<string, string>; body: Record<string, unknown> }
let calls: Call[] = [];

function stubFetch(queue: Array<[number, unknown]>): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const next = queue.shift();
    if (!next) throw new Error("stub fetch called more times than expected");
    const [status, payload] = next;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) } as Response;
  }) as unknown as typeof fetch;
}

function toolReply(input: unknown) {
  return { content: [{ type: "tool_use", name: "emit", input }], stop_reason: "tool_use" };
}

beforeEach(() => {
  calls = [];
  envKey = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = FAKE_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (envKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = envKey;
});

// Every call is keyed by (ship + answers + size) in a module-level cache with a
// 24h TTL, so each test uses its own ship name to be sure it reaches the wire.
let shipSeq = 0;
const ship = () => `Test Ship ${++shipSeq}`;

const answers = normalizeAnswers({ party: "couple", room: "balcony", priority: "quiet", motion: "no" });

function picks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    cabin: String(8000 + i),
    reason: "stored archetype text",
    facts: { deck: 8, category: "Ocean View Balcony" },
  }));
}

const steerFacts: SteerFacts[] = [
  { cabin: "6234", deck: 6, section: "forward", category: "Ocean View Balcony",
    factor: "motion", severity: "moderate", what: "Far forward on deck 6, where the bow rises and falls first." },
  { cabin: "7101", deck: 7, section: "midship", category: "Interior",
    factor: "noise_above", severity: "significant", what: "Directly under the pool deck." },
];

// ── reasonLive: the room cards ───────────────────────────────────────────────

test("reasonLive sends one forced tool call with the LiveOut schema on the cheap model — no regex, no text block", async () => {
  const reply = {
    recommendations: [
      // The characters that used to break the text-block parser: a raw newline
      // and an unescaped-looking quote. Through a tool call they are just data.
      { cabin: "8000", hook: "A quiet balcony for coffee", reason: 'Line one\nand a "quote" in it.' },
      { cabin: "8001", hook: "Same view, steadier ride", reason: "Two decks down. Same water." },
    ],
    steerClear: [{ cabin: "6234", reason: "Bow rooms move first." }],
  };
  stubFetch([[200, toolReply(reply)]]);

  const out = await reasonLive(ship(), answers, picks(2), [{ cabin: "6234", reason: "moves" }], "en");
  assert.deepEqual(out, reply);

  assert.equal(calls.length, 1);
  const body = calls[0]!.body;
  assert.equal(body["model"], "claude-haiku-4-5");
  assert.equal(body["max_tokens"], 1800);
  assert.ok(!("temperature" in body), "temperature is a hard 400 on the Claude 5 models");
  // Mark's VOICE is the system prompt, byte for byte what the old fetch sent.
  assert.match(String(body["system"]), /You are Mark, a cruise advisor and the voice of Still Afloat/);
  // The prompt is unchanged: still ends by naming the shape it wants.
  const messages = body["messages"] as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.content, /Respond with ONLY a JSON object:\n\{"recommendations":/);
  assert.match(messages[0]!.content, /Ship: Test Ship \d+\./);

  assert.deepEqual(body["tool_choice"], { type: "tool", name: "emit" });
  const tools = body["tools"] as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  const schema = tools[0]!["input_schema"] as Record<string, unknown>;
  assert.deepEqual(schema["required"], ["recommendations"]);
  const props = schema["properties"] as Record<string, Record<string, unknown>>;
  const recItems = props["recommendations"]!["items"] as Record<string, unknown>;
  assert.deepEqual(recItems["required"], ["cabin", "hook", "reason"]);
  const steerItems = props["steerClear"]!["items"] as Record<string, unknown>;
  assert.deepEqual(steerItems["required"], ["cabin", "reason"]);
});

test("reasonLive raises the token budget for the 'Show me More Options' list (>8 rooms)", async () => {
  stubFetch([[200, toolReply({ recommendations: [{ cabin: "8000", hook: "h", reason: "r" }] })]]);
  await reasonLive(ship(), answers, picks(9), [], "en");
  assert.equal(calls[0]!.body["max_tokens"], 6000);
});

test("reasonLive returns null when the model fails, so the stored archetype text serves", async () => {
  // A 400 is not retried by llmJson; the route must swallow it and fall back.
  stubFetch([[400, { error: { message: "bad request" } }]]);
  assert.equal(await reasonLive(ship(), answers, picks(2), [], "en"), null);
  assert.equal(calls.length, 1);
});

test("reasonLive treats an empty recommendations array as a failure, not as an answer", async () => {
  stubFetch([[200, toolReply({ recommendations: [] })]]);
  assert.equal(await reasonLive(ship(), answers, picks(2), [], "en"), null);
});

test("reasonLive makes no request at all without ANTHROPIC_API_KEY", async () => {
  delete process.env["ANTHROPIC_API_KEY"];
  stubFetch([]);
  assert.equal(await reasonLive(ship(), answers, picks(2), [], "en"), null);
  assert.equal(calls.length, 0);
});

// ── reasonLive: the 25s→15s timeout retry (2026-09-09, Mark's "no description
// for these rooms" report — 4 timeouts logged since 9/5 at the old single-shot
// 25s budget) ─────────────────────────────────────────────────────────────────

/** A fetch mock that raises exactly what Node's real AbortSignal.timeout raises. */
function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

test("reasonLive retries once at a shorter timeout after a TimeoutError, then serves the retried result", async () => {
  const reply = toolReply({ recommendations: [{ cabin: "8000", hook: "h", reason: "r" }] });
  let n = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    n++;
    calls.push({ headers: (init.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (n === 1) throw timeoutError();
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) } as Response;
  }) as unknown as typeof fetch;

  const out = await reasonLive(ship(), answers, picks(2), [], "en");
  assert.equal(calls.length, 2, "the 25s attempt, then exactly one 15s retry");
  assert.equal(out?.recommendations[0]?.cabin, "8000");
  // The retry is a second chance at the SAME (already-cheap) model, not an
  // escalation to something more expensive.
  assert.equal(calls[0]!.body["model"], "claude-haiku-4-5");
  assert.equal(calls[1]!.body["model"], "claude-haiku-4-5");
});

test("reasonLive falls back to null when BOTH the 25s attempt and its 15s retry time out — never more than one retry", async () => {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: (init.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    throw timeoutError();
  }) as unknown as typeof fetch;

  assert.equal(await reasonLive(ship(), answers, picks(2), [], "en"), null);
  assert.equal(calls.length, 2);
});

test("reasonLive does NOT retry a non-timeout failure — a 400 stays a single call", async () => {
  stubFetch([[400, { error: { message: "bad request" } }]]);
  assert.equal(await reasonLive(ship(), answers, picks(2), [], "en"), null);
  assert.equal(calls.length, 1);
});

// ── resolvePickReasons: the never-empty-card ladder (live → research → facts) ─

test("resolvePickReasons: live text wins when present and clean", () => {
  const p = [{ cabin: "8000", reason: "stored", facts: { deck: 8, category: "Interior" } }];
  const live = { recommendations: [{ cabin: "8000", hook: "A quiet corner", reason: "Fresh live prose." }] };
  const { picks, counts } = resolvePickReasons("Test Ship", p, live, "en");
  assert.equal(picks[0]!.reason, "Fresh live prose.");
  assert.equal(picks[0]!.hook, "A quiet corner");
  assert.equal(picks[0]!.reasonSource, "live");
  assert.deepEqual(counts, { live: 1, research: 0, facts: 0 });
});

test("resolvePickReasons: no live text falls back to the stored archetype text", () => {
  const p = [{ cabin: "8000", reason: "stored archetype text", facts: { deck: 8 } }];
  const { picks, counts } = resolvePickReasons("Test Ship", p, null, "en");
  assert.equal(picks[0]!.reason, "stored archetype text");
  assert.equal(picks[0]!.reasonSource, "research");
  assert.deepEqual(counts, { live: 0, research: 1, facts: 0 });
});

test("resolvePickReasons: no live text AND no stored text — the exact gap that shipped blank cards — falls to factsSentence and is never empty", () => {
  const p = [{ cabin: "8000", reason: undefined, facts: { deck: 8, section: "midship", side: "starboard", real_ocean: true, above_kind: "cabins" as const, below_kind: "cabins" as const } }];
  const { picks, counts } = resolvePickReasons("Test Ship", p, null, "en");
  assert.equal(picks[0]!.reason, factsSentence(p[0]!.facts, "en"));
  assert.ok(picks[0]!.reason.length > 0);
  assert.equal(picks[0]!.reasonSource, "facts");
  assert.deepEqual(counts, { live: 0, research: 0, facts: 1 });
});

test("resolvePickReasons: a pick with no facts at all AND no stored text still never returns an empty reason", () => {
  const p = [{ cabin: "9999", reason: undefined, facts: null }];
  const { picks } = resolvePickReasons("Test Ship", p, null, "en");
  assert.equal(picks[0]!.reason, factsSentence(null, "en"));
  assert.ok(picks[0]!.reason.length > 0);
  assert.equal(picks[0]!.reasonSource, "facts");
});

test("resolvePickReasons: a live rewrite that argues against its own pick is discarded, falling through to research then facts", () => {
  const argues = { cabin: "8000", hook: "h", reason: "Honestly, I'd pass and book one of the quieter options." };
  const withStored = [{ cabin: "8000", reason: "stored text", facts: { deck: 8 } }];
  const r1 = resolvePickReasons("Test Ship", withStored, { recommendations: [argues] }, "en");
  assert.equal(r1.picks[0]!.reasonSource, "research");
  assert.equal(r1.picks[0]!.reason, "stored text");

  const withoutStored = [{ cabin: "8000", reason: undefined, facts: { deck: 8 } }];
  const r2 = resolvePickReasons("Test Ship", withoutStored, { recommendations: [argues] }, "en");
  assert.equal(r2.picks[0]!.reasonSource, "facts");
  assert.equal(r2.picks[0]!.reason, factsSentence({ deck: 8 }, "en"));
});

test("resolvePickReasons: a cabin the model dropped from its reply falls through the same ladder", () => {
  const p = [{ cabin: "8000", reason: "stored", facts: { deck: 8 } }];
  const live = { recommendations: [{ cabin: "9999", hook: "h", reason: "about a different cabin" }] };
  const { picks } = resolvePickReasons("Test Ship", p, live, "en");
  assert.equal(picks[0]!.reasonSource, "research");
  assert.equal(picks[0]!.reason, "stored");
});

test("resolvePickReasons: es-419 facts fallback reads in Spanish, not English", () => {
  const p = [{ cabin: "8000", reason: undefined, facts: { deck: 8, side: "starboard" } }];
  const { picks } = resolvePickReasons("Test Ship", p, null, "es");
  assert.equal(picks[0]!.reason, "Cubierta 8, por estribor.");
});

// ── writeSteerLines: the skip-list ───────────────────────────────────────────

test("writeSteerLines sends the {lines:[{cabin,reason}]} schema and keeps only lines that pass the fact gate", async () => {
  stubFetch([[200, toolReply({
    lines: [
      { cabin: "6234", reason: "Deck 6, far forward — you feel the bow first, and it does not wait for you to finish your coffee." },
      // Names a deck the entry does not sit on: the gate must reject it and the
      // plain composed line must serve instead.
      { cabin: "7101", reason: "Deck 9 is directly overhead, with the pool chairs." },
    ],
  })]]);

  const out = await writeSteerLines(ship(), steerFacts, answers, "en");

  assert.equal(calls.length, 1);
  const body = calls[0]!.body;
  assert.equal(body["model"], "claude-haiku-4-5");
  assert.equal(body["max_tokens"], 700);
  assert.deepEqual(body["tool_choice"], { type: "tool", name: "emit" });
  const tools = body["tools"] as Array<Record<string, unknown>>;
  const schema = tools[0]!["input_schema"] as Record<string, unknown>;
  assert.deepEqual(schema["required"], ["lines"]);
  const lines = (schema["properties"] as Record<string, Record<string, unknown>>)["lines"]!;
  assert.deepEqual((lines["items"] as Record<string, unknown>)["required"], ["cabin", "reason"]);
  const messages = body["messages"] as Array<{ content: string }>;
  assert.match(messages[0]!.content, /Respond with ONLY JSON: \{"lines":\[\{"cabin":"<number>","reason":"\.\.\."\}\]\}$/);
  // This traveler said seasickness is not a problem: the rule in the prompt says so.
  assert.match(messages[0]!.content, /seasickness is NOT a problem/);

  assert.equal(out.get("6234"), "Deck 6, far forward — you feel the bow first, and it does not wait for you to finish your coffee.");
  assert.equal(out.get("7101"), plainSteerLine(steerFacts[1]!, "en"), "a line that fails the fact gate falls back to the plain sentence");
});

test("writeSteerLines serves the plain lines when the writer is unavailable", async () => {
  stubFetch([
    [503, { error: { message: "overloaded" } }],
    [503, { error: { message: "overloaded" } }], // llmJson retries a 5xx exactly once
  ]);
  const out = await writeSteerLines(ship(), steerFacts, answers, "en");
  assert.equal(calls.length, 2);
  for (const f of steerFacts) assert.equal(out.get(f.cabin), plainSteerLine(f, "en"));
});

test("writeSteerLines makes no request at all without ANTHROPIC_API_KEY", async () => {
  delete process.env["ANTHROPIC_API_KEY"];
  stubFetch([]);
  const out = await writeSteerLines(ship(), steerFacts, answers, "en");
  assert.equal(calls.length, 0);
  for (const f of steerFacts) assert.equal(out.get(f.cabin), plainSteerLine(f, "en"));
});
