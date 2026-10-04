// llm.ts — the ONE place this service talks to a language model.
//
// Why this file exists (2026-09-09): every generative feature in the monorepo
// called api.openai.com directly, each with its own fetch, its own prompt
// plumbing and its own JSON-out-of-a-text-block parser. When the OpenAI key
// started being rejected on 2026-09-05 that was nine independent outages: the
// social planner generated nothing for four days, and nobody found out until
// the review queue stayed empty. Mark's call: drop OpenAI entirely and run on
// Anthropic, which is already the key that works everywhere else.
//
// Two entry points, no third:
//   llmText  — prose in, prose out.
//   llmJson  — prose in, SCHEMA-GUARANTEED object out.
//
// llmJson forces a single tool call whose input_schema IS the caller's JSON
// schema and returns the tool input verbatim. That is the house rule from
// [[stillafloat-commentary-autonomous-mode]]: use tool_choice, never text-parse.
// The old `response_format: {type:"json_object"}` guaranteed only that the text
// looked like JSON — it still broke on raw newlines and unescaped quotes inside
// HTML bodies (2 of 3 real commentary runs). A forced tool call cannot produce
// invalid JSON, and the schema is enforced server-side, so `response_format`'s
// guarantee is preserved and strengthened rather than dropped.
//
// Raw fetch, deliberately: the server has no @anthropic-ai/sdk dependency and
// the pnpm lockfile is fragile enough that adding one is its own risk. The
// commentary agent already spoke this wire format by hand; this generalises it.
//
// 2026-10-02 (Mark, "do both"):
//   * The workhorse moved to Claude Sonnet 5.5 — same per-token price as Sonnet 5
//     (checked on the pricing page). Sonnet 5.5 REJECTS a forced tool_choice, so
//     llmJson now asks for the tool with tool_choice "auto" on that model and
//     retries once if prose comes back; Haiku keeps the forced call. Thinking is
//     switched off on Sonnet 5.5 ("between_tools") because every max_tokens below
//     was sized for the answer alone, and Sonnet 5 did not think inside a forced
//     tool call either — same output, same bill.
//   * Every request carries metadata.user_id = "site:<job>" so the Console's Logs
//     page says which job made it. `job` is REQUIRED and typed against
//     llm-jobs.json: an untagged or misspelled call does not compile.
//   The shared rules (models, tags, the bulk-run gate) live in claude-core.mjs.

import { logger } from "./logger";
import {
  routeLocally, shadowLocally, localText, localJson, shadowCompare,
} from "./llm-local";
import {
  MODELS, withJobTag, assertRequestAllowed, structuredCallShape, supportsBetweenTools,
} from "./claude-core.mjs";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** Every job tag a call from this server may carry — the keys of llm-jobs.json "site". */
export type SiteJob = keyof (typeof import("./llm-jobs.json"))["site"];

/** Default workhorse. Overridable per-deploy without a code change. */
export const DEFAULT_MODEL = process.env["LLM_MODEL"] || MODELS.DEFAULT;

/**
 * Captions, categorisation, one-line summaries, mechanical translation — work
 * where the judgement is thin and the volume is high. Not overridable by
 * LLM_MODEL: the point of `cheap` is that it is cheap.
 */
export const CHEAP_MODEL = process.env["LLM_CHEAP_MODEL"] || MODELS.CHEAP;

/** Two minutes matches what every ported call site used to allow OpenAI. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface LlmRequest {
  /**
   * Which job this call belongs to, e.g. "news.hubclass". REQUIRED: sent as
   * metadata.user_id = "site:<job>" so the Console attributes the spend. The same
   * label opts a job into the local box: routing is per job via LLM_LOCAL_JOBS,
   * shadow comparison via LLM_SHADOW_JOBS.
   */
  job: SiteJob;
  system: string;
  user: string;
  /** Explicit model id. Wins over `cheap` and over LLM_MODEL. */
  model?: string;
  /** Use the cheap model for thin-judgement, high-volume work. */
  cheap?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Reduce a result to the part a shadow comparison should judge. Without one,
   * two models are compared verbatim — and free prose or a differently-ordered
   * batch then reads as 100% disagreement, which measures nothing. Supply this
   * whenever the payload carries anything but the decision itself.
   */
  shadowNormalise?: (value: never) => unknown;
}

export interface LlmJsonRequest extends LlmRequest {
  /** JSON Schema for the object you want back. Becomes the tool's input_schema. */
  schema: Record<string, unknown>;
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; [k: string]: unknown };
  error?: { message?: string; type?: string };
}

export function anthropicConfigured(): boolean {
  return Boolean(process.env["ANTHROPIC_API_KEY"]);
}

function apiKey(): string {
  const key = process.env["ANTHROPIC_API_KEY"] || "";
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  return key;
}

/**
 * Nothing thrown from this module may carry the credential. The key is never
 * deliberately interpolated into a message, but error bodies are echoed back
 * from a remote service and these strings end up in logs, in the dashboard's
 * error toasts and in Mark's push notifications. Belt and braces.
 */
function redact(text: string, key: string): string {
  if (!key) return text;
  let out = text.split(key).join("***");
  // Any stray sk-ant-… shaped token, whichever key it belongs to.
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***");
  return out;
}

function modelFor(req: LlmRequest): string {
  if (req.model) return req.model;
  return req.cheap ? CHEAP_MODEL : DEFAULT_MODEL;
}

/**
 * One POST. Retries EXACTLY once, and only on the two failures that are worth
 * retrying — 429 and 5xx. A 400 (bad schema, bad model id) repeated is just the
 * same 400 twice, and a timeout retried doubles the wall clock on the calls
 * that are already the slowest thing the server does.
 *
 * The job tag is stamped here, at the last step before the wire, so no path
 * through this module can send an untagged request.
 */
