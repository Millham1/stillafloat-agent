// entry-requirements.test.ts — each itinerary country's visa and vaccination requirements for a U.S. traveler (Mark 2026-10-31),
// read from the CDC and the State Department with the advisory; a source that does not answer is said so, never guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cdcSlugFor, countriesOf, entryRequirementsForGroup, normCountry, parseCdcList, parseCdcVaccines, parseStateQuickFacts, resetEntryCache, stateCountrySlug, stateCountryUrl } from "./entry-requirements";

const LIST = `<ul><li><a href="/travel/destinations/traveler/none/afghanistan">Afghanistan</a></li>
<li><a href="/travel/destinations/traveler/none/the-bahamas" class="x">Bahamas, The</a></li>
<li><a href="/travel/destinations/traveler/none/british-virgin-islands">Virgin Islands, British </a></li>
<li><a href="/travel/destinations/traveler/none/mexico">Mexico</a></li>
<li><a href="/travel/destinations/traveler/none/the-bahamas">Bahamas, The</a></li></ul>`;

const PAGE = `<h3>Travel Health Notices</h3><p>Level 1</p><h3>Vaccines and Medicines</h3><div><table><tr><th>Vaccines for disease</th><th>Recommendations</th><th>Clinical</th></tr>
<tr><td> Routine vaccines </td><td> Make sure you are up-to-date on all routine vaccines before every trip. Some of these vaccines include Chickenpox</td><td>x</td></tr>
<tr><td> COVID-19 </td><td>All eligible travelers should be up to date with their COVID-19 vaccines. Please see Your COVID-19 Vaccination for more information. </td><td>x</td></tr>
<tr><td> Hepatitis A </td><td>Recommended for unvaccinated travelers one year old or older going to The Bahamas.<br>Infants 6 to 11 months old should also be vaccinated.</td><td>x</td></tr>
<tr><td> Rabies </td><td>Dogs infected with rabies are not commonly found in The Bahamas. Please consult with a healthcare provider to determine whether you should receive pre-exposure vaccination before travel.</td><td>x</td></tr>
<tr><td> Typhoid </td><td>Consider getting a typhoid vaccine if you might: Travel to areas with poor sanitation</td><td>x</td></tr>
<tr><td> Yellow Fever </td><td>CDC recommendations: Vaccine is not recommended.<br>Country entry requirements: <ul><li>Direct travel from United States: Vaccine is not required.</li><li>Travel from countries with risk for YF virus transmission: Vaccine is required for travelers &ge;1 year old.</li></ul><div>Updated April 23, 2025</div></td><td>x</td></tr>
</table></div><h3>Non-Vaccine-Preventable Diseases</h3><table><tr><td>Leptospirosis</td><td>Touching urine</td></tr></table>`;

test("the CDC's destination list maps a country to its page, loosely by name", () => {
  const list = parseCdcList(LIST);
  assert.deepEqual(list.map((e) => e.slug), ["afghanistan", "the-bahamas", "british-virgin-islands", "mexico"], "one entry per page, however often the list repeats it");
  assert.equal(normCountry("Bahamas, The"), "bahamas");
  assert.equal(normCountry("Virgin Islands, British "), "british virgin islands");
  assert.equal(normCountry("Anguilla (U.K.)"), "anguilla");
  assert.equal(cdcSlugFor("The Bahamas", list), "the-bahamas");
  assert.equal(cdcSlugFor("British Virgin Islands", list), "british-virgin-islands");
  assert.equal(cdcSlugFor("Mexico", list), "mexico");
  assert.equal(cdcSlugFor("Atlantis", list), null);
});

test("the Vaccines and Medicines table: each vaccine with what the CDC says, the entry requirement for travel from the United States read as such", () => {
  const lines = parseCdcVaccines(PAGE);
  assert.deepEqual(lines.map((l) => [l.name, l.advice]), [
    ["Routine vaccines", "routine"], ["COVID-19", "recommended"], ["Hepatitis A", "recommended"], ["Rabies", "consider"], ["Typhoid", "consider"], ["Yellow Fever", "not-required"],
  ]);
  assert.equal(lines[5]!.text, "Entry requirement for travel from the United States: vaccine is not required.");
  assert.equal(lines[2]!.text, "Recommended for unvaccinated travelers one year old or older going to The Bahamas.");
  assert.equal(parseCdcVaccines(PAGE.replace("Vaccine is not required", "Vaccine is required for all travelers"))[5]!.advice, "required");
  assert.deepEqual(parseCdcVaccines("<p>nothing here</p>"), []);
});

