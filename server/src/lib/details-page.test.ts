// details-page.test.ts — the guest's "Your details" page, Road B (server/public/details.html and its Spanish twin), run the way a visitor's browser runs it
// (Mark 2026-10-24, "Road B · I've got this… let me fill it in!": three short parts, the address, the checks, the pick with its upgrade hook, "Hold my cabin!", one line).
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
import { MSG, pickCabin } from "./group-details";

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
const PERKS = ["Your own restaurant where you eat when you feel like it", "the adults-only thermal spa", "a solarium the rest of the ship can't find"];
const ANSWERS = { room: "balcony", priority: "quiet", budget: "middle", motion: "yes" } as const;
const PICK = pickCabin(ANSWERS, HELD, "en", PERKS);
const ADDR = { street: "123 Main St", city: "Raleigh", state: "NC", zip: "27601", tidied: false };

/** The answer GET /api/group-details/:token gives (the server's own shape; each test changes what it needs). No cabin price is in it. */
function answer(over: Record<string, unknown> = {}) {
  return {
    success: true, label: "Friends and Family 2027", ship: "MSC Seashore", sailDateText: "May 9, 2027", returnDateText: "May 13, 2027", heroUrl: "https://stillafloatcruising.com/assets/images/hero.jpg",
    firstName: "Mark", lastName: "Millham", email: "mmillham1@gmail.com", phone: null, guests: 2, travelers: [], address: null, concierge: null, pick: null, choice: null, callWhen: null,
    holdRequestedAt: null, depositPerPersonText: "$50", phoneLine: "Questions? Call or text Mark at 919-346-6127.", businessPhone: "919-346-6127", lang: "en",
    ...over,
  };
}

// ── The browser stand-in ─────────────────────────────────────────────────────────────────────────────────────

type Handler = (e: { target: Target; preventDefault(): void }) => void;
class El {
  textContent = ""; innerHTML = ""; hidden = false; className = ""; value = ""; disabled = false; alt = ""; decoding = ""; src = ""; placeholder = "";
  onload: (() => void) | null = null; onerror: (() => void) | null = null; parentNode: El | null = null; firstChild: El | null = null;
  handlers: Record<string, Handler> = {};
  kids: El[] = [];
  private attrs: Record<string, string> = {};
  scrolledTo = 0; focused = 0;
  constructor(readonly id: string) {}
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  scrollIntoView() { this.scrolledTo++; }
  focus() { this.focused++; }
  addEventListener(type: string, fn: Handler) { this.handlers[type] = fn; }
  appendChild(c: El) { c.parentNode = this; this.kids.push(c); return c; }
  insertBefore(c: El) { c.parentNode = this; this.kids.unshift(c); this.firstChild = c; return c; }
  removeChild() { /* nothing */ }
}
interface Target { getAttribute(k: string): string | null; value: string; className: string }
const target = (attrs: Record<string, string>, value = ""): Target => ({ getAttribute: (k) => attrs[k] ?? null, value, className: "" });

type Sent = { url: string; body: Record<string, any> };
type Reply = { ok: boolean; status?: number; json?: unknown };
type PostReply = (url: string, body: Record<string, any>) => Reply | Promise<Reply>;

