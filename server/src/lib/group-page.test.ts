// group-page.test.ts — the PUBLIC GROUP PAGE (server/public/group.html and its Spanish twin), run the way a visitor's browser runs it.
//
// Mark 2026-10-20 ("we already had this discussion"): the person who opens the page has just read the poster, the Facebook post or the email,
// so the page opens on a short personal WELCOME from the hosts; it never repeats the headline, the payoff or the pitch; it never prints a vendor name
// (airline, hotel, transfer company); and a hotel is priced per room.
// Mark 2026-10-23 (design v2): the header is the logo and the language link only; the welcome is "Welcome!" and a paragraph per line; the ONE form
// (name, email or phone, how many) comes next; then the plan day by day (a sentence a day), the cabin prices, the dates, getting there; no ship rating,
// no advisor bio; a navy footer with the logo, the legal line, the photo credits and the Cornerstone logo.
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
const css = (lang: Lang) => /<style>([\s\S]*?)<\/style>/.exec(html(lang))![1]!;

// ── A group file as the server reads it ──────────────────────────────────────────────────────────────────────

function file() {
  return {
    group: {
      id: "g1", name: "Millham F/F 2027", organizer_name: "Mark Millham", cruise_line: "MSC CRUISES", ship_name: "MSC SEASHORE", ship_slug: "msc-seashore",
      sail_date: "2027-05-09", return_date: "2027-05-13", nights: 4, embark_port: "PCV", deposit_due: "2026-12-01", final_payment_due: "2027-02-01",
      amenities: [], inclusions: ["Premium drinks package", "Overnight at Ocean Cay"],
      itinerary: [
        { day: 1, date: "2027-05-09", port: "Port Canaveral (Orlando), Florida", arrive: null, depart: "16:00" },
        { day: 2, date: "2027-05-10", port: "Nassau, Bahamas", arrive: "09:00", depart: "18:00" },
        { day: 3, date: "2027-05-11", port: "Ocean Cay MSC Marine Reserve, Bahamas", arrive: "08:00", depart: null },
        { day: 4, date: "2027-05-12", port: "Ocean Cay MSC Marine Reserve, Bahamas", arrive: null, depart: "12:00" },
        { day: 5, date: "2027-05-13", port: "Port Canaveral (Orlando), Florida", arrive: "07:00", depart: null },
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
  welcome: "You tapped, so you are curious… great!\nWe have wanted to sail this one together for a long time…\nONE CRUISE, AND WE WANT YOU ON IT!\nSo come along, and say you are in!",
  headline: "Imagine dancing under the lighthouse light show, then walking the beach into a sunrise",
  subhead: "ALL ON THE SAME CRUISE!",
  intro: "Join us for our first Friends and Family cruise to the Bahamas! The pitch sentence that must not come back.",
  why_ship: "WHY-SHIP-PARAGRAPH Ocean Cay is a private island.",
  who_for: "WHO-FOR-PARAGRAPH Friends and family, first-timers welcome.",
  organizer_note: null,
  cta_label: "Tell us you're in",
  cta_blurb: "Questions? Call or text Mark at 919-346-6127.",
  email_subject: "x", email_body: "y", social_post: "z",
};

/** The answer GET /api/group-page/:code gives for this file, built by the same functions the route calls. */
function answerFor(lang: Lang, over: { answers?: Record<string, unknown>; copy?: Partial<GroupCopy>; withRating?: boolean; credits?: string[]; itinerary?: unknown[]; travel?: unknown[]; langs?: Lang[] } = {}) {
  const answers = normalizeAnswers({ show_rating: true, ...over.answers });
  const f = file();
  const withOver = { ...f, group: { ...f.group, ...(over.itinerary ? { itinerary: over.itinerary } : {}) }, travel: (over.travel ?? f.travel) as Array<Record<string, unknown>> };
  const facts = buildFacts(withOver, over.withRating === false ? null : rating, lang);
  return {
    success: true, live: true, preview: false, langs: over.langs ?? [lang],
    facts: publicFacts(facts, answers), look: pageLook(answers, over.credits ?? []), copy: publicCopy({ ...COPY, ...over.copy }), turnstileSiteKey: "",
  };
}

// ── The browser stand-in ─────────────────────────────────────────────────────────────────────────────────────

class El {
  textContent = ""; innerHTML = ""; hidden = false; className = ""; value = ""; checked = false; disabled = false; alt = ""; decoding = ""; src = ""; placeholder = "";
  onload: (() => void) | null = null; onerror: (() => void) | null = null; parentNode: El | null = null; firstChild: El | null = null;
  private attrs: Record<string, string> = {};
  handlers: Record<string, (e: { preventDefault(): void }) => void> = {};
  constructor(readonly id: string) {}
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void) { this.handlers[type] = fn; }
  kids: El[] = [];
  appendChild(c: El) { c.parentNode = this; this.kids.push(c); return c; }
  insertBefore(c: El) { c.parentNode = this; this.kids.unshift(c); return c; }
  removeChild() { /* nothing */ }
  reset() { /* nothing */ }
}

type Sent = { url: string; method: string; body: Record<string, unknown> };

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
  const sent: Sent[] = [];
  const sandbox = {
    document: doc, window: {}, location: { search, hash: "" }, URLSearchParams, decodeURIComponent, encodeURIComponent, setTimeout, console,
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") { sent.push({ url, method: "POST", body: JSON.parse(init.body ?? "{}") as Record<string, unknown> }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }); }
      requested.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) });
    },
  };
  runInNewContext(script(lang), sandbox);
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  return {
    els, el, doc, requested, sent, ready: flush,
    /** Fill the form the way a visitor would and press Count me in. */
    async submit(v: { name?: string; contact?: string; guests?: string; website?: string }) {
      el("f-name").value = v.name ?? ""; el("f-contact").value = v.contact ?? ""; el("f-guests").value = v.guests ?? "2"; el("f-website").value = v.website ?? "";
      let prevented = false;
      el("gp-form").handlers["submit"]!({ preventDefault() { prevented = true; } });
      assert.ok(prevented, "the form does not submit the page away");
      await flush();
    },
  };
}

