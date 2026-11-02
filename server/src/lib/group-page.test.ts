// group-page.test.ts — the PUBLIC GROUP PAGE (server/public/group.html and its Spanish twin), run the way a visitor's browser runs it.
//
// Mark 2026-10-20 ("we already had this discussion"): the person who opens the page has just read the poster, the Facebook post or the email,
// so the page opens on a short personal WELCOME from the hosts; it never repeats the headline, the payoff or the pitch; it never prints a vendor name
// (airline, hotel, transfer company); and a hotel is priced per room.
// Mark 2026-10-23 (design v2): the header is the logo and the language link only; the welcome is "Welcome!" and a paragraph per line; then the plan day by
// day (a sentence a day), the cabin prices, the dates, getting there; no ship rating, no advisor bio; a navy footer with the logo, the legal line, the photo
// credits and the Cornerstone logo.
// Mark 2026-10-24 (design v3, "pitch first, ask last"): the ONE form (name, email or phone, how many) is the LAST panel, "Save my spot!"; the fields check
// themselves; after it the panel is the choice between two equal pills, "I've got this… let me fill it in!" (a link to the guest's details page) and "Talk me
// into it, Mark!" (a drop-down for the time, then one line). "Count me in" is not on the page.
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
// The page's look lives in a shared same-site stylesheet under /css/ (2026-10-23: the release gate's crawl counts same-site
// stylesheets, and both language twins share one look), so the CSS is read from the file the page links.
const css = (lang: Lang) => {
  const m = /<link rel="stylesheet" href="\/css\/([a-z-]+\.css)[^"]*">/.exec(html(lang));
  assert.ok(m, `${lang}: the page links its stylesheet from /css/`);
  return readFileSync(join(PUBLIC, "css", m![1]!), "utf8");
};

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
  textContent = ""; innerHTML = ""; hidden = false; className = ""; value = ""; checked = false; disabled = false; alt = ""; decoding = ""; src = ""; placeholder = ""; href = "";
  onload: (() => void) | null = null; onerror: (() => void) | null = null; parentNode: El | null = null; firstChild: El | null = null;
  private attrs: Record<string, string> = {};
  handlers: Record<string, (e: { preventDefault(): void }) => void> = {};
  constructor(readonly id: string) {}
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  scrolledTo = 0; focused = 0;
  scrollIntoView() { this.scrolledTo++; }
  focus() { this.focused++; }
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void) { this.handlers[type] = fn; }
  kids: El[] = [];
  appendChild(c: El) { c.parentNode = this; this.kids.push(c); return c; }
  insertBefore(c: El) { c.parentNode = this; this.kids.unshift(c); return c; }
  removeChild() { /* nothing */ }
  reset() { /* nothing */ }
}

type Sent = { url: string; method: string; body: Record<string, unknown> };

/** What the stand-in server answers a POST with (the default is a plain success, as before). */
type PostReply = (url: string, body: Record<string, unknown>) => { ok: boolean; json?: unknown };

function visit(lang: Lang, answer: unknown, search = "?g=abcdefghjk", postReply?: PostReply) {
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
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        sent.push({ url, method: "POST", body });
        const r = postReply ? postReply(url, body) : { ok: true, json: { success: true } };
        return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.json ?? { success: r.ok }) });
      }
      requested.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) });
    },
  };
  runInNewContext(script(lang), sandbox);
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  return {
    els, el, doc, requested, sent, ready: flush,
    /** Type into the two boxes the way a visitor would (the page hears every key), without leaving them. */
    type(v: { name?: string; contact?: string }) {
      if (v.name !== undefined) { el("f-name").value = v.name; el("f-name").handlers["input"]?.({ preventDefault() { /* */ } }); }
      if (v.contact !== undefined) { el("f-contact").value = v.contact; el("f-contact").handlers["input"]?.({ preventDefault() { /* */ } }); }
    },
    /** Leave a box (tab away). */
    leave(id: "f-name" | "f-contact") { el(id).handlers["blur"]!({ preventDefault() { /* */ } }); },
    /** Fill the form the way a visitor would and press Save my spot. */
    async submit(v: { name?: string; contact?: string; guests?: string; website?: string }) {
      this.type({ name: v.name ?? "", contact: v.contact ?? "" });
      el("f-guests").value = v.guests ?? "2"; el("f-website").value = v.website ?? "";
      let prevented = false;
      el("gp-form").handlers["submit"]!({ preventDefault() { prevented = true; } });
      assert.ok(prevented, "the form does not submit the page away");
      await flush();
    },
  };
}

