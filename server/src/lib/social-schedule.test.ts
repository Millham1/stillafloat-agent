import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isStale, staleDays, STALE_DAYS_DEFAULT, decideOutcome,
  isPending, batchIsDone, healClosedBatches, processQueue, applyPostNow,
  STALE_UNRESOLVED, NO_SLOT,
} from "./social-schedule";
import type { PublishResult } from "./social-publish";
import type { QueuedBatch, SocialPost } from "./social-agent";

const DAY = 86_400_000;

describe("social poster stale rule", () => {
  it("defaults to 7 days; env overrides only with a positive number", () => {
    assert.equal(staleDays(undefined), STALE_DAYS_DEFAULT);
    assert.equal(staleDays("3"), 3);
    assert.equal(staleDays("0"), STALE_DAYS_DEFAULT);
    assert.equal(staleDays("nope"), STALE_DAYS_DEFAULT);
  });
  it("an item past due longer than the window is stale; a fresh one is not", () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    assert.equal(isStale(new Date(now - 8 * DAY).toISOString(), now, 7), true);
    assert.equal(isStale(new Date(now - 6 * DAY).toISOString(), now, 7), false);
    assert.equal(isStale(new Date(now + DAY).toISOString(), now, 7), false);
    assert.equal(isStale(undefined, now, 7), false);
    assert.equal(isStale("garbage", now, 7), false);
  });
});

