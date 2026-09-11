// active-set.test.ts — every registry ship gets a subscription while there is room.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectActiveSet, trackingRank, AISSTREAM_MMSIS_PER_SUBSCRIPTION } from "./active-set";

const ship = (name: string, o: Partial<{ seedActive: boolean; lastRequestedAt: string | null; hasWatch: boolean }> = {}) =>
  ({ mmsi: String(300000000 + name.length * 1000 + name.charCodeAt(0)), name, seedActive: false, lastRequestedAt: null, hasWatch: false, ...o });

describe("selectActiveSet", () => {
  const storm = new Set<string>();
  const registry = [
    ship("Zuiderdam"),                                                    // never requested, not seeded
    ship("Utopia of the Seas", { seedActive: true }),
    ship("Norwegian Getaway", { lastRequestedAt: "2026-09-10T20:00:00Z" }),
    ship("Icon of the Seas", { lastRequestedAt: "2026-09-11T01:00:00Z" }),
    ship("Carnival Celebration", { hasWatch: true }),
    ship("Anthem of the Seas"),                                           // never requested, not seeded
  ];
  it("fills spare capacity with never-requested ships instead of leaving them registry-only", () => {
    const set = selectActiveSet(registry, storm, 600);
    assert.equal(set.length, registry.length, "the whole registry is subscribed when it fits");
    assert.deepEqual(set.map((s) => s.name), [
      "Carnival Celebration",   // watched
      "Utopia of the Seas",     // seeded
      "Icon of the Seas",       // requested, newest first
      "Norwegian Getaway",
      "Anthem of the Seas",     // the rest, by name
      "Zuiderdam",
    ]);
  });
  it("under capacity pressure the lowest-ranked ships are the ones left out", () => {
    const set = selectActiveSet(registry, storm, 4).map((s) => s.name);
    assert.deepEqual(set, ["Carnival Celebration", "Utopia of the Seas", "Icon of the Seas", "Norwegian Getaway"]);
  });
  it("a storm alert promotes a ship to the top whatever its history", () => {
    const zuiderdam = registry[0]!;
    const set = selectActiveSet(registry, new Set([zuiderdam.mmsi]), 2).map((s) => s.name);
    assert.deepEqual(set.sort(), ["Carnival Celebration", "Zuiderdam"]);
    assert.equal(trackingRank(zuiderdam, new Set([zuiderdam.mmsi])), 0);
  });
  it("capacity of zero subscribes nothing; the input is not mutated", () => {
    const before = registry.map((s) => s.name);
    assert.deepEqual(selectActiveSet(registry, storm, 0), []);
    assert.deepEqual(registry.map((s) => s.name), before);
  });
  it("the default per-subscription allowance is aisstream's published 200, and three keys cover a 315-ship registry", () => {
    assert.equal(AISSTREAM_MMSIS_PER_SUBSCRIPTION, 200);
    assert.ok(3 * AISSTREAM_MMSIS_PER_SUBSCRIPTION >= 315);
  });
});
