// transcriber.test.ts — the dashboard's "record your take" proxy.
//
// This module is one hop to the ops-manager, so what actually needs testing is
// the translation layer: every way that hop can fail has to arrive at the
// dashboard as ONE sentence Mark can act on, with a status that matches. The
// route hands `error` straight to a toast, so a wrong string here is a wrong
// string on his screen.
//
// fetch is stubbed — nothing here touches the network or the box.

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { transcribe, MAX_RECORDING_SECONDS } from "./transcriber";

const realFetch = globalThis.fetch;
let envKey: string | undefined;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
let calls: Call[] = [];

/** Answer the next fetch with `[status, body]`. `body` may be a string. */
function stubFetch(status: number, payload: unknown): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    } as Response;
  }) as unknown as typeof fetch;
}

/** Make fetch itself blow up, the way an unreachable or slow box does. */
function stubFetchThrows(err: Error): void {
  globalThis.fetch = (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

const AUDIO = Buffer.from("pretend-webm-opus-bytes").toString("base64");

beforeEach(() => {
  calls = [];
  envKey = process.env["IDEAS_API_KEY"];
  process.env["IDEAS_API_KEY"] = "test-ideas-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (envKey === undefined) delete process.env["IDEAS_API_KEY"];
  else process.env["IDEAS_API_KEY"] = envKey;
});

// ── the happy path ───────────────────────────────────────────────────────────

test("a successful transcription keeps the {audioBase64} → {transcript} contract", async () => {
  stubFetch(200, {
    ok: true,
    transcript: "  This is a test of the Still Afloat transcription.  ",
    language: "en",
    duration_s: 20.4,
    model: "small",
    wall_s: 11.2,
  });

  const out = await transcribe({ audioBase64: AUDIO, mime: "audio/webm;codecs=opus" });

  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.transcript, "This is a test of the Still Afloat transcription.");
  assert.equal(out.language, "en");
  assert.equal(out.durationS, 20.4);
  assert.equal(out.model, "small");
  assert.equal(out.wallS, 11.2);
});

test("the request goes to the ops manager, x-api-key'd, with the audio intact", async () => {
  stubFetch(200, { transcript: "hi" });
  await transcribe({ audioBase64: AUDIO, mime: "audio/webm", lang: "es" });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/transcribe$/);
  assert.equal(calls[0]!.headers["x-api-key"], "test-ideas-key");
  assert.equal(calls[0]!.body["audioBase64"], AUDIO);
  assert.equal(calls[0]!.body["mime"], "audio/webm");
  assert.equal(calls[0]!.body["lang"], "es");
});

// ── refusals that never leave this process ───────────────────────────────────

test("empty audio is refused before anything is uploaded", async () => {
  stubFetch(200, { transcript: "should never be reached" });
  const out = await transcribe({ audioBase64: "   " });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 400);
  assert.match(out.error, /record something/i);
  assert.equal(calls.length, 0, "no audio means no request");
});

test("a missing IDEAS_API_KEY reads as 'unavailable', not as Mark's mistake", async () => {
  delete process.env["IDEAS_API_KEY"];
  stubFetch(200, { transcript: "nope" });
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 503);
  assert.match(out.error, /transcription service unavailable/i);
  assert.equal(calls.length, 0);
});

// ── the toasts ───────────────────────────────────────────────────────────────

test("the box being down says 'transcription service unavailable'", async () => {
  stubFetchThrows(Object.assign(new Error("fetch failed"), { name: "TypeError" }));
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 503);
  assert.match(out.error, /transcription service unavailable/i);
  assert.match(out.error, /type the take instead/i);
});

test("a 413 from the box says 'recording too long' and names the limit", async () => {
  stubFetch(413, { detail: "recording is 1200 seconds; the limit is 900" });
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 413);
  assert.match(out.error, /recording too long/i);
  assert.match(out.error, new RegExp(`${Math.round(MAX_RECORDING_SECONDS / 60)} minutes`));
  assert.match(out.error, /1200 seconds/);
});

test("a 409 tells the second click to wait rather than looking broken", async () => {
  stubFetch(409, { detail: "another transcription is already running — try again in a moment" });
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 409);
  assert.match(out.error, /already running/i);
});

test("undecodable audio keeps the box's own explanation", async () => {
  stubFetch(400, { detail: "could not decode the audio (Invalid data found)" });
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 400);
  assert.match(out.error, /could not decode the audio/);
});

test("a missing ffmpeg or model is 'unavailable' plus the reason", async () => {
  stubFetch(503, { detail: "ffmpeg is not installed on this host — transcription unavailable" });
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 503);
  assert.match(out.error, /transcription service unavailable/i);
  assert.match(out.error, /ffmpeg/);
});

test("a bad api key is OUR fault, so Mark sees 'unavailable' and not '401'", async () => {
  stubFetch(401, { detail: "invalid api key" });
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 503);
  assert.doesNotMatch(out.error, /api key/i);
});

test("an unexpected 500 becomes a 502 with the server's reason", async () => {
  stubFetch(500, { detail: "transcription failed: ctranslate2 exploded" });
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 502);
  assert.match(out.error, /ctranslate2 exploded/);
});

test("a non-JSON error body (an nginx page, say) still yields a sentence", async () => {
  stubFetch(502, "<html><head><title>502 Bad Gateway</title></head></html>");
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 502);
  assert.match(out.error, /transcription failed/i);
});

test("waiting too long says so instead of surfacing 'fetch failed'", async () => {
  stubFetchThrows(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }));
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 504);
  assert.match(out.error, /shorter clip/i);
  assert.doesNotMatch(out.error, /fetch failed/);
});

// ── the quiet failure ────────────────────────────────────────────────────────

test("silence is not a successful empty transcript", async () => {
  // A dead mic returns 200 with nothing in it. Pasting "" into the editor and
  // saying "Transcribed" would be the worst possible answer.
  stubFetch(200, { ok: true, transcript: "   ", language: "en", duration_s: 30 });
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 422);
  assert.match(out.error, /nothing was said/i);
});

test("a reply that isn't JSON at all is reported, not thrown", async () => {
  stubFetch(200, "not json");
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 502);
});

test("missing optional fields degrade to null rather than undefined noise", async () => {
  stubFetch(200, { transcript: "just the words" });
  const out = await transcribe({ audioBase64: AUDIO });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.language, null);
  assert.equal(out.durationS, null);
  assert.equal(out.model, null);
});
