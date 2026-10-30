// group-details.test.ts (routes) — the guest's two roads after "Save my spot!" (Mark 2026-10-24): Road A's choice and its ONE email, Road B's pick, save and
// hold and its ONE email; the answer that hands out the links (and sends NO email); and the dashboard's "add these travelers to a cabin" and the two buttons
// that close Mark's items. The real routers run against a small in-memory stand-in for the database (an http server that answers the PostgREST reads and
// writes the routes make) and for the mail sender, so nothing here can reach Supabase, an inbox or Mark's phone.

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
    marketing: { taxes_included: true, host_names: "Mark & Ceci", page_label: "Friends and Family 2027", hero_photo: "https://stillafloatcruising.com/assets/images/hero.jpg", upgrade_perks: "Your own restaurant where you eat when you feel like it\nthe adults-only thermal spa\na solarium the rest of the ship can't find" },
    marketing_copy: {
      en: { welcome: "w", headline: "h", subhead: "s", intro: "i", why_ship: "y", who_for: "f", organizer_note: null, cta_label: "Save my spot!", cta_blurb: "Questions? Call or text Mark at 919-346-6127.", email_subject: "s", email_body: "b", social_post: "p" },
      es: { welcome: "w", headline: "h", subhead: "s", intro: "i", why_ship: "y", who_for: "f", organizer_note: null, cta_label: "¡Aparte mi lugar!", cta_blurb: "¿Preguntas? Llame o escriba a Mark al 919-346-6127.", email_subject: "s", email_body: "b", social_post: "p" },
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
    id: REPLY_ID, group_id: GROUP_ID, first_name: "Mark", last_name: "Millham", email: "mmillham1@gmail.com", phone: null, lang: "en", guests: 2, note: null, status: "new", created_at: new Date().toISOString(),
    ip_hash: "iphash-secret", prospect_id: "prospect-secret", traveler_id: null, details_token_hash: hashLinkToken(LINK), details_token_issued_at: new Date().toISOString(),
    choice: null, choice_at: null, call_when: null, travelers: null, address: null, concierge: null, pick: null, hold_requested_at: null, ack_email_status: null, ack_email_at: null,
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

// The email and Mark's item are sent after the answer goes back, so a test waits for them: up to 10 seconds (a busy test run
// is slow), and a wait that never comes true fails the test right there instead of leaving that work to land in the next test.
const wait = async (cond: () => boolean) => {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`timed out waiting for: ${cond.toString()}`);
};
const replyRow = () => tables["group_interests"]!.find((r) => r["id"] === REPLY_ID)!;
const writes = (table: string) => log.filter((l) => l.table === table && l.method !== "GET");
const ADDRESS = { street: "123 Main St", city: "Raleigh", state: "NC", zip: "27601", tidied: true };
const GOOD = {
  travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }],
  address: ADDRESS,
  concierge: { room: "balcony", priority: "quiet", budget: "middle", motion: "yes" },
};
const WHY = "Steady for whoever feels the motion, quiet away from the pool deck, and a balcony for that coffee.";
const UPGRADE = { category: "Aurea", hook: "Your own restaurant where you eat when you feel like it, the adults-only thermal spa, and a solarium the rest of the ship can't find." };
const PICK = { category: "Balcony Bella", where: "midship, a lower deck", why: WHY, upgrade: UPGRADE };
/** The pending item the reply put on Mark's list when it was saved. */
const pendingItem = () => tables["actions"]!.push({ id: "a-1", type: "lead", source_ref: `group-interest-${REPLY_ID}`, status: "pending", title: "Group reply: Mark Millham", body: "old", buttons: [] });

// ── GET: what the link opens ──────────────────────────────────────────────────

test("a good link answers with what we know and what they entered; private headers, nothing internal, and NO cabin price", async () => {
  const r = await call("GET", `/group-details/${LINK}`);
  assert.equal(r.status, 200);
  assert.equal(r.json["success"], true);
  assert.deepEqual(
    { label: r.json["label"], ship: r.json["ship"], sail: r.json["sailDateText"], back: r.json["returnDateText"], first: r.json["firstName"], last: r.json["lastName"], email: r.json["email"], phone: r.json["phone"], guests: r.json["guests"], lang: r.json["lang"] },
    { label: "Friends and Family 2027", ship: "MSC Seashore", sail: "May 9, 2027", back: "May 13, 2027", first: "Mark", last: "Millham", email: "mmillham1@gmail.com", phone: null, guests: 2, lang: "en" },
  );
  assert.deepEqual([r.json["depositPerPersonText"], r.json["phoneLine"], r.json["businessPhone"], r.json["heroUrl"]], ["$50", "Questions? Call or text Mark at 919-346-6127.", "919-346-6127", "https://stillafloatcruising.com/assets/images/hero.jpg"]);
  assert.deepEqual([r.json["travelers"], r.json["address"], r.json["concierge"], r.json["pick"], r.json["choice"], r.json["callWhen"], r.json["holdRequestedAt"]], [[], null, null, null, null, null, null]);
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.match(r.headers.get("referrer-policy") ?? "", /no-referrer/);
  // nothing internal: no hash, no audit hash, no ids, no other replies, no cabin the group still has
  for (const secret of [hashLinkToken(LINK), "iphash-secret", "prospect-secret", GROUP_ID, REPLY_ID, CABIN_ID, "details_token", "cabinsAvailable"]) assert.ok(!r.text.includes(secret), `the answer carries ${secret}`);
  // no cabin price and no category list: nothing after the group page repeats them
  for (const price of ["536.79", "686.79", "1073.58", "Balcony Bella", "held", "taxesIncluded", "perPersonText"]) assert.ok(!r.text.includes(price), `the answer carries ${price}`);
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
  assetsFail = false; tables["groups"]![0]!["marketing"] = { taxes_included: true };
  log = [];
  assert.deepEqual((await call("GET", `/group-details/${LINK}`)).json["credits"], []);
  assert.equal(log.filter((l) => l.table === "group_assets").length, 0);
});

