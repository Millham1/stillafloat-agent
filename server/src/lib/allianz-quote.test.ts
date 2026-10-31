// allianz-quote.test.ts — the background Allianz quote (Mark 2026-10-30): the file's facts become the portal's inputs; without a
// browser, a sign-in or the portal map the job says so and invents nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QUOTE_NOTE, fetchAllianzQuote, plansFromText, quoteInputFor } from "./allianz-quote";

const GROUP = { sail_date: "2027-05-09", return_date: "2027-05-13", embark_port: "Port Canaveral", itinerary: [{ day: 1, port: "Port Canaveral" }, { day: 2, port: "Nassau" }, { day: 3, port: "Ocean Cay" }],
  terms: { cabin_categories: [{ category: "Balcony Bella", code: "BB", price_per_person: 536.79 }] } };
const CABIN = { category: "Balcony Bella", category_code: "BB", price_total: 1073.58, booked_at: "2026-10-30T12:00:00Z" };
const T = { dob: "1965-04-12", form_data: { city_state_zip: "Fuquay Varina, NC 27526" } };

test("the quote's inputs come from the file: home state, dates, the fare per person, the birth dates, the deposit date, the ports", () => {
  const q = quoteInputFor({ group: GROUP, traveler: T, cabin: CABIN, mates: [{ dob: "1966-02-02" }] });
  assert.deepEqual(q, { state: "NC", depart_date: "2027-05-09", return_date: "2027-05-13", trip_cost: 536.79, birth_dates: ["1965-04-12", "1966-02-02"], deposit_date: "2026-10-30", destination: "Nassau, Ocean Cay" });
  const noCat = quoteInputFor({ group: { ...GROUP, terms: {} }, traveler: T, cabin: CABIN, mates: [{ dob: "1966-02-02" }] });
  assert.equal("missing" in noCat ? "" : noCat.trip_cost, 536.79, "no category price: the cabin's total split by its travelers");
  const bare = quoteInputFor({ group: { ...GROUP, sail_date: null }, traveler: { form_data: {} }, cabin: null, mates: [] });
  assert.deepEqual("missing" in bare ? bare.missing : [], ["home state", "sailing dates", "cruise fare per person", "birth date"]);
});

test("no browser, no sign-in or no portal map: unavailable, with the reason for Mark's row, and the note on every price", async () => {
  const input = quoteInputFor({ group: GROUP, traveler: T, cabin: CABIN, mates: [] });
  assert.ok(!("missing" in input));
  if ("missing" in input) return;
  assert.deepEqual(await fetchAllianzQuote(input, { chromePath: undefined, user: "u", password: "p" }), { status: "unavailable", reason: "no browser on this box (CHROME_PATH)" });
  assert.deepEqual(await fetchAllianzQuote(input, { chromePath: "/usr/bin/chrome", user: undefined, password: undefined }), { status: "unavailable", reason: "no Allianz agent sign-in on this box (ALLIANZ_AGENT_USER / ALLIANZ_AGENT_PASSWORD)" });
  assert.deepEqual(await fetchAllianzQuote(input, { chromePath: "/usr/bin/chrome", user: "u", password: "p" }, { loginUrl: "https://example.test", steps: [] }), { status: "unavailable", reason: "the Allianz portal's quote screens are not mapped yet" });
  assert.equal(QUOTE_NOTE, "Pricing subject to change until finalized.");
});

test("the plans Mark types on the group file, one per line with a dollar figure, are the plans the page offers (Mark 2026-10-30)", () => {
  assert.deepEqual(plansFromText("OneTrip Basic: $89 per person\nOneTrip Prime — $129.50 per person\n\nOneTrip Premier $1,029\nno price on this line\n"), [
    { name: "OneTrip Basic", price_per_person: 89 }, { name: "OneTrip Prime", price_per_person: 129.5 }, { name: "OneTrip Premier", price_per_person: 1029 },
  ]);
  assert.deepEqual(plansFromText(null), []);
  assert.deepEqual(plansFromText("Prime: $0"), [], "a free plan is not a plan");
});
