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
// 120 made-up destinations "QA".."UP"-style codes starting with Q, W, X, Y, Z (none of them BS, and none a cruise territory) plus the Bahamas row the test watches
const bigCsv = (bahamas = "240") => ["Passport,Destination,Requirement", `US,BS,${bahamas}`, ...Array.from({ length: 120 }, (_, i) => `US,${"QWXYZ"[Math.floor(i / 26)]}${String.fromCharCode(65 + (i % 26))},90`)].join("\n");

test("the quarterly review: the table is loaded when empty, left alone until a row is due, read again after 90 days with the changes counted; a dataset that cannot be read keeps the rows", async () => {
  const { state, store } = fakeStore();
  let calls = 0; let body = bigCsv();
  const fetchImpl = (async () => { calls++; return new Response(body, { status: 200 }); }) as unknown as typeof fetch;
  const t0 = new Date("2026-10-31T20:00:00.000Z");
  const first = await refreshVisaRequirements(store, fetchImpl, t0);
  const { orizn: _o, changes: _c, oriznRows: _n, ...dataset } = first;
  assert.deepEqual(dataset, { due: true, rows: 121, loaded: 121, changed: 0, next_check_at: "2027-01-29T20:00:00.000Z" });
  assert.equal(state.length, 121);
  const bs = state.find((r) => r.destination_iso2 === "BS")!;
  assert.deepEqual([bs.destination_name, bs.requirement, bs.stay_days, bs.raw, bs.source, bs.checked_at], ["Bahamas", "visa-free", 240, "240", "passport-index-dataset", "2026-10-31T20:00:00.000Z"]);
  const later = await refreshVisaRequirements(store, fetchImpl, new Date("2026-12-01T20:00:00.000Z"));
  const { orizn: _o2, changes: _c2, oriznRows: _n2, ...laterDataset } = later;
  assert.deepEqual(laterDataset, { due: false, rows: 121, loaded: 0, changed: 0, next_check_at: "2027-01-29T20:00:00.000Z" });
  assert.match(later.orizn.note, /no ORIZN_API_KEY/);
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

// ── Mark 2026-10-31 "Yes, add one": Orizn fills the destinations the dataset lacks ──
import { CRUISE_TERRITORIES, ORIZN_SOURCE, fetchOrizn, oriznDetail } from "./visa-requirements";
import { ALPHA3 } from "./iso3166";

const oriznBody = (requirement: string, days: number | null, extra: Record<string, unknown> = {}) => JSON.stringify({ data: { passport: "USA", destination: "CYM", requirement, visa_required: requirement !== "visa_free", visa_free_days: days, verified: true, source: "official", source_url: null, last_verified_at: null, passport_validity_months: 6, documents_required: ["Valid passport", "Return ticket"], ...extra }, meta: { lang: "en", quota: { used: 3, limit: 100, remaining: 97, resets_at: "2026-11-30" } } });

test("Orizn: one destination by alpha-3 with the key in the header; the row keeps the stay, the validity and the documents; 404 is no row; a refused key or a used-up quota throws", async () => {
  assert.equal(ALPHA3["KY"], "CYM"); assert.equal(ALPHA3["SX"], "SXM"); assert.equal(ALPHA3["US"], "USA"); assert.equal(Object.keys(ALPHA3).length, 249);
  const seen: Array<{ url: string; key: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, key: (init.headers as Record<string, string>)["x-api-key"] ?? null });
    if (url.includes("destination=BES")) return new Response(JSON.stringify({ error: "No visa data found for USA -> BES" }), { status: 404, headers: { "x-ratelimit-remaining": "96" } });
    if (url.includes("destination=GRL")) return new Response(JSON.stringify({ error: "Missing API key" }), { status: 401 });
    if (url.includes("destination=GIB")) return new Response("", { status: 429, headers: { "retry-after": "3600" } });
    return new Response(oriznBody(url.includes("destination=ABW") ? "eta" : "visa_free", url.includes("destination=ABW") ? null : 30), { status: 200, headers: { "x-ratelimit-remaining": "97" } });
  }) as unknown as typeof fetch;
  const now = new Date("2026-10-31T22:00:00.000Z");
  const ky = await fetchOrizn("KY", "k-123", fetchImpl, now);
  assert.equal(seen[0]!.url, "https://visa.orizn.app/api/v1/visa?passport=USA&destination=CYM&lang=en");
  assert.equal(seen[0]!.key, "k-123");
  assert.equal(ky.remaining, 97);
  assert.deepEqual([ky.row!.destination_iso2, ky.row!.destination_name, ky.row!.requirement, ky.row!.stay_days, ky.row!.source, ky.row!.source_url, ky.row!.checked_at, ky.row!.next_check_at],
    ["KY", "Cayman Islands", "visa-free", 30, "orizn", "https://visa.orizn.app/visa-api/docs", "2026-10-31T22:00:00.000Z", "2027-01-29T22:00:00.000Z"]);
  assert.deepEqual(oriznDetail(ky.row!).documents_required, ["Valid passport", "Return ticket"]);
  assert.equal(oriznDetail(ky.row!).passport_validity_months, 6);
  assert.equal((await fetchOrizn("AW", "k-123", fetchImpl, now)).row!.requirement, "eta");
  const none = await fetchOrizn("BQ", "k-123", fetchImpl, now);
  assert.equal(none.row, null); assert.equal(none.remaining, 96);
  await assert.rejects(fetchOrizn("GL", "k-123", fetchImpl, now), /refused the API key/);
  await assert.rejects(fetchOrizn("GI", "k-123", fetchImpl, now), /quota is used up/);
  assert.equal((await fetchOrizn("XX", "k-123", fetchImpl, now)).row, null, "a code with no alpha-3 is never asked for");
});