test("a Spanish reply is answered in Spanish (dates and phone line), and stored answers come back so the page can fill itself", async () => {
  Object.assign(replyRow(), { lang: "es", ...GOOD, pick: PICK, choice: "call", call_when: "evening" });
  const r = await call("GET", `/group-details/${LINK}`);
  assert.equal(r.json["lang"], "es");
  assert.equal(r.json["sailDateText"], "9 de mayo de 2027");
  assert.equal(r.json["phoneLine"], "¿Preguntas? Llame o escriba a Mark al 919-346-6127.");
  assert.deepEqual(r.json["travelers"], GOOD.travelers);
  assert.deepEqual(r.json["address"], ADDRESS);
  assert.deepEqual(r.json["concierge"], GOOD.concierge);
  assert.deepEqual(r.json["pick"], PICK);
  assert.deepEqual([r.json["choice"], r.json["callWhen"]], ["call", "evening"]);
  // a pick stored before the upgrade hook existed reads with none
  Object.assign(replyRow(), { pick: { category: "Balcony Bella", where: "midship", why: "x" } });
  assert.deepEqual((await call("GET", `/group-details/${LINK}`)).json["pick"], { category: "Balcony Bella", where: "midship", why: "x", upgrade: null });
});

test("the number a guest is told is the one in the group's own line beside the button, else the business number", async () => {
  tables["groups"]![0]!["marketing_copy"].en.cta_blurb = "Questions? Call Mark at (704) 555-0100.";
  assert.equal((await call("GET", `/group-details/${LINK}`)).json["businessPhone"], "(704) 555-0100");
  tables["groups"]![0]!["marketing_copy"].en.cta_blurb = "Questions? Ask away.";
  assert.equal((await call("GET", `/group-details/${LINK}`)).json["businessPhone"], "919-346-6127");
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

// ── Road A: "Talk me into it, Mark!" ──────────────────────────────────────────

const choose = (when: unknown, extra: Row = {}, token = LINK) => call("POST", `/group-details/${token}/choice`, { body: { choice: "call", when, ...extra } });

test("Road A: the time is saved, the guest's item on Mark's list becomes 'Ring …' in place (one person, one item), and the ONE email goes out", async () => {
  pendingItem();
  const r = await choose("evening");
  assert.deepEqual([r.status, r.json["success"]], [200, true]);
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual([replyRow()["choice"], replyRow()["call_when"]], ["call", "evening"]);
  assert.ok(replyRow()["choice_at"]);
  const item = tables["actions"]![0]!;
  assert.equal(item["title"], "Ring Mark Millham · party of 2 · evenings");
  assert.match(item["body"], /^Friends and Family 2027 · mmillham1@gmail\.com · saved their spot (today|[A-Z][a-z]{2} \d{1,2}) at \d{1,2}:\d{2} (AM|PM) and said "talk me into it"\.$/);
  assert.deepEqual(item["buttons"], [
    { label: "Open the group file", href: `/groups/${GROUP_ID}` },
    { label: "We talked", method: "POST", path: `/api/groups/${GROUP_ID}/interests/${REPLY_ID}/mark/talked` },
  ]);
  assert.equal(writes("actions").filter((w) => w.method === "POST").length, 0, "no second item was made");
  await wait(() => mails.length > 0);
  assert.equal(mails.length, 1, "the ONE email");
  assert.equal(mails[0]!["to"], "mmillham1@gmail.com");
  assert.equal(mails[0]!["subject"], "Good call… literally! Friends and Family 2027");
  assert.equal(mails[0]!["from_name"], "Mark Millham");
  assert.equal(mails[0]!["reply_to"], "mark@stillafloatcruising.com");
  assert.match(String(mails[0]!["text"]), /Mark will ring you within a day from 919-346-6127… evenings, like you said\./);
  assert.match(String(mails[0]!["text"]), /^Hi Mark,/);
  assert.ok(!/\$|Bella|Aurea|per person/.test(String(mails[0]!["text"]) + String(mails[0]!["html"])), "no cabin names or prices");
  await wait(() => replyRow()["ack_email_status"] === "sent");
  assert.equal(replyRow()["ack_email_status"], "sent");
  assert.ok(replyRow()["ack_email_at"]);
  await wait(() => writes("group_messages").length > 0);
  const logged = writes("group_messages")[0]!.body;
  assert.deepEqual([logged.audience, logged.template, logged.to_email, logged.status, logged.subject], ["client", "call-confirmation", "mmillham1@gmail.com", "sent", "Good call… literally! Friends and Family 2027"]);
});

test("Road A: each answer is worded for Mark's list and for the email; a missing party size leaves the party out", async () => {
  const words: Record<string, [string, string]> = { morning: ["mornings", "mornings"], afternoon: ["afternoons", "afternoons"], evening: ["evenings", "evenings"], anytime: ["whenever", "whenever works"] };
  for (const [when, [listWord, mailWord]] of Object.entries(words)) {
    tables["actions"]!.length = 0; mails.length = 0; replyRow()["choice_at"] = null; replyRow()["choice"] = null; replyRow()["guests"] = when === "anytime" ? null : 2;
    pendingItem();
    assert.equal((await choose(when)).status, 200, when);
    assert.equal(tables["actions"]![0]!["title"], when === "anytime" ? `Ring Mark Millham · ${listWord}` : `Ring Mark Millham · party of 2 · ${listWord}`);
    await wait(() => mails.length > 0);
    assert.match(String(mails[0]!["text"]), new RegExp(`… ${mailWord}, like you said\\.`), when);
  }
});

test("Road A with no pending item (Mark already cleared it) makes a new item for the call, with the same buttons", async () => {
  const r = await choose("morning");
  assert.equal(r.status, 200);
  await wait(() => writes("actions").some((w) => w.method === "POST"));
  const made = writes("actions").find((w) => w.method === "POST")!.body;
  assert.equal(made.title, "Ring Mark Millham · party of 2 · mornings");
  assert.equal(made.source_ref, `group-call-${REPLY_ID}`);
  assert.deepEqual(made.buttons.map((b: Row) => b["label"]), ["Open the group file", "We talked"]);
  assert.equal(made.buttons.length, 2, "no 'Later tonight': the actions list has no snooze to hang it on");
});

test("Road A: the first press wins. A double tap or a second tab makes no second item and no second email; a later press only changes the time", async () => {
  pendingItem();
  await Promise.all([choose("evening"), choose("evening")]);
  await wait(() => mails.length > 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(mails.length, 1, "one email");
  assert.equal(writes("actions").filter((w) => w.method === "POST").length, 0);
  const again = await choose("morning");
  assert.equal(again.status, 200);
  assert.equal(replyRow()["call_when"], "morning");
  assert.equal(tables["actions"]![0]!["title"], "Ring Mark Millham · party of 2 · mornings");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(mails.length, 1, "still one email");
});

test("Road A refuses what it does not understand: any time but the four, any choice but 'call', a wrong link, a cabin already on hold; the bot trap changes nothing", async () => {
  for (const when of ["night", "Morning", "", null, undefined, 3, ["morning"], "morning;drop"]) {
    const r = await choose(when);
    assert.equal(r.status, 400, JSON.stringify(when));
    assert.equal(r.json["error"], "Pick a time that suits you.");
  }
  for (const choice of ["finish", "hold", "", null, undefined, 1, ["call"], "CALL"]) {
    const r = await call("POST", `/group-details/${LINK}/choice`, { body: { choice, when: "evening" } });
    assert.equal(r.status, 400, JSON.stringify(choice));
    assert.equal(r.json["error"], "Unknown choice.");
  }
  assert.equal((await choose("evening", {}, "A".repeat(43))).status, 404);
  assert.equal((await choose("evening", {}, "not-a-token")).status, 404);
  const bot = await choose("evening", { website: "http://spam.example" });
  assert.deepEqual([bot.status, bot.json["success"]], [200, true], "the robot is told yes");
  assert.equal(replyRow()["choice"], null, "and nothing was stored");
  assert.equal(writes("actions").length + writes("group_interests").length + writes("group_messages").length, 0);
  assert.equal(mails.length, 0);
  replyRow()["hold_requested_at"] = "2026-10-24T10:00:00Z";
  const held = await choose("evening");
  assert.equal(held.status, 409);
  assert.match(held.json["error"], /already on hold/);
  assert.equal(replyRow()["call_when"], null);
  // and in Spanish
  const es = await call("POST", `/group-details/${LINK}/choice`, { body: { choice: "call", when: "x", lang: "es" } });
  assert.equal(es.json["error"], "Elija un horario que le convenga.");
});

test("Road A's email goes only to an address this box may email; a phone-only reply gets none; a failed send is recorded; the Spanish reply gets the Spanish email", async () => {
  process.env["GROUP_FORMS_MAIL_ALLOW"] = "tester@example.org,@staff.example";
  assert.equal((await choose("evening")).status, 200);
  await wait(() => replyRow()["ack_email_status"] === "held");
  assert.equal(replyRow()["ack_email_status"], "held");
  assert.equal(mails.length, 0, "nothing was sent to a real address");
  await wait(() => writes("group_messages").length > 0);
  assert.deepEqual([writes("group_messages")[0]!.body.status, writes("group_messages")[0]!.body.template], ["skipped", "call-confirmation"]);

  // an allowed address
  Object.assign(replyRow(), { choice: null, choice_at: null, email: "tester@example.org", ack_email_status: null });
  assert.equal((await choose("evening")).status, 200);
  await wait(() => mails.length === 1);
  assert.equal(mails[0]!["to"], "tester@example.org");
  delete process.env["GROUP_FORMS_MAIL_ALLOW"];

  // a phone-only reply
  mails.length = 0;
  Object.assign(replyRow(), { choice: null, choice_at: null, email: null, phone: "919-555-0100", ack_email_status: null });
  assert.equal((await choose("evening")).status, 200);
  await wait(() => replyRow()["ack_email_status"] === "no-email");
  assert.equal(replyRow()["ack_email_status"], "no-email");
  assert.equal(mails.length, 0, "no email for a phone number");
  await wait(() => writes("actions").filter((w) => w.method === "POST").length > 1);
  assert.match(writes("actions").filter((w) => w.method === "POST").pop()!.body.body, /919-555-0100/, "Mark still gets the item, with the phone to ring");

  // a mail sender that is down
  mailOk = false;
  Object.assign(replyRow(), { choice: null, choice_at: null, email: "fail@example.com", phone: null, ack_email_status: null, ack_email_at: null });
  assert.equal((await choose("evening")).status, 200, "a mail sender that is down does not cost the guest their answer");
  await wait(() => replyRow()["ack_email_status"] === "failed");
  await wait(() => writes("group_messages").some((w) => w.body.status === "failed"));   // the email log is written just after the status
  assert.equal(replyRow()["ack_email_status"], "failed");
  assert.equal(replyRow()["ack_email_at"], null);

  // Spanish
  mailOk = true; mails.length = 0;
  Object.assign(replyRow(), { choice: null, choice_at: null, email: "ana@example.com", lang: "es", first_name: "Ana", ack_email_status: null });
  assert.equal((await choose("morning")).status, 200);
  await wait(() => mails.length === 1);
  assert.equal(mails[0]!["subject"], "Buena decisión… ¡la llamada va en camino! Friends and Family 2027");
  assert.match(String(mails[0]!["text"]), /Mark le llamará en un día desde el 919-346-6127… por la mañana, como usted dijo\./);
  await wait(() => writes("group_messages").some((w) => w.body.status === "sent"));   // nothing of this test is left to land in the next
});

test("Road A rings from the number in the group's own line beside the button", async () => {
  tables["groups"]![0]!["marketing_copy"].en.cta_blurb = "Questions? Call or text Mark at (704) 555-0100.";
  assert.equal((await choose("evening")).status, 200);
  await wait(() => mails.length > 0);
  assert.match(String(mails[0]!["text"]), /from \(704\) 555-0100… evenings/);
});

// ── Road B: the pick ──────────────────────────────────────────────────────────

const pickOf = (concierge: unknown, extra: Row = {}) => call("POST", `/group-details/${LINK}/pick`, { body: { concierge, ...extra } });

test("Road B: the four answers alone make the pick (the design's example, with the upgrade hook from the group's perks and NO price) and it is kept on the reply", async () => {
  const r = await pickOf(GOOD.concierge);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json["pick"], PICK);
  assert.deepEqual([replyRow()["concierge"], replyRow()["pick"]], [GOOD.concierge, PICK]);
  assert.equal(replyRow()["travelers"], null, "the names are not touched");
  assert.ok(!/\$|per person/.test(JSON.stringify(r.json)));
  // a higher budget takes the top category, which has nothing above it
  const top = await pickOf({ ...GOOD.concierge, budget: "sky" });
  assert.equal(top.json["pick"].category, "Balcony Aurea");
  assert.equal(top.json["pick"].upgrade, null);
  // no perks written for the group: no hook
  tables["groups"]![0]!["marketing"] = { page_label: "Friends and Family 2027" };
  assert.equal((await pickOf(GOOD.concierge)).json["pick"].upgrade, null);
  // Spanish
  tables["groups"]![0]!["marketing"] = { upgrade_perks: "Un restaurante propio\nEl spa" };
  const es = await pickOf(GOOD.concierge, { lang: "es" });
  assert.equal(es.json["pick"].where, "en el centro del barco, en una cubierta baja");
  assert.deepEqual(es.json["pick"].upgrade, { category: "Aurea", hook: "Un restaurante propio y el spa." });
});

test("Road B: the pick refuses a missing or wrong answer, a wrong link and the bot trap, and a cabin already on hold", async () => {
  for (const concierge of [undefined, {}, { ...GOOD.concierge, motion: "maybe" }, "balcony"]) {
    const r = await pickOf(concierge);
    assert.equal(r.status, 400, JSON.stringify(concierge));
    assert.equal(r.json["error"], "Please tap one answer for each of the four room questions.");
  }
  assert.equal((await call("POST", `/group-details/${"A".repeat(43)}/pick`, { body: { concierge: GOOD.concierge } })).status, 404);
  const bot = await pickOf(GOOD.concierge, { website: "http://spam.example" });
  assert.deepEqual([bot.status, bot.json["success"], "pick" in bot.json], [200, true, false], "the bot trap does not pretend a cabin was picked");
  assert.equal(replyRow()["pick"], null);
  replyRow()["hold_requested_at"] = "2026-10-24T10:00:00Z";
  assert.equal((await pickOf(GOOD.concierge)).status, 409);
});

test("with the prices hidden the pick names the kind of cabin and has no upgrade", async () => {
  tables["groups"]![0]!["marketing"] = { show_prices: false, upgrade_perks: "A spa" };
  const r = await pickOf({ ...GOOD.concierge, room: "oceanview" });
  assert.equal(r.json["pick"].category, "Oceanview");
  assert.equal(r.json["pick"].upgrade, null);
  assert.ok(!/\$/.test(r.json["pick"].why));
});

// ── Road B: names, birthdays, address, the four answers ───────────────────────

const save = (body: unknown, token = LINK) => call("POST", `/group-details/${token}`, { body });

test("Road B: good details are saved with our pick; the guest's count replaces the party size", async () => {
  const r = await save(GOOD);
  assert.equal(r.status, 200);
  assert.equal(r.json["success"], true);
  assert.deepEqual(r.json["pick"], PICK);
  assert.deepEqual(replyRow()["travelers"], GOOD.travelers);
  assert.deepEqual(replyRow()["address"], ADDRESS);
  assert.deepEqual(replyRow()["concierge"], GOOD.concierge);
  assert.deepEqual(replyRow()["pick"], PICK);
  assert.equal(replyRow()["guests"], 2);
  const four = await save({ ...GOOD, travelers: Array.from({ length: 4 }, (_, i) => ({ legal_name: `Guest Number${"x".repeat(i)}`, dob: "1990-01-01" })) });
  assert.equal(four.status, 200);
  assert.equal(replyRow()["guests"], 4);
  assert.equal(writes("actions").length, 0, "saving tells Mark nothing: only the hold does");
  assert.equal(mails.length, 0, "and sends nothing");
});

test("Road B: details that do not pass are refused in the design's words with the field, and nothing is saved", async () => {
  const cases: Array<[unknown, string, string]> = [
    [{ ...GOOD, travelers: [{ legal_name: "Bob", dob: "1965-04-12" }] }, "First AND last name, please… the way the passport has it.", "travelers.0.legal_name"],
    [{ ...GOOD, travelers: [GOOD.travelers[0], { legal_name: "Ceci Millham", dob: "04/12/1965" }] }, "Month, day and a four-digit year: 03 / 04 / 1965.", "travelers.1.dob"],
    [{ ...GOOD, travelers: [] }, "Please add at least one traveler.", "travelers"],
    [{ ...GOOD, travelers: Array.from({ length: 5 }, () => GOOD.travelers[0]) }, "More than four? Mark will set up a second cabin on the call… tap Talk me into it, Mark! on the group page.", "travelers"],
    [{ ...GOOD, address: undefined }, "A street and number, please… like 123 Main St.", "address.street"],
    [{ ...GOOD, address: { ...ADDRESS, city: "" } }, "Which city, please?", "address.city"],
    [{ ...GOOD, address: { ...ADDRESS, state: "ZZ" } }, "The state's two letters, please… like NC.", "address.state"],
    [{ ...GOOD, address: { ...ADDRESS, zip: "1" } }, "Five digits for the ZIP, please… like 27601.", "address.zip"],
    [{ ...GOOD, concierge: { ...GOOD.concierge, room: "penthouse" } }, "Please tap one answer for each of the four room questions.", "concierge.room"],
    [[], "Something went wrong with that form. Please reload the page.", "body"],
  ];
  for (const [body, error, field] of cases) {
    const r = await save(body);
    assert.equal(r.status, 400, field);
    assert.deepEqual([r.json["error"], r.json["field"]], [error, field]);
  }
  assert.equal(replyRow()["travelers"], null);
  assert.equal(replyRow()["address"], null);
  // the Spanish page gets Spanish words
  const es = await save({ ...GOOD, address: { ...ADDRESS, zip: "1" }, lang: "es" });
  assert.equal(es.json["error"], "Cinco dígitos para el código postal, por favor… como 27601.");
});

test("Road B: a wrong link or the bot trap saves nothing, and once the cabin is on hold a change goes through Mark, not a form", async () => {
  assert.equal((await save(GOOD, "A".repeat(43))).status, 404);
  assert.equal((await save(GOOD, "not-a-token")).status, 404);
  const bot = await save({ ...GOOD, website: "http://spam.example" });
  assert.deepEqual([bot.status, bot.json["success"], "pick" in bot.json], [200, true, false]);
  assert.equal(replyRow()["travelers"], null);
  replyRow()["hold_requested_at"] = "2026-10-24T10:00:00Z";
  const held = await save(GOOD);
  assert.equal(held.status, 409);
  assert.equal(held.json["error"], "Your cabin is already on hold. To change anything, call or text Mark at 919-346-6127.");
  assert.equal((await save({ ...GOOD, lang: "es" })).json["error"], "Su cabina ya está apartada. Para cambiar algo, llame o escriba a Mark al 919-346-6127.");
  assert.equal(replyRow()["travelers"], null);
});

// ── Road B: "Hold my cabin!" ──────────────────────────────────────────────────

const hold = (token = LINK, body: Row = {}) => call("POST", `/group-details/${token}/hold`, { body });
const readyToHold = () => Object.assign(replyRow(), { ...GOOD, pick: PICK });

test("Road B: 'Hold my cabin!' needs the saved names, address and pick first", async () => {
  const r = await hold();
  assert.equal(r.status, 400);
  assert.equal(r.json["error"], "Please finish the names, the address and the four questions first.");
  Object.assign(replyRow(), { travelers: GOOD.travelers, pick: PICK });          // no address yet
  assert.equal((await hold()).status, 400);
  Object.assign(replyRow(), { travelers: null, address: ADDRESS });
  assert.equal((await hold()).status, 400);
  assert.equal(replyRow()["hold_requested_at"], null);
  assert.equal(writes("actions").length, 0);
  assert.equal(mails.length, 0);
  Object.assign(replyRow(), { lang: "es", address: null });
  assert.equal((await hold()).json["error"], "Primero termine los nombres, la dirección y las preguntas.");
});

test("Road B: the hold records the request, marks the choice, tells Mark once with the design's item, and sends the ONE email; nothing is booked", async () => {
  readyToHold();
  actionsAccept = true;
  pendingItem();
  const r = await hold();
  assert.deepEqual([r.status, r.json["success"]], [200, true]);
  assert.ok(replyRow()["hold_requested_at"]);
  assert.equal(replyRow()["choice"], "finish");
  await wait(() => writes("actions").some((w) => w.method === "POST"));
  const made = writes("actions").find((w) => w.method === "POST")!.body;
  assert.equal(made.type, "lead");
  assert.equal(made.source_ref, `group-hold-${REPLY_ID}`);
  assert.equal(made.title, "Hold requested · Mark Millham · Balcony Bella · party of 2");
  assert.equal(made.body, "Friends and Family 2027 · mmillham1@gmail.com · midship, a lower deck (feels the motion, wants quiet, balcony). Names, birthdays and the address are on the reply.");
  assert.deepEqual(made.buttons, [
    { label: "Add the travelers to a cabin", href: `/groups/${GROUP_ID}#replies` },
    { label: "Open the group file", href: `/groups/${GROUP_ID}` },
    { label: "Confirmed with MSC", method: "POST", path: `/api/groups/${GROUP_ID}/interests/${REPLY_ID}/mark/confirmed` },
  ]);
  assert.equal(made.buttons[0].label, "Add the travelers to a cabin", "the to-file route is the FIRST button");
  // the earlier "Group reply" item is closed once the new one exists
  await wait(() => tables["actions"]![0]!["status"] === "done");
  assert.equal(tables["actions"]![0]!["status"], "done");
  // the ONE email
  await wait(() => mails.length > 0);
  assert.equal(mails.length, 1);
  assert.equal(mails[0]!["to"], "mmillham1@gmail.com");
  assert.equal(mails[0]!["subject"], "Your cabin is on hold… nicely done! Friends and Family 2027");
  const text = String(mails[0]!["text"]);
  assert.match(text, /^Hi Mark,/);
  assert.match(text, /Here's what you did: Balcony Bella, midship, a lower deck, for Mark and Ceci\. Mark confirms it with the cruise line within a day/);
  assert.match(text, /dig out both passports/);
  assert.ok(text.includes(`https://dev.example.test/details.html?t=${LINK}`), "the way back to their details is their own link");
  assert.ok(!/\$|per person|deposit/i.test(text + String(mails[0]!["html"])), "no price in the email");
  await wait(() => replyRow()["ack_email_status"] === "sent");
  await wait(() => writes("group_messages").length > 0);
  const logged = writes("group_messages")[0]!.body;
  assert.deepEqual([logged.audience, logged.template, logged.to_email, logged.status], ["client", "hold-confirmation", "mmillham1@gmail.com", "sent"]);
  assert.ok(!JSON.stringify(logged).includes(LINK), "the link is not in the message log");
  assert.equal(writes("group_cabins").length + writes("group_travelers").length, 0, "nothing is booked or added to a cabin");
});

test("Road B: a second press (a double tap, a reload) changes nothing, makes no second item and sends no second email", async () => {
  readyToHold();
  actionsAccept = true;
  await Promise.all([hold(), hold()]);
  const again = await hold();
  assert.deepEqual([again.status, again.json["success"]], [200, true]);
  await wait(() => mails.length > 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(writes("actions").filter((w) => w.method === "POST").length, 1, "one item for Mark");
  assert.equal(mails.length, 1, "one email");
});

test("Road B: when the hold's item is made, the guest's earlier items (the reply, and a 'Ring …' if they asked for a call first) are closed; when it is not, they stay", async () => {
  readyToHold();
  tables["actions"]!.push({ id: "a-1", type: "lead", source_ref: `group-interest-${REPLY_ID}`, status: "pending", title: "Ring Mark Millham · party of 2 · evenings", body: "old", buttons: [] });
  tables["actions"]!.push({ id: "a-2", type: "lead", source_ref: `group-call-${REPLY_ID}`, status: "pending", title: "Ring again", body: "old", buttons: [] });
  actionsAccept = false;                                       // the stand-in refuses the new item
  assert.equal((await hold()).status, 200);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(tables["actions"]!.map((a) => a["status"]), ["pending", "pending"], "no new item, so the old ones stay for Mark");
  Object.assign(replyRow(), { hold_requested_at: null });
  actionsAccept = true;
  assert.equal((await hold()).status, 200);
  await wait(() => tables["actions"]!.every((a) => a["status"] === "done" || a["source_ref"] === `group-hold-${REPLY_ID}`));
  assert.deepEqual(tables["actions"]!.slice(0, 2).map((a) => a["status"]), ["done", "done"]);
});

test("Road B's email goes only to an address this box may email; a phone-only reply gets none; a failed send is recorded; Spanish gets the Spanish email", async () => {
  readyToHold();
  process.env["GROUP_FORMS_MAIL_ALLOW"] = "tester@example.org";
  assert.equal((await hold()).status, 200);
  await wait(() => replyRow()["ack_email_status"] === "held");
  await wait(() => writes("group_messages").length > 0);   // the email log is written just after the reply's status
  assert.equal(mails.length, 0);
  assert.equal(writes("group_messages")[0]!.body.status, "skipped");
  delete process.env["GROUP_FORMS_MAIL_ALLOW"];
  Object.assign(replyRow(), { hold_requested_at: null, email: null, phone: "919-555-0100", ack_email_status: null });
  assert.equal((await hold()).status, 200);
  await wait(() => replyRow()["ack_email_status"] === "no-email");
  assert.equal(mails.length, 0);
  mailOk = false;
  Object.assign(replyRow(), { hold_requested_at: null, email: "fail@example.com", phone: null, ack_email_status: null });
  assert.equal((await hold()).status, 200);
  await wait(() => replyRow()["ack_email_status"] === "failed");
  await wait(() => writes("group_messages").some((w) => w.body.status === "failed"));   // the email log is written just after the status
  mailOk = true; mails.length = 0;
  Object.assign(replyRow(), { hold_requested_at: null, email: "ana@example.com", lang: "es", first_name: "Ana", ack_email_status: null, pick: { ...PICK, where: "en el centro del barco, en una cubierta baja" } });
  assert.equal((await hold()).status, 200);
  await wait(() => mails.length === 1);
  assert.equal(mails[0]!["subject"], "Su cabina está apartada… ¡bien hecho! Friends and Family 2027");
  assert.match(String(mails[0]!["text"]), new RegExp(`/es/details\\.html\\?t=${LINK}`));
  await wait(() => writes("group_messages").some((w) => w.body.status === "sent"));   // nothing of this test is left to land in the next
});

test("Road B: a wrong link or the bot trap holds nothing", async () => {
  readyToHold();
  assert.equal((await hold("A".repeat(43))).status, 404);
  assert.equal((await hold("not-a-token")).status, 404);
  const bot = await hold(LINK, { website: "http://spam.example" });
  assert.deepEqual([bot.status, bot.json["success"]], [200, true]);
  assert.equal(replyRow()["hold_requested_at"], null);
  assert.equal(writes("actions").length + writes("group_messages").length, 0);
  assert.equal(mails.length, 0);
});

// ── The "Save my spot!" answer ────────────────────────────────────────────────

const INTEREST = (over: Row = {}) => ({ first_name: "Pat", last_name: "Lee", email: "pat@example.com", phone: "", guests: 2, newsletter_opt_in: false, website: "", lang: "en", ...over });
const interest = (body: Row, ip?: string) => call("POST", `/group-page/${CODE}/interest`, { body, ip });
const newest = () => tables["group_interests"]![tables["group_interests"]!.length - 1]!;

test("saving a spot hands the guest their own links and the first word of their name, stores only the link's hash, and sends NO email (the client gets one message, after a road is chosen)", async () => {
  tables["group_interests"] = [];
  const r = await interest(INTEREST({ first_name: "Mary Ann", last_name: "van der Berg" }));
  assert.equal(r.status, 200);
  assert.equal(r.json["success"], true);
  assert.equal(r.json["first"], "Mary", "the first word of the name typed");
  const { detailsUrl, callUrl } = r.json;
  const m = /^https:\/\/dev\.example\.test\/details\.html\?t=([A-Za-z0-9_-]{43})$/.exec(detailsUrl);
  assert.ok(m, detailsUrl);
  assert.equal(callUrl, `${detailsUrl}&choice=call`);
  const row = newest();
  assert.equal(row["details_token_hash"], hashLinkToken(m![1]!), "the hash of the token in the link is what is stored");
  assert.ok(!JSON.stringify(row).includes(m![1]!), "the token itself is stored nowhere");
  assert.ok(row["details_token_issued_at"]);
  assert.equal(row["ack_email_status"], "awaiting-choice");
  // and the link opens the page for that very reply
  assert.equal((await call("GET", `/group-details/${m![1]}`)).json["firstName"], "Mary Ann");
  // the item on Mark's list is this reply's own
  await wait(() => writes("actions").some((w) => w.method === "POST"));
  assert.equal(writes("actions").find((w) => w.method === "POST")!.body.source_ref, `group-interest-${row["id"]}`);
  // and NO email went out, now or a moment later
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(mails.length, 0, "no acknowledgement email");
  assert.equal(writes("group_messages").length, 0, "nothing in the email log");
});

test("saving a spot sends nothing on a box that emails real people either, and a phone-only reply still gets its links", async () => {
  tables["group_interests"] = [];
  const email = await interest(INTEREST({ email: "pat@example.com" }));
  assert.ok(email.json["detailsUrl"]);
  const phone = await interest(INTEREST({ email: "", phone: "919-346-6127", first_name: "Cher", last_name: "Bono" }));
  assert.ok(phone.json["detailsUrl"] && phone.json["callUrl"], "a phone-only reply still gets its links");
  assert.equal(phone.json["first"], "Cher");
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(mails.length, 0);
  assert.deepEqual(tables["group_interests"]!.map((x) => x["ack_email_status"]), ["awaiting-choice", "awaiting-choice"]);
});

test("a Spanish reply gets the Spanish page's links", async () => {
  tables["group_interests"] = [];
  const r = await interest(INTEREST({ lang: "es", first_name: "Ana", last_name: "Pérez" }));
  assert.match(r.json["detailsUrl"], /^https:\/\/dev\.example\.test\/es\/details\.html\?t=/);
  assert.match(r.json["callUrl"], /^https:\/\/dev\.example\.test\/es\/details\.html\?t=[A-Za-z0-9_-]{43}&choice=call$/);
  assert.equal(r.json["first"], "Ana");
});

test("a box that has not applied migration 0056 still takes the reply: success and the name, no links, no email", async () => {
  tables["group_interests"] = [];
  tokenWriteFails = true;
  const r = await interest(INTEREST());
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { success: true, first: "Pat" });
  assert.equal(tables["group_interests"]!.length, 1, "the reply is saved");
  await new Promise((r2) => setTimeout(r2, 60));
  assert.equal(mails.length, 0);
});

test("the form's refusals keep the design's words, and none of them hands out a link", async () => {
  tables["group_interests"] = [];
  const cases: Array<[Row, number, string]> = [
    [INTEREST({ first_name: "" }), 400, "First AND last name, please… the way the passport has it."],
    [INTEREST({ last_name: "" }), 400, "First AND last name, please… the way the passport has it."],
    [INTEREST({ first_name: "R2", last_name: "D2" }), 400, "First AND last name, please… the way the passport has it."],
    [INTEREST({ email: "nope", phone: "" }), 400, "Please check your email address or phone number."],
    [INTEREST({ email: "", phone: "" }), 400, "Please check your email address or phone number."],
  ];
  for (const [body, status, error] of cases) {
    const r = await interest(body);
    assert.equal(r.status, status);
    assert.equal(r.json["error"], error);
    assert.ok(!("detailsUrl" in r.json) && !("callUrl" in r.json));
  }
  const bot = await interest(INTEREST({ website: "http://spam.example" }));
  assert.deepEqual(bot.json, { success: true }, "the bot trap answers as before, with no link");
  assert.equal((await call("POST", `/group-page/NOT-A-CODE/interest`, { body: INTEREST() })).status, 404);
  assert.equal(tables["group_interests"]!.length, 0);
});

// ── The dashboard: add the reply's travelers to a cabin, and the two buttons on Mark's list ──

const toFile = (iid: string, body: unknown, token = true) => call("POST", `/groups/${GROUP_ID}/interests/${iid}/to-file`, { body, token });

test("the dashboard route is Mark's alone", async () => {
  Object.assign(replyRow(), GOOD);
  assert.equal((await toFile(REPLY_ID, { cabin_id: CABIN_ID }, false)).status, 401);
  assert.equal(tables["group_travelers"]!.length, 0);
});

test("the typed travelers become travelers on the chosen cabin: last-space split, the first is the lead and carries the contact and the home address; the cabin's status is untouched", async () => {
  Object.assign(replyRow(), { lang: "es", address: ADDRESS, travelers: [{ legal_name: "Mary Ann Smith", dob: "1965-04-12" }, { legal_name: "Cher Bono", dob: "1980-11-02" }] });
  const r = await toFile(REPLY_ID, { cabin_id: CABIN_ID });
  assert.equal(r.status, 200);
  assert.equal(r.json["count"], 2);
  const [a, b] = tables["group_travelers"]!;
  assert.deepEqual([a!["group_id"], a!["cabin_id"], a!["first_name"], a!["last_name"], a!["dob"], a!["is_lead"], a!["email"], a!["phone"], a!["lang"]], [GROUP_ID, CABIN_ID, "Mary Ann", "Smith", "1965-04-12", true, "mmillham1@gmail.com", null, "es"]);
  assert.deepEqual(a!["form_data"], { address: "123 Main St", city_state_zip: "Raleigh, NC 27601" }, "the home address goes where the paperwork pre-fills from, in its two parts (Mark 2026-10-30)");
  assert.deepEqual([b!["first_name"], b!["last_name"], b!["dob"], b!["is_lead"], b!["cabin_id"], "email" in b!, "form_data" in b!], ["Cher", "Bono", "1980-11-02", false, CABIN_ID, false, false]);
  assert.equal(replyRow()["traveler_id"], a!["id"], "the reply remembers it was added");
  assert.equal(writes("group_cabins").length, 0, "the cabin was not touched: Mark books with the cruise line himself");
  // it goes in once
  const again = await toFile(REPLY_ID, { cabin_id: CABIN_ID });
  assert.equal(again.status, 409);
  assert.equal(tables["group_travelers"]!.length, 2);
});

test("a reply with no address on it (a road that did not ask for one) still goes in, with no address line", async () => {
  Object.assign(replyRow(), { travelers: GOOD.travelers, address: null });
  assert.equal((await toFile(REPLY_ID, { cabin_id: CABIN_ID })).status, 200);
  assert.equal("form_data" in tables["group_travelers"]![0]!, false);
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

test("the replies list carries what the table shows: choice, when, hold, the travelers, the address and the pick", async () => {
  Object.assign(replyRow(), { ...GOOD, choice: "call", call_when: "evening", hold_requested_at: "2026-10-23T18:00:00Z", pick: PICK });
  const r = await call("GET", `/groups/${GROUP_ID}/interests`, { token: true });
  assert.equal(r.status, 200);
  const row = r.json["interests"][0];
  assert.deepEqual([row["choice"], row["call_when"], row["hold_requested_at"], row["travelers"].length, row["address"]["city"], row["pick"]["category"]], ["call", "evening", "2026-10-23T18:00:00Z", 2, "Raleigh", "Balcony Bella"]);
  assert.ok(!("details_token_hash" in row) && !("ip_hash" in row), "the list never carries the link's hash");
  assert.equal((await call("GET", `/groups/${GROUP_ID}/interests`)).status, 401);
});

const mark = (how: string, iid = REPLY_ID, token = true) => call("POST", `/groups/${GROUP_ID}/interests/${iid}/mark/${how}`, { token });

test("'We talked' and 'Confirmed with MSC' (the buttons on Mark's list) move the reply along: contacted, then booked; never over a declined or spam reply; Mark's alone", async () => {
  assert.equal((await mark("talked", REPLY_ID, false)).status, 401);
  assert.equal(replyRow()["status"], "new");
  const talked = await mark("talked");
  assert.deepEqual([talked.status, talked.json["success"], talked.json["status"]], [200, true, "contacted"]);
  assert.equal(replyRow()["status"], "contacted");
  const confirmed = await mark("confirmed");
  assert.deepEqual([confirmed.status, confirmed.json["status"]], [200, "booked"]);
  assert.equal(replyRow()["status"], "booked");
  for (const status of ["declined", "spam"]) {
    replyRow()["status"] = status;
    const r = await mark("confirmed");
    assert.deepEqual([r.status, r.json["status"]], [200, status], "left as Mark set it");
    assert.equal(replyRow()["status"], status);
  }
  assert.equal((await mark("later")).status, 404, "only the two buttons exist");
  assert.equal((await mark("talked", "66666666-6666-4666-8666-666666666666")).status, 404);
  assert.equal((await mark("talked", "not-an-id")).status, 404);
});