async function post(
  job: SiteJob,
  body: Record<string, unknown>,
  timeoutMs: number,
  retries = 1,
): Promise<AnthropicResponse> {
  const tagged = withJobTag(body, job);
  assertRequestAllowed(tagged);
  const key = apiKey();
  let lastStatus = 0;
  let lastDetail = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1_000));

    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(tagged),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Read the body once, tolerantly: an error response is not always JSON.
    const raw = await response.text();
    let payload: AnthropicResponse = {};
    try {
      payload = JSON.parse(raw) as AnthropicResponse;
    } catch {
      payload = {};
    }

    if (response.ok) {
      if (payload.stop_reason === "refusal") {
        throw new Error("Anthropic declined this request (stop_reason=refusal)");
      }
      return payload;
    }

    lastStatus = response.status;
    lastDetail = payload.error?.message ?? raw.slice(0, 200);

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) break;
    // Only an attempt with a retry left says "retrying"; saying it on the last
    // would put a line in the log for something that never happens.
    if (attempt < retries) {
      logger.warn(
        { status: response.status, model: body["model"], job },
        "Anthropic call failed, retrying once",
      );
    }
  }

  throw new Error(redact(`Anthropic HTTP ${lastStatus}: ${lastDetail}`, key));
}

/**
 * Sonnet 5.5 thinks by default and cannot take "disabled"; "between_tools" is its
 * thinking-off switch. Every caller here sized max_tokens for the answer alone.
 */
function thinkingFor(model: string): Record<string, unknown> {
  return supportsBetweenTools(model) ? { thinking: { type: "between_tools" } } : {};
}

/** Prose in, prose out. Returns the concatenated text blocks, trimmed. */
export async function llmText(req: LlmRequest): Promise<string> {
  if (routeLocally(req.job)) {
    try {
      return await localText(req);
    } catch (err) {
      logger.warn(
        { job: req.job, err: err instanceof Error ? err.message : String(err) },
        "local LLM failed, falling back to Anthropic",
      );
    }
  }

  const model = modelFor(req);
  const payload = await post(
    req.job,
    {
      model,
      max_tokens: req.maxTokens ?? 2000,
      // No `temperature`: removed on the Claude 5 models and a hard 400 if sent.
      system: req.system,
      ...thinkingFor(model),
      messages: [{ role: "user", content: req.user }],
    },
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const text = (payload.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();

  if (shadowLocally(req.job)) {
    shadowCompare(req.job, text, () => localText(req),
      req.shadowNormalise as ((v: string) => unknown) | undefined);
  }
  return text;
}

/**
 * Prose in, schema-guaranteed object out.
 *
 * The model answers through a single tool named `emit` whose input_schema is the
 * caller's schema; the parsed tool input IS the return value. No text block is
 * read, so there is nothing to parse and nothing to fail on.
 *
 * Where the model still accepts a forced tool call (Haiku 4.5, Sonnet 5) it is
 * forced, exactly as before. Sonnet 5.5 rejects that with a 400, so there the
 * tool is offered with tool_choice "auto", the system prompt says to answer
 * through it, and a reply that comes back as prose is asked again ONCE.
 */
export async function llmJson<T = Record<string, unknown>>(req: LlmJsonRequest): Promise<T> {
  if (routeLocally(req.job)) {
    try {
      return await localJson<T>(req);
    } catch (err) {
      logger.warn(
        { job: req.job, err: err instanceof Error ? err.message : String(err) },
        "local LLM failed, falling back to Anthropic",
      );
    }
  }

  const model = modelFor(req);
  const shape = structuredCallShape(model, "emit");
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? 2000,
    system: shape.instruction ? `${req.system}\n\n${shape.instruction}` : req.system,
    tools: [
      {
        name: "emit",
        description: "Return the finished result. This is the only way to answer.",
        input_schema: req.schema,
      },
    ],
    tool_choice: shape.tool_choice,
    ...(shape.thinking ? { thinking: shape.thinking } : {}),
    messages: [{ role: "user", content: req.user }],
  };

  const attempts = shape.forced ? 1 : 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const payload = await post(req.job, body, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    // max_tokens mid-tool-call yields a truncated (and therefore absent) input.
    // Name it, because it used to surface as a bare "no structured result".
    if (payload.stop_reason === "max_tokens") {
      throw new Error(
        `Anthropic hit max_tokens (${req.maxTokens ?? 2000}) before finishing the structured result`,
      );
    }

    const block = (payload.content ?? []).find((b) => b.type === "tool_use" && b.name === "emit");
    if (block && block.input !== undefined && block.input !== null) {
      const result = block.input as T;
      if (shadowLocally(req.job)) {
        shadowCompare(req.job, result, () => localJson<T>(req),
          req.shadowNormalise as ((v: T) => unknown) | undefined);
      }
      return result;
    }
    if (attempt + 1 < attempts) {
      logger.warn({ job: req.job, model }, "model answered in prose instead of the emit tool — asking once more");
    }
  }
  throw new Error("Anthropic returned no structured result");
}

/**
 * A raw Messages call for the two shapes llmText/llmJson cannot express — the
 * commentary fact-check with live web search (server tools, pause_turn) and the
 * Conga Line draft that reports its own token cost. Still tagged, still checked.
 * `retries` defaults to 0: the web-search call already runs for minutes.
 */
export async function anthropicMessages(
  job: SiteJob,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<AnthropicResponse> {
  return post(job, body, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.retries ?? 0);
}
