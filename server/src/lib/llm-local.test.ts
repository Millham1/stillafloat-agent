// llm-local.test.ts — routing to the house box, and the fallback that makes it safe.
//
// The whole point of this provider is that it is OPTIONAL. The box sits on
// residential power and internet; it went down twice on the day it was built
// (a hard power cut and a knocked power brick). So the property that actually
// matters here is not "local works" — it is "local failing changes nothing".
// Mark's standing directive, 2026-09-21: move what we can off the API, and
// keep Claude as the redundancy. These tests are that directive, asserted.
//
// fetch is stubbed, so nothing here touches the network, the box, or a cent.

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { llmText, llmJson } from "./llm";
import { routeLocally, shadowLocally, localConfigured } from "./llm-local";

const FAKE_KEY = "sk-ant-test-DEADBEEF-not-a-real-key";
const LOCAL_URL = "http://10.88.0.3:8080";
const realFetch = globalThis.fetch;

interface Call {
  url: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];

/** Each entry is [status, jsonBody]; fetch shifts one per call. */
function stubFetch(queue: Array<[number, unknown]>): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
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

const anthropicText = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const anthropicTool = (input: unknown) => ({
  content: [{ type: "tool_use", name: "emit", input }],
  stop_reason: "tool_use",
});
const localText = (t: string) => ({ choices: [{ message: { content: t }, finish_reason: "stop" }] });

const saved: Record<string, string | undefined> = {};
const KEYS = ["ANTHROPIC_API_KEY", "LOCAL_LLM_URL", "LLM_LOCAL_JOBS", "LLM_SHADOW_JOBS"];

beforeEach(() => {
  calls = [];
  for (const k of KEYS) saved[k] = process.env[k];
  process.env["ANTHROPIC_API_KEY"] = FAKE_KEY;
  delete process.env["LOCAL_LLM_URL"];
  delete process.env["LLM_LOCAL_JOBS"];
  delete process.env["LLM_SHADOW_JOBS"];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

const SCHEMA = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    category: { type: "string", enum: ["itinerary", "pricing", "safety"] },
    note: { type: "string" },
  },
  required: ["relevant", "category"],
  additionalProperties: false,
};

// ---------------------------------------------------------------- routing

test("routing is off entirely until LOCAL_LLM_URL is set", () => {
  process.env["LLM_LOCAL_JOBS"] = "news.relevance";
  assert.equal(localConfigured(), false);
  assert.equal(routeLocally("news.relevance"), false);
});

test("only the jobs named in LLM_LOCAL_JOBS route locally", () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_LOCAL_JOBS"] = "news.relevance, ops.receipts";
  assert.equal(routeLocally("news.relevance"), true);
  assert.equal(routeLocally("ops.receipts"), true, "whitespace around the comma is tolerated");
  assert.equal(routeLocally("newsletter.write"), false);
});

test("a call with no job label never routes locally, whatever is configured", () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_LOCAL_JOBS"] = "news.relevance";
  assert.equal(routeLocally(undefined), false);
});

test("shadow and local routing are independent switches", () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_SHADOW_JOBS"] = "news.relevance";
  assert.equal(shadowLocally("news.relevance"), true);
  assert.equal(routeLocally("news.relevance"), false, "shadowing must not silently move the job");
});

// ---------------------------------------------------------------- it actually goes local

test("a routed job hits the local box and never calls Anthropic", async () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_LOCAL_JOBS"] = "news.relevance";
  stubFetch([[200, localText("locally answered")]]);

  const out = await llmText({ system: "s", user: "u", job: "news.relevance" });

  assert.equal(out, "locally answered");
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.startsWith(LOCAL_URL), `went to ${calls[0]!.url}`);
});

test("an unrouted job still goes to Anthropic", async () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_LOCAL_JOBS"] = "something.else";
  stubFetch([[200, anthropicText("from anthropic")]]);

  const out = await llmText({ system: "s", user: "u", job: "news.relevance" });

  assert.equal(out, "from anthropic");
  assert.ok(calls[0]!.url.includes("api.anthropic.com"));
});

// ---------------------------------------------------------------- THE SAFETY PROPERTY

test("local failure falls back to Anthropic and the caller never notices", async () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_LOCAL_JOBS"] = "news.relevance";
  // box is down: 502, then Anthropic answers
  stubFetch([[502, { error: { message: "bad gateway" } }], [200, anthropicText("rescued")]]);

  const out = await llmText({ system: "s", user: "u", job: "news.relevance" });

  assert.equal(out, "rescued", "a dead box must not surface as an error");
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.url.startsWith(LOCAL_URL));
  assert.ok(calls[1]!.url.includes("api.anthropic.com"));
});

