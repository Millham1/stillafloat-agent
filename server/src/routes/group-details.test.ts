// group-details.test.ts (routes) — the guest's own "Your details" page API, the Count me in answer that hands out its links, and the dashboard's
// "add these travelers to a cabin" (Mark 2026-10-23). The real routers run against a small in-memory stand-in for the database (an http server that
// answers the PostgREST reads and writes the routes make) and for the mail sender, so nothing here can reach Supabase, an inbox or Mark's phone.

import { test, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import express, { type Router } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hashLinkToken } from "../lib/group-secure";

const TOKEN = "test-agent-token";
const CODE = "bcdfghjkmn";
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const CABIN_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CABIN = "33333333-3333-4333-8333-333333333333";
const REPLY_ID = "44444444-4444-4444-8444-444444444444";
const LINK = "L".repeat(43);              // a well-formed link token
const realFetch = globalThis.fetch;
const DAY = 86_400_000;

type Row = Record<string, any>;
let marketingRouter: Router, detailsRouter: Router;
let stub: Server;
let tables: Record<string, Row[]> = {};
let log: Array<{ method: string; table: string; query: string; body: any }> = [];
let mails: Array<Record<string, any>> = [];
let mailOk = true;
/** The stand-in's `actions` table refuses inserts (a made item would push Mark's phone); set to true to let one through. */
let actionsAccept = false;
/** When true the stand-in refuses to write the details link (migration 0056 not applied). */
let tokenWriteFails = false;
/** When true the stand-in refuses the group_assets read (the page must still be served). */
let assetsFail = false;
let seq = 0;

function group(over: Row = {}): Row {
  return {
    id: GROUP_ID, share_code: CODE, name: "Millham F/F 2027", status: "marketing", lang: "both", marketing_approved_at: "2026-10-20T12:00:00Z",
    cruise_line: "MSC CRUISES", ship_name: "MSC SEASHORE", ship_slug: "msc-seashore", sail_date: "2027-05-09", return_date: "2027-05-13", nights: 4,
    embark_port: "Port Canaveral, Florida", deposit_per_person: 50, deposit_due: "2026-12-01", final_payment_due: "2027-01-15", amenities: [],
    itinerary: [
      { day: 1, date: "2027-05-09", port: "Port Canaveral, Florida", arrive: null, depart: "16:00" },
      { day: 2, date: "2027-05-10", port: "Nassau, Bahamas", arrive: "09:00", depart: "18:00" },
      { day: 3, date: "2027-05-11", port: "Ocean Cay MSC Marine Reserve, Bahamas", arrive: "08:00", depart: null },
      { day: 4, date: "2027-05-13", port: "Port Canaveral, Florida", arrive: "07:00", depart: null },
    ],
    marketing: { taxes_included: true, host_names: "Mark & Ceci", page_label: "Friends and Family 2027", hero_photo: "https://stillafloatcruising.com/assets/images/hero.jpg" },
    marketing_copy: {
      en: { welcome: "w", headline: "h", subhead: "s", intro: "i", why_ship: "y", who_for: "f", organizer_note: null, cta_label: "Count me in!", cta_blurb: "Questions? Call or text Mark at 919-346-6127.", email_subject: "s", email_body: "b", social_post: "p" },
      es: { welcome: "w", headline: "h", subhead: "s", intro: "i", why_ship: "y", who_for: "f", organizer_note: null, cta_label: "¡Cuenten conmigo!", cta_blurb: "¿Preguntas? Llame o escriba a Mark al 919-346-6127.", email_subject: "s", email_body: "b", social_post: "p" },
    },
    ...over,
  };
}
const cabinRows = (): Row[] => [
  { id: CABIN_ID, group_id: GROUP_ID, status: "held", category: "Balcony Bella", category_code: "BEL", price_total: 1073.58, deposit_amount: 100, cabin_num: null },
  { id: "c-2", group_id: GROUP_ID, status: "held", category: "Balcony Aurea", category_code: "AUR", price_total: 1373.58, deposit_amount: 100, cabin_num: null },
  { id: OTHER_CABIN, group_id: "99999999-9999-4999-8999-999999999999", status: "held", category: "Elsewhere", category_code: "X", price_total: 1, deposit_amount: 1, cabin_num: null },
];
function reply(over: Row = {}): Row {
  return {
    id: REPLY_ID, group_id: GROUP_ID, first_name: "Mark", last_name: "Millham", email: "mmillham1@gmail.com", phone: null, lang: "en", guests: 2, note: null, status: "new",
    ip_hash: "iphash-secret", prospect_id: "prospect-secret", traveler_id: null, details_token_hash: hashLinkToken(LINK), details_token_issued_at: new Date().toISOString(),
    choice: null, choice_at: null, travelers: null, concierge: null, pick: null, hold_requested_at: null, ack_email_status: null, ack_email_at: null,
    ...over,
  };
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
    const cell = row[k];
    if (v === "is.null") { if (cell !== null && cell !== undefined) return false; continue; }
    if (v.startsWith("eq.")) { if (String(cell ?? "") !== v.slice(3)) return false; continue; }
    if (v.startsWith("neq.")) { if (String(cell ?? "") === v.slice(4)) return false; continue; }
    if (v.startsWith("in.(")) { if (!v.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, "")).includes(String(cell ?? ""))) return false; continue; }
    throw new Error(`the stand-in does not understand ${k}=${v}`);
  }
  return true;
}

