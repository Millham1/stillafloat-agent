// visa-requirements.test.ts — the visa table of our own (Mark 2026-10-31): loaded from the Passport Index dataset, reviewed every
// 90 days, read by the passport checklist; nothing asserted that was not read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VISA_DATASET_URL, describeVisa, iso2Of, parseTidyCsv, refreshVisaRequirements, regionName, requirementOf, visaRowFor, type VisaRow, type VisaStore } from "./visa-requirements";

const CSV = ["Passport,Destination,Requirement", "AF,AL,e-visa", "US,US,-1", "US,BS,240", "US,DO,visa free", "US,MX,180", "US,GB,eta", "US,IN,e-visa", "US,EG,visa on arrival", "US,RU,visa required", "US,KP,no admission", "us,ky,90", ""].join("\n");

test("the dataset's values become our requirement and the stay it allows; the passport's own country is left out", () => {
  assert.deepEqual(parseTidyCsv(CSV), [
    { destination_iso2: "BS", raw: "240" }, { destination_iso2: "DO", raw: "visa free" }, { destination_iso2: "MX", raw: "180" }, { destination_iso2: "GB", raw: "eta" },
    { destination_iso2: "IN", raw: "e-visa" }, { destination_iso2: "EG", raw: "visa on arrival" }, { destination_iso2: "RU", raw: "visa required" }, { destination_iso2: "KP", raw: "no admission" }, { destination_iso2: "KY", raw: "90" },
  ]);
  assert.deepEqual(parseTidyCsv(CSV, "AF"), [{ destination_iso2: "AL", raw: "e-visa" }]);
  assert.deepEqual(requirementOf("240"), { requirement: "visa-free", stay_days: 240 });
  assert.deepEqual(requirementOf("visa free"), { requirement: "visa-free", stay_days: null });
  assert.deepEqual(requirementOf("visa on arrival"), { requirement: "visa-on-arrival", stay_days: null });
  assert.deepEqual(requirementOf("e-visa"), { requirement: "e-visa", stay_days: null });
  assert.deepEqual(requirementOf("eta"), { requirement: "eta", stay_days: null });
  assert.deepEqual(requirementOf("visa required"), { requirement: "visa-required", stay_days: null });
  assert.deepEqual(requirementOf("no admission"), { requirement: "no-admission", stay_days: null });
  assert.deepEqual(requirementOf("covid ban"), { requirement: "unknown", stay_days: null });
});

test("a country as the itinerary names it finds its ISO code and its row; Node's region names plus the cruise world's aliases", () => {
  assert.equal(regionName("BS"), "Bahamas");
  for (const [name, code] of [["The Bahamas", "BS"], ["Bahamas", "BS"], ["Sint Maarten", "SX"], ["St. Maarten", "SX"], ["Saint Kitts and Nevis", "KN"], ["St. Lucia", "LC"], ["Curaçao", "CW"],
    ["Turks and Caicos Islands", "TC"], ["Bonaire", "BQ"], ["British Virgin Islands", "VG"], ["Cayman Islands", "KY"], ["Dominican Republic", "DO"], ["Mexico", "MX"], ["United Kingdom", "GB"],
    ["Antigua and Barbuda", "AG"], ["Saint Vincent and the Grenadines", "VC"], ["Honduras", "HN"], ["Hong Kong", "HK"], ["United Arab Emirates", "AE"]]) {
    assert.equal(iso2Of(name as string), code, name as string);
  }
  assert.equal(iso2Of("Atlantis"), null);
  assert.equal(iso2Of(""), null);
  const rows: VisaRow[] = [{ passport: "US", destination_iso2: "BS", destination_name: "Bahamas", requirement: "visa-free", stay_days: 240, raw: "240", source: "passport-index-dataset", source_url: VISA_DATASET_URL, checked_at: "2026-10-31T20:00:00.000Z", next_check_at: "2027-01-29T20:00:00.000Z" }];
  assert.equal(visaRowFor("The Bahamas", rows)?.stay_days, 240);
  assert.equal(visaRowFor("Mexico", rows), null);
  assert.deepEqual(describeVisa(rows[0]!), { required: false, type: "Visa-free for U.S. passport holders, stays up to 240 days" });
  assert.deepEqual(describeVisa({ ...rows[0]!, requirement: "eta", stay_days: null }), { required: true, type: "Electronic Travel Authorization (ETA): applied for online before travel" });
  assert.deepEqual(describeVisa({ ...rows[0]!, requirement: "visa-required", stay_days: null }), { required: true, type: "Visa in Advance: from the consulate or embassy before departure" });
  assert.equal(describeVisa({ ...rows[0]!, requirement: "unknown", stay_days: null }).required, null);
});

