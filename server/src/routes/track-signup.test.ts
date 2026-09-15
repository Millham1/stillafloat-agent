// track-signup.test.ts — the storm pages' one-step "Track this ship": POST /api/wms/track-signup
// starts a 15-day watch (subscribing first when needed), and POST /api/wms/watch/restart runs
// one again when the "keep tracking?" email's button is pressed. Dependencies are injected
// (see TrackSignupDeps), so a real Express app runs the routes end to end against in-memory
// subscribers, ships and watches.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTrackSignupRouter, type TrackSignupDeps, type SubscriberRow } from "./track-signup";
import { activatePendingWatches } from "../lib/pending-watches";
import { makeWatchSig } from "../lib/ship-watch";

interface Watch {
  id: string; subscriber_id: string; ship_name: string; sailing_start: string; sailing_end: string;
  window_days: number | null; status: string; source: string;
}

const TODAY = "2026-09-15";
const W1 = "0b6f7a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const W2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

function world(opts: { subscribers?: (SubscriberRow & { email: string })[]; watches?: Watch[]; limited?: boolean } = {}) {
  const subscribers = new Map((opts.subscribers ?? []).map((s) => [s.email, { ...s }]));
  const watches: Watch[] = (opts.watches ?? []).map((w) => ({ ...w }));
  const sent = {
    verification: [] as { email: string; token: string; lang: string; shipName: string; name: string }[],
    tracking: [] as { to: string; subject: string; html: string }[],
  };
  const SHIPS = ["Carnival Panorama", "Navigator of the Seas"];
  let n = 0;
  const deps: TrackSignupDeps = {
    findSubscriber: async (email) => subscribers.get(email) ?? null,
    createSubscriber: async ({ email, name, lang, token }) => {
      const id = `sub-${++n}`;
      subscribers.set(email, { id, email, name, lang, token, status: "pending" });
      return { id };
    },
    reopenSubscriber: async (id, patch) => {
      for (const s of subscribers.values()) if (s.id === id) Object.assign(s, patch, { status: "pending" });
    },
    findShip: async (name) => {
      const hit = SHIPS.find((s) => s.toLowerCase() === name.toLowerCase());
      return hit ? { name: hit } : null;
    },
    findOpenWatch: async (subscriberId, shipName, today) => {
      const w = watches
        .filter((x) => x.subscriber_id === subscriberId && x.ship_name === shipName && ["pending", "active"].includes(x.status)
          && x.sailing_start <= today && x.sailing_end >= today)
        .sort((a, b) => a.status.localeCompare(b.status))[0];
      return w ? { id: w.id, status: w.status, sailing_end: w.sailing_end } : null;
    },
    findWatch: async (id) => {
      const w = watches.find((x) => x.id === id);
      if (!w) return null;
      const sub = [...subscribers.values()].find((s) => s.id === w.subscriber_id);
      return { id: w.id, subscriber_id: w.subscriber_id, ship_name: w.ship_name, window_days: w.window_days, subscriber_status: sub?.status ?? null };
    },
    createWatch: async (row) => { const id = `w-${++n}`; watches.push({ id, ...row }); return { id }; },
    activateWatch: async (id, window) => {
      const w = watches.find((x) => x.id === id);
      if (w) Object.assign(w, { status: "active", sailing_start: window.start, sailing_end: window.end });
    },
    sendVerification: async (args) => { sent.verification.push(args); },
    sendTracking: async ({ to, subject, html }) => { sent.tracking.push({ to, subject, html }); },
    today: () => TODAY,
    newToken: () => `token-${++n}`,
    rateLimited: () => Boolean(opts.limited),
  };
  return { deps, subscribers, watches, sent };
}

