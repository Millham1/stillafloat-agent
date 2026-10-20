// group-marketing.test.ts (routes) — the real group-marketing router runs against a small stand-in for the database (an http server that
// answers the few PostgREST reads the routes make), so no request here can reach Supabase, an AI box or an email.
// What is tested is the page's `look` block (Mark 2026-10-20: every group page looks like the approved marketing): only validated picture links,
// a real boolean and the welcome's signature leave the server, whatever the interview holds; and the dashboard's interview list carries the look
// questions. Also what the public answer is made of (Mark 2026-10-20, "we already had this discussion"): the welcome and the Count me in words, never
// the poster's headline or pitch; the cabin categories and their prices without any count; getting-there lines without a vendor and with the price unit.

import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import express, { type Router } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const TOKEN = "test-agent-token";
const CODE = "bcdfghjkmn";            // a well-formed share code (no look-alike letters)
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const SUPABASE_HOST = "https://abcd1234efgh.supabase.co";
const realFetch = globalThis.fetch;

let router: Router;
let stub: Server;
/** The interview answers the stand-in group holds; each test sets what it needs. */
let marketing: Record<string, unknown> = {};
let status = "marketing";
let approved: string | null = "2026-10-20T12:00:00Z";
const patches: unknown[] = [];
/** What the stand-in holds in the group's cabin and travel tables (each test sets what it needs). */
let cabinRows: Array<Record<string, unknown>> = [];
/** When set, the copy the stand-in group holds (to serve copy written before the welcome existed). */
let copyOverride: Record<string, unknown> | null = null;
let travelRows: Array<Record<string, unknown>> = [];

function groupRow() {
  return {
    id: GROUP_ID, share_code: CODE, name: "Post 12 Cruise", status, lang: "both", marketing_approved_at: approved,
    cruise_line: "CARNIVAL CRUISE LINE", ship_name: "CARNIVAL CELEBRATION", ship_slug: "carnival-celebration",
    sail_date: "2027-03-14", return_date: "2027-03-21", nights: 7, embark_port: "Miami, Florida",
    deposit_due: "2026-11-01", recall_date: "2026-10-15", final_payment_due: "2026-12-14", amenities: ["Private cocktail party"],
    itinerary: [
      { day: 1, date: "2027-03-14", port: "Miami, Florida", arrive: null, depart: "16:00" },
      { day: 2, date: "2027-03-15", port: "At Sea", arrive: null, depart: null },
      { day: 3, date: "2027-03-16", port: "Cozumel, Mexico", arrive: "08:00", depart: "17:00" },
    ],
    marketing,
    marketing_copy: copyOverride ?? {
      en: { welcome: "We put this week together for the Post and we would love to sail it with you…", headline: "Post 12 goes to sea", subhead: "Seven nights out of Miami.", intro: "A week at sea.", why_ship: "Big enough.", who_for: "First-timers.", organizer_note: null, cta_label: "Tell Mark you're interested", cta_blurb: "Tap here to book your spot!", email_subject: "s", email_body: "b", social_post: "p" },
      es: { welcome: "Armamos esta semana para el Post y nos encantaría navegarla con usted…", headline: "Post 12 sale al mar", subhead: "Siete noches desde Miami.", intro: "Una semana en el mar.", why_ship: "Grande.", who_for: "Primerizos.", organizer_note: null, cta_label: "Cuéntele a Mark", cta_blurb: "¡Toque aquí para reservar su lugar!", email_subject: "s", email_body: "b", social_post: "p" },
    },
  };
}