before(async () => {
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const send = (status: number, body?: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(body === undefined ? "" : JSON.stringify(body)); };
      const json = raw ? JSON.parse(raw) : undefined;
      if (url.pathname === "/send-email") { mails.push(json); return mailOk ? send(200, { ok: true }) : send(500, { error: "mail sender down" }); }
      const table = url.pathname.replace(/^\/rest\/v1\//, "");
      log.push({ method: req.method ?? "", table, query: url.search, body: json });
      const rows = (tables[table] ??= []);
      const wantsRows = /return=representation/.test(String(req.headers["prefer"] ?? ""));
      const object = /pgrst\.object\+json/.test(String(req.headers["accept"] ?? ""));
      // select=a,b,c returns only those columns, as PostgREST does (a route that asks for fewer must not be handed more)
      const sel = (url.searchParams.get("select") ?? "*").trim();
      const project = (r: Row): Row => (sel === "*" ? r : Object.fromEntries(sel.split(",").map((c) => c.trim()).filter((c) => c in r).map((c) => [c, r[c]])));
      const out = (list: Row[]) => (object ? send(200, list[0] ? project(list[0]) : null) : send(200, list.map(project)));
      if (req.method === "GET" && table === "group_assets" && assetsFail) return send(500, { message: "stand-in refuses the read" });
      if (req.method === "GET") return out(rows.filter((r) => matches(r, url.searchParams)));
      if (req.method === "POST") {
        if (table === "actions" && !actionsAccept) return send(400, { message: "stand-in: actions refuse inserts" });
        const made = (Array.isArray(json) ? json : [json]).map((r: Row) => ({ id: r["id"] ?? `${table}-${++seq}`, ...r }));
        rows.push(...made);
        return wantsRows ? (object ? send(201, project(made[0])) : send(201, made.map(project))) : send(201);
      }
      if (req.method === "PATCH") {
        if (table === "group_interests" && tokenWriteFails && json && "details_token_hash" in json) return send(400, { message: 'column "details_token_hash" does not exist' });
        const hit = rows.filter((r) => matches(r, url.searchParams));
        for (const r of hit) Object.assign(r, json);
        return wantsRows ? out(hit) : send(204);
      }
      return send(405, {});
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const { port } = stub.address() as AddressInfo;
  process.env["SUPABASE_URL"] = `http://127.0.0.1:${port}`;
  process.env["SUPABASE_SERVICE_KEY"] = "test-service-key";
  process.env["AGENT_APPROVAL_TOKEN"] = TOKEN;
  process.env["OPS_MANAGER_URL"] = `http://127.0.0.1:${port}`;
  process.env["IDEAS_API_KEY"] = "test-ideas-key";
  process.env["PUBLIC_URL"] = "https://dev.example.test";
  process.env["DISABLE_NOTIFY_EMAIL"] = "1";
  delete process.env["GROUP_FORMS_MAIL_ALLOW"];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`group-details routes test: unexpected network call to ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  marketingRouter = (await import("./group-marketing")).default;
  detailsRouter = (await import("./group-details")).default;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

beforeEach(() => {
  tables = { groups: [group()], group_cabins: cabinRows(), group_interests: [reply()], group_travelers: [], actions: [], group_messages: [], prospects: [], group_assets: [] };
  log = []; mails = []; mailOk = true; actionsAccept = false; tokenWriteFails = false; assetsFail = false;
  delete process.env["GROUP_FORMS_MAIL_ALLOW"];
});

type Res = { status: number; json: Record<string, any>; text: string; headers: Headers };
let visitor = 0;
async function call(method: string, path: string, o: { body?: unknown; token?: boolean; ip?: string } = {}): Promise<Res> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {} }; next(); });
  app.use("/api", marketingRouter);
  app.use("/api", detailsRouter);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { "content-type": "application/json", "x-forwarded-for": o.ip ?? `203.0.113.${(++visitor % 250) + 1}`, ...(o.token ? { "x-affiliate-token": TOKEN } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const wait = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); };
const replyRow = () => tables["group_interests"]!.find((r) => r["id"] === REPLY_ID)!;
const writes = (table: string) => log.filter((l) => l.table === table && l.method !== "GET");
const GOOD = { travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }], concierge: { room: "balcony", priority: "quiet", budget: "middle", motion: "yes" } };
const WHY = "Steady for whoever feels the motion, quiet away from the pool deck, and a balcony for that coffee. From $536.79 per person, taxes and port fees included.";

// ── GET: what the link opens ──────────────────────────────────────────────────

test("a good link answers with what we know, what they entered, and the group's cabin categories; private headers, nothing internal", async () => {
  const r = await call("GET", `/group-details/${LINK}`);
  assert.equal(r.status, 200);
  assert.equal(r.json["success"], true);
  assert.deepEqual(
    { label: r.json["label"], ship: r.json["ship"], sail: r.json["sailDateText"], back: r.json["returnDateText"], first: r.json["firstName"], last: r.json["lastName"], email: r.json["email"], phone: r.json["phone"], guests: r.json["guests"], lang: r.json["lang"] },
    { label: "Friends and Family 2027", ship: "MSC Seashore", sail: "May 9, 2027", back: "May 13, 2027", first: "Mark", last: "Millham", email: "mmillham1@gmail.com", phone: null, guests: 2, lang: "en" },
  );
  assert.deepEqual(r.json["held"], [{ category: "Balcony Bella", perPersonText: "$536.79" }, { category: "Balcony Aurea", perPersonText: "$686.79" }]);
  assert.deepEqual([r.json["taxesIncluded"], r.json["depositPerPersonText"], r.json["phoneLine"], r.json["heroUrl"]], [true, "$50", "Questions? Call or text Mark at 919-346-6127.", "https://stillafloatcruising.com/assets/images/hero.jpg"]);
  assert.deepEqual([r.json["travelers"], r.json["concierge"], r.json["pick"], r.json["choice"], r.json["holdRequestedAt"]], [[], null, null, null, null]);
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.match(r.headers.get("referrer-policy") ?? "", /no-referrer/);
  // nothing internal: no hash, no audit hash, no ids, no other replies, no cabin the group still has
  for (const secret of [hashLinkToken(LINK), "iphash-secret", "prospect-secret", GROUP_ID, REPLY_ID, CABIN_ID, "details_token", "cabinsAvailable"]) assert.ok(!r.text.includes(secret), `the answer carries ${secret}`);
});

test("the top picture's credit line comes with the answer (a CC BY photo is credited where it is shown); a failed read costs the line, never the page", async () => {
  const HERO = "https://stillafloatcruising.com/assets/images/hero.jpg";
  assert.deepEqual((await call("GET", `/group-details/${LINK}`)).json["credits"], [], "no credit row: no credit line");
  tables["group_assets"]!.push({ id: "a1", public_url: HERO, attribution: "Photo: Symbiosis · CC BY 2.0 · Wikimedia Commons" }, { id: "a2", public_url: "https://stillafloatcruising.com/other.jpg", attribution: "Photo: Someone Else · CC0 · Wikimedia Commons" });
  const r = await call("GET", `/group-details/${LINK}`);
  assert.deepEqual(r.json["credits"], ["Photo: Symbiosis · CC BY 2.0 · Wikimedia Commons"], "only the picture this page shows");
  assert.ok(!r.text.includes("Someone Else"));
  assetsFail = true;
  const down = await call("GET", `/group-details/${LINK}`);
  assert.equal(down.status, 200);
  assert.deepEqual(down.json["credits"], []);
  // a group with no top picture reads nothing
  assetsFail = false; tables["groups"]![0]!["marketing"] = { taxes_included: true };
  log = [];
  assert.deepEqual((await call("GET", `/group-details/${LINK}`)).json["credits"], []);
  assert.equal(log.filter((l) => l.table === "group_assets").length, 0);
});

test("a Spanish reply is answered in Spanish (dates and phone line), and stored answers come back so the page can fill itself", async () => {
  Object.assign(replyRow(), { lang: "es", ...GOOD, pick: { category: "Balcony Bella", where: "midship", why: "x" }, choice: "finish" });
  const r = await call("GET", `/group-details/${LINK}`);
  assert.equal(r.json["lang"], "es");
  assert.equal(r.json["sailDateText"], "9 de mayo de 2027");
  assert.equal(r.json["phoneLine"], "¿Preguntas? Llame o escriba a Mark al 919-346-6127.");
  assert.deepEqual(r.json["travelers"], GOOD.travelers);
  assert.deepEqual(r.json["concierge"], GOOD.concierge);
  assert.deepEqual(r.json["pick"], { category: "Balcony Bella", where: "midship", why: "x" });
  assert.equal(r.json["choice"], "finish");
});

test("every wrong link gets the same plain 404: malformed, unknown, older than 90 days, a spam reply, a group that is no longer taking replies", async () => {
  const bodies = new Set<string>();
  const check = async (token: string, why: string) => { const r = await call("GET", `/group-details/${token}`); assert.equal(r.status, 404, why); assert.deepEqual(r.json, { success: false, error: "Not found" }, why); bodies.add(r.text); };
  await check("not-a-token", "malformed");
  await check("A".repeat(43), "unknown");
  await check("L".repeat(42), "one character short");
  replyRow()["details_token_issued_at"] = new Date(Date.now() - 91 * DAY).toISOString();
  await check(LINK, "expired");
  replyRow()["details_token_issued_at"] = new Date(Date.now() - 89 * DAY).toISOString();
  assert.equal((await call("GET", `/group-details/${LINK}`)).status, 200, "89 days is still good");
  replyRow()["details_token_issued_at"] = null;
  await check(LINK, "no issue time");
  replyRow()["details_token_issued_at"] = new Date().toISOString();
  replyRow()["status"] = "spam";
  await check(LINK, "spam");
  replyRow()["status"] = "new";
  for (const status of ["cancelled", "closed", "sailed", "draft"]) { tables["groups"]![0]!["status"] = status; await check(LINK, `group ${status}`); }
  tables["groups"]![0]!["status"] = "booking";
  assert.equal((await call("GET", `/group-details/${LINK}`)).status, 200, "a group taking bookings is fine");
  assert.equal(bodies.size, 1, "different wrong links must get the identical answer");
});

test("guessing links is limited per address: after 40 wrong ones the answer is 429", async () => {
  const ip = "198.51.100.77";
  let last = 0;
  for (let i = 0; i < 45; i++) last = (await call("GET", `/group-details/${"B".repeat(43)}`, { ip })).status;
  assert.equal(last, 429);
  assert.equal((await call("GET", `/group-details/${LINK}`, { ip })).status, 200, "a right link still opens for the same address");
});

// ── POST: the choice ──────────────────────────────────────────────────────────

test("'Mark, call me': the reply is marked, and the guest's item on Mark's list says they want a call (one person, one item)", async () => {
  tables["actions"]!.push({ id: "a-1", type: "lead", source_ref: `group-interest-${REPLY_ID}`, status: "pending", title: "Group reply: Mark Millham", body: "old" });
  const r = await call("POST", `/group-details/${LINK}/choice`, { body: { choice: "call" } });
  assert.deepEqual([r.status, r.json["success"]], [200, true]);
  assert.equal(replyRow()["choice"], "call");
  assert.ok(replyRow()["choice_at"]);
  assert.equal(tables["actions"]![0]!["title"], "Group reply: Mark Millham wants a call");
  assert.match(tables["actions"]![0]!["body"], /Millham F\/F 2027\. mmillham1@gmail\.com\. They chose "Mark, call me"/);
  assert.equal(writes("actions").filter((w) => w.method === "POST").length, 0, "no second item was made");
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
});

test("'Mark, call me' with no pending item (Mark already cleared it) makes a new lead item", async () => {
  const r = await call("POST", `/group-details/${LINK}/choice`, { body: { choice: "call" } });
  assert.equal(r.status, 200);
  await wait(() => writes("actions").some((w) => w.method === "POST"));
  const made = writes("actions").find((w) => w.method === "POST")!.body;
  assert.equal(made.title, "Group reply: Mark Millham wants a call");
  assert.equal(made.source_ref, `group-call-${REPLY_ID}`);
  assert.deepEqual(made.buttons, [{ label: "Open the group file", href: `/groups/${GROUP_ID}` }]);
});

test("any other choice is refused, a wrong link is a 404 first, and the bot trap changes nothing", async () => {
  for (const choice of ["finish", "hold", "", null, undefined, 1, ["call"], "CALL"]) {
    const r = await call("POST", `/group-details/${LINK}/choice`, { body: { choice } });
    assert.equal(r.status, 400, JSON.stringify(choice));
    assert.equal(r.json["error"], "Unknown choice.");
  }
  assert.equal((await call("POST", `/group-details/${"A".repeat(43)}/choice`, { body: { choice: "call" } })).status, 404);
  assert.equal((await call("POST", `/group-details/not-a-token/choice`, { body: { choice: "call" } })).status, 404);
  const bot = await call("POST", `/group-details/${LINK}/choice`, { body: { choice: "call", website: "http://spam.example" } });
  assert.deepEqual([bot.status, bot.json["success"]], [200, true], "the robot is told yes");
  assert.equal(replyRow()["choice"], null, "and nothing was stored");
  assert.equal(writes("actions").length + writes("group_interests").length, 0);
});

// ── POST: names, birthdays, the four answers ──────────────────────────────────

test("good details are saved with our pick; the guest's count replaces the party size; the pick is the design's example", async () => {
  const r = await call("POST", `/group-details/${LINK}`, { body: { ...GOOD, travelers: [...GOOD.travelers, { legal_name: "Pat Lee", dob: "1990-01-01" }] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json["pick"], { category: "Balcony Bella", where: "midship, a lower deck", why: WHY });
  const row = replyRow();
  assert.equal(row["travelers"].length, 3);
  assert.deepEqual(row["concierge"], GOOD.concierge);
  assert.deepEqual(row["pick"], r.json["pick"]);
  assert.equal(row["guests"], 3, "people change their minds: three came, so three is the party");
  assert.equal(row["hold_requested_at"], null, "saving is not holding");
  // a treat budget picks the higher category, and the answer follows the reply's language
  const t = await call("POST", `/group-details/${LINK}`, { body: { ...GOOD, concierge: { ...GOOD.concierge, budget: "treat" }, lang: "es" } });
  assert.equal(t.json["pick"]["category"], "Balcony Aurea");
  assert.match(t.json["pick"]["why"], /^Estable para quien sienta el movimiento/);
  assert.match(t.json["pick"]["why"], /Desde \$686\.79 por persona, con impuestos y cargos portuarios incluidos\.$/);
});

test("details that do not pass are refused in plain words with the field, and nothing is saved", async () => {
  const bad: Array<[Record<string, unknown>, RegExp, string]> = [
    [{ ...GOOD, travelers: [] }, /at least one traveler/, "travelers"],
    [{ ...GOOD, travelers: [{ legal_name: "<b>x</b>", dob: "1990-01-01" }] }, /Traveler 1: please type the name/, "travelers.0.legal_name"],
    [{ ...GOOD, travelers: [GOOD.travelers[0], { legal_name: "Ceci Millham", dob: "2999-01-01" }] }, /Traveler 2: that date of birth does not look right/, "travelers.1.dob"],
    [{ ...GOOD, travelers: [{ legal_name: "Mark Millham", dob: "" }] }, /Traveler 1: please add a date of birth/, "travelers.0.dob"],
    [{ ...GOOD, concierge: { ...GOOD.concierge, motion: "maybe" } }, /one answer for each of the four room questions/, "concierge.motion"],
    [{ travelers: GOOD.travelers }, /four room questions/, "concierge.room"],
    [{ ...GOOD, travelers: Array.from({ length: 13 }, () => GOOD.travelers[0]) }, /Up to 12 travelers/, "travelers"],
  ];
  for (const [body, error, field] of bad) {
    const r = await call("POST", `/group-details/${LINK}`, { body });
    assert.equal(r.status, 400, field);
    assert.match(r.json["error"], error, field);
    assert.equal(r.json["field"], field);
  }
  const es = await call("POST", `/group-details/${LINK}`, { body: { ...GOOD, travelers: [], lang: "es" } });
  assert.equal(es.json["error"], "Agregue al menos un viajero.");
  assert.equal(writes("group_interests").length, 0, "no refused form wrote anything");
  assert.equal(replyRow()["travelers"], null);
});

test("a wrong link or the bot trap saves nothing", async () => {
  assert.equal((await call("POST", `/group-details/${"A".repeat(43)}`, { body: GOOD })).status, 404);
  assert.equal((await call("POST", `/group-details/not-a-token`, { body: GOOD })).status, 404);
  const bot = await call("POST", `/group-details/${LINK}`, { body: { ...GOOD, website: "x" } });
  assert.deepEqual([bot.status, bot.json["success"], bot.json["pick"]], [200, true, undefined]);
  assert.equal(writes("group_interests").length, 0);
});

test("with the prices hidden the pick names the kind of cabin and quotes no price", async () => {
  tables["groups"]![0]!["marketing"] = { show_prices: false, taxes_included: true };
  const r = await call("POST", `/group-details/${LINK}`, { body: GOOD });
  assert.equal(r.status, 200);
  assert.equal(r.json["pick"]["category"], "Balcony");
  assert.ok(!/\$|From/.test(r.json["pick"]["why"]), r.json["pick"]["why"]);
  assert.deepEqual((await call("GET", `/group-details/${LINK}`)).json["held"], []);
});

// ── POST: Hold my cabin ───────────────────────────────────────────────────────

test("'Hold my cabin' needs the saved names and pick first", async () => {
  const r = await call("POST", `/group-details/${LINK}/hold`, { body: {} });
  assert.equal(r.status, 400);
  assert.match(r.json["error"], /finish the names and the four questions first/);
  assert.equal(replyRow()["hold_requested_at"], null);
  Object.assign(replyRow(), { lang: "es" });
  assert.equal((await call("POST", `/group-details/${LINK}/hold`, { body: {} })).json["error"], "Primero termine los nombres y las preguntas.");
  assert.equal((await call("POST", `/group-details/${"A".repeat(43)}/hold`, { body: {} })).status, 404);
  assert.equal((await call("POST", `/group-details/not-a-token/hold`, { body: {} })).status, 404);
});

test("'Hold my cabin' records the request, marks the choice, and tells Mark once: name, category, party size, and the button to the group file; nothing is booked", async () => {
  await call("POST", `/group-details/${LINK}`, { body: GOOD });
  const r = await call("POST", `/group-details/${LINK}/hold`, { body: {} });
  assert.deepEqual([r.status, r.json["success"]], [200, true]);
  const row = replyRow();
  assert.ok(row["hold_requested_at"]);
  assert.equal(row["choice"], "finish");
  await wait(() => writes("actions").some((w) => w.method === "POST"));
  const made = writes("actions").filter((w) => w.method === "POST");
  assert.equal(made.length, 1);
  assert.equal(made[0]!.body.title, "Hold requested: Mark Millham, Balcony Bella, party of 2");
  assert.deepEqual(made[0]!.body.buttons, [{ label: "Open the group file", href: `/groups/${GROUP_ID}` }]);
  assert.equal(made[0]!.body.source_ref, `group-hold-${REPLY_ID}`);
  // a second press (a double tap, a reload) changes nothing and makes no second item
  const again = await call("POST", `/group-details/${LINK}/hold`, { body: {} });
  assert.equal(again.json["success"], true);
  await new Promise((r2) => setTimeout(r2, 50));
  assert.equal(writes("actions").filter((w) => w.method === "POST").length, 1);
  // nothing in the group file moved: no cabin touched, no traveler made
  assert.equal(writes("group_cabins").length + writes("group_travelers").length, 0);
  // once held, a form change goes through Mark
  const late = await call("POST", `/group-details/${LINK}`, { body: GOOD });
  assert.equal(late.status, 409);
  assert.match(late.json["error"], /already on hold. To change anything, call or text Mark at 919-346-6127/);
  assert.equal((await call("GET", `/group-details/${LINK}`)).json["holdRequestedAt"], row["hold_requested_at"]);
});

test("when the hold's item is made, the guest's earlier 'Group reply' item is closed (one person, one item); when it is not, that item stays", async () => {
  await call("POST", `/group-details/${LINK}`, { body: GOOD });
  tables["actions"]!.push({ id: "a-1", type: "lead", source_ref: `group-interest-${REPLY_ID}`, status: "pending", title: "Group reply: Mark Millham" });
  await call("POST", `/group-details/${LINK}/hold`, { body: {} });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(tables["actions"]![0]!["status"], "pending", "the new item could not be made, so the old one is still there");

  tables["group_interests"] = [reply()];
  log = [];
  actionsAccept = true;
  await call("POST", `/group-details/${LINK}`, { body: GOOD });
  tables["actions"] = [{ id: "a-1", type: "lead", source_ref: `group-interest-${REPLY_ID}`, status: "pending", title: "Group reply: Mark Millham" }];
  await call("POST", `/group-details/${LINK}/hold`, { body: {} });
  await wait(() => tables["actions"]![0]!["status"] === "done");
  assert.equal(tables["actions"]![0]!["status"], "done");
  assert.equal(tables["actions"]!.length, 2, "the hold's own item exists");
});

// ── The Count me in answer ────────────────────────────────────────────────────

const INTEREST = (over: Row = {}) => ({ first_name: "Pat", last_name: "Lee", email: "pat@example.com", phone: "", guests: 2, newsletter_opt_in: false, website: "", lang: "en", ...over });
const interest = (body: Row, ip?: string) => call("POST", `/group-page/${CODE}/interest`, { body, ip });
const newest = () => tables["group_interests"]![tables["group_interests"]!.length - 1]!;

test("Count me in hands the guest their own two links, stores only the link's hash, and the email goes out with them", async () => {
  tables["group_interests"] = [];
  const r = await interest(INTEREST());
  assert.equal(r.status, 200);
  assert.equal(r.json["success"], true);
  const { detailsUrl, callUrl } = r.json;
  const m = /^https:\/\/dev\.example\.test\/details\.html\?t=([A-Za-z0-9_-]{43})$/.exec(detailsUrl);
  assert.ok(m, detailsUrl);
  assert.equal(callUrl, `${detailsUrl}&choice=call`);
  const row = newest();
  assert.equal(row["details_token_hash"], hashLinkToken(m![1]!), "the hash of the token in the link is what is stored");
  assert.ok(!JSON.stringify(row).includes(m![1]!), "the token itself is stored nowhere");
  assert.ok(row["details_token_issued_at"]);
  // and the link opens the page for that very reply
  assert.equal((await call("GET", `/group-details/${m![1]}`)).json["firstName"], "Pat");

  await wait(() => row["ack_email_status"] === "sent");
  assert.equal(row["ack_email_status"], "sent");
  assert.ok(row["ack_email_at"]);
  assert.equal(mails.length, 1);
  assert.equal(mails[0]!["to"], "pat@example.com");
  assert.equal(mails[0]!["subject"], "You're on the list for Friends and Family 2027");
  assert.equal(mails[0]!["from_name"], "Mark Millham");
  assert.equal(mails[0]!["reply_to"], "mark@stillafloatcruising.com");
  assert.ok(String(mails[0]!["text"]).includes(detailsUrl) && String(mails[0]!["html"]).includes(detailsUrl));
  assert.ok(String(mails[0]!["text"]).includes("Balcony Bella from $536.79 or Balcony Aurea from $686.79 per person, taxes and port fees included… and just $50 per person holds your spot."));
  assert.ok(String(mails[0]!["text"]).includes("we sail from Port Canaveral, Florida on Sunday, May 9, 2027… stops in Nassau and Ocean Cay… and home Thursday, May 13, 2027."));
  // the message log keeps who and when, never the link
  await wait(() => writes("group_messages").length > 0);
  const logged = writes("group_messages")[0]!.body;
  assert.deepEqual([logged.audience, logged.template, logged.to_email, logged.status], ["client", "interest-ack", "pat@example.com", "sent"]);
  assert.ok(!JSON.stringify(logged).includes(m![1]!), "the link is not in the message log");
  // the item on Mark's list is this reply's own
  await wait(() => writes("actions").some((w) => w.method === "POST"));
  assert.equal(writes("actions").find((w) => w.method === "POST")!.body.source_ref, `group-interest-${row["id"]}`);
});

test("a Spanish reply gets the Spanish page's links and the Spanish email", async () => {
  tables["group_interests"] = [];
  const r = await interest(INTEREST({ lang: "es", first_name: "Ana" }));
  assert.match(r.json["detailsUrl"], /^https:\/\/dev\.example\.test\/es\/details\.html\?t=/);
  assert.match(r.json["callUrl"], /^https:\/\/dev\.example\.test\/es\/details\.html\?t=[A-Za-z0-9_-]{43}&choice=call$/);
  await wait(() => mails.length > 0);
  assert.equal(mails[0]!["subject"], "Ya está en la lista de Friends and Family 2027");
  assert.ok(String(mails[0]!["text"]).includes("Lo termino ahora"));
});

test("a box that only emails its test addresses holds the email; a phone-only reply gets none; a failed send is recorded; every one still gets the links", async () => {
  tables["group_interests"] = [];
  process.env["GROUP_FORMS_MAIL_ALLOW"] = "tester@example.org,@staff.example";
  const held = await interest(INTEREST({ email: "pat@example.com" }));
  assert.ok(held.json["detailsUrl"]);
  await wait(() => newest()["ack_email_status"] === "held");
  assert.equal(newest()["ack_email_status"], "held");
  assert.equal(mails.length, 0, "nothing was sent to a real address");
  await wait(() => writes("group_messages").length > 0);
  assert.equal(writes("group_messages")[0]!.body.status, "skipped");

  const allowed = await interest(INTEREST({ email: "tester@example.org" }));
  assert.ok(allowed.json["detailsUrl"]);
  await wait(() => mails.length === 1);
  assert.equal(mails[0]!["to"], "tester@example.org");
  delete process.env["GROUP_FORMS_MAIL_ALLOW"];

  const phone = await interest(INTEREST({ email: "", phone: "919-346-6127", first_name: "Cher", last_name: "" }));
  assert.ok(phone.json["detailsUrl"] && phone.json["callUrl"], "a phone-only reply still gets its links");
  await wait(() => newest()["ack_email_status"] === "no-email");
  assert.equal(newest()["ack_email_status"], "no-email");
  assert.equal(mails.length, 1, "no email for a phone number");

  mailOk = false;
  const failed = await interest(INTEREST({ email: "fail@example.com" }));
  assert.ok(failed.json["detailsUrl"], "a mail sender that is down does not cost the guest their links");
  await wait(() => newest()["ack_email_status"] === "failed");
  assert.equal(newest()["ack_email_status"], "failed");
  assert.equal(newest()["ack_email_at"], null);
});

test("a box that has not applied migration 0056 still takes the reply: success, no links, no email", async () => {
  tables["group_interests"] = [];
  tokenWriteFails = true;
  const r = await interest(INTEREST());
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { success: true });
  assert.equal(tables["group_interests"]!.length, 1, "the reply is saved");
  await new Promise((r2) => setTimeout(r2, 60));
  assert.equal(mails.length, 0);
});

test("every refusal the Count me in form already had is unchanged, and none of them hands out a link", async () => {
  tables["group_interests"] = [];
  const cases: Array<[Row, number]> = [[INTEREST({ first_name: "" }), 400], [INTEREST({ email: "nope", phone: "" }), 400], [INTEREST({ email: "", phone: "" }), 400]];
  for (const [body, status] of cases) {
    const r = await interest(body);
    assert.equal(r.status, status);
    assert.ok(!("detailsUrl" in r.json) && !("callUrl" in r.json));
  }
  const bot = await interest(INTEREST({ website: "http://spam.example" }));
  assert.deepEqual(bot.json, { success: true }, "the bot trap answers as before, with no link");
  assert.equal((await call("POST", `/group-page/NOT-A-CODE/interest`, { body: INTEREST() })).status, 404);
  assert.equal(tables["group_interests"]!.length, 0);
});

// ── The dashboard: add the reply's travelers to a cabin ───────────────────────

const toFile = (iid: string, body: unknown, token = true) => call("POST", `/groups/${GROUP_ID}/interests/${iid}/to-file`, { body, token });

test("the dashboard route is Mark's alone", async () => {
  Object.assign(replyRow(), GOOD);
  assert.equal((await toFile(REPLY_ID, { cabin_id: CABIN_ID }, false)).status, 401);
  assert.equal(tables["group_travelers"]!.length, 0);
});

test("the typed travelers become travelers on the chosen cabin: last-space split, the first is the lead and carries the contact; the cabin's status is untouched", async () => {
  Object.assign(replyRow(), { lang: "es", travelers: [{ legal_name: "Mary Ann Smith", dob: "1965-04-12" }, { legal_name: "Cher", dob: "1980-11-02" }] });
  const r = await toFile(REPLY_ID, { cabin_id: CABIN_ID });
  assert.equal(r.status, 200);
  assert.equal(r.json["count"], 2);
  const [a, b] = tables["group_travelers"]!;
  assert.deepEqual([a!["group_id"], a!["cabin_id"], a!["first_name"], a!["last_name"], a!["dob"], a!["is_lead"], a!["email"], a!["phone"], a!["lang"]], [GROUP_ID, CABIN_ID, "Mary Ann", "Smith", "1965-04-12", true, "mmillham1@gmail.com", null, "es"]);
  assert.deepEqual([b!["first_name"], b!["last_name"], b!["dob"], b!["is_lead"], b!["cabin_id"], "email" in b!], ["Cher", null, "1980-11-02", false, CABIN_ID, false]);
  assert.equal(replyRow()["traveler_id"], a!["id"], "the reply remembers it was added");
  assert.equal(writes("group_cabins").length, 0, "the cabin was not touched: Mark books with the cruise line himself");
  // it goes in once
  const again = await toFile(REPLY_ID, { cabin_id: CABIN_ID });
  assert.equal(again.status, 409);
  assert.equal(tables["group_travelers"]!.length, 2);
});

test("a cabin that already has its lead keeps it: the new first traveler is not a second lead", async () => {
  tables["group_travelers"]!.push({ id: "t-0", group_id: GROUP_ID, cabin_id: CABIN_ID, is_lead: true, first_name: "Existing" });
  Object.assign(replyRow(), GOOD);
  assert.equal((await toFile(REPLY_ID, { cabin_id: CABIN_ID })).status, 200);
  assert.deepEqual(tables["group_travelers"]!.slice(1).map((t) => t["is_lead"]), [false, false]);
});

test("refused: a reply with no travelers, no cabin chosen, a cabin that is not on this group, an unknown reply, a malformed id", async () => {
  const none = await toFile(REPLY_ID, { cabin_id: CABIN_ID });
  assert.equal(none.status, 400);
  assert.match(none.json["error"], /no travelers yet/);
  Object.assign(replyRow(), GOOD);
  assert.equal((await toFile(REPLY_ID, {})).status, 400);
  assert.equal((await toFile(REPLY_ID, { cabin_id: OTHER_CABIN })).status, 404);
  assert.equal((await toFile(REPLY_ID, { cabin_id: "55555555-5555-4555-8555-555555555555" })).status, 404);
  assert.equal((await toFile(REPLY_ID, { cabin_id: "not-a-uuid" })).status, 404);
  assert.equal((await toFile("66666666-6666-4666-8666-666666666666", { cabin_id: CABIN_ID })).status, 404);
  assert.equal((await toFile("not-a-uuid", { cabin_id: CABIN_ID })).status, 404);
  assert.equal(tables["group_travelers"]!.length, 0, "no refused request made a traveler");
});

test("the replies list carries what the table shows: choice, hold, the travelers and the pick", async () => {
  Object.assign(replyRow(), { ...GOOD, choice: "finish", hold_requested_at: "2026-10-23T18:00:00Z", pick: { category: "Balcony Bella", where: "midship", why: "x" } });
  const r = await call("GET", `/groups/${GROUP_ID}/interests`, { token: true });
  assert.equal(r.status, 200);
  const row = r.json["interests"][0];
  assert.deepEqual([row["choice"], row["hold_requested_at"], row["travelers"].length, row["pick"]["category"]], ["finish", "2026-10-23T18:00:00Z", 2, "Balcony Bella"]);
  assert.ok(!("details_token_hash" in row) && !("ip_hash" in row), "the list never carries the link's hash");
  assert.equal((await call("GET", `/groups/${GROUP_ID}/interests`)).status, 401);
});