const PLAN_ROW = (wd: string, date: string, sentence: string) => `<div class="day"><b>${wd}<br>${date}</b><span>${sentence}</span></div>`;

// ── The order of the page ───────────────────────────────────────────────────────────────────────────────────

test("both pages (English and Spanish) are the same page: header, hero, welcome, the plan, your cabin, the dates, getting there, THEN the ask panel, the footer", () => {
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    const at = (needle: string) => { const i = h.indexOf(needle); assert.ok(i > 0, `${lang}: ${needle}`); return i; };
    const order = ['class="hdr"', 'class="gp-banner"', 'id="sec-welcome"', 'id="sec-org"', 'id="gp-photo-plan"', 'id="sec-itin"', 'id="gp-photo-cabin"', 'id="sec-cabin"', 'id="sec-dates"', 'id="sec-travel"', 'id="interest"', 'id="gp-form"', 'class="foot"'].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${lang}: the sections are out of order (the pitch first, the ask last)`);
    // the pitch and the poster's words are not on the page at all
    for (const gone of ['id="gp-headline"', 'id="gp-subhead"', 'id="gp-intro"', 'id="gp-why"', 'id="gp-who"', "class=\"lead\""]) assert.ok(!h.includes(gone), `${lang}: ${gone} is back`);
    const s = script(lang);
    for (const k of ["headline", "subhead", "intro", "why_ship", "who_for"]) assert.ok(!new RegExp(`\\bc\\.${k}\\b`).test(s), `${lang}: the script reads copy.${k}`);
    assert.deepEqual([...new Set([...s.matchAll(/\bc\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort(), ["cta_blurb", "cta_label", "organizer_note", "welcome"], `${lang}: the copy names the page reads`);
    // the call to action is still the yellow pill
    assert.ok(h.includes('id="gp-submit"') && /\.btn\{[^}]*background:#f5c33b;color:#07183f/.test(css(lang)));
    // no cabin picker and no cabin table: the page only asks to save a spot (the price list is not a table or a picker)
    assert.ok(!/id="gp-cabins"|id="f-cabin"|id="sec-cabins"/.test(h), `${lang}: a cabin table or picker is back`);
    // "Count me in" is gone from the page, the script and the look, in both languages
    for (const [what, text] of [["markup", h], ["look", css(lang)]] as const) assert.ok(!/count me in|cuenten conmigo/i.test(text), `${lang}: "Count me in" is on the ${what}`);
  }
  assert.match(script("en"), /default_cta:'Save my spot!'/); assert.match(script("es"), /default_cta:'¡Aparte mi lugar!'/);
  assert.match(script("en"), /itinerary:'The plan, day by day'/); assert.match(script("es"), /itinerary:'El plan, día a día'/);
  assert.match(script("en"), /cabin:'Your cabin'/); assert.match(script("es"), /cabin:'Su cabina'/);
  assert.match(script("en"), /welcome_h:'Welcome!'/); assert.match(script("es"), /welcome_h:'¡Bienvenidos!'/);
  // the ask panel's words, from the approved design
  assert.match(script("en"), /ask_h:"You tapped… so let's make it official!"/);
  assert.match(script("en"), /ask_p:"Tell us who's coming and how to reach you… that's all it takes\. Nothing to pay, nothing to sign, and Mark takes it from there!"/);
  assert.match(script("es"), /ask_h:'Usted tocó… ¡así que hagámoslo oficial!'/);
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
  assert.match(script("es"), /f_name:'Su nombre', ph_name:'Nombre y apellido', f_contact:'Correo electrónico o teléfono', ph_contact:'El que prefiera que usemos', f_guests:'¿Cuántos son\?'/);
  // a red note under each box that is checked, hidden until it has something to say; the button starts dim
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    assert.match(h, /<input id="f-name"[^>]*><p class="err" id="e-name" hidden><\/p>/); assert.match(h, /<input id="f-contact"[^>]*><p class="err" id="e-contact" hidden><\/p>/);
    assert.match(h, /<button class="btn" type="submit" id="gp-submit" aria-disabled="true">/, `${lang}: the button starts dim`);
    assert.match(css(lang), /\.btn\[aria-disabled="true"\]\{opacity:/); assert.match(css(lang), /\.field input\.bad[^{]*\{[^}]*border-color:#d12d2d/);
  }
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

test("a group with no welcome (copy written before it existed) opens straight on the plan; the signature is Mark unless the interview names the hosts; a blank button label falls back to Save my spot!", async () => {
  const none = visit("en", answerFor("en", { copy: { welcome: null } }));
  await none.ready();
  assert.equal(none.el("sec-welcome").hidden, true, "no empty welcome box");
  assert.equal(none.el("gp-submit").textContent, "Tell us you're in", "the group's own button words still win; the form is there");
  const blank = visit("en", answerFor("en", { copy: { welcome: "   ", cta_label: "  ", cta_blurb: "" } }));
  await blank.ready();
  assert.equal(blank.el("sec-welcome").hidden, true);
  assert.equal(blank.el("gp-submit").textContent, "Save my spot!");
  assert.equal(blank.el("gp-cta-blurb").hidden, true, "no empty phone line");
  const es = visit("es", answerFor("es", { copy: { cta_label: "" } }));
  await es.ready();
  assert.equal(es.el("gp-submit").textContent, "¡Aparte mi lugar!");
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
  assert.match(css("en"), /\.gp-host\{position:absolute;top:16px;right:16px;[^}]*width:clamp\(143px,29%,340px\)/);
});

test("Mark 2026-10-25: the two small pictures on the LEFT of the top picture load after the hosts' photo, sit top-left and bottom-left with the same fade, the top picture runs edge to edge, and the poster's note joins the credits", async () => {
  const p = visit("en", answerFor("en", { answers: { hero_photo: "https://stillafloatcruising.com/h.jpg", host_photo: "https://stillafloatcruising.com/hosts.jpg", hero_inset_top: "https://stillafloatcruising.com/sunset.jpg", hero_inset_bottom: "https://stillafloatcruising.com/sunrise.jpg" } }));
  await p.ready();
  assert.deepEqual(p.el("query:.gp-banner").kids.map((k) => [k.className, k.src]), [["gp-hero", "https://stillafloatcruising.com/h.jpg"], ["gp-host", "https://stillafloatcruising.com/hosts.jpg"], ["gp-side gp-side-1", "https://stillafloatcruising.com/sunset.jpg"], ["gp-side gp-side-2", "https://stillafloatcruising.com/sunrise.jpg"]]);
  assert.equal(p.el("gp-credits").hidden, false);
  assert.equal(p.el("gp-credits").textContent, "Insets: illustrative imagery");
  const one = visit("en", answerFor("en", { answers: { hero_inset_top: "http://stillafloatcruising.com/x.jpg", hero_inset_bottom: "https://stillafloatcruising.com/sunrise.jpg" } }));
  await one.ready();
  assert.deepEqual(one.el("query:.gp-banner").kids.map((k) => k.className), ["gp-side gp-side-2"], "a link that is not https shows nothing; the other still shows");
  const none = visit("en", answerFor("en"));
  await none.ready();
  assert.equal(none.el("gp-credits").hidden, true, "no insets, no note");
  const c = css("en");
  assert.match(c, /\.gp-banner\{--gp-h:clamp\(300px,48vw,640px\);position:relative;overflow:hidden;height:var\(--gp-h\);width:100vw;margin-left:calc\(50% - 50vw\)/, "edge to edge");
  assert.match(c, /\.gp-side\{position:absolute;left:16px;[^}]*width:min\(29%,calc\(\(var\(--gp-h\) - 44px\) \* 2 \/ 3\)\);aspect-ratio:4\/3;[^}]*mask-image:radial-gradient/, "left, two fit, faded like the hosts");
  assert.match(c, /\.gp-side-1\{top:16px\}/); assert.match(c, /\.gp-side-2\{bottom:16px\}/);
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

// ── The fields check themselves (Mark 2026-10-24, "Save my spot!") ───────────────────────────────────────────

const NAME_NOTE = "First AND last name, please… the way the passport has it.";
const CONTACT_NOTE = "Please check your email address or phone number.";

test("the name box: a first AND last name of letters, spaces, hyphens and apostrophes; a wrong one is red with the design's words once the box is left, and not before", async () => {
  for (const bad of ["Bob", "", "   ", "R2 D2", "Mark <b>Millham</b>", "Mark 3rd", "Mark Millham!", "- -", "x ".repeat(50)]) {
    const p = visit("en", answerFor("en"));
    await p.ready();
    p.type({ name: bad });
    assert.equal(p.el("e-name").hidden, true, `typing "${bad}" shows nothing until the box is left`);
    p.leave("f-name");
    assert.equal(p.el("e-name").hidden, false, `"${bad}" is refused when the box is left`);
    assert.equal(p.el("e-name").textContent, NAME_NOTE);
    assert.equal(p.el("f-name").className, "bad", "a red border");
  }
  for (const good of ["Mark Millham", "Mary-Jane O'Brien", "José Pérez", "Ana de la Cruz", "  Pat   Lee "]) {
    const p = visit("en", answerFor("en"));
    await p.ready();
    p.type({ name: good }); p.leave("f-name");
    assert.equal(p.el("e-name").hidden, true, good);
    assert.equal(p.el("f-name").className, "", good);
  }
  // once it has been wrong, fixing it clears the note as the visitor types
  const p = visit("en", answerFor("en"));
  await p.ready();
  p.type({ name: "Bob" }); p.leave("f-name");
  assert.equal(p.el("e-name").hidden, false);
  p.type({ name: "Bob Smith" });
  assert.equal(p.el("e-name").hidden, true); assert.equal(p.el("f-name").className, "");
  // the Spanish words
  const es = visit("es", answerFor("es"));
  await es.ready();
  es.type({ name: "Ana" }); es.leave("f-name");
  assert.equal(es.el("e-name").textContent, "Nombre Y apellido, por favor… tal como aparecen en el pasaporte.");
});

test("the contact box: a real email, or a phone with at least seven digits; a wrong one is red with the design's words once the box is left", async () => {
  for (const bad of ["", "pat@x", "pat@example", "@example.com", "12345", "123456", "call me maybe", "919-346-61x7", "pat@example.com, lee@example.com", "1".repeat(16)]) {
    const p = visit("en", answerFor("en"));
    await p.ready();
    p.type({ contact: bad }); p.leave("f-contact");
    assert.equal(p.el("e-contact").hidden, false, JSON.stringify(bad));
    assert.equal(p.el("e-contact").textContent, CONTACT_NOTE);
    assert.equal(p.el("f-contact").className, "bad");
  }
  for (const good of ["pat@example.com", "Pat.Lee+cruise@mail.example.org", "919-346-6127", "(919) 346 6127", "+1 919.346.6127", "3466127"]) {
    const p = visit("en", answerFor("en"));
    await p.ready();
    p.type({ contact: good }); p.leave("f-contact");
    assert.equal(p.el("e-contact").hidden, true, good);
  }
  const es = visit("es", answerFor("es"));
  await es.ready();
  es.type({ contact: "x" }); es.leave("f-contact");
  assert.equal(es.el("e-contact").textContent, "Revise su correo electrónico o su teléfono.");
});

test("the button sits dim (aria-disabled) until both boxes are good, and a tap on the dim button sends nothing and goes to the FIRST problem, marked red", async () => {
  const p = visit("en", answerFor("en"));
  await p.ready();
  assert.equal(p.el("gp-submit").getAttribute("aria-disabled"), "true", "dim at the start");
  p.type({ name: "Pat Lee" });
  assert.equal(p.el("gp-submit").getAttribute("aria-disabled"), "true", "one box good is not enough");
  p.type({ contact: "pat@example.com" });
  assert.equal(p.el("gp-submit").getAttribute("aria-disabled"), "false", "both good: lit");
  p.type({ contact: "pat@" });
  assert.equal(p.el("gp-submit").getAttribute("aria-disabled"), "true", "dim again when a box goes wrong");

  // both wrong: the tap marks both, goes to the name (the first), and sends nothing
  const q = visit("en", answerFor("en"));
  await q.ready();
  q.type({ name: "Bob", contact: "x" });
  q.el("gp-form").handlers["submit"]!({ preventDefault() { /* */ } });
  await q.ready();
  assert.equal(q.sent.length, 0, "nothing is sent while a box is wrong");
  assert.equal(q.el("e-name").hidden, false); assert.equal(q.el("e-contact").hidden, false);
  assert.equal(q.el("f-name").className, "bad"); assert.equal(q.el("f-contact").className, "bad");
  assert.deepEqual([q.el("f-name").scrolledTo, q.el("f-name").focused, q.el("f-contact").scrolledTo], [1, 1, 0], "taken to the first problem only");
  // the name is fixed: the next tap goes to the contact
  q.type({ name: "Bob Smith" });
  q.el("gp-form").handlers["submit"]!({ preventDefault() { /* */ } });
  await q.ready();
  assert.equal(q.sent.length, 0);
  assert.deepEqual([q.el("f-name").scrolledTo, q.el("f-contact").scrolledTo, q.el("f-contact").focused], [1, 1, 1]);
  assert.equal(q.el("e-name").hidden, true);
});

// ── Sending it ────────────────────────────────────────────────────────────────────────────────────────────────

test("sending the form: the name splits on its LAST space, an '@' makes the contact an email and anything else a phone", async () => {
  const cases: Array<[string, string, string, string, string, string]> = [
    // name, contact, first, last, email, phone
    ["Mary Smith", "mary@example.com", "Mary", "Smith", "mary@example.com", ""],
    ["Mary Ann van der Berg", "919-346-6127", "Mary Ann van der", "Berg", "", "919-346-6127"],
    ["  Cher   Bono  ", " (919) 346 6127 ", "Cher", "Bono", "", "(919) 346 6127"],
    ["Pat   Lee", "pat.lee@mail.example", "Pat", "Lee", "pat.lee@mail.example", ""],
  ];
  for (const [name, contact, first, last, email, phone] of cases) {
    const p = visit("en", answerFor("en"));
    await p.ready();
    await p.submit({ name, contact, guests: "4" });
    assert.equal(p.sent.length, 1, name);
    assert.equal(p.sent[0]!.url, "/api/group-page/abcdefghjk/interest");
    assert.deepEqual(p.sent[0]!.body, { first_name: first, last_name: last, email, phone, guests: 4, newsletter_opt_in: false, website: "", lang: "en", "cf-turnstile-response": null }, name);
    assert.equal(p.el("gp-msg").textContent, "Got it. We will be in touch soon.", "a server that sends no link gets the plain thank-you");
    assert.equal(p.el("gp-msg").className, "msg ok");
  }
  const es = visit("es", answerFor("es"));
  await es.ready();
  await es.submit({ name: "Ana Pérez", contact: "ana@example.com" });
  assert.equal(es.sent[0]!.body["lang"], "es");
  assert.equal(es.el("gp-msg").textContent, "Recibido. Le escribiremos pronto.");
  // a robot that fills the hidden field is sent as it filled it (the server answers it as if accepted and stores nothing)
  const bot = visit("en", answerFor("en"));
  await bot.ready();
  await bot.submit({ name: "Bot Bot", contact: "bot@example.com", website: "http://spam.example" });
  assert.equal(bot.sent[0]!.body["website"], "http://spam.example");
});

// ── The choice (Road A and Road B) ────────────────────────────────────────────────────────────────────────────

const LINK = "L".repeat(43);
const LINKS = { success: true, first: "Mark", detailsUrl: `https://stillafloatcruising.com/details.html?t=${LINK}`, callUrl: `https://stillafloatcruising.com/details.html?t=${LINK}&choice=call` };
const WITH_LINKS: PostReply = (url) => (url.endsWith("/interest") ? { ok: true, json: LINKS } : { ok: true, json: { success: true } });
const saved = async (lang: Lang = "en", over: Parameters<typeof answerFor>[1] = {}, reply: PostReply = WITH_LINKS, who = { name: "Mark Millham", contact: "mark@example.com" }) => {
  const p = visit(lang, answerFor(lang, over), "?g=abcdefghjk", reply);
  await p.ready();
  await p.submit(who);
  return p;
};

test("after 'Save my spot!' the form is replaced by the choice: the cheer with the FIRST WORD of the name in capitals, one question, two equal yellow pills, one line (English and Spanish)", async () => {
  const p = visit("en", answerFor("en"), "?g=abcdefghjk", WITH_LINKS);
  await p.ready();
  assert.equal(p.el("gp-choice").hidden, true, "the choice is not there before they save their spot");
  await p.submit({ name: "Mark Millham", contact: "mark@example.com" });
  assert.equal(p.el("gp-ask").hidden, true, "the form is gone");
  assert.equal(p.el("gp-choice").hidden, false);
  assert.equal(p.el("gp-choice-h").textContent, "You tapped, we cheered… YOU'RE ON THE LIST, MARK!");
  assert.equal(p.el("gp-choice-lead").textContent, "Now, how do you like to plan a cruise?");
  assert.equal(p.el("gp-finish").textContent, "I've got this… let me fill it in!");
  assert.equal(p.el("gp-finish").href, LINKS.detailsUrl, "a plain link to their own details page");
  assert.equal(p.el("gp-talk").textContent, "Talk me into it, Mark!");
  assert.equal(p.el("gp-choice-foot").textContent, "Either way: nothing to pay or sign tonight… and a laugh or two along the way.");
  assert.equal(p.el("gp-dd").hidden, true, "the drop-down is closed until they tap Talk me into it");
  assert.equal(p.el("gp-msg").textContent, "", "the plain thank-you is not shown beside it");
  assert.equal(p.el("gp-finish").className, "btn"); assert.equal(p.el("gp-talk").className, "btn", "two equal pills");

  const es = await saved("es", {}, (url) => (url.endsWith("/interest") ? { ok: true, json: { ...LINKS, first: "Ana" } } : { ok: true, json: { success: true } }), { name: "Ana María Pérez", contact: "ana@example.com" });
  assert.equal(es.el("gp-choice-h").textContent, "Usted tocó, nosotros aplaudimos… ¡YA ESTÁ EN LA LISTA, ANA!");
  assert.equal(es.el("gp-choice-lead").textContent, "Ahora, ¿cómo le gusta planear un crucero?");
  assert.equal(es.el("gp-finish").textContent, "¡Yo me encargo… déjeme llenarlo!");
  assert.equal(es.el("gp-talk").textContent, "¡Convénzame, Mark!");
  assert.equal(es.el("gp-choice-foot").textContent, "De cualquier manera: nada que pagar ni firmar esta noche… y una que otra risa en el camino.");
});

test("the greeting is the first word of the name typed, in capitals; the server's own 'first' is used when it sends one, the typed name when it does not", async () => {
  const typed = await saved("en", {}, (url) => (url.endsWith("/interest") ? { ok: true, json: { ...LINKS, first: undefined } } : { ok: true, json: { success: true } }), { name: "mary ann Smith", contact: "m@example.com" });
  assert.match(typed.el("gp-choice-h").textContent, /YOU'RE ON THE LIST, MARY!$/);
  const server = await saved("en", {}, (url) => (url.endsWith("/interest") ? { ok: true, json: { ...LINKS, first: "Pat" } } : { ok: true, json: { success: true } }), { name: "Patricia Lee", contact: "m@example.com" });
  assert.match(server.el("gp-choice-h").textContent, /YOU'RE ON THE LIST, PAT!$/);
});

test("'Talk me into it, Mark!' opens a drop-down under the button ('When's a good time to catch you?' and four pills); the other pill dims; a second tap closes it", async () => {
  const p = await saved();
  assert.equal(p.el("gp-dd-q").textContent, "When's a good time to catch you?");
  assert.deepEqual(["morning", "afternoon", "evening", "anytime"].map((k) => p.el(`gp-when-${k}`).textContent), ["Mornings", "Afternoons", "Evenings", "Whenever… I'm easy"]);
  p.el("gp-talk").handlers["click"]!({ preventDefault() { /* */ } });
  assert.equal(p.el("gp-dd").hidden, false);
  assert.equal(p.el("gp-finish").className, "btn dim", "the pill not chosen is dimmed (and is still a link)");
  assert.equal(p.sent.filter((x) => x.url.includes("/api/group-details/")).length, 0, "opening the drop-down asks for nothing");
  p.el("gp-talk").handlers["click"]!({ preventDefault() { /* */ } });
  assert.equal(p.el("gp-dd").hidden, true); assert.equal(p.el("gp-finish").className, "btn");
  const es = await saved("es");
  assert.equal(es.el("gp-dd-q").textContent, "¿Cuándo es buen momento para llamarle?");
  assert.deepEqual(["morning", "afternoon", "evening", "anytime"].map((k) => es.el(`gp-when-${k}`).textContent), ["Por la mañana", "Por la tarde", "Por la noche", "Cuando sea… me adapto"]);
});

test("picking a time is the whole request: it goes to the choice route of their own link, the chosen pill stays lit, and the one line sits under the pills", async () => {
  const p = await saved();
  p.el("gp-talk").handlers["click"]!({ preventDefault() { /* */ } });
  p.el("gp-when-evening").handlers["click"]!({ preventDefault() { /* */ } });
  await p.ready();
  const call = p.sent.find((x) => x.url.includes("/api/group-details/"))!;
  assert.equal(call.url, `/api/group-details/${LINK}/choice`);
  assert.deepEqual(call.body, { choice: "call", when: "evening", lang: "en", website: "" });
  assert.equal(p.el("gp-dd-line").hidden, false);
  assert.equal(p.el("gp-dd-line").innerHTML, "Evenings it is… Mark rings you from <b>919-346-6127</b>. Watch your inbox: the details are on their way, with one smart-cruiser move to do while you wait.");
  // Mark 2026-10-24 (Road A v5): the question and the pills stay, the chosen time is lit, and the one line sits under them
  assert.equal(p.el("gp-dd-q").hidden, false); assert.equal(p.el("gp-whens").hidden, false, "the question and the pills stay");
  assert.equal(p.el("gp-when-evening").className, "opt on"); assert.equal(p.el("gp-when-morning").className, "opt");
  assert.equal(p.el("gp-choice-msg").textContent, "");
  // a second tap on a pill (a double tap) asks for nothing more
  const before = p.sent.length;
  p.el("gp-when-morning").handlers["click"]!({ preventDefault() { /* */ } });
  await p.ready();
  assert.equal(p.sent.length, before);
});

test("the one line for each answer, in English and Spanish; the number is the one in the group's own line beside the button, else the business number", async () => {
  const lead: Record<string, string> = { morning: "Mornings it is…", afternoon: "Afternoons it is…", evening: "Evenings it is…", anytime: "Whenever works…" };
  const tail = (n: string) => ` Mark rings you from <b>${n}</b>. Watch your inbox: the details are on their way, with one smart-cruiser move to do while you wait.`;
  for (const when of ["morning", "afternoon", "evening", "anytime"]) {
    const p = await saved();
    p.el(`gp-when-${when}`).handlers["click"]!({ preventDefault() { /* */ } });
    await p.ready();
    assert.equal(p.el("gp-dd-line").innerHTML, lead[when] + tail("919-346-6127"), when);
  }
  const own = await saved("en", { copy: { cta_blurb: "Questions? Call or text Mark at (704) 555-0100." } });
  own.el("gp-when-anytime").handlers["click"]!({ preventDefault() { /* */ } });
  await own.ready();
  assert.equal(own.el("gp-dd-line").innerHTML, "Whenever works…" + tail("(704) 555-0100"));
  const none = await saved("en", { copy: { cta_blurb: "" } });
  none.el("gp-when-evening").handlers["click"]!({ preventDefault() { /* */ } });
  await none.ready();
  assert.equal(none.el("gp-dd-line").innerHTML, lead["evening"] + tail("919-346-6127"));
  const es = await saved("es");
  es.el("gp-when-morning").handlers["click"]!({ preventDefault() { /* */ } });
  await es.ready();
  assert.equal(es.el("gp-dd-line").innerHTML, "Por la mañana, entonces… Mark le llama desde el <b>919-346-6127</b>. Esté pendiente de su correo: los detalles van en camino, con una jugada inteligente de crucerista para hacer mientras espera.");
  const esEve = await saved("es");
  esEve.el("gp-when-evening").handlers["click"]!({ preventDefault() { /* */ } });
  await esEve.ready();
  assert.match(esEve.el("gp-dd-line").innerHTML, /^Por la noche, entonces… Mark le llama/);
  // the line is markup only because of its own <b>: anything else in the number is text
  const odd = await saved("en", { copy: { cta_blurb: "Call 919-346-6127 <img src=x>" } });
  odd.el("gp-when-evening").handlers["click"]!({ preventDefault() { /* */ } });
  await odd.ready();
  assert.ok(!odd.el("gp-dd-line").innerHTML.includes("<img"));
});

test("if the request does not go through nothing is promised: the pills stay, the line is not shown, and the red note says to call or text Mark", async () => {
  const p = await saved("en", {}, (url) => (url.endsWith("/interest") ? { ok: true, json: LINKS } : { ok: false, json: { success: false } }));
  p.el("gp-talk").handlers["click"]!({ preventDefault() { /* */ } });
  p.el("gp-when-evening").handlers["click"]!({ preventDefault() { /* */ } });
  await p.ready();
  assert.equal(p.el("gp-dd-line").hidden, true);
  assert.equal(p.el("gp-whens").hidden, false); assert.equal(p.el("gp-dd-q").hidden, false);
  assert.equal(p.el("gp-choice-msg").textContent, "That did not go through. Call or text Mark at 919-346-6127.");
  assert.equal(p.el("gp-choice-msg").className, "msg err");
  const es = await saved("es", {}, (url) => (url.endsWith("/interest") ? { ok: true, json: LINKS } : { ok: false, json: { success: false } }));
  es.el("gp-when-evening").handlers["click"]!({ preventDefault() { /* */ } });
  await es.ready();
  assert.equal(es.el("gp-choice-msg").textContent, "No se pudo enviar. Llame o escriba a Mark al 919-346-6127.");
  // and a retry works once the server is back
  let up = false;
  const r = await saved("en", {}, (url) => (url.endsWith("/interest") ? { ok: true, json: LINKS } : { ok: up, json: { success: up } }));
  r.el("gp-when-evening").handlers["click"]!({ preventDefault() { /* */ } });
  await r.ready();
  up = true;
  r.el("gp-when-morning").handlers["click"]!({ preventDefault() { /* */ } });
  await r.ready();
  assert.match(r.el("gp-dd-line").innerHTML, /^Mornings it is…/);
});

test("'I've got this' is a plain link to their details page and sends nothing by itself", async () => {
  const p = await saved();
  assert.equal(p.sent.filter((x) => x.url.includes("/api/group-details/")).length, 0);
  assert.equal(p.el("gp-finish").href, LINKS.detailsUrl);
  assert.equal(p.el("gp-finish").handlers["click"], undefined, "the page adds no click handler: the browser just follows the link");
});

test("a server that sends no links (or a link that is not http) gets the plain thank-you, and nothing is made of a hostile link", async () => {
  for (const reply of [{ success: true }, { ...LINKS, detailsUrl: "javascript:alert(1)" }, { ...LINKS, detailsUrl: "https://stillafloatcruising.com/details.html?t=short" }]) {
    const p = visit("en", answerFor("en"), "?g=abcdefghjk", (url) => (url.endsWith("/interest") ? { ok: true, json: reply } : { ok: true, json: { success: true } }));
    await p.ready();
    await p.submit({ name: "Pat Lee", contact: "pat@example.com" });
    assert.equal(p.el("gp-msg").textContent, "Got it. We will be in touch soon.", JSON.stringify(reply));
    assert.equal(p.el("gp-choice").hidden, true);
    assert.equal(p.el("gp-ask").hidden, false);
  }
});

test("a refused reply keeps the form and shows the server's words where they always were; no choice appears", async () => {
  const p = visit("en", answerFor("en"), "?g=abcdefghjk", () => ({ ok: false, json: { success: false, error: "Please check your email address or phone number." } }));
  await p.ready();
  await p.submit({ name: "Pat Lee", contact: "pat@example.com" });
  assert.equal(p.el("gp-msg").textContent, "Please check your email address or phone number.");
  assert.equal(p.el("gp-choice").hidden, true);
  assert.equal(p.el("gp-ask").hidden, false);
  assert.equal(p.el("gp-submit").disabled, false);
});

test("the ask panel is the last panel before the footer, and the choice is inside the same panel after the form: a yellow link-pill, a yellow button, then the drop-down joined to it", () => {
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    const panel = h.slice(h.indexOf('<section class="panel" id="interest">'), h.indexOf("</section>", h.indexOf('id="interest"')));
    assert.ok(panel.indexOf('id="gp-ask"') < panel.indexOf('id="gp-form"') && panel.indexOf('id="gp-form"') < panel.indexOf('id="gp-choice"'), `${lang}: order inside the panel`);
    assert.ok(h.indexOf('id="sec-travel"') < h.indexOf('id="interest"') && h.indexOf('id="interest"') < h.indexOf('class="foot"'), `${lang}: the ask is last`);
    assert.equal((h.match(/<section\b/g) ?? []).length - (h.slice(h.indexOf('id="interest"')).match(/<section\b/g) ?? []).length, h.slice(0, h.indexOf('id="interest"')).match(/<section\b/g)!.length, `${lang}: nothing but the ask follows it`);
    const choice = panel.slice(panel.indexOf('id="gp-choice"'));
    assert.match(choice, /<a class="btn" id="gp-finish" href="#"><\/a>/);
    assert.match(choice, /<button type="button" class="btn" id="gp-talk"><\/button>/);
    assert.ok(choice.indexOf('id="gp-finish"') < choice.indexOf('id="gp-talk"') && choice.indexOf('id="gp-talk"') < choice.indexOf('id="gp-dd"'), `${lang}: the drop-down sits under the Talk button`);
    assert.deepEqual([...choice.matchAll(/data-when="(\w+)"/g)].map((m) => m[1]), ["morning", "afternoon", "evening", "anytime"]);
    assert.ok(!/btn-out/.test(choice) && !/btn-out/.test(css(lang)), `${lang}: the outlined button is gone`);
    // the drop-down is a white box with a yellow border, joined to the button (no top border)
    assert.match(css(lang), /\.dd\{[^}]*border:2px solid var\(--yellow\);border-top:0;[^}]*background:#fff/);
    assert.match(css(lang), /\.opt\.on\{background:var\(--yellow\)/);
  }
});