before(async () => {
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    let body: unknown = [];
    if (req.method === "GET" && table === "groups") {
      const wanted = url.searchParams.get("share_code") ?? `eq.${CODE}`;
      const id = url.searchParams.get("id");
      body = (id ? id === `eq.${GROUP_ID}` : wanted === `eq.${CODE}`) ? [groupRow()] : [];
    } else if (req.method === "GET" && table === "group_cabins") {
      body = cabinRows;
    } else if (req.method === "GET" && table === "group_travel") {
      body = travelRows;
    } else if (req.method === "PATCH" && table === "groups") {
      patches.push(url.search);
      body = [{ id: GROUP_ID }];
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const { port } = stub.address() as AddressInfo;
  // The database address is read when persistence.ts loads: set before the router is imported.
  process.env["SUPABASE_URL"] = `http://127.0.0.1:${port}`;
  process.env["SUPABASE_SERVICE_KEY"] = "test-service-key";
  process.env["AGENT_APPROVAL_TOKEN"] = TOKEN;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`group-marketing routes test: unexpected network call to ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  router = (await import("./group-marketing")).default;
  // From here on the picture rule sees the real kind of address (https), as it does on the boxes.
  process.env["SUPABASE_URL"] = SUPABASE_HOST;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

type Res = { status: number; json: Record<string, any>; text: string };
async function call(method: string, path: string, o: { body?: unknown; token?: boolean } = {}): Promise<Res> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {} }; next(); });
  app.use("/api", router);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(o.token ? { "x-affiliate-token": TOKEN } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const pageOf = (lang: "en" | "es" = "en") => call("GET", `/group-page/${CODE}?lang=${lang}`);
const NO_LOOK = { heroUrl: null, hostPhotoUrl: null, taxesIncluded: false, hostNames: "Mark", label: null };

test("a group that says nothing about its look gets a look block of nulls and false: the page is unchanged", async () => {
  marketing = { pitch: "Come along.", audience: "a", occasion: "b", why_sailing: "c" };
  const r = await pageOf();
  assert.equal(r.status, 200);
  assert.equal(r.json["success"], true);
  assert.deepEqual(r.json["look"], NO_LOOK);
  // the rest of the answer is what it was: facts, copy and the form's security key
  assert.ok(r.json["facts"] && r.json["copy"] && "turnstileSiteKey" in r.json);
  assert.equal(r.json["copy"].cta_label, "Tell Mark you're interested");
});

test("valid links on our own hosts and a yes to taxes come through, in English and in Spanish", async () => {
  const hero = "https://stillafloatcruising.com/assets/images/group-hero.jpg";
  const host = `${SUPABASE_HOST}/storage/v1/object/public/group-assets/g1/hosts.jpg`;
  marketing = { pitch: "Come along.", hero_photo: hero, host_photo: host, taxes_included: true };
  for (const lang of ["en", "es"] as const) {
    const r = await pageOf(lang);
    assert.equal(r.status, 200, lang);
    assert.deepEqual(r.json["look"], { heroUrl: hero, hostPhotoUrl: host, taxesIncluded: true, hostNames: "Mark", label: null }, lang);
  }
});

test("a link that is not https on our own hosts is null; one bad link does not cost the other", async () => {
  const good = "https://stillafloatcruising.com/assets/images/hosts.png";
  const refused = [
    "http://stillafloatcruising.com/a.jpg", "https://example.com/a.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA",
    'https://stillafloatcruising.com/a.jpg");background:url(//evil.example/x', "https://stillafloatcruising.com/a(1).jpg", "https://stillafloatcruising.com/a'b.jpg",
    "https://user:pw@stillafloatcruising.com/a.jpg", "https://other-project.supabase.co/storage/v1/object/public/x/y.jpg", `${SUPABASE_HOST}/rest/v1/groups`,
  ];
  for (const bad of refused) {
    marketing = { pitch: "Come along.", hero_photo: bad, host_photo: good, taxes_included: false };
    const r = await pageOf();
    assert.equal(r.status, 200, bad);
    assert.deepEqual(r.json["look"], { heroUrl: null, hostPhotoUrl: good, taxesIncluded: false, hostNames: "Mark", label: null }, bad);
    // what was refused is not echoed anywhere in the answer
    assert.ok(!r.text.includes(bad), `the refused link is in the page's answer: ${bad}`);
    marketing = { pitch: "Come along.", hero_photo: good, host_photo: bad };
    assert.deepEqual((await pageOf()).json["look"], { heroUrl: good, hostPhotoUrl: null, taxesIncluded: false, hostNames: "Mark", label: null }, bad);
  }
});

