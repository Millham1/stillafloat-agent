import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sinkEnabled, sinkEntry, pickBatchToFeed } from "./social-sink";
import type { QueuedBatch, SocialPost } from "./social-agent";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const HOUR = 3_600_000;
const post = (over: Partial<SocialPost> = {}): SocialPost => ({
  platform: "facebook", surface: "Still Afloat Page", track: "B", lang: "en", caption: "Hello", hashtags: [], link: "https://x", videoId: "vid", videoUrl: "https://y", ...over,
} as SocialPost);
const batch = (id: string, status: QueuedBatch["status"], createdAt: string, posts: SocialPost[] = [post()]): QueuedBatch => ({
  id, status, createdAt, posts, videoId: "vid", title: "t", track: "B", lang: "en", generatedAt: createdAt, transcriptChars: 0,
} as QueuedBatch);

describe("sink switch (dev mirror only)", () => {
  it("is off unless SOCIAL_POSTER_SINK=1", () => {
    assert.equal(sinkEnabled({ PUBLIC_URL: "http://178.156.154.144" }), false);
    assert.equal(sinkEnabled({ SOCIAL_POSTER_SINK: "0", PUBLIC_URL: "http://178.156.154.144" }), false);
  });
  it("is on for the dev box address", () => {
    assert.equal(sinkEnabled({ SOCIAL_POSTER_SINK: "1", PUBLIC_URL: "http://178.156.154.144" }), true);
  });
  it("refuses the production site, with or without www or a path, and an unknown address", () => {
    for (const url of ["https://stillafloatcruising.com", "https://www.stillafloatcruising.com/", "http://stillafloatcruising.com:443", "", undefined]) {
      assert.equal(sinkEnabled({ SOCIAL_POSTER_SINK: "1", PUBLIC_URL: url }), false, String(url));
    }
  });
});

describe("what the sink records", () => {
  it("keeps where and when, and the size of the caption — never the caption itself", () => {
    const e = sinkEntry(post({ caption: "twelve chars", scheduledFor: "2026-10-10T11:00:00Z" }), NOW);
    assert.deepEqual(e, { at: "2026-10-10T12:00:00.000Z", platform: "facebook", surface: "Still Afloat Page", lang: "en", videoId: "vid", scheduledFor: "2026-10-10T11:00:00Z", captionChars: 12 });
    assert.equal(JSON.stringify(e).includes("twelve"), false);
  });
});

describe("dev feeder: which pending batch gets approved", () => {
  const waiting = (n: number) => Array.from({ length: n }, (_, i) => post({ scheduledFor: new Date(NOW + (i + 1) * HOUR).toISOString(), postState: "scheduled" }));
  it("approves the OLDEST pending batch when fewer than 3 posts wait for a future slot", () => {
    const batches = [batch("new", "pending", "2026-10-09T10:00:00Z"), batch("old", "pending", "2026-09-09T10:00:00Z"), batch("done", "posted", "2026-08-01T00:00:00Z", waiting(2))];
    assert.equal(pickBatchToFeed(batches, NOW)?.id, "old");
  });
  it("does nothing while 3 or more posts already wait", () => {
    const batches = [batch("sched", "scheduled", "2026-10-01T00:00:00Z", waiting(3)), batch("old", "pending", "2026-09-09T10:00:00Z")];
    assert.equal(pickBatchToFeed(batches, NOW), null);
  });
  it("does not count posts already posted, skipped or whose slot has passed", () => {
    const past = post({ scheduledFor: new Date(NOW - HOUR).toISOString(), postState: "scheduled" });
    const done = post({ scheduledFor: new Date(NOW + HOUR).toISOString(), postState: "posted", postedAt: new Date(NOW).toISOString() });
    const skipped = post({ scheduledFor: new Date(NOW + HOUR).toISOString(), postState: "skipped" });
    const batches = [batch("s", "scheduled", "2026-10-01T00:00:00Z", [past, done, skipped]), batch("p", "pending", "2026-09-09T10:00:00Z")];
    assert.equal(pickBatchToFeed(batches, NOW)?.id, "p");
  });
  it("returns null when nothing is pending, and never touches rejected or approved batches", () => {
    assert.equal(pickBatchToFeed([batch("r", "rejected", "2026-09-09T10:00:00Z"), batch("a", "approved", "2026-09-09T10:00:00Z")], NOW), null);
  });
});