test("the State Department's Quick Facts, when its page answers; its country page address", () => {
  const html = `<div><h2>Quick Facts</h2><p>PASSPORT VALIDITY: Must be valid at time of entry</p><p>BLANK PASSPORT PAGES: One page required for entry stamp</p>
  <p>TOURIST VISA REQUIRED: No</p><p>VACCINATIONS: None</p><p>CURRENCY RESTRICTIONS FOR ENTRY: None</p></div>`;
  assert.deepEqual(parseStateQuickFacts(html), { tourist_visa_required: false, passport_validity: "Must be valid at time of entry", blank_pages: "One page required for entry stamp", vaccinations: "None" });
  assert.equal(parseStateQuickFacts(html.replace("TOURIST VISA REQUIRED: No", "TOURIST VISA REQUIRED: Yes, for stays over 30 days"))!.tourist_visa_required, true);
  assert.equal(parseStateQuickFacts("<title>Attention Required! | Cloudflare</title>"), null, "a bot-check page is not Quick Facts");
  assert.equal(stateCountrySlug("The Bahamas"), "TheBahamas");
  assert.equal(stateCountrySlug("Turks and Caicos Islands"), "TurksandCaicosIslands");
  assert.equal(stateCountryUrl("Mexico"), "https://travel.state.gov/content/travel/en/international-travel/International-Travel-Country-Information-Pages/Mexico.html");
});

test("every foreign country of the itinerary is read once a week; the State Department's refusal leaves the visa line null and names the page; the CDC's table is kept", async () => {
  resetEntryCache();
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes("wwwnc.cdc.gov/travel/destinations/list")) return new Response(LIST, { status: 200 });
    if (url.includes("wwwnc.cdc.gov/travel/destinations/traveler/none/the-bahamas")) return new Response(PAGE, { status: 200 });
    if (url.includes("travel.state.gov")) return new Response("<title>Attention Required! | Cloudflare</title>", { status: 403 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const group = { embark_port: "Port Canaveral", itinerary: [{ port: "Port Canaveral" }, { port: "At sea" }, { port: "Nassau" }, { port: "Ocean Cay" }, { port: "Port Canaveral" }] };
  assert.deepEqual(countriesOf(["Port Canaveral", "Nassau", "Ocean Cay", "Cozumel"]), [{ country: "The Bahamas", ports: ["Nassau", "Ocean Cay"] }, { country: "Mexico", ports: ["Cozumel"] }]);
  const out = await entryRequirementsForGroup(group, fetchImpl, 1_000);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.country, "The Bahamas");
  assert.deepEqual(out[0]!.ports, ["Nassau", "Ocean Cay"]);
  assert.equal(out[0]!.visa, null, "the State Department's page did not answer: nothing is guessed");
  assert.equal(out[0]!.visa_url, "https://travel.state.gov/content/travel/en/international-travel/International-Travel-Country-Information-Pages/TheBahamas.html");
  assert.equal(out[0]!.vaccines!.lines.length, 6);
  assert.equal(out[0]!.vaccines!.url, "https://wwwnc.cdc.gov/travel/destinations/traveler/none/the-bahamas");
  assert.equal(out[0]!.vaccines!.read_at, new Date(1_000).toISOString());
  const before = calls.length;
  await entryRequirementsForGroup(group, fetchImpl, 2_000);
  assert.equal(calls.length, before, "within the day nothing is read again, not even a refusal");
  const again = await entryRequirementsForGroup(group, fetchImpl, 2_000 + 25 * 3_600_000);
  assert.equal(again[0]!.vaccines!.lines.length, 6);
  assert.equal(calls.filter((u) => u.includes("travel.state.gov")).length, 2, "a refusal is tried again after a day");
  assert.equal(calls.filter((u) => u.includes("cdc.gov")).length, 2, "within the week the CDC's copy is kept: the list and the page, once each");
  // the CDC down a week later: the last good copy is kept
  const down = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  const kept = await entryRequirementsForGroup(group, down, 2_000 + 8 * 24 * 3_600_000);
  assert.equal(kept[0]!.vaccines!.lines.length, 6);
  resetEntryCache();
  assert.deepEqual((await entryRequirementsForGroup(group, down))[0]!.vaccines, null, "nothing ever read: the checklist says so");
  resetEntryCache();
});
