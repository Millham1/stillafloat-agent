// quote-page.test.ts — the guest's "Your quote" page (server/public/quote.html and its Spanish twin), run the way a visitor's browser runs it.
// Mark 2026-11-01: the quote step — which cabin, FlexPay, drinks, insurance, getting there and back, the starting price, "Send my choices to Mark!" —
// then one line. Mark 2026-11-07: it is its own page on the guest's own link (the details page sends them here once the names are in; no email does),
// the FlexPay yes is "Let's schedule a brief appointment with Mark to apply.", and no flight, hotel or transfer price shows before he finalizes the quote.
//
// The page script is executed against a minimal stand-in for the browser (the same one details-page.test.ts uses), fed the answer the server's
// GET /api/group-details/:token gives and a stand-in for its POSTs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { BUSINESS } from "./group-secure";
import { pickCabin } from "./group-details";
import { buildQuote, quoteOptions } from "./group-quote";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "../../public");
type Lang = "en" | "es";
const PAGES: Record<Lang, string> = { en: "quote.html", es: "es/quote.html" };
const html = (lang: Lang) => readFileSync(join(PUBLIC, PAGES[lang]), "utf8");
const script = (lang: Lang) => /<script>\n([\s\S]*?)<\/script>/.exec(html(lang))![1]!;

const TOKEN = "T".repeat(43);
const HELD = [{ category: "Balcony Bella", perPersonText: "$536.79" }, { category: "Balcony Aurea", perPersonText: "$686.79" }];
const PERKS = ["Your own restaurant where you eat when you feel like it", "the adults-only thermal spa", "a solarium the rest of the ship can't find"];
const ANSWERS = { room: "balcony", priority: "quiet", budget: "middle", motion: "yes" } as const;
const PICK = pickCabin(ANSWERS, HELD, "en", PERKS);
const ADDR = { street: "123 Main St", city: "Raleigh", state: "NC", zip: "27601", tidied: false };
/** The group file the quote step reads (lib/group-quote.ts): two held categories, the cruise line's plan with a price, one flight on offer. */
const FILE = {
  group: { sail_date: "2027-05-09", deposit_per_person: "50.00", final_payment_due: "2027-01-15", inclusions: [], line_protection: "MSC Cruise Protection: $99 per person", insurance_plans: null, marketing: { taxes_included: true }, terms: null },
  cabins: [{ id: "c1", status: "held", category: "Balcony Bella", category_code: "BEL", price_total: "1073.58" }, { id: "c2", status: "held", category: "Balcony Aurea", category_code: "AUR", price_total: "1373.58" }],
  travel: [{ id: "f1", kind: "flight", direction: "pre", from_place: "Raleigh (RDU)", price_per_person: "136", price_unit: "person", included: false }],
};
const OPTIONS = (lang: Lang) => quoteOptions(FILE, lang);
const TWO = [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }];
/** What the guest taps: our pick's cabin stays, FlexPay no, drinks no, no insurance, no flight, no hotel, no transfers. */
const QA = { cabin: "BEL", flexpay: false, drinks: false, insurance: "decline", travel: [], needs: { hotel: false, transfer: false } };

/** The answer GET /api/group-details/:token gives once the names are in (the server's own shape; each test changes what it needs). */
function answer(over: Record<string, unknown> = {}) {
  return {
    success: true, label: "Friends and Family 2027", ship: "MSC Seashore", sailDateText: "May 9, 2027", returnDateText: "May 13, 2027", heroUrl: "https://stillafloatcruising.com/assets/images/hero.jpg",
    firstName: "Mark", lastName: "Millham", email: "mmillham1@gmail.com", phone: null, guests: 2, travelers: TWO, address: ADDR, concierge: ANSWERS, pick: PICK, choice: "finish", callWhen: null,
    holdRequestedAt: "2026-10-24T10:00:00Z", quoteOptions: OPTIONS("en"), quote: null, quoteRequestedAt: null, paperwork: null,
    depositPerPersonText: "$50", phoneLine: "Questions? Call or text Mark at 919-346-6127.", businessPhone: "919-346-6127", lang: "en",
    ...over,
  };
}

