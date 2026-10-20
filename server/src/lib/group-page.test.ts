// group-page.test.ts — the PUBLIC GROUP PAGE (server/public/group.html and its Spanish twin), run the way a visitor's browser runs it.
//
// Mark 2026-10-20 ("we already had this discussion"): the person who opens the page has just read the poster, the Facebook post or the email,
// so the page opens on a short personal WELCOME from the hosts, then the Count me in form, then the details; it never repeats the headline, the
// payoff or the pitch; it never prints a vendor name (airline, hotel, transfer company); and a hotel is priced per room.
//
// The page script is executed here against a minimal stand-in for the browser (just enough DOM for what the script touches) and fed the answer
// the server really builds (publicFacts + pageLook + publicCopy over a real group file), so a field the page reads and the server stopped
// sending, or a section that moved, fails here and not in front of a client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildFacts, normalizeAnswers, pageLook, publicCopy, publicFacts, type GroupCopy, type Lang } from "./group-marketing";

// Built to dist-test/lib/, so the site is two levels up.
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "../../public");
const PAGES: Record<Lang, string> = { en: "group.html", es: "es/group.html" };
const html = (lang: Lang) => readFileSync(join(PUBLIC, PAGES[lang]), "utf8");
const script = (lang: Lang) => /<script>\n([\s\S]*?)<\/script>/.exec(html(lang))![1]!;

// ── A group file as the server reads it ──────────────────────────────────────────────────────────────────────

function file() {
  return {
    group: {
      id: "g1", name: "Millham F/F 2027", organizer_name: "Mark Millham", cruise_line: "MSC CRUISES", ship_name: "MSC SEASHORE", ship_slug: "msc-seashore",
      sail_date: "2027-05-09", return_date: "2027-05-13", nights: 4, embark_port: "PCV", deposit_due: "2026-12-01", final_payment_due: "2027-02-01",
      amenities: [], inclusions: ["Premium drinks package", "Overnight at Ocean Cay"],
      itinerary: [
        { day: 1, date: "2027-05-09", port: "Port Canaveral, Florida", arrive: null, depart: "17:00" },
        { day: 2, date: "2027-05-10", port: "Nassau, Bahamas", arrive: "09:00", depart: "17:00" },
        { day: 3, date: "2027-05-11", port: "At Sea", arrive: null, depart: null },
        { day: 4, date: "2027-05-13", port: "Port Canaveral, Florida", arrive: "07:00", depart: null },
      ],
    },
    cabins: [
      { status: "held", category: "Balcony", category_code: "BAL", price_total: 2498, deposit_amount: 500 },
      { status: "held", category: "Balcony", category_code: "BAL", price_total: 2498, deposit_amount: 500 },
      { status: "held", category: "Interior", category_code: "INT", price_total: 1698, deposit_amount: 500 },
    ],
    travel: [
      { kind: "flight", direction: "pre", provider: "American Airlines", from_place: "Raleigh-Durham", price_per_person: 350, price_unit: "person", included: false, traveler_id: null, cabin_id: null },
      { kind: "hotel", direction: "pre", provider: "Marriott Courtyard", from_place: "Port Canaveral", reference: "1 night", price_per_person: 125, price_unit: "room", included: false, traveler_id: null, cabin_id: null },
      { kind: "transfer", direction: "pre", provider: "Limopedia", from_place: "Hotel", to_place: "Cruise port", price_per_person: 45, price_unit: "person", included: false, traveler_id: null, cabin_id: null },
    ],
  };
}
const rating = { status: "published", rating: 4.3, comment: "Lively ship.", comment_es: "Barco animado.", salty_mark_take: "Loud by the pool.", salty_mark_take_es: "Ruidoso junto a la piscina." };

const COPY: GroupCopy = {
  welcome: "We have wanted to sail this one together for a long time…\nSo come along, and say you are in!",
  headline: "Imagine dancing under the lighthouse light show, then walking the beach into a sunrise",
  subhead: "ALL ON THE SAME CRUISE!",
  intro: "Join us for our first Friends and Family cruise to the Bahamas! The pitch sentence that must not come back.",
  why_ship: "WHY-SHIP-PARAGRAPH Ocean Cay is a private island.",
  who_for: "WHO-FOR-PARAGRAPH Friends and family, first-timers welcome.",
  organizer_note: null,
  cta_label: "Tell us you're in",
  cta_blurb: "Tap here to book your spot!",
  email_subject: "x", email_body: "y", social_post: "z",
};

