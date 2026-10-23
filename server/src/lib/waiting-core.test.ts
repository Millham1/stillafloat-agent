// waiting-core.test.ts — one notification, a count for a title, pushed only when something
// NEW is waiting (Mark, 2026-10-22). Pure module: no stores, no network.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { summarizeWaiting, describe, pushWaitingWith, isUndecidedStory, WAITING_TAG, type WaitingItem, type WaitingState } from "./waiting-core";

const item = (key: string, group: WaitingItem["group"], label = key): WaitingItem => ({ key, group, label });
const OCT22: WaitingItem[] = [
  item("news:a", "news", "Carnival Spirit skips Puerto Vallarta"),
  item("news:b", "news", "Oasis of the Seas returns late"),
  item("inbox:t1", "inbox", "[Go Port] Re: Quote for group"),
  item("action:s1", "decisions", "Storm Nolo: approve the alert"),
];

test("title is the count; the body names each group in plain English", () => {
  const s = summarizeWaiting(OCT22, { morning: true, events: 2 });
  assert.equal(s.title, "Waiting on you: 4");
  assert.equal(s.body, "Storm Nolo: approve the alert · 2 news stories to approve · 1 email needs your reply\n2 on the calendar today");
});

test("singular and plural read correctly", () => {
  assert.equal(describe([item("news:a", "news")]), "1 news story to approve");
  assert.equal(describe([item("inbox:1", "inbox"), item("inbox:2", "inbox")]), "2 emails need your reply");
  assert.equal(describe([item("c:1", "commentary")]), "this week's commentary to approve");
  assert.equal(describe([item("n:1", "newsletter")]), "a newsletter draft to approve");
  assert.equal(describe([item("p:1", "proposals")]), "1 agent proposal to decide");
});

test("more than two decisions are counted, not named", () => {
  const many = ["a", "b", "c"].map((k) => item(`action:${k}`, "decisions", `Decision ${k}`));
  assert.equal(describe(many), "3 decisions in your queue");
});

test("an empty list says so, and still carries the calendar on the morning push", () => {
  assert.deepEqual(summarizeWaiting([], { morning: true, events: 1 }), { title: "Nothing waiting on you", body: "Inbox, queue and drafts are clear. · 1 on the calendar today" });
  assert.deepEqual(summarizeWaiting([], {}), { title: "Nothing waiting on you", body: "Inbox, queue and drafts are clear." });
});

test("an update names what is new first, then the rest", () => {
  const s = summarizeWaiting(OCT22, { newKeys: new Set(["news:a", "news:b"]) });
  assert.equal(s.title, "Waiting on you: 4");
  assert.equal(s.body, "New: 2 news stories to approve\nAlso waiting: Storm Nolo: approve the alert · 1 email needs your reply");
});

function harness(last: WaitingState, sent = 1) {
  const saved: WaitingState[] = []; const pushed: Array<{ title: string; body: string; url: string; tag: string }> = [];
  return {
    saved, pushed,
    deps: {
      load: async () => last,
      save: async (s: WaitingState) => { saved.push(s); },
      push: async (p: { title: string; body: string; url: string; tag: string }) => { pushed.push(p); return { sent, pruned: 0 }; },
      url: () => "https://dashboard.example/brief.html",
      now: () => new Date("2026-10-22T12:04:24Z"),
    },
  };
}

test("a push goes out when a new item joined the list, with the one tag and the brief as target", async () => {
  const h = harness({ keys: ["inbox:t1", "action:s1"], at: "2026-10-22T11:04:00Z", total: 2 });
  const r = await pushWaitingWith(h.deps, { items: OCT22, reason: "news scan" });
  assert.equal(r.pushed, true);
  assert.equal(r.added, 2);
  assert.equal(h.pushed[0]!.tag, WAITING_TAG);
  assert.equal(h.pushed[0]!.url, "https://dashboard.example/brief.html");
  assert.equal(h.pushed[0]!.title, "Waiting on you: 4");
  assert.match(h.pushed[0]!.body, /^New: 2 news stories to approve/);
  assert.deepEqual(h.saved[0]!.keys, OCT22.map((i) => i.key));
  assert.equal(h.saved[0]!.at, "2026-10-22T12:04:24.000Z");
});

test("nothing new → no push, but the current set is recorded so a returning item counts as new later", async () => {
  const h = harness({ keys: [...OCT22.map((i) => i.key), "news:gone"], at: "2026-10-22T11:04:00Z", total: 5 });
  const r = await pushWaitingWith(h.deps, { items: OCT22, reason: "brief-update" });
  assert.equal(r.pushed, false);
  assert.equal(h.pushed.length, 0);
  assert.deepEqual(h.saved[0]!.keys, OCT22.map((i) => i.key), "news:gone left the set");
  assert.equal(h.saved[0]!.at, "2026-10-22T11:04:00Z", "a quiet run keeps the last real push time");
});

test("a removal alone never buzzes", async () => {
  const h = harness({ keys: OCT22.map((i) => i.key), at: "x", total: 4 });
  const r = await pushWaitingWith(h.deps, { items: OCT22.slice(1), reason: "approved one" });
  assert.equal(r.pushed, false);
});

test("the morning brief always pushes, even with nothing new, and uses the morning wording", async () => {
  const h = harness({ keys: OCT22.map((i) => i.key), at: "x", total: 4 });
  const r = await pushWaitingWith(h.deps, { items: OCT22, events: 3, force: true, reason: "morning-brief" });
  assert.equal(r.pushed, true);
  assert.equal(r.added, 0);
  assert.doesNotMatch(h.pushed[0]!.body, /^New:/);
  assert.match(h.pushed[0]!.body, /3 on the calendar today$/);
});

test("a state that cannot be read is treated as empty, so the first ever run pushes", async () => {
  const h = harness({ keys: [], at: "", total: 0 });
  h.deps.load = async () => { throw new Error("no store"); };
  const r = await pushWaitingWith(h.deps, { items: OCT22, reason: "first" });
  assert.equal(r.pushed, true);
  assert.equal(r.added, 4);
});

// 2026-10-23: 14 "candidate" stories counted as 0 news stories to approve on prod.
test("a news story waits for Mark while it is a candidate or has no status; a decision removes it", () => {
  for (const status of ["candidate", "", undefined, null, "pending", "Candidate"]) assert.equal(isUndecidedStory({ status }), true, `status ${JSON.stringify(status)} should still be waiting`);
  for (const status of ["approved", "featured", "rejected", "held", "published"]) assert.equal(isUndecidedStory({ status }), false, `status ${status} was decided`);
});

