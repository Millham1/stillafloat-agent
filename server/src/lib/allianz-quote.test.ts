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

// Mark 2026-11-10: the whole trip quoted on Allianz's agent site. The pieces that turn the file into what the site takes, and its rows into plans.
test("the trip quote's helpers: dates the way the site takes them, a traveler's age in whole years, a plan row read as printed (one price for the party)", async () => {
  const { usDate, ageOnDay, tripPlanFrom, fetchAllianzTripQuote, AGENTMAX_URL } = await import("./allianz-quote");
  assert.equal(usDate("2027-05-09"), "05/09/2027");
  assert.deepEqual([ageOnDay("1964-05-09", "2026-11-10"), ageOnDay("1973-03-15", "2026-11-10"), ageOnDay("2000-11-10", "2026-11-10"), ageOnDay("2000-11-11", "2026-11-10")], [62, 53, 26, 25]);
  assert.deepEqual(tripPlanFrom(" Classic Plan   Recommended ", " $265.00 "), { name: "Classic Plan", total: 265 });
  assert.deepEqual(tripPlanFrom("Annual Premier $10K", "$1,050.00"), { name: "Annual Premier $10K", total: 1050 });
  assert.equal(tripPlanFrom("Basic Plan", "call us"), null, "a row with no price is not a plan");
  const { offeredTripPlans } = await import("./allianz-quote");
  assert.deepEqual(offeredTripPlans(["Classic Plan", "Basic Plan", "Classic Plan with Cancel Anytime", "Premier Plan", "Rental Car Damage Protector", "Professional Travel Program", "Annual Premier $5K", "Annual Deluxe"].map((name) => ({ name, total: 1 }))).map((p) => p.name),
    ["Classic Plan", "Basic Plan", "Classic Plan with Cancel Anytime", "Premier Plan"], "Mark 2026-11-10: the annual plans, the rental car plan and the Professional Travel Program are left off the list he picks from");
  assert.match(AGENTMAX_URL, /^https:\/\/www\.agentmaxonline\.com\/.*#\/login$/);
  const input = { state: "NC", total_trip_cost: 2475.26, ages: [62, 53], depart_date: "2027-05-09", return_date: "2027-05-13", deposit_date: "2026-11-10" };
  assert.deepEqual(await fetchAllianzTripQuote(input, { chromePath: undefined, user: "u", password: "p" }), { status: "unavailable", reason: "no browser on this box (CHROME_PATH)" });
  const noSignIn = await fetchAllianzTripQuote(input, { chromePath: "/x", user: undefined, password: undefined });
  assert.equal(noSignIn.status, "unavailable");
  assert.match((noSignIn as { reason: string }).reason, /sign-in is not on this box/);
});