async function post(deps: TrackSignupDeps, path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use("/api", createTrackSignupRouter(deps));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const signup = (deps: TrackSignupDeps, body: Record<string, unknown>) => post(deps, "/wms/track-signup", body);
const restart = (deps: TrackSignupDeps, body: Record<string, unknown>) => post(deps, "/wms/watch/restart", body);

const form = (over: Record<string, unknown> = {}) => ({
  name: "Pat Cruiser", email: "Pat@Example.com ", ship: "carnival panorama", lang: "en", source: "storm", ...over,
});

const confirmedPat = { id: "s1", email: "pat@example.com", name: "Pat Cruiser", lang: "en", status: "confirmed", token: null };

test("a new visitor becomes a pending subscriber with a pending 15-day watch and one confirmation email naming the ship", async () => {
  const w = world();
  const { status, json } = await signup(w.deps, form());
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, state: "confirm_email", ship: "Carnival Panorama" });
  const sub = w.subscribers.get("pat@example.com")!;
  assert.deepEqual([sub.status, sub.name, sub.lang], ["pending", "Pat Cruiser", "en"]);
  assert.deepEqual(w.watches.map((x) => [x.ship_name, x.status, x.source, x.sailing_start, x.sailing_end, x.window_days]),
    [["Carnival Panorama", "pending", "storm", "2026-09-15", "2026-09-29", 15]]);
  assert.deepEqual(w.sent.verification.map((v) => [v.email, v.shipName, v.lang, v.name, v.token === sub.token]),
    [["pat@example.com", "Carnival Panorama", "en", "Pat Cruiser", true]]);
  assert.equal(w.sent.tracking.length, 0, "nothing is tracked until they confirm");
});

test("dates sent with a sign-up are ignored: every storm-page watch is today plus 14 days", async () => {
  const w = world();
  await signup(w.deps, form({ sailingStart: "2026-12-01", sailingEnd: "2026-12-08" }));
  assert.deepEqual(w.watches.map((x) => [x.sailing_start, x.sailing_end, x.window_days]), [["2026-09-15", "2026-09-29", 15]]);
});

test("a confirmed subscriber is tracking at once for 15 days, and a second click does not start a second watch", async () => {
  const w = world({ subscribers: [{ ...confirmedPat, lang: "es" }] });
  const first = await signup(w.deps, form());
  assert.deepEqual(first.json, { ok: true, state: "tracking", ship: "Carnival Panorama", until: "2026-09-29" });
  assert.deepEqual(w.watches.map((x) => [x.status, x.sailing_start, x.sailing_end, x.window_days, x.source]),
    [["active", "2026-09-15", "2026-09-29", 15, "storm"]]);
  assert.deepEqual(w.sent.tracking.map((t) => [t.to, t.subject]), [["pat@example.com", "Estás siguiendo a Carnival Panorama — Still Afloat"]],
    "in the subscriber's own language");
  const html = w.sent.tracking[0]!.html;
  assert.ok(html.includes("durante los próximos 15 días, hasta el 29 de septiembre"));
  assert.ok(html.includes(`/api/wms/watch/stop?id=${w.watches[0]!.id}&sig=${makeWatchSig(w.watches[0]!.id)}`), "the stop link names this watch");
  assert.equal(w.sent.verification.length, 0);

  const again = await signup(w.deps, form());
  assert.deepEqual(again.json, { ok: true, state: "tracking", ship: "Carnival Panorama", until: "2026-09-29", already: true });
  assert.equal(w.watches.length, 1);
  assert.equal(w.sent.tracking.length, 1, "no second email");
});

test("a watch that does not cover today does not count: a December sailing watch still lets a storm watch start now", async () => {
  const december: Watch = {
    id: W1, subscriber_id: "s1", ship_name: "Carnival Panorama", sailing_start: "2026-12-01", sailing_end: "2026-12-08",
    window_days: null, status: "active", source: "tracker",
  };
  const w = world({ subscribers: [confirmedPat], watches: [december] });
  const { json } = await signup(w.deps, form());
  assert.deepEqual(json, { ok: true, state: "tracking", ship: "Carnival Panorama", until: "2026-09-29" });
  assert.deepEqual(w.watches.map((x) => [x.sailing_start, x.sailing_end, x.window_days]),
    [["2026-12-01", "2026-12-08", null], ["2026-09-15", "2026-09-29", 15]]);
});

