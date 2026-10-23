// details-page.test.ts — the guest's "Your details" page (server/public/details.html and its Spanish twin), run the way a visitor's browser runs it
// (Mark 2026-10-23, design 5b: "auto fill what we have, then ask for DOB, have them run through the room concierge questions").
//
// The page script is executed against a minimal stand-in for the browser (just enough DOM for what the script touches), fed the answer the server's
// GET /api/group-details/:token gives and a stand-in for its POSTs, so a field the page reads and the server stopped sending, a question that drifted
// from the Room Concierge's, or a step that sends the wrong thing fails here and not in front of a guest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { EXPECT_QS } from "./concierge-interview";
import { BUSINESS } from "./group-secure";
import { pickCabin } from "./group-details";

// Built to dist-test/lib/, so the site is two levels up.
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "../../public");
type Lang = "en" | "es";
const PAGES: Record<Lang, string> = { en: "details.html", es: "es/details.html" };
const html = (lang: Lang) => readFileSync(join(PUBLIC, PAGES[lang]), "utf8");
const script = (lang: Lang) => /<script>\n([\s\S]*?)<\/script>/.exec(html(lang))![1]!;
// The page's look lives in a shared same-site stylesheet under /css/ (2026-10-23: the release gate's crawl counts same-site
// stylesheets, and both language twins share one look), so the CSS is read from the file the page links.
const css = (lang: Lang) => {
  const m = /<link rel="stylesheet" href="\/css\/([a-z-]+\.css)[^"]*">/.exec(html(lang));
  assert.ok(m, `${lang}: the page links its stylesheet from /css/`);
  return readFileSync(join(PUBLIC, "css", m![1]!), "utf8");
};

const TOKEN = "T".repeat(43);
const HELD = [{ category: "Balcony Bella", perPersonText: "$536.79" }, { category: "Balcony Aurea", perPersonText: "$686.79" }];

/** The answer GET /api/group-details/:token gives (the server's own shape; each test changes what it needs). */
function answer(over: Record<string, unknown> = {}) {
  return {
    success: true, label: "Friends and Family 2027", ship: "MSC Seashore", sailDateText: "May 9, 2027", returnDateText: "May 13, 2027", heroUrl: "https://stillafloatcruising.com/assets/images/hero.jpg",
    firstName: "Mark", lastName: "Millham", email: "mmillham1@gmail.com", phone: null, guests: 2, travelers: [], concierge: null, pick: null, choice: null, holdRequestedAt: null,
    held: HELD, taxesIncluded: true, depositPerPersonText: "$50", phoneLine: "Questions? Call or text Mark at 919-346-6127.", businessPhone: "919-346-6127", lang: "en",
    ...over,
  };
}
const ANSWERS = { room: "balcony", priority: "quiet", budget: "middle", motion: "yes" } as const;
const PICK = pickCabin(ANSWERS, HELD, "en", true);

// ── The browser stand-in ─────────────────────────────────────────────────────────────────────────────────────

type Handler = (e: { target: Target; preventDefault(): void }) => void;
class El {
  textContent = ""; innerHTML = ""; hidden = false; className = ""; value = ""; disabled = false; alt = ""; decoding = ""; src = "";
  onload: (() => void) | null = null; onerror: (() => void) | null = null; parentNode: El | null = null; firstChild: El | null = null;
  handlers: Record<string, Handler> = {};
  kids: El[] = [];
  constructor(readonly id: string) {}
  addEventListener(type: string, fn: Handler) { this.handlers[type] = fn; }
  appendChild(c: El) { c.parentNode = this; this.kids.push(c); return c; }
  insertBefore(c: El) { c.parentNode = this; this.kids.unshift(c); this.firstChild = c; return c; }
  removeChild() { /* nothing */ }
}
interface Target { getAttribute(k: string): string | null; value: string; className: string }
const target = (attrs: Record<string, string>, value = ""): Target => ({ getAttribute: (k) => attrs[k] ?? null, value, className: "" });

type Sent = { url: string; body: Record<string, any> };
type PostReply = (url: string, body: Record<string, any>) => { ok: boolean; status?: number; json?: unknown } | Promise<{ ok: boolean; status?: number; json?: unknown }>;

