// storm-sailings.test.ts — the "Track this ship" sign-up link only goes beside a ship the
// tracker knows. It carries no dates: a storm-page watch runs 15 days from when it starts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTrackable, type Sailing } from "./storm-sailings";

const sailing = (ship_name: string, start_date = "2026-09-15", end_date = "2026-09-20"): Sailing => ({
  ship_name, cruise_line: "Carnival", depart_port: "Miami", start_date, end_date, regions: ["bahamas"],
});

describe("withTrackable", () => {
  it("marks each sailing by whether Where's My Ship can open that ship, keeping every other field and adding nothing else", () => {
    const registry = new Set(["carnival panorama", "navigator of the seas"]);
    const out = withTrackable(
      [sailing("Carnival Panorama"), sailing("Navigator of the Seas"), sailing("A Ship We Do Not Track"), sailing("")],
      (name) => registry.has(name.toLowerCase()),
    );
    assert.deepEqual(out.map((s) => [s.ship_name, s.trackable]), [
      ["Carnival Panorama", true],
      ["Navigator of the Seas", true],
      ["A Ship We Do Not Track", false],
      ["", false],
    ]);
    assert.deepEqual(out[0], { ...sailing("Carnival Panorama"), trackable: true });
    assert.deepEqual(out[2], { ...sailing("A Ship We Do Not Track"), trackable: false });
  });

  it("links a ship whatever its listed dates, since the watch does not use them", () => {
    const [season, underWay] = withTrackable([
      sailing("Seasonal Deployment", "2026-05-01", "2026-10-31"),
      sailing("Under Way", "2026-09-10", "2026-09-17"),
    ], () => true);
    assert.deepEqual([season!.trackable, underWay!.trackable], [true, true]);
  });

  it("gives no links at all when the registry has not loaded", () => {
    assert.deepEqual(withTrackable([sailing("Carnival Panorama")], () => false).map((s) => s.trackable), [false]);
  });
});
