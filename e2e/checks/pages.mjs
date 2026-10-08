// e2e/checks/pages.mjs — every page of the site: it opens, everything on it resolves, and it
// tells visitors and search engines the right language, address and Spanish twin.
//
// Why this file exists (risks and incidents):
//   2026-09-15  The navbar's "En Español" link on /track-ship.html and /subscribe-verified.html
//               went to the Spanish HOME page, and Spanish-preference browsers were never routed
//               to the Spanish page, because the page was missing from the navbar's ES_PAGES list.
//               A feature test of either page passed; only reading the navbar against the page
//               list catches it. The language switch is now checked on EVERY page that loads it.
//   2026-09-15  navbar.js is cache-busted with ?v= on 49+ pages by hand. A page left on an old
//               ?v= keeps serving the old menu from browser caches — every page must name the
//               same version as the home page.
//   2026-09-29  Foreign domains (scrapemafia.com, applify.work) served our pages under their own
//               names. Every indexable page must name https://stillafloatcruising.com as its
//               canonical address, and the dev box must never be indexable (robots + header).
//   2026-09     Search collapse (see stillafloat-search-collapse-2026-09): Spanish is a core
//               market, and a Spanish page that names the English page as its canonical address,
//               or has no hreflang pair, is dropped from Spanish search results.
//   always      The site falls back to nothing helpful when a link breaks: nginx answers 404. A
//               page whose picture, script or stylesheet moved shows a broken layout to every
//               visitor while every API check stays green.
//
// How it is organised: the PAGES table below lists every tracked page (server/public/**.html —
// the coverage audit fails when a new page is not added here). Each crawl check takes a small
// group of pages, EN and ES twins together, and checks for each page:
//   · it answers 200 with a real HTML page (not an error page or the home page under another name)
//   · a non-empty <title>, an <h1> (or the documented reason it has none), <html lang> matching
//     its language
//   · canonical = itself on https://stillafloatcruising.com (customer pages); a utility page is
//     kept out of search (noindex or robots.txt Disallow)
//   · its Spanish twin exists (English customer and template pages), hreflang pairs are reciprocal
//     (in the page or in sitemap.xml — Google accepts either), customer pages are in sitemap.xml
//   · the navbar's language switch opens the twin, and the page names the current navbar version
//   · ALL same-site scripts and stylesheets resolve with the right content type, all same-site
//     images resolve as images, and up to 15 same-site links per page resolve (sampled first,
//     last and evenly between when a group would pass ~40 requests). /api/ links are never
//     followed: /api/go/:id records an affiliate click (the affiliate area tests it with a fixture).
// On dev, links written with the production host are followed on the dev box (html.onBase).
// Problems are collected and reported together, so one run lists every broken thing in a group.
//
// Added by the adversarial review (2026-10-07), each for a breakage the first version let through:
//   · THE REAL NAVBAR IS RUN, not imitated. The language link, the menu and the Spanish-browser
//     redirect are computed by executing the served navbar.js in a sandbox (node:vm, a fake
//     window/document, no network). A copy of its logic in this file would keep passing after
//     navbar.js itself broke. The redirect is checked too: a Spanish-language browser on an English
//     page must be sent to that page's Spanish twin, never to an address that does not exist, and
//     an explicit English choice must stick.
//   · The page still calls its data. Each page must mention the /api/ endpoints its content comes
//     from (in the page or its own scripts), and an English page and its Spanish twin must call the
//     same endpoints — a Spanish page that stopped loading its data shows a shell while the English
//     one works (found: the Spanish gear hub never loads the featured item).
//   · Hero art lives in CSS (inline <style> and styles.css url(...)), not <img>: those pictures and
//     the social-share picture (og:image) are fetched as images.
//   · In-page jump links ("Start planning with Mark" → #contact) must land on something.
//   · A Spanish page must read as Spanish (and an English page as English), not just say lang="es".
//   · A page that loads the menu script must hold the container it draws into, must not load a
//     script twice, and an English page and its Spanish twin both have the menu or both do not.
import vm from "node:vm";
import * as H from "../lib/html.mjs";

const PROD = "https://stillafloatcruising.com";
const MAX_REQUESTS = 42; // per crawl check — the sweep must stay gentle on the small prod box

// kinds:
//   customer      an indexable public page: canonical = itself, in sitemap.xml, Spanish twin + hreflang pair
//   template      one page that renders many items from its query string (?id=, ?place=, ?g=…): a static
//                 canonical would merge every item into one, so none is required (if present, it must be itself)
//   utility       a confirmation / interstitial page: must be kept out of search, no twin required
//   owner         Mark's own tool page: must be kept out of search
//   verification  Google Search Console's ownership file
// h1:  omitted → a real heading must be in the markup
//      { client: why } → the page's script writes the heading; the markup must hold the <h1> it fills
//      { none: why }   → no heading by design
const PAGES = [
  // home
  { path: "/index.html", fetch: "/", lang: "en", kind: "customer" },
  { path: "/es/index.html", fetch: "/es/", lang: "es", kind: "customer" },
  // advisor + sign-up
  { path: "/work-with-mark.html", lang: "en", kind: "customer" },
  { path: "/es/work-with-mark.html", lang: "es", kind: "customer" },
  { path: "/subscribe.html", lang: "en", kind: "customer" },
  { path: "/es/subscribe.html", lang: "es", kind: "customer" },
  { path: "/subscribe-pending.html", lang: "en", kind: "utility", noTwin: "the 'check your inbox' page shown after a sign-up form is sent" },
  { path: "/subscribe-verified.html", lang: "en", kind: "utility", noTwin: "confirmation landing page (its Spanish twin exists and is checked too)" },
  { path: "/es/subscribe-verified.html", lang: "es", kind: "utility" },
  { path: "/unsubscribe-confirmed.html", lang: "en", kind: "utility", noTwin: "the landing page after an unsubscribe link" },
  // gear
  { path: "/affiliate.html", lang: "en", kind: "customer" },
  { path: "/es/affiliate.html", lang: "es", kind: "customer" },
  ...["air-travel", "cabin-essentials", "clothing", "cruise-fun", "great-ideas", "health-at-sea"].flatMap((c) => [
    { path: `/affiliate/${c}.html`, lang: "en", kind: "customer" },
    { path: `/es/affiliate/${c}.html`, lang: "es", kind: "customer" },
  ]),
  // weather + cams + favorites
  { path: "/weather.html", lang: "en", kind: "customer" },
  { path: "/es/weather.html", lang: "es", kind: "customer" },
  { path: "/forecast.html", lang: "en", kind: "template", noTwin: "one page for both languages: the Spanish weather page opens it with &lang=es and its script switches the text (weather.search-path-synopsis checks those links)" },
  { path: "/webcams.html", lang: "en", kind: "customer" },
  { path: "/es/webcams.html", lang: "es", kind: "customer" },
  { path: "/favorites.html", lang: "en", kind: "customer" },
  // ships + storms
  { path: "/wheres-my-ship.html", lang: "en", kind: "customer" },
  { path: "/es/wheres-my-ship.html", lang: "es", kind: "customer" },
  { path: "/track-ship.html", lang: "en", kind: "template" },
  { path: "/es/track-ship.html", lang: "es", kind: "template" },
  { path: "/storm-watch.html", lang: "en", kind: "template" },
  { path: "/es/storm-watch.html", lang: "es", kind: "template" },
  // cabins
  { path: "/room-concierge.html", lang: "en", kind: "customer" },
  { path: "/es/room-concierge.html", lang: "es", kind: "customer" },
  { path: "/cabin-request.html", lang: "en", kind: "template" },
  { path: "/es/cabin-request.html", lang: "es", kind: "template" },
  // the 2026-08 cabin quiz, superseded by Room Concierge: nothing on the site links to it (only the
  // dashboard's ratings page), so it is kept out of search (noindex since 8d59440) and needs no twin
  { path: "/cabin-finder.html", lang: "en", kind: "utility", noTwin: "orphaned cabin quiz superseded by Room Concierge; only the dashboard links to it" },
  // commentary + stories
  { path: "/commentary.html", lang: "en", kind: "customer" },
  { path: "/es/commentary.html", lang: "es", kind: "customer" },
  { path: "/commentary-post.html", lang: "en", kind: "template", h1: { client: "the post's title is written into the <h1> by the page script" } },
  { path: "/es/commentary-post.html", lang: "es", kind: "template", h1: { client: "the post's title is written into the <h1> by the page script" } },
  { path: "/story.html", lang: "en", kind: "template" },
  { path: "/es/story.html", lang: "es", kind: "template" },
  { path: "/es/translate-loading.html", lang: "es", kind: "utility", h1: { none: "a two-second 'translating…' spinner shown while a story is translated" } },
  // policies + utility + owner
  { path: "/privacy.html", lang: "en", kind: "customer" },
  { path: "/es/privacy.html", lang: "es", kind: "customer" },
  { path: "/terms.html", lang: "en", kind: "customer" },
  { path: "/es/terms.html", lang: "es", kind: "customer" },
  { path: "/under-construction.html", lang: "en", kind: "utility", noTwin: "a placeholder page nothing links to" },
  { path: "/editorial-queue.html", lang: "en", kind: "owner", noTwin: "Mark's own review page" },
  { path: "/google6dc6f027af183f2e.html", lang: "", kind: "verification", noTwin: "Search Console's ownership file" },
  // group cruises — NEW IN THIS RELEASE (dev only until the 2026-10-08 promotion)
  // navbarSwitch: a group page in English only has no Spanish version, so the navbar's "En Español" link
  // correctly falls back to the Spanish home page (and Spanish browsers are NOT redirected to an empty
  // /es/group.html); a bilingual group shows its own language link (#gp-lang) built from the group's languages.
  { path: "/group.html", lang: "en", kind: "template", h1: { client: "the group's name is written into the <h1> from the ?g= code" }, navbarSwitch: "home" },
  { path: "/es/group.html", lang: "es", kind: "template", h1: { client: "the group's name is written into the <h1> from the ?g= code" } },
];
const BY_PATH = new Map(PAGES.map((p) => [p.path, p]));