test("local returning unparseable JSON also falls back", async () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_LOCAL_JOBS"] = "news.relevance";
  stubFetch([
    [200, localText("I'm afraid I can't do that")],
    [200, anthropicTool({ relevant: true, category: "safety" })],
  ]);

  const out = await llmJson({ system: "s", user: "u", schema: SCHEMA, job: "news.relevance" });

  assert.deepEqual(out, { relevant: true, category: "safety" });
  assert.equal(calls.length, 2);
});

test("local returning empty text falls back rather than yielding an empty answer", async () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_LOCAL_JOBS"] = "news.relevance";
  stubFetch([[200, localText("   ")], [200, anthropicText("real answer")]]);

  assert.equal(await llmText({ system: "s", user: "u", job: "news.relevance" }), "real answer");
});

// ---------------------------------------------------------------- the 18x prompt rule

test("a local JSON call describes the schema in the prompt as well as enforcing it", async () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_LOCAL_JOBS"] = "news.relevance";
  stubFetch([[200, localText('{"relevant":true,"category":"pricing"}')]]);

  await llmJson({ system: "s", user: "Fares are up.", schema: SCHEMA, job: "news.relevance" });

  const body = calls[0]!.body;
  const messages = body["messages"] as Array<{ role: string; content: string }>;
  const userTurn = messages.find((m) => m.role === "user")!.content;

  // Measured 2026-09-21: schema alone cost 414 tokens / 24.9s; schema plus this
  // description cost 27 tokens / 1.4s for the same answer. Without it the box
  // is eighteen times slower, which is the difference between usable and not.
  assert.ok(userTurn.includes("Fares are up."), "the caller's prompt survives");
  assert.ok(userTurn.includes("relevant (boolean)"), "types are spelled out");
  assert.ok(
    userTurn.includes("category (one of itinerary, pricing, safety)"),
    "enum values are spelled out",
  );
  assert.ok(userTurn.includes("note (string, optional)"), "optional fields are marked optional");

  // and the schema is still enforced server-side, not merely requested
  const rf = body["response_format"] as { type: string; json_schema: { strict: boolean } };
  assert.equal(rf.type, "json_schema");
  assert.equal(rf.json_schema.strict, true);
});

// ---------------------------------------------------------------- shadow normalising

test("without a normaliser, a reordered batch reads as disagreement", async () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_SHADOW_JOBS"] = "news.hubclass";
  const anthropic = { verdicts: [{ storyId: "a", lines: ["x"] }, { storyId: "b", lines: ["y"] }] };
  const local = { verdicts: [{ storyId: "b", lines: ["y"] }, { storyId: "a", lines: ["x"] }] };
  stubFetch([[200, anthropicTool(anthropic)], [200, localText(JSON.stringify(local))]]);

  await llmJson({ system: "s", user: "u", schema: SCHEMA, job: "news.hubclass" });
  await new Promise((r) => setTimeout(r, 30));

  // Same classification, different order. Verbatim comparison calls this a
  // disagreement — which is exactly the false signal the normaliser exists for.
  assert.notEqual(JSON.stringify(anthropic), JSON.stringify(local));
});

test("a normaliser makes the same answer in a different order compare equal", async () => {
  process.env["LOCAL_LLM_URL"] = LOCAL_URL;
  process.env["LLM_SHADOW_JOBS"] = "news.hubclass";
  const anthropic = { verdicts: [{ storyId: "a", lines: ["x", "z"] }, { storyId: "b", lines: ["y"] }] };
  const local = { verdicts: [{ storyId: "b", lines: ["y"] }, { storyId: "a", lines: ["z", "x"] }] };

  // the normaliser the hub classifier actually uses
  const norm = (out: { verdicts?: { storyId?: string; lines?: string[] }[] }) =>
    (out.verdicts ?? [])
      .map((v) => [String(v.storyId ?? ""), [...new Set(v.lines ?? [])].sort()] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));

  assert.equal(JSON.stringify(norm(anthropic)), JSON.stringify(norm(local)),
    "order of verdicts, and of slugs within a verdict, must not count as a difference");

  stubFetch([[200, anthropicTool(anthropic)], [200, localText(JSON.stringify(local))]]);
  const out = await llmJson({
    system: "s", user: "u", schema: SCHEMA, job: "news.hubclass",
    shadowNormalise: norm as unknown as (v: never) => unknown,
  });
  assert.deepEqual(out, anthropic, "the shadow must not alter what the caller receives");
});
