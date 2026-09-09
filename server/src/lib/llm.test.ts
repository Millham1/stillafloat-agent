// llm.test.ts — the one door to the model.
//
// Every generative feature in this service now goes through llmText/llmJson, so
// the failure modes tested here are the failure modes of the social planner, the
// newsletter, the storm drafts, the commentary agent and both translators at
// once. That is also why the port happened: nine hand-rolled OpenAI fetches meant
// nine copies of this logic and no test on any of them, which is how a rejected
// key on 2026-09-05 went four days without anyone noticing.
//
// fetch is stubbed, so nothing here touches the network or spends a cent.

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { llmText, llmJson, anthropicConfigured, DEFAULT_MODEL, CHEAP_MODEL } from "./llm";

const FAKE_KEY = "sk-ant-test-DEADBEEF-not-a-real-key";
const realFetch = globalThis.fetch;
let envKey: string | undefined;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let calls: Call[] = [];

/** Queue up responses; each fetch shifts one. `[status, jsonBody]`. */
function stubFetch(queue: Array<[number, unknown]>): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const next = queue.shift();
    if (!next) throw new Error("stub fetch called more times than expected");
    const [status, payload] = next;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
}

function textReply(text: string) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn" };
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

// ── the wire format ──────────────────────────────────────────────────────────

test("llmText posts to the Messages API with the key in x-api-key, not a bearer token", async () => {
  stubFetch([[200, textReply("  Nassau stays warm all week.  ")]]);
  const out = await llmText({ system: "be brief", user: "weather?" });

  assert.equal(out, "Nassau stays warm all week."); // trimmed
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0]!.headers["x-api-key"], FAKE_KEY);
  assert.equal(calls[0]!.headers["anthropic-version"], "2023-06-01");
  // OpenAI's auth header must not survive the port anywhere.
  assert.equal(calls[0]!.headers["authorization"], undefined);
  assert.equal(calls[0]!.headers["Authorization"], undefined);
  assert.equal(calls[0]!.body["system"], "be brief");
  assert.deepEqual(calls[0]!.body["messages"], [{ role: "user", content: "weather?" }]);
});

test("temperature is never sent — it is a hard 400 on the Claude 5 models", async () => {
  stubFetch([
    [200, textReply("ok")],
    [200, toolReply({ a: 1 })],
  ]);
  await llmText({ system: "s", user: "u" });
  await llmJson({ system: "s", user: "u", schema: { type: "object" } });
  for (const c of calls) {
    assert.ok(!("temperature" in c.body), "temperature leaked into the request body");
    assert.ok(!("response_format" in c.body), "OpenAI response_format leaked into the request");
  }
});

test("only text blocks are read back; thinking or tool blocks are not concatenated into prose", async () => {
  stubFetch([
    [
      200,
      {
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "One." },
          { type: "text", text: " Two." },
        ],
        stop_reason: "end_turn",
      },
    ],
  ]);
  assert.equal(await llmText({ system: "s", user: "u" }), "One. Two.");
});

// ── model selection ──────────────────────────────────────────────────────────

test("default model, cheap model, and an explicit override each win in that order", async () => {
  stubFetch([
    [200, textReply("a")],
    [200, textReply("b")],
    [200, textReply("c")],
  ]);
  await llmText({ system: "s", user: "u" });
  await llmText({ system: "s", user: "u", cheap: true });
  await llmText({ system: "s", user: "u", cheap: true, model: "claude-opus-5" });

  assert.equal(calls[0]!.body["model"], DEFAULT_MODEL);
  assert.equal(calls[1]!.body["model"], CHEAP_MODEL);
  // An explicit model beats `cheap` — call sites that must pin a model still can.
  assert.equal(calls[2]!.body["model"], "claude-opus-5");
});

// ── the JSON path ────────────────────────────────────────────────────────────