// The /api/ endpoints each page's content comes from, read from the page code on 2026-10-07 (keyed by
// the English page; the Spanish twin needs the same). A page that still opens but no longer mentions
// its endpoint in the page or in its own scripts (navbar.js excluded) shows an empty shell. The
// endpoints themselves are tested by their areas; this holds the PAGE to calling them.
// Not listed: weather.html (calls the weather provider from the browser — the weather area covers it)
// and story.html (calls the news agent through AGENT_BASE_URL, which a static scan cannot see).
const GEAR = "/api/affiliate-items";
const APIS = {
  "/index.html": ["/api/storm-watch", "/api/youtube-top"],
  "/work-with-mark.html": ["/api/contact", "/api/public-config"],
  "/subscribe.html": ["/api/subscribe", "/api/public-config"],
  "/subscribe-pending.html": ["/api/resend-verification"],
  "/affiliate.html": [GEAR],
  ...Object.fromEntries(["air-travel", "cabin-essentials", "clothing", "cruise-fun", "great-ideas", "health-at-sea"].map((c) => [`/affiliate/${c}.html`, [GEAR]])),
  "/forecast.html": ["/api/weather"],
  "/webcams.html": ["/api/webcams"],
  "/favorites.html": ["/api/favorites"],
  "/wheres-my-ship.html": ["/api/wms/ships", "/api/weather"],
  "/track-ship.html": ["/api/wms/track-signup"],
  "/storm-watch.html": ["/api/storm-watch"],
  "/room-concierge.html": ["/api/cabins/recommend", "/api/cabins/fleet"],
  "/cabin-request.html": ["/api/contact"],
  "/cabin-finder.html": ["/api/cabins/recommend"],
  "/commentary.html": ["/api/commentary"],
  "/commentary-post.html": ["/api/commentary"],
  "/group.html": ["/api/group-page/"],
  "/translate-loading.html": ["/api/translate-article"],
};
const apisFor = (p) => APIS[p.lang === "es" ? p.path.replace(/^\/es(\/.*)$/, "$1") : p.path] || [];

// ── small helpers ─────────────────────────────────────────────────────────────
/** Comparable form of an address: protocol + host + path, "/index.html" folded to "/", no query or hash. */
const norm = (u) => {
  try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname.replace(/\/index\.html$/, "/")}`; } catch { return String(u); }
};
const prodUrl = (path) => norm(`${PROD}${path}`);
const enTwinOf = (path) => path.replace(/^\/es(\/.*)$/, "$1");
const esTwinOf = (path) => `/es${path}`;
const twinOf = (p) => (p.lang === "es" ? enTwinOf(p.path) : esTwinOf(p.path));
const isRealPage = (res) => res.status === 200 && /<html[\s>]/i.test(res.text) && res.text.length > 500;
const ctype = (res) => String(res.headers?.get?.("content-type") || "");
const spread = (list, n) => {
  if (list.length <= n) return list;
  const out = new Set([list[0], list[list.length - 1]]);
  for (let i = 1; out.size < n && i < n; i++) out.add(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return [...out];
};
const short = (u, t) => String(u).replace(t.bases.site, "").replace(PROD, "") || "/";

/**
 * Where to read the robots.txt that ships to production. On prod: /robots.txt. On dev, nginx
 * answers /robots.txt itself with a block-everything file (the dev mirror must never be
 * indexed), so the shipping file is read from the dev app directly — port 5000, the address
 * nginx proxies /api/ to on the dev box.
 */
const shippingRobotsUrl = (t) => {
  if (t.mode === "prod") return t.url("/robots.txt");
  const u = new URL(t.bases.site); u.port = "5000"; u.pathname = "/robots.txt"; return u.toString();
};
const disallowsOf = (text) => {
  const out = []; let star = false;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(line.replace(/#.*$/, ""));
    if (!m) continue;
    if (/^user-agent$/i.test(m[1])) star = m[2] === "*";
    else if (star && /^disallow$/i.test(m[1]) && m[2]) out.push(m[2]);
  }
  return out;
};
/** sitemap.xml → { locs: [normalised], alts: Map(loc → {hreflang: normalised href}) } */
const readSitemap = (xml) => {
  const locs = []; const alts = new Map();
  for (const m of String(xml).matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1])?.[1];
    if (!loc) continue;
    const n = norm(loc.replace(/&amp;/g, "&"));
    locs.push(n);
    alts.set(n, Object.fromEntries([...m[1].matchAll(/hreflang="([^"]+)"\s+href="([^"]+)"/g)].map((a) => [a[1].toLowerCase(), norm(a[2])])));
  }
  return { locs, alts };
};
/**
 * Run the SERVED navbar.js for a visitor at `pathname` + `search`, in a sandbox: a fake window,
 * document, navigator and localStorage; no network, no timers, 2-second limit. Returns the desktop
 * menu HTML, the mobile menu HTML and where the script redirected the browser (null = stayed).
 * `languages` is the browser's language list; `pref` the stored language choice (null = none).
 * The script is our own (the box under test serves it); it is never given anything but these fakes.
 */
function renderNavbar(js, pathname, { search = "", languages = ["en-US"], pref = null } = {}) {
  const made = [];
  const el = () => {
    const e = { style: {}, _html: "", textContent: "", parentElement: null,
      classList: { add() {}, remove() {}, contains() { return false; } },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, appendChild() {},
      querySelector() { return null; }, querySelectorAll() { return []; } };
    Object.defineProperty(e, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); } });
    made.push(e); return e;
  };
  const container = el(); container.parentElement = el();
  let redirect = null;
  const document = { readyState: "complete", head: el(), body: el(), createElement: () => el(),
    getElementById: (id) => (id === "navbar-container" ? container : null), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const sandbox = {
    window: { location: { pathname, search, replace: (u) => { redirect = String(u); } } },
    document, navigator: { languages, language: languages[0] || "" },
    localStorage: { getItem: () => pref, setItem() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    console: { log() {}, warn() {}, error() {}, info() {} },
  };
  vm.runInNewContext(String(js), sandbox, { timeout: 2000 });
  return { desktop: container.innerHTML, mobile: made.filter((e) => e !== container).map((e) => e.innerHTML).join("\n"), redirect };
}
/** href of the first <a> carrying class `cls` in a navbar render ("" when there is none). */
const hrefOfClass = (html, cls) => {
  const tag = (String(html).match(/<a\b[^>]*>/gi) || []).find((a) => new RegExp(`class\\s*=\\s*["'][^"']*\\b${cls}\\b`).test(a));
  return tag ? (/\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "") : "";
};
/** The menu as a visitor sees it: every link the render draws, minus the language link. */
const menuLinks = (html) => (String(html).match(/<a\b[^>]*>/gi) || [])
  .filter((a) => !/\bsa-(lang-link|mobile-lang)\b/.test(a))
  .map((a) => /\bhref\s*=\s*["']([^"']*)["']/i.exec(a)?.[1]).filter(Boolean);
