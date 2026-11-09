// choice-page.test.ts — the page after "Save my spot!" (server/public/choice.html and its Spanish twin), run the way a visitor's browser runs it.
// Mark 2026-10-24 (Road A and Road B): the cheer with the FIRST WORD of the name in capitals, one question, two EQUAL yellow pills — "I've got this…
// let me fill it in!" (a plain link to the guest's details page) and "Walk me through it, Mark!" (a drop-down for the time; a tap on a time is the
// whole request, the chosen time stays lit, one line under the pills). Mark 2026-11-08: it is its OWN page on the guest's private link (the group page
// sends them here after Save my spot!), never a card at the bottom of the group page; the group's name sits in the header, right of the logo.
//
// The page script is executed against a minimal stand-in for the browser, fed the answer the server's GET /api/group-details/:token gives and a
// stand-in for its one POST (/choice).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "../../public");
type Lang = "en" | "es";
const PAGES: Record<Lang, string> = { en: "choice.html", es: "es/choice.html" };
const html = (lang: Lang) => readFileSync(join(PUBLIC, PAGES[lang]), "utf8");
const script = (lang: Lang) => /<script>\n([\s\S]*?)<\/script>/.exec(html(lang))![1]!;
const css = () => readFileSync(join(PUBLIC, "css", "group-page.css"), "utf8");

const TOKEN = "T".repeat(43);

/** The answer GET /api/group-details/:token gives right after Save my spot!: a name, no choice yet. */
function answer(over: Record<string, unknown> = {}) {
  return {
    success: true, label: "Friends and Family 2027", ship: "MSC Seashore", sailDateText: "May 9, 2027", returnDateText: "May 13, 2027", heroUrl: null, credits: [], photos: null,
    firstName: "Mark", lastName: "Millham", email: "mmillham1@gmail.com", phone: null, guests: 2, travelers: [], address: null, concierge: null, pick: null,
    choice: null, callWhen: null, holdRequestedAt: null, quoteOptions: null, quote: null, quoteRequestedAt: null, paperwork: null,
    depositPerPersonText: "$50", phoneLine: "Questions? Call or text Mark at 919-346-6127.", businessPhone: "919-346-6127", lang: "en",
    ...over,
  };
}

// ── The browser stand-in ─────────────────────────────────────────────────────────────────────────────────────

type Handler = (e: { preventDefault(): void }) => void;
class El {
  textContent = ""; innerHTML = ""; hidden = false; className = ""; href = ""; disabled = false;
  handlers: Record<string, Handler> = {};
  private attrs: Record<string, string> = {};
  constructor(readonly id: string) {}
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(type: string, fn: Handler) { this.handlers[type] = fn; }
}
type Sent = { url: string; body: Record<string, unknown> };
type Reply = { ok: boolean; json?: unknown };
type PostReply = (url: string, body: Record<string, unknown>) => Reply;

function visit(lang: Lang, o: { search?: string; get?: unknown; getStatus?: number; post?: PostReply } = {}) {
  const els = new Map<string, El>();
  const el = (id: string) => { let e = els.get(id); if (!e) els.set(id, (e = new El(id))); return e; };
  const doc = {
    documentElement: { lang }, title: "",
    getElementById: el,
    createElement: () => { let text = ""; return { set textContent(v: string) { text = v; }, get innerHTML() { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); } }; },
  };
  for (const m of html(lang).matchAll(/<[a-z0-9]+\s[^>]*?\bid="([^"]+)"[^>]*>/g)) if (/\shidden(?=[\s>=])/.test(m[0])) el(m[1]!).hidden = true;
  el("gp-plaque").textContent = lang === "es" ? "Crucero en grupo" : "Group Cruise";
  const requested: string[] = [];
  const sent: Sent[] = [];
  const post = o.post ?? (() => ({ ok: true, json: { success: true } }));
  const loc: { search: string; hash: string; href?: string } = { search: o.search ?? `?t=${TOKEN}`, hash: "" };
  const sandbox = {
    document: doc, window: {}, location: loc, URLSearchParams, console, JSON, String, Promise, Error,
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        sent.push({ url, body });
        const r = post(url, body);
        return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.json ?? { success: r.ok }) });
      }
      requested.push(url);
      const status = o.getStatus ?? 200;
      return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(o.get ?? answer({ lang })) });
    },
  };
  runInNewContext(script(lang), sandbox);
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const quiet = { preventDefault() { /* */ } };
  return {
    el, doc, requested, sent, loc, ready: flush,
    talk: () => el("gp-talk").handlers["click"]!(quiet),
    when: (k: string) => el(`gp-when-${k}`).handlers["click"]!(quiet),
  };
}

