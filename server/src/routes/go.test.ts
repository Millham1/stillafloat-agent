// go.test.ts — the /api/go/:itemId redirect. getItemMap/logClick are
// dependency-injected (see GoRouterDeps in ./go), so these tests never touch
// Supabase — same pattern as lib/push-health.test.ts's injected `count`.
//
// A real Express app + http server is used (not manual req/res mocks) so the
// actual route matching, status code, and Location header are exercised end
// to end, exactly what a shopper's browser sees.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createGoRouter, type GoRouterDeps } from "./go";
import type { AffiliateItem } from "./affiliate";

function makeItem(overrides: Partial<AffiliateItem> = {}): AffiliateItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Test Item",
    description: "",
    category: "cabin-essentials",
    smartStrip: "",
    affiliateLink: "https://www.amazon.com/dp/B000TEST?tag=stillafloatcr-20",
    imageUrl: "",
    featured: false,
    createdAt: new Date().toISOString(),
    sortOrder: 0,
    ...overrides,
  };
}

async function startServer(deps: GoRouterDeps): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use("/api", createGoRouter(deps));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      resolve({ status: res.statusCode || 0, location: res.headers.location });
      res.resume();
    });
    req.on("error", reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("a known item id redirects 302 straight to its tagged Amazon URL", async () => {
  const it = makeItem();
  const { server, base } = await startServer({
    getItemMap: async () => new Map([[it.id, it]]),
    logClick: async () => {},
  });
  try {
    const { status, location } = await get(`${base}/api/go/${it.id}`);
    assert.equal(status, 302);
    assert.equal(location, it.affiliateLink);
  } finally {
    await close(server);
  }
});

test("an unknown item id is refused with 404, not a redirect", async () => {
  const { server, base } = await startServer({
    getItemMap: async () => new Map(),
    logClick: async () => {},
  });
  try {
    const { status, location } = await get(`${base}/api/go/does-not-exist`);
    assert.equal(status, 404);
    assert.equal(location, undefined);
  } finally {
    await close(server);
  }
});

test("the affiliate tag is appended when the stored URL is missing it", async () => {
  const it = makeItem({ affiliateLink: "https://www.amazon.com/dp/B000TEST" });
  const { server, base } = await startServer({
    getItemMap: async () => new Map([[it.id, it]]),
    logClick: async () => {},
  });
  try {
    const { location } = await get(`${base}/api/go/${it.id}`);
    assert.equal(location, "https://www.amazon.com/dp/B000TEST?tag=stillafloatcr-20");
  } finally {
    await close(server);
  }
});

test("a bot UA still gets redirected but is never logged", async () => {
  const it = makeItem();
  let called = false;
  const { server, base } = await startServer({
    getItemMap: async () => new Map([[it.id, it]]),
    logClick: async () => {
      called = true;
    },
  });
  try {
    const { status } = await get(`${base}/api/go/${it.id}`, { "User-Agent": "facebookexternalhit/1.1" });
    assert.equal(status, 302);
    // logClick is fire-and-forget; give any errant call a tick to land.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, false);
  } finally {
    await close(server);
  }
});

test("a logging failure never affects the redirect", async () => {
  const it = makeItem();
  const { server, base } = await startServer({
    getItemMap: async () => new Map([[it.id, it]]),
    logClick: async () => {
      throw new Error("supabase down");
    },
  });
  try {
    const { status, location } = await get(`${base}/api/go/${it.id}`);
    assert.equal(status, 302);
    assert.equal(location, it.affiliateLink);
    // Let the rejected promise's .catch() run so it doesn't surface as an
    // unhandled rejection after the test ends.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    await close(server);
  }
});

test("an item lookup failure is a 404, not a crash", async () => {
  const { server, base } = await startServer({
    getItemMap: async () => {
      throw new Error("supabase down");
    },
    logClick: async () => {},
  });
  try {
    const { status } = await get(`${base}/api/go/anything`);
    assert.equal(status, 404);
  } finally {
    await close(server);
  }
});

test("an item with no usable link (widget-only, no affiliateLink) 404s rather than redirecting nowhere", async () => {
  const it = makeItem({ smartStrip: "<script>ad widget</script>", affiliateLink: "" });
  const { server, base } = await startServer({
    getItemMap: async () => new Map([[it.id, it]]),
    logClick: async () => {},
  });
  try {
    const { status } = await get(`${base}/api/go/${it.id}`);
    assert.equal(status, 404);
  } finally {
    await close(server);
  }
});
