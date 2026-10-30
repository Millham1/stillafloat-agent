// travel-advisories.test.ts — the State Department advisory per port of an itinerary (Mark 2026-10-30), never asked of the client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { advisoriesForGroup, advisoriesForPorts, advisoryEntries, advisoryFor, countryOfPort, itineraryPorts, parseAdvisoryFeed, resetAdvisoryCache } from "./travel-advisories";

const FEED = `<?xml version="1.0"?><rss><channel><title>Travel Advisories</title>
<item><title>The Bahamas - Level 2: Exercise Increased Caution</title></item>
<item><title>Mexico Travel Advisory - Level 2: Exercise Increased Caution</title></item>
<item><title>Haiti - Level 4: Do Not Travel</title></item>
<item><title>Cayman Islands - Level 1: Exercise Normal Precautions</title></item>
<item><title><![CDATA[Jamaica - Level 2: Exercise Increased Caution]]></title></item>
<item><title>Worldwide Caution</title></item>
</channel></rss>`;

test("the feed's titles become country, level and the level's words; titles without a level are left out", () => {
  const e = parseAdvisoryFeed(FEED);
  assert.deepEqual(e.map((x) => [x.country, x.level]), [["The Bahamas", 2], ["Mexico", 2], ["Haiti", 4], ["Cayman Islands", 1], ["Jamaica", 2]]);
  assert.equal(e[0]!.title, "Level 2: Exercise Increased Caution");
});

test("a port's country comes from the gazetteer name; home ports are the United States; the feed's names are matched loosely", () => {
  assert.equal(countryOfPort("Nassau, Bahamas"), "The Bahamas");
  assert.equal(countryOfPort("Ocean Cay MSC Marine Reserve, Bahamas"), "The Bahamas");
  assert.equal(countryOfPort("Miami, Florida"), "United States");
  assert.equal(countryOfPort("St. Thomas, USVI"), "United States");
  assert.equal(countryOfPort("Grand Cayman"), "Cayman Islands");
  assert.equal(countryOfPort("Cozumel, Mexico"), "Mexico");
  assert.equal(countryOfPort("Grand Turk, Turks & Caicos"), "Turks and Caicos Islands");
  assert.equal(countryOfPort("Halifax, Nova Scotia"), "Canada");
  const e = parseAdvisoryFeed(FEED);
  assert.equal(advisoryFor("The Bahamas", e)?.level, 2);
  assert.equal(advisoryFor("Bahamas", e)?.level, 2);
  assert.equal(advisoryFor("Mexico", e)?.title, "Level 2: Exercise Increased Caution");
  assert.equal(advisoryFor("Narnia", e), null);
});

test("every port of the itinerary gets its advisory, the embarkation port first, sea days left out, the unknown ones said so", () => {
  const group = { embark_port: "Port Canaveral", itinerary: [{ day: 1, port: "Port Canaveral" }, { day: 2, port: "At sea" }, { day: 3, port: "Nassau" }, { day: 4, port: "Ocean Cay" }, { day: 5, port: "Labadee" }, { day: 6, port: "Atlantis" }] };
  assert.deepEqual(itineraryPorts(group), ["Port Canaveral", "Nassau", "Ocean Cay", "Labadee", "Atlantis"]);
  const a = advisoriesForPorts(itineraryPorts(group), parseAdvisoryFeed(FEED));
  assert.deepEqual(a.map((x) => [x.port, x.country, x.level]), [
    ["Port Canaveral", "United States", null], ["Nassau", "The Bahamas", 2], ["Ocean Cay", "The Bahamas", 2], ["Labadee", "Haiti", 4], ["Atlantis", "Atlantis", null],
  ]);
  assert.match(a[4]!.title, /not listed/);
});

test("the feed is read once a day and the last good copy is kept when it is down; nothing read means no advisories", async () => {
  resetAdvisoryCache();
  let calls = 0;
  const ok = (async () => { calls++; return new Response(FEED, { status: 200 }); }) as unknown as typeof fetch;
  const down = (async () => { calls++; throw new Error("network down"); }) as unknown as typeof fetch;
  assert.equal((await advisoryEntries(ok, 1_000)).length, 5);
  assert.equal((await advisoryEntries(down, 2_000)).length, 5, "within the day: the kept copy, no fetch");
  assert.equal(calls, 1);
  assert.equal((await advisoryEntries(down, 2_000 + 25 * 3_600_000)).length, 5, "a day later and the feed is down: the last good copy");
  assert.equal(calls, 2);
  resetAdvisoryCache();
  assert.deepEqual(await advisoriesForGroup({ embark_port: "Miami", itinerary: [] }, down), [], "nothing ever read: no advisories (the waiver says they could not be read)");
  resetAdvisoryCache();
});