const PLAN_ROW = (wd: string, date: string, sentence: string) => `<div class="day"><b>${wd}<br>${date}</b><span>${sentence}</span></div>`;

// ── The order of the page ───────────────────────────────────────────────────────────────────────────────────

test("both pages (English and Spanish) are the same page: header, hero, welcome, the one form, the plan, the cabins, the dates, getting there, the footer", () => {
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    const at = (needle: string) => { const i = h.indexOf(needle); assert.ok(i > 0, `${lang}: ${needle}`); return i; };
    const order = ['class="hdr"', 'class="gp-banner"', 'id="sec-welcome"', 'id="sec-org"', 'id="interest"', 'id="gp-form"', 'id="gp-photo-plan"', 'id="sec-itin"', 'id="gp-photo-cabin"', 'id="sec-cabin"', 'id="sec-dates"', 'id="sec-travel"', 'class="foot"'].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${lang}: the sections are out of order`);
    // the pitch and the poster's words are not on the page at all
    for (const gone of ['id="gp-headline"', 'id="gp-subhead"', 'id="gp-intro"', 'id="gp-why"', 'id="gp-who"', "class=\"lead\""]) assert.ok(!h.includes(gone), `${lang}: ${gone} is back`);
    const s = script(lang);
    for (const k of ["headline", "subhead", "intro", "why_ship", "who_for"]) assert.ok(!new RegExp(`\\bc\\.${k}\\b`).test(s), `${lang}: the script reads copy.${k}`);
    assert.deepEqual([...new Set([...s.matchAll(/\bc\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort(), ["cta_blurb", "cta_label", "organizer_note", "welcome"], `${lang}: the copy names the page reads`);
    // the call to action is still the yellow pill
    assert.ok(h.includes('id="gp-submit"') && /\.btn\{[^}]*background:#f5c33b;color:#07183f/.test(h));
    // no cabin picker and no cabin table: the page only asks "I'm interested" (the price list is not a table or a picker)
    assert.ok(!/id="gp-cabins"|id="f-cabin"|id="sec-cabins"/.test(h), `${lang}: a cabin table or picker is back`);
  }
  assert.match(script("en"), /count_me_in:'Count me in!'/); assert.match(script("es"), /count_me_in:'¡Cuenten conmigo!'/);
  assert.match(script("en"), /itinerary:'The plan, day by day'/); assert.match(script("es"), /itinerary:'El plan, día a día'/);
  assert.match(script("en"), /cabin:'Your cabin'/); assert.match(script("es"), /cabin:'Su cabina'/);
  assert.match(script("en"), /welcome_h:'Welcome!'/); assert.match(script("es"), /welcome_h:'¡Bienvenidos!'/);
  assert.match(script("en"), /put_name:'Put your name down'/); assert.match(script("es"), /put_name:'Deje su nombre'/);
  assert.match(script("en"), /only_step:'This is the only step\. Your name, how to reach you, how many, and Mark takes it from there\.'/);
});

test("the header is the logo and the language link only: no site menu, and nothing about the ship rating, the advisor or Cornerstone is on either page", () => {
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    const header = h.slice(h.indexOf('<div class="hdr">'), h.indexOf('<div id="gp-preview"'));
    assert.deepEqual([...header.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map((m) => m[1]), ["/assets/images/still_afloat_logo.png"], `${lang}: the header holds more than the logo`);
    assert.ok(header.includes('id="gp-lang"'), `${lang}: the language link is gone`);
    assert.ok(!/<a\b|<nav\b/.test(header), `${lang}: a link or menu is in the header`);
    // the site menu is removed from these two pages only
    assert.ok(!h.includes("navbar-container") && !h.includes("navbar.js"), `${lang}: the site menu is back`);
    // removed for good: the ship rating, the advisor, the second call to action, the old form fields
    for (const gone of ['id="sec-rating"', "gp-score", "Conga", 'data-t="about"', 'data-t="bio"', "Your cruise advisor", 'id="f-news"', 'id="f-note"', 'id="f-first"', 'id="f-last"', 'id="f-email"', 'id="f-phone"', 'type="checkbox"', "<textarea"]) {
      assert.ok(!h.includes(gone), `${lang}: ${gone} is back`);
    }
    assert.ok(!/conga|salty|score/i.test(script(lang)), `${lang}: the script still knows about the rating`);
    const visible = h.replace(/<script\b[\s\S]*?<\/script>/g, " ").replace(/<style\b[\s\S]*?<\/style>/g, " ").replace(/<img\b[^>]*>/g, " ").replace(/<!--[\s\S]*?-->/g, " ");
    assert.ok(!/cornerstone/i.test(visible) && !/cornerstone/i.test(script(lang)), `${lang}: the word Cornerstone is on the page (only its logo may be)`);
    assert.equal((h.match(/id="gp-submit"/g) ?? []).length, 1, `${lang}: exactly one call to action`);
  }
});

test("the form is one name box, one email-or-phone box, how many, the bot trap and the quiet security check", () => {
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    const form = h.slice(h.indexOf('<form id="gp-form"'), h.indexOf("</form>"));
    assert.deepEqual([...form.matchAll(/<(input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[2]), ["f-name", "f-contact", "f-guests", "f-website"]);
    assert.match(form, /id="gp-turnstile"[^>]*data-appearance="interaction-only"/, `${lang}: the security check is not interaction-only`);
    assert.match(script(lang), /appearance: 'interaction-only'/);
    assert.match(script(lang), /'cf-turnstile-response': turnstileToken/);
    assert.ok(form.includes('class="hp"') && form.includes('id="f-website"'));
    assert.ok(!/<input\b[^>]*type="(checkbox|email|tel)"/.test(form), `${lang}: a checkbox, an email or a phone field is back`);
  }
  assert.match(script("en"), /f_name:'Your name', ph_name:'First and last', f_contact:'Email or phone', ph_contact:"Whichever you'd rather we use", f_guests:'How many of you'/);
});

test("the two pages differ only in their language, title, plaque and honeypot label", () => {
  const norm = (s: string) => s
    .replace('<html lang="en">', "<html>").replace('<html lang="es">', "<html>")
    .replace("<title>Group Cruise | Still Afloat Cruising</title>", "<title/>").replace("<title>Crucero en grupo | Still Afloat Cruising</title>", "<title/>")
    .replace('id="gp-plaque">Group Cruise</span>', 'id="gp-plaque"></span>').replace('id="gp-plaque">Crucero en grupo</span>', 'id="gp-plaque"></span>')
    .replace("<label>Website<input", "<label><input").replace("<label>Sitio web<input", "<label><input");
  assert.equal(norm(html("es")), norm(html("en")));
});

test("the page is one centered column of at most 640px on a navy page with cloud-white panels, and no white text is smaller than 15px", () => {
  for (const lang of ["en", "es"] as const) {
    const c = css(lang);
    assert.match(c, /\.wrap\{max-width:640px;margin:0 auto\}/);
    assert.match(c, /--navy:#07183f;--cloud:#f7fbff;--gold:#ffca4f;--yellow:#f5c33b/);
    assert.match(c, /html,body\{margin:0;background:var\(--navy\)\}/);
    assert.match(c, /\.welcome \.sig\{[^}]*color:#ffca4f/, "the signature is in the gold accent");
    assert.match(c, /'Bree Serif'/); assert.match(c, /'Baloo 2'/);
    // every rule that sets white text and a size: at least 15px (rgba white under 15px is the design's old 12px credit line)
    const flat = c.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of flat.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const [sel, body] = [m[1]!.trim(), m[2]!];
      if (!/(^|;)\s*color:(#fff\b|#ffffff|rgba\(255,255,255)/.test(body)) continue;
      const size = /font-size:(\d+(?:\.\d+)?)px/.exec(body)?.[1];
      if (size) assert.ok(Number(size) >= 15, `${lang}: white text of ${size}px in ${sel}`);
    }
    // text on the navy page is at least 20px; the footer's small print is the only smaller text and it is at least 15px
    assert.match(c, /body\{[^}]*font-size:20px/);
    assert.match(c, /\.welcome p\{[^}]*font-size:21px/);
    assert.match(c, /\.foot p\{[^}]*font-size:15px/);
  }
});

// ── The page, run ────────────────────────────────────────────────────────────────────────────────────────────

test("the page opens on the welcome, a paragraph per line with the capitals-and-! line as the bold payoff, signed with the hosts' names; no headline or pitch (EN and ES)", async () => {
  for (const lang of ["en", "es"] as const) {
    const answer = answerFor(lang, { answers: { host_names: "Mark & Ceci" } });
    const p = visit(lang, answer);
    await p.ready();
    assert.deepEqual(p.requested, [`/api/group-page/abcdefghjk?lang=${lang}`]);
    assert.equal(p.el("gp-welcome").innerHTML,
      "<p>You tapped, so you are curious…" + " great!</p><p>We have wanted to sail this one together for a long time…</p><p class=\"payoff\">ONE CRUISE, AND WE WANT YOU ON IT!</p><p>So come along, and say you are in!</p>");
    assert.equal(p.el("gp-sig").textContent, "Mark & Ceci");
    assert.equal(p.el("sec-welcome").hidden, false);
    assert.equal(p.el("gp-main").hidden, false);
    // the button is the group's own words, the phone line under it is the copy's blurb
    assert.equal(p.el("gp-submit").textContent, "Tell us you're in");
    assert.equal(p.el("gp-cta-blurb").textContent, "Questions? Call or text Mark at 919-346-6127.");
    assert.equal(p.el("gp-cta-blurb").hidden, false);
    // nothing of the poster's words anywhere the page writes
    const written = [...p.els.values()].map((e) => `${e.textContent}\n${e.innerHTML}`).join("\n") + p.doc.title;
    for (const gone of ["lighthouse light show", "ALL ON THE SAME CRUISE", "pitch sentence that must not come back", "WHY-SHIP-PARAGRAPH", "WHO-FOR-PARAGRAPH"]) assert.ok(!written.includes(gone), `${lang}: "${gone}" is on the page`);
    assert.equal(p.doc.title, "Millham F/F 2027 | Still Afloat Cruising", "the tab names the group, not the poster's headline");
    assert.equal(p.el("gp-plaque").textContent, "Millham F/F 2027");
  }
});

test("only a line in capitals that ends with '!' is the payoff; a shouted line without '!', a mixed-case line and markup are plain paragraphs", async () => {
  const welcome = "ONE CRUISE, AND WE WANT YOU ON IT!\nALL CAPITALS BUT NO MARK\nNot ALL caps!\n¡UNA SOLA TRAVESÍA, Y LOS QUEREMOS A BORDO!\n123!\n<b>HTML</b> is shown as text\n\n   \nLast line";
  const p = visit("en", answerFor("en", { copy: { welcome } }));
  await p.ready();
  assert.equal(p.el("gp-welcome").innerHTML, [
    '<p class="payoff">ONE CRUISE, AND WE WANT YOU ON IT!</p>', "<p>ALL CAPITALS BUT NO MARK</p>", "<p>Not ALL caps!</p>", '<p class="payoff">¡UNA SOLA TRAVESÍA, Y LOS QUEREMOS A BORDO!</p>',
    "<p>123!</p>", "<p>&lt;b&gt;HTML&lt;/b&gt; is shown as text</p>", "<p>Last line</p>"].join(""));
});

test("the organizer's line shows after the welcome only when the copy has one", async () => {
  const none = visit("en", answerFor("en"));
  await none.ready();
  assert.equal(none.el("sec-org").hidden, true);
  const has = visit("en", answerFor("en", { copy: { organizer_note: "See you there — Pat" } }));
  await has.ready();
  assert.equal(has.el("sec-org").hidden, false);
  assert.equal(has.el("gp-org").textContent, "See you there — Pat");
});

test("even if the answer still carried the poster's words (an older server), the page does not print them", async () => {
  const answer = { ...answerFor("en"), copy: { ...answerFor("en").copy, headline: "OLD-HEADLINE", subhead: "OLD-SUBHEAD", intro: "OLD-INTRO", why_ship: "OLD-WHY", who_for: "OLD-WHO" } };
  const p = visit("en", answer);
  await p.ready();
  const written = [...p.els.values()].map((e) => `${e.textContent}\n${e.innerHTML}`).join("\n") + p.doc.title;
  for (const gone of ["OLD-HEADLINE", "OLD-SUBHEAD", "OLD-INTRO", "OLD-WHY", "OLD-WHO"]) assert.ok(!written.includes(gone), gone);
});

test("a group with no welcome (copy written before it existed) opens straight on the form; the signature is Mark unless the interview names the hosts; a blank button label falls back to Count me in", async () => {
  const none = visit("en", answerFor("en", { copy: { welcome: null } }));
  await none.ready();
  assert.equal(none.el("sec-welcome").hidden, true, "no empty welcome box");
  assert.equal(none.el("gp-submit").textContent, "Tell us you're in", "the form is there");
  const blank = visit("en", answerFor("en", { copy: { welcome: "   ", cta_label: "  ", cta_blurb: "" } }));
  await blank.ready();
  assert.equal(blank.el("sec-welcome").hidden, true);
  assert.equal(blank.el("gp-submit").textContent, "Count me in!");
  assert.equal(blank.el("gp-cta-blurb").hidden, true, "no empty phone line");
  const es = visit("es", answerFor("es", { copy: { cta_label: "" } }));
  await es.ready();
  assert.equal(es.el("gp-submit").textContent, "¡Cuenten conmigo!");
  const alone = visit("en", answerFor("en"));
  await alone.ready();
  assert.equal(alone.el("gp-sig").textContent, "Mark");
});

test("the plan is one sentence a day built from the itinerary, with the weekday and short date beside it (the brief's itinerary, English)", async () => {
  const en = visit("en", answerFor("en"));
  await en.ready();
  assert.equal(en.el("sec-itin").hidden, false);
  assert.equal(en.el("gp-itin").innerHTML, [
    PLAN_ROW("Sun", "May 9", "We sail from Port Canaveral at 4:00 PM."),
    PLAN_ROW("Mon", "May 10", "Nassau, 9:00 AM to 6:00 PM."),
    PLAN_ROW("Tue", "May 11", "Ocean Cay from 8:00 AM, and we stay the night."),
    PLAN_ROW("Wed", "May 12", "Ocean Cay until noon."),
    PLAN_ROW("Thu", "May 13", "Back in Port Canaveral at 7:00 AM."),
  ].join(""));
  // the old stats cards and the itinerary table are gone
  for (const gone of ["gp-stats", "gp-itin-wrap", "<table"]) assert.ok(!html("en").includes(gone), gone);
});

test("the plan in Spanish: the same sentences, the weekday and date in Spanish, 'mediodía' for twelve o'clock", async () => {
  const es = visit("es", answerFor("es"));
  await es.ready();
  assert.equal(es.el("gp-itin").innerHTML, [
    PLAN_ROW("Dom", "9 de mayo", "Zarpamos de Port Canaveral a las 16:00."),
    PLAN_ROW("Lun", "10 de mayo", "Nassau, de 09:00 a 18:00."),
    PLAN_ROW("Mar", "11 de mayo", "Ocean Cay desde las 08:00, y pasamos la noche."),
    PLAN_ROW("Mié", "12 de mayo", "Ocean Cay hasta el mediodía."),
    PLAN_ROW("Jue", "13 de mayo", "De regreso en Port Canaveral a las 07:00."),
  ].join(""));
});

test("the plan: a sea day, a departure that is not at noon, an ordinary port day and a day with no times", async () => {
  const days = [
    { day: 1, date: "2027-03-14", port: "Miami, Florida", arrive: null, depart: "16:30" },
    { day: 2, date: "2027-03-15", port: "At Sea", arrive: null, depart: null },
    { day: 3, date: "2027-03-16", port: "Cozumel, Mexico", arrive: "08:00", depart: null },
    { day: 4, date: "2027-03-17", port: "Cozumel, Mexico", arrive: null, depart: "15:00" },
    { day: 5, date: "2027-03-18", port: "Roatan (Honduras), Honduras", arrive: "09:00", depart: null },
    { day: 6, date: "2027-03-19", port: "Grand Turk", arrive: null, depart: null },
    { day: 7, date: "2027-03-21", port: "Miami, Florida", arrive: "06:30", depart: null },
  ];
  const en = visit("en", answerFor("en", { itinerary: days }));
  await en.ready();
  assert.equal(en.el("gp-itin").innerHTML, [
    PLAN_ROW("Sun", "March 14", "We sail from Miami at 4:30 PM."),
    PLAN_ROW("Mon", "March 15", "A day at sea."),
    PLAN_ROW("Tue", "March 16", "Cozumel from 8:00 AM, and we stay the night."),
    PLAN_ROW("Wed", "March 17", "Cozumel until 3:00 PM."),
    PLAN_ROW("Thu", "March 18", "Roatan, arrive 9:00 AM."),
    PLAN_ROW("Fri", "March 19", "Grand Turk."),
    PLAN_ROW("Sun", "March 21", "Back in Miami at 6:30 AM."),
  ].join(""));
  const es = visit("es", answerFor("es", { itinerary: days }));
  await es.ready();
  assert.match(es.el("gp-itin").innerHTML, /<span>Un día en el mar\.<\/span>/);
  assert.match(es.el("gp-itin").innerHTML, /<span>Cozumel hasta las 15:00\.<\/span>/);
  assert.match(es.el("gp-itin").innerHTML, /<span>Roatan, llegada 09:00\.<\/span>/);
});

test("Mark's note for a day follows that day's sentence; the date is matched as the plan prints it, whatever the capitals, weekday or year", async () => {
  const notes = "May 11: The beach party and light show at the lighthouse.\nmay 12, 2027: Sunrise on the beach, then we head for home.\nMay 10: <i>Dolphins</i> & beaches.\nMay 20: A day that is not in the plan.\nno colon here";
  const en = visit("en", answerFor("en", { answers: { day_notes: notes } }));
  await en.ready();
  const rows = en.el("gp-itin").innerHTML;
  assert.match(rows, /<span>Nassau, 9:00 AM to 6:00 PM\. Dolphins &amp; beaches\.<\/span>/, "markup characters are dropped, the rest shown as text");
  assert.match(rows, /<span>Ocean Cay from 8:00 AM, and we stay the night\. The beach party and light show at the lighthouse\.<\/span>/);
  assert.match(rows, /<span>Ocean Cay until noon\. Sunrise on the beach, then we head for home\.<\/span>/);
  assert.match(rows, /<span>We sail from Port Canaveral at 4:00 PM\.<\/span>/, "a day with no note is just its sentence");
  assert.ok(!rows.includes("not in the plan"), "a note for a date the plan does not have is not shown");
  const es = visit("es", answerFor("es", { answers: { day_notes: "11 de mayo: La fiesta en la playa." } }));
  await es.ready();
  assert.match(es.el("gp-itin").innerHTML, /pasamos la noche\. La fiesta en la playa\.<\/span>/);
});

test("the photo bands above the plan and the cabins use the group's own links, are there only when there is a link, and go if the picture does not load", async () => {
  const plan = "https://stillafloatcruising.com/p.jpg", cabin = "https://stillafloatcruising.com/c.jpg";
  const p = visit("en", answerFor("en", { answers: { photo_plan: plan, photo_cabin: cabin } }));
  await p.ready();
  assert.equal(p.el("gp-photo-plan").hidden, false); assert.equal(p.el("gp-photo-cabin").hidden, false);
  assert.deepEqual(p.el("gp-photo-plan").kids.map((k) => [k.className, k.src]), [["gp-band", plan]]);
  assert.deepEqual(p.el("gp-photo-cabin").kids.map((k) => [k.className, k.src]), [["gp-band", cabin]]);
  p.el("gp-photo-plan").kids[0]!.onload!();
  assert.equal(p.el("gp-photo-plan").kids[0]!.className, "gp-band on");
  p.el("gp-photo-cabin").kids[0]!.onerror!();
  assert.equal(p.el("gp-photo-cabin").hidden, true, "a picture that does not load leaves no empty band");
  // no link, no band; a link that is not https is not used
  const none = visit("en", answerFor("en"));
  await none.ready();
  assert.equal(none.el("gp-photo-plan").hidden, true); assert.equal(none.el("gp-photo-cabin").hidden, true);
  const bad = visit("en", { ...answerFor("en"), look: { ...answerFor("en").look, planPhotoUrl: "javascript:alert(1)", cabinPhotoUrl: "http://stillafloatcruising.com/x.jpg" } });
  await bad.ready();
  assert.equal(bad.el("gp-photo-plan").hidden, true); assert.deepEqual(bad.el("gp-photo-cabin").kids, []);
});

test("your cabin lists each category with its per-person price, then the price note, the FlexPay line, the upgrade offer and what is planned; no cabin counts", async () => {
  const en = visit("en", answerFor("en", { answers: { pitch: "Come along. We have a $25 onboard credit per cabin." } }));
  await en.ready();
  const list = en.el("gp-cabin-prices").innerHTML;
  assert.equal(list, '<div class="price"><b>Interior</b><span class="amt">$849<small>per person</small></span></div><div class="price"><b>Balcony</b><span class="amt">$1,249<small>per person</small></span></div>');
  assert.equal(en.el("gp-fine").textContent, "Two to a cabin. Taxes and port fees are confirmed at booking.");
  assert.equal(en.el("gp-fine").hidden, false);
  assert.equal(en.el("gp-upgrades").textContent, "Cabin upgrades available. Ask Mark.");
  assert.equal(en.el("gp-planned").innerHTML, "<p>Planned for the group: $25 onboard credit.</p>");
  // the FlexPay logo and its words are in the page itself
  assert.ok(html("en").includes('<img src="/assets/images/flexpay-logo.png" alt="FlexPay"') && /flex:'Flexible Payment Plans Available'/.test(script("en")));
  assert.match(script("es"), /flex:'Planes de pago flexibles disponibles'/);
  // taxes-included variant
  const tax = visit("en", answerFor("en", { answers: { taxes_included: true } }));
  await tax.ready();
  assert.equal(tax.el("gp-fine").textContent, "Two to a cabin. Taxes and port fees included.");
  assert.equal(tax.el("gp-planned").innerHTML, "", "nothing planned unless Mark's words say so");
  // Spanish
  const es = visit("es", answerFor("es", { answers: { taxes_included: true } }));
  await es.ready();
  assert.match(es.el("gp-cabin-prices").innerHTML, /<span class="amt">\$849<small>por persona<\/small><\/span>/);
  assert.equal(es.el("gp-upgrades").textContent, "Mejoras de cabina disponibles. Pregunte a Mark.");
  assert.equal(es.el("gp-fine").textContent, "Dos personas por cabina. Impuestos y cargos portuarios incluidos.");
  // prices off: no category prices and no price note; the FlexPay line and the upgrade offer stay
  const off = visit("en", answerFor("en", { answers: { show_prices: false } }));
  await off.ready();
  assert.equal(off.el("gp-cabin-prices").innerHTML, ""); assert.equal(off.el("gp-fine").hidden, true);
  assert.equal(off.el("gp-upgrades").textContent, "Cabin upgrades available. Ask Mark.");
  // nothing in the answer or on the page counts cabins
  const answer = JSON.stringify(answerFor("en"));
  for (const leak of ["cabinsAvailable", "cabinsTotal", "available", "deposit", "BAL", "INT"]) assert.ok(!answer.includes(leak), `${leak} is in the public answer`);
});

test("a file with only a from-price and no category list shows one 'From' row", async () => {
  const answer = answerFor("en");
  (answer.facts as Record<string, unknown>)["cabinPrices"] = [];
  const p = visit("en", answer);
  await p.ready();
  assert.equal(p.el("gp-cabin-prices").innerHTML, '<div class="price"><b>From</b><span class="amt">$849<small>per person</small></span></div>');
});

test("dates that matter: reserve by, final payment, and 'We sail' with the weekday, the date and the port; hidden when the file has neither deadline", async () => {
  const en = visit("en", answerFor("en"));
  await en.ready();
  assert.equal(en.el("sec-dates").hidden, false);
  const tiles = en.el("gp-dates").innerHTML;
  assert.match(tiles, /<div class="date"><p class="label">Reserve by<\/p><b>[A-Z][a-z]+ \d{1,2}, 2026<\/b><\/div>/);
  assert.match(tiles, /<div class="date"><p class="label">Final payment<\/p><b>February 1, 2027<\/b><\/div>/);
  assert.match(tiles, /<div class="date wide"><p class="label">We sail<\/p><b>Sunday, May 9, 2027 from Port Canaveral, Florida<\/b><\/div>/);
  const es = visit("es", answerFor("es"));
  await es.ready();
  assert.match(es.el("gp-dates").innerHTML, /<p class="label">Reserve antes de<\/p>/);
  assert.match(es.el("gp-dates").innerHTML, /<p class="label">Pago final<\/p><b>1 de febrero de 2027<\/b>/);
  assert.match(es.el("gp-dates").innerHTML, /<p class="label">Zarpamos<\/p><b>Domingo, 9 de mayo de 2027 desde Port Canaveral, Florida<\/b>/);
  const answer = answerFor("en");
  Object.assign(answer.facts, { bookByText: null, finalPaymentText: null });
  const none = visit("en", answer);
  await none.ready();
  assert.equal(none.el("sec-dates").hidden, true);
  // the dates panel sits directly after the cabin panel, then getting there
  const h = html("en");
  assert.ok(h.indexOf('id="sec-cabin"') < h.indexOf('id="sec-dates"') && h.indexOf('id="sec-dates"') < h.indexOf('id="sec-travel"'));
  assert.equal((h.slice(h.indexOf('id="sec-cabin"'), h.indexOf('id="sec-dates"')).match(/<section/g) ?? []).length, 1, "nothing but the cabin panel's own end sits between it and the dates panel");
});

test("getting there reads in the guest's words with no vendor name, a hotel per room and the rest per person, with the icon for each kind (EN and ES)", async () => {
  const en = visit("en", answerFor("en"));
  await en.ready();
  const rows = [...en.el("gp-travel").innerHTML.matchAll(/<div class="trip"><span>([^<]+)<\/span><span>([^<]*)<\/span><\/div>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [
    ["✈️", "Flight from Raleigh-Durham: $350 per person"],
    ["🏨", "Hotel the night before in Port Canaveral (1 night): $125 per room"],
    ["🚐", "Hotel to Cruise port: $45 per person"],
  ]);
  assert.equal(en.el("sec-travel").hidden, false);
  assert.match(script("en"), /travel_note:"Want any of it\? Say so when Mark calls and he'll line it up\."/);
  const es = visit("es", answerFor("es"));
  await es.ready();
  const esRows = [...es.el("gp-travel").innerHTML.matchAll(/<span>([^<]{8,})<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(esRows, [
    "Vuelo desde Raleigh-Durham: $350 por persona",
    "Hotel la noche anterior en Port Canaveral (1 noche): $125 por habitación",
    "Hotel a puerto de cruceros: $45 por persona",
  ]);
  for (const lang of ["en", "es"] as const) {
    const all = JSON.stringify(answerFor(lang)) + (lang === "en" ? en : es).el("gp-travel").innerHTML;
    for (const vendor of ["American", "Airlines", "Marriott", "Courtyard", "Limopedia"]) assert.ok(!all.includes(vendor), `${lang}: ${vendor} reached the client`);
  }
  const none = visit("en", answerFor("en", { travel: [] }));
  await none.ready();
  assert.equal(none.el("sec-travel").hidden, true, "no offer, no panel");
});

test("the ship's score never reaches the page: not in the public answer, whatever the interview says, and not on the page", async () => {
  for (const show_rating of [true, false]) {
    const answer = answerFor("en", { answers: { show_rating } });
    assert.ok(!("rating" in answer.facts), `show_rating ${show_rating}: the public facts carry a rating`);
    assert.ok(!JSON.stringify(answer).includes("Lively ship") && !JSON.stringify(answer).includes("Loud by the pool"), "the rating's words are in the public answer");
    const p = visit("en", answer);
    await p.ready();
    const written = [...p.els.values()].map((e) => `${e.textContent}\n${e.innerHTML}`).join("\n");
    assert.ok(!written.includes("4.3") && !/Lively ship|Loud by the pool|Conga/.test(written));
    assert.ok(![...p.els.keys()].some((k) => /rating|score/.test(k)), "the script touches a rating element");
  }
});

test("the footer: the legal line, the photo credits in one compact line, and nothing about Cornerstone but its logo", async () => {
  const credits = ["Photo: Symbiosis · CC BY 2.0 · Wikimedia Commons", "Photo: Bluerasberry · CC BY 4.0 · Wikimedia Commons", "Photo: Jack Adamenko · CC0 · Wikimedia Commons", "Photo: Symbiosis · CC BY 2.0 · Wikimedia Commons"];
  const p = visit("en", answerFor("en", { credits }));
  await p.ready();
  assert.equal(p.el("gp-legal").textContent, "Still Afloat LLC dba Still Afloat Cruising · mark@stillafloatcruising.com");
  assert.equal(p.el("gp-credits").hidden, false);
  assert.equal(p.el("gp-credits").textContent, "Photos: Symbiosis (CC BY 2.0) · Bluerasberry (CC BY 4.0) · Jack Adamenko (CC0) · Wikimedia Commons");
  const one = visit("en", answerFor("en", { credits: ["Photo: Bluerasberry · CC BY 4.0 · Wikimedia Commons"] }));
  await one.ready();
  assert.equal(one.el("gp-credits").textContent, "Photo: Bluerasberry (CC BY 4.0) · Wikimedia Commons");
  const other = visit("en", answerFor("en", { credits: ["Photo: Mark Millham", "From the line's kit"] }));
  await other.ready();
  assert.equal(other.el("gp-credits").textContent, "Photo: Mark Millham · From the line's kit", "lines of another shape are joined as they are");
  const es = visit("es", answerFor("es", { credits: ["Photo: Bluerasberry · CC BY 4.0 · Wikimedia Commons", "Photo: Symbiosis · CC BY 2.0 · Wikimedia Commons"] }));
  await es.ready();
  assert.equal(es.el("gp-credits").textContent, "Fotos: Bluerasberry (CC BY 4.0) · Symbiosis (CC BY 2.0) · Wikimedia Commons");
  const none = visit("en", answerFor("en"));
  await none.ready();
  assert.equal(none.el("gp-credits").hidden, true, "no credits, no line");
  // the markup: the Still Afloat logo is the largest picture on the page; the Cornerstone logo is small, at the bottom right, with no text
  const h = html("en");
  const foot = h.slice(h.indexOf('<div class="foot">'));
  assert.ok(foot.indexOf('class="sa"') < foot.indexOf('id="gp-legal"') && foot.indexOf('id="gp-legal"') < foot.indexOf('id="gp-credits"') && foot.indexOf('id="gp-credits"') < foot.indexOf('class="cs"'));
  assert.match(foot, /<div class="cs-row"><img class="cs" src="\/assets\/images\/cornerstone-white\.png" alt=""><\/div>/);
  const c = css("en");
  const px = (re: RegExp) => Number(re.exec(c)?.[1]);
  assert.equal(px(/\.foot \.sa\{[^}]*height:(\d+)px/), 140);
  assert.ok(px(/\.foot \.cs\{[^}]*height:(\d+)px/) <= 50 && px(/\.foot \.sa\{[^}]*height:(\d+)px/) > px(/\.hdr \.logo\{[^}]*height:(\d+)px/), "the footer logo is the largest on the page");
  assert.match(c, /\.cs-row\{[^}]*justify-content:flex-end/);
});

test("the group's top picture and hosts' photo still go to the banner, and a link that is not https shows nothing", async () => {
  const p = visit("en", answerFor("en", { answers: { hero_photo: "https://stillafloatcruising.com/h.jpg", host_photo: "https://stillafloatcruising.com/hosts.jpg" } }));
  await p.ready();
  const banner = p.el("query:.gp-banner");
  assert.deepEqual(banner.kids.map((k) => [k.className, k.src]), [["gp-hero", "https://stillafloatcruising.com/h.jpg"], ["gp-host", "https://stillafloatcruising.com/hosts.jpg"]]);
  const bad = visit("en", { ...answerFor("en"), look: { ...answerFor("en").look, heroUrl: "javascript:alert(1)", hostPhotoUrl: "http://stillafloatcruising.com/x.jpg" } });
  await bad.ready();
  assert.deepEqual(bad.el("query:.gp-banner").kids, [], "neither picture is used");
  // the hosts' photo keeps its place: small, top-right of the picture
  assert.match(css("en"), /\.gp-host\{position:absolute;top:16px;right:16px;[^}]*width:clamp\(110px,22%,260px\)/);
});

test("the language link shows only for a group in both languages and points at the other page with the same code", async () => {
  const one = visit("en", answerFor("en"));
  await one.ready();
  assert.equal(one.el("gp-lang").hidden, true);
  const both = visit("en", answerFor("en", { langs: ["en", "es"] }));
  await both.ready();
  assert.equal(both.el("gp-lang").hidden, false);
  assert.equal(both.el("gp-lang").innerHTML, '<a href="/es/group.html?g=abcdefghjk">Español</a>');
  const es = visit("es", answerFor("es", { langs: ["en", "es"] }));
  await es.ready();
  assert.equal(es.el("gp-lang").innerHTML, '<a href="/group.html?g=abcdefghjk">English</a>');
});

// ── The form, run ────────────────────────────────────────────────────────────────────────────────────────────

test("sending the form: the name splits on its LAST space, one word is a first name only, an '@' makes the contact an email and anything else a phone", async () => {
  const cases: Array<[string, string, string, string, string, string]> = [
    // name, contact, first, last, email, phone
    ["Mary Smith", "mary@example.com", "Mary", "Smith", "mary@example.com", ""],
    ["Mary Ann van der Berg", "919-346-6127", "Mary Ann van der", "Berg", "", "919-346-6127"],
    ["  Cher  ", " (919) 346 6127 ", "Cher", "", "", "(919) 346 6127"],
    ["Pat   Lee", "pat.lee@mail.example", "Pat", "Lee", "pat.lee@mail.example", ""],
  ];
  for (const [name, contact, first, last, email, phone] of cases) {
    const p = visit("en", answerFor("en"));
    await p.ready();
    await p.submit({ name, contact, guests: "4" });
    assert.equal(p.sent.length, 1, name);
    assert.equal(p.sent[0]!.url, "/api/group-page/abcdefghjk/interest");
    assert.deepEqual(p.sent[0]!.body, { first_name: first, last_name: last, email, phone, guests: 4, newsletter_opt_in: false, website: "", lang: "en", "cf-turnstile-response": null }, name);
    assert.equal(p.el("gp-msg").textContent, "Got it. We will be in touch soon.");
    assert.equal(p.el("gp-msg").className, "msg ok");
  }
  const es = visit("es", answerFor("es"));
  await es.ready();
  await es.submit({ name: "Ana Pérez", contact: "ana@example.com" });
  assert.equal(es.sent[0]!.body["lang"], "es");
  assert.equal(es.el("gp-msg").textContent, "Recibido. Le escribiremos pronto.");
});

test("sending the form with no name or no way to reach them is refused on the page, in plain words, and sends nothing; the bot trap field travels as it is", async () => {
  const p = visit("en", answerFor("en"));
  await p.ready();
  await p.submit({ name: "   ", contact: "a@b.co" });
  assert.equal(p.el("gp-msg").textContent, "Please add your name."); assert.equal(p.el("gp-msg").className, "msg err");
  await p.submit({ name: "Pat Lee", contact: "  " });
  assert.equal(p.el("gp-msg").textContent, "Please add an email or a phone number.");
  assert.equal(p.sent.length, 0);
  const es = visit("es", answerFor("es"));
  await es.ready();
  await es.submit({ name: "", contact: "x" });
  assert.equal(es.el("gp-msg").textContent, "Escriba su nombre.");
  await es.submit({ name: "Ana", contact: "" });
  assert.equal(es.el("gp-msg").textContent, "Escriba un correo electrónico o un teléfono.");
  assert.equal(es.sent.length, 0);
  // a robot that fills the hidden field is sent as it filled it (the server answers it as if accepted and stores nothing)
  await p.submit({ name: "Bot Bot", contact: "bot@example.com", website: "http://spam.example" });
  assert.equal(p.sent[0]!.body["website"], "http://spam.example");
});