describe("social poster outcome per publish result", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  const fresh = new Date(now - DAY).toISOString();
  const old = new Date(now - 8 * DAY).toISOString();
  it("ok → posted", () => {
    assert.deepEqual(decideOutcome({ ok: true, reason: "posted" }, fresh, now, 7), { kind: "posted" });
  });
  it("retry reasons stay scheduled while fresh, become skipped:stale after the window", () => {
    for (const reason of ["ig-no-clip", "ig-not-configured", "fb-not-configured"]) {
      assert.deepEqual(decideOutcome({ ok: false, reason }, fresh, now, 7), { kind: "retry" });
      assert.deepEqual(decideOutcome({ ok: false, reason }, old, now, 7), { kind: "skipped", error: `stale:${reason}` });
    }
  });
  it("language off and manual-only surfaces are skipped immediately, tagged with the reason", () => {
    assert.deepEqual(decideOutcome({ ok: false, reason: "ig-lang-off" }, fresh, now, 7), { kind: "skipped", error: "ig-lang-off" });
    assert.deepEqual(decideOutcome({ ok: false, reason: "personal-manual" }, old, now, 7), { kind: "skipped", error: "personal-manual" });
  });
  it("anything else is a hard failure carrying the reason", () => {
    assert.deepEqual(decideOutcome({ ok: false, reason: "HTTP 500" }, fresh, now, 7), { kind: "failed", error: "HTTP 500" });
    assert.deepEqual(decideOutcome({ ok: false, reason: "fetch failed" }, old, now, 7), { kind: "failed", error: "fetch failed" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A batch is "posted" only when every post in it has an outcome, and the poster resolves a post
// left pending inside a batch already marked posted. Seen on the dev box 2026-10-17: batch
// a0cb81d1 was "posted" while its Instagram (ES, slot 2026-10-10T21:00Z) and Facebook (ES, slot
// 2026-10-11T13:00Z) posts carried postState "scheduled" and neither postedAt nor postError.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const at = (ms: number) => new Date(ms).toISOString();
const post = (over: Partial<SocialPost> = {}): SocialPost => ({
  platform: "facebook", surface: "Still Afloat Page", ctaType: "subscribe", linkInBio: false,
  track: "B", lang: "es", caption: "Hola", hashtags: [], link: "https://stillafloatcruising.com/es/", videoId: "vid", videoUrl: "https://y",
  ...over,
} as SocialPost);
const batch = (status: QueuedBatch["status"], posts: SocialPost[], id = "b1"): QueuedBatch => ({
  id, status, createdAt: "2026-09-09T00:00:00Z", videoId: "vid", title: "t", track: "B", lang: "es",
  generatedAt: "2026-09-09T00:00:00Z", transcriptChars: 0, posts,
} as QueuedBatch);
const youtubeSkipped = () => post({ platform: "youtube", surface: "YouTube", postState: "skipped", postError: "youtube-source" });
const ig = (over: Partial<SocialPost> = {}) => post({ platform: "instagram", surface: "Still Afloat Reels", ...over });
const published = (p: SocialPost): PublishResult => ({ surface: p.surface, platform: p.platform, ok: true, reason: "posted" });
const refused = (reason: string) => async (p: SocialPost): Promise<PublishResult> => ({ surface: p.surface, platform: p.platform, ok: false, reason });
/** A publish function that records which posts it was asked to send. */
function recorder(reply: (p: SocialPost) => PublishResult | Promise<PublishResult> = published) {
  const sent: SocialPost[] = [];
  return { sent, publish: async (p: SocialPost) => { sent.push(p); return reply(p); } };
}

// The release gate's idea of an unresolved calendar item (e2e/checks/jobs.mjs).
const gateUnresolved = (i: { postedAt?: string; postState?: string }) => !i.postedAt && (!i.postState || i.postState === "scheduled");

describe("a batch is posted only when every post has an outcome", () => {
  it("isPending: no outcome yet, for schedulable posts only", () => {
    assert.equal(isPending(post({ postState: "scheduled", scheduledFor: "2026-10-10T21:00:00Z" })), true);
    assert.equal(isPending(post({})), true); // never given a state
    assert.equal(isPending(post({ postedAt: "2026-10-10T21:01:00Z", postState: "posted" })), false);
    assert.equal(isPending(post({ postState: "failed", postError: "HTTP 500" })), false);
    assert.equal(isPending(post({ postState: "skipped", postError: "ig-lang-off" })), false);
    assert.equal(isPending(youtubeSkipped()), false);
    assert.equal(isPending(post({ platform: "youtube", surface: "YouTube" })), false); // can never be posted
    assert.equal(isPending(post({ surface: "Personal Facebook" })), false); // manual-only
  });

  it("a batch with one pending post is not done; with every outcome recorded it is", () => {
    const pending = ig({ postState: "scheduled", scheduledFor: "2026-10-10T21:00:00Z" });
    const done = post({ postedAt: "2026-10-11T13:02:00Z", postState: "posted" });
    assert.equal(batchIsDone(batch("scheduled", [youtubeSkipped(), done, pending])), false);
    assert.equal(batchIsDone(batch("scheduled", [youtubeSkipped(), done, ig({ postState: "failed", postError: "HTTP 500" })])), true);
  });

  it("the poster does not mark a batch posted while one post is still waiting for its slot", async () => {
    const now = Date.parse("2026-10-10T14:00:00Z");
    const due = post({ postState: "scheduled", scheduledFor: at(now - 2 * HOUR) });
    const later = ig({ postState: "scheduled", scheduledFor: at(now + 7 * HOUR) });
    const b = batch("scheduled", [youtubeSkipped(), due, later]);
    const { sent, publish } = recorder();
    const r = await processQueue({ batches: [b] }, now, publish, { staleAfterDays: 7 });
    assert.equal(r.posted, 1);
    assert.equal(sent.length, 1);
    assert.equal(due.postState, "posted");
    assert.ok(due.postedAt);
    assert.equal(later.postState, "scheduled");
    assert.equal(b.status, "scheduled", "one post is still pending, so the batch is not posted");
    // …and once its slot has come and it has posted, the batch closes.
    const r2 = await processQueue({ batches: [b] }, now + 8 * HOUR, publish, { staleAfterDays: 7 });
    assert.equal(r2.posted, 1);
    assert.equal(b.status, "posted");
  });

  it("a due post that must retry (no Instagram clip yet) keeps its batch open", async () => {
    const now = Date.parse("2026-10-10T22:00:00Z");
    const reel = ig({ postState: "scheduled", scheduledFor: at(now - HOUR) });
    const b = batch("scheduled", [youtubeSkipped(), reel]);
    await processQueue({ batches: [b] }, now, refused("ig-no-clip"), { staleAfterDays: 7 });
    assert.equal(reel.postState, "scheduled");
    assert.equal(b.status, "scheduled");
  });

  it("approve-now records every outcome and closes the batch only if nothing is left pending", async () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    // Scheduled earlier (slots in the future), then approved "now": the case that left posts with no outcome.
    const fb = post({ postState: "scheduled", scheduledFor: at(now + 20 * HOUR) });
    const reel = ig({ postState: "scheduled", scheduledFor: at(now + 9 * HOUR) });
    const b = batch("approved", [{ ...youtubeSkipped() }, fb, reel]);
    const { sent, publish } = recorder((p) => (p.platform === "instagram" ? { surface: p.surface, platform: p.platform, ok: false, reason: "ig-no-clip" } : published(p)));
    const results = await applyPostNow(b, now, publish, 7);
    assert.deepEqual(results.map((x) => [x.platform, x.ok]), [["youtube", false], ["facebook", true], ["instagram", false]]);
    assert.equal(fb.postState, "posted");
    assert.ok(fb.postedAt);
    assert.equal(fb.scheduledFor, at(now), "a post sent now has now as its slot, so it never reads as sent before its slot");
    assert.equal(reel.postState, "scheduled", "the Instagram post could not go yet — it waits for the poster's retry");
    assert.equal(b.status, "scheduled", "not posted: one post is still pending");
    assert.equal(sent.length, 2, "YouTube is never published");

    // The retry succeeds on a later tick and the batch closes.
    const r = await processQueue({ batches: [b] }, now + HOUR, async (p) => published(p), { staleAfterDays: 7 });
    assert.equal(r.posted, 1);
    assert.equal(reel.postState, "posted");
    assert.equal(b.status, "posted");
  });

  it("approve-now never publishes a post twice and closes a batch when all posts resolve", async () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    const already = post({ postedAt: at(now - HOUR), postState: "posted", scheduledFor: at(now - HOUR) });
    const fresh = ig({ postState: "scheduled", scheduledFor: at(now + HOUR) });
    const b = batch("approved", [already, fresh]);
    const { sent, publish } = recorder();
    await applyPostNow(b, now, publish, 7);
    assert.deepEqual(sent, [fresh]);
    assert.equal(b.status, "posted");
  });
});

describe("the poster resolves pending posts inside batches already marked posted", () => {
  // The shape seen on dev 2026-10-17.
  const stuckDevBatch = () => batch("posted", [
    youtubeSkipped(),
    ig({ postState: "scheduled", scheduledFor: "2026-10-10T21:00:00Z" }),
    post({ postState: "scheduled", scheduledFor: "2026-10-11T13:00:00Z" }),
  ], "a0cb81d1");

  it("posts them when their slot is within the stale window", async () => {
    const now = Date.parse("2026-10-17T12:00:00Z"); // 6d15h after the first slot
    const b = stuckDevBatch();
    const { sent, publish } = recorder();
    const r = await processQueue({ batches: [b] }, now, publish, { staleAfterDays: 7 });
    assert.equal(r.posted, 2);
    assert.equal(sent.length, 2);
    assert.deepEqual(r.healed.reopened, ["a0cb81d1"]);
    for (const p of b.posts.slice(1)) {
      assert.equal(p.postState, "posted");
      assert.ok(p.postedAt);
    }
    assert.equal(b.status, "posted", "closed again once both have an outcome");
    assert.equal(batchIsDone(b), true);
  });

  it("skips them as stale, with a reason and without publishing, once the slot is past the window", async () => {
    const now = Date.parse("2026-10-18T14:00:00Z"); // both slots more than 7 days back (7d17h and 7d01h)
    const b = stuckDevBatch();
    const { sent, publish } = recorder();
    const r = await processQueue({ batches: [b] }, now, publish, { staleAfterDays: 7 });
    assert.equal(sent.length, 0, "nothing stale is sent");
    assert.equal(r.posted, 0);
    assert.equal(r.healed.skippedStale, 2);
    for (const p of b.posts.slice(1)) {
      assert.equal(p.postState, "skipped");
      assert.equal(p.postError, STALE_UNRESOLVED);
      assert.equal(p.postedAt, undefined);
    }
    assert.equal(b.status, "posted");
    assert.equal(r.changed, true);
  });

  it("a future slot reopens the batch and waits; a stale one beside it is skipped", async () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const old = ig({ postState: "scheduled", scheduledFor: at(now - 9 * 24 * HOUR) });
    const future = post({ postState: "scheduled", scheduledFor: at(now + 3 * HOUR) });
    const b = batch("posted", [old, future]);
    const { sent, publish } = recorder();
    const r1 = await processQueue({ batches: [b] }, now, publish, { staleAfterDays: 7 });
    assert.equal(sent.length, 0);
    assert.equal(old.postError, STALE_UNRESOLVED);
    assert.equal(future.postState, "scheduled");
    assert.equal(b.status, "scheduled");
    assert.deepEqual(r1.healed.reopened, [b.id]);
    const r2 = await processQueue({ batches: [b] }, now + 4 * HOUR, publish, { staleAfterDays: 7 });
    assert.equal(r2.posted, 1);
    assert.equal(b.status, "posted");
  });

  it("a pending post with no slot at all is skipped with its own reason", () => {
    const orphan = post({});
    const b = batch("posted", [orphan]);
    const h = healClosedBatches([b], Date.now(), 7);
    assert.equal(h.skippedNoSlot, 1);
    assert.equal(orphan.postState, "skipped");
    assert.equal(orphan.postError, NO_SLOT);
    assert.equal(b.status, "posted");
  });

  it("leaves a healthy posted batch exactly as it is", async () => {
    const b = batch("posted", [
      youtubeSkipped(),
      post({ postedAt: "2026-10-01T13:02:00Z", postState: "posted", scheduledFor: "2026-10-01T13:00:00Z" }),
      ig({ postState: "failed", postError: "HTTP 500", scheduledFor: "2026-10-01T21:00:00Z" }),
    ]);
    const before = JSON.stringify(b);
    const { sent, publish } = recorder();
    const r = await processQueue({ batches: [b] }, Date.parse("2026-10-17T12:00:00Z"), publish, { staleAfterDays: 7 });
    assert.equal(JSON.stringify(b), before);
    assert.equal(sent.length, 0);
    assert.equal(r.changed, false);
  });
});

describe("the release gate's stale rule agrees with the poster's", () => {
  // e2e/checks/jobs.mjs flags a due post still waiting after 7 days + 30 minutes. The poster's
  // window is staleDays() (7 by default) and it ticks every 10 minutes.
  const GATE_DAYS = 7;
  const GATE_GRACE_MS = 30 * 60_000;
  const TICK_MS = 10 * 60_000;
  const gateFlags = (slot: number, now: number) => slot < now - GATE_DAYS * 24 * HOUR - GATE_GRACE_MS;

  it("the gate still says what this test assumes", () => {
    let d = process.cwd();
    let src: string | null = null;
    for (let i = 0; i < 6 && src === null; i++) {
      const f = path.join(d, "e2e", "checks", "jobs.mjs");
      if (fs.existsSync(f)) src = fs.readFileSync(f, "utf8");
      d = path.dirname(d);
    }
    assert.ok(src, `e2e/checks/jobs.mjs not found above ${process.cwd()} — run the tests from server/ inside the monorepo`);
    assert.ok(src.includes("at(i) < now - 7 * DAY - 30 * 60_000"), "the gate's overdue rule changed — update this test and the poster together");
    assert.ok(src.includes('!i.postedAt && (!i.postState || i.postState === "scheduled")'), "the gate's definition of an unresolved post changed");
  });

  it("the poster's window is the gate's seven days, and the gate's grace covers a poster tick", () => {
    assert.equal(STALE_DAYS_DEFAULT, GATE_DAYS);
    assert.ok(GATE_GRACE_MS >= 2 * TICK_MS, "the gate must wait longer than a tick or two before calling a post overdue");
  });

  it("after one poster pass nothing the gate would flag is left pending, at any age around the boundary", async () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    for (let min = -3 * 60; min <= 3 * 60; min += 5) {
      const slot = now - GATE_DAYS * 24 * HOUR + min * 60_000; // from 3 hours inside to 3 hours past the window
      const p = post({ postState: "scheduled", scheduledFor: at(slot) });
      const b = batch("posted", [p]);
      // The poster pass with a publish step that cannot send (the worst case: nothing resolves it by posting).
      await processQueue({ batches: [b] }, now, refused("ig-no-clip"), { staleAfterDays: STALE_DAYS_DEFAULT });
      const item = { postedAt: p.postedAt, postState: p.postState };
      assert.equal(gateFlags(slot, now) && gateUnresolved(item), false, `slot ${min} minutes from the window edge is flagged by the gate but still pending after the poster ran`);
      if (slot < now - GATE_DAYS * 24 * HOUR) {
        assert.equal(gateUnresolved(item), false, `slot ${min} minutes from the edge is past the poster's window but was not resolved`);
      }
    }
  });

  it("every outcome the poster records reads as resolved to the gate", async () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const fresh = at(now - HOUR);
    const stale = at(now - 9 * 24 * HOUR);
    const cases: Array<[string, SocialPost, (p: SocialPost) => Promise<PublishResult>]> = [
      ["posted", ig({ postState: "scheduled", scheduledFor: fresh }), async (p) => published(p)],
      ["failed", ig({ postState: "scheduled", scheduledFor: fresh }), refused("HTTP 500")],
      ["language off", ig({ postState: "scheduled", scheduledFor: fresh }), refused("ig-lang-off")],
      ["stale retry reason", ig({ postState: "scheduled", scheduledFor: stale }), refused("ig-no-clip")],
      ["stale in a closed batch", ig({ postState: "scheduled", scheduledFor: stale }), refused("ig-no-clip")],
    ];
    for (const [name, p, pub] of cases) {
      const b = batch(name === "stale in a closed batch" ? "posted" : "scheduled", [p]);
      await processQueue({ batches: [b] }, now, pub, { staleAfterDays: 7 });
      assert.equal(gateUnresolved(p), false, `${name}: the gate would still call it unresolved`);
      assert.equal(isPending(p), false, `${name}: the poster would still call it pending`);
      assert.equal(b.status, "posted", `${name}: the batch should have closed`);
    }
  });
});