/** The answer GET /api/group-page/:code gives for this file, built by the same functions the route calls. */
function answerFor(lang: Lang, over: { answers?: Record<string, unknown>; copy?: Partial<GroupCopy>; withRating?: boolean } = {}) {
  const answers = normalizeAnswers({ show_rating: true, ...over.answers });
  const facts = buildFacts(file(), over.withRating === false ? null : rating, lang);
  return {
    success: true, live: true, preview: false, langs: [lang],
    facts: publicFacts(facts, answers), look: pageLook(answers), copy: publicCopy({ ...COPY, ...over.copy }), turnstileSiteKey: "",
  };
}

// ── The browser stand-in ─────────────────────────────────────────────────────────────────────────────────────

class El {
  textContent = ""; innerHTML = ""; hidden = false; className = ""; value = ""; checked = false; disabled = false; alt = ""; decoding = ""; src = "";
  onload: (() => void) | null = null; onerror: (() => void) | null = null; parentNode: El | null = null; firstChild: El | null = null;
  private attrs: Record<string, string> = {};
  constructor(readonly id: string) {}
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener() { /* the form's submit handler is not exercised here */ }
  kids: El[] = [];
  appendChild(c: El) { c.parentNode = this; this.kids.push(c); return c; }
  insertBefore(c: El) { c.parentNode = this; this.kids.unshift(c); return c; }
  removeChild() { /* nothing */ }
  reset() { /* nothing */ }
}

function visit(lang: Lang, answer: unknown, search = "?g=abcdefghjk") {
  const els = new Map<string, El>();
  const el = (id: string) => { let e = els.get(id); if (!e) els.set(id, (e = new El(id))); return e; };
  const doc = {
    documentElement: { lang }, title: "", head: { appendChild() { /* turnstile script: not requested without a site key */ } },
    getElementById: el, querySelectorAll: () => [] as El[], querySelector: (sel: string) => el(`query:${sel}`),
    createElement: (tag: string) => {
      if (tag !== "div") return new El(`created:${tag}`);
      // the page escapes text through a <div>: textContent in, innerHTML (escaped) out
      let text = "";
      return { set textContent(v: string) { text = v; }, get innerHTML() { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); } };
    },
  };
  // an element that starts hidden in the page's own markup starts hidden here, so "the page showed it" means the script un-hid it
  for (const m of html(lang).matchAll(/<[a-z0-9]+\s[^>]*?\bid="([^"]+)"[^>]*>/g)) if (/\shidden(?=[\s>=])/.test(m[0])) el(m[1]!).hidden = true;
  const requested: string[] = [];
  const sandbox = {
    document: doc, window: {}, location: { search, hash: "" }, URLSearchParams, decodeURIComponent, encodeURIComponent, setTimeout, console,
    fetch: (url: string) => { requested.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) }); },
  };
  runInNewContext(script(lang), sandbox);
  return { els, el, doc, requested, ready: async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); } };
}

// ── The order of the page ───────────────────────────────────────────────────────────────────────────────────

