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

import { logger } from "./logger";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** Default workhorse. Overridable per-deploy without a code change. */
export const DEFAULT_MODEL = process.env["LLM_MODEL"] || "claude-sonnet-5";

/**
 * Captions, categorisation, one-line summaries, mechanical translation — work
 * where the judgement is thin and the volume is high. Not overridable by
 * LLM_MODEL: the point of `cheap` is that it is cheap.
 */
export const CHEAP_MODEL = process.env["LLM_CHEAP_MODEL"] || "claude-haiku-4-5";

/** Two minutes matches what every ported call site used to allow OpenAI. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface LlmRequest {
  system: string;
  user: string;
  /** Explicit model id. Wins over `cheap` and over LLM_MODEL. */
  model?: string;
  /** Use the cheap model for thin-judgement, high-volume work. */
  cheap?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmJsonRequest extends LlmRequest {
  /** JSON Schema for the object you want back. Becomes the tool's input_schema. */
  schema: Record<string, unknown>;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  model?: string;
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
 */
async function post(body: Record<string, unknown>, timeoutMs: number): Promise<AnthropicResponse> {
  const key = apiKey();
  let lastStatus = 0;
  let lastDetail = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1_000));

    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
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
    logger.warn(
      { status: response.status, model: body["model"] },
      "Anthropic call failed, retrying once",
    );
  }

  throw new Error(redact(`Anthropic HTTP ${lastStatus}: ${lastDetail}`, key));
}

/** Prose in, prose out. Returns the concatenated text blocks, trimmed. */
export async function llmText(req: LlmRequest): Promise<string> {
  const payload = await post(
    {
      model: modelFor(req),
      max_tokens: req.maxTokens ?? 2000,
      // No `temperature`: removed on the Claude 5 models and a hard 400 if sent.
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    },
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  return (payload.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

/**
 * Prose in, schema-guaranteed object out.
 *
 * The model is forced to call a single tool named `emit` whose input_schema is
 * the caller's schema; the parsed tool input IS the return value. No text
 * block is read, so there is nothing to parse and nothing to fail on.
 */
export async function llmJson<T = Record<string, unknown>>(req: LlmJsonRequest): Promise<T> {
  const payload = await post(
    {
      model: modelFor(req),
      max_tokens: req.maxTokens ?? 2000,
      system: req.system,
      tools: [
        {
          name: "emit",
          description: "Return the finished result. This is the only way to answer.",
          input_schema: req.schema,
        },
      ],
      tool_choice: { type: "tool", name: "emit" },
      messages: [{ role: "user", content: req.user }],
    },
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  // max_tokens mid-tool-call yields a truncated (and therefore absent) input.
  // Name it, because it used to surface as a bare "no structured result".
  if (payload.stop_reason === "max_tokens") {
    throw new Error(
      `Anthropic hit max_tokens (${req.maxTokens ?? 2000}) before finishing the structured result`,
    );
  }

  const block = (payload.content ?? []).find((b) => b.type === "tool_use" && b.name === "emit");
  if (!block || block.input === undefined || block.input === null) {
    throw new Error("Anthropic returned no structured result");
  }
  return block.input as T;
}