test("the review's second pass: without a key the territories stay unfilled and the result says so; with a key only the destinations the dataset lacks are asked for, within the cap and the quota's reserve, and 'no data' is kept as unknown until the next review", async () => {
  const { state, store } = fakeStore();
  let remaining = 100;
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (url.includes("passport-index-dataset")) return new Response(bigCsv(), { status: 200 });
    calls.push(url);
    remaining -= 1;
    if (url.includes("destination=BES")) return new Response("{}", { status: 404, headers: { "x-ratelimit-remaining": String(remaining) } });
    return new Response(oriznBody("visa_free", 90), { status: 200, headers: { "x-ratelimit-remaining": String(remaining) } }).clone();
  }) as unknown as typeof fetch;
  // the body above always reports remaining=97; the header is read when the body has no quota, so make the body quota follow the counter
  const live = (async (url: string, init?: RequestInit) => {
    const r = await (fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    if (r.status !== 200 || url.includes("passport-index-dataset")) return r;
    const j = JSON.parse(await r.text()); j.meta.quota.remaining = remaining;
    return new Response(JSON.stringify(j), { status: 200 });
  }) as unknown as typeof fetch;
  const t0 = new Date("2026-10-31T22:00:00.000Z");
  const noKey = await refreshVisaRequirements(store, live, t0, "US", { wanted: ["BS", "KY"] });
  assert.equal(noKey.rows, 121);
  assert.match(noKey.orizn.note, /no ORIZN_API_KEY/);
  assert.ok(noKey.orizn.missing.includes("KY") && !noKey.orizn.missing.includes("BS"), "the Bahamas is in the dataset; Cayman is not");
  assert.equal(calls.length, 0);
  const withKey = await refreshVisaRequirements(store, live, t0, "US", { oriznKey: "k-123", wanted: async () => ["BS", "KY", "MX"], maxOrizn: 100 });
  assert.equal(withKey.due, false, "the dataset was read today: not read again");
  assert.equal(withKey.orizn.fetched, CRUISE_TERRITORIES.length + 1, "every standing territory asked for once, plus Mexico, which this fake dataset lacks; the dataset's own countries never are");
  assert.ok(!calls.some((u) => u.includes("destination=BHS")) && calls.some((u) => u.includes("destination=MEX")), "nothing the dataset has is asked of Orizn; what an itinerary needs and the dataset lacks is");
  assert.deepEqual(withKey.orizn.missing, []);
  const bq = state.find((r) => r.destination_iso2 === "BQ")!;
  assert.deepEqual([bq.requirement, bq.source, JSON.parse(bq.raw)], ["unknown", ORIZN_SOURCE, { orizn: "no visa data" }], "no visa data is kept as unknown so it is not asked daily");
  assert.equal(state.find((r) => r.destination_iso2 === "KY")!.stay_days, 90);
  const again = await refreshVisaRequirements(store, live, new Date("2026-11-15T22:00:00.000Z"), "US", { oriznKey: "k-123" });
  assert.equal(again.orizn.fetched, 0, "nothing due, nothing missing: no request spent");
  // the reserve: with 6 requests left only one more is spent
  remaining = 6;
  const { state: s2, store: store2 } = fakeStore();
  const low = await refreshVisaRequirements(store2, live, t0, "US", { oriznKey: "k-123", maxOrizn: 100 });
  assert.equal(low.orizn.fetched, 1, `one request, then the reserve stops the run: ${low.orizn.note}`);
  assert.match(low.orizn.note, /kept in reserve/);
  assert.ok(low.orizn.missing.length >= CRUISE_TERRITORIES.length - 1);
  assert.equal(s2.length, 122);
  // the cap
  remaining = 100;
  const { store: store3 } = fakeStore();
  const capped = await refreshVisaRequirements(store3, live, t0, "US", { oriznKey: "k-123", maxOrizn: 3 });
  assert.equal(capped.orizn.fetched, 3); assert.match(capped.orizn.note, /cap of 3/);
});

// ── Mark 2026-10-31: a new port is asked for on its own; "alert me on reaching 180 ports"; Europe's changes ──
import { VISA_ALERT_AT, visaAlerts } from "./visa-requirements";
import { visaCodesOf } from "./visa-fill";