/** url(...) and @import references in CSS text (data: URIs dropped). */
const cssRefs = (css) => [
  ...[...String(css).matchAll(/url\(\s*(?:(['"])(.*?)\1|([^)'"\s]+))\s*\)/g)].map((m) => m[2] ?? m[3]),
  ...[...String(css).matchAll(/@import\s+(['"])(.*?)\1/g)].map((m) => m[2]),
].filter((u) => u && !/^data:/i.test(u));
/** CSS written in the page itself: <style> blocks and style="" attributes (script text excluded). */
const inlineCss = (html) => {
  const noScripts = String(html).replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  return [...[...noScripts.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]),
    ...[...noScripts.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'"))].join("\n");
};
// Function words: enough to tell a Spanish page from an English copy wearing lang="es".
const ES_WORDS = new Set("de la el los las para con tu tus que en una del por y más cómo qué es un nuestro nuestra puedes crucero cruceros barco".split(" "));
const EN_WORDS = new Set("the and you your to of for with is our this what it are can cruise ship ships".split(" "));
const languageOfText = (html) => {
  const words = H.visibleText(html).toLowerCase().split(/[^a-záéíóúñü]+/).filter(Boolean);
  return { words: words.length, es: words.filter((w) => ES_WORDS.has(w)).length, en: words.filter((w) => EN_WORDS.has(w)).length };
};
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|ico)$/i;
// Public CDNs the pages load code and styles from (fetched as plain files; see the crawl, step 3).
const CDN_HOSTS = new Set(["unpkg.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com"]);
const cdnUrl = (ref, pageUrl) => { const u = H.resolve(ref, pageUrl); try { return u && CDN_HOSTS.has(new URL(u).host) ? u : null; } catch { return null; } };
const readEsPages = (js) => {
  const m = /const\s+ES_PAGES\s*=\s*new\s+Set\(\s*\[([^\]]*)\]/.exec(String(js));
  return m ? new Set([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])) : null;
};

/** A fetcher that asks for each address once per check; production-host addresses go to the box under test. */
function fetcher(t) {
  const cache = new Map();
  const get = async (pathOrUrl) => {
    const url = H.onBase(t.url(pathOrUrl), t.bases.site);
    if (!cache.has(url)) cache.set(url, await t.get(url));
    return cache.get(url);
  };
  return { get, cache };
}

/** Context every crawl group needs: the home page (navbar version + its title), sitemap.xml and the shipping robots.txt. */
async function context(t, get) {
  const home = await get("/");
  t.html(home);
  const navSrc = H.scripts(home.text).find((s) => /\/components\/navbar\.js/.test(s));
  t.ok(Boolean(navSrc), "the home page does not load the site navbar (components/navbar.js)");
  const sm = await get("/sitemap.xml");
  t.status(sm, 200);
  t.ok(/<urlset\b/.test(sm.text), `sitemap.xml is not a sitemap (${sm.text.length} bytes)`);
  const sitemap = readSitemap(sm.text);
  t.atLeast(sitemap.locs.length, 20, "addresses in sitemap.xml");
  const robots = await t.get(shippingRobotsUrl(t));
  t.status(robots, 200);
  t.ok(/user-agent\s*:/i.test(robots.text), "the shipping robots.txt has no User-agent line");
  const nav = await get(H.resolve(navSrc, home.url));
  t.status(nav, 200);
  t.ok(/javascript/i.test(ctype(nav)) && !/^\s*</.test(nav.text), `navbar.js does not load as JavaScript (${ctype(nav) || "no type"})`);
  // the served navbar must run and draw a menu with a language link — otherwise nothing below means anything
  let probe;
  try { probe = renderNavbar(nav.text, "/weather.html"); } catch (e) { probe = null; t.ok(false, `the served navbar.js throws when it runs: ${String(e?.message || e).slice(0, 120)}`); }
  t.ok(Boolean(hrefOfClass(probe.desktop, "sa-lang-link")) && menuLinks(probe.desktop).length >= 8, "the served navbar.js ran but drew no menu with a language link — the menu is broken on every page");
  return { home, homeTitle: H.title(home.text), navVersion: navSrc.split("?")[1] || "", sitemap, disallows: disallowsOf(robots.text), navJs: nav.text };
}

/**
 * The crawl. `paths` are entries of PAGES. Collects every problem and fails once, listing all of them.
 */
async function crawl(t, paths, { label }) {
  const { get, cache } = fetcher(t);
  const ctx = await context(t, get);
  const problems = [];
  const bad = (msg) => problems.push(msg);
  const pages = paths.map((p) => { const e = BY_PATH.get(p); if (!e) throw new Error(`pages.mjs: ${p} is not in the PAGES table`); return e; });
  const loaded = new Map(); // path → { html, res }
  const assets = { script: new Set(), style: new Set(), image: new Set(), other: new Set(), cdn: new Map() };
  const linksPerPage = [];
  const hasNav = new Map(); // path → the page loads the site navbar
  const pageScripts = new Map(); // path → same-site scripts it loads (navbar.js excluded)
  const fragments = []; // { from, url (no #), frag } — jump links to another page
  let apiLinksSkipped = 0;
  const nav = (pathname, opts) => {
    try { return renderNavbar(ctx.navJs, pathname, opts); } catch (e) { bad(`the navbar script throws on ${pathname}: ${String(e?.message || e).slice(0, 100)}`); return { desktop: "", mobile: "", redirect: null }; }
  };

  // 1. every page, and the twin each one needs
  for (const p of pages) {
    const res = await get(p.fetch || p.path);
    if (p.kind === "verification") {
      if (res.status !== 200 || !res.text.includes(`google-site-verification: ${p.path.slice(1)}`)) bad(`${p.path}: the Search Console ownership file is missing or changed (${res.describe()}) — Search Console would lose the site`);
      continue;
    }
    if (!isRealPage(res)) { bad(`${p.path} does not open as a page (${res.describe()}, ${res.text.length} bytes)`); continue; }
    if (!/text\/html/i.test(ctype(res))) bad(`${p.path} is served as "${ctype(res) || "no type"}", not text/html — browsers would show the code instead of the page`);
    const html = res.text;
    loaded.set(p.path, { html, res });
    const title = H.title(html);
    t.observe(`title ${p.path}`, title);
    if (!title) bad(`${p.path} has no <title>`);
    else if (p.path !== "/index.html" && title === ctx.homeTitle) bad(`${p.path} answers with the home page's title — it is the home page under another address`);
    const lang = H.htmlLang(html).toLowerCase();
    if (!lang.startsWith(p.lang)) bad(`${p.path} says <html lang="${lang}"> but it is the ${p.lang === "es" ? "Spanish" : "English"} page`);
    // the words on the page are in the page's language (a copy of the English page with lang="es" fails)
    const words = languageOfText(html);
    if (words.words >= 8) {
      if (p.lang === "es" && !(words.es >= 2 && words.es > 2 * words.en)) bad(`${p.path} is the Spanish page but its text reads as English (${words.es} Spanish vs ${words.en} English common words)`);
      if (p.lang === "en" && !(words.en >= 1 && words.en > 2 * words.es)) bad(`${p.path} is the English page but its text reads as Spanish (${words.en} English vs ${words.es} Spanish common words)`);
    }
    const heads = H.h1s(html).filter((h) => h && !h.includes("${"));
    if (!p.h1 && !heads.length) bad(`${p.path} has no heading (<h1>)`);
    if (p.h1?.client && !/<h1\b/i.test(html)) bad(`${p.path}: no <h1> for the page script to fill (${p.h1.client})`);

    // search-engine signals
    const canonTags = (html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").match(/<link\b[^>]*rel\s*=\s*["']?canonical[^>]*>/gi) || []).length;
    if (canonTags > 1) bad(`${p.path} names ${canonTags} canonical addresses — search engines ignore all of them`);
    const canon = H.canonical(html);
    const robotsMeta = H.metaContent(html, "robots");
    const noindex = /noindex/i.test(robotsMeta);
    const disallowed = ctx.disallows.some((d) => p.path.startsWith(d));
    if (p.kind === "customer") {
      if (!canon) bad(`${p.path} names no canonical address`);
      else if (norm(canon) !== prodUrl(p.path)) bad(`${p.path} names ${short(canon, t)} as its canonical address instead of itself${p.lang === "es" && norm(canon) === prodUrl(enTwinOf(p.path)) ? " (the English page — search engines then drop this Spanish page)" : ""}`);
      if (noindex) bad(`${p.path} is a customer page but tells search engines not to index it (meta robots "${robotsMeta}")`);
      if (disallowed) bad(`${p.path} is a customer page but robots.txt blocks it`);
      if (t.mode === "prod" && /noindex/i.test(String(res.headers?.get?.("x-robots-tag") || ""))) bad(`${p.path} is sent with an X-Robots-Tag noindex header on production`);
      if (!ctx.sitemap.locs.includes(prodUrl(p.path))) bad(`${p.path} is missing from sitemap.xml`);
    } else {
      if (canon && norm(canon) !== prodUrl(p.path)) bad(`${p.path} names ${short(canon, t)} as its canonical address instead of itself`);
      if ((p.kind === "utility" || p.kind === "owner") && !noindex && !disallowed) bad(`${p.path} (${p.kind === "owner" ? "Mark's own page" : "a utility page"}) can be indexed by search engines — no noindex and not blocked in robots.txt`);
    }

    // scripts: none twice; the navbar at the home page's version, with the container it draws into
    const srcs = H.scripts(html);
    for (const d of [...new Set(srcs.filter((s, i) => srcs.indexOf(s) !== i))]) bad(`${p.path} loads ${d.split("?")[0]} twice — its code runs twice (double menus, double listeners, double counts)`);
    const navSrc = srcs.find((s) => /\/components\/navbar\.js/.test(s));
    if (navSrc) {
      const v = navSrc.split("?")[1] || "";
      if (v !== ctx.navVersion) bad(`${p.path} loads navbar.js?${v} but the home page loads ?${ctx.navVersion} — this page keeps an old menu in visitors' browsers`);
      if (!/\bid\s*=\s*["']navbar-container["']/.test(html)) bad(`${p.path} loads the menu script but has no navbar-container for it to draw into — the page shows no menu`);
    }
    hasNav.set(p.path, Boolean(navSrc));

    // collect what the page loads and links to
    const here = res.url;
    const same = (ref) => { const u = H.resolve(ref, here); return u && H.sameSite(u, t.bases.site) ? H.onBase(u, t.bases.site) : null; };
    const mineScripts = [];
    for (const s of srcs) { const u = same(s); if (u) { assets.script.add(u); if (!/\/components\/navbar\.js/.test(u)) mineScripts.push(u); } else { const x = cdnUrl(s, here); if (x) assets.cdn.set(x, "script"); } }
    pageScripts.set(p.path, mineScripts);
    for (const s of H.stylesheets(html)) { const u = same(s); if (u) assets.style.add(u); else { const x = cdnUrl(s, here); if (x) assets.cdn.set(x, "style"); } }
    for (const s of H.images(html)) { const u = same(s); if (u) assets.image.add(u); }
    // hero art and backgrounds written in the page's own CSS, and the picture shown when the page is shared
    for (const s of cssRefs(inlineCss(html))) { const u = same(s); if (u) (IMAGE_EXT.test(new URL(u).pathname) ? assets.image : assets.other).add(u); }
    const og = H.metaContent(html, "og:image");
    if (og) { const u = same(og); if (u) assets.image.add(u); }
    const mine = [];
    for (const a of H.links(html)) {
      // a jump link within this page must land on something (an id/name, or a name its script creates)
      const local = /^#(.+)$/.exec(a);
      if (local) {
        const f = decodeURIComponent(local[1]);
        if (f !== "top" && html.split(f).length - 1 <= (html.match(new RegExp(`href\\s*=\\s*["']#${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "g")) || []).length) {
          bad(`${p.path}: the link to #${f} jumps to nothing — no element on the page is called "${f}"`);
        }
        continue;
      }
      const u = same(a); if (!u) continue;
      const [clean, frag] = u.split("#");
      if (new URL(clean).pathname.startsWith("/api/")) { apiLinksSkipped++; continue; }
      if (frag) fragments.push({ from: p.path, url: clean, frag: decodeURIComponent(frag) });
      if (!mine.includes(clean)) mine.push(clean);
    }
    linksPerPage.push(...spread(mine, 15));
  }

  // 2. twins, hreflang pairs, the menu on both, and the language switch + Spanish-browser redirect (the real navbar, run)
  for (const p of pages) {
    if (!loaded.has(p.path)) continue;
    const { html } = loaded.get(p.path);
    const needsTwin = (p.kind === "customer" || p.kind === "template") && !p.noTwin;
    const twinPath = twinOf(p);
    let twinOk = false;
    let twinHtml = "";
    if (needsTwin || hasNav.get(p.path)) {
      const tr = await get(twinPath);
      twinOk = isRealPage(tr) && H.htmlLang(tr.text).toLowerCase().startsWith(p.lang === "es" ? "en" : "es");
      if (needsTwin && !twinOk) bad(p.lang === "en" ? `${p.path} has no Spanish twin (${twinPath} → HTTP ${tr.status})` : `${p.path} has no English twin (${twinPath} → HTTP ${tr.status})`);
      if (twinOk) { twinHtml = tr.text; if (!loaded.has(twinPath)) loaded.set(twinPath, { html: tr.text, res: tr, outside: true }); }
    }
    if (twinOk && p.lang === "en" && p.kind !== "utility") {
      // both languages have the menu, or neither (a Spanish reader must not lose the menu the English one has)
      const twinNav = H.scripts(twinHtml).some((s) => /\/components\/navbar\.js/.test(s));
      if (twinNav !== hasNav.get(p.path)) bad(`${hasNav.get(p.path) ? twinPath : p.path} has no site menu but ${hasNav.get(p.path) ? p.path : twinPath} does — the ${hasNav.get(p.path) ? "Spanish" : "English"} reader loses the menu and the language link`);
      const tt = H.title(twinHtml);
      if (tt && tt === H.title(html)) bad(`${twinPath} has the same title as ${p.path} ("${tt}") — the Spanish page's title was never translated`);
    }
    if (p.kind === "customer" && twinOk) {
      // hreflang: the page's own tags plus sitemap.xml's alternates (Google reads either)
      const own = Object.fromEntries(Object.entries(H.hreflangs(html)).map(([k, v]) => [String(k).toLowerCase(), norm(v)]));
      const alts = { ...(ctx.sitemap.alts.get(prodUrl(p.path)) || {}), ...own };
      const want = p.lang === "en" ? "es" : "en";
      if (!Object.entries(alts).some(([k, v]) => k.startsWith(want) && v === prodUrl(twinPath))) {
        bad(`${p.path} does not point search engines at its ${want === "es" ? "Spanish" : "English"} twin ${twinPath} (no hreflang="${want}" in the page or in sitemap.xml)`);
      }
      for (const [k, v] of Object.entries(own)) {
        const expect = k.startsWith("es") ? prodUrl(p.lang === "es" ? p.path : twinPath) : (k.startsWith("en") || k === "x-default") ? prodUrl(p.lang === "en" ? p.path : twinPath) : null;
        if (expect && v !== expect) bad(`${p.path} declares hreflang="${k}" → ${short(v, t)}, which is not the ${k.startsWith("es") ? "Spanish" : "English"} page of this pair`);
      }
    }
    if (hasNav.get(p.path)) {
      const visit = p.fetch || p.path;
      const q = p.kind === "template" ? "?e2e=1" : ""; // template pages carry their item in the query string; the switch must keep it
      const r = nav(visit, { search: q });
      const sw = hrefOfClass(r.desktop, "sa-lang-link"); const swm = hrefOfClass(r.mobile, "sa-mobile-lang");
      if (!sw) { bad(`the menu on ${p.path} has no language link`); continue; }
      if (sw !== swm) bad(`on ${p.path} the desktop language link opens ${sw} but the phone menu's opens ${swm}`);
      if (q && !sw.endsWith(q)) bad(`the language link on ${p.path} drops the address's query string (${sw}) — the other language opens without the item the reader was looking at`);
      const to = sw.split("?")[0];
      if (p.lang === "en") {
        const es = nav(visit, { search: q, languages: ["es-MX", "es"] }); // a Spanish-language browser, no choice stored
        const kept = nav(visit, { search: q, languages: ["es-MX", "es"], pref: "en" }); // ...that chose English before
        const redirTo = es.redirect ? es.redirect.split("?")[0] : null;
        if (kept.redirect) bad(`${p.path} redirects a reader who chose English to ${kept.redirect} — the explicit English choice does not stick`);
        if (redirTo && !(twinOk && norm(PROD + redirTo) === prodUrl(twinPath))) bad(`a Spanish-language browser on ${p.path} is sent to ${redirTo}, which is not this page's working Spanish twin`);
        if (p.navbarSwitch === "home") {
          if (to !== "/es/index.html") bad(`the "En Español" link on ${p.path} opens ${to}; it should fall back to the Spanish home page (see the PAGES note)`);
          if (redirTo) bad(`a Spanish-language browser on ${p.path} is redirected to ${redirTo}; it should stay (see the PAGES note)`);
        } else if (twinOk) {
          const switchOk = norm(PROD + to) === prodUrl(twinPath);
          const redirOk = redirTo !== null && norm(PROD + redirTo) === prodUrl(twinPath);
          if (!switchOk || !redirOk) bad(`on ${p.path}${switchOk ? "" : `, the "En Español" link opens ${to} instead of the Spanish twin ${twinPath}`}${redirOk ? "" : `${switchOk ? "" : " and"} Spanish-language browsers are ${redirTo ? `sent to ${redirTo}` : "not sent"} to ${twinPath}`} — add it to ES_PAGES in navbar.js`);
          if (es.redirect && q && !es.redirect.endsWith(q)) bad(`the Spanish-browser redirect on ${p.path} drops the query string (${es.redirect})`);
        }
      } else {
        if (norm(PROD + to) !== prodUrl(twinPath) || !twinOk) bad(`the "English" link on ${p.path} opens ${to}, which is not a working English twin`);
        const es = nav(visit, { search: q, languages: ["es-MX"] });
        if (es.redirect) bad(`the Spanish page ${p.path} redirects to ${es.redirect} — a redirect loop for Spanish readers`);
      }
    }
  }

  // 3. everything the pages load: all scripts, stylesheets and images; links sampled to the budget
  const knownPages = new Set([...loaded.keys()].map((pth) => prodUrl(pth)));
  for (const u of assets.script) {
    const r = await get(u);
    if (r.status !== 200 || !/javascript|ecmascript/i.test(ctype(r)) || /^\s*</.test(r.text)) bad(`script ${short(u, t)} does not load as JavaScript (HTTP ${r.status}, ${ctype(r) || "no type"})`);
  }
  for (const u of [...assets.style]) {
    const r = await get(u);
    if (r.status !== 200 || !/text\/css/i.test(ctype(r))) { bad(`stylesheet ${short(u, t)} does not load (HTTP ${r.status}, ${ctype(r) || "no type"})`); continue; }
    // what the stylesheet itself pulls in (backgrounds, card art, @import), resolved against the stylesheet
    for (const ref of cssRefs(r.text)) {
      const x = H.resolve(ref, r.url); if (!x || !H.sameSite(x, t.bases.site)) continue;
      const v = H.onBase(x, t.bases.site);
      if (/\.css$/i.test(new URL(v).pathname)) { if (!assets.style.has(v)) { assets.style.add(v); const c = await get(v); if (c.status !== 200 || !/text\/css/i.test(ctype(c))) bad(`stylesheet ${short(v, t)} (imported by ${short(u, t)}) does not load (HTTP ${c.status})`); } }
      else (IMAGE_EXT.test(new URL(v).pathname) ? assets.image : assets.other).add(v);
    }
  }
  for (const u of assets.image) {
    const r = await get(u);
    if (r.status !== 200 || !/^image\//i.test(ctype(r)) || !r.text.length) bad(`image ${short(u, t)} does not load (HTTP ${r.status}, ${ctype(r) || "no type"})`);
  }
  for (const u of assets.other) {
    const r = await get(u);
    if (r.status !== 200 || /text\/html/i.test(ctype(r))) bad(`file ${short(u, t)} used by the page styles does not load (HTTP ${r.status}, ${ctype(r) || "no type"})`);
  }
  // the map library, the icon font (the phone menu button is an icon) and the web fonts come from public
  // CDNs: a wrong version or address breaks the page while every same-site file is fine. Plain static
  // files — no side effects, no cost.
  for (const [u, kind] of assets.cdn) {
    const r = await get(u);
    const okType = kind === "script" ? /javascript|ecmascript/i.test(ctype(r)) : /text\/css/i.test(ctype(r));
    if (r.status !== 200 || !okType) bad(`${kind === "script" ? "script" : "stylesheet"} ${u} from a public CDN does not load (HTTP ${r.status}, ${ctype(r) || "no type"})`);
  }

  // 4. the page still calls its data: the endpoints it needs, and the same ones in both languages
  const callsOf = (path) => {
    const own = H.apiMentions(loaded.get(path).html);
    for (const s of pageScripts.get(path) || []) { const r = cache.get(s); if (r && r.status === 200) own.push(...H.apiMentions(r.text)); }
    return [...new Set(own)].sort();
  };
  const groupPaths = new Set(pages.map((p) => p.path));
  for (const p of pages) {
    if (!loaded.has(p.path) || p.kind === "verification") continue;
    const calls = callsOf(p.path);
    t.observe(`endpoints called by ${p.path}`, calls.join(" "));
    const missing = apisFor(p).filter((need) => !calls.some((c) => c === need || c.startsWith(need)));
    if (missing.length) bad(`${p.path} no longer calls ${missing.join(", ")} — the part of the page filled from ${missing.length === 1 ? "it" : "them"} stays empty`);
    if (p.lang === "en" && groupPaths.has(esTwinOf(p.path)) && loaded.has(esTwinOf(p.path))) {
      const esCalls = callsOf(esTwinOf(p.path));
      const onlyEn = calls.filter((c) => !esCalls.includes(c)); const onlyEs = esCalls.filter((c) => !calls.includes(c));
      if (onlyEn.length || onlyEs.length) bad(`${p.path} and ${esTwinOf(p.path)} load different data${onlyEn.length ? ` — only the English page calls ${onlyEn.join(", ")}` : ""}${onlyEs.length ? ` — only the Spanish page calls ${onlyEs.join(", ")}` : ""}`);
    }
  }

  const links = [...new Set(linksPerPage)].filter((u) => !knownPages.has(norm(u)) || /\?/.test(u));
  const room = Math.max(6, MAX_REQUESTS - t.requests);
  const followed = spread(links, room);
  for (const u of followed) {
    const r = await get(u);
    const path = new URL(u).pathname;
    const wantsPage = /\.html?$|\/$/.test(path);
    if (r.status !== 200) bad(`link ${short(u, t)} is broken (HTTP ${r.status})`);
    else if (wantsPage && !isRealPage(r)) bad(`link ${short(u, t)} does not open a real page (${r.text.length} bytes)`);
  }
  // jump links into another page ("…/work-with-mark.html#contact"): checked when that page was opened above
  let fragmentsChecked = 0;
  for (const f of fragments) {
    const target = cache.get(f.url) || [...loaded.values()].find((v) => norm(v.res.url) === norm(f.url))?.res;
    if (!target || !isRealPage(target)) continue;
    fragmentsChecked++;
    if (!target.text.includes(f.frag)) bad(`${f.from} links to ${short(f.url, t)}#${f.frag}, but that page has nothing called "${f.frag}" — the link opens the top of the page instead`);
  }

  t.observe(`${label}: navbar version`, ctx.navVersion);
  t.observe(`${label}: links followed`, followed.length, "info");
  t.observe(`${label}: links not followed (request budget)`, links.length - followed.length, "info");
  t.observe(`${label}: /api/ links not followed (may have side effects)`, apiLinksSkipped, "info");
  t.observe(`${label}: jump links into other pages checked`, fragmentsChecked, "info");
  t.observe(`${label}: images checked`, assets.image.size, "min");
  t.observe(`${label}: files from public CDNs checked`, [...assets.cdn.keys()].map((u) => new URL(u).host + new URL(u).pathname).sort().join(" "));
  t.ok(problems.length === 0, `${problems.length} problem${problems.length === 1 ? "" : "s"} on ${label}: ${problems.join(" | ")}`);
  // after the problem list, so a group whose pages all failed reports why
  t.atLeast(loaded.size, 1, `${label}: pages that opened`);
  t.atLeast(assets.script.size + assets.style.size, 1, `${label}: scripts and stylesheets found`);
}

const crawlCheck = (id, label, title, paths, extra = {}) => ({
  id: `pages.crawl-${id}`,
  title,
  covers: [...paths.map((p) => `page ${p}`), "flow:language-switch", "flow:spanish-twins", "flow:search-signals", ...(extra.covers || [])],
  modes: ["dev", "prod"],
  ...extra.meta,
  run: (t) => crawl(t, paths, { label }),
});

export default [
  crawlCheck("home", "the home pages",
    "The English and Spanish home pages open with their pictures, scripts and links working, and point search engines at each other",
    ["/index.html", "/es/index.html"],
    { covers: ["ext:file /components/navbar.js", "ext:file /css/styles.css"] }),
  crawlCheck("advisor-and-signup", "the Work-with-Mark and sign-up pages",
    "Work with Mark, Subscribe and the sign-up confirmation pages open correctly in English and Spanish, and the confirmation pages stay out of search results",
    ["/work-with-mark.html", "/es/work-with-mark.html", "/subscribe.html", "/es/subscribe.html", "/subscribe-pending.html", "/subscribe-verified.html", "/es/subscribe-verified.html", "/unsubscribe-confirmed.html"]),
  crawlCheck("gear-hub", "the gear hub and first gear categories",
    "The Cruising Gear page and its first categories open in English and Spanish, with every picture and link working and each Spanish page named as its own address",
    ["/affiliate.html", "/es/affiliate.html", "/affiliate/air-travel.html", "/es/affiliate/air-travel.html", "/affiliate/cabin-essentials.html", "/es/affiliate/cabin-essentials.html"],
    { covers: ["ext:file /components/affiliate-page.js"] }),
  crawlCheck("gear-categories", "the remaining gear categories",
    "The clothing, fun, great-ideas and health-at-sea gear pages open in English and Spanish with a heading, and search engines can find each language",
    ["/affiliate/clothing.html", "/es/affiliate/clothing.html", "/affiliate/cruise-fun.html", "/es/affiliate/cruise-fun.html", "/affiliate/great-ideas.html", "/es/affiliate/great-ideas.html", "/affiliate/health-at-sea.html", "/es/affiliate/health-at-sea.html"]),
  crawlCheck("weather-cams-favorites", "the weather, forecast, live-cam and favorites pages",
    "The weather, forecast, live cams and Mark's Favorites pages open with everything on them working, and each has a Spanish version",
    ["/weather.html", "/es/weather.html", "/forecast.html", "/webcams.html", "/es/webcams.html", "/favorites.html"]),
  crawlCheck("ships-and-storms", "the ship tracker and Storm Watch pages",
    "Where's My Ship, Track Your Ship and Storm Watch open in English and Spanish with their scripts and links working",
    ["/wheres-my-ship.html", "/es/wheres-my-ship.html", "/track-ship.html", "/es/track-ship.html", "/storm-watch.html", "/es/storm-watch.html"]),
  crawlCheck("cabins", "the Room Concierge and cabin pages",
    "Room Concierge and the cabin request pages open in English and Spanish, and every cabin page has a Spanish version",
    ["/room-concierge.html", "/es/room-concierge.html", "/cabin-request.html", "/es/cabin-request.html", "/cabin-finder.html"]),
  crawlCheck("commentary-and-stories", "the commentary and story pages",
    "Commentary, a commentary post and a news story page open in English and Spanish, and the translating spinner stays out of search results",
    ["/commentary.html", "/es/commentary.html", "/commentary-post.html", "/es/commentary-post.html", "/story.html", "/es/story.html", "/es/translate-loading.html"]),
  crawlCheck("policies-and-owner", "the policy, placeholder and owner pages",
    "Privacy and Terms open in English and Spanish, Mark's review page and the placeholder stay out of search, and the Search Console ownership file is in place",
    ["/privacy.html", "/es/privacy.html", "/terms.html", "/es/terms.html", "/under-construction.html", "/editorial-queue.html", "/google6dc6f027af183f2e.html"]),
  // Group cruise pages are NEW in this release (server/src/routes/group-marketing.ts). On prod they
  // do not exist until the 2026-10-08 promotion, so this check FAILS on prod until then — correct.
  crawlCheck("group-cruise", "the group cruise pages",
    "The group cruise page opens in English and Spanish and stays out of search results (it is shared by private link)",
    ["/group.html", "/es/group.html"]),

  {
    id: "pages.sitemap",
    title: "Every address in sitemap.xml opens a real page that names itself as the address search engines should use",
    covers: ["ext:file /sitemap.xml", "flow:search-signals"],
    modes: ["dev", "prod"],
    incident: "search collapse, September 2026: sitemap entries that do not resolve, or resolve to a page naming another address, waste the crawl",
    run: async (t) => {
      const { get } = fetcher(t);
      const sm = await get("/sitemap.xml");
      t.status(sm, 200);
      t.ok(/xml/i.test(ctype(sm)) && /<urlset\b/.test(sm.text), `sitemap.xml is not an XML sitemap (${ctype(sm)}, ${sm.text.length} bytes)`);
      const { locs, alts } = readSitemap(sm.text);
      t.atLeast(locs.length, 25, "addresses in sitemap.xml");
      t.equal(new Set(locs).size, locs.length, "sitemap.xml lists an address twice — number of unique addresses vs listed");
      const problems = [];
      for (const m of sm.text.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)) {
        const d = Date.parse(m[1]);
        if (!Number.isFinite(d) || d > t.now() + 86_400_000) problems.push(`lastmod "${m[1]}" is not a real past date`);
      }
      // every address in the sitemap is listed here once (30 today) — a sitemap is small by design
      for (const loc of locs) {
        if (!loc.startsWith(`${PROD}/`)) { problems.push(`${loc} is not on ${PROD}`); continue; }
        const r = await get(loc);
        const path = new URL(loc).pathname;
        if (!isRealPage(r)) { problems.push(`${path} → ${r.describe()} (${r.text.length} bytes)`); continue; }
        const canon = H.canonical(r.text);
        if (norm(canon) !== loc) problems.push(`${path} names ${canon ? short(canon, t) : "no address"} as its canonical, not itself`);
        if (/noindex/i.test(H.metaContent(r.text, "robots"))) problems.push(`${path} is in the sitemap but tells search engines not to index it`);
        const lang = H.htmlLang(r.text).toLowerCase();
        if (!lang.startsWith(path.startsWith("/es/") ? "es" : "en")) problems.push(`${path} says lang="${lang}"`);
        // two views of the same pair must agree: the page's own hreflang tags and the sitemap's alternates
        for (const [hl, href] of Object.entries(H.hreflangs(r.text))) {
          const k = String(hl).toLowerCase(); const mine = (alts.get(loc) || {})[k];
          if (mine && norm(href) !== mine) problems.push(`${path} says its ${k} version is ${short(href, t)} but sitemap.xml says ${short(mine, t)}`);
        }
        if (/^\s*$/.test(H.title(r.text))) problems.push(`${path} has no <title>`);
        for (const [hl, href] of Object.entries(alts.get(loc) || {})) {
          if (hl === "x-default") continue;
          if (!locs.includes(href)) problems.push(`${path} lists a ${hl} alternate ${short(href, t)} that is not itself in the sitemap`);
          else if (href !== loc && !Object.values(alts.get(href) || {}).includes(loc)) problems.push(`${path} → ${short(href, t)} (${hl}) is not reciprocal: ${short(href, t)} does not list ${path} back`);
        }
      }
      t.observe("sitemap.xml addresses", locs.length, "min");
      t.observe("sitemap.xml address list", locs.map((l) => l.replace(PROD, "")).sort().join(" "));
      t.ok(problems.length === 0, `${problems.length} problem(s) in sitemap.xml: ${problems.join(" | ")}`);
    },
  },

  {
    id: "pages.robots",
    title: "robots.txt lets search engines in on production, points at sitemaps that exist, and the dev mirror stays out of search",
    covers: ["ext:file /robots.txt", "flow:dev-not-indexable"],
    modes: ["dev", "prod"],
    incident: "2026-09-29: foreign domains served the dev mirror to the public web; a robots.txt that blocks everything on prod would empty search results",
    run: async (t) => {
      const problems = [];
      if (t.mode === "dev") {
        // the dev box: nginx's own robots.txt blocks everything and every answer carries noindex
        const r = await t.get("/robots.txt");
        t.status(r, 200);
        t.ok(/^\s*disallow\s*:\s*\/\s*$/im.test(r.text) && /user-agent\s*:\s*\*/i.test(r.text), "the dev mirror's robots.txt does not block every crawler — dev could be indexed as a copy of the site");
        const home = await t.get("/");
        t.html(home);
        t.ok(/noindex/i.test(String(home.headers.get("x-robots-tag") || "")), "the dev mirror's pages are not sent with X-Robots-Tag: noindex");
      } else {
        const home = await t.get("/");
        t.html(home);
        t.ok(!/noindex/i.test(String(home.headers.get("x-robots-tag") || "")), "production pages are sent with X-Robots-Tag: noindex — the whole site would drop out of search");
      }
      // the robots.txt that ships to production
      const rb = await t.get(shippingRobotsUrl(t));
      t.status(rb, 200);
      t.ok(/text\/plain/i.test(ctype(rb)), `robots.txt is not plain text (${ctype(rb)})`);
      t.ok(/^\s*user-agent\s*:\s*\*\s*$/im.test(rb.text), "robots.txt has no rules for all crawlers (User-agent: *)");
      const dis = disallowsOf(rb.text);
      t.ok(!dis.includes("/"), "the production robots.txt blocks the whole site (Disallow: /)");
      for (const d of dis) {
        const p = BY_PATH.get(d);
        if (p && p.kind === "customer") problems.push(`robots.txt blocks ${d}, a customer page`);
      }
      const maps = [...rb.text.matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)].map((m) => m[1]);
      t.atLeast(maps.length, 3, "sitemaps named in robots.txt");
      for (const m of maps) {
        if (!m.startsWith(`${PROD}/`)) { problems.push(`robots.txt names a sitemap off the production host: ${m}`); continue; }
        const r = await t.get(H.onBase(m, t.bases.site));
        const n = (r.text.match(/<loc>/g) || []).length;
        if (r.status !== 200 || !/<(urlset|sitemapindex)\b/.test(r.text) || n === 0) problems.push(`${m.replace(PROD, "")} → ${r.describe()} with ${n} addresses`);
        t.observe(`addresses in ${m.replace(PROD, "")}`, n, "min");
      }
      t.observe("robots.txt sitemaps", maps.map((m) => m.replace(PROD, "")).sort().join(" "));
      t.observe("robots.txt disallows", dis.slice().sort().join(" "));
      t.ok(problems.length === 0, `${problems.length} problem(s): ${problems.join(" | ")}`);
    },
  },

  {
    id: "pages.llms-txt",
    title: "llms.txt (the map AI assistants read) lists Work with Mark first, then the same guides and news hubs the site publishes, and its links open real pages",
    covers: ["ext:file /llms.txt", "data:guides-sitemap", "ext:file /news-sitemap.xml"],
    modes: ["dev", "prod"],
    incident: "2026-09-29 AI-visibility program: llms.txt is generated hourly (lib/llms-txt.ts) and is not in git; if the generator breaks, assistants learn nothing about the site",
    run: async (t) => {
      const { get } = fetcher(t);
      const r = await get("/llms.txt");
      t.status(r, 200);
      t.ok(/text\/plain/i.test(ctype(r)), `llms.txt is not plain text (${ctype(r)})`);
      t.ok(/^# Still Afloat Cruising\s*$/m.test(r.text.split("\n")[0]), `llms.txt does not start with "# Still Afloat Cruising"`);
      const heads = [...r.text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
      t.equal(heads[0], "Work with Mark", "the first section of llms.txt (assistants weight what comes first)");
      for (const need of ["Guides", "Cruise line news hubs", "Tools", "Policies"]) t.ok(heads.includes(need), `llms.txt has no "${need}" section`);
      t.observe("llms.txt sections", heads.join(" · "));
      // links per section, so the sample reaches every section
      const sections = r.text.split(/^## /m).slice(1).map((s) => ({ name: s.split("\n")[0].trim(), links: [...s.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]) }));
      const all = sections.flatMap((s) => s.links);
      t.atLeast(all.length, 30, "links in llms.txt");
      const guides = sections.find((s) => s.name === "Guides")?.links || [];
      t.atLeast(guides.length, 4, "guide links in llms.txt");
      const problems = all.filter((u) => !u.startsWith(`${PROD}/`)).map((u) => `link off the production host: ${u}`);
      // sample: the first and last link of each section (≤ 16 requests)
      const sample = [...new Set(sections.flatMap((s) => [s.links[0], s.links[s.links.length - 1]]).filter(Boolean).map((u) => u.split("#")[0]))];
      for (const u of sample) {
        const res = await get(u);
        const path = new URL(u).pathname;
        if (!isRealPage(res)) { problems.push(`${path} → ${res.describe()}`); continue; }
        const canon = H.canonical(res.text);
        if (canon && norm(canon) !== norm(u)) problems.push(`${path} names ${short(canon, t)} as its canonical, not the address llms.txt gives`);
        const lang = H.htmlLang(res.text).toLowerCase();
        if (!lang.startsWith(path.startsWith("/es/") ? "es" : "en")) problems.push(`${path} says lang="${lang}"`);
      }
      // one system: llms.txt is rebuilt from the same data as the guides sitemap and the news hub pages.
      // If the hourly rebuild stops (or skips a section), assistants are told about guides that are gone
      // or never hear of new ones. The guides section must list exactly the guides sitemap's pages, and
      // the news-hub section exactly the hub pages in the news sitemap (story pages end in a 6-hex id).
      // A guide published in the minute between the two writes could differ once; a rerun clears it.
      const gs = await get("/guides-sitemap.xml");
      t.status(gs, 200);
      const guideLocs = readSitemap(gs.text).locs;
      t.atLeast(guideLocs.length, 4, "pages in the guides sitemap");
      const guideSet = new Set(guides.map(norm));
      for (const l of guideLocs) if (!guideSet.has(l)) problems.push(`the guides sitemap lists ${l.replace(PROD, "")} but llms.txt does not`);
      for (const l of guideSet) if (!guideLocs.includes(l)) problems.push(`llms.txt lists the guide ${l.replace(PROD, "")} but the guides sitemap does not`);
      const hubs = (sections.find((s) => s.name === "Cruise line news hubs")?.links || []).map(norm);
      t.atLeast(hubs.length, 4, "news hub links in llms.txt");
      const ns = await get("/news-sitemap.xml");
      t.status(ns, 200);
      const hubLocs = readSitemap(ns.text).locs.filter((l) => /\/news\/[a-z0-9-]+\.html$/.test(l) && !/-[0-9a-f]{6}\.html$/.test(l));
      t.atLeast(hubLocs.length, 4, "news hub pages in the news sitemap");
      for (const l of hubLocs) if (!hubs.includes(l)) problems.push(`the news sitemap lists the hub ${l.replace(PROD, "")} but llms.txt does not`);
      for (const l of hubs) if (!hubLocs.includes(l)) problems.push(`llms.txt lists the hub ${l.replace(PROD, "")} but the news sitemap does not`);
      // jump links llms.txt gives ("…/work-with-mark.html#contact") must land on the section they name
      for (const u of all.filter((x) => x.includes("#"))) {
        const [page, frag] = u.split("#");
        const res = await get(page);
        if (isRealPage(res) && !new RegExp(`\\b(id|name)\\s*=\\s*["']${frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(res.text)) problems.push(`llms.txt sends assistants to ${u.replace(PROD, "")}, but that page has no "${frag}" section`);
      }
      t.observe("llms.txt links", all.length, "min");
      t.observe("llms.txt guide links", guides.length, "min");
      t.observe("llms.txt news hub links", hubs.length, "min");
      t.ok(problems.length === 0, `${problems.length} problem(s) in llms.txt: ${problems.join(" | ")}`);
    },
  },

  {
    id: "pages.navbar-menu",
    title: "Every link in the site menu opens a real page in the menu's language, in English and in Spanish, on computers and phones",
    covers: ["ext:file /components/navbar.js", "flow:language-switch"],
    modes: ["dev", "prod"],
    incident: "2026-09-15: pages missing from the navbar's ES_PAGES list sent Spanish readers to the Spanish home page; 2026-09-05: the home-only pills showed on every page because isHome matched everything",
    run: async (t) => {
      // The menu is drawn by navbar.js, so a page crawl never sees its links: the SERVED script is run
      // (renderNavbar) for an English and a Spanish inner page and for both home pages, and what it
      // draws is what is checked. About 30 requests: each distinct menu address once, plus ES_PAGES.
      const { get } = fetcher(t);
      const home = await get("/");
      t.html(home);
      const src = H.scripts(home.text).find((s) => /\/components\/navbar\.js/.test(s));
      t.ok(Boolean(src), "the home page does not load components/navbar.js");
      const nav = await get(H.resolve(src, home.url));
      t.status(nav, 200);
      t.ok(/javascript/i.test(ctype(nav)) && !/^\s*</.test(nav.text), `navbar.js is not served as JavaScript (${ctype(nav)})`);
      const run = (pathname, opts) => { try { return renderNavbar(nav.text, pathname, opts); } catch (e) { t.ok(false, `the served navbar.js throws on ${pathname}: ${String(e?.message || e).slice(0, 120)}`); return null; } };
      const problems = [];
      const menus = {};
      for (const [lang, inner, homePath] of [["en", "/weather.html", "/"], ["es", "/es/weather.html", "/es/"]]) {
        const word = lang === "es" ? "Spanish" : "English";
        const r = run(inner);
        const desk = menuLinks(r.desktop); const mob = menuLinks(r.mobile);
        t.atLeast(desk.length, 9, `links in the ${word} desktop menu`);
        // the phone menu is the same menu: the same addresses, nothing missing and nothing extra
        const onlyDesk = desk.filter((h) => !mob.includes(h)); const onlyMob = mob.filter((h) => !desk.includes(h));
        if (onlyDesk.length || onlyMob.length) problems.push(`the ${word} phone menu and desktop menu differ${onlyDesk.length ? ` — only on the desktop: ${onlyDesk.join(", ")}` : ""}${onlyMob.length ? ` — only on phones: ${onlyMob.join(", ")}` : ""}`);
        // home: the quick pills (Room Concierge, Gear) appear there and only there
        const h = run(homePath);
        const pills = (h.desktop.match(/<a\b[^>]*class\s*=\s*["'][^"']*\bsa-quick-pill\b[^>]*>/gi) || []).map((a) => /\bhref\s*=\s*["']([^"']*)["']/i.exec(a)?.[1]).filter(Boolean);
        if (pills.length < 2) problems.push(`the ${word} home page shows ${pills.length} quick pills (Room Concierge and Gear expected)`);
        if (/\bsa-quick-pill\b/.test(r.desktop)) problems.push(`the ${word} quick pills show on ${inner} — they belong on the home page only (2026-09-05)`);
        menus[lang] = [...new Set([...desk, ...mob, ...pills])];
      }
      t.equal(menuLinks(run("/es/weather.html").desktop).length, menuLinks(run("/weather.html").desktop).length, "the Spanish and English desktop menus have the same number of links");
      for (const lang of ["en", "es"]) {
        for (const href of menus[lang]) {
          const r = await get(href);
          if (!isRealPage(r)) { problems.push(`${lang === "es" ? "Spanish" : "English"} menu link ${href} → ${r.describe()}`); continue; }
          const pl = H.htmlLang(r.text).toLowerCase();
          if (!pl.startsWith(lang)) problems.push(`the ${lang === "es" ? "Spanish" : "English"} menu sends readers to ${href}, which is ${pl.startsWith("es") ? "a Spanish" : "an English"} page`);
        }
      }
      // ES_PAGES drives the "En Español" link and the Spanish-browser redirect: for every page named in it,
      // a Spanish-language browser on the English page is sent to /es/<page>, and that opens as a Spanish page
      const esPages = readEsPages(nav.text);
      t.ok(esPages && esPages.size >= 5, "could not read ES_PAGES from navbar.js");
      // entries are root-relative English paths since 2026-10-08 (bare filenames before: the gear category
      // pages live in /affiliate/, which a filename cannot say); the twin is /es + the same path
      for (const f of esPages) {
        const en = f.startsWith("/") ? f : `/${f}`;
        const es = `/es${en}`;
        const r = run(en, { languages: ["es-MX", "es"] });
        const sw = hrefOfClass(run(en).desktop, "sa-lang-link");
        if (r.redirect !== es) problems.push(`a Spanish-language browser on ${en} is sent to ${r.redirect || "nowhere"}, not ${es}`);
        if (sw !== es) problems.push(`the "En Español" link on ${en} opens ${sw || "nothing"}, not ${es}`);
        const p = await get(es);
        if (!isRealPage(p) || !H.htmlLang(p.text).toLowerCase().startsWith("es")) problems.push(`navbar.js sends Spanish readers to ${es}, which does not open as a Spanish page (HTTP ${p.status})`);
      }
      t.observe("navbar version", (src.split("?")[1] || ""));
      t.observe("English menu", menus.en.join(" "));
      t.observe("Spanish menu", menus.es.join(" "));
      t.observe("pages with a Spanish twin (ES_PAGES)", [...esPages].sort().join(" "));
      t.ok(problems.length === 0, `${problems.length} problem(s) in the site menu: ${problems.join(" | ")}`);
    },
  },

  {
    id: "pages.missing-page-404",
    title: "An address that does not exist answers 'not found' instead of quietly showing the home page, for pages, files and the site's data addresses",
    covers: ["flow:missing-page-404"],
    modes: ["dev", "prod"],
    incident: "server/src/app.ts serves index.html for ANY unknown address that reaches the app (since 2026-05-18); behind nginx a missing page must be a real 404, or broken links look fine and search engines index copies of the home page. Unknown /api/ addresses reach the app: a page calling a renamed or removed endpoint gets the home page with HTTP 200 instead of an error, so the failure is invisible to monitoring and to the page's own error handling",
    run: async (t) => {
      // positive control first: the home page itself is real (so a site answering 404 to everything fails)
      const home = t.html(await t.get("/"), { mustContain: ["Still Afloat"] });
      t.atLeast(H.title(home).length, 5, "the home page title length");
      // /api/no-such-e2e matches no route (checked against server/src/routes on 2026-10-07: no router has a
      // root-level "/:param" route), so no handler runs — safe on prod
      const problems = [];
      for (const p of ["/no-such-page-e2e.html", "/es/no-such-page-e2e.html", "/affiliate/no-such-page-e2e.html", "/assets/images/no-such-image-e2e.png", "/components/no-such-script-e2e.js", "/api/no-such-endpoint-e2e"]) {
        const r = await t.get(p);
        if (r.status !== 404) problems.push(`${p} answered HTTP ${r.status} instead of 404${r.status === 200 && H.title(r.text) === H.title(home) ? " — the home page is served for an address that does not exist" : ""}`);
      }
      t.ok(problems.length === 0, `${problems.length} address(es) that do not exist did not answer 'not found': ${problems.join(" | ")}`);
    },
  },
];