function visit(lang: Lang, o: { search?: string; get?: unknown; getStatus?: number; post?: PostReply } = {}) {
  const els = new Map<string, El>();
  const el = (id: string) => { let e = els.get(id); if (!e) els.set(id, (e = new El(id))); return e; };
  const created: El[] = [];
  const doc = {
    documentElement: { lang }, title: "",
    getElementById: el,
    createElement: (tag: string) => {
      if (tag !== "div") { const e = new El(`created:${tag}`); created.push(e); return e; }
      // the page escapes text through a <div>: textContent in, innerHTML (escaped) out
      let text = "";
      return { set textContent(v: string) { text = v; }, get innerHTML() { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); } };
    },
  };
  // an element that starts hidden in the page's own markup starts hidden here, so "the page showed it" means the script un-hid it
  for (const m of html(lang).matchAll(/<[a-z0-9]+\s[^>]*?\bid="([^"]+)"[^>]*>/g)) if (/\shidden(?=[\s>=])/.test(m[0])) el(m[1]!).hidden = true;
  const requested: string[] = [];
  const sent: Sent[] = [];
  const sandbox = {
    document: doc, window: {}, location: { search: o.search ?? `?t=${TOKEN}`, hash: "" }, URLSearchParams, console, Date, JSON, Math, Number, String, Array, parseInt, isNaN, RegExp, Object,
    clearTimeout, setTimeout: (fn: () => void) => setTimeout(fn, 1),
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as Record<string, any>;
        sent.push({ url, body });
        const r = o.post ? o.post(url, body) : { ok: true, json: { success: true } };
        return Promise.resolve(r).then((x) => ({ ok: x.ok, status: x.status ?? (x.ok ? 200 : 400), json: () => Promise.resolve(x.json ?? { success: x.ok }) }));
      }
      requested.push(url);
      const status = o.getStatus ?? 200;
      return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(o.get ?? answer()) });
    },
  };
  runInNewContext(script(lang), sandbox);
  const flush = async (ms = 0) => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, ms || 0)); };
  const trav = () => el("d-travs");
  const nameValue = (i: number) => new RegExp(`id="d-name-${i}"[^>]*value="([^"]*)"`).exec(trav().innerHTML)?.[1];
  const dobValue = (i: number) => new RegExp(`id="d-dob-${i}"[^>]*value="([^"]*)"`).exec(trav().innerHTML)?.[1];
  return {
    els, el, doc, requested, sent, created, ready: () => flush(5),
    blocks: () => (trav().innerHTML.match(/class="trav"/g) ?? []).length,
    nameValue, dobValue,
    typeName: (i: number, v: string) => { trav().handlers["input"]!({ target: target({ "data-i": String(i), "data-f": "name" }, v), preventDefault() { /* */ } }); },
    typeDob: (i: number, v: string) => { trav().handlers["input"]!({ target: target({ "data-i": String(i), "data-f": "dob" }, v), preventDefault() { /* */ } }); },
    remove: (i: number) => { trav().handlers["click"]!({ target: target({ "data-act": "remove", "data-i": String(i) }), preventDefault() { /* */ } }); },
    add: () => { el("d-add").handlers["click"]!({ target: target({}), preventDefault() { /* */ } }); },
    tap: (q: string, idx: number) => { el("d-qs").handlers["click"]!({ target: target({ "data-q": q, "data-i": String(idx) }), preventDefault() { /* */ } }); },
    hold: () => { el("d-hold").handlers["click"]!({ target: target({}), preventDefault() { /* */ } }); },
    change: () => { el("d-change").handlers["click"]!({ target: target({}), preventDefault() { /* */ } }); },
    pills: () => [...el("d-qs").innerHTML.matchAll(/<button[^>]*data-q="([^"]+)" data-i="(\d+)" data-v="([^"]+)" aria-pressed="(true|false)">([^<]*)<\/button>/g)]
      .map((m) => ({ q: m[1]!, i: Number(m[2]), v: m[3]!, on: m[4] === "true", label: m[5]!.replace(/&amp;/g, "&").replace(/&#39;/g, "'") })),
    /** Fill the form the way a guest would: both names and birthdays, and the four taps (room = balcony, priority = quiet, budget = middle, motion = yes). */
    async fillAll(o2: { second?: string } = {}) {
      this.typeName(0, "Mark Millham"); this.typeDob(0, "1965-04-12");
      this.typeName(1, o2.second ?? "Ceci Millham"); this.typeDob(1, "1980-11-02");
      this.tap("room", 2); this.tap("priority", 1); this.tap("budget", 1); this.tap("motion", 0);
      await flush(8);
    },
  };
}

// ── The two pages ─────────────────────────────────────────────────────────────────────────────────────────────

test("the two pages are one page in two languages: they differ only in the language, the title, the plaque and the bot-trap label", () => {
  const norm = (s: string) => s
    .replace('<html lang="en">', "<html>").replace('<html lang="es">', "<html>")
    .replace("<title>Your details | Still Afloat Cruising</title>", "<title/>").replace("<title>Sus datos | Still Afloat Cruising</title>", "<title/>")
    .replace('id="d-plaque">Your details</span>', 'id="d-plaque"></span>').replace('id="d-plaque">Sus datos</span>', 'id="d-plaque"></span>')
    .replace("<label>Website<input", "<label><input").replace("<label>Sitio web<input", "<label><input");
  assert.equal(norm(html("es")), norm(html("en")));
});

test("a private page: never indexed, its address never sent on, it calls the guest's own API and carries the bot trap and 'Hold my cabin'", () => {
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    assert.match(h, /<meta name="robots" content="noindex, nofollow">/, lang);
    assert.match(h, /<meta name="referrer" content="no-referrer">/, lang);
    assert.ok(h.includes("/api/group-details/"), lang);
    assert.ok(h.includes('id="d-website"') && h.includes('class="hp"'), `${lang}: the bot trap`);
    assert.ok(script(lang).includes(lang === "es" ? "Apartar mi cabina" : "Hold my cabin"), `${lang}: the button's words`);
    assert.ok(script(lang).includes("body.website") || script(lang).includes("b.website = $('d-website').value"), `${lang}: the bot trap travels with every POST`);
    // the header is the logo only; the footer is the group page's: the legal line and the Cornerstone logo
    const header = h.slice(h.indexOf('<div class="hdr">'), h.indexOf('<div class="d-banner"'));
    assert.deepEqual([...header.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map((m) => m[1]), [BUSINESS.logoPath], `${lang}: header`);
    assert.ok(!/<a\b|<nav\b/.test(header), `${lang}: a link or menu in the header`);
    assert.ok(h.includes(`${BUSINESS.legalName} · ${BUSINESS.email}`), `${lang}: the footer's legal line`);
    assert.ok(h.includes('src="/assets/images/cornerstone-white.png"'), `${lang}: the Cornerstone logo`);
    assert.ok(!h.includes("navbar.js") && !h.includes("navbar-container"), `${lang}: the site menu`);
    // the order of the page: intro, who is coming, the four questions, our pick, the thank-you, the footer
    const at = (needle: string) => { const i = h.indexOf(needle); assert.ok(i > 0, `${lang}: ${needle}`); return i; };
    const order = ['class="hdr"', 'class="d-banner"', 'id="d-intro"', 'id="d-part1"', 'id="d-part2"', 'id="d-part3"', 'id="d-thanks"', 'class="foot"'].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${lang}: the sections are out of order`);
    // no money is taken and no card is asked for on this page
    assert.ok(!/type="(checkbox|password|tel|email)"|card number|cvv/i.test(h), `${lang}: a card or account field`);
  }
});

test("the page's look is the group page's: a centered column of at most 640px, a navy page, cloud-white panels, the yellow pill, and no white text under 15px", () => {
  for (const lang of ["en", "es"] as const) {
    const c = css(lang);
    assert.match(c, /\.wrap\{max-width:640px;margin:0 auto\}/);
    assert.match(c, /--navy:#07183f;--cloud:#f7fbff;--gold:#ffca4f;--yellow:#f5c33b/);
    assert.match(c, /html,body\{margin:0;background:var\(--navy\)\}/);
    assert.match(c, /\.btn\{[^}]*background:#f5c33b;color:#07183f/);
    assert.match(c, /\.pick\{[^}]*border:2px solid var\(--gold\)/, "the pick sits in the gold-bordered card");
    assert.match(c, /body\{[^}]*font-size:20px/);
    const flat = c.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of flat.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const [sel, body] = [m[1]!.trim(), m[2]!];
      if (!/(^|;)\s*color:(#fff\b|#ffffff|rgba\(255,255,255)/.test(body)) continue;
      const size = /font-size:(\d+(?:\.\d+)?)px/.exec(body)?.[1];
      if (size) assert.ok(Number(size) >= 15, `${lang}: white text of ${size}px in ${sel}`);
    }
  }
});

// ── The four questions are the Room Concierge's ───────────────────────────────────────────────────────────────

test("the four questions carry the Room Concierge's own answer values, in its order, and the design's words", async () => {
  const DESIGN = [
    ["room", "How do you picture using your room?", ["Crash and recharge", "Wake up to daylight and water", "Coffee outside in my pajamas", "The room is part of the vacation"]],
    ["priority", "What matters most once you're aboard?", ["Waking up to the ocean", "Peace and quiet", "Being near the action", "Room to spread out"]],
    ["budget", "How does the trip budget work, honestly?", ["There's a number, and we respect it", "Comfortable, but every dollar should earn its spot", "For the right room, the budget moves", "The budget is whatever makes it perfect"]],
    ["motion", "Does anyone get seasick?", ["Yes, keep us steady", "No, we're fine", "I can grin and bear it"]],
  ] as const;
  for (const lang of ["en", "es"] as const) {
    const p = visit(lang);
    await p.ready();
    const pills = p.pills();
    for (const [key, , labels] of DESIGN) {
      const mine = pills.filter((x) => x.q === key);
      const theirs = EXPECT_QS.find((q) => q.key === key)!.options.filter((o) => !(key === "room" && o.label.startsWith("Honestly, no idea")));
      assert.deepEqual(mine.map((x) => x.v), theirs.map((o) => o.value), `${lang}: ${key} values (the page and lib/concierge-interview.ts have drifted)`);
      assert.equal(mine.length, labels.length, `${lang}: ${key} count`);
      if (lang === "en") assert.deepEqual(mine.map((x) => x.label), [...labels], `${key} labels`);
    }
    if (lang === "en") for (const [, q] of DESIGN) assert.ok(p.el("d-qs").innerHTML.includes(q.replace(/'/g, "&#39;")) || p.el("d-qs").innerHTML.includes(q), `the question: ${q}`);
    assert.equal(pills.length, 15);
    assert.ok(pills.every((x) => !x.on), "nothing is pre-answered for a new guest");
  }
});

// ── What the page fills in ────────────────────────────────────────────────────────────────────────────────────

test("it opens filled in with what we have: their name in the heading, the plaque and tab, how to reach them, one block per person with the first named, birthdays empty", async () => {
  const p = visit("en");
  await p.ready();
  assert.deepEqual(p.requested, [`/api/group-details/${TOKEN}`]);
  assert.equal(p.el("d-state").hidden, true);
  assert.equal(p.el("d-main").hidden, false);
  assert.equal(p.doc.title, "Your details | Friends and Family 2027");
  assert.equal(p.el("d-plaque").textContent, "Friends and Family 2027");
  assert.equal(p.el("d-h1").textContent, "Let's get you a cabin, Mark.");
  assert.equal(p.el("d-lede").textContent, "We've filled in what you already gave us. Three short parts, about three minutes, and your cabin is held.");
  assert.equal(p.el("d-p1").textContent, "Part 1 · Who's coming");
  assert.equal(p.el("d-reach").textContent, "mmillham1@gmail.com");
  assert.equal(p.el("d-count").textContent, "2");
  assert.equal(p.el("d-p1note").textContent, "The cruise line needs each traveler's legal name and date of birth to hold a cabin. Passport numbers come later, on your paperwork page.");
  assert.equal(p.blocks(), 2);
  assert.equal(p.nameValue(0), "Mark Millham");
  assert.equal(p.nameValue(1), "");
  assert.equal(p.dobValue(0), ""); assert.equal(p.dobValue(1), "");
  assert.match(p.el("d-travs").innerHTML, /Traveler 1 · you/); assert.match(p.el("d-travs").innerHTML, /Traveler 2/);
  assert.match(p.el("d-travs").innerHTML, /Legal name, as on your passport/); assert.match(p.el("d-travs").innerHTML, /Legal name, as on their passport/);
  assert.match(p.el("d-travs").innerHTML, /<input id="d-dob-0" type="date"/, "the birthday is a date field");
  assert.equal(p.el("d-p2").textContent, "Part 2 · Which cabin suits you");
  assert.equal(p.el("d-p2intro").textContent, "Four questions from our Room Concierge. Tap one answer each.");
  assert.equal(p.el("d-part3").hidden, true, "our pick is not shown before they have answered");
  assert.equal(p.el("d-thanks").hidden, true);
  assert.equal(p.sent.length, 0, "opening the page sends nothing");
  assert.equal(p.created.filter((e) => e.id === "created:img").length, 1);
  assert.equal(p.created[0]!.src, "https://stillafloatcruising.com/assets/images/hero.jpg");
});

test("a phone-only reply shows the phone to reach them; a one-word name fills the first block; the party size is 1 to 12 whatever was said", async () => {
  const one = visit("en", { get: answer({ email: null, phone: "919-346-6127", firstName: "Cher", lastName: "", guests: 1 }) });
  await one.ready();
  assert.equal(one.el("d-reach").textContent, "919-346-6127");
  assert.equal(one.nameValue(0), "Cher");
  assert.equal(one.blocks(), 1);
  for (const [guests, expect] of [[null, 1], [0, 1], [5, 5], [40, 12], ["3", 3]] as const) {
    const p = visit("en", { get: answer({ guests }) });
    await p.ready();
    assert.equal(p.blocks(), expect, `guests ${String(guests)}`);
  }
});

test("the top picture's credit line is in the footer, in the group page's compact form, and only when there is one", async () => {
  const none = visit("en");
  await none.ready();
  assert.equal(none.el("d-credits").hidden, true);
  const p = visit("en", { get: answer({ credits: ["Photo: Symbiosis · CC BY 2.0 · Wikimedia Commons"] }) });
  await p.ready();
  assert.equal(p.el("d-credits").hidden, false);
  assert.equal(p.el("d-credits").textContent, "Photo: Symbiosis (CC BY 2.0) · Wikimedia Commons");
  const two = visit("en", { get: answer({ credits: ["Photo: A · CC0 · Wikimedia Commons", "Photo: B · CC BY 4.0 · Wikimedia Commons", "Photo: A · CC0 · Wikimedia Commons"] }) });
  await two.ready();
  assert.equal(two.el("d-credits").textContent, "Photos: A (CC0) · B (CC BY 4.0) · Wikimedia Commons");
  const es = visit("es", { get: answer({ credits: ["Photo: Symbiosis · CC BY 2.0 · Wikimedia Commons"] }) });
  await es.ready();
  assert.equal(es.el("d-credits").textContent, "Foto: Symbiosis (CC BY 2.0) · Wikimedia Commons");
  const other = visit("en", { get: answer({ credits: ["Photo by the cruise line's press office"] }) });
  await other.ready();
  assert.equal(other.el("d-credits").textContent, "Photo by the cruise line's press office");
  // the line is plain text, never markup, and the footer's small print is at least 15px
  const evil = visit("en", { get: answer({ credits: ["<b>x</b>"] }) });
  await evil.ready();
  assert.equal(evil.el("d-credits").textContent, "<b>x</b>");
  assert.match(css("en"), /\.foot \.credits\{[^}]*font-size:15px/);
});

test("a picture that is not https is never used, and anything the guest or the file wrote is escaped, never markup", async () => {
  const bad = visit("en", { get: answer({ heroUrl: "javascript:alert(1)" }) });
  await bad.ready();
  assert.equal(bad.created.length, 0);
  const evil = '"><img src=x onerror=alert(1)>';
  const p = visit("en", { get: answer({ firstName: evil, lastName: "", label: evil }) });
  await p.ready();
  assert.ok(!p.el("d-travs").innerHTML.includes("<img"), p.el("d-travs").innerHTML);
  assert.ok(p.el("d-travs").innerHTML.includes("&lt;img") || p.el("d-travs").innerHTML.includes("&quot;&gt;"), "escaped");
  assert.equal(p.el("d-plaque").textContent, evil, "text only, through textContent");
});

// ── Part 3 appears when everything is in ──────────────────────────────────────────────────────────────────────

test("our pick appears only once every name and birthday is valid and all four questions are answered; then the form is saved and the pick shown in the gold card", async () => {
  const p = visit("en", { post: () => ({ ok: true, json: { success: true, pick: PICK } }) });
  await p.ready();
  p.typeName(0, "Mark Millham"); p.typeDob(0, "1965-04-12"); p.typeName(1, "Ceci Millham"); p.typeDob(1, "1980-11-02");
  p.tap("room", 2); p.tap("priority", 1); p.tap("budget", 1);
  await p.ready();
  assert.equal(p.el("d-part3").hidden, true, "three of four answers");
  assert.equal(p.sent.length, 0);
  assert.equal(p.el("d-wait").hidden, false);
  p.tap("motion", 0);
  await p.ready();
  assert.equal(p.sent.length, 1, "saved once");
  assert.equal(p.sent[0]!.url, `/api/group-details/${TOKEN}`);
  assert.deepEqual(p.sent[0]!.body, {
    travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }],
    concierge: { room: "balcony", priority: "quiet", budget: "middle", motion: "yes" }, lang: "en", website: "",
  });
  assert.equal(p.el("d-part3").hidden, false);
  assert.equal(p.el("d-p3").textContent, "Part 3 · Our pick for you");
  assert.equal(p.el("d-pick-h").textContent, "Balcony Bella, midship, a lower deck");
  assert.equal(p.el("d-pick-why").textContent, "Steady for whoever feels the motion, quiet away from the pool deck, and a balcony for that coffee. From $536.79 per person, taxes and port fees included.");
  assert.equal(p.el("d-pick-alt").textContent, "Want Balcony Aurea instead? Tell Mark when he confirms.");
  assert.equal(p.el("d-pick-alt").hidden, false);
  assert.equal(p.el("d-hold").textContent, "Hold my cabin");
  assert.equal(p.el("d-hold-note").textContent, "Mark confirms it with the cruise line and sends your paperwork. $50 per person holds it. Nothing is charged here.");
  assert.equal(p.el("d-rather").textContent, "Rather talk it through? Call or text Mark at 919-346-6127.");
  assert.equal(p.el("d-wait").hidden, true);
  // the selected pills are marked
  assert.deepEqual(p.pills().filter((x) => x.on).map((x) => `${x.q}:${x.v}`), ["room:balcony", "priority:quiet", "budget:middle", "motion:yes"]);
});

test("a name or birthday that the server would refuse keeps Part 3 away (and sends nothing): markup, one letter, a birthday in the future or in no calendar, and nothing typed", async () => {
  for (const [name, dob] of [["<b>Mark</b>", "1965-04-12"], ["M", "1965-04-12"], ["Mark Millham", "2999-01-01"], ["Mark Millham", "1965-02-30"], ["Mark Millham", ""], ["", "1965-04-12"], ["Mark Millham", "1800-01-01"]] as const) {
    const p = visit("en");
    await p.ready();
    await p.fillAll();
    p.typeName(0, name); p.typeDob(0, dob);
    await p.ready();
    assert.equal(p.el("d-part3").hidden, true, `${name} / ${dob}`);
    assert.equal(p.sent.filter((x) => x.url === `/api/group-details/${TOKEN}`).length <= 1, true);
  }
  // after a refused name nothing further is sent, and fixing it brings the pick back
  const p = visit("en", { post: () => ({ ok: true, json: { success: true, pick: PICK } }) });
  await p.ready();
  await p.fillAll();
  assert.equal(p.el("d-part3").hidden, false);
  const sentBefore = p.sent.length;
  p.typeName(1, "<script>");
  await p.ready();
  assert.equal(p.el("d-part3").hidden, true, "a bad name takes the pick away");
  assert.equal(p.sent.length, sentBefore);
  p.typeName(1, "Ceci Millham");
  await p.ready();
  assert.equal(p.el("d-part3").hidden, false);
});

test("people change their minds: add up to twelve travelers, remove any but the first, and the count follows; the save carries exactly who is listed", async () => {
  const p = visit("en", { post: () => ({ ok: true, json: { success: true, pick: PICK } }) });
  await p.ready();
  assert.equal(p.blocks(), 2);
  p.add(); p.add();
  assert.equal(p.blocks(), 4);
  assert.equal(p.el("d-count").textContent, "4");
  for (let i = 0; i < 12; i++) p.add();
  assert.equal(p.blocks(), 12);
  assert.equal(p.el("d-add").hidden, true, "no thirteenth traveler");
  assert.equal(p.el("d-max").hidden, false);
  assert.equal(p.el("d-max").textContent, "Twelve is the most on one list. Call or text Mark for a bigger party.");
  assert.ok(!/data-act="remove" data-i="0"/.test(p.el("d-travs").innerHTML), "the first traveler cannot be removed");
  p.remove(0);
  assert.equal(p.blocks(), 12, "a remove of the first block does nothing wrong");
  for (let i = 0; i < 10; i++) p.remove(1);
  assert.equal(p.blocks(), 2);
  assert.equal(p.el("d-add").hidden, false);
  p.remove(1);
  assert.equal(p.blocks(), 1);
  assert.ok(!p.el("d-travs").innerHTML.includes('data-act="remove"'), "one traveler left: nothing to remove");
  p.remove(0);
  assert.equal(p.blocks(), 1);
  // a party of one is valid
  p.typeName(0, "Mark Millham"); p.typeDob(0, "1965-04-12");
  p.tap("room", 2); p.tap("priority", 1); p.tap("budget", 1); p.tap("motion", 1);
  await p.ready();
  assert.equal(p.sent.length, 1);
  assert.deepEqual(p.sent[0]!.body["travelers"], [{ legal_name: "Mark Millham", dob: "1965-04-12" }]);
  assert.equal(p.sent[0]!.body["concierge"].motion, "no");
  // what was typed in the other blocks survives adding one
  p.add(); p.typeName(1, "Ceci Millham");
  p.add();
  assert.equal(p.nameValue(1), "Ceci Millham");
});

test("the 'grin and bear it' answer counts as a no, and both no-answers show as chosen only for the one tapped", async () => {
  const p = visit("en", { post: () => ({ ok: true, json: { success: true, pick: PICK } }) });
  await p.ready();
  p.tap("motion", 2);
  assert.deepEqual(p.pills().filter((x) => x.q === "motion" && x.on).map((x) => x.label), ["I can grin and bear it"]);
  await p.fillAll();
  p.tap("motion", 2);
  await p.ready();
  assert.equal(p.sent[p.sent.length - 1]!.body["concierge"].motion, "no");
  assert.deepEqual(p.pills().filter((x) => x.q === "motion" && x.on).map((x) => x.label), ["I can grin and bear it"]);
});

test("when the server refuses the save, its words are shown and Part 3 stays away; a change made while it was saving is not answered with the old pick", async () => {
  const refused = visit("en", { post: () => ({ ok: false, json: { success: false, error: "Traveler 2: that date of birth does not look right. Please check it." } }) });
  await refused.ready();
  await refused.fillAll();
  assert.equal(refused.el("d-part3").hidden, true);
  assert.equal(refused.el("d-msg").textContent, "Traveler 2: that date of birth does not look right. Please check it.");
  assert.equal(refused.el("d-msg").className, "msg err");

  let release: () => void = () => undefined;
  const slow = visit("en", { post: () => new Promise((resolve) => { release = () => resolve({ ok: true, json: { success: true, pick: PICK } }); }) });
  await slow.ready();
  await slow.fillAll();
  assert.equal(slow.sent.length, 1);
  slow.tap("budget", 2);          // they change an answer while the first save is still out
  release();
  await slow.ready();
  assert.equal(slow.el("d-part3").hidden, true, "the old pick is not shown for the new answers");
  release();
  await slow.ready();
  assert.equal(slow.sent.length, 2, "the changed form is saved again");
  assert.equal(slow.sent[1]!.body["concierge"].budget, "treat");
  assert.equal(slow.el("d-part3").hidden, false);

  const down = visit("en", { post: () => Promise.reject(new Error("offline")) });
  await down.ready();
  await down.fillAll();
  assert.equal(down.el("d-part3").hidden, true);
  assert.match(down.el("d-msg").textContent, /call or text Mark at 919-346-6127/);
});

test("the bot trap field travels with every save and every hold", async () => {
  const p = visit("en", { post: () => ({ ok: true, json: { success: true, pick: PICK } }) });
  await p.ready();
  p.el("d-website").value = "http://spam.example";
  await p.fillAll();
  p.hold();
  await p.ready();
  assert.deepEqual(p.sent.map((x) => x.body["website"]), ["http://spam.example", "http://spam.example"]);
});

// ── Hold my cabin, and the thank-you ──────────────────────────────────────────────────────────────────────────

test("'Hold my cabin' asks the server to hold it, then the panel becomes the thank-you: nothing is charged, and where the paperwork goes", async () => {
  const p = visit("en", { post: (url) => (url.endsWith("/hold") ? { ok: true, json: { success: true } } : { ok: true, json: { success: true, pick: PICK } }) });
  await p.ready();
  await p.fillAll();
  p.hold();
  await p.ready();
  const hold = p.sent.find((x) => x.url.endsWith("/hold"))!;
  assert.equal(hold.url, `/api/group-details/${TOKEN}/hold`);
  assert.equal(p.el("d-thanks").hidden, false);
  assert.equal(p.el("d-thanks-h").textContent, "Your cabin is on hold, Mark!");
  assert.equal(p.el("d-thanks-p").textContent, "Mark confirms it with the cruise line and sends your paperwork to this email: mmillham1@gmail.com. Nothing is charged.");
  assert.equal(p.el("d-thanks-phone").textContent, "Questions? Call or text Mark at 919-346-6127.");
  for (const id of ["d-intro", "d-part1", "d-part2", "d-part3"]) assert.equal(p.el(id).hidden, true, id);
  assert.equal(p.el("d-change").hidden, true, "no way back once the hold is asked for");

  // a phone-only guest is told the paperwork goes to their phone
  const ph = visit("en", { get: answer({ email: null, phone: "919 555 0100" }), post: (url) => (url.endsWith("/hold") ? { ok: true, json: { success: true } } : { ok: true, json: { success: true, pick: PICK } }) });
  await ph.ready(); await ph.fillAll(); ph.hold(); await ph.ready();
  assert.equal(ph.el("d-thanks-p").textContent, "Mark confirms it with the cruise line and sends your paperwork to this phone number: 919 555 0100. Nothing is charged.");
  // a group whose button blurb is not a phone line gets the plain one
  const other = visit("en", { get: answer({ phoneLine: "Tap here to book your spot!", holdRequestedAt: "2026-10-23T18:00:00Z" }) });
  await other.ready();
  assert.equal(other.el("d-thanks-phone").textContent, "Questions? Call or text Mark at 919-346-6127.");
});

test("a hold the server refuses keeps the button and shows its words; a failed request does too", async () => {
  const p = visit("en", { post: (url) => (url.endsWith("/hold") ? { ok: false, json: { success: false, error: "Please finish the names and the four questions first." } } : { ok: true, json: { success: true, pick: PICK } }) });
  await p.ready(); await p.fillAll(); p.hold(); await p.ready();
  assert.equal(p.el("d-thanks").hidden, true);
  assert.equal(p.el("d-hold").disabled, false);
  assert.equal(p.el("d-hold").textContent, "Hold my cabin");
  assert.equal(p.el("d-msg").textContent, "Please finish the names and the four questions first.");
  const down = visit("en", { post: (url) => (url.endsWith("/hold") ? Promise.reject(new Error("x")) : { ok: true, json: { success: true, pick: PICK } }) });
  await down.ready(); await down.fillAll(); down.hold(); await down.ready();
  assert.equal(down.el("d-hold").disabled, false);
  assert.match(down.el("d-msg").textContent, /did not go through/);
});

test("a guest who already asked for the hold opens straight on the thank-you and nothing is sent", async () => {
  const p = visit("en", { get: answer({ holdRequestedAt: "2026-10-23T18:00:00Z", choice: "finish", travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }], concierge: ANSWERS, pick: PICK }) });
  await p.ready();
  assert.equal(p.el("d-thanks").hidden, false);
  assert.equal(p.el("d-thanks-h").textContent, "Your cabin is on hold, Mark!");
  for (const id of ["d-intro", "d-part1", "d-part2", "d-part3"]) assert.equal(p.el(id).hidden, true, id);
  assert.equal(p.sent.length, 0);
  // even with the call link in the address: they are on hold, nothing is asked again
  const call = visit("en", { search: `?t=${TOKEN}&choice=call`, get: answer({ holdRequestedAt: "2026-10-23T18:00:00Z" }) });
  await call.ready();
  assert.equal(call.el("d-thanks-h").textContent, "Your cabin is on hold, Mark!");
  assert.equal(call.sent.length, 0);
});

test("a returning guest finds their answers back, and our pick right away, with nothing re-sent until they change something", async () => {
  const saved = answer({ travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }], concierge: ANSWERS, pick: PICK });
  const p = visit("en", { get: saved, post: () => ({ ok: true, json: { success: true, pick: PICK } }) });
  await p.ready();
  assert.equal(p.nameValue(1), "Ceci Millham"); assert.equal(p.dobValue(1), "1980-11-02");
  assert.deepEqual(p.pills().filter((x) => x.on).map((x) => `${x.q}:${x.v}`), ["room:balcony", "priority:quiet", "budget:middle", "motion:yes"]);
  assert.equal(p.el("d-part3").hidden, false);
  assert.equal(p.el("d-pick-h").textContent, "Balcony Bella, midship, a lower deck");
  assert.equal(p.sent.length, 0);
  p.typeName(1, "Ceci M Millham");
  assert.equal(p.el("d-part3").hidden, true, "a changed name takes the old pick away until it is saved again");
  await p.ready();
  assert.equal(p.sent.length, 1);
  assert.equal(p.el("d-part3").hidden, false);
});

// ── "Mark, call me" ───────────────────────────────────────────────────────────────────────────────────────────

test("the call link tells the server and says Mark will call within a day; the guest can still change their mind and finish it themselves", async () => {
  const p = visit("en", { search: `?t=${TOKEN}&choice=call` });
  await p.ready();
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0]!.url, `/api/group-details/${TOKEN}/choice`);
  assert.deepEqual(p.sent[0]!.body, { choice: "call", website: "" });
  assert.equal(p.el("d-thanks").hidden, false);
  assert.equal(p.el("d-thanks-h").textContent, "Got it, Mark.");
  assert.equal(p.el("d-thanks-p").textContent, "Mark will call or text you within a day.");
  assert.equal(p.el("d-change").hidden, false);
  assert.equal(p.el("d-change").textContent, "Changed your mind? Finish it yourself.");
  assert.equal(p.el("d-part1").hidden, true);
  p.change();
  assert.equal(p.el("d-thanks").hidden, true);
  assert.equal(p.el("d-part1").hidden, false);
  assert.equal(p.el("d-part2").hidden, false);
  assert.equal(p.el("d-intro").hidden, false);
});

test("if the call request does not go through, nothing is promised: the guest gets the form back with the reason", async () => {
  const p = visit("en", { search: `?t=${TOKEN}&choice=call`, post: () => ({ ok: false, json: { success: false, error: "Too many attempts. Please try again later, or email mark@stillafloatcruising.com." } }) });
  await p.ready();
  assert.equal(p.el("d-thanks").hidden, true);
  assert.equal(p.el("d-part1").hidden, false);
  assert.equal(p.el("d-msg").textContent, "Too many attempts. Please try again later, or email mark@stillafloatcruising.com.");
  const down = visit("en", { search: `?t=${TOKEN}&choice=call`, post: () => Promise.reject(new Error("offline")) });
  await down.ready();
  assert.equal(down.el("d-thanks").hidden, true);
  assert.match(down.el("d-msg").textContent, /call or text Mark at 919-346-6127/);
});

test("without the call link nothing is sent just for opening the page; any other value of choice is ignored", async () => {
  for (const search of [`?t=${TOKEN}`, `?t=${TOKEN}&choice=finish`, `?t=${TOKEN}&choice=`, `?t=${TOKEN}&choice=CALL`]) {
    const p = visit("en", { search });
    await p.ready();
    assert.equal(p.sent.length, 0, search);
    assert.equal(p.el("d-thanks").hidden, true, search);
  }
});

// ── A link that does not work ─────────────────────────────────────────────────────────────────────────────────

test("a missing, short or odd link never reaches the server; an unknown one says the link is not valid and names the phone", async () => {
  for (const search of ["", "?t=", "?t=abc", `?t=${"T".repeat(44)}`, `?t=${"T".repeat(42)}!`, `?t=${"T".repeat(40)}%3Cb%3E`]) {
    const p = visit("en", { search });
    await p.ready();
    assert.equal(p.requested.length, 0, search);
    assert.equal(p.el("d-state").textContent, "This link is not valid. Please open the whole link from your email, or call or text Mark at 919-346-6127.", search);
    assert.equal(p.el("d-main").hidden, true);
  }
  const gone = visit("en", { getStatus: 404 });
  await gone.ready();
  assert.equal(gone.el("d-state").textContent, "This link is not valid. Please open the whole link from your email, or call or text Mark at 919-346-6127.");
  assert.equal(gone.el("d-main").hidden, true);
  const es = visit("es", { getStatus: 404 });
  await es.ready();
  assert.equal(es.el("d-state").textContent, "Este enlace no es válido. Abra el enlace completo de su correo, o llame o escriba a Mark al 919-346-6127.");
});

// ── Spanish ───────────────────────────────────────────────────────────────────────────────────────────────────

test("the Spanish page says everything in Spanish, in usted, through the same steps", async () => {
  const get = answer({ lang: "es", firstName: "Ana", lastName: "Pérez", label: "Amigos y Familia 2027", sailDateText: "9 de mayo de 2027" });
  const p = visit("es", { get, post: (url) => (url.endsWith("/hold") ? { ok: true, json: { success: true } } : { ok: true, json: { success: true, pick: pickCabin(ANSWERS, HELD, "es", true) } }) });
  await p.ready();
  assert.equal(p.doc.title, "Sus datos | Amigos y Familia 2027");
  assert.equal(p.el("d-h1").textContent, "Vamos a conseguirle una cabina, Ana.");
  assert.equal(p.el("d-lede").textContent, "Ya llenamos lo que nos dio. Tres partes cortas, unos tres minutos, y su cabina queda apartada.");
  assert.equal(p.el("d-p1").textContent, "Parte 1 · Quiénes vienen");
  assert.equal(p.el("d-reach-l").textContent, "Cómo comunicarnos con usted");
  assert.match(p.el("d-travs").innerHTML, /Viajero 1 · usted/); assert.match(p.el("d-travs").innerHTML, /Nombre legal, como aparece en su pasaporte/);
  assert.equal(p.el("d-add").textContent, "Agregar otro viajero");
  assert.equal(p.el("d-p2").textContent, "Parte 2 · Qué cabina le conviene");
  assert.equal(p.pills().filter((x) => x.q === "room").map((x) => x.label)[2], "Café afuera en pijama");
  await p.fillAll();
  assert.equal(p.sent[0]!.body["lang"], "es");
  assert.equal(p.el("d-p3").textContent, "Parte 3 · Nuestra sugerencia para usted");
  assert.equal(p.el("d-pick-h").textContent, "Balcony Bella, en el centro del barco, en una cubierta baja");
  assert.equal(p.el("d-pick-alt").textContent, "¿Prefiere Balcony Aurea? Dígaselo a Mark cuando lo confirme.");
  assert.equal(p.el("d-hold").textContent, "Apartar mi cabina");
  assert.equal(p.el("d-hold-note").textContent, "Mark lo confirma con la naviera y le envía sus documentos. $50 por persona la aparta. Aquí no se cobra nada.");
  assert.equal(p.el("d-rather").textContent, "¿Prefiere hablarlo? Llame o escriba a Mark al 919-346-6127.");
  p.hold();
  await p.ready();
  assert.equal(p.el("d-thanks-h").textContent, "¡Su cabina está apartada, Ana!");
  assert.equal(p.el("d-thanks-p").textContent, "Mark la confirma con la naviera y le envía sus documentos a este correo: mmillham1@gmail.com. No se cobra nada.");

  const call = visit("es", { search: `?t=${TOKEN}&choice=call`, get });
  await call.ready();
  assert.equal(call.el("d-thanks-h").textContent, "Listo, Ana.");
  assert.equal(call.el("d-thanks-p").textContent, "Mark le llamará o le escribirá en un día.");
  assert.equal(call.el("d-change").textContent, "¿Cambió de opinión? Termínelo usted.");
});

test("the pick's 'other cabin' line points at the next category up, the one below for the top category, and is absent with a single category", async () => {
  const alt = async (held: unknown, category: string) => {
    const p = visit("en", { get: answer({ held, travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }], concierge: ANSWERS, pick: { ...PICK, category }, guests: 1 }) });
    await p.ready();
    return p.el("d-pick-alt").hidden ? "" : p.el("d-pick-alt").textContent;
  };
  assert.equal(await alt(HELD, "Balcony Bella"), "Want Balcony Aurea instead? Tell Mark when he confirms.");
  assert.equal(await alt(HELD, "Balcony Aurea"), "Want Balcony Bella instead? Tell Mark when he confirms.");
  assert.equal(await alt([HELD[0]], "Balcony Bella"), "");
  assert.equal(await alt([], "Balcony"), "");
  assert.equal(await alt([...HELD, { category: "Suite", perPersonText: "$900" }], "Balcony Aurea"), "Want Suite instead? Tell Mark when he confirms.");
  // no deposit in the file: the sentence is dropped, never invented
  const p = visit("en", { get: answer({ depositPerPersonText: null, travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }], concierge: ANSWERS, pick: PICK, guests: 1 }) });
  await p.ready();
  assert.equal(p.el("d-hold-note").textContent, "Mark confirms it with the cruise line and sends your paperwork. Nothing is charged here.");
});