test("a group file's save asks only for the itinerary's missing destination, never the standing territory list; it then rides the quarterly review", async () => {
  const { state, store } = fakeStore();
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (url.includes("passport-index-dataset")) return new Response(bigCsv(), { status: 200 });
    calls.push(url);
    return new Response(oriznBody("visa_free", 30), { status: 200, headers: { "x-ratelimit-remaining": "90" } });
  }) as unknown as typeof fetch;
  const t0 = new Date("2026-10-31T22:00:00.000Z");
  await refreshVisaRequirements(store, fetchImpl, t0); // the table, without a key
  assert.deepEqual(visaCodesOf({ embark_port: "Miami, Florida", itinerary: [{ port: "Miami, Florida" }, { port: "At sea" }, { port: "Grand Cayman" }, { port: "Nassau, Bahamas" }, { port: "Cozumel, Mexico" }] }).sort(), ["BS", "KY", "MX"]);
  const r = await refreshVisaRequirements(store, fetchImpl, t0, "US", { oriznKey: "k-123", wanted: ["BS", "KY", "MX"], territories: false, maxOrizn: 10 });
  assert.equal(r.orizn.fetched, 2, "Cayman and Mexico (which this fake dataset lacks), nothing else");
  assert.ok(calls.every((u) => u.includes("destination=CYM") || u.includes("destination=MEX")), calls.join(" "));
  assert.ok(!state.some((x) => x.destination_iso2 === "SX"), "the territory list was not touched");
  const ky = state.find((x) => x.destination_iso2 === "KY")!;
  assert.equal(ky.next_check_at, "2027-01-29T22:00:00.000Z", "due again with the quarterly review");
  const again = await refreshVisaRequirements(store, fetchImpl, new Date("2026-12-01T22:00:00.000Z"), "US", { oriznKey: "k-123", wanted: ["KY"], territories: false });
  assert.equal(again.orizn.fetched, 0, "the row exists and is not due: no request");
  const review = await refreshVisaRequirements(store, fetchImpl, new Date("2027-01-30T22:00:00.000Z"), "US", { oriznKey: "k-123", wanted: ["KY"], territories: false });
  assert.equal(review.orizn.fetched, 1, "at the review the Orizn row is asked for again");
  assert.equal(review.due, true, "and the dataset is read again, free");
});

test("the alerts: at the threshold of Orizn destinations, on requirements that moved, and on a review paused by the quota; none otherwise", () => {
  const base = { due: false, rows: 218, loaded: 0, changed: 0, next_check_at: "2027-01-29T22:00:00.000Z", orizn: { fetched: 0, missing: [], note: "", remaining: 79 }, changes: [], oriznRows: 20 };
  assert.deepEqual(visaAlerts(base), []);
  const many = visaAlerts({ ...base, oriznRows: VISA_ALERT_AT }, new Date("2027-03-01T10:00:00.000Z"));
  assert.equal(many.length, 1);
  assert.equal(many[0]!.source_ref, "visa-orizn-180");
  assert.match(many[0]!.title, /180 destinations now come from Orizn/);
  assert.match(many[0]!.body, /about 2 months of quota/);
  const moved = visaAlerts({ ...base, changes: [{ code: "FR", name: "France", from: "visa-free", to: "eta" }, { code: "IT", name: "Italy", from: "visa-free", to: "eta" }] }, new Date("2027-01-30T22:00:00.000Z"));
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.source_ref, "visa-change-2027-01-30");
  assert.equal(moved[0]!.title, "Visa requirements changed for 2 destinations");
  assert.match(moved[0]!.body, /^France \(FR\): visa-free → eta; Italy \(IT\): visa-free → eta\./);
  const paused = visaAlerts({ ...base, orizn: { fetched: 1, missing: ["SX", "CW"], note: "stopped: 5 requests left on the month's quota (5 kept in reserve)", remaining: 5 } }, new Date("2027-02-10T22:00:00.000Z"));
  assert.equal(paused.length, 1);
  assert.equal(paused[0]!.source_ref, "visa-quota-2027-02");
  assert.match(paused[0]!.title, /paused.*2 destinations still to fill/);
});

test("a review that moves a requirement is reported as a change, from either source", async () => {
  const { store } = fakeStore();
  let bahamas = "240";
  const fetchImpl = (async (url: string) => {
    if (url.includes("passport-index-dataset")) return new Response(bigCsv(bahamas), { status: 200 });
    return new Response(oriznBody(url.includes("destination=CYM") ? "eta" : "visa_free", 30), { status: 200, headers: { "x-ratelimit-remaining": "90" } });
  }) as unknown as typeof fetch;
  const first = await refreshVisaRequirements(store, fetchImpl, new Date("2026-10-31T22:00:00.000Z"), "US", { oriznKey: "k-123", wanted: ["KY"], territories: false });
  assert.deepEqual(first.changes, [], "the first load moves nothing");
  assert.equal(first.oriznRows, 1);
  bahamas = "eta";
  const review = await refreshVisaRequirements(store, fetchImpl, new Date("2027-01-30T22:00:00.000Z"), "US", { oriznKey: "k-123", wanted: ["KY"], territories: false });
  assert.deepEqual(review.changes, [{ code: "BS", name: "Bahamas", from: "visa-free", to: "eta" }], "the dataset's change is reported; Cayman's answer did not move");
});