// ── The two pages ─────────────────────────────────────────────────────────────────────────────────────────────

test("the two pages are one page in two languages: they differ only in the language, the title and the plaque", () => {
  const norm = (s: string) => s
    .replace('<html lang="en">', "<html>").replace('<html lang="es">', "<html>")
    .replace("<title>You're on the list | Still Afloat Cruising</title>", "<title/>").replace("<title>Ya está en la lista | Still Afloat Cruising</title>", "<title/>")
    .replace('id="gp-plaque">Group Cruise</span>', 'id="gp-plaque"></span>').replace('id="gp-plaque">Crucero en grupo</span>', 'id="gp-plaque"></span>');
  assert.equal(norm(html("en")), norm(html("es")));
});

test("a private page: never indexed, no referrer, the group's name in the header right of the logo, the choice as the one panel, no price, no form, and the group page's own look", () => {
  for (const lang of ["en", "es"] as const) {
    const h = html(lang);
    assert.match(h, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(h, /<meta name="referrer" content="no-referrer">/);
    assert.match(h, /<link rel="stylesheet" href="\/css\/group-page\.css[^"]*">/, `${lang}: the group page's stylesheet`);
    const header = h.slice(h.indexOf('<div class="hdr">'), h.indexOf('<div id="gp-state">'));
    assert.ok(header.indexOf('class="logo"') < header.indexOf('id="gp-plaque"'), `${lang}: the group's name is not right of the logo`);
    assert.ok(!h.includes('class="gp-banner"'), `${lang}: a picture is on the choice page`);
    assert.equal((h.match(/<section\b/g) ?? []).length, 1, `${lang}: more than the one panel`);
    assert.ok(!/<form\b|<input\b(?![^>]*id="gp-website")/.test(h), `${lang}: a form on the choice page`);
    assert.ok(!/\$\s?\d/.test(h), `${lang}: a price on the choice page`);
    assert.ok(!/count me in|cuenten conmigo/i.test(h), `${lang}: "Count me in"`);
    const choice = h.slice(h.indexOf('id="gp-choice"'));
    assert.match(choice, /<a class="btn" id="gp-finish" href="#"><\/a>/);
    assert.match(choice, /<button type="button" class="btn" id="gp-talk"><\/button>/);
    assert.ok(choice.indexOf('id="gp-finish"') < choice.indexOf('id="gp-talk"') && choice.indexOf('id="gp-talk"') < choice.indexOf('id="gp-dd"'), `${lang}: the drop-down sits under the Talk button`);
    assert.deepEqual([...choice.matchAll(/data-when="(\w+)"/g)].map((m) => m[1]), ["morning", "afternoon", "evening", "anytime"]);
    assert.ok(h.includes('<img class="sa" src="/assets/images/still_afloat_logo.png"') && h.includes("cornerstone-white.png"), `${lang}: the footer logos`);
  }
  // the drop-down is a white box with a yellow border, joined to the button (no top border); the chosen time lights yellow
  assert.match(css(), /\.dd\{[^}]*border:2px solid var\(--yellow\);border-top:0;[^}]*background:#fff/);
  assert.match(css(), /\.opt\.on\{background:var\(--yellow\)/);
  assert.match(css(), /#gp-choice \.btn\.dim\{opacity:\.45\}/);
});

// ── The page as the guest sees it ─────────────────────────────────────────────────────────────────────────────

test("the page opens on the cheer with the FIRST WORD of the name in capitals, one question, two equal yellow pills and one line; the name of the group is in the header and the title (English and Spanish)", async () => {
  const p = visit("en");
  await p.ready();
  assert.deepEqual(p.requested, [`/api/group-details/${TOKEN}`]);
  assert.equal(p.el("gp-main").hidden, false); assert.equal(p.el("gp-state").hidden, true);
  assert.equal(p.el("gp-plaque").textContent, "Friends and Family 2027");
  assert.equal(p.doc.title, "You're on the list · Friends and Family 2027 | Still Afloat Cruising");
  assert.equal(p.el("gp-choice-h").textContent, "You tapped, we cheered… YOU'RE ON THE LIST, MARK!");
  assert.equal(p.el("gp-choice-lead").textContent, "Now, how do you like to plan a cruise?");
  assert.equal(p.el("gp-finish").textContent, "I've got this… let me fill it in!");
  assert.equal(p.el("gp-finish").href, `/details.html?t=${TOKEN}`, "a plain link to their own details page, on the same private link");
  assert.equal(p.el("gp-talk").textContent, "Walk me through it, Mark!");
  assert.equal(p.el("gp-choice-foot").textContent, "Either way: nothing to pay or sign tonight… and a laugh or two along the way.");
  assert.equal(p.el("gp-dd").hidden, true, "the drop-down is closed until they tap Walk me through it");
  assert.equal(p.el("gp-finish").className, "btn"); assert.equal(p.el("gp-talk").className, "btn", "two equal pills");
  assert.equal(p.sent.length, 0, "opening the page asks for nothing");

  const typed = visit("en", { get: answer({ firstName: "mary ann" }) });
  await typed.ready();
  assert.match(typed.el("gp-choice-h").textContent, /YOU'RE ON THE LIST, MARY!$/, "the first WORD of the name, in capitals");

  const es = visit("es", { get: answer({ firstName: "Ana", lang: "es" }) });
  await es.ready();
  assert.equal(es.el("gp-choice-h").textContent, "Usted tocó, nosotros aplaudimos… ¡YA ESTÁ EN LA LISTA, ANA!");
  assert.equal(es.el("gp-choice-lead").textContent, "Ahora, ¿cómo le gusta planear un crucero?");
  assert.equal(es.el("gp-finish").textContent, "¡Yo me encargo… déjeme llenarlo!");
  assert.equal(es.el("gp-finish").href, `/es/details.html?t=${TOKEN}`);
  assert.equal(es.el("gp-talk").textContent, "¡Guíeme paso a paso, Mark!");
  assert.equal(es.el("gp-choice-foot").textContent, "De cualquier manera: nada que pagar ni firmar esta noche… y una que otra risa en el camino.");
  assert.equal(es.doc.title, "Ya está en la lista · Friends and Family 2027 | Still Afloat Cruising");
});

test("'Walk me through it, Mark!' opens a drop-down under the button ('When's a good time to catch you?' and four pills); the other pill dims; a second tap closes it", async () => {
  const p = visit("en");
  await p.ready();
  assert.equal(p.el("gp-dd-q").textContent, "When's a good time to catch you?");
  assert.deepEqual(["morning", "afternoon", "evening", "anytime"].map((k) => p.el(`gp-when-${k}`).textContent), ["Mornings", "Afternoons", "Evenings", "Whenever… I'm easy"]);
  p.talk();
  assert.equal(p.el("gp-dd").hidden, false);
  assert.equal(p.el("gp-finish").className, "btn dim", "the pill not chosen is dimmed (and is still a link)");
  assert.equal(p.sent.length, 0, "opening the drop-down asks for nothing");
  p.talk();
  assert.equal(p.el("gp-dd").hidden, true); assert.equal(p.el("gp-finish").className, "btn");
  const es = visit("es", { get: answer({ lang: "es" }) });
  await es.ready();
  assert.equal(es.el("gp-dd-q").textContent, "¿Cuándo es buen momento para llamarle?");
  assert.deepEqual(["morning", "afternoon", "evening", "anytime"].map((k) => es.el(`gp-when-${k}`).textContent), ["Por la mañana", "Por la tarde", "Por la noche", "Cuando sea… me adapto"]);
});

test("picking a time is the whole request: it goes to the choice route of their own link, the chosen pill stays lit, and the one line sits under the pills", async () => {
  const p = visit("en");
  await p.ready();
  p.talk(); p.when("evening");
  await p.ready();
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0]!.url, `/api/group-details/${TOKEN}/choice`);
  assert.deepEqual(p.sent[0]!.body, { choice: "call", when: "evening", lang: "en", website: "" });
  assert.equal(p.el("gp-dd-line").hidden, false);
  assert.equal(p.el("gp-dd-line").innerHTML, "Evenings it is… Mark rings you from <b>919-346-6127</b>. Watch your inbox: the details are on their way, with one smart-cruiser move to do while you wait.");
  // Mark 2026-10-24 (Road A v5): the question and the pills stay, the chosen time is lit, and the one line sits under them
  assert.equal(p.el("gp-dd-q").hidden, false); assert.equal(p.el("gp-whens").hidden, false, "the question and the pills stay");
  assert.equal(p.el("gp-when-evening").className, "opt on"); assert.equal(p.el("gp-when-morning").className, "opt");
  assert.equal(p.el("gp-choice-msg").textContent, "");
  // a second tap on a pill (a double tap) asks for nothing more
  p.when("morning");
  await p.ready();
  assert.equal(p.sent.length, 1);
});

test("the one line for each answer, in English and Spanish; the number is the one in the group's own line beside the button (the server's businessPhone), else the business number", async () => {
  const lead: Record<string, string> = { morning: "Mornings it is…", afternoon: "Afternoons it is…", evening: "Evenings it is…", anytime: "Whenever works…" };
  const tail = (n: string) => ` Mark rings you from <b>${n}</b>. Watch your inbox: the details are on their way, with one smart-cruiser move to do while you wait.`;
  for (const when of ["morning", "afternoon", "evening", "anytime"]) {
    const p = visit("en");
    await p.ready();
    p.when(when);
    await p.ready();
    assert.equal(p.el("gp-dd-line").innerHTML, lead[when] + tail("919-346-6127"), when);
  }
  const own = visit("en", { get: answer({ businessPhone: "(704) 555-0100" }) });
  await own.ready();
  own.when("anytime");
  await own.ready();
  assert.equal(own.el("gp-dd-line").innerHTML, "Whenever works…" + tail("(704) 555-0100"));
  const none = visit("en", { get: answer({ businessPhone: null, phoneLine: null }) });
  await none.ready();
  none.when("evening");
  await none.ready();
  assert.equal(none.el("gp-dd-line").innerHTML, lead["evening"] + tail("919-346-6127"));
  const es = visit("es", { get: answer({ lang: "es" }) });
  await es.ready();
  es.when("morning");
  await es.ready();
  assert.equal(es.el("gp-dd-line").innerHTML, "Por la mañana, entonces… Mark le llama desde el <b>919-346-6127</b>. Esté pendiente de su correo: los detalles van en camino, con una jugada inteligente de crucerista para hacer mientras espera.");
  // the line is markup only because of its own <b>: anything else in the number is text
  const odd = visit("en", { get: answer({ businessPhone: "919-346-6127 <img src=x>" }) });
  await odd.ready();
  odd.when("evening");
  await odd.ready();
  assert.ok(!odd.el("gp-dd-line").innerHTML.includes("<img"));
});

test("if the request does not go through nothing is promised: the pills stay, the line is not shown, and the red note says to call or text Mark; a retry works once the server is back", async () => {
  const p = visit("en", { post: () => ({ ok: false, json: { success: false } }) });
  await p.ready();
  p.talk(); p.when("evening");
  await p.ready();
  assert.equal(p.el("gp-dd-line").hidden, true);
  assert.equal(p.el("gp-whens").hidden, false); assert.equal(p.el("gp-dd-q").hidden, false);
  assert.equal(p.el("gp-choice-msg").textContent, "That did not go through. Call or text Mark at 919-346-6127.");
  assert.equal(p.el("gp-choice-msg").className, "msg err");
  const es = visit("es", { get: answer({ lang: "es" }), post: () => ({ ok: false, json: { success: false } }) });
  await es.ready();
  es.when("evening");
  await es.ready();
  assert.equal(es.el("gp-choice-msg").textContent, "No se pudo enviar. Llame o escriba a Mark al 919-346-6127.");
  let up = false;
  const r = visit("en", { post: () => ({ ok: up, json: { success: up } }) });
  await r.ready();
  r.when("evening");
  await r.ready();
  up = true;
  r.when("morning");
  await r.ready();
  assert.match(r.el("gp-dd-line").innerHTML, /^Mornings it is…/);
});

test("'I've got this' is a plain link to their details page and sends nothing by itself", async () => {
  const p = visit("en");
  await p.ready();
  assert.equal(p.sent.length, 0);
  assert.equal(p.el("gp-finish").href, `/details.html?t=${TOKEN}`);
  assert.equal(p.el("gp-finish").handlers["click"], undefined, "the page adds no click handler: the browser just follows the link");
});

// ── Coming back on the same link ──────────────────────────────────────────────────────────────────────────────

test("a guest who already asked for the call sees the time they picked lit and the one line, and cannot ask twice; 'I've got this' is still there", async () => {
  const p = visit("en", { get: answer({ choice: "call", callWhen: "afternoon" }) });
  await p.ready();
  assert.equal(p.el("gp-dd").hidden, false);
  assert.equal(p.el("gp-when-afternoon").className, "opt on");
  assert.match(p.el("gp-dd-line").innerHTML, /^Afternoons it is… Mark rings you from <b>919-346-6127<\/b>/);
  assert.equal(p.el("gp-finish").href, `/details.html?t=${TOKEN}`);
  p.when("morning"); p.talk();
  await p.ready();
  assert.equal(p.sent.length, 0, "nothing is asked again");
  assert.equal(p.el("gp-dd").hidden, false, "the drop-down stays open");
});

test("a guest whose names are in (Road B taken) or whose quote step is open is sent on to their details page, which knows where they are", async () => {
  for (const over of [{ choice: "finish" }, { holdRequestedAt: "2026-11-08T10:00:00Z", choice: "finish" }, { quoteRequestedAt: "2026-11-08T10:00:00Z", choice: "finish" }]) {
    const p = visit("en", { get: answer(over) });
    await p.ready();
    assert.equal(p.loc.href, `/details.html?t=${TOKEN}`, JSON.stringify(over));
    assert.equal(p.el("gp-main").hidden, true);
  }
  const es = visit("es", { get: answer({ choice: "finish", lang: "es" }) });
  await es.ready();
  assert.equal(es.loc.href, `/es/details.html?t=${TOKEN}`);
});

// ── Bad links ─────────────────────────────────────────────────────────────────────────────────────────────────

test("a wrong link gets the same plain 'not available' and asks the server for nothing when the link is not even the right shape", async () => {
  for (const search of ["", "?t=short", `?t=${"A".repeat(44)}`, "?t=wrong-link-with-$ymbols!-and-the-right-length"]) {
    const p = visit("en", { search });
    await p.ready();
    assert.equal(p.requested.length, 0, search);
    assert.equal(p.el("gp-state").textContent, "This page is not available. If your group sent you the link, email mark@stillafloatcruising.com.");
    assert.equal(p.el("gp-main").hidden, true);
  }
  const gone = visit("en", { getStatus: 404 });
  await gone.ready();
  assert.equal(gone.el("gp-state").textContent, "This page is not available. If your group sent you the link, email mark@stillafloatcruising.com.");
  assert.equal(gone.el("gp-main").hidden, true);
  const es = visit("es", { getStatus: 404 });
  await es.ready();
  assert.equal(es.el("gp-state").textContent, "Esta página no está disponible. Si recibió el enlace de su grupo, escriba a mark@stillafloatcruising.com.");
});
