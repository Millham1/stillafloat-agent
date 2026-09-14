import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shipsInPort, IN_PORT_RADIUS_KM, IN_PORT_MAX_AGE_H } from "./webcam-ships";

const miami = { slug: "miami", lat: 25.7617, lon: -80.1918 };
const now = new Date("2026-09-14T18:00:00Z");
const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
const ship = (name: string, lat: number, lon: number, hoursAgo: number, sogKn = 0) =>
  ({ name, cruiseLine: "Line", lat, lon, sogKn, lastPosAt: at(hoursAgo) });

describe("shipsInPort", () => {
  it("lists ships with a recent fix near the port, docked first, then by name", () => {
    const list = shipsInPort([
      ship("Wonder of the Seas", 25.775, -80.17, 1),          // PortMiami terminals, alongside
      ship("Carnival Glory", 25.77, -80.18, 2, 0.3),
      ship("Norwegian Epic", 25.70, -80.05, 0.5, 14),          // leaving, 12 nm off, under way
      ship("Icon of the Seas", 26.09, -80.12, 1),              // Fort Lauderdale, 36 km away
    ], miami, now);
    assert.deepEqual(list.map((s) => [s.name, s.docked]), [["Carnival Glory", true], ["Wonder of the Seas", true]]);
  });
  it("a fix older than the age limit does not count, nor a ship with no fix", () => {
    const list = shipsInPort([
      ship("Old Fix", 25.77, -80.18, IN_PORT_MAX_AGE_H + 1),
      { name: "No Fix", lat: null, lon: null, lastPosAt: null },
      ship("Fresh", 25.77, -80.18, IN_PORT_MAX_AGE_H - 1),
    ], miami, now);
    assert.deepEqual(list.map((s) => s.name), ["Fresh"]);
  });
  it("the radius is the port's, not the ship's", () => {
    const edge = 25.7617 + (IN_PORT_RADIUS_KM - 0.5) / 111; // just inside, due north
    const past = 25.7617 + (IN_PORT_RADIUS_KM + 0.5) / 111; // just outside
    const list = shipsInPort([ship("Inside", edge, -80.1918, 1), ship("Outside", past, -80.1918, 1)], miami, now);
    assert.deepEqual(list.map((s) => s.name), ["Inside"]);
  });
  it("a moving ship inside the radius is listed but not marked docked", () => {
    const [s] = shipsInPort([ship("Passing", 25.77, -80.18, 0.2, 9)], miami, now);
    assert.equal(s?.docked, false);
  });
});
