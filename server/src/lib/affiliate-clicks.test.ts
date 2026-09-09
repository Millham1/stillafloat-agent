// affiliate-clicks.test.ts — the pure surface of first-party click tracking:
// tag guarantee (the commission depends on it), bot detection, privacy hashing
// (never the raw UA/IP), and the report aggregation the dashboard reads. The
// two Supabase-backed functions (logAffiliateClick, fetchClickReport) are thin
// I/O wrappers and are not tested here, same split as lib/persistence.ts.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ensureAffiliateTag, isBotUA, hashUA, hashIp, aggregateClicks } from "./affiliate-clicks";

// ── ensureAffiliateTag: the commission depends on this ──────────────────────

test("ensureAffiliateTag leaves an already-correctly-tagged URL byte-for-byte alone", () => {
  const url = "https://www.amazon.com/dp/B000TEST?tag=stillafloatcr-20";
  assert.equal(ensureAffiliateTag(url), url);
});

test("ensureAffiliateTag appends the tag when the URL has none", () => {
  assert.equal(
    ensureAffiliateTag("https://www.amazon.com/dp/B000TEST"),
    "https://www.amazon.com/dp/B000TEST?tag=stillafloatcr-20",
  );
});

test("ensureAffiliateTag appends the tag alongside other existing query params", () => {
  const out = ensureAffiliateTag("https://www.amazon.com/dp/B000TEST?psc=1");
  const u = new URL(out);
  assert.equal(u.searchParams.get("psc"), "1");
  assert.equal(u.searchParams.get("tag"), "stillafloatcr-20");
});

test("ensureAffiliateTag replaces a wrong tag rather than crediting someone else's commission", () => {
  const out = ensureAffiliateTag("https://www.amazon.com/dp/B000TEST?tag=someoneelse-20");
  assert.equal(new URL(out).searchParams.get("tag"), "stillafloatcr-20");
});

test("ensureAffiliateTag no-ops on an empty string", () => {
  assert.equal(ensureAffiliateTag(""), "");
});

// ── isBotUA ───────────────────────────────────────────────────────────────

test("isBotUA matches known crawler/preview UAs", () => {
  assert.equal(isBotUA("facebookexternalhit/1.1"), true);
  assert.equal(isBotUA("Googlebot/2.1 (+http://www.google.com/bot.html)"), true);
  assert.equal(isBotUA("Mozilla/5.0 (compatible; Bingbot/2.0)"), true);
  assert.equal(isBotUA("Slackbot-LinkExpanding 1.0"), true);
});

test("isBotUA does not flag a real browser", () => {
  assert.equal(
    isBotUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"),
    false,
  );
});

test("isBotUA treats a missing UA as not-a-bot (still gets logged, still rate-limited)", () => {
  assert.equal(isBotUA(undefined), false);
  assert.equal(isBotUA(""), false);
});

// ── Privacy hashing: never the raw value ─────────────────────────────────────

test("hashUA never stores the raw user-agent string", () => {
  const ua = "Mozilla/5.0 VeryIdentifiableClientString";
  const h = hashUA(ua);
  assert.equal(h.length, 64); // sha256 hex digest
  assert.doesNotMatch(h, /VeryIdentifiable/);
});

test("hashIp is stable for the same ip within a calendar day but never contains the raw ip", () => {
  const day = new Date("2026-09-09T12:00:00Z");
  const a = hashIp("203.0.113.7", day);
  const b = hashIp("203.0.113.7", day);
  assert.equal(a, b);
  assert.doesNotMatch(a, /203\.0\.113\.7/);
});

test("hashIp differs between two different ips on the same day", () => {
  const day = new Date("2026-09-09T12:00:00Z");
  assert.notEqual(hashIp("203.0.113.7", day), hashIp("198.51.100.9", day));
});

test("hashIp rotates across calendar days (the daily salt) so days can't be correlated", () => {
  const day1 = new Date("2026-09-09T23:59:00Z");
  const day2 = new Date("2026-09-10T00:01:00Z");
  assert.notEqual(hashIp("203.0.113.7", day1), hashIp("203.0.113.7", day2));
});

// ── aggregateClicks: pure report aggregation ─────────────────────────────────

test("aggregateClicks totals and buckets by item, page, and day", () => {
  const rows = [
    { item_id: "a", category: "cabin-essentials", page: "cabin-essentials", clicked_at: "2026-09-01T10:00:00Z" },
    { item_id: "a", category: "cabin-essentials", page: "newsletter", clicked_at: "2026-09-01T11:00:00Z" },
    { item_id: "b", category: "cruise-fun", page: "cruise-fun", clicked_at: "2026-09-02T09:00:00Z" },
  ];
  const report = aggregateClicks(rows);
  assert.equal(report.total, 3);
  assert.deepEqual(report.byItem, [
    { item_id: "a", count: 2 },
    { item_id: "b", count: 1 },
  ]);
  assert.ok(report.byPage.some((p) => p.page === "newsletter" && p.count === 1));
  assert.ok(report.byPage.some((p) => p.page === "cabin-essentials" && p.count === 1));
  assert.deepEqual(report.byDay, [
    { day: "2026-09-01", count: 2 },
    { day: "2026-09-02", count: 1 },
  ]);
});

test("aggregateClicks buckets a missing page under 'unknown' rather than dropping the row", () => {
  const report = aggregateClicks([
    { item_id: "a", category: null, page: null, clicked_at: "2026-09-01T10:00:00Z" },
  ]);
  assert.equal(report.total, 1);
  assert.deepEqual(report.byPage, [{ page: "unknown", count: 1 }]);
});

test("aggregateClicks on an empty set returns zeroed, not-crashed totals", () => {
  const report = aggregateClicks([]);
  assert.deepEqual(report, { total: 0, byItem: [], byPage: [], byDay: [] });
});
