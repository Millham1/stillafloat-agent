// social-analytics.test.ts — the dashboard's social pulse reads the snapshot list the ingest
// route writes (2026-10-08: it read a "latest" object nobody wrote, and said "No data yet").
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { latestAndPrior } from "./social-analytics";

const snap = (at: string, ig: number) => ({ at, instagram: { followers: ig, reach: ig * 10 } });

test("latestAndPrior: newest snapshot, and the newest one at least 28 days older", () => {
  const items = [snap("2026-09-01T00:00:00Z", 100), snap("2026-09-05T00:00:00Z", 110), snap("2026-10-01T00:00:00Z", 150), snap("2026-10-08T00:00:00Z", 160)];
  const { latest, prior } = latestAndPrior([...items].reverse());
  assert.equal(latest?.at, "2026-10-08T00:00:00Z");
  assert.equal(prior?.at, "2026-09-05T00:00:00Z");
});

test("latestAndPrior: a short series compares with its oldest snapshot; one snapshot has no prior; empty has neither", () => {
  const short = latestAndPrior([snap("2026-10-07T00:00:00Z", 1), snap("2026-10-08T00:00:00Z", 2)]);
  assert.equal(short.latest?.at, "2026-10-08T00:00:00Z");
  assert.equal(short.prior?.at, "2026-10-07T00:00:00Z");
  const one = latestAndPrior([snap("2026-10-08T00:00:00Z", 2)]);
  assert.equal(one.prior, null);
  assert.deepEqual(latestAndPrior([]), { latest: null, prior: null });
});