// ── The browser stand-in ─────────────────────────────────────────────────────────────────────────────────────

type Handler = (e: { target: Target; preventDefault(): void }) => void;
class El {
  textContent = ""; innerHTML = ""; hidden = false; className = ""; value = ""; alt = ""; decoding = ""; src = "";
  onload: (() => void) | null = null; onerror: (() => void) | null = null; parentNode: El | null = null; firstChild: El | null = null;
  handlers: Record<string, Handler> = {};
  private attrs: Record<string, string> = {};
  constructor(readonly id: string) {}
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(type: string, fn: Handler) { this.handlers[type] = fn; }
  insertBefore(c: El) { c.parentNode = this; this.firstChild = c; return c; }
  removeChild() { /* nothing */ }
}
interface Target { getAttribute(k: string): string | null; value: string; className: string }
const target = (attrs: Record<string, string>): Target => ({ getAttribute: (k) => attrs[k] ?? null, value: "", className: "" });

type Sent = { url: string; body: Record<string, any> };
type Reply = { ok: boolean; status?: number; json?: unknown };
type PostReply = (url: string, body: Record<string, any>) => Reply | Promise<Reply>;

/** What the real server answers: the quote for the answers, and the paperwork sent on the agreement. */
function server(lang: Lang): PostReply {
  return (url, body) => {
    if (url.endsWith("/quote")) return { ok: true, json: { success: true, quote: buildQuote(FILE, TWO, body["answers"], lang) } };
    if (url.endsWith("/request")) return { ok: true, json: { success: true, paperwork: "sent" } };
    return { ok: false, status: 404, json: { success: false, error: "not found" } };
  };
}

