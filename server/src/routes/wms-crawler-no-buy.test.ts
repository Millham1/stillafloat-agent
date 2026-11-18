// wms-crawler-no-buy.test.ts — a search-engine crawler must never trigger a paid Live-AIS position.
// In the two weeks to 2026-11-18, 100 of the 175 positions prod bought for "request" were bought for
// crawlers rendering ship pages (Baidu 82, Apple 10, Google 6, ByteDance 2).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isBotUA } from "../lib/affiliate-clicks";

const src = fs.readFileSync(path.join(process.cwd(), "src/routes/wms.ts"), "utf8");

test("the crawlers that were spending credits are recognised", () => {
  for (const ua of [
    "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
    "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
  ]) assert.equal(isBotUA(ua), true, ua);
});

test("a person's browser still buys", () => {
  assert.equal(isBotUA("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"), false);
  assert.equal(isBotUA(undefined), false);
});

test("every paid request lookup in the tracker routes sits behind the crawler check", () => {
  const buys = [...src.matchAll(/refreshStalePosition\([^)]*"request"\)/g)];
  assert.equal(buys.length, 2, "expected the two public buy sites: POST /wms/request and GET /wms/position");
  for (const b of buys) {
    const before = src.slice(Math.max(0, b.index! - 160), b.index!);
    assert.match(before, /crawlerAsking\(req, \w+\)/, "a paid lookup is not guarded: " + b[0]);
  }
});