test("taxes_included is a boolean on the page whatever the interview holds", async () => {
  for (const [held, shown] of [[true, true], [false, false], ["true", false], ["yes", false], [1, false], [null, false], [undefined, false]] as const) {
    marketing = { pitch: "Come along.", taxes_included: held };
    const r = await pageOf();
    assert.equal(r.json["look"].taxesIncluded, shown, JSON.stringify(held));
    assert.equal(typeof r.json["look"].taxesIncluded, "boolean");
  }
});

test("the look block holds exactly five names, and the raw answers are not in the public answer", async () => {
  marketing = { pitch: "Come along.", hero_photo: "https://stillafloatcruising.com/a.jpg", host_photo: "https://stillafloatcruising.com/b.jpg", taxes_included: true, cta_line: "Join the fun!", reference: "a private note" };
  const r = await pageOf();
  assert.deepEqual(Object.keys(r.json["look"]).sort(), ["heroUrl", "hostNames", "hostPhotoUrl", "label", "taxesIncluded"]);
  for (const k of ["hero_photo", "host_photo", "taxes_included", "host_names", "page_label", "reference", "pitch"]) {
    assert.ok(!(k in r.json["facts"]) && !(k in r.json["look"]) && !(k in r.json), `${k} leaks into the public answer`);
  }
  assert.ok(!r.text.includes("a private note"));
});

test("an unapproved page is still hidden, look or no look", async () => {
  marketing = { pitch: "Come along.", hero_photo: "https://stillafloatcruising.com/a.jpg" };
  const was = approved; approved = null;
  try {
    const r = await pageOf();
    assert.equal(r.status, 404);
    assert.ok(!r.text.includes("stillafloatcruising.com/a.jpg"));
  } finally { approved = was; }
});

test("the dashboard's interview list carries the three look questions after the call to action", async () => {
  marketing = { pitch: "Come along." };
  const r = await call("GET", `/groups/${GROUP_ID}/marketing`, { token: true });
  assert.equal(r.status, 200);
  const keys = (r.json["interview"] as Array<{ key: string }>).map((q) => q.key);
  const i = keys.indexOf("cta_line");
  assert.deepEqual(keys.slice(i + 1, i + 5), ["taxes_included", "hero_photo", "host_photo", "host_names"]);
  const byKey = Object.fromEntries((r.json["interview"] as Array<{ key: string; type: string; label: string; required?: boolean }>).map((q) => [q.key, q]));
  assert.equal(byKey["taxes_included"].type, "yesno");
  assert.equal(byKey["hero_photo"].type, "text");
  assert.equal(byKey["host_photo"].type, "text");
  assert.equal(byKey["host_names"].type, "text");
  assert.equal(byKey["host_names"].label, "Who is the invitation from? (e.g. Mark & Ceci)");
  for (const k of ["taxes_included", "hero_photo", "host_photo", "host_names"]) assert.notEqual(byKey[k].required, true);
  // the answers the screen starts from carry them too (so the form shows what is saved)
  assert.equal(r.json["answers"].taxes_included, false);
  assert.equal(r.json["answers"].hero_photo, "");
  assert.equal(r.json["answers"].host_photo, "");
  assert.equal(r.json["answers"].host_names, "");
  // the dashboard's copy editor is told about the welcome field, first, optional, at most 420 characters
  const fields = r.json["copyFields"] as Array<{ key: string; max: number; optional?: boolean }>;
  assert.deepEqual([fields[0]!.key, fields[0]!.max, fields[0]!.optional], ["welcome", 420, true]);
});