test("someone still unconfirmed gets the same token again; someone who unsubscribed is reopened with a new one", async () => {
  const w = world({ subscribers: [
    { id: "p1", email: "pending@example.com", name: "Pending Pat", lang: "en", status: "pending", token: "old-token" },
    { id: "u1", email: "gone@example.com", name: "Gone Gus", lang: "en", status: "unsubscribed", token: null },
  ] });
  await signup(w.deps, form({ email: "pending@example.com" }));
  await signup(w.deps, form({ email: "pending@example.com" }));
  assert.deepEqual(w.sent.verification.map((v) => v.token), ["old-token", "old-token"]);
  assert.equal(w.watches.filter((x) => x.subscriber_id === "p1").length, 1, "no duplicate pending watch");

  await signup(w.deps, form({ email: "gone@example.com", name: "Gus Returns" }));
  const gus = w.subscribers.get("gone@example.com")!;
  assert.equal(gus.status, "pending");
  assert.match(String(gus.token), /^token-/);
  assert.equal(w.sent.verification.at(-1)!.token, gus.token);
});

test("a bounced address, bad input, an unknown ship and a flood are refused; the honeypot is silently accepted", async () => {
  const bounced = world({ subscribers: [{ id: "b1", email: "bad@example.com", name: "B", lang: "en", status: "bounced", token: null }] });
  assert.deepEqual(await signup(bounced.deps, form({ email: "bad@example.com" })), { status: 409, json: { ok: false, error: "email_unreachable" } });

  const w = world();
  assert.deepEqual(await signup(w.deps, form({ name: "P" })), { status: 400, json: { ok: false, error: "name_required" } });
  assert.deepEqual(await signup(w.deps, form({ email: "not-an-email" })), { status: 400, json: { ok: false, error: "email_invalid" } });
  assert.deepEqual(await signup(w.deps, form({ ship: " " })), { status: 400, json: { ok: false, error: "ship_required" } });
  assert.deepEqual(await signup(w.deps, form({ ship: "Ghost Ship" })), { status: 404, json: { ok: false, error: "unknown_ship" } });
  assert.deepEqual(await signup(world({ limited: true }).deps, form()), { status: 429, json: { ok: false, error: "too_many_attempts" } });
  assert.equal(w.subscribers.size, 0);
  assert.equal(w.watches.length, 0);

  const bot = world();
  assert.deepEqual((await signup(bot.deps, form({ website: "http://spam" }))).json, { ok: true, state: "confirm_email" });
  assert.equal(bot.subscribers.size, 0);
  assert.equal(bot.watches.length, 0);
});

test("the keep-tracking button starts an ended 15-day watch again from today, for another 15 days, without another email", async () => {
  const ended: Watch = {
    id: W1, subscriber_id: "s1", ship_name: "Carnival Panorama", sailing_start: "2026-08-28", sailing_end: "2026-09-11",
    window_days: 15, status: "ended", source: "storm",
  };
  const w = world({ subscribers: [confirmedPat], watches: [ended] });
  const { status, json } = await restart(w.deps, { id: W1, sig: makeWatchSig(W1, "restart") });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, state: "restarted", ship: "Carnival Panorama", until: "2026-09-29" });
  assert.deepEqual(w.watches.map((x) => [x.id, x.status, x.sailing_start, x.sailing_end, x.window_days]),
    [[W1, "active", "2026-09-15", "2026-09-29", 15]]);
  assert.equal(w.sent.tracking.length + w.sent.verification.length, 0);

  const stopped = world({ subscribers: [confirmedPat], watches: [{ ...ended, status: "stopped" }] });
  assert.equal((await restart(stopped.deps, { id: W1, sig: makeWatchSig(W1, "restart") })).json["state"], "restarted",
    "a watch stopped from an email can be started again by its own subscriber");
});

