/**
 * Local model provider — llama.cpp on the house box, reached over WireGuard.
 *
 * This exists to take mechanical, high-volume work off the metered API. It is
 * NEVER the only path: every call here is wrapped by llm.ts in a try/catch that
 * falls back to Anthropic, because the box sits on residential power and
 * internet and WILL disappear sometimes. A local failure must cost a log line
 * and a slightly larger bill, never a missed news scan.
 *
 * Measured on the box (Qwen3-30B-A3B Q4_K_M, CPU): ~17 tok/s generation,
 * ~78 tok/s prompt. Budget roughly 10x the wall clock of a Haiku call.
 */
import { logger } from "./logger";

// Every one of these is read LAZILY, not captured at module load. Routing a
// job to the local box is an operational decision Mark makes by editing
// shared.env; reading it fresh means the value in the file is the value in
// force, and it keeps the routing testable without module-cache games.

/** OpenAI-compatible endpoint, e.g. http://10.88.0.3:8080 over the tunnel. */
function base(): string {
  return process.env["LOCAL_LLM_URL"] || "";
}

function jobSet(key: string): Set<string> {
  return new Set((process.env[key] || "").split(",").map((s) => s.trim()).filter(Boolean));
}

/** Local generation is slow. A 120s API timeout would be a 12s local one. */
function localTimeoutMs(): number {
  return Number(process.env["LOCAL_LLM_TIMEOUT_MS"] || 90_000);
}

export function localConfigured(): boolean {
  return Boolean(base());
}

/**
 * Jobs that route to the local box, by label (LLM_LOCAL_JOBS, comma-separated,
 * matched exactly). Opt-in PER JOB: this is how a job is moved across, and how
 * it is moved back with one env edit. A call with no job label never routes.
 */
export function routeLocally(job?: string): boolean {
  return Boolean(base()) && Boolean(job) && jobSet("LLM_LOCAL_JOBS").has(job as string);
}

/**
 * Jobs that run BOTH providers (LLM_SHADOW_JOBS). Anthropic stays authoritative
 * and is what the caller gets; the local answer is computed alongside and any
 * disagreement logged. This is the evidence Mark asked for before a job flips.
 */
export function shadowLocally(job?: string): boolean {
  return Boolean(base()) && Boolean(job) && jobSet("LLM_SHADOW_JOBS").has(job as string);
}

interface OpenAiChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}
interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: { completion_tokens?: number };
  error?: { message?: string };
}

/**
 * MEASURED 2026-09-21 and the single most important thing about this provider.
 *
 * A JSON Schema alone constrains the grammar but does NOT tell the model what
 * is wanted, so it fights the constraint token by token: the same call cost
 * 414 tokens / 24.9s with the schema alone, and 27 tokens / 1.4s with the
 * fields also described in the prompt. Eighteen times faster, same answer.
 *
 * So we always describe the schema in words as well as enforcing it.
 */
function describeSchema(schema: Record<string, unknown>): string {
  const props = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema["required"] as string[] | undefined) ?? []);
  const parts: string[] = [];

  for (const [name, spec] of Object.entries(props)) {
    const enumValues = spec["enum"] as unknown[] | undefined;
    let type: string;
    if (enumValues?.length) {
      type = `one of ${enumValues.join(", ")}`;
    } else if (spec["type"] === "array") {
      const items = spec["items"] as Record<string, unknown> | undefined;
      type = `array of ${(items?.["type"] as string) ?? "values"}`;
    } else {
      type = (spec["type"] as string) ?? "value";
    }
    parts.push(`${name} (${type}${required.has(name) ? "" : ", optional"})`);
  }

  if (!parts.length) return "Return a JSON object.";
  return `Return a JSON object with keys: ${parts.join("; ")}. Return only the JSON.`;
}

async function post(body: Record<string, unknown>, timeoutMs: number): Promise<OpenAiResponse> {
  const response = await fetch(`${base()}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  let payload: OpenAiResponse = {};
  try {
    payload = JSON.parse(raw) as OpenAiResponse;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(`local LLM HTTP ${response.status}: ${payload.error?.message ?? raw.slice(0, 200)}`);
  }
  return payload;
}

export interface LocalTextRequest {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function localText(req: LocalTextRequest): Promise<string> {
  const payload = await post(
    {
      model: "qwen3-30b",
      max_tokens: req.maxTokens ?? 2000,
      temperature: 0,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    },
    req.timeoutMs ?? localTimeoutMs(),
  );

  const text = payload.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("local LLM returned empty text");
  return text.trim();
}

export interface LocalJsonRequest extends LocalTextRequest {
  schema: Record<string, unknown>;
}

export async function localJson<T = Record<string, unknown>>(req: LocalJsonRequest): Promise<T> {
  const payload = await post(
    {
      model: "qwen3-30b",
      max_tokens: req.maxTokens ?? 2000,
      temperature: 0,
      messages: [
        { role: "system", content: req.system },
        // The described schema rides with the user turn — see describeSchema.
        { role: "user", content: `${req.user}\n\n${describeSchema(req.schema)}` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema: req.schema },
      },
    },
    req.timeoutMs ?? localTimeoutMs(),
  );

  const choice = payload.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("local LLM hit max_tokens before finishing the structured result");
  }
  const text = choice?.message?.content ?? "";
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`local LLM returned unparseable JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Run the local model alongside a result Anthropic already produced and log any
 * disagreement. Never throws and never changes what the caller receives — a
 * shadow run that fails is a quiet log line, not an incident.
 */
export function shadowCompare<T>(
  job: string,
  authoritative: T,
  run: () => Promise<T>,
): void {
  void run()
    .then((local) => {
      const a = JSON.stringify(authoritative);
      const b = JSON.stringify(local);
      if (a === b) {
        logger.info({ job, agree: true }, "llm shadow: local agreed");
      } else {
        logger.warn(
          { job, agree: false, anthropic: a.slice(0, 500), local: b.slice(0, 500) },
          "llm shadow: local DISAGREED",
        );
      }
    })
    .catch((err: unknown) => {
      logger.info(
        { job, err: err instanceof Error ? err.message : String(err) },
        "llm shadow: local run failed",
      );
    });
}