test("saving the interview keeps the look answers and says which picture link will not be shown", async () => {
  patches.length = 0;
  const ok = await call("PUT", `/groups/${GROUP_ID}/marketing/answers`, { token: true, body: { pitch: "Come along.", hero_photo: " https://stillafloatcruising.com/a.jpg ", host_photo: "https://stillafloatcruising.com/b.jpg", taxes_included: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json["answers"].hero_photo, "https://stillafloatcruising.com/a.jpg");
  assert.equal(ok.json["answers"].taxes_included, true);
  assert.deepEqual(ok.json["ignored"], []);
  const bad = await call("PUT", `/groups/${GROUP_ID}/marketing/answers`, { token: true, body: { pitch: "Come along.", hero_photo: "https://drive.google.com/file/d/abc/view", host_photo: "https://stillafloatcruising.com/b.jpg" } });
  assert.equal(bad.status, 200);
  assert.deepEqual(bad.json["ignored"], ["hero_photo"], "the link is kept in the interview but flagged: the page will not show it");
  assert.equal(bad.json["answers"].hero_photo, "https://drive.google.com/file/d/abc/view");
  assert.equal(patches.length, 2, "both saves reached the database");
  // the token gate is unchanged
  assert.equal((await call("PUT", `/groups/${GROUP_ID}/marketing/answers`, { body: { pitch: "x" } })).status, 401);
});


// ── What the public answer is made of (Mark 2026-10-20: "we already had this discussion") ───────────────────────────────

test("the public answer carries the welcome and the Count me in words, never the poster's headline, payoff, intro, why-ship or who-for; the signature is the interview's names", async () => {
  marketing = { pitch: "Come along.", host_names: "Mark & Ceci" };
  for (const lang of ["en", "es"] as const) {
    const r = await pageOf(lang);
    assert.equal(r.status, 200, lang);
    assert.deepEqual(Object.keys(r.json["copy"]).sort(), ["cta_blurb", "cta_label", "organizer_note", "welcome"], lang);
    assert.equal(r.json["copy"].welcome, lang === "es" ? "Armamos esta semana para el Post y nos encantaría navegarla con usted…" : "We put this week together for the Post and we would love to sail it with you…");
    for (const poster of ["Post 12 goes to sea", "Post 12 sale al mar", "Seven nights out of Miami.", "Siete noches desde Miami.", "A week at sea.", "Una semana en el mar.", "Big enough.", "Grande.", "First-timers.", "Primerizos."]) {
      assert.ok(!r.text.includes(poster), `${lang}: the poster's words "${poster}" are in the page's answer`);
    }
    assert.equal(r.json["look"].hostNames, "Mark & Ceci");
  }
});

test("a group whose copy has no welcome (written before it existed) is still served, with a null welcome, in both languages", async () => {
  const { welcome: _en, ...oldEn } = groupRow().marketing_copy.en as Record<string, unknown>;
  const { welcome: _es, ...oldEs } = groupRow().marketing_copy.es as Record<string, unknown>;
  assert.ok(_en && _es);
  copyOverride = { en: oldEn, es: oldEs };
  try {
    marketing = { pitch: "Come along." };
    for (const lang of ["en", "es"] as const) {
      const r = await pageOf(lang);
      assert.equal(r.status, 200, lang);
      assert.equal(r.json["copy"].welcome, null, lang);
      assert.ok(r.json["copy"].cta_label, lang);
    }
    // the dashboard is told, gently, that there is no welcome yet
    const dash = await call("GET", `/groups/${GROUP_ID}/marketing`, { token: true });
    assert.deepEqual(dash.json["perLang"]["en"].problems, [], "no problem: an old approved page stays approved");
    assert.ok((dash.json["perLang"]["en"].notes as Array<{ field: string }>).some((n) => n.field === "welcome"));
  } finally { copyOverride = null; }
});

test("your cabin: the public answer lists each category with its from-price and no count, code, deposit or availability; prices off lists none", async () => {
  cabinRows = [
    { id: "c1", status: "held", category: "BALCONY", category_code: "8C", price_total: 2498, deposit_amount: 500 },
    { id: "c2", status: "held", category: "BALCONY", category_code: "8C", price_total: 2498, deposit_amount: 500 },
    { id: "c3", status: "held", category: "INTERIOR", category_code: "4B", price_total: 1698, deposit_amount: 500 },
    { id: "c4", status: "booked", category: "SUITE", category_code: "S1", price_total: 6000, deposit_amount: 500 },
  ];
  try {
    marketing = { pitch: "Come along." };
    const r = await pageOf();
    assert.deepEqual(r.json["facts"].cabinPrices, [{ category: "Interior", perPersonText: "$849" }, { category: "Balcony", perPersonText: "$1,249" }]);
    for (const k of ["cabins", "cabinsAvailable", "cabinsTotal"]) assert.ok(!(k in r.json["facts"]), `${k} leaked`);
    for (const leak of ["8C", "4B", "S1", "$250", "$500", "available"]) assert.ok(!r.text.includes(leak), `${leak} is in the public answer`);
    assert.equal(r.json["facts"].fromPerPersonText, "$849");
    marketing = { pitch: "Come along.", show_prices: false };
    const off = await pageOf();
    assert.deepEqual(off.json["facts"].cabinPrices, []);
    assert.equal(off.json["facts"].fromPerPersonText, null);
  } finally { cabinRows = []; }
});

test("getting there: the public answer words each line without the vendor, a hotel per room and the rest per person, in both languages", async () => {
  travelRows = [
    { id: "t1", kind: "flight", direction: "pre", provider: "American Airlines", from_place: "Raleigh-Durham", price_per_person: 350, price_unit: "person", included: false, traveler_id: null, cabin_id: null },
    { id: "t2", kind: "hotel", direction: "pre", provider: "Marriott Courtyard", from_place: "Miami", reference: "1 night", price_per_person: 125, price_unit: "room", included: false, traveler_id: null, cabin_id: null },
    { id: "t3", kind: "transfer", direction: "pre", provider: "Limopedia", from_place: "Hotel", to_place: "Cruise port", price_per_person: 45, price_unit: "person", included: false, traveler_id: null, cabin_id: null },
  ];
  try {
    marketing = { pitch: "Come along." };
    const en = await pageOf("en");
    assert.deepEqual((en.json["facts"].travel as Array<{ text: string }>).map((t) => t.text), [
      "Flight from Raleigh-Durham: $350 per person", "Hotel the night before in Miami (1 night): $125 per room", "Hotel to Cruise port: $45 per person"]);
    const es = await pageOf("es");
    assert.deepEqual((es.json["facts"].travel as Array<{ text: string }>).map((t) => t.text), [
      "Vuelo desde Raleigh-Durham: $350 por persona", "Hotel la noche anterior en Miami (1 noche): $125 por habitación", "Hotel a puerto de cruceros: $45 por persona"]);
    for (const r of [en, es]) for (const vendor of ["American", "Airlines", "Marriott", "Courtyard", "Limopedia"]) assert.ok(!r.text.includes(vendor), `${vendor} is in the public answer`);
    // the dashboard's marketing view is vendor-free too (it is what the copy writer and the poster read)
    const dash = await call("GET", `/groups/${GROUP_ID}/marketing`, { token: true });
    for (const vendor of ["American", "Marriott", "Limopedia"]) assert.ok(!JSON.stringify(dash.json["perLang"]["en"].facts.travel).includes(vendor), `${vendor} is in the dashboard's facts`);
  } finally { travelRows = []; }
});

test("saving copy whose intro lacks Mark's pitch sentences does not take an approved page down: that rule is a note now", async () => {
  marketing = { pitch: "Come along and see the Bahamas with us. Bring the whole family." };
  const copy = groupRow().marketing_copy.en;
  const r = await call("PUT", `/groups/${GROUP_ID}/marketing/copy`, { token: true, body: { lang: "en", copy } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json["problems"], [], "no problem, so the approval stays");
  assert.equal(r.json["approvedAt"], "2026-10-20T12:00:00Z");
  assert.ok((r.json["notes"] as Array<{ problem: string }>).some((n) => n.problem.startsWith("Pitch sentence not kept")), "but Mark is told");
  // a real problem still takes it down
  const bad = await call("PUT", `/groups/${GROUP_ID}/marketing/copy`, { token: true, body: { lang: "en", copy: { ...copy, welcome: "Scan the QR code to book" } } });
  assert.ok((bad.json["problems"] as Array<{ field: string }>).some((p) => p.field === "welcome"));
  assert.equal(bad.json["approvedAt"], null);
});