test("both pages (English and Spanish) are the same page: the welcome, then Count me in, then the plan, your cabin, getting there, the score, the dates and the advisor", () => {
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    const at = (needle: string) => { const i = h.indexOf(needle); assert.ok(i > 0, `${lang}: ${needle}`); return i; };
    const order = ['id="sec-welcome"', 'id="interest"', 'id="gp-form"', 'id="sec-itin"', 'id="sec-cabin"', 'id="sec-travel"', 'id="sec-rating"', 'id="sec-org"', 'id="sec-dates"', 'data-t="about"'].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${lang}: the sections are out of order`);
    // the pitch and the poster's words are not on the page at all
    for (const gone of ['id="gp-headline"', 'id="gp-subhead"', 'id="gp-intro"', 'id="gp-why"', 'id="gp-who"', "class=\"lead\""]) assert.ok(!h.includes(gone), `${lang}: ${gone} is back`);
    const s = script(lang);
    for (const k of ["headline", "subhead", "intro", "why_ship", "who_for"]) assert.ok(!new RegExp(`\\bc\\.${k}\\b`).test(s), `${lang}: the script reads copy.${k}`);
    assert.ok(/\bc\.welcome\b/.test(s) && /\bc\.cta_label\b/.test(s) && /\bc\.cta_blurb\b/.test(s));
    // the call to action is still the yellow pill that says Count me in
    assert.ok(h.includes('id="gp-submit"') && h.includes("background:#f5c33b"));
    // no cabin picker and no cabin table: the page only asks "I'm interested" (the price list is not a table or a picker)
    assert.ok(!/id="gp-cabins"|id="f-cabin"|id="sec-cabins"/.test(h), `${lang}: a cabin table or picker is back`);
  }
  assert.match(script("en"), /count_me_in:'Count me in!'/); assert.match(script("es"), /count_me_in:'¡Cuenten conmigo!'/);
  assert.match(script("en"), /itinerary:'The plan, day by day'/); assert.match(script("es"), /itinerary:'El plan, día a día'/);
  assert.match(script("en"), /cabin:'Your cabin'/); assert.match(script("es"), /cabin:'Su cabina'/);
});

test("the two pages differ only in their language, title, plaque and honeypot label", () => {
  const norm = (s: string) => s
    .replace('<html lang="en">', "<html>").replace('<html lang="es">', "<html>")
    .replace("<title>Group Cruise | Still Afloat Cruising</title>", "<title/>").replace("<title>Crucero en grupo | Still Afloat Cruising</title>", "<title/>")
    .replace(">Group Cruise</h1>", "></h1>").replace(">Crucero en grupo</h1>", "></h1>")
    .replace("<label>Website<input", "<label><input").replace("<label>Sitio web<input", "<label><input");
  assert.equal(norm(html("es")), norm(html("en")));
});

test("the welcome is large, warm type on the dark page, and the signature is in the gold accent", () => {
  const h = html("en");
  const note = /\.welcome \.note\{([^}]*)\}/.exec(h)?.[1] ?? "";
  const size = /font-size:clamp\((\d+)px/.exec(note)?.[1];
  assert.ok(size && Number(size) >= 20, `the welcome's smallest size is ${size}px`);
  assert.match(note, /color:#fff/);
  assert.match(/\.welcome \.sig\{([^}]*)\}/.exec(h)?.[1] ?? "", /color:#ffca4f/);
  assert.match(h, /body\{[^}]*background:linear-gradient\(to bottom,#06111f/, "on the page's dark theme");
});

// ── The page, run ────────────────────────────────────────────────────────────────────────────────────────────

test("the page opens on the welcome signed with the hosts' names, and shows neither the headline nor the pitch (EN and ES)", async () => {
  for (const lang of ["en", "es"] as const) {
    const answer = answerFor(lang, { answers: { host_names: "Mark & Ceci" } });
    const p = visit(lang, answer);
    await p.ready();
    assert.deepEqual(p.requested, [`/api/group-page/abcdefghjk?lang=${lang}`]);
    assert.equal(p.el("gp-welcome").textContent, COPY.welcome);
    assert.equal(p.el("gp-sig").textContent, "Mark & Ceci");
    assert.equal(p.el("sec-welcome").hidden, false);
    assert.equal(p.el("gp-main").hidden, false);
    assert.equal(p.el("gp-cta-title").textContent, "Tell us you're in");
    assert.equal(p.el("gp-cta-blurb").textContent, "Tap here to book your spot!");
    assert.equal(p.el("gp-submit").textContent, lang === "es" ? "¡Cuenten conmigo!" : "Count me in!");
    // nothing of the poster's words anywhere the page writes
    const written = [...p.els.values()].map((e) => `${e.textContent}\n${e.innerHTML}`).join("\n") + p.doc.title;
    for (const gone of ["lighthouse light show", "ALL ON THE SAME CRUISE", "pitch sentence that must not come back", "WHY-SHIP-PARAGRAPH", "WHO-FOR-PARAGRAPH"]) assert.ok(!written.includes(gone), `${lang}: "${gone}" is on the page`);
    assert.equal(p.doc.title, "Millham F/F 2027 | Still Afloat Cruising", "the tab names the group, not the poster's headline");
    assert.equal(p.el("gp-plaque").textContent, "Millham F/F 2027");
  }
});

test("even if the answer still carried the poster's words (an older server), the page does not print them", async () => {
  const answer = { ...answerFor("en"), copy: { ...answerFor("en").copy, headline: "OLD-HEADLINE", subhead: "OLD-SUBHEAD", intro: "OLD-INTRO", why_ship: "OLD-WHY", who_for: "OLD-WHO" } };
  const p = visit("en", answer);
  await p.ready();
  const written = [...p.els.values()].map((e) => `${e.textContent}\n${e.innerHTML}`).join("\n") + p.doc.title;
  for (const gone of ["OLD-HEADLINE", "OLD-SUBHEAD", "OLD-INTRO", "OLD-WHY", "OLD-WHO"]) assert.ok(!written.includes(gone), gone);
});

test("a group with no welcome (copy written before it existed) opens straight on the form; the signature is Mark unless the interview names the hosts", async () => {
  const none = visit("en", answerFor("en", { copy: { welcome: null } }));
  await none.ready();
  assert.equal(none.el("sec-welcome").hidden, true, "no empty welcome box");
  assert.equal(none.el("gp-cta-title").textContent, "Tell us you're in", "the form is there");
  const blank = visit("en", answerFor("en", { copy: { welcome: "   " } }));
  await blank.ready();
  assert.equal(blank.el("sec-welcome").hidden, true);
  const alone = visit("en", answerFor("en"));
  await alone.ready();
  assert.equal(alone.el("gp-sig").textContent, "Mark");
});

test("your cabin lists each category with its from-price per person, then the price note, the plans line and the upgrade offer; no cabin counts", async () => {
  const en = visit("en", answerFor("en"));
  await en.ready();
  const list = en.el("gp-cabin-prices").innerHTML;
  assert.match(list, /<span class="cat">Interior<\/span><span class="amt">from \$849 <small>per person<\/small><\/span>/);
  assert.match(list, /<span class="cat">Balcony<\/span><span class="amt">from \$1,249 <small>per person<\/small><\/span>/);
  assert.ok(list.indexOf("Interior") < list.indexOf("Balcony"), "cheapest first");
  assert.equal(en.el("gp-cabin-card").hidden, false);
  assert.equal(en.el("gp-from").hidden, true, "the single from line is only for a file with no category list");
  assert.match(en.el("gp-fine").textContent, /^Price is per person, based on two guests per cabin\. The price, taxes, fees and port expenses are confirmed in writing when you book\.$/);
  assert.equal(en.el("gp-fine").hidden, false);
  assert.equal(en.el("gp-upgrades").textContent, "Cabin upgrades available — ask Mark");
  assert.match(en.el("gp-perks").innerHTML, /Premium drinks package/);
  assert.equal(en.el("sec-perks").hidden, false);
  // taxes-included variant
  const tax = visit("en", answerFor("en", { answers: { taxes_included: true } }));
  await tax.ready();
  assert.equal(tax.el("gp-fine").textContent, "Price is per person, based on two guests per cabin, with taxes and port fees included.");
  // Spanish
  const es = visit("es", answerFor("es"));
  await es.ready();
  assert.match(es.el("gp-cabin-prices").innerHTML, /<span class="amt">desde \$849 <small>por persona<\/small><\/span>/);
  assert.equal(es.el("gp-upgrades").textContent, "Mejoras de cabina disponibles — pregunte a Mark");
  // prices off: no category prices, no from line, no price note
  const off = visit("en", answerFor("en", { answers: { show_prices: false } }));
  await off.ready();
  assert.equal(off.el("gp-cabin-card").hidden, true); assert.equal(off.el("gp-from").hidden, true); assert.equal(off.el("gp-fine").hidden, true);
  // nothing in the answer or on the page counts cabins
  const answer = JSON.stringify(answerFor("en"));
  for (const leak of ["cabinsAvailable", "cabinsTotal", "available", "deposit", "BAL", "INT"]) assert.ok(!answer.includes(leak), `${leak} is in the public answer`);
});

test("a file with only a from-price and no category list shows the one From line", async () => {
  const answer = answerFor("en");
  (answer.facts as Record<string, unknown>)["cabinPrices"] = [];
  const p = visit("en", answer);
  await p.ready();
  assert.equal(p.el("gp-cabin-card").hidden, true);
  assert.equal(p.el("gp-from").hidden, false);
  assert.equal(p.el("gp-from").textContent, "From $849 per person");
});

test("getting there reads in the guest's words with no vendor name, a hotel per room and the rest per person (EN and ES)", async () => {
  const en = visit("en", answerFor("en"));
  await en.ready();
  const rows = [...en.el("gp-travel").innerHTML.matchAll(/<li><i class="fa-solid fa-([a-z-]+)"><\/i><span>([^<]*)<\/span><\/li>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [
    ["plane", "Flight from Raleigh-Durham: $350 per person"],
    ["bed", "Hotel the night before in Port Canaveral (1 night): $125 per room"],
    ["van-shuttle", "Hotel to Cruise port: $45 per person"],
  ]);
  assert.equal(en.el("sec-travel").hidden, false);
  const es = visit("es", answerFor("es"));
  await es.ready();
  const esRows = [...es.el("gp-travel").innerHTML.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(esRows, [
    "Vuelo desde Raleigh-Durham: $350 por persona",
    "Hotel la noche anterior en Port Canaveral (1 noche): $125 por habitación",
    "Hotel a puerto de cruceros: $45 por persona",
  ]);
  for (const lang of ["en", "es"] as const) {
    const all = JSON.stringify(answerFor(lang)) + (lang === "en" ? en : es).el("gp-travel").innerHTML;
    for (const vendor of ["American", "Airlines", "Marriott", "Courtyard", "Limopedia"]) assert.ok(!all.includes(vendor), `${lang}: ${vendor} reached the client`);
  }
});

test("the Conga Line score card shows only when the group shows it, and the long 'why this ship' and 'who it suits' paragraphs are gone", async () => {
  const shown = visit("en", answerFor("en"));
  await shown.ready();
  assert.equal(shown.el("sec-rating").hidden, false);
  assert.equal(shown.el("gp-score").textContent, "4.3");
  assert.equal(shown.el("gp-score-comment").textContent, "Lively ship.");
  const off = visit("en", answerFor("en", { answers: { show_rating: false } }));
  await off.ready();
  assert.equal(off.el("sec-rating").hidden, true, "show_rating off: no card");
  const none = visit("en", answerFor("en", { withRating: false }));
  await none.ready();
  assert.equal(none.el("sec-rating").hidden, true, "no published score: no card");
});

test("the plan shows the sailing at a glance and the day-by-day table; the dates that matter and the advisor still close the page", async () => {
  const p = visit("en", answerFor("en"));
  await p.ready();
  const stats = p.el("gp-stats").innerHTML;
  for (const want of ["MSC Seashore", "May 9, 2027", "Port Canaveral, Florida"]) assert.ok(stats.includes(want), want);
  assert.ok(!/From|\$849/.test(stats), "the price lives under Your cabin now");
  assert.equal(p.el("gp-itin-wrap").hidden, false);
  assert.match(p.el("gp-itin").innerHTML, /<td>1<\/td><td>May 9, 2027<\/td><td class="">Port Canaveral, Florida<\/td><td>depart 5:00 PM<\/td>/);
  assert.match(p.el("gp-itin").innerHTML, /Day at sea/);
  assert.equal(p.el("sec-dates").hidden, false);
  assert.match(p.el("gp-dates").innerHTML, /Reserve by/);
  assert.match(p.el("gp-legal").textContent, /Still Afloat LLC/);
});

test("the group's top picture and hosts' photo still go to the banner, and a link that is not https shows nothing", async () => {
  const p = visit("en", answerFor("en", { answers: { hero_photo: "https://stillafloatcruising.com/h.jpg", host_photo: "https://stillafloatcruising.com/hosts.jpg" } }));
  await p.ready();
  const banner = p.el("query:.gp-banner");
  assert.deepEqual(banner.kids.map((k) => [k.className, k.src]), [["gp-hero", "https://stillafloatcruising.com/h.jpg"], ["gp-host", "https://stillafloatcruising.com/hosts.jpg"]]);
  const bad = visit("en", { ...answerFor("en"), look: { heroUrl: "javascript:alert(1)", hostPhotoUrl: "http://stillafloatcruising.com/x.jpg", taxesIncluded: false, hostNames: "Mark", label: null } });
  await bad.ready();
  assert.deepEqual(bad.el("query:.gp-banner").kids, [], "neither picture is used");
});