/** What the real server answers: a pick for the four answers (the same pickCabin), success for a save and a hold, and no address service unless a test gives one. */
function server(lang: Lang, over: { perks?: string[]; lookup?: (body: Record<string, any>) => Reply } = {}): PostReply {
  return (url, body) => {
    if (url === "/api/address/lookup") return over.lookup ? over.lookup(body) : { ok: true, json: { success: true, available: false } };
    if (url.endsWith("/hold")) return { ok: true, json: { success: true } };
    const concierge = body["concierge"];
    return { ok: true, json: { success: true, pick: pickCabin(concierge, HELD, lang, over.perks ?? PERKS) } };
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
      // the page escapes text through a <div>: textContent in, innerHTML (escaped) out
      let text = "";
      return { set textContent(v: string) { text = v; }, get innerHTML() { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); } };
    },
  };
  // an element that starts hidden in the page's own markup starts hidden here, so "the page showed it" means the script un-hid it
  for (const m of html(lang).matchAll(/<[a-z0-9]+\s[^>]*?\bid="([^"]+)"[^>]*>/g)) if (/\shidden(?=[\s>=])/.test(m[0])) el(m[1]!).hidden = true;
  const requested: string[] = [];
  const sent: Sent[] = [];
  const post = o.post ?? server(lang);
  const sandbox = {
    document: doc, window: {}, location: { search: o.search ?? `?t=${TOKEN}`, hash: "" }, URLSearchParams, console, Date, JSON, Math, Number, String, Array, parseInt, isNaN, RegExp, Object, Promise,
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
  const page = {
    els, el, doc, requested, sent, created, ready: () => flush(5), flush,
    posts: (suffix: string) => sent.filter((x) => x.url.endsWith(suffix)),
    /** Type into a box the way a guest does (the page hears the key; a birthday is formatted as it is typed). */
    type(id: string, v: string) { const e = el(id); e.value = v; e.handlers["input"]!({ target: target({}, v), ...quiet }); },
    leave(id: string) { el(id).handlers["blur"]!({ target: target({}), ...quiet }); },
    tap: (q: string, idx: number) => { el("d-qs").handlers["click"]!({ target: target({ "data-q": q, "data-i": String(idx) }), ...quiet }); },
    tick3: () => { el("d-tick-3").handlers["click"]!({ target: target({}), ...quiet }); },
    tick4: () => { el("d-tick-4").handlers["click"]!({ target: target({}), ...quiet }); },
    hold: () => { el("d-hold").handlers["click"]!({ target: target({}), ...quiet }); },
    take: () => { el("d-take").handlers["click"]!({ target: target({}), ...quiet }); },
    fix: (act: "yes" | "no") => { el("d-fix").handlers["click"]!({ target: target({ "data-act": act }), ...quiet }); },
    pickSugg: (j: number) => { el("d-sugg").handlers["click"]!({ target: target({ "data-s": String(j) }), ...quiet }); },
    pills: () => [...el("d-qs").innerHTML.matchAll(/<button[^>]*data-q="([^"]+)" data-i="(\d+)" data-v="([^"]+)" aria-pressed="(true|false)">([^<]*)<\/button>/g)]
      .map((m) => ({ q: m[1]!, i: Number(m[2]), v: m[3]!, on: m[4] === "true", label: m[5]!.replace(/&amp;/g, "&").replace(/&#39;/g, "'") })),
    /** Fill the address the way a guest does. */
    address(a: { street?: string; city?: string; st?: string; zip?: string } = {}) {
      this.type("d-street", a.street ?? "123 Main St"); this.type("d-city", a.city ?? "Raleigh"); this.type("d-st", a.st ?? "NC"); this.type("d-zip", a.zip ?? "27601");
    },
    /** The four taps: room = balcony, priority = quiet, budget = middle, motion = yes. */
    answers() { this.tap("room", 2); this.tap("priority", 1); this.tap("budget", 1); this.tap("motion", 0); },
    /** Everything a party of two needs: both names and birthdays, the address, the four taps. */
    async fillAll(o2: { second?: string } = {}) {
      this.type("d-name-0", "Mark Millham"); this.type("d-dob-0", "04121965");
      this.type("d-name-1", o2.second ?? "Ceci Millham"); this.type("d-dob-1", "11/02/1980");
      this.address(); this.answers();
      await flush(8);
    },
    visible: (id: string) => !el(id).hidden,
  };
  return page;
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

test("a private page: never indexed, its address never sent on, it calls the guest's own API and carries the bot trap and 'Hold my cabin!'", () => {
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    assert.match(h, /<meta name="robots" content="noindex, nofollow">/, lang);
    assert.match(h, /<meta name="referrer" content="no-referrer">/, lang);
    assert.ok(h.includes("/api/group-details/") && h.includes("/api/address/lookup"), lang);
    assert.ok(h.includes('id="d-website"') && h.includes('class="hp"'), `${lang}: the bot trap`);
    assert.ok(script(lang).includes(lang === "es" ? "¡Apartar mi cabina!" : "Hold my cabin!"), `${lang}: the button's words`);
    assert.ok(script(lang).includes("b.website = $('d-website').value"), `${lang}: the bot trap travels with every POST`);
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
    // no money is taken and no card is asked for on this page; the checkmarks are buttons, not form controls
    assert.ok(!/type="(checkbox|password|tel|email)"|card number|cvv/i.test(h), `${lang}: a card, account or form-control field`);
    // no price anywhere on the page or in its script: the guest saw them on the group page
    const visible = h.replace(/<style\b[\s\S]*?<\/style>/g, " ");
    assert.ok(!/\$\s?\d/.test(visible), `${lang}: a dollar amount is written on the page`);
    assert.ok(!/count me in|cuenten conmigo/i.test(h), `${lang}: "Count me in"`);
  }
});

test("the page's look is the group page's: a centered column of at most 640px, a navy page, cloud-white panels, the yellow pill (dim until it is lit), red for a wrong field, and no white text under 15px", () => {
  for (const lang of ["en", "es"] as const) {
    const c = css(lang);
    assert.match(c, /\.wrap\{max-width:640px;margin:0 auto\}/);
    assert.match(c, /--navy:#07183f;--cloud:#f7fbff;--gold:#ffca4f;--yellow:#f5c33b/);
    assert.match(c, /html,body\{margin:0;background:var\(--navy\)\}/);
    assert.match(c, /\.btn\{[^}]*background:#f5c33b;color:#07183f/);
    assert.match(c, /\.btn\[aria-disabled="true"\]\{opacity:/);
    assert.match(c, /\.pick\{[^}]*border:2px solid var\(--gold\)/, "the pick sits in the gold-bordered card");
    assert.match(c, /\.field input\.bad\{[^}]*border-color:#d12d2d/);
    assert.match(c, /\.err\{[^}]*color:#d12d2d/);
    assert.match(c, /\.fix\{[^}]*background:#fff6d6;border:2px solid var\(--yellow\)/, "the yellow 'Right?' box");
    assert.match(c, /\.two\{display:grid;grid-template-columns:repeat\(2,/);
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

// ── Part 1: what the page fills in, and the people ────────────────────────────────────────────────────────────

test("it opens filled in with what we have: the design's heading and lede, the plaque and tab, how to reach them, their own name in Traveler 1, the second traveler, birthdays and address empty", async () => {
  const p = visit("en");
  await p.ready();
  assert.deepEqual(p.requested, [`/api/group-details/${TOKEN}`]);
  assert.equal(p.el("d-state").hidden, true);
  assert.equal(p.el("d-main").hidden, false);
  assert.equal(p.doc.title, "Your details | Friends and Family 2027");
  assert.equal(p.el("d-plaque").textContent, "Friends and Family 2027");
  assert.equal(p.el("d-h1").textContent, "Look at you, taking charge… WE LOVE A PLANNER!");
  assert.equal(p.el("d-lede").textContent, "Three short parts, about three minutes… less time than the buffet line on embarkation day. Your cabin is held at the end.");
  assert.equal(p.el("d-p1").textContent, "Part 1 · Who's coming");
  assert.equal(p.el("d-reach-l").textContent, "How to reach you"); assert.equal(p.el("d-reach").textContent, "mmillham1@gmail.com");
  assert.equal(p.el("d-count-l").textContent, "How many of you"); assert.equal(p.el("d-count").textContent, "2");
  assert.equal(p.el("d-p1note").textContent, "The cruise line needs each traveler's legal name and birthday to hold a cabin. Spell them the way the passport does, not the way your aunt does. Passport numbers come later, on your paperwork page.");
  assert.equal(p.el("d-who-0").textContent, "Traveler 1 · you"); assert.equal(p.el("d-who-1").textContent, "Traveler 2");
  assert.equal(p.el("d-name-l-0").textContent, "Legal name, as on your passport"); assert.equal(p.el("d-name-l-1").textContent, "Legal name, as on their passport");
  assert.equal(p.el("d-dob-l-0").textContent, "Date of birth");
  assert.equal(p.el("d-name-0").placeholder, "First and last"); assert.equal(p.el("d-dob-0").placeholder, "mm / dd / yyyy");
  assert.equal(p.el("d-name-0").value, "Mark Millham", "their own name, from the reply");
  assert.equal(p.el("d-name-1").value, ""); assert.equal(p.el("d-dob-0").value, ""); assert.equal(p.el("d-dob-1").value, "");
  assert.equal(p.el("d-street-l").textContent, "Your home address"); assert.equal(p.el("d-street").placeholder, "Street");
  assert.equal(p.el("d-city-l").textContent, "City"); assert.equal(p.el("d-stzip-l").textContent, "State · ZIP");
  assert.equal(p.el("d-addr-note").textContent, "One address for the cabin. If someone in your party lives elsewhere, we sort it on the paperwork page.");
  assert.equal(p.el("d-p2").textContent, "Part 2 · Which cabin suits you");
  assert.equal(p.el("d-p2intro").textContent, "Four questions from our Room Concierge. Answer honestly… the ship can tell.");
  assert.equal(p.el("d-p2move").textContent, "Smart-cruiser move: the ship moves least low and midship. That is where we put anyone who feels it.");
  assert.equal(p.visible("d-trav-1"), true, "Traveler 2 is shown for a party of two");
  assert.equal(p.visible("d-trav-2"), false); assert.equal(p.visible("d-trav-3"), false);
  assert.equal(p.el("d-more-h").textContent, "More of you? The more the merrier…");
  assert.equal(p.el("d-tick-3-t").textContent, "There's a third of us"); assert.equal(p.el("d-tick-4-t").textContent, "…and a fourth!");
  assert.equal(p.visible("d-more"), true); assert.equal(p.visible("d-tick-4"), false, "the fourth checkmark waits for the third");
  assert.equal(p.el("d-part3").hidden, true, "our pick is not shown before they have answered");
  assert.equal(p.el("d-thanks").hidden, true);
  assert.equal(p.sent.length, 0, "opening the page sends nothing");
  assert.equal(p.created.filter((e) => e.id === "created:img").length, 1);
  assert.equal(p.created[0]!.src, "https://stillafloatcruising.com/assets/images/hero.jpg");
  assert.equal(p.el("d-hold").getAttribute("aria-disabled"), "true", "dim from the start");
});

test("how many blocks open follows the party: Traveler 2 shows from two of them, a third and a fourth open from the party size or by the checkmarks; never more than four", async () => {
  const shown = async (guests: unknown, extra: Record<string, unknown> = {}) => {
    const p = visit("en", { get: answer({ guests, ...extra }) });
    await p.ready();
    return { p, open: [1, 2, 3].filter((i) => p.visible(`d-trav-${i}`)).length + 1, more: p.visible("d-more"), max: p.visible("d-max") };
  };
  const one = await shown(1);
  assert.deepEqual([one.open, one.more, one.max], [1, false, false]);
  assert.equal(one.p.el("d-count").textContent, "1");
  assert.deepEqual([(await shown(null)).open, (await shown(0)).open, (await shown("3")).open], [1, 1, 3]);
  assert.deepEqual([(await shown(2)).open, (await shown(3)).open, (await shown(4)).open], [2, 3, 4]);
  const six = await shown(6);
  assert.deepEqual([six.open, six.max], [4, true]);
  assert.equal(six.p.el("d-max").textContent, "More than four? Mark will set up a second cabin on the call… tap Talk me into it, Mark! on the group page.");
  assert.equal(six.p.el("d-count").textContent, "4");
  assert.equal((await shown(40)).open, 4);
  // a party of three opens with the third checkmark ticked and the fourth offered
  const three = await shown(3);
  assert.equal(three.p.el("d-tick-3").getAttribute("aria-checked"), "true"); assert.equal(three.p.visible("d-tick-4"), true);
  assert.equal(three.p.el("d-tick-4").getAttribute("aria-checked"), "false");
});

test("a phone-only reply shows the phone to reach them; a one-word name fills Traveler 1 and is refused as a first name only", async () => {
  const p = visit("en", { get: answer({ email: null, phone: "919-346-6127", firstName: "Cher", lastName: "", guests: 1 }) });
  await p.ready();
  assert.equal(p.el("d-reach").textContent, "919-346-6127");
  assert.equal(p.el("d-name-0").value, "Cher");
  p.leave("d-name-0");
  assert.equal(p.el("d-name-e-0").textContent, MSG.name.en);
});

test("the third and fourth traveler open with a checkmark: the third reveals Traveler 3 and offers the fourth; unticking the third closes both; the count follows", async () => {
  const p = visit("en");
  await p.ready();
  p.tick3();
  assert.equal(p.visible("d-trav-2"), true); assert.equal(p.el("d-who-2").textContent, "Traveler 3");
  assert.equal(p.el("d-tick-3").getAttribute("aria-checked"), "true"); assert.equal(p.el("d-tick-3").className, "tickrow on");
  assert.equal(p.visible("d-tick-4"), true); assert.equal(p.visible("d-trav-3"), false);
  assert.equal(p.el("d-count").textContent, "3");
  p.tick4();
  assert.equal(p.visible("d-trav-3"), true); assert.equal(p.el("d-who-3").textContent, "Traveler 4"); assert.equal(p.el("d-count").textContent, "4");
  p.tick4();
  assert.equal(p.visible("d-trav-3"), false); assert.equal(p.el("d-count").textContent, "3");
  p.tick4(); p.tick3();
  assert.equal(p.visible("d-trav-2"), false); assert.equal(p.visible("d-trav-3"), false); assert.equal(p.visible("d-tick-4"), false);
  assert.equal(p.el("d-count").textContent, "2");
  // the checkmarks are buttons with a checkbox role, not form controls
  assert.match(html("en"), /<button type="button" class="tickrow" id="d-tick-3" role="checkbox" aria-checked="false">/);
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
  const evil = visit("en", { get: answer({ credits: ["<b>x</b>"] }) });
  await evil.ready();
  assert.equal(evil.el("d-credits").textContent, "<b>x</b>");
  assert.match(css("en"), /\.foot \.credits\{[^}]*font-size:15px/);
});

test("a picture that is not https is never used, and anything the guest or the file wrote is shown as text, never markup", async () => {
  const bad = visit("en", { get: answer({ heroUrl: "javascript:alert(1)" }) });
  await bad.ready();
  assert.equal(bad.created.length, 0);
  const evil = '"><img src=x onerror=alert(1)>';
  const p = visit("en", { get: answer({ firstName: evil, lastName: "", label: evil, email: evil }) });
  await p.ready();
  assert.equal(p.el("d-plaque").textContent, evil, "text only, through textContent");
  assert.equal(p.el("d-name-0").value, evil.trim(), "an input's value, never markup");
  assert.equal(p.el("d-reach").textContent, evil);
  const held = visit("en", { get: answer({ holdRequestedAt: "2026-10-24T10:00:00Z", businessPhone: evil, travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }], address: ADDR, concierge: ANSWERS, pick: { ...PICK, category: evil } }) });
  await held.ready();
  assert.ok(held.el("d-thanks-h").textContent.includes(evil) && !held.el("d-thanks-h").innerHTML.includes("<img"));
  assert.ok(held.el("d-thanks-p").textContent.includes(evil));
  // the pick's own words are written as text too (the card's hook is the only markup, and only its own <b>)
  const card = visit("en", { post: (url, body) => ({ ok: true, json: { success: true, pick: { category: evil, where: evil, why: evil, upgrade: { category: evil, hook: evil } } } }) });
  await card.ready();
  card.answers(); await card.ready();
  assert.equal(card.el("d-pick-h").textContent, `${evil}, ${evil}`);
  assert.ok(!card.el("d-pick-up").innerHTML.includes("<img"), card.el("d-pick-up").innerHTML);
});

// ── The checks: names, dates, address (Road B design, row 5) ──────────────────────────────────────────────────

test("a name is first AND last, letters only: red with the design's words once the box is left, and not before; fixing it clears the note", async () => {
  const NAME = "First AND last name, please… the way the passport has it.";
  for (const bad of ["Bob", "", "R2 D2", "Mark <b>Millham</b>", "Mark 3rd", "-- --"]) {
    const p = visit("en");
    await p.ready();
    p.type("d-name-1", bad);
    assert.equal(p.el("d-name-e-1").hidden, true, `typing "${bad}" shows nothing until the box is left`);
    p.leave("d-name-1");
    assert.equal(p.el("d-name-e-1").hidden, false, bad);
    assert.equal(p.el("d-name-e-1").textContent, NAME);
    assert.equal(p.el("d-name-1").className, "bad");
  }
  const p = visit("en");
  await p.ready();
  p.type("d-name-1", "Ceci"); p.leave("d-name-1");
  assert.equal(p.el("d-name-e-1").hidden, false);
  p.type("d-name-1", "Ceci Millham");
  assert.equal(p.el("d-name-e-1").hidden, true); assert.equal(p.el("d-name-1").className, "done");
  const es = visit("es");
  await es.ready();
  es.type("d-name-1", "Ceci"); es.leave("d-name-1");
  assert.equal(es.el("d-name-e-1").textContent, "Nombre Y apellido, por favor… tal como aparecen en el pasaporte.");
});

test("a birthday is typed as digits and shown as 'mm / dd / yyyy'; a wrong one is red with the design's words: a two-digit year, a date that is not real, the future, over 120 years ago", async () => {
  const DOB = "Month, day and a four-digit year: 03 / 04 / 1965.";
  const p = visit("en");
  await p.ready();
  p.type("d-dob-0", "0"); assert.equal(p.el("d-dob-0").value, "0");
  p.type("d-dob-0", "03"); assert.equal(p.el("d-dob-0").value, "03");
  p.type("d-dob-0", "030"); assert.equal(p.el("d-dob-0").value, "03 / 0");
  p.type("d-dob-0", "03 / 04"); assert.equal(p.el("d-dob-0").value, "03 / 04");
  p.type("d-dob-0", "03 / 041"); assert.equal(p.el("d-dob-0").value, "03 / 04 / 1");
  p.type("d-dob-0", "03 / 04 / 1965"); assert.equal(p.el("d-dob-0").value, "03 / 04 / 1965");
  p.type("d-dob-0", "03041965999"); assert.equal(p.el("d-dob-0").value, "03 / 04 / 1965", "no more than eight digits");
  p.type("d-dob-0", "3/4/1965"); assert.equal(p.el("d-dob-0").value, "3/4/1965", "separators typed by the guest are left alone");
  p.leave("d-dob-0");
  assert.equal(p.el("d-dob-e-0").hidden, true, "3/4/1965 is a real date");
  assert.equal(p.el("d-dob-0").className, "done");
  const wrong = async (text: string) => {
    const q = visit("en");
    await q.ready();
    q.type("d-dob-1", text); q.leave("d-dob-1");
    return [q.el("d-dob-e-1").hidden, q.el("d-dob-e-1").textContent, q.el("d-dob-1").className];
  };
  for (const bad of ["03 / 04 / 65", "030465", "02 / 30 / 1965", "13 / 01 / 1965", "00 / 10 / 1965", "03 / 04 / 2999", "01 / 01 / 1800", "mm / dd / yyyy", "", "1965"]) {
    assert.deepEqual(await wrong(bad), [false, DOB, "bad"], JSON.stringify(bad));
  }
  const today = new Date();
  const mmddyyyy = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")} / ${String(d.getDate()).padStart(2, "0")} / ${d.getFullYear()}`;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  assert.deepEqual(await wrong(mmddyyyy(tomorrow)), [false, DOB, "bad"], "tomorrow is the future");
  assert.equal((await wrong(mmddyyyy(today)))[0], true, "today is a newborn, which is fine");
  assert.equal((await wrong(mmddyyyy(new Date(today.getFullYear() - 119, today.getMonth(), today.getDate()))))[0], true, "119 years is fine");
  assert.equal((await wrong(mmddyyyy(new Date(today.getFullYear() - 120, today.getMonth(), today.getDate()))))[0], false, "120 years ago is too old");
  const es = visit("es");
  await es.ready();
  es.type("d-dob-1", "03 / 04 / 65"); es.leave("d-dob-1");
  assert.equal(es.el("d-dob-e-1").textContent, "Mes, día y año de cuatro dígitos (el mes primero): 03 / 04 / 1965.");
  assert.equal(es.el("d-dob-0").placeholder, "mm / dd / aaaa");
});

test("the address: a street (five characters or more), a city, two letters for the state and five digits for the ZIP, each red with its own words once it is left", async () => {
  const note = async (id: string, e: string, text: string, others: Parameters<ReturnType<typeof visit>["address"]>[0] = {}) => {
    const p = visit("en");
    await p.ready();
    p.address(others); p.type(id, text); p.leave(id);
    return [p.el(e).hidden, p.el(e).textContent, p.el(id).className];
  };
  assert.deepEqual(await note("d-street", "d-street-e", "12"), [false, "A street and number, please… like 123 Main St.", "bad"]);
  assert.deepEqual(await note("d-street", "d-street-e", "12345"), [false, "A street and number, please… like 123 Main St.", "bad"]);
  assert.deepEqual(await note("d-street", "d-street-e", "<script>"), [false, "A street and number, please… like 123 Main St.", "bad"]);
  assert.deepEqual(await note("d-city", "d-city-e", ""), [false, "Which city, please?", "bad"]);
  assert.deepEqual(await note("d-city", "d-city-e", "R4leigh"), [false, "Which city, please?", "bad"]);
  assert.deepEqual(await note("d-st", "d-st-e", "N"), [false, "The state's two letters, please… like NC.", "bad"]);
  assert.deepEqual(await note("d-st", "d-st-e", "zz"), [false, "The state's two letters, please… like NC.", "bad"]);
  assert.deepEqual(await note("d-zip", "d-zip-e", "2760"), [false, "Five digits for the ZIP, please… like 27601.", "bad"]);
  assert.deepEqual(await note("d-zip", "d-zip-e", "ABCDE"), [false, "Five digits for the ZIP, please… like 27601.", "bad"]);
  assert.equal((await note("d-zip", "d-zip-e", "27601-1234"))[0], true, "ZIP+4 is fine");
  assert.equal((await note("d-st", "d-st-e", "nc"))[0], true, "the state is capitalised as it is typed");
  const p = visit("en");
  await p.ready();
  p.type("d-st", "nc");
  assert.equal(p.el("d-st").value, "NC");
  p.type("d-st", "n1c"); assert.equal(p.el("d-st").value, "NC", "letters only");
  // Spanish words
  const es = visit("es");
  await es.ready();
  es.type("d-zip", "1"); es.leave("d-zip");
  assert.equal(es.el("d-zip-e").textContent, "Cinco dígitos para el código postal, por favor… como 27601.");
});

// ── Part 3: our pick, the upgrade hook, the hold ──────────────────────────────────────────────────────────────

test("when the four answers are in the page asks for the pick (from the four answers alone) and shows it: the title, the why, the upgrade hook and the hold line; no price", async () => {
  const p = visit("en");
  await p.ready();
  p.tap("room", 2); p.tap("priority", 1); p.tap("budget", 1);
  await p.ready();
  assert.equal(p.el("d-part3").hidden, true, "three of four answers");
  assert.equal(p.posts("/pick").length, 0);
  p.tap("motion", 0);
  await p.ready();
  const asked = p.posts("/pick");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.url, `/api/group-details/${TOKEN}/pick`);
  assert.deepEqual(asked[0]!.body, { concierge: ANSWERS, lang: "en", website: "" });
  assert.equal(p.el("d-part3").hidden, false, "shown with Part 1 still empty: the button is what waits");
  assert.equal(p.el("d-p3").textContent, "Part 3 · Our pick for you");
  assert.equal(p.el("d-pick-h").textContent, "Balcony Bella, midship, a lower deck");
  assert.equal(p.el("d-pick-why").textContent, "Steady for whoever feels the motion, quiet away from the pool deck, and a balcony for that coffee.");
  assert.equal(p.el("d-pick-up").hidden, false);
  assert.equal(p.el("d-pick-up").innerHTML, "<b>The upgrade most people never hear about:</b> Aurea. Your own restaurant where you eat when you feel like it, the adults-only thermal spa, and a solarium the rest of the ship can't find. Ask Mark about the Aurea class rooms.");
  assert.equal(p.el("d-hold").textContent, "Hold my cabin!");
  assert.equal(p.el("d-hold-note").textContent, "Mark confirms it with the cruise line and your paperwork follows. $50 a person holds it… nothing is charged tonight.");
  const shown = ["d-pick-h", "d-pick-why", "d-pick-up", "d-hold-note"].map((id) => p.el(id).textContent + p.el(id).innerHTML).join(" ");
  assert.ok(!/\$(?!50 a person)|per person|From \d/.test(shown), "no cabin price is on the card");
});

test("with no deposit the hold line drops the dollar clause; with no upgrade perks (or no higher category) the hook line is not there", async () => {
  const none = visit("en", { get: answer({ depositPerPersonText: null }), post: server("en", { perks: [] }) });
  await none.ready();
  none.answers(); await none.ready();
  assert.equal(none.el("d-hold-note").textContent, "Mark confirms it with the cruise line and your paperwork follows. Nothing is charged tonight.");
  assert.equal(none.el("d-pick-up").hidden, true, "no perks written, no hook");
  const noUp = visit("en", { post: (url, body) => ({ ok: true, json: { success: true, pick: { ...pickCabin(body["concierge"], HELD, "en", PERKS), upgrade: null } } }) });
  await noUp.ready();
  noUp.answers(); await noUp.ready();
  assert.equal(noUp.el("d-pick-up").hidden, true);
});

test("changing an answer asks for a new pick; a pick that comes back for answers they have since changed is not shown", async () => {
  const slow: Array<() => void> = [];
  const p = visit("en", { post: (url, body) => new Promise<Reply>((resolve) => { slow.push(() => resolve({ ok: true, json: { success: true, pick: pickCabin(body["concierge"], HELD, "en", PERKS) } })); }) });
  await p.ready();
  p.answers();
  p.tap("budget", 3);                  // changed their mind while the first pick was being made
  await p.ready();
  assert.equal(p.posts("/pick").length, 2);
  slow[0]!(); await p.ready();
  assert.equal(p.el("d-part3").hidden, true, "the first pick is for answers that are gone");
  slow[1]!(); await p.ready();
  assert.equal(p.el("d-part3").hidden, false);
  assert.equal(p.el("d-pick-h").textContent, "Balcony Aurea, midship, a lower deck", "a sky budget takes the higher category");
  assert.equal(p.el("d-pick-up").hidden, true, "nothing above the top category");
  // an answer taken away again (cannot happen from the buttons, but the page must not show a stale pick for fewer than four)
});

test("a pick the server refuses shows its words and no card", async () => {
  const p = visit("en", { post: () => ({ ok: false, status: 400, json: { success: false, error: "Please tap one answer for each of the four room questions." } }) });
  await p.ready();
  p.answers(); await p.ready();
  assert.equal(p.el("d-part3").hidden, true);
  assert.equal(p.el("d-msg").textContent, "Please tap one answer for each of the four room questions.");
});

test("'Hold my cabin!' sits dim (aria-disabled) until Part 1 is clean, then lights up; the quiet save carries exactly who is listed, the address and the answers", async () => {
  const p = visit("en");
  await p.ready();
  await p.fillAll();
  assert.equal(p.el("d-hold").getAttribute("aria-disabled"), "false", "lit");
  assert.equal(p.el("d-summary").hidden, true);
  const saves = p.sent.filter((x) => x.url === `/api/group-details/${TOKEN}`);
  assert.equal(saves.length, 1, "saved once it settled");
  assert.deepEqual(saves[0]!.body, {
    travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }],
    address: ADDR, concierge: ANSWERS, lang: "en", website: "",
  });
  // a change makes it dim again if it breaks something, and is saved again when it is right
  p.type("d-name-1", "Ceci");
  assert.equal(p.el("d-hold").getAttribute("aria-disabled"), "true");
  p.type("d-name-1", "Ceci Millham-Smith"); await p.flush(8);
  assert.equal(p.sent.filter((x) => x.url === `/api/group-details/${TOKEN}`).length, 2);
  assert.equal(p.sent.filter((x) => x.url === `/api/group-details/${TOKEN}`)[1]!.body["travelers"][1].legal_name, "Ceci Millham-Smith");
  // a third traveler opened and left empty makes the button dim; closing it again lights it
  p.tick3();
  assert.equal(p.el("d-hold").getAttribute("aria-disabled"), "true");
  p.tick3();
  assert.equal(p.el("d-hold").getAttribute("aria-disabled"), "false");
  // nothing is saved before Part 1 is clean and the four answers are in
  const early = visit("en");
  await early.ready();
  early.type("d-name-0", "Mark Millham"); early.type("d-dob-0", "04121965"); await early.flush(8);
  assert.equal(early.sent.length, 0);
});

test("a tap on the dim button goes to the FIRST problem, marks every problem red, and says under the button how many things still need them, with a 'Take me there' link", async () => {
  const p = visit("en", { get: answer({ guests: 3 }) });
  await p.ready();
  p.type("d-name-0", "Mark Millham"); p.type("d-dob-0", "04121965"); p.address();
  p.type("d-name-1", "Ceci Millham"); p.type("d-dob-1", "03 / 04 / 65");     // a two-digit year
  p.type("d-name-2", "Pat"); p.type("d-dob-2", "01011990");                  // no last name
  p.answers(); await p.ready();
  assert.equal(p.el("d-hold").getAttribute("aria-disabled"), "true");
  p.hold();
  assert.equal(p.sent.filter((x) => x.url.endsWith("/hold")).length, 0, "nothing is held");
  assert.equal(p.el("d-summary").hidden, false);
  assert.equal(p.el("d-summary-t").textContent, "Two things still need you: a four-digit year on Traveler 2's birthday, and Traveler 3's last name.");
  assert.equal(p.el("d-take").textContent, "Take me there");
  assert.equal(p.el("d-dob-e-1").hidden, false); assert.equal(p.el("d-dob-e-1").textContent, "Month, day and a four-digit year: 03 / 04 / 1965.");
  assert.equal(p.el("d-name-e-2").hidden, false); assert.equal(p.el("d-name-2").className, "bad");
  assert.equal(p.el("d-name-e-0").hidden, true, "what is good stays quiet");
  assert.deepEqual([p.el("d-dob-1").scrolledTo, p.el("d-dob-1").focused, p.el("d-name-2").scrolledTo], [1, 1, 0], "taken to the first problem only");
  p.take();
  assert.equal(p.el("d-dob-1").scrolledTo, 2, "the link goes to the first problem again");
  // one thing left: the singular
  p.type("d-dob-1", "03 / 04 / 1965");
  p.hold();
  assert.equal(p.el("d-summary-t").textContent, "One thing still needs you: Traveler 3's last name.");
  assert.equal(p.el("d-name-2").scrolledTo, 1);
  // three or more are listed with the serial comma, in the order of the page
  const q = visit("en", { get: answer({ guests: 4 }) });
  await q.ready();
  q.answers(); await q.ready();
  q.hold();
  assert.match(q.el("d-summary-t").textContent, /^11 things still need you: your birthday, your street address, your city, your state, your ZIP, Traveler 2's name, .*, and Traveler 4's birthday\.$/, "past ten the count is digits; the list has the serial comma");
  assert.equal(q.el("d-dob-0").scrolledTo, 1, "the first field of the page that is wrong (their own name came filled in)");
  // the summary goes when everything is good (two travelers is what fillAll fills in)
  q.tick4(); q.tick3();
  await q.fillAll();
  assert.equal(q.el("d-summary").hidden, true);
});

test("the summary in Spanish: the same things, in usted, with the Spanish list", async () => {
  const p = visit("es", { get: answer({ lang: "es", guests: 2 }) });
  await p.ready();
  p.type("d-name-0", "Ana Pérez"); p.type("d-dob-0", "04121965"); p.address();
  p.type("d-name-1", "Luis"); p.type("d-dob-1", "03 / 04 / 65");
  p.answers(); await p.ready();
  p.hold();
  assert.equal(p.el("d-summary-t").textContent, "Todavía faltan dos cosas: el apellido del Viajero 2 y un año de cuatro dígitos en la fecha de nacimiento del Viajero 2.");
  assert.equal(p.el("d-take").textContent, "Lléveme ahí");
});

// ── The address service ───────────────────────────────────────────────────────────────────────────────────────

const FOUND_TIDY = { street: "500 E Davie St", city: "Raleigh", state: "NC", zip: "27601", formatted: "500 E Davie St, Raleigh, NC 27601" };
const lookupWith = (r: Record<string, unknown>) => ({ lookup: () => ({ ok: true, json: { success: true, ...r } }) });

test("as the street is typed (five characters or more) the page asks the post office, with whatever else is filled in; short streets ask nothing; it never asks twice for the same address", async () => {
  const p = visit("en", { post: server("en", lookupWith({ available: true, suggestions: [], incomplete: true })) });
  await p.ready();
  p.type("d-street", "12 M"); await p.flush(8);
  assert.equal(p.posts("/api/address/lookup").length, 0, "four characters ask nothing");
  p.type("d-street", "123 Main"); await p.flush(8);
  const asked = p.sent.filter((x) => x.url === "/api/address/lookup");
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]!.body, { q: "123 Main", city: "", state: "", zip: "", website: "" });
  p.type("d-city", "Raleigh"); p.type("d-st", "nc"); p.type("d-zip", "27601"); await p.flush(8);
  assert.deepEqual(p.sent.filter((x) => x.url === "/api/address/lookup").pop()!.body, { q: "123 Main", city: "Raleigh", state: "NC", zip: "27601", website: "" });
  assert.equal(p.el("d-fix").hidden, true, "'incomplete' says nothing");
  // a robot that fills the bot trap is passed on as it filled it
  const bot = visit("en");
  await bot.ready();
  bot.el("d-website").value = "http://spam.example"; bot.type("d-street", "123 Main St"); await bot.flush(8);
  assert.equal(bot.sent.find((x) => x.url === "/api/address/lookup")!.body["website"], "http://spam.example");
});

test("the post office's spelling is offered in a yellow box ('We tidied it … Right? Yes · No, I'll fix it'); Yes fills the four fields and is remembered as tidied; No keeps what was typed", async () => {
  const p = visit("en", { post: server("en", lookupWith({ available: true, suggestions: [FOUND_TIDY] })) });
  await p.ready();
  p.address({ street: "500 e davie street", city: "ral", st: "NC", zip: "" });
  await p.flush(8);
  assert.equal(p.el("d-fix").hidden, false);
  assert.equal(p.el("d-fix").innerHTML, "We tidied it to the post office's spelling: <b>500 E Davie St, Raleigh, NC 27601</b>. Right? <button type=\"button\" class=\"yes\" data-act=\"yes\">Yes</button> · <button type=\"button\" class=\"linkbtn\" data-act=\"no\">No, I&#39;ll fix it</button>".replace("&#39;", "'"));
  p.fix("yes");
  assert.deepEqual(["d-street", "d-city", "d-st", "d-zip"].map((id) => p.el(id).value), ["500 E Davie St", "Raleigh", "NC", "27601"]);
  assert.equal(p.el("d-fix").hidden, true);
  p.type("d-name-0", "Mark Millham"); p.type("d-dob-0", "04121965"); p.type("d-name-1", "Ceci Millham"); p.type("d-dob-1", "11021980"); p.answers();
  await p.flush(8);
  const save = p.sent.filter((x) => x.url === `/api/group-details/${TOKEN}`).pop()!;
  assert.deepEqual(save.body["address"], { street: "500 E Davie St", city: "Raleigh", state: "NC", zip: "27601", tidied: true });
  // typing in the address again forgets that it was tidied
  p.type("d-street", "500 E Davie St Apt 2"); await p.flush(8);
  p.address({ street: "500 E Davie St Apt 2" }); await p.flush(8);
  assert.equal(p.sent.filter((x) => x.url === `/api/group-details/${TOKEN}`).pop()!.body["address"].tidied, false);

  // "No, I'll fix it": the typed address stays, the box goes, the guest is taken back to the street
  const q = visit("en", { post: server("en", lookupWith({ available: true, suggestions: [FOUND_TIDY] })) });
  await q.ready();
  q.address({ street: "500 e davie street", city: "ral", st: "NC", zip: "" }); await q.flush(8);
  q.fix("no");
  assert.equal(q.el("d-fix").hidden, true);
  assert.equal(q.el("d-street").value, "500 e davie street");
  assert.equal(q.el("d-street").focused, 1);
  assert.equal(q.el("d-hold").getAttribute("aria-disabled"), "true", "(the rest of Part 1 is still empty)");
});

test("an address the post office already spells that way gets no box; several suggestions are a list, and picking one fills the fields and shows the box", async () => {
  const same = visit("en", { post: server("en", lookupWith({ available: true, suggestions: [{ street: "123 Main St", city: "Raleigh", state: "NC", zip: "27601", formatted: "123 Main St, Raleigh, NC 27601" }] })) });
  await same.ready();
  same.address(); await same.flush(8);
  assert.equal(same.el("d-fix").hidden, true); assert.equal(same.el("d-sugg").hidden, true);
  const many = [FOUND_TIDY, { street: "500 E Davie Ct", city: "Raleigh", state: "NC", zip: "27603", formatted: "500 E Davie Ct, Raleigh, NC 27603" }, ...Array.from({ length: 5 }, (_, i) => ({ street: `${i} Extra St`, city: "Cary", state: "NC", zip: "27511", formatted: `${i} Extra St, Cary, NC 27511` }))];
  const p = visit("en", { post: server("en", lookupWith({ available: true, suggestions: many })) });
  await p.ready();
  p.address({ street: "500 e davie", city: "ral", st: "NC", zip: "" }); await p.flush(8);
  assert.equal(p.el("d-fix").hidden, true);
  assert.equal(p.el("d-sugg").hidden, false);
  assert.deepEqual([...p.el("d-sugg").innerHTML.matchAll(/data-s="(\d)">([^<]*)</g)].map((m) => m[2]), many.slice(0, 5).map((s) => s.formatted), "up to five");
  p.pickSugg(1);
  assert.deepEqual(["d-street", "d-city", "d-st", "d-zip"].map((id) => p.el(id).value), ["500 E Davie Ct", "Raleigh", "NC", "27603"]);
  assert.equal(p.el("d-sugg").hidden, true);
  assert.equal(p.el("d-fix").hidden, false);
  assert.match(p.el("d-fix").innerHTML, /<b>500 E Davie Ct, Raleigh, NC 27603<\/b>\. Right\?/);
});

test("a street the post office cannot find is refused under the street ('We couldn't find that one…') and keeps the hold dim until it is changed", async () => {
  const p = visit("en", { post: server("en", lookupWith({ available: true, suggestions: [] })) });
  await p.ready();
  await p.fillAll();
  assert.equal(p.el("d-street-e").hidden, false);
  assert.equal(p.el("d-street-e").textContent, "We couldn't find that one… check the street and ZIP.");
  assert.equal(p.el("d-street").className, "bad");
  assert.equal(p.el("d-hold").getAttribute("aria-disabled"), "true");
  p.hold();
  assert.equal(p.el("d-summary-t").textContent, "One thing still needs you: your address (we couldn't find it).");
  assert.equal(p.sent.filter((x) => x.url.endsWith("/hold")).length, 0);
  // fixing the street clears the refusal (and asks again)
  p.type("d-street", "124 Main St");
  assert.equal(p.el("d-street-e").hidden, true);
});

test("when the address service is not available the page takes the address as typed, says so once, and stops asking", async () => {
  const p = visit("en");     // the default stand-in answers { available: false }
  await p.ready();
  await p.fillAll();
  assert.equal(p.visible("d-addr-status"), true);
  assert.equal(p.el("d-addr-status").textContent, "We couldn't check that address right now, so we'll take it as typed.");
  assert.equal(p.el("d-hold").getAttribute("aria-disabled"), "false", "an address that is well-formed holds");
  const asked = p.sent.filter((x) => x.url === "/api/address/lookup").length;
  p.type("d-street", "124 Main St"); await p.flush(8);
  assert.equal(p.sent.filter((x) => x.url === "/api/address/lookup").length, asked, "no more questions to a service that is down");
  const down = visit("en", { post: (url, body) => (url === "/api/address/lookup" ? { ok: false, status: 429, json: { success: false } } : server("en")(url, body)) });
  await down.ready();
  down.address(); await down.flush(8);
  assert.equal(down.el("d-addr-status").textContent, "We couldn't check that address right now, so we'll take it as typed.");
  const es = visit("es");
  await es.ready();
  es.address(); await es.flush(8);
  assert.equal(es.el("d-addr-status").textContent, "No pudimos revisar esa dirección en este momento, así que la tomaremos tal como la escribió.");
});

// ── Holding the cabin ─────────────────────────────────────────────────────────────────────────────────────────

test("'Hold my cabin!' asks the server to hold it, then the WHOLE page becomes one line: 'Held!… {category}, party of {n}. Watch your inbox for the confirmation.'", async () => {
  const p = visit("en");
  await p.ready();
  await p.fillAll();
  p.hold();
  await p.ready();
  const hold = p.sent.find((x) => x.url === `/api/group-details/${TOKEN}/hold`)!;
  assert.deepEqual(hold.body, { website: "" });
  for (const id of ["d-intro", "d-part1", "d-part2", "d-part3", "d-summary"]) assert.equal(p.el(id).hidden, true, id);
  assert.equal(p.el("d-thanks").hidden, false);
  assert.equal(p.el("d-thanks-h").textContent, "Held!… Balcony Bella, party of two. Watch your inbox for the confirmation.");
  assert.equal(p.el("d-thanks-p").hidden, true, "one line, nothing else");
  assert.equal(p.el("d-msg").textContent, "");
  // the party in words: one, three, four
  for (const [guests, word] of [[1, "one"], [3, "three"], [4, "four"]] as const) {
    const q = visit("en", { get: answer({ guests }) });
    await q.ready();
    q.type("d-name-0", "Mark Millham"); q.type("d-dob-0", "04121965"); q.address();
    for (let i = 1; i < guests; i++) { q.type(`d-name-${i}`, `Guest Number${"x".repeat(i)}`); q.type(`d-dob-${i}`, "01011990"); }
    q.answers(); await q.flush(8);
    q.hold(); await q.ready();
    assert.equal(q.el("d-thanks-h").textContent, `Held!… Balcony Bella, party of ${word}. Watch your inbox for the confirmation.`.replace("party of one", "party of one"));
  }
});

test("a hold on a changed form saves first, then holds; a double tap holds once", async () => {
  const p = visit("en");
  await p.ready();
  await p.fillAll();
  p.type("d-name-1", "Ceci Millham-Smith");          // changed, not yet saved (the save waits to settle)
  p.hold(); p.hold();
  await p.ready();
  const order = p.sent.filter((x) => !x.url.includes("/pick") && !x.url.includes("address")).map((x) => x.url.replace(TOKEN, ":t"));
  assert.deepEqual(order.slice(-2), ["/api/group-details/:t", "/api/group-details/:t/hold"], "the last save comes before the hold");
  assert.equal(p.sent.filter((x) => x.url.endsWith("/hold")).length, 1);
});

test("a hold the server refuses keeps the button and shows its words; a failed request does too", async () => {
  const refusing = visit("en", { post: (url, body) => (url.endsWith("/hold") ? { ok: false, status: 400, json: { success: false, error: "Please finish the names, the address and the four questions first." } } : server("en")(url, body)) });
  await refusing.ready();
  await refusing.fillAll();
  refusing.hold(); await refusing.ready();
  assert.equal(refusing.el("d-thanks").hidden, true);
  assert.equal(refusing.el("d-msg").textContent, "Please finish the names, the address and the four questions first.");
  assert.equal(refusing.el("d-hold").textContent, "Hold my cabin!");
  assert.equal(refusing.el("d-hold").getAttribute("aria-disabled"), "false");
  const down = visit("en", { post: (url, body) => { if (url.endsWith("/hold")) throw new Error("network"); return server("en")(url, body); } });
  await down.ready();
  await down.fillAll();
  down.hold(); await down.ready();
  assert.equal(down.el("d-thanks").hidden, true);
  assert.equal(down.el("d-msg").textContent, "That did not go through. Please try again, or call or text Mark at 919-346-6127.");
});

test("when the server refuses the save, its words go under the field it names and the guest is taken there; the hold is not asked", async () => {
  const p = visit("en", { post: (url, body) => (url === `/api/group-details/${TOKEN}` ? { ok: false, status: 400, json: { success: false, error: "First AND last name, please… the way the passport has it.", field: "travelers.1.legal_name" } } : server("en")(url, body)) });
  await p.ready();
  await p.fillAll();
  p.hold(); await p.ready();
  assert.equal(p.sent.filter((x) => x.url.endsWith("/hold")).length, 0);
  assert.equal(p.el("d-name-e-1").textContent, "First AND last name, please… the way the passport has it.");
  assert.equal(p.el("d-name-1").className, "bad");
  assert.ok(p.el("d-name-1").scrolledTo >= 1);
  assert.equal(p.el("d-thanks").hidden, true);
  // an address refusal lands under its own field
  const q = visit("en", { post: (url, body) => (url === `/api/group-details/${TOKEN}` ? { ok: false, status: 400, json: { success: false, error: "Five digits for the ZIP, please… like 27601.", field: "address.zip" } } : server("en")(url, body)) });
  await q.ready();
  await q.fillAll(); q.hold(); await q.ready();
  assert.equal(q.el("d-zip-e").textContent, "Five digits for the ZIP, please… like 27601.");
});

test("a guest who already asked for the hold opens straight on the one line, with the way to change something named (Mark), and nothing is sent", async () => {
  const get = answer({ holdRequestedAt: "2026-10-24T10:00:00Z", travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }], address: ADDR, concierge: ANSWERS, pick: PICK });
  const p = visit("en", { get });
  await p.ready();
  assert.equal(p.el("d-thanks").hidden, false);
  assert.equal(p.el("d-thanks-h").textContent, "Held!… Balcony Bella, party of two. Watch your inbox for the confirmation.");
  assert.equal(p.el("d-thanks-p").hidden, false);
  assert.equal(p.el("d-thanks-p").textContent, "Need to change a name, a birthday or your mind? Call or text Mark at 919-346-6127.");
  for (const id of ["d-intro", "d-part1", "d-part2", "d-part3"]) assert.equal(p.el(id).hidden, true, id);
  assert.equal(p.sent.length, 0);
});

test("a returning guest finds their names, birthdays, address, answers and pick back, with nothing re-sent until they change something", async () => {
  const get = answer({ travelers: [{ legal_name: "Mark Millham", dob: "1965-04-12" }, { legal_name: "Ceci Millham", dob: "1980-11-02" }], address: { ...ADDR, tidied: true }, concierge: ANSWERS, pick: PICK });
  const p = visit("en", { get });
  await p.ready();
  assert.deepEqual([p.el("d-name-0").value, p.el("d-dob-0").value, p.el("d-name-1").value, p.el("d-dob-1").value], ["Mark Millham", "04 / 12 / 1965", "Ceci Millham", "11 / 02 / 1980"]);
  assert.deepEqual(["d-street", "d-city", "d-st", "d-zip"].map((id) => p.el(id).value), ["123 Main St", "Raleigh", "NC", "27601"]);
  assert.equal(p.pills().filter((x) => x.on).map((x) => x.v).join(","), "balcony,quiet,middle,yes");
  assert.equal(p.el("d-part3").hidden, false);
  assert.equal(p.el("d-pick-h").textContent, "Balcony Bella, midship, a lower deck");
  assert.equal(p.el("d-hold").getAttribute("aria-disabled"), "false");
  await p.flush(8);
  assert.equal(p.sent.length, 0, "nothing is re-sent for what is already saved");
  p.type("d-name-1", "Ceci Millham-Smith"); await p.flush(8);
  assert.equal(p.sent.filter((x) => x.url === `/api/group-details/${TOKEN}`).length, 1);
  // more saved travelers than the party size: all of them are open
  const three = visit("en", { get: answer({ guests: 2, travelers: [{ legal_name: "A One", dob: "1990-01-01" }, { legal_name: "B Two", dob: "1990-01-02" }, { legal_name: "C Three", dob: "1990-01-03" }] }) });
  await three.ready();
  assert.equal(three.visible("d-trav-2"), true); assert.equal(three.el("d-count").textContent, "3");
});

test("the call link is no longer read: opening the page with &choice=call just opens the form, and nothing is sent", async () => {
  const p = visit("en", { search: `?t=${TOKEN}&choice=call` });
  await p.ready();
  assert.equal(p.sent.length, 0);
  assert.equal(p.el("d-thanks").hidden, true);
  assert.equal(p.el("d-part1").hidden, false);
});

test("the bot trap field travels with every save, pick and hold", async () => {
  const p = visit("en");
  await p.ready();
  p.el("d-website").value = "http://spam.example";
  await p.fillAll();
  p.hold(); await p.ready();
  const mine = p.sent.filter((x) => x.url.startsWith("/api/group-details/"));
  assert.ok(mine.length >= 3 && mine.every((x) => x.body["website"] === "http://spam.example"), JSON.stringify(mine.map((x) => x.url)));
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
  const perks = ["Un restaurante propio", "El spa solo para adultos", "Un solárium escondido"];
  const p = visit("es", { get, post: server("es", { perks }) });
  await p.ready();
  assert.equal(p.doc.title, "Sus datos | Amigos y Familia 2027");
  assert.equal(p.el("d-h1").textContent, "Mire nada más, tomando el mando… ¡NOS ENCANTA UN BUEN PLANIFICADOR!");
  assert.equal(p.el("d-lede").textContent, "Tres partes cortas, unos tres minutos… menos que la fila del buffet el día del embarque. Su cabina queda apartada al final.");
  assert.equal(p.el("d-p1").textContent, "Parte 1 · Quiénes vienen");
  assert.equal(p.el("d-reach-l").textContent, "Cómo comunicarnos con usted");
  assert.equal(p.el("d-who-0").textContent, "Viajero 1 · usted"); assert.equal(p.el("d-who-1").textContent, "Viajero 2");
  assert.equal(p.el("d-name-l-0").textContent, "Nombre legal, como aparece en su pasaporte");
  assert.equal(p.el("d-street-l").textContent, "Su dirección de casa"); assert.equal(p.el("d-stzip-l").textContent, "Estado · Código postal");
  assert.equal(p.el("d-more-h").textContent, "¿Son más? Entre más, mejor…");
  assert.equal(p.el("d-p2").textContent, "Parte 2 · Qué cabina le conviene");
  assert.equal(p.pills().filter((x) => x.q === "room").map((x) => x.label)[2], "Café afuera en pijama");
  p.type("d-name-0", "Ana Pérez"); p.type("d-dob-0", "04121965"); p.type("d-name-1", "Luis Pérez"); p.type("d-dob-1", "11021980"); p.address(); p.answers();
  await p.flush(8);
  assert.equal(p.sent.find((x) => x.url.endsWith("/pick"))!.body["lang"], "es");
  assert.equal(p.el("d-p3").textContent, "Parte 3 · Nuestra sugerencia para usted");
  assert.equal(p.el("d-pick-h").textContent, "Balcony Bella, en el centro del barco, en una cubierta baja");
  assert.equal(p.el("d-pick-up").innerHTML, "<b>La mejora que casi nadie conoce:</b> Aurea. Un restaurante propio, el spa solo para adultos y un solárium escondido. Pregunte a Mark por las cabinas de clase Aurea.");
  assert.equal(p.el("d-hold").textContent, "¡Apartar mi cabina!");
  assert.equal(p.el("d-hold-note").textContent, "Mark la confirma con la naviera y sus documentos le llegan después. $50 por persona la aparta… no se cobra nada esta noche.");
  p.hold(); await p.ready();
  assert.equal(p.el("d-thanks-h").textContent, "¡Apartada!… Balcony Bella, grupo de dos. Revise su correo para la confirmación.");
  const again = visit("es", { get: answer({ lang: "es", holdRequestedAt: "2026-10-24T10:00:00Z", travelers: [{ legal_name: "Ana Pérez", dob: "1965-04-12" }], address: ADDR, concierge: ANSWERS, pick: pickCabin(ANSWERS, HELD, "es", perks) }) });
  await again.ready();
  assert.equal(again.el("d-thanks-h").textContent, "¡Apartada!… Balcony Bella, para una persona. Revise su correo para la confirmación.");
  assert.equal(again.el("d-thanks-p").textContent, "¿Necesita cambiar un nombre, una fecha de nacimiento o de opinión? Llame o escriba a Mark al 919-346-6127.");
});
