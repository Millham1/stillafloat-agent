// newsletter-delivery.test.ts — the 2026-09-18 failure, replayed: 11 emails in 18 seconds, the
// relay refused one, the log said 11/11. A send must go out slowly, report who REALLY got it,
// retry relay-refused mail once, never retry a dead address, and survive a restart mid-send.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  newDelivery,
  runDeliveryRound,
  deliveryIsDue,
  deliveryCounts,
  deliveryNotice,
  type Bounce,
  type DeliveryDeps,
  type NewsletterDelivery,
} from "./newsletter-delivery";

const T0 = Date.parse("2026-09-18T13:02:00Z");
const PACE = 45_000;
const SETTLE = 120_000;
const RETRY = 3_600_000;

const people = (n: number): Array<{ email: string; name: string }> =>
  Array.from({ length: n }, (_, i) => ({ email: `reader${i + 1}@example.com`, name: `Reader ${i + 1}` }));

interface Rig {
  deps: DeliveryDeps;
  sentTo: string[];
  sleeps: number[];
  saves: number;
  clock: { ms: number };
  bounceQueries: number[];
}

function rig(opts: { bounces?: (since: number) => Bounce[] | null; refuse?: string[] } = {}): Rig {
  const r: Rig = { sentTo: [], sleeps: [], saves: 0, clock: { ms: T0 }, bounceQueries: [], deps: undefined as unknown as DeliveryDeps };
  r.deps = {
    send: async (p) => { r.sentTo.push(p.email); return !(opts.refuse ?? []).includes(p.email); },
    bounces: async (since) => { r.bounceQueries.push(since); return opts.bounces ? opts.bounces(since) : []; },
    save: async () => { r.saves += 1; },
    sleep: async (ms) => { r.sleeps.push(ms); r.clock.ms += ms; },
    now: () => r.clock.ms,
    paceMs: PACE,
    settleMs: SETTLE,
    retryDelayMs: RETRY,
  };
  return r;
}

const relayRefusal = (email: string, atMs: number): Bounce => ({
  recipient: email, status: "5.4.6", relay_refused: true, at: Math.floor(atMs / 1000),
  diagnostic: "550 5.4.6 Unusual sending activity detected. Please try after sometime.",
});

