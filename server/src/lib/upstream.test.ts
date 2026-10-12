import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, fetchWithBackoff, loaderCache } from "./upstream";

const res = (status: number, retryAfter?: string) => ({ ok: status >= 200 && status < 300, status, headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter ?? null : null) } });
const noSleep = async () => {};

describe("backoff wait", () => {
  it("honours Retry-After (seconds), capped", () => {
    assert.equal(backoffMs(0, "2"), 2000);
    assert.equal(backoffMs(0, "60"), 4000);
    assert.equal(backoffMs(0, "0"), 0);
  });
  it("otherwise doubles from 400 ms with jitter under 250 ms, capped", () => {
    assert.equal(backoffMs(0, null, () => 0), 400);
    assert.equal(backoffMs(1, null, () => 0), 800);
    assert.equal(backoffMs(2, null, () => 0.999), 1600 + 249);
    assert.equal(backoffMs(8, null, () => 0), 4000);
    assert.equal(backoffMs(0, "junk", () => 0), 400);
  });
});

describe("fetchWithBackoff", () => {
  it("returns a good answer at once, and a plain 404 without retrying", async () => {
    let n = 0;
    assert.equal((await fetchWithBackoff(async () => { n++; return res(200); }, "u", undefined, { sleep: noSleep })).status, 200);
    n = 0;
    assert.equal((await fetchWithBackoff(async () => { n++; return res(404); }, "u", undefined, { sleep: noSleep })).status, 404);
    assert.equal(n, 1);
  });
  it("retries a 429 after the pause the API asked for, then succeeds", async () => {
    const waits: number[] = [];
    const answers = [res(429, "1"), res(429), res(200)];
    let i = 0;
    const r = await fetchWithBackoff(async () => answers[i++]!, "u", undefined, { sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
    assert.equal(r.status, 200);
    assert.deepEqual(waits, [1000, 800]);
  });
  it("gives back the last response when every attempt is refused, and retries a dropped connection", async () => {
    let n = 0;
    const r = await fetchWithBackoff(async () => { n++; return res(503); }, "u", undefined, { sleep: noSleep, attempts: 3 });
    assert.equal(r.status, 503);
    assert.equal(n, 3);
    let k = 0;
    const r2 = await fetchWithBackoff(async () => { if (k++ === 0) throw new Error("Parse Error"); return res(200); }, "u", undefined, { sleep: noSleep });
    assert.equal(r2.status, 200);
    await assert.rejects(fetchWithBackoff(async () => { throw new Error("down"); }, "u", undefined, { sleep: noSleep, attempts: 2 }), /down/);
  });
});

describe("loader cache", () => {
  it("serves a fresh answer without loading again, and asks again once it has expired", async () => {
    let t = 0, loads = 0;
    const c = loaderCache<number>({ ttlMs: 1000, staleMs: 5000, now: () => t });
    assert.equal(await c.get("a", async () => ++loads), 1);
    t = 999; assert.equal(await c.get("a", async () => ++loads), 1);
    t = 1000; assert.equal(await c.get("a", async () => ++loads), 2);
    assert.equal(loads, 2);
  });
  it("shares one load between callers asking at the same time", async () => {
    let loads = 0;
    const c = loaderCache<number>({ ttlMs: 1000, staleMs: 0 });
    const slow = async () => { loads++; await new Promise((r) => setTimeout(r, 10)); return 7; };
    assert.deepEqual(await Promise.all([c.get("k", slow), c.get("k", slow), c.get("k", slow)]), [7, 7, 7]);
    assert.equal(loads, 1);
  });
  it("serves the last good answer when a refresh fails, but only within the stale window", async () => {
    let t = 0;
    const c = loaderCache<string>({ ttlMs: 1000, staleMs: 5000, now: () => t });
    await c.get("p", async () => "good");
    t = 2000; assert.equal(await c.get("p", async () => { throw new Error("429"); }), "good");
    t = 6001; await assert.rejects(c.get("p", async () => { throw new Error("429"); }), /429/);
  });
  it("never caches a failure, and a place with no good answer yet still fails", async () => {
    const c = loaderCache<number>({ ttlMs: 1000, staleMs: 5000 });
    await assert.rejects(c.get("x", async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await c.get("x", async () => 3), 3);
  });
  it("drops the whole map when it grows past its limit", async () => {
    const c = loaderCache<number>({ ttlMs: 1000, staleMs: 0, max: 2 });
    await c.get("a", async () => 1); await c.get("b", async () => 2); await c.get("c", async () => 3);
    assert.equal(c.size(), 1);
  });
});
