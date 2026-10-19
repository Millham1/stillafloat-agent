// last-good-store.test.ts — the saved "last good answer" the weather route starts from after a restart.
// Everything is injected: a fake disk (JSON round-trip, like platform_state), a fake clock.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lastGoodStore, LAST_GOOD_RETRY_MS } from "./last-good-store";

const HOUR = 3_600_000;

function fakeDisk(initial: unknown = null) {
  let saved: unknown = initial;
  const writes: unknown[] = [];
  return {
    read: async (_key: string) => (saved === null ? null : JSON.parse(JSON.stringify(saved))),
    write: async (_key: string, payload: unknown) => { saved = JSON.parse(JSON.stringify(payload)); writes.push(saved); return true; },
    get saved() { return saved as { savedAt: string; entries: Record<string, { at: number; value: { n: number } }> } | null; },
    writes,
  };
}
type V = { n: number };
const isV = (v: unknown): v is V => !!v && typeof v === "object" && typeof (v as V).n === "number";
const make = (disk: ReturnType<typeof fakeDisk>, clock: { t: number }, extra: Record<string, unknown> = {}) =>
  lastGoodStore<V>({ key: "k", maxEntries: 3, maxAgeMs: 10 * HOUR, saveDelayMs: 5, validate: isV, read: disk.read, write: disk.write, now: () => clock.t, ...extra });

describe("last-good store: save and read back", () => {
  it("a noted answer is saved with its time, and a new run reads it back", async () => {
    const disk = fakeDisk(); const clock = { t: 1_000_000 };
    const run1 = make(disk, clock);
    run1.note("miami", { n: 1 });
    await run1.flush();
    assert.deepEqual(disk.saved?.entries["miami"], { at: 1_000_000, value: { n: 1 } });

    clock.t += 2 * HOUR;
    const run2 = make(disk, clock);
    assert.equal(run2.get("miami"), undefined, "nothing is known before the saved copy is read");
    await run2.load();
    assert.deepEqual(run2.get("miami"), { at: 1_000_000, value: { n: 1 } });
  });

  it("an answer older than maxAgeMs is neither served nor saved", async () => {
    const disk = fakeDisk(); const clock = { t: 5_000_000 };
    const s = make(disk, clock);
    s.note("old", { n: 1 });
    clock.t += 10 * HOUR + 1;
    assert.equal(s.get("old"), undefined);
    s.note("new", { n: 2 });
    await s.flush();
    assert.deepEqual(Object.keys(disk.saved!.entries), ["new"]);
    // and an old saved entry is dropped on load
    const stale = fakeDisk({ entries: { gone: { at: clock.t - 11 * HOUR, value: { n: 9 } }, kept: { at: clock.t - HOUR, value: { n: 8 } } } });
    const s2 = make(stale, clock);
    await s2.load();
    assert.equal(s2.get("gone"), undefined);
    assert.equal(s2.get("kept")?.value.n, 8);
  });

  it("keeps at most maxEntries, dropping the oldest", async () => {
    const disk = fakeDisk(); const clock = { t: 1_000 };
    const s = make(disk, clock);
    for (const [k, at] of [["a", 1], ["b", 2], ["c", 3], ["d", 4]] as const) s.note(k, { n: at }, at);
    await s.flush();
    assert.deepEqual(Object.keys(disk.saved!.entries).sort(), ["b", "c", "d"]);
  });

  it("a saved entry the current code cannot read (wrong shape) is dropped, not served", async () => {
    const disk = fakeDisk({ entries: { bad: { at: 1, value: { nope: true } }, bad2: { at: "x", value: { n: 1 } }, ok: { at: 1, value: { n: 2 } } } });
    const s = make(disk, { t: 100 });
    await s.load();
    assert.equal(s.get("bad"), undefined);
    assert.equal(s.get("bad2"), undefined);
    assert.equal(s.get("ok")?.value.n, 2);
  });

  it("reading the saved copy never replaces something newer this run already learnt", async () => {
    const disk = fakeDisk({ entries: { miami: { at: 10, value: { n: 1 } } } });
    const s = make(disk, { t: 1000 });
    s.note("miami", { n: 2 }, 500);
    await s.load();
    assert.equal(s.get("miami")?.value.n, 2);
  });

  it("many notes in a burst are one write", async () => {
    const disk = fakeDisk(); const clock = { t: 1_000 };
    const s = make(disk, clock);
    for (let i = 0; i < 20; i++) s.note(`p${i % 3}`, { n: i });
    await new Promise((r) => setTimeout(r, 60));   // past saveDelayMs (5 ms)
    assert.equal(disk.writes.length, 1);
  });
});

describe("last-good store: a failing disk never breaks the caller", () => {
  it("a failed read means 'start without a copy' — and nothing is written over the copy it could not read", async () => {
    const disk = fakeDisk({ entries: { miami: { at: 1, value: { n: 1 } } } });
    const clock = { t: 100 };
    let failing = true;
    const s = make(disk, clock, { read: async (k: string) => { if (failing) throw new Error("supabase down"); return disk.read(k); } });
    await s.load();                       // does not throw
    s.note("fresh", { n: 2 });
    await s.flush();
    assert.equal(disk.writes.length, 0, "a thin in-memory map must not overwrite the saved copy it could not read");

    // once the disk is back (after the retry wait) the saved copy is read, merged, and then written
    failing = false;
    clock.t += LAST_GOOD_RETRY_MS + 1;
    await s.flush();
    assert.deepEqual(Object.keys(disk.saved!.entries).sort(), ["fresh", "miami"]);
  });

  it("ready() waits for a slow read only up to its cap", async () => {
    const disk = fakeDisk({ entries: { miami: { at: 1, value: { n: 1 } } } });
    const s = make(disk, { t: 100 }, { read: async (k: string) => { await new Promise((r) => setTimeout(r, 200)); return disk.read(k); } });
    const t0 = Date.now();
    await s.ready(20);
    assert.ok(Date.now() - t0 < 150, "ready() returned at its cap, not when the read finished");
    assert.equal(s.get("miami"), undefined);
    await s.ready(2000);                  // the read finishes
    assert.equal(s.get("miami")?.value.n, 1);
  });

  it("a failed write is not thrown at the caller and is tried again on the next flush", async () => {
    const disk = fakeDisk();
    let failing = true;
    const s = make(disk, { t: 100 }, { write: async (k: string, p: unknown) => { if (failing) throw new Error("write refused"); return disk.write(k, p); } });
    s.note("miami", { n: 1 });
    await s.flush();                      // does not throw
    assert.equal(disk.writes.length, 0);
    failing = false;
    await s.flush();
    assert.equal(disk.saved?.entries["miami"]?.value.n, 1);
  });
});