describe("newsletter delivery ledger", () => {
  it("paces one email per 45s — between sends, never after the last — then settles before the bounce check", async () => {
    const d = newDelivery(people(3), T0);
    const r = rig();
    assert.equal(await runDeliveryRound(d, r.deps), "finished");
    assert.deepEqual(r.sentTo, ["reader1@example.com", "reader2@example.com", "reader3@example.com"]);
    assert.deepEqual(r.sleeps, [PACE, PACE, SETTLE]);
    assert.deepEqual(r.bounceQueries, [Math.floor(T0 / 1000)]); // looked back to the round's start
    assert.deepEqual(deliveryCounts(d), { total: 3, delivered: 3, retrying: [], undeliverable: [], queued: 0 });
    assert.equal(d.bounceCheck, "ok");
    assert.ok(d.finishedAt);
  });

  it("saves the ledger after every single email", async () => {
    const d = newDelivery(people(4), T0);
    const r = rig();
    await runDeliveryRound(d, r.deps);
    assert.equal(r.saves, 4 + 1); // one per email + the closing save
  });

  it("the 9/18 case: a relay refusal is counted as NOT delivered and parked for one retry an hour later", async () => {
    const d = newDelivery(people(8), T0);
    const r = rig({ bounces: () => [relayRefusal("Reader8@Example.com", T0 + 7 * PACE + 3000)] }); // case differs on purpose
    assert.equal(await runDeliveryRound(d, r.deps), "waiting-retry");
    const c = deliveryCounts(d);
    assert.equal(c.delivered, 7);
    assert.deepEqual(c.retrying.map((x) => x.email), ["reader8@example.com"]);
    assert.match(c.retrying[0]?.note ?? "", /Unusual sending activity/);
    assert.equal(d.finishedAt, undefined);
    assert.equal(Date.parse(d.retryAt as string), r.clock.ms + RETRY);

    const notice = deliveryNotice(d, "es", "Princess llama…", "America/New_York");
    assert.equal(notice.title, "📬 Newsletter ES delivered to 7 of 8 — 1 held by the mail server");
    assert.match(notice.body, /Trying again at \d{1,2}:\d{2} [AP]M:\nreader8@example\.com \(550 5\.4\.6/);
  });

  it("does nothing while the retry is not due, then re-sends ONLY the held address and finishes", async () => {
    const d = newDelivery(people(3), T0);
    const first = rig({ bounces: () => [relayRefusal("reader2@example.com", T0 + PACE + 2000)] });
    await runDeliveryRound(d, first.deps);

    const early = rig();
    early.clock.ms = Date.parse(d.retryAt as string) - 1;
    assert.equal(deliveryIsDue(d, early.clock.ms), false);
    assert.equal(await runDeliveryRound(d, early.deps), "not-due");
    assert.deepEqual(early.sentTo, []);

    const due = rig();
    const retryAtMs = Date.parse(d.retryAt as string);
    due.clock.ms = retryAtMs;
    assert.equal(deliveryIsDue(d, due.clock.ms), true);
    assert.equal(await runDeliveryRound(d, due.deps), "finished");
    assert.deepEqual(due.sentTo, ["reader2@example.com"]); // nobody else hears from us twice
    assert.deepEqual(due.bounceQueries, [Math.floor(retryAtMs / 1000)]); // round 2 looks back only to ITS start, not round 1's bounce
    assert.equal(deliveryCounts(d).delivered, 3);
    assert.equal(d.recipients[1]?.attempts, 2);
    assert.equal(deliveryNotice(d, "en", "S", "America/New_York").title, "📬 Newsletter EN after the retry: delivered to 3 of 3");
  });

  it("retries once only: a second relay refusal ends as not delivered, with the server's reason", async () => {
    const d = newDelivery(people(2), T0);
    const always = (): Bounce[] => [relayRefusal("reader1@example.com", Date.now() + 10 * RETRY)];
    await runDeliveryRound(d, rig({ bounces: always }).deps);
    const second = rig({ bounces: always });
    second.clock.ms = Date.parse(d.retryAt as string);
    assert.equal(await runDeliveryRound(d, second.deps), "finished");
    const c = deliveryCounts(d);
    assert.equal(c.delivered, 1);
    assert.deepEqual(c.undeliverable.map((x) => x.email), ["reader1@example.com"]);
    assert.equal(d.retryAt, undefined);
    const notice = deliveryNotice(d, "en", "S", "America/New_York");
    assert.equal(notice.title, "⚠️ Newsletter EN: 1 of 2 not delivered");
    assert.match(notice.body, /Not delivered:\nreader1@example\.com \(550 5\.4\.6/);
  });

  it("a refusal by the RECIPIENT's server is final — never retried", async () => {
    const d = newDelivery(people(2), T0);
    const dead: Bounce = { recipient: "reader1@example.com", status: "5.1.1", relay_refused: false, at: Math.floor(T0 / 1000) + 5, diagnostic: "550 5.1.1 No such user" };
    assert.equal(await runDeliveryRound(d, rig({ bounces: () => [dead] }).deps), "finished");
    assert.equal(d.retryAt, undefined);
    assert.deepEqual(deliveryCounts(d).undeliverable.map((x) => x.note), ["550 5.1.1 No such user"]);
  });

  it("an email the mail service would not take is held for the retry too", async () => {
    const d = newDelivery(people(2), T0);
    assert.equal(await runDeliveryRound(d, rig({ refuse: ["reader2@example.com"] }).deps), "waiting-retry");
    assert.deepEqual(deliveryCounts(d).retrying.map((x) => x.email), ["reader2@example.com"]);
  });

  it("ignores bounces from before this round and for people not on this send", async () => {
    const d = newDelivery(people(2), T0);
    const stale = relayRefusal("reader1@example.com", T0 - 60_000);
    const stranger = relayRefusal("someone-else@example.com", T0 + 5000);
    assert.equal(await runDeliveryRound(d, rig({ bounces: () => [stale, stranger] }).deps), "finished");
    assert.equal(deliveryCounts(d).delivered, 2);
  });

  it("a restart mid-send resumes with the people still queued — no one is mailed twice, no one dropped", async () => {
    const d = newDelivery(people(5), T0);
    let sends = 0;
    const crashing = rig();
    const realSend = crashing.deps.send;
    crashing.deps.send = async (p) => { if (sends === 2) throw new Error("process restarted"); sends += 1; return realSend(p); };
    await assert.rejects(runDeliveryRound(d, crashing.deps));
    const saved = JSON.parse(JSON.stringify(d)) as NewsletterDelivery; // what the store holds after the crash
    assert.equal(deliveryIsDue(saved, T0 + 10 * 60_000), true);

    const resumed = rig();
    assert.equal(await runDeliveryRound(saved, resumed.deps), "finished");
    assert.deepEqual(resumed.sentTo, ["reader3@example.com", "reader4@example.com", "reader5@example.com"]);
    assert.equal(deliveryCounts(saved).delivered, 5);
    assert.ok(saved.recipients.every((x) => x.attempts === 1));
  });

  it("a restart during the settle wait still runs the bounce check", async () => {
    const d = newDelivery(people(1), T0);
    const first = d.recipients[0];
    assert.ok(first);
    first.state = "sent";
    first.attempts = 1; // sent, then the process died before the check
    assert.equal(deliveryIsDue(d, T0 + 1000), true);
    const r = rig({ bounces: () => [relayRefusal("reader1@example.com", T0 + 3000)] });
    assert.equal(await runDeliveryRound(d, r.deps), "waiting-retry");
    assert.deepEqual(r.sentTo, []);
  });

  it("says so when the bounce check could not run, instead of claiming delivery", async () => {
    const d = newDelivery(people(2), T0);
    d.auto = true;
    assert.equal(await runDeliveryRound(d, rig({ bounces: () => null }).deps), "finished");
    assert.equal(d.bounceCheck, "unavailable");
    const notice = deliveryNotice(d, "en", "Subject line", "America/New_York");
    assert.equal(notice.title, "📬 Newsletter EN auto-sent, delivered to 2 of 2");
    assert.match(notice.body, /^Subject line\n.*not confirmed delivery/);
  });

  it("a finished ledger is never due and never re-sends", async () => {
    const d = newDelivery(people(1), T0);
    await runDeliveryRound(d, rig().deps);
    const again = rig();
    assert.equal(deliveryIsDue(d, T0 + 10 * RETRY), false);
    assert.equal(await runDeliveryRound(d, again.deps), "finished");
    assert.deepEqual(again.sentTo, []);
  });
});