test("a stop link's signature, a made-up id or a sailing watch cannot restart anything", async () => {
  const sailingWatch: Watch = {
    id: W2, subscriber_id: "s1", ship_name: "Navigator of the Seas", sailing_start: "2026-09-01", sailing_end: "2026-09-08",
    window_days: null, status: "ended", source: "tracker",
  };
  const ended: Watch = { ...sailingWatch, id: W1, ship_name: "Carnival Panorama", window_days: 15, source: "storm" };
  const w = world({ subscribers: [confirmedPat], watches: [ended, sailingWatch] });
  const invalid = { ok: false, error: "invalid_link" };
  assert.deepEqual(await restart(w.deps, { id: W1, sig: makeWatchSig(W1) }), { status: 400, json: invalid }, "the stop signature");
  assert.deepEqual(await restart(w.deps, { id: W1 }), { status: 400, json: invalid });
  assert.deepEqual(await restart(w.deps, { id: "w-1", sig: makeWatchSig("w-1", "restart") }), { status: 400, json: invalid }, "not a watch id");
  assert.deepEqual(await restart(w.deps, { id: W2, sig: makeWatchSig(W2, "restart") }), { status: 404, json: invalid }, "a sailing watch");
  const unknown = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(await restart(w.deps, { id: unknown, sig: makeWatchSig(unknown, "restart") }), { status: 404, json: invalid });
  assert.deepEqual(await restart(world({ limited: true }).deps, { id: W1, sig: makeWatchSig(W1, "restart") }),
    { status: 429, json: { ok: false, error: "too_many_attempts" } });
  assert.deepEqual(w.watches.map((x) => x.status), ["ended", "ended"], "nothing moved");
});

test("a restart for someone no longer subscribed sends them to sign up again, and never starts a second watch on the same ship", async () => {
  const ended: Watch = {
    id: W1, subscriber_id: "s1", ship_name: "Carnival Panorama", sailing_start: "2026-08-28", sailing_end: "2026-09-11",
    window_days: 15, status: "ended", source: "storm",
  };
  const gone = world({ subscribers: [{ ...confirmedPat, status: "unsubscribed" }], watches: [ended] });
  assert.deepEqual(await restart(gone.deps, { id: W1, sig: makeWatchSig(W1, "restart") }),
    { status: 409, json: { ok: false, error: "subscription_inactive", ship: "Carnival Panorama" } });
  assert.equal(gone.watches[0]!.status, "ended");

  const signedUpAgain: Watch = { ...ended, id: W2, sailing_start: "2026-09-13", sailing_end: "2026-09-27", status: "active" };
  const w = world({ subscribers: [confirmedPat], watches: [ended, signedUpAgain] });
  assert.deepEqual((await restart(w.deps, { id: W1, sig: makeWatchSig(W1, "restart") })).json,
    { ok: true, state: "tracking", ship: "Carnival Panorama", until: "2026-09-27", already: true });
  assert.deepEqual(w.watches.map((x) => x.status), ["ended", "active"]);
});

test("confirming the email starts each pending watch: a 15-day one counts from that day, one past its days is closed", async () => {
  const pending = [
    { id: "w1", ship_name: "Carnival Panorama", sailing_start: "2026-09-10", sailing_end: "2026-09-24", window_days: 15 },
    { id: "w2", ship_name: "Navigator of the Seas", sailing_start: "2026-09-15", sailing_end: "2026-09-20", window_days: null },
    { id: "w3", ship_name: "Carnival Radiance", sailing_start: "2026-08-20", sailing_end: "2026-09-03", window_days: 15 },
  ];
  const activated: [string, unknown][] = [];
  const ended: string[] = [];
  const mails: { subject: string; html: string }[] = [];
  const started = await activatePendingWatches(
    { id: "s1", email: "pat@example.com", name: "Pat Cruiser", lang: "en" },
    {
      listPending: async () => pending,
      activate: async (id, window) => { activated.push([id, window]); },
      end: async (id) => { ended.push(id); },
      sendTracking: async ({ subject, html }) => { mails.push({ subject, html }); },
      today: () => TODAY,
    },
  );
  assert.deepEqual(started, [{ ship: "Carnival Panorama", until: "2026-09-29" }, { ship: "Navigator of the Seas", until: "2026-09-20" }]);
  assert.deepEqual(activated, [["w1", { start: "2026-09-15", end: "2026-09-29" }], ["w2", null]]);
  assert.deepEqual(ended, ["w3"], "signed up in August and confirmed after its 15 days: the storm has moved on");
  assert.deepEqual(mails.map((m) => m.subject), ["You're tracking Carnival Panorama — Still Afloat", "You're tracking Navigator of the Seas — Still Afloat"]);
  assert.ok(mails[0]!.html.includes("for the next 15 days, through September 29"));
  assert.ok(mails[1]!.html.includes("from 2026-09-15 to 2026-09-20") && !mails[1]!.html.includes("15 days"), "a sailing watch keeps its dates");
});