function fakeStore() {
  const state: VisaRow[] = [];
  const store: VisaStore = {
    async all(passport) { return state.filter((r) => r.passport === passport).map((r) => ({ ...r })); },
    async upsert(rows) { for (const r of rows) { const i = state.findIndex((x) => x.passport === r.passport && x.destination_iso2 === r.destination_iso2); if (i >= 0) state[i] = { ...r }; else state.push({ ...r }); } },
  };
  return { state, store };
}
// 120 made-up destinations "FA".."JP" (none of them BS) plus the Bahamas row the test watches
const bigCsv = (bahamas = "240") => ["Passport,Destination,Requirement", `US,BS,${bahamas}`, ...Array.from({ length: 120 }, (_, i) => `US,${String.fromCharCode(70 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))},90`)].join("\n");

test("the quarterly review: the table is loaded when empty, left alone until a row is due, read again after 90 days with the changes counted; a dataset that cannot be read keeps the rows", async () => {
  const { state, store } = fakeStore();
  let calls = 0; let body = bigCsv();
  const fetchImpl = (async () => { calls++; return new Response(body, { status: 200 }); }) as unknown as typeof fetch;
  const t0 = new Date("2026-10-31T20:00:00.000Z");
  const first = await refreshVisaRequirements(store, fetchImpl, t0);
  assert.deepEqual(first, { due: true, rows: 121, loaded: 121, changed: 0, next_check_at: "2027-01-29T20:00:00.000Z" });
  assert.equal(state.length, 121);
  const bs = state.find((r) => r.destination_iso2 === "BS")!;
  assert.deepEqual([bs.destination_name, bs.requirement, bs.stay_days, bs.raw, bs.source, bs.checked_at], ["Bahamas", "visa-free", 240, "240", "passport-index-dataset", "2026-10-31T20:00:00.000Z"]);
  const later = await refreshVisaRequirements(store, fetchImpl, new Date("2026-12-01T20:00:00.000Z"));
  assert.deepEqual(later, { due: false, rows: 121, loaded: 0, changed: 0, next_check_at: "2027-01-29T20:00:00.000Z" });
  assert.equal(calls, 1, "nothing fetched while no row is due");
  body = bigCsv("visa required");
  const review = await refreshVisaRequirements(store, fetchImpl, new Date("2027-01-30T20:00:00.000Z"));
  assert.deepEqual([review.due, review.loaded, review.changed, review.next_check_at], [true, 121, 1, "2027-04-30T20:00:00.000Z"]);
  assert.equal(state.find((r) => r.destination_iso2 === "BS")!.requirement, "visa-required");
  assert.equal(calls, 2);
  const down = (async () => { calls++; return new Response("", { status: 503 }); }) as unknown as typeof fetch;
  await assert.rejects(refreshVisaRequirements(store, down, new Date("2027-05-01T20:00:00.000Z")), /HTTP 503/);
  assert.equal(state.length, 121, "the table keeps its rows when the dataset cannot be read");
  const thin = (async () => new Response("Passport,Destination,Requirement\nUS,BS,240\n", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(refreshVisaRequirements(store, thin, new Date("2027-05-01T20:00:00.000Z")), /only 1 rows/);
  assert.equal((await refreshVisaRequirements(store, fetchImpl, new Date("2026-12-01T20:00:00.000Z"), "US", true)).due, true, "forced: read again whether or not a row is due");
});
