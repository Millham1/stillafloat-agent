import { logger } from "./logger";

/**
 * transcriber.ts — the dashboard's "record your take" speech-to-text.
 *
 * Same shape as mailer.ts: this service owns none of the machinery, it just
 * makes one x-api-key'd localhost hop to the ops-manager, which runs Whisper on
 * our own CPU (agent/transcribe.py). No STT vendor, no per-minute bill — Mark's
 * standing rule is build and host on our server first.
 *
 * Unlike sendMail this is NOT best-effort: the person is staring at a spinner,
 * so every failure has to come back as a sentence they can act on.
 */

const OPS_URL = process.env["OPS_MANAGER_URL"] || "http://127.0.0.1:5000";

/**
 * How long we'll wait for the box. Node's fetch gives up on a response that
 * takes more than 300 s and reports it as an opaque "fetch failed", so we abort
 * a few seconds earlier and say something useful instead.
 */
const REQUEST_TIMEOUT_MS = 290_000;

/** Anything longer than this is refused here, before it is uploaded at all. */
export const MAX_RECORDING_SECONDS = 900;

export interface TranscribeInput {
  audioBase64: string;
  mime?: string | undefined;
  lang?: string | undefined;
}

export interface TranscribeOk {
  ok: true;
  transcript: string;
  language: string | null;
  durationS: number | null;
  model: string | null;
  wallS: number | null;
}

export interface TranscribeFail {
  ok: false;
  /** HTTP status this service should answer with. */
  status: number;
  /** Rendered verbatim in the dashboard toast — write it for Mark, not for a log. */
  error: string;
}

export type TranscribeResult = TranscribeOk | TranscribeFail;

const UNAVAILABLE =
  "Transcription service unavailable — the ops manager on this box isn't answering. " +
  "Type the take instead; nothing is lost.";

/**
 * Map an ops-manager status onto the sentence the dashboard shows. The Python
 * side already writes plain-English detail, so prefer it when it exists and only
 * fall back to these when it doesn't.
 */
function messageFor(status: number, detail: string): { status: number; error: string } {
  if (status === 413) {
    return {
      status: 413,
      error:
        `Recording too long — keep voice notes under ${Math.round(MAX_RECORDING_SECONDS / 60)} ` +
        `minutes${detail ? ` (${detail})` : ""}. Split it and transcribe each part.`,
    };
  }
  if (status === 409) {
    return {
      status: 409,
      error: "Another transcription is already running — give it a moment and try again.",
    };
  }
  if (status === 400) {
    return {
      status: 400,
      error: detail || "That audio couldn't be read. Re-record it and try again.",
    };
  }
  if (status === 401 || status === 403) {
    // Our own key is wrong — a config fault, not something Mark did.
    return { status: 503, error: UNAVAILABLE };
  }
  if (status === 503) {
    return {
      status: 503,
      error: detail
        ? `Transcription service unavailable — ${detail}`
        : UNAVAILABLE,
    };
  }
  return {
    status: 502,
    error: detail
      ? `Transcription failed — ${detail}`
      : "Transcription failed on the server. Try again, or type the take.",
  };
}

/** Pull FastAPI's `{detail: …}` out of a body that may not even be JSON. */
function detailOf(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown; error?: unknown };
    const d = parsed.detail ?? parsed.error;
    if (typeof d === "string") return d;
    if (d) return JSON.stringify(d);
  } catch {
    /* not JSON — fall through */
  }
  return raw.trim().slice(0, 300);
}

export async function transcribe(input: TranscribeInput): Promise<TranscribeResult> {
  const audioBase64 = (input.audioBase64 || "").trim();
  if (!audioBase64) {
    return { ok: false, status: 400, error: "No audio was sent. Record something first." };
  }

  const key = process.env["IDEAS_API_KEY"];
  if (!key) {
    logger.warn("transcriber: IDEAS_API_KEY unset — cannot reach the ops manager");
    return { ok: false, status: 503, error: UNAVAILABLE };
  }

  let res: Response;
  try {
    res = await fetch(`${OPS_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        audioBase64,
        mime: input.mime,
        lang: input.lang,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      logger.warn({ err }, "transcriber: timed out waiting for the ops manager");
      return {
        ok: false,
        status: 504,
        error:
          "That recording is taking longer than the dashboard will wait. It's still " +
          "running on the box — try again with a shorter clip.",
      };
    }
    logger.warn({ err }, "transcriber: ops manager unreachable");
    return { ok: false, status: 503, error: UNAVAILABLE };
  }

  const raw = await res.text();
  if (!res.ok) {
    const mapped = messageFor(res.status, detailOf(raw));
    logger.warn({ status: res.status, detail: detailOf(raw) }, "transcriber: non-200 from ops manager");
    return { ok: false, ...mapped };
  }

  let body: {
    transcript?: unknown;
    language?: unknown;
    duration_s?: unknown;
    model?: unknown;
    wall_s?: unknown;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 502, error: "Transcription failed — the server sent a reply we couldn't read." };
  }

  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    // A successful run that heard nothing: silence, a dead mic, a muted tab.
    return {
      ok: false,
      status: 422,
      error: "Nothing was said in that recording — check the microphone and try again.",
    };
  }

  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    ok: true,
    transcript,
    language: typeof body.language === "string" ? body.language : null,
    durationS: num(body.duration_s),
    model: typeof body.model === "string" ? body.model : null,
    wallS: num(body.wall_s),
  };
}