function visit(lang: Lang, o: { search?: string; get?: unknown; getStatus?: number; post?: PostReply } = {}) {
  const els = new Map<string, El>();
  const el = (id: string) => { let e = els.get(id); if (!e) els.set(id, (e = new El(id))); return e; };
  const created: El[] = [];
  const doc = {
    documentElement: { lang }, title: "",
    getElementById: el,
    createElement: (tag: string) => {
      if (tag !== "div") { const e = new El(`created:${tag}`); created.push(e); return e; }
      let text = "";
      return { set textContent(v: string) { text = v; }, get innerHTML() { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); } };
    },
  };
  for (const m of html(lang).matchAll(/<[a-z0-9]+\s[^>]*?\bid="([^"]+)"[^>]*>/g)) if (/\shidden(?=[\s>=])/.test(m[0])) el(m[1]!).hidden = true;
  const requested: string[] = [];
  const sent: Sent[] = [];
  const post = o.post ?? server(lang);
  const loc: { search: string; hash: string; href?: string } = { search: o.search ?? `?t=${TOKEN}`, hash: "" };
  const sandbox = {
    document: doc, window: {}, location: loc, URLSearchParams, console, Date, JSON, Math, Number, String, Array, parseInt, isNaN, RegExp, Object, Promise,
    clearTimeout, setTimeout: (fn: () => void) => setTimeout(fn, 1),
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as Record<string, any>;
        sent.push({ url, body });
        return Promise.resolve(post(url, body)).then((x) => ({ ok: x.ok, status: x.status ?? (x.ok ? 200 : 400), json: () => Promise.resolve(x.json ?? { success: x.ok }) }));
      }
      requested.push(url);
      const status = o.getStatus ?? 200;
      return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(o.get ?? answer()) });
    },
  };
  runInNewContext(script(lang), sandbox);
  const flush = async (ms = 0) => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, ms || 0)); };
  const quiet = { preventDefault() { /* */ } };
  return {
    els, el, doc, requested, sent, created, loc, ready: () => flush(5), flush,
    posts: (suffix: string) => sent.filter((x) => x.url.endsWith(suffix)),
    /** A tap on the choices: a cabin, a yes/no, an insurance choice, a travel tick. */
    qtap: (g: string, v: string) => { el("d-qq").handlers["click"]!({ target: target({ "data-g": g, "data-v": v }), ...quiet }); },
    agree: () => { el("d-agree").handlers["click"]!({ target: target({}), ...quiet }); },
    qpills: () => [...el("d-qq").innerHTML.matchAll(/<button[^>]*data-g="([^"]+)" data-v="([^"]+)" aria-pressed="(true|false)">([^<]*)<\/button>/g)]
      .map((m) => ({ g: m[1]!, v: m[2]!, on: m[3] === "true", label: m[4]!.replace(/&amp;/g, "&").replace(/&#39;/g, "'") })),
    qticks: () => [...el("d-qq").innerHTML.matchAll(/<button[^>]*class="tickrow( on)?"[^>]*data-g="travel" data-v="([^"]+)"><span class="bx"><\/span><span>([^<]*)<\/span><\/button>/g)]
      .map((m) => ({ v: m[2]!, on: !!m[1], label: m[3]! })),
    /** The taps for a party that wants nothing extra (QA), then the quote. */
    async answerQuote() { this.qtap("flexpay", "no"); this.qtap("drinks", "no"); this.qtap("insurance", "decline"); this.qtap("need-hotel", "no"); this.qtap("need-transfer", "no"); await flush(8); },
    lines: () => [...el("d-quote-lines").innerHTML.matchAll(/<div class="qline( qtotal)?"><span>([^<]*)(?:<span class="det">([^<]*)<\/span>)?<\/span><b>([^<]*)<\/b><\/div>/g)].map((m) => [m[2], m[3] ?? null, m[4]]),
  };
}

// ── The two pages ─────────────────────────────────────────────────────────────────────────────────────────────

test("the two pages are one page in two languages: they differ only in the language, the title, the plaque and the bot-trap label", () => {
  const norm = (s: string) => s
    .replace('<html lang="en">', "<html>").replace('<html lang="es">', "<html>")
    .replace("<title>Your quote | Still Afloat Cruising</title>", "<title/>").replace("<title>Su cotización | Still Afloat Cruising</title>", "<title/>")
    .replace('id="d-plaque">Your quote</span>', 'id="d-plaque"></span>').replace('id="d-plaque">Su cotización</span>', 'id="d-plaque"></span>')
    .replace("<label>Website<input", "<label><input").replace("<label>Sitio web<input", "<label><input");
  assert.equal(norm(html("es")), norm(html("en")));
});

test("a private page: never indexed, its address never sent on, the details page's look, the guest's own API with the bot trap, the quote step's calls and 'Send my choices to Mark!'; no price written on the page", () => {
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    assert.match(h, /<meta name="robots" content="noindex, nofollow">/, lang);
    assert.match(h, /<meta name="referrer" content="no-referrer">/, lang);
    assert.ok(h.includes('<link rel="stylesheet" href="/css/details-page.css'), `${lang}: the details page's own stylesheet`);
    assert.ok(h.includes("/api/group-details/") && script(lang).includes("'/quote'") && script(lang).includes("'/request'"), `${lang}: the quote step's calls`);
    assert.ok(h.includes('id="d-website"') && h.includes('class="hp"'), `${lang}: the bot trap`);
    assert.ok(script(lang).includes("b.website = $('d-website').value"), `${lang}: the bot trap travels with every POST`);
    assert.ok(script(lang).includes(lang === "es" ? "¡Enviar mis decisiones a Mark!" : "Send my choices to Mark!"), `${lang}: the send button's words`);
    assert.ok(script(lang).includes(lang === "es" ? "Agendemos una cita breve con Mark para solicitarlo." : "Let's schedule a brief appointment with Mark to apply."), `${lang}: the FlexPay yes (Mark 2026-11-07)`);
    assert.ok(script(lang).includes(lang === "es" ? "/es/details.html" : "/details.html"), `${lang}: the page it sends a guest back to when the names are not in`);
    const header = h.slice(h.indexOf('<div class="hdr">'), h.indexOf('<div class="d-banner"'));
    assert.deepEqual([...header.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map((m) => m[1]), [BUSINESS.logoPath], `${lang}: header`);
    assert.ok(h.includes(`${BUSINESS.legalName} · ${BUSINESS.email}`), `${lang}: the footer's legal line`);
    assert.ok(h.includes('src="/assets/images/cornerstone-white.png"'), `${lang}: the Cornerstone logo`);
    assert.ok(!h.includes("navbar.js") && !h.includes("navbar-container"), `${lang}: the site menu`);
    const at = (needle: string) => { const i = h.indexOf(needle); assert.ok(i > 0, `${lang}: ${needle}`); return i; };
    const order = ['class="hdr"', 'class="d-banner"', 'id="d-intro"', 'id="d-part4"', 'id="d-agree"', 'id="d-thanks"', 'class="foot"'].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${lang}: the sections are out of order`);
    assert.ok(!h.includes('id="d-part1"') && !h.includes('id="d-hold"'), `${lang}: the names and the four questions are the details page's, not this one's`);
    assert.ok(!/type="(checkbox|password|tel|email)"|card number|cvv/i.test(h), `${lang}: a card, account or form-control field`);
    assert.ok(!/\$\s?\d/.test(h.replace(/<style\b[\s\S]*?<\/style>/g, " ")), `${lang}: a dollar amount is written on the page`);
    assert.ok(!/—/.test(h), `${lang}: an em dash`);
  }
});

// ── The quote step ────────────────────────────────────────────────────────────────────────────────────────────

test("the page opens on the choices once the names are in: the heading, the locked line, our pick already chosen among the file's cabins, FlexPay with its appointment wording, drinks, insurance from the file, the flight on offer WITHOUT its price, a yes/no for the hotel and the transfers; the send button waits; nothing is sent", async () => {
  const p = visit("en");
  await p.ready();
  assert.deepEqual(p.requested, [`/api/group-details/${TOKEN}`]);
  assert.equal(p.el("d-state").hidden, true);
  assert.equal(p.el("d-main").hidden, false);
  assert.equal(p.doc.title, "Your quote | Friends and Family 2027");
  assert.equal(p.el("d-plaque").textContent, "Friends and Family 2027");
  assert.equal(p.el("d-h1").textContent, "Nicely done… now let's build your quote!");
  assert.equal(p.el("d-lede").textContent, "Five quick choices, then the numbers. Mark confirms every figure with you before anything is charged.");
  assert.equal(p.el("d-part4").hidden, false);
  assert.equal(p.el("d-thanks").hidden, true, "nothing is sent yet");
  assert.equal(p.el("d-p4").textContent, "Your choices");
  assert.equal(p.el("d-locked").textContent, "Names are in for Mark and Ceci · party of two. Our pick: Balcony Bella. To change a name or a birthday, call or text Mark at 919-346-6127.");
  assert.equal(p.el("d-msg").textContent, "");
  const pills = p.qpills();
  assert.deepEqual(pills.filter((x) => x.g === "cabin").map((x) => [x.v, x.label, x.on]), [
    ["BEL", "Balcony Bella · $536.79 per person · taxes and port fees included", true],
    ["AUR", "Balcony Aurea · $686.79 per person · taxes and port fees included", false],
  ], "the file's categories with their fares, our pick already chosen");
  assert.deepEqual(pills.filter((x) => x.g === "flexpay").map((x) => [x.v, x.label, x.on]), [["yes", "Let's schedule a brief appointment with Mark to apply.", false], ["no", "No thanks", false]], "Mark 2026-11-07: the FlexPay yes is the appointment");
  assert.ok(p.el("d-qq").innerHTML.includes("FlexPay is an installment plan Mark offers separately from the cruise line."), "FlexPay is Mark's, apart from the cruise line, and promises no terms");
  assert.deepEqual(pills.filter((x) => x.g === "drinks").map((x) => x.label), ["Yes, price one for us", "No thanks"]);
  assert.deepEqual(pills.filter((x) => x.g === "insurance").map((x) => [x.v, x.label]), [["line", "MSC Cruise Protection · $99 per person"], ["own", "I have my own policy"], ["decline", "No insurance for us"]]);
  assert.deepEqual(p.qticks(), [{ v: "f1", on: false, label: "Flight from Raleigh (RDU)" }], "Mark 2026-11-07: no flight, hotel or transfer price before he finalizes the quote");
  assert.ok(p.el("d-qq").innerHTML.includes("Tick what you want added. Mark prices flights, hotel and transfers with your final quote."), "the travel note says why there is no price");
  assert.deepEqual(pills.filter((x) => x.g.startsWith("need-")).map((x) => x.g + ":" + x.v), ["need-hotel:yes", "need-hotel:no", "need-transfer:yes", "need-transfer:no"], "no hotel or transfer on offer: a yes/no each; the flight has its offer");
  assert.equal(p.el("d-agree").getAttribute("aria-disabled"), "true", "dim until every question is answered");
  assert.equal(p.el("d-agree-note").textContent, "Answer every question above and the button lights up.");
  assert.equal(p.el("d-quote").hidden, true);
  assert.equal(p.sent.length, 0, "nothing is sent before every answer is in");
  // the party in words: one, three, four
  for (const [n, word] of [[1, "one"], [3, "three"], [4, "four"]] as const) {
    const travelers = TWO.concat([{ legal_name: "Guest Three", dob: "1990-01-01" }, { legal_name: "Guest Four", dob: "1990-01-01" }]).slice(0, n);
    const q = visit("en", { get: answer({ travelers }) });
    await q.ready();
    assert.match(q.el("d-locked").textContent, new RegExp(`party of ${word}\\. Our pick: Balcony Bella\\.`));
  }
});

test("the quote: once every question is answered the page asks the server with the answers, shows the lines, the total, the deposit, the balance and the note, and lights the send button; a changed answer asks again; a ticked flight is 'to come', never a figure; sending it makes the WHOLE page one line with where the paperwork went", async () => {
  const p = visit("en");
  await p.ready();
  await p.answerQuote();
  const asked = p.posts("/quote");
  assert.equal(asked.length, 1, "one ask once the last answer is in");
  assert.deepEqual(asked[0]!.body, { answers: QA, lang: "en", website: "" });
  assert.equal(p.el("d-quote").hidden, false);
  assert.equal(p.el("d-quote-h").textContent, "Your starting price");
  assert.deepEqual(p.lines(), [
    ["Balcony Bella · 2 travelers", "Mark $536.79 · Ceci $536.79 · taxes and port fees included", "$1,073.58"],
    ["Travel insurance: none", null, ""],
    ["Total", null, "$1,073.58"],
  ]);
  assert.equal(p.el("d-quote-plus").hidden, true, "nothing left for Mark to price");
  assert.equal(p.el("d-quote-dep").textContent, "Deposit to hold the cabin: $100 ($50 per person). Nothing is charged until Mark confirms it with you.");
  assert.equal(p.el("d-quote-bal").textContent, "Balance $973.58, due by January 15, 2027.");
  assert.match(p.el("d-quote-note").textContent, /^Every figure comes from the group's file with the cruise line, and Mark confirms each one with you before anything is charged\. Pricing subject to change until finalized\.$/);
  assert.equal(p.el("d-agree").getAttribute("aria-disabled"), "false");
  assert.equal(p.el("d-agree").textContent, "Send my choices to Mark!");
  assert.equal(p.el("d-agree-note").textContent, "This is the group price before extras and upgrades. Mark prices your choices with the cruise line, then emails your paperwork with the final price for you to check and sign. Nothing is booked or charged yet.");
  // a changed answer: the quote goes until the new one is back, with Mark's items to price named
  p.qtap("drinks", "yes"); p.qtap("travel", "f1"); p.qtap("flexpay", "yes"); p.qtap("insurance", "line");
  assert.equal(p.el("d-quote").hidden, true, "the old figures are not shown for the new answers");
  await p.flush(8);
  assert.equal(p.posts("/quote").length, 2);
  assert.deepEqual(p.posts("/quote")[1]!.body["answers"], { ...QA, drinks: true, travel: ["f1"], flexpay: true, insurance: "line" });
  assert.equal(p.qticks()[0]!.on, true);
  assert.deepEqual(p.lines().map((l) => [l[0], l[2]]), [["Balcony Bella · 2 travelers", "$1,073.58"], ["Drink package", "to come"], ["Travel insurance: MSC Cruise Protection", "$198"], ["Flight from Raleigh (RDU)", "to come"], ["FlexPay", ""], ["Total", "$1,271.58"]], "the flight waits for Mark's finalized quote (Mark 2026-11-07): no figure, and not in the total");
  assert.ok(!/—/.test(p.el("d-quote-lines").innerHTML + p.el("d-qq").innerHTML), "no em dash on the quote step");
  assert.equal(p.el("d-quote-plus").textContent, "Plus Drink package and Flight from Raleigh (RDU), which Mark prices for you.", "two items: no comma before 'and'");
  p.qtap("need-hotel", "yes"); await p.flush(8);
  assert.equal(p.el("d-quote-plus").textContent, "Plus Drink package, Flight from Raleigh (RDU), and Hotel, which Mark prices for you.");
  // send
  p.agree(); await p.ready();
  assert.deepEqual(p.posts("/request").map((x) => x.body), [{ lang: "en", website: "" }]);
  for (const id of ["d-intro", "d-part4"]) assert.equal(p.el(id).hidden, true, id);
  assert.equal(p.el("d-thanks").hidden, false);
  assert.equal(p.el("d-thanks-h").textContent, "Your paperwork is on its way to mmillham1@gmail.com!… Balcony Bella, party of two. It carries your final price: check it and sign.");
  assert.equal(p.el("d-thanks-p").textContent, "Need to change a name, a birthday or your mind? Call or text Mark at 919-346-6127.");
  // when this box could not email them, the line says Mark sends the paperwork; a refused agreement keeps the button and shows its words
  const heldBox = visit("en", { post: (url, body) => (url.endsWith("/request") ? { ok: true, json: { success: true, paperwork: "held" } } : server("en")(url, body)) });
  await heldBox.ready(); await heldBox.answerQuote(); heldBox.agree(); await heldBox.ready();
  assert.equal(heldBox.el("d-thanks-h").textContent, "Your choices are with Mark!… Balcony Bella, party of two. He sends your paperwork next.");
  // Mark 2026-11-03: the paperwork waits for Mark to book the cabin and validate the travel
  const booking = visit("en", { post: (url, body) => (url.endsWith("/request") ? { ok: true, json: { success: true, paperwork: "booking" } } : server("en")(url, body)) });
  await booking.ready(); await booking.answerQuote(); booking.agree(); await booking.ready();
  assert.equal(booking.el("d-thanks-h").textContent, "Your choices are with Mark!… Balcony Bella, party of two. He is pricing them with the cruise line; your paperwork, with your final price, follows by email.");
  const refused = visit("en", { post: (url, body) => (url.endsWith("/request") ? { ok: false, status: 409, json: { success: false, error: "Your choices are with Mark and your paperwork follows by email. To change anything, call or text Mark at 919-346-6127." } } : server("en")(url, body)) });
  await refused.ready(); await refused.answerQuote(); refused.agree(); await refused.ready();
  assert.equal(refused.el("d-thanks").hidden, true);
  assert.equal(refused.el("d-part4").hidden, false);
  assert.equal(refused.el("d-msg").textContent, "Your choices are with Mark and your paperwork follows by email. To change anything, call or text Mark at 919-346-6127.");
  assert.equal(refused.el("d-agree").getAttribute("aria-disabled"), "false");
  // a quote the server refuses shows its words
  const noQuote = visit("en", { post: (url, body) => (url.endsWith("/quote") ? { ok: false, status: 400, json: { success: false, error: "Pick a cabin, please." } } : server("en")(url, body)) });
  await noQuote.ready(); await noQuote.answerQuote();
  assert.equal(noQuote.el("d-msg").textContent, "Pick a cabin, please.");
  assert.equal(noQuote.el("d-quote").hidden, true);
});

test("a returning guest finds the answers they gave last time and their quote back, and nothing is sent; once the choices are sent, the one line", async () => {
  const back = visit("en", { get: answer({ quote: buildQuote(FILE, TWO, { ...QA, insurance: "line", travel: ["f1"] }, "en") }) });
  await back.ready();
  assert.deepEqual(back.qpills().filter((x) => x.on).map((x) => x.g + ":" + x.v), ["cabin:BEL", "flexpay:no", "drinks:no", "insurance:line", "need-hotel:no", "need-transfer:no"]);
  assert.equal(back.qticks()[0]!.on, true);
  assert.equal(back.el("d-quote").hidden, false, "their quote is shown again");
  assert.equal(back.el("d-agree").getAttribute("aria-disabled"), "false");
  assert.equal(back.sent.length, 0, "nothing is re-sent until they change something");
  const agreed = visit("en", { get: answer({ quoteRequestedAt: "2026-10-24T10:10:00Z", paperwork: "sent", quote: buildQuote(FILE, TWO, QA, "en") }) });
  await agreed.ready();
  assert.equal(agreed.el("d-thanks").hidden, false);
  assert.equal(agreed.el("d-thanks-h").textContent, "Your paperwork is on its way to mmillham1@gmail.com!… Balcony Bella, party of two. It carries your final price: check it and sign.");
  assert.equal(agreed.el("d-thanks-p").hidden, false);
  for (const id of ["d-intro", "d-part4"]) assert.equal(agreed.el(id).hidden, true, id);
  assert.equal(agreed.sent.length, 0);
});

test("a guest whose names are not in yet is sent to the details page on the same link, and nothing is sent", async () => {
  const early = visit("en", { get: answer({ holdRequestedAt: null, quoteOptions: null, travelers: [], pick: null }) });
  await early.ready();
  assert.equal(early.loc.href, `/details.html?t=${TOKEN}`);
  assert.equal(early.el("d-main").hidden, true);
  assert.equal(early.sent.length, 0);
  const es = visit("es", { get: answer({ lang: "es", holdRequestedAt: null, quoteOptions: null, travelers: [], pick: null }) });
  await es.ready();
  assert.equal(es.loc.href, `/es/details.html?t=${TOKEN}`);
});

test("anything the guest or the file wrote is shown as text, never markup; a picture that is not https is never used", async () => {
  const bad = visit("en", { get: answer({ heroUrl: "javascript:alert(1)" }) });
  await bad.ready();
  assert.equal(bad.created.length, 0);
  const evil = '"><img src=x onerror=alert(1)>';
  const held = visit("en", { get: answer({ label: evil, businessPhone: evil, travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }], pick: { ...PICK, category: evil }, quoteOptions: { ...OPTIONS("en"), cabins: [{ ...OPTIONS("en").cabins[0]!, label: evil }] } }) });
  await held.ready();
  assert.equal(held.el("d-plaque").textContent, evil, "text only, through textContent");
  assert.ok(held.el("d-locked").textContent.includes(evil) && !held.el("d-locked").innerHTML.includes("<img"), "the locked line is text");
  assert.ok(held.el("d-qq").innerHTML.includes("&lt;img") && !held.el("d-qq").innerHTML.includes("<img"), "a cabin's label from the file is escaped");
  const agreed = visit("en", { get: answer({ quoteRequestedAt: "2026-10-24T10:10:00Z", paperwork: "sent", email: evil, businessPhone: evil, quote: { version: 1, answers: QA, lines: [], category: evil, party: 2 } }) });
  await agreed.ready();
  assert.ok(agreed.el("d-thanks-h").textContent.includes(evil) && !agreed.el("d-thanks-h").innerHTML.includes("<img"));
  assert.ok(agreed.el("d-thanks-p").textContent.includes(evil));
});

test("a missing, short or odd link never reaches the server; an unknown one says the link is not valid and names the phone", async () => {
  for (const search of ["", "?t=short", `?t=${"A".repeat(44)}`, "?t=has%20a%20space%20and%20is%20fortythree%20chars%20x"]) {
    const p = visit("en", { search });
    await p.ready();
    assert.equal(p.requested.length, 0, search);
    assert.equal(p.el("d-state").textContent, "This link is not valid. Please open the whole link from your email, or call or text Mark at 919-346-6127.");
  }
  const gone = visit("en", { getStatus: 404 });
  await gone.ready();
  assert.equal(gone.el("d-state").textContent, "This link is not valid. Please open the whole link from your email, or call or text Mark at 919-346-6127.");
  assert.equal(gone.el("d-main").hidden, true);
});

test("the Spanish page says everything in Spanish, in usted, through the same steps", async () => {
  const perks = ["Un restaurante propio", "El spa solo para adultos", "Un solárium escondido"];
  const get = answer({ lang: "es", firstName: "Ana", lastName: "Pérez", label: "Amigos y Familia 2027", travelers: [{ legal_name: "Ana Pérez", dob: "1965-04-12" }, { legal_name: "Luis Pérez", dob: "1980-11-02" }], pick: pickCabin(ANSWERS, HELD, "es", perks), quoteOptions: OPTIONS("es") });
  const p = visit("es", { get, post: server("es") });
  await p.ready();
  assert.equal(p.doc.title, "Su cotización | Amigos y Familia 2027");
  assert.equal(p.el("d-h1").textContent, "Bien hecho… ¡ahora armemos su cotización!");
  assert.equal(p.el("d-lede").textContent, "Cinco decisiones rápidas y luego los números. Mark confirma cada cifra con usted antes de cobrar nada.");
  assert.equal(p.el("d-p4").textContent, "Sus decisiones");
  assert.equal(p.el("d-locked").textContent, "Nombres registrados: Ana y Luis · grupo de dos. Nuestra sugerencia: Balcony Bella. Para cambiar un nombre o una fecha de nacimiento, llame o escriba a Mark al 919-346-6127.");
  assert.deepEqual(p.qpills().filter((x) => x.g === "cabin").map((x) => x.label), ["Balcony Bella · $536.79 por persona · impuestos y tasas portuarias incluidos", "Balcony Aurea · $686.79 por persona · impuestos y tasas portuarias incluidos"]);
  assert.deepEqual(p.qpills().filter((x) => x.g === "flexpay").map((x) => x.label), ["Agendemos una cita breve con Mark para solicitarlo.", "No, gracias"]);
  assert.deepEqual(p.qpills().filter((x) => x.g === "insurance").map((x) => x.label), ["MSC Cruise Protection · $99 por persona", "Tengo mi propia póliza", "Sin seguro para nosotros"]);
  assert.deepEqual(p.qticks().map((x) => x.label), ["Vuelo desde Raleigh (RDU)"]);
  await p.answerQuote();
  assert.equal(p.sent.find((x) => x.url.endsWith("/quote"))!.body["lang"], "es");
  assert.equal(p.el("d-quote-h").textContent, "Su precio inicial");
  assert.equal(p.el("d-quote-dep").textContent, "Depósito para apartar la cabina: $100 ($50 por persona). No se cobra nada hasta que Mark lo confirme con usted.");
  assert.equal(p.el("d-quote-bal").textContent, "Saldo $973.58, a pagar antes del 15 de enero de 2027.");
  assert.equal(p.el("d-agree").textContent, "¡Enviar mis decisiones a Mark!");
  p.agree(); await p.ready();
  assert.equal(p.el("d-thanks-h").textContent, "¡Sus documentos van en camino a mmillham1@gmail.com!… Balcony Bella, grupo de dos. Traen su precio final: revíselos y firme.");
  const again = visit("es", { get: answer({ lang: "es", quoteRequestedAt: "2026-10-24T10:10:00Z", paperwork: "held", travelers: [{ legal_name: "Ana Pérez", dob: "1965-04-12" }], pick: pickCabin(ANSWERS, HELD, "es", perks), quoteOptions: OPTIONS("es"), quote: buildQuote(FILE, [{ legal_name: "Ana Pérez", dob: "1965-04-12" }], QA, "es") }) });
  await again.ready();
  assert.equal(again.el("d-thanks-h").textContent, "¡Sus decisiones ya están con Mark!… Balcony Bella, para una persona. Él le envía sus documentos después.");
  assert.equal(again.el("d-thanks-p").textContent, "¿Necesita cambiar un nombre, una fecha de nacimiento o de opinión? Llame o escriba a Mark al 919-346-6127.");
});