test("llmJson forces one tool call and returns its input verbatim — nothing is parsed out of prose", async () => {
  const schema = {
    type: "object",
    properties: { posts: { type: "array", items: { type: "object" } } },
    required: ["posts"],
  };
  // A caption with the characters that used to break prose-JSON parsing: a raw
  // newline and an unescaped-looking quote. Through a tool call they are just data.
  const input = { posts: [{ idx: 0, caption: 'Line one\nand a "quote"', hashtags: ["crucero"] }] };
  stubFetch([[200, toolReply(input)]]);

  const out = await llmJson<typeof input>({ system: "s", user: "u", schema });
  assert.deepEqual(out, input);

  const body = calls[0]!.body;
  assert.deepEqual(body["tool_choice"], { type: "tool", name: "emit" });
  const tools = body["tools"] as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1, "exactly one tool, or the model can choose not to answer");
  assert.equal(tools[0]!["name"], "emit");
  assert.deepEqual(tools[0]!["input_schema"], schema);
});

test("a response with no emit block is an error, not an empty object", async () => {
  stubFetch([[200, textReply("I would rather explain than emit.")]]);
  await assert.rejects(
    llmJson({ system: "s", user: "u", schema: { type: "object" } }),
    /no structured result/,
  );
});

test("running out of tokens mid-tool-call says so instead of 'no structured result'", async () => {
  stubFetch([[200, { content: [{ type: "text", text: "" }], stop_reason: "max_tokens" }]]);
  await assert.rejects(
    llmJson({ system: "s", user: "u", schema: { type: "object" }, maxTokens: 64 }),
    /max_tokens \(64\)/,
  );
});

// ── retry ────────────────────────────────────────────────────────────────────

test("a 429 is retried exactly once and the retry's result is returned", async () => {
  stubFetch([
    [429, { error: { message: "rate limited" } }],
    [200, textReply("second time lucky")],
  ]);
  assert.equal(await llmText({ system: "s", user: "u" }), "second time lucky");
  assert.equal(calls.length, 2);
});

test("a 500 is retried once, then the failure is surfaced", async () => {
  stubFetch([
    [500, { error: { message: "overloaded" } }],
    [503, { error: { message: "overloaded" } }],
  ]);
  await assert.rejects(llmText({ system: "s", user: "u" }), /Anthropic HTTP 503/);
  assert.equal(calls.length, 2, "one retry, not a retry storm");
});

test("a 400 is NOT retried — the same bad request twice is just two bad requests", async () => {
  stubFetch([[400, { error: { message: "schema is invalid" } }]]);
  await assert.rejects(llmText({ system: "s", user: "u" }), /Anthropic HTTP 400.*schema is invalid/);
  assert.equal(calls.length, 1);
});

test("a refusal is an error rather than an empty success", async () => {
  stubFetch([[200, { content: [], stop_reason: "refusal" }]]);
  await assert.rejects(llmText({ system: "s", user: "u" }), /refusal/);
});

// ── the credential ───────────────────────────────────────────────────────────

test("the API key never appears in a thrown error, even when the API echoes it back", async () => {
  // Worst case: the upstream error body contains the key verbatim. These messages
  // reach pino logs, dashboard toasts and Mark's push notifications.
  stubFetch([[400, { error: { message: `bad key ${FAKE_KEY} rejected` } }]]);

  await assert.rejects(llmText({ system: "s", user: "u" }), (err: Error) => {
    assert.ok(!err.message.includes(FAKE_KEY), `key leaked: ${err.message}`);
    assert.ok(!/sk-ant-[A-Za-z0-9_-]{8,}/.test(err.message), `key-shaped token leaked: ${err.message}`);
    assert.match(err.message, /Anthropic HTTP 400/);
    return true;
  });
});

test("a missing key fails loudly and says which variable, without inventing one", async () => {
  delete process.env["ANTHROPIC_API_KEY"];
  stubFetch([]);
  assert.equal(anthropicConfigured(), false);
  await assert.rejects(llmText({ system: "s", user: "u" }), /ANTHROPIC_API_KEY not configured/);
  assert.equal(calls.length, 0, "no request should be attempted without a key");
});

test("anthropicConfigured reports the key the whole service now depends on", () => {
  assert.equal(anthropicConfigured(), true);
  delete process.env["ANTHROPIC_API_KEY"];
  assert.equal(anthropicConfigured(), false);
});
