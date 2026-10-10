// e2e/checks/audience.mjs — sign-up, confirmation, unsubscribe, contact, push, health, the
// static customer pages, and the emails the site sends to its audience.
//
// Incidents and risks these checks exist for:
//   2026-10-01/02  Bots signed strangers up through POST /api/subscribe (21 on Oct 1, 28 on Oct 2)
//                  and every sign-up emailed them from Mark's own mailbox. Turnstile was added to the
//                  sign-up the same day. A Turnstile that is configured on one box and not the other,
//                  or a form that stops sending the token, silently re-opens that hole or silently
//                  blocks every real visitor — so the key, every form that needs it, and the server's
//                  refusal are checked together.
//   2026-09-15     Unsubscribe links were signed with a default written in the public repo: anyone
//                  could unsubscribe anyone. The newsletter preview's link is checked against that
//                  public default on every run.
//   2026-08-26     Web push had zero devices for five days and nothing noticed. The push key and the
//                  device registration path are exercised; the device count itself needs the canary
//                  token (see the gap list in coverage/audience.json).
//   ES first-class Spanish subscribers must land on Spanish pages; a missing twin is a bug.
//
// SAFETY (read before adding a request here):
//   • Prod is GET-only, and these GETs are never made on prod: /api/verify-email, /api/unsubscribe
//     (both act on a link), /api/go/* (records an affiliate click). Their links are checked by FORM.
//   • No check ever completes a sign-up, a contact submission, a resend, a push, or a newsletter send:
//     the dev box sends real email. Only refusal paths are exercised, in an order where every
//     refusal happens BEFORE the handler could save or send anything (read each handler first).
//   • The token-less sign-up probe uses an address that is ALREADY a confirmed subscriber, so even if
//     Turnstile were off the handler stops at "already subscribed" — nothing saved, nothing sent.
//     The token-less CONTACT request is only made after that probe proved Turnstile is enforced.
//   • The one dev write (a push subscription) is a fixture endpoint on a .invalid host, removed in
//     `finally`, and removed again at the start of the next run if a run ever died half-way.
//   • No personal data is recorded: subscriber counts only, never an address or a name.
//
// RATE LIMITS: /api/subscribe, /api/contact and /api/resend-verification allow 5 attempts per hour
// per "client address", and the server takes that address from the X-Forwarded-For header, which
// nginx passes through from the visitor unchanged (see site_problems: every real visitor shares the
// address 127.0.0.1, and a bot can pick any address it likes). Each refusal request below carries
// its own documentation-range address (192.0.2.x, RFC 5737) so the gate never uses up the bucket
// real visitors share. If the server is fixed to use the real address, these requests will share
// the box's own bucket: a 429 then reports UNTESTABLE (re-run after an hour), never a pass.
//
// SAFE BY CONSTRUCTION (adversarial review, 2026-10-08): every refusal probe is built so that if
// the refusal it tests were deleted from the handler, a LATER refusal in the same handler still
// stops the request before anything is saved or sent. The dev box runs with Turnstile OFF, so a
// probe whose only safety was "Turnstile will refuse it" would really go through there:
//   • sign-up probes always carry an invalid address unless the address is what is being tested;
//   • contact probes leave the travel dates blank unless the dates are what is being tested, and
//     always send 2.5 travellers — it passes the 1–20 check, but prospects.num_travelers is an
//     integer column on both databases (checked 2026-10-08), so the insert fails before either
//     email is sent even if every check in front of it were gone.
//
// REDIRECTS: the harness follows redirects and does not expose where it landed. The confirm and
// unsubscribe links are the one place where WHERE a redirect goes is the whole answer (a forged
// unsubscribe link and a real one land on the same static page; only ?result= differs), so
// noFollow() below reads the Location header itself, through the same recorded transport.
import crypto from "node:crypto";
import { keysOf, Res, redactUrl } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

const PROD_HOST = "https://stillafloatcruising.com";
const FIXTURE = "e2e-fixture";
const fixtureEmail = () => `${FIXTURE}+${Date.now().toString(36)}@release-gate.invalid`;
const PUSH_FIXTURE = {
  endpoint: "https://e2e-fixture.invalid/saf-release-gate/push-device",
  keys: { p256dh: "BE2E-fixture-not-a-real-key-saf-release-gate", auth: "e2e-fixture-auth" },
};

let xffSeq = Math.floor(Math.random() * 250);
const testNetAddr = () => `192.0.2.${1 + (xffSeq++ % 254)}`;

/** A refused form submission from its own documentation-range address (see RATE LIMITS above). */
async function post(t, path, body, { auth = false, method = "POST" } = {}) {
  return t.send(method, path, { body, auth, headers: { "x-forwarded-for": testNetAddr() } });
}

/** The request was refused with `status` and an error message matching `re`. */
function refused(t, res, status, re, what) {
  if (res.status === 429 && status !== 429) {
    t.require(false, `${what}: the gate's own request was rate-limited (HTTP 429), so this refusal could not be tested — re-run after an hour`);
  }
  t.ok(res.status === status, `${what}: expected HTTP ${status}, got ${res.describe()}`);
  t.ok(res.json && typeof res.json === "object", `${what}: the refusal is not JSON: ${res.describe()}`);
  const msg = String(res.json.error ?? "");
  t.ok(re.test(msg), `${what}: expected a message like ${re}, got ${res.describe()}`);
  return msg;
}

/** GET without following a redirect (see REDIRECTS above). Same transport, so it is recorded and faked. */
async function noFollow(t, path) {
  const url = t.url(path);
  t.requests++;
  let r;
  try {
    r = await t.fetchImpl(url, { method: "GET", headers: { "user-agent": "saf-e2e/1 (whole-site release gate)" }, redirect: "manual", signal: AbortSignal.timeout(t.timeoutMs) });
  } catch (e) {
    t.ok(false, `GET ${redactUrl(url)} did not answer (${String(e?.message || e).slice(0, 100)})`);
  }
  const text = await r.text().catch(() => "");
  return new Res({ url, status: r.status, headers: r.headers, text, ms: 0 });
}

/** The response is a redirect; returns where it points (a URL object). */
function redirectTo(t, res, what) {
  t.ok(res.status >= 301 && res.status <= 308, `${what}: expected a redirect, got ${res.describe()}`);
  const loc = (res.headers && res.headers.get && res.headers.get("location")) || "";
  t.ok(loc.length > 0, `${what}: the redirect has no destination`);
  return new URL(loc, res.url);
}

const TODAY = () => new Date().toISOString().slice(0, 10);
const YESTERDAY = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
/** lib/push-health.ts raises this action, one per UTC day, whenever no device can receive a push. */
const pushEmptyRefs = () => [`push-channel-empty-${TODAY()}`, `push-channel-empty-${YESTERDAY()}`];

const SPANISH = /[áéíóúñ¿¡]| (el|la|los|las|que|con|para|por|una?|tu|su) /i;
const legacyUnsubSig = (email) => crypto.createHmac("sha256", "still-afloat-unsub-v1").update(email.toLowerCase()).digest("hex").slice(0, 24);
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ""; } };

/** The customer pages this area owns, with what each must carry. */
const PAGES = [
  // The sign-up page sends the visitor on to the "check your inbox" page; the pending page reads
  // the address from ?email= and offers the resend button; the landing pages must handle every
  // ?result= the server sends them to (routes/subscribe.ts: verify-email → already|invalid|error|
  // success; unsubscribe → invalid|error|success).
  { path: "/subscribe.html", lang: "en", title: /subscribe/i, minText: 300, must: ["/api/subscribe", "cf-turnstile-response", "/api/public-config", "/subscribe-pending.html"] },
  { path: "/es/subscribe.html", lang: "es", title: /suscr/i, minText: 300, must: ["/api/subscribe", "cf-turnstile-response", "lang: 'es'", "/api/public-config"] },
  { path: "/subscribe-pending.html", lang: "en", title: /inbox/i, minText: 150, must: ["/api/resend-verification", /get\(\s*['"]email['"]\s*\)/] },
  { path: "/subscribe-verified.html", lang: "en", title: /you.re in/i, minText: 150, must: ["errorCard", /['"]already['"]/, /['"]invalid['"]/] },
  { path: "/es/subscribe-verified.html", lang: "es", title: /dentro/i, minText: 150, must: ["errorCard", /['"]already['"]/, /['"]invalid['"]/] },
  { path: "/unsubscribe-confirmed.html", lang: "en", title: /unsubscribed/i, minText: 80, must: [/['"]invalid['"]/, /['"]success['"]/] },
  { path: "/work-with-mark.html", lang: "en", title: /advisor/i, minText: 1500, must: ["/api/contact", "cf-turnstile-response"] },
  { path: "/es/work-with-mark.html", lang: "es", title: /asesor/i, minText: 1500, must: ["/api/contact", "cf-turnstile-response"] },
  { path: "/privacy.html", lang: "en", title: /privacy/i, minText: 1500 },
  { path: "/es/privacy.html", lang: "es", title: /privacidad/i, minText: 1500 },
  { path: "/terms.html", lang: "en", title: /terms/i, minText: 1200 },
  { path: "/es/terms.html", lang: "es", title: /términos/i, minText: 1200 },
  { path: "/under-construction.html", lang: "en", title: /coming soon/i, minText: 40 },
];

export default [
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.static-pages",
    basis: "ruling: stillafloat-es-first-class.md — Mark 8/15: every page ships with its Spanish twin, translated, and Spanish readers stay on Spanish pages; sign-up, contact, privacy and terms pages carry real content",
    title: "The sign-up, confirmation, unsubscribe, Work With Mark, privacy and terms pages load with real content, in English and Spanish",
    covers: PAGES.map((p) => `page ${p.path}`),
    modes: ["dev", "prod"],
    run: async (t) => {
      const assets = new Set();
      const titles = {};
      for (const p of PAGES) {
        const html = t.html(await t.get(p.path), { mustContain: p.must || [] });
        const title = H.title(html);
        t.matches(title, p.title, `${p.path} page title`);
        titles[p.path] = title;
        t.equal(H.htmlLang(html).slice(0, 2), p.lang, `${p.path} language`);
        const text = H.visibleText(html);
        t.atLeast(text.length, p.minText, `${p.path}: characters of visible text`);
        if (p.lang === "es") t.matches(text, SPANISH, `${p.path} visible text (should read as Spanish)`);
        t.ok(!/\b(undefined|NaN|\[object Object\]|lorem ipsum)\b/i.test(text), `${p.path} shows placeholder or broken text`);
        const canon = H.canonical(html);
        if (canon) t.equal(canon, `${PROD_HOST}${p.path}`, `${p.path} canonical address`);
        // hreflang pairs, where a page declares them, must point at the real twin and back.
        const alts = H.hreflangs(html);
        for (const [lang, href] of Object.entries(alts)) {
          t.ok(/^https:\/\/stillafloatcruising\.com\//.test(href || ""), `${p.path}: hreflang ${lang} points off-site: ${href}`);
          const want = lang.startsWith("es") ? (p.path.startsWith("/es/") ? p.path : `/es${p.path}`) : lang === "x-default" || lang === "en" ? p.path.replace(/^\/es\//, "/") : null;
          if (want) t.equal(pathOf(href), want, `${p.path}: hreflang ${lang} target`);
        }
        // A Spanish page's own links (outside its scripts) must keep the reader in Spanish: a link to
        // a page that has an /es/ twin, or to the English home page, sends them back to English.
        if (p.lang === "es") {
          for (const ref of H.links(html)) {
            const u = H.resolve(ref, `${PROD_HOST}${p.path}`);
            if (!u || !H.sameSite(u, PROD_HOST)) continue;
            const path = pathOf(u);
            if (!/\.html$|\/$/.test(path) || path.startsWith("/es/") || path.startsWith("/api/")) continue;
            t.ok(!(path === "/" || path === "/index.html" || PAGES.some((x) => x.path === `/es${path}`)),
              `${p.path} links a Spanish reader to the English page ${path}`);
          }
        }
        for (const ref of [...H.stylesheets(html), ...H.scripts(html), ...H.images(html)]) {
          const u = H.resolve(ref, t.url(p.path));
          if (u && H.sameSite(u, t.bases.site)) assets.add(H.onBase(u, t.bases.site));
        }
      }
      // Spanish twins are translations, not copies.
      for (const p of PAGES.filter((x) => x.path.startsWith("/es/"))) {
        const en = titles[p.path.replace(/^\/es\//, "/")];
        if (en) t.ok(en !== titles[p.path], `${p.path} has the same title as the English page ("${en}") — untranslated`);
      }
      // Same-site assets the pages load (deduplicated; at most 12, spread across the list).
      const list = [...assets].sort();
      const step = Math.max(1, Math.ceil(list.length / 12));
      const sample = list.filter((_, i) => i % step === 0).slice(0, 12);
      t.nonEmpty(sample, "same-site stylesheets, scripts and images on these pages");
      for (const u of sample) {
        const r = await t.get(u);
        t.ok(r.status === 200 && r.text.length > 0, `a page asset is broken: ${r.describe()}`);
      }
      t.observe("page titles", Object.entries(titles).map(([k, v]) => `${k}=${v}`).join(" | "));
      t.observe("same-site assets on these pages", assets.size, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.spanish-unsubscribe-page",
    basis: "ruling: mark-en-approval-implies-es-translation.md — Mark 10/8 (stillafloat-es-first-class.md): a missing Spanish twin is a bug; a Spanish subscriber who unsubscribes must land on a Spanish confirmation page",
    title: "A Spanish subscriber who unsubscribes lands on a Spanish confirmation page",
    covers: ["flow:spanish-unsubscribe", "page /unsubscribe-confirmed.html", "page /es/unsubscribe-confirmed.html"],
    modes: ["dev", "prod"],
    incident: "ES first-class: GET /api/unsubscribe always redirects to the English /unsubscribe-confirmed.html, and no /es/ twin exists (found 2026-10-07)",
    run: async (t) => {
      const en = t.html(await t.get("/unsubscribe-confirmed.html"));
      t.equal(H.htmlLang(en).slice(0, 2), "en", "/unsubscribe-confirmed.html language");
      // 8 of the 11 confirmed prod subscribers read the Spanish edition (2026-10-07); every
      // Spanish newsletter and storm email carries an unsubscribe link that ends on this page.
      const es = await t.get("/es/unsubscribe-confirmed.html");
      t.ok(es.status === 200, `there is no Spanish unsubscribe confirmation page: ${es.describe()} — a Spanish subscriber who unsubscribes is shown an English page`);
      const html = t.html(es);
      t.equal(H.htmlLang(html).slice(0, 2), "es", "/es/unsubscribe-confirmed.html language");
      t.matches(H.visibleText(html), SPANISH, "/es/unsubscribe-confirmed.html visible text");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.turnstile-on-every-form",
    basis: "ruling: stillafloat-newsletter-subscription-bombing.md — Mark 10/2: bots abused the sign-up to make us email strangers; Turnstile (site key from /api/public-config) on every public form that emails",
    title: "Every sign-up and contact form loads the security check, and the server hands the pages its site key",
    covers: ["GET /api/public-config", "page /subscribe.html", "page /es/subscribe.html", "page /work-with-mark.html", "page /es/work-with-mark.html", "page /cabin-request.html", "page /es/cabin-request.html"],
    modes: ["dev", "prod"],
    incident: "2026-10-02: bots signed strangers up; Turnstile added to the sign-up. Dev found running with no Turnstile keys on 2026-10-07.",
    run: async (t) => {
      // Every page whose form posts to /api/subscribe or /api/contact (found by grep, 2026-10-07).
      const forms = [
        ["/subscribe.html", "/api/subscribe"], ["/es/subscribe.html", "/api/subscribe"],
        ["/work-with-mark.html", "/api/contact"], ["/es/work-with-mark.html", "/api/contact"],
        ["/cabin-request.html", "/api/contact"], ["/es/cabin-request.html", "/api/contact"],
      ];
      for (const [p, api] of forms) {
        const html = t.html(await t.get(p), { mustContain: [api] });
        t.ok(html.includes("/api/public-config"), `${p} never asks the server for the security-check key — the widget can never appear`);
        t.ok(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/.test(html), `${p} does not load the Turnstile script`);
        t.ok(/turnstile\.render\(/.test(html), `${p} never renders the Turnstile widget`);
        t.ok(html.includes("cf-turnstile-response"), `${p} does not send the security token with the form — the server refuses every submission`);
        if (p.startsWith("/es/")) t.equal(H.htmlLang(html).slice(0, 2), "es", `${p} language`);
      }
      // The group cruise page and the "Track this ship" sign-up are checked by their own checks
      // below (audience.turnstile-on-group-interest-form, audience.turnstile-on-ship-tracking-signup)
      // so that each failure names its own cause.
      const cfg = t.json(await t.get("/api/public-config"));
      t.ok(cfg && typeof cfg === "object" && "turnstileSiteKey" in cfg, `/api/public-config no longer returns turnstileSiteKey (keys: ${keysOf(cfg)})`);
      // prod: a real key. dev: Cloudflare's documented always-pass TEST key (1x00000000000000000000AA) is
      // the mirror — the widget renders and a missing token is refused; only the forged-token probe is moot.
      const TEST_KEY = "1x00000000000000000000AA";
      t.matches(cfg.turnstileSiteKey, t.mode === "dev" ? /^(0x[0-9A-Za-z_-]{16,}|1x00000000000000000000AA)$/ : /^0x[0-9A-Za-z_-]{16,}$/,
        `the Turnstile site key from /api/public-config (empty means the sign-up and contact pages show no security check and the server lets every bot through${t.mode === "dev" ? " — dev does not mirror prod" : ""})`);
      t.equal(Boolean(cfg.turnstileTestMode), cfg.turnstileSiteKey === TEST_KEY, "public-config says test mode exactly when the site key is Cloudflare's test key");
      if (t.mode === "prod") t.ok(!cfg.turnstileTestMode, "PRODUCTION is running Cloudflare's always-pass TEST key — every bot passes the security check");
      t.observe("public-config keys", keysOf(cfg));
      t.observe("turnstile site key present", Boolean(cfg.turnstileSiteKey));
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.turnstile-on-group-interest-form",
    basis: "ruling: stillafloat-newsletter-subscription-bombing.md — Mark 10/2: every public form that emails someone carries Turnstile; the group interest form emails Mark and must use the same site key as the other forms",
    title: "The group cruise page's 'I'm interested' form (English and Spanish) loads the security check with the same site key as the other forms",
    covers: ["page /group.html", "page /es/group.html", "GET /api/group-page/:code", "GET /api/public-config", "GET /api/groups"],
    modes: ["dev", "prod"],
    incident: "2026-10-02 bot sign-ups: every public form that emails Mark or a stranger must carry Turnstile. POST /api/group-page/:code/interest emails Mark (priority lead).",
    // PROD: group marketing is dev-only until the 2026-10-08 promotion — /group.html is 404 on prod
    // until then, so this check FAILS on prod before the promotion and must pass after it.
    run: async (t) => {
      for (const p of ["/group.html", "/es/group.html"]) {
        const html = t.html(await t.get(p), { mustContain: ["/api/group-page/"] });
        t.equal(H.htmlLang(html).slice(0, 2), p.startsWith("/es/") ? "es" : "en", `${p} language`);
        t.ok(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/.test(html), `${p} does not load the Turnstile script — the interest form can never pass the server's check`);
        t.ok(/turnstile\.render\(/.test(html), `${p} never renders the Turnstile widget`);
        t.ok(/['"]cf-turnstile-response['"]\s*:/.test(html), `${p} does not send the security token with the interest form`);
        t.ok(/turnstileSiteKey/.test(html), `${p} no longer reads the site key the group API hands it`);
      }
      // The page takes its key from the group API, not /api/public-config: the two must agree, or the
      // group page renders a widget for a key the server does not verify against.
      // Whether Mark has an approved, public group page right now is his business, not the site's, so prod
      // is never required to have one (the pages above are tested regardless). Dev is seeded with a test
      // group on purpose (Mark's 2026-10-04 mirror ruling; approved 2026-10-07) and must still hold it.
      const list = t.success(await t.get("/api/groups", { auth: true }));
      t.ok(Array.isArray(list.groups), "Mark's group list has no groups array");
      const live = list.groups.filter((x) => x.share_code && x.marketing_approved_at && ["marketing", "booking"].includes(x.status));
      if (t.mode === "dev") t.require(live.length > 0, "dev has no group with an approved public page (the seeded test group should be approved), so the group form's key cannot be compared");
      t.observe("live group pages", live.length, "info");
      const cfg = t.json(await t.get("/api/public-config"));
      if (live.length) {
        const gp = t.success(await t.get(`/api/group-page/${encodeURIComponent(live[0].share_code)}?lang=en`));
        t.ok("turnstileSiteKey" in gp, "the group page API no longer hands the page a turnstileSiteKey");
        t.equal(gp.turnstileSiteKey, cfg.turnstileSiteKey, "the group page's security-check key compared with /api/public-config's");
        t.observe("group page api keys", keysOf(gp));
      } else {
        // no approved page: a made-up code is a clean "not found", never a crash or a preview
        t.status(await t.get("/api/group-page/zzzzzzzzzz?lang=en"), 404);
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.turnstile-on-ship-tracking-signup",
    basis: "ruling: stillafloat-newsletter-subscription-bombing.md — Mark 10/2: the Track-this-ship sign-up sends the same confirmation email as the newsletter, so it carries the same bot check",
    title: "The 'Track this ship' sign-up (English and Spanish), which sends the same confirmation email as the newsletter sign-up, carries the same bot check",
    covers: ["page /track-ship.html", "page /es/track-ship.html"],
    modes: ["dev", "prod"],
    incident: "2026-10-02: bots used POST /api/subscribe to make us email strangers; Turnstile was added there only. POST /api/wms/track-signup (2026-09-15) sends the same confirmation email (and, for a confirmed address, a tracking email) with no Turnstile, and shares the site-wide 10-an-hour confirmation cap, so a bot can also use it to lock real sign-ups out.",
    run: async (t) => {
      // Page-level here; the server's refusal is proven in audience.turnstile-enforced-by-server
      // (with a ship that does not exist, so a box without Turnstile still saves and sends nothing).
      for (const p of ["/track-ship.html", "/es/track-ship.html"]) {
        const html = t.html(await t.get(p), { mustContain: ["/api/wms/track-signup"] });
        t.equal(H.htmlLang(html).slice(0, 2), p.startsWith("/es/") ? "es" : "en", `${p} language`);
        t.ok(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/.test(html) && /turnstile\.render\(/.test(html),
          `${p} has no bot check: its sign-up makes the site email any address typed into it (the 2026-10-02 bot hole, still open on this form)`);
        t.ok(html.includes("cf-turnstile-response"), `${p} does not send a security token with the sign-up`);
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.turnstile-enforced-by-server",
    basis: "ruling: stillafloat-newsletter-subscription-bombing.md — Mark 10/2: the server itself refuses a sign-up or contact request with no security check, in English and Spanish; dev holds only test subscribers (mark-dev-never-emails-real-people.md)",
    title: "The server refuses a sign-up or contact request that has no security check (English and Spanish messages)",
    covers: ["POST /api/subscribe", "POST /api/contact", "POST /api/wms/track-signup", "flow:turnstile-enforced", "GET /api/subscribers"],
    modes: ["dev"],
    devOnlyBecause: "it POSTs to the sign-up, contact and ship-tracking forms; prod is read-only",
    incident: "2026-10-02: bot sign-ups; the server only enforces Turnstile when TURNSTILE_SECRET_KEY is set",
    run: async (t) => {
      // A confirmed subscriber's address: if Turnstile were off, the handler stops at "already
      // subscribed" (no insert, no email). The address is never recorded or printed.
      const list = t.json(await t.get("/api/subscribers?status=confirmed&limit=1", { auth: true }));
      const probe = Array.isArray(list.subscribers) ? list.subscribers[0]?.email : "";
      t.require(typeof probe === "string" && probe.includes("@"),
        "this box has no confirmed subscriber, so the security check cannot be probed without risking a real confirmation email");

      const en = await post(t, "/api/subscribe", { name: `${FIXTURE} probe`, email: probe, website: "", lang: "en" });
      t.ok(!(en.status === 200 && en.json?.already),
        "the server ACCEPTED a sign-up with no security token (it answered \"already subscribed\") — Turnstile is not enforced on this box, so bots can sign anyone up");
      refused(t, en, 400, /security check/i, "sign-up with no security token (English)");
      const es = await post(t, "/api/subscribe", { name: `${FIXTURE} probe`, email: probe, website: "", lang: "es" });
      refused(t, es, 400, /verificación de seguridad/i, "sign-up with no security token (Spanish)");
      // A forged token is refused by Cloudflare, not by us — with the documented test secret Cloudflare
      // accepts every token, so on a test-key box this probe would SIGN THE PROBE ADDRESS UP (it is already
      // confirmed, so the handler stops at "already subscribed" — no insert, no email) and prove nothing.
      const cfg = t.json(await t.get("/api/public-config"));
      const testMode = Boolean(cfg.turnstileTestMode);
      t.observe("turnstile test keys on this box", testMode);
      if (!testMode) {
        const bad = await post(t, "/api/subscribe", { name: `${FIXTURE} probe`, email: probe, website: "", lang: "en", "cf-turnstile-response": "e2e-fixture-not-a-real-token" });
        refused(t, bad, 400, /security check/i, "sign-up with a forged security token");
      }

      // The ship-tracking sign-up (POST /api/wms/track-signup, Turnstile added 2026-10-08) — SAFE BY
      // CONSTRUCTION: the ship named does not exist, so if Turnstile were NOT enforced the route answers
      // 404 unknown_ship before anything is saved or any email is sent. Turnstile runs before the ship lookup.
      const track = await post(t, "/api/wms/track-signup", { name: `${FIXTURE} probe`, email: probe, ship: "e2e-fixture-no-such-ship", lang: "en", website: "" });
      t.ok(track.status !== 404, "the ship-tracking sign-up looked the ship up BEFORE the security check — a bot's token-less sign-up reaches the database and the mailer");
      refused(t, track, 400, /^security_check$/, "ship-tracking sign-up with no security token");
      if (!testMode) {
        const trackForged = await post(t, "/api/wms/track-signup", { name: `${FIXTURE} probe`, email: probe, ship: "e2e-fixture-no-such-ship", lang: "en", website: "", "cf-turnstile-response": "e2e-fixture-not-a-real-token" });
        refused(t, trackForged, 400, /^security_check$/, "ship-tracking sign-up with a forged security token");
      }

      // Same secret governs the contact form, and it is now proven to be enforced.
      // 2.5 travellers: if this request ever got past Turnstile, the integer column refuses the insert
      // before either email is sent (see SAFE BY CONSTRUCTION at the top of the file).
      const contact = await post(t, "/api/contact", {
        first_name: FIXTURE, last_name: "release-gate", email: fixtureEmail(), num_travelers: 2.5,
        travel_dates: "e2e fixture — never a real request", preferred_lang: "en",
      });
      refused(t, contact, 400, /verification failed/i, "contact request with no security token");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.subscribe-refusals",
    basis: "code: server/src/routes/subscribe.ts — the sign-up refuses the hidden honeypot field, a short name and a bad address, and resend-verification refuses a missing or unknown address, all before any save or send",
    title: "The newsletter sign-up refuses bots, blank names and bad addresses, and the resend button refuses unknown addresses — and nothing is saved",
    covers: ["POST /api/subscribe", "POST /api/resend-verification", "GET /api/subscribers"],
    modes: ["dev"],
    devOnlyBecause: "it POSTs to the sign-up and resend endpoints; prod is read-only",
    run: async (t) => {
      const email = fixtureEmail();
      // Every refusal below returns before Turnstile, before the insert and before any email. The
      // honeypot and short-name probes ALSO carry a bad address, so that if the refusal they test
      // were removed, the address check still stops them (dev runs with Turnstile off).
      const honey = await post(t, "/api/subscribe", { name: `${FIXTURE} bot`, email: "e2e-fixture-not-an-address", website: "http://spam.example", lang: "en" });
      t.ok(honey.status === 200 && honey.json?.ok === true && !honey.json?.already,
        `a bot that fills the hidden field should be answered "ok" and silently dropped: ${honey.describe()}`);
      refused(t, await post(t, "/api/subscribe", { name: "x", email: "e2e-fixture-not-an-address", lang: "en" }), 400, /full name/i, "sign-up with a one-letter name");
      refused(t, await post(t, "/api/subscribe", { name: `${FIXTURE} name`, email: "not-an-address", lang: "en" }), 400, /valid email/i, "sign-up with a bad address");
      refused(t, await post(t, "/api/subscribe", { name: `${FIXTURE} name`, lang: "es" }), 400, /valid email/i, "sign-up with no address (Spanish form)");

      refused(t, await post(t, "/api/resend-verification", {}), 400, /email is required/i, "resend confirmation with no address");
      refused(t, await post(t, "/api/resend-verification", { email }), 404, /no subscription found/i, "resend confirmation for an address that never signed up");

      // Nothing above may have saved a row. (Search by the fixture marker; counts only.)
      const found = t.json(await t.get(`/api/subscribers?status=all&search=${FIXTURE}&limit=5`, { auth: true }));
      t.ok(Array.isArray(found.subscribers), "the subscriber list has no subscribers array");
      t.equal(found.total, 0, "subscriber rows carrying the e2e-fixture marker after the refused sign-ups");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.contact-refusals",
    basis: "ruling: stillafloat-contact-form.md — the Work With Mark form posts to /api/contact, which refuses missing names, a bad address, a traveller count outside 1 to 20 and missing dates before saving or emailing",
    title: "The Work With Mark contact form refuses missing names, bad addresses, bad traveller counts and missing dates",
    covers: ["POST /api/contact"],
    modes: ["dev"],
    devOnlyBecause: "it POSTs to the contact endpoint; prod is read-only",
    run: async (t) => {
      // Field checks run before Turnstile, before the insert into prospects and before both emails.
      // Each probe also leaves the travel dates blank (the LAST field check) unless the dates are what
      // is tested, and always sends 2.5 travellers (an integer column refuses it at the insert), so a
      // removed check can never let a probe reach the emails — dev runs with Turnstile off.
      const ok = { first_name: FIXTURE, last_name: "release-gate", email: fixtureEmail(), num_travelers: 2.5, travel_dates: "" };
      const cases = [
        [{ ...ok, first_name: "" }, /first name is required/i, "no first name"],
        [{ ...ok, last_name: "" }, /last name is required/i, "no last name"],
        [{ ...ok, email: "not-an-address" }, /valid email/i, "a bad address"],
        [{ ...ok, num_travelers: 0 }, /how many travel+ers/i, "zero travellers"],
        [{ ...ok, num_travelers: 21 }, /how many travel+ers/i, "21 travellers"],
        [{ ...ok, travel_dates: "" }, /travel dates/i, "no travel dates"],
      ];
      for (const [body, re, what] of cases) refused(t, await post(t, "/api/contact", body), 400, re, `contact request with ${what}`);
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.subscriber-counts",
    basis: "code: server/src/lib/newsletter.ts — each edition selects confirmed subscribers by language, so every confirmed subscriber must be tagged en or es; the daily clean-up archives unconfirmed sign-ups after 21 days",
    title: "Mark's subscriber list refuses visitors and, with the token, counts subscribers by status and language with every confirmed one tagged English or Spanish",
    covers: ["GET /api/subscribers", "GET /api/approved-stories-list"],
    modes: ["dev", "prod"],
    run: async (t) => {
      t.status(await t.get("/api/subscribers?limit=1"), 401);
      t.status(await t.get("/api/approved-stories-list"), 401);

      const totals = {};
      for (const s of ["all", "confirmed", "pending", "unsubscribed", "bounced", "archived"]) {
        const b = t.json(await t.get(`/api/subscribers?status=${s}&limit=1`, { auth: true }));
        t.ok(Array.isArray(b.subscribers) && Number.isInteger(b.total), `the subscriber list (${s}) has no list or total`);
        t.ok(b.subscribers.length <= 1, `the subscriber list ignored limit=1 (${s})`);
        totals[s] = b.total;
      }
      // How many people have signed up is the audience, not the site, so prod is not required to have any.
      // Dev holds test addresses only (Mark 2026-10-08) and must still carry one confirmed subscriber, or
      // the language split and the newsletter's use of it are never exercised.
      if (t.mode === "dev") t.require(totals.confirmed >= 1, "dev has no confirmed test subscriber, so the subscriber list, language tags and newsletter cannot be exercised (seed a test-address fixture)");
      const known = totals.confirmed + totals.pending + totals.unsubscribed + totals.bounced + totals.archived;
      t.ok(known === totals.all, `subscribers in an unknown status: ${totals.all} on file but only ${known} in confirmed/pending/unsubscribed/bounced/archived`);

      // Every confirmed subscriber must be tagged en or es: each edition selects by lang, so an
      // untagged subscriber silently receives no newsletter at all (lib/newsletter.ts).
      const conf = t.json(await t.get("/api/subscribers?status=confirmed&limit=200", { auth: true }));
      t.ok(Array.isArray(conf.subscribers) && conf.subscribers.length === Math.min(200, totals.confirmed), "the confirmed list does not match its own count");
      const byLang = { en: 0, es: 0, other: 0 };
      for (const r of conf.subscribers) byLang[r.lang === "en" || r.lang === "es" ? r.lang : "other"]++;
      t.equal(byLang.other, 0, "confirmed subscribers with no en/es language tag (they get no newsletter edition)");

      // The daily hygiene sweep archives a sign-up that is still unconfirmed after 21 days. A pending
      // row older than 22 days means that sweep has stopped. (The list is newest first, so the last
      // page of one row is the oldest. With no pending rows this proves nothing about the sweep —
      // which is why this check does not claim "job scheduleSubscriberHygiene"; jobs.* covers the job.)
      if (totals.pending > 0) {
        const oldest = t.json(await t.get(`/api/subscribers?status=pending&limit=1&page=${totals.pending}`, { auth: true }));
        const row = Array.isArray(oldest.subscribers) ? oldest.subscribers[0] : null;
        t.fields(row, ["created_at"], "the oldest pending subscriber");
        t.fresh(row.created_at, 22 * 24, "the oldest unconfirmed sign-up (the daily sweep archives them after 21 days)");
      }

      // Which stories Mark has approved is the news, not the site: the list must be well-formed whatever its length.
      const ap = t.json(await t.get("/api/approved-stories-list", { auth: true }));
      t.ok(Array.isArray(ap.stories), "the approved-stories list for the newsletter composer has no stories array");
      const st = ap.stories;
      for (const s of [st[0], st[Math.floor(st.length / 2)], st[st.length - 1]].filter(Boolean)) t.fields(s, ["id", "title", "summary"], "an approved story");

      for (const [k, v] of Object.entries(totals)) t.observe(`subscribers ${k}`, v, k === "all" ? "min" : "info");
      t.observe("confirmed subscribers en", byLang.en, "info");
      t.observe("confirmed subscribers es", byLang.es, "info");
      t.observe("approved stories", st.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.subscriber-admin-refusals",
    basis: "code: server/src/routes/subscribe.ts — the subscriber admin routes (language fix, mark-bounced, legacy send) are token-gated and refuse bad input before touching a subscriber",
    title: "The subscriber admin actions (language fix, bounce, legacy newsletter send) refuse visitors and bad requests without touching a subscriber",
    covers: ["PATCH /api/subscribers/:id/lang", "POST /api/subscribers/mark-bounced", "POST /api/send-newsletter"],
    modes: ["dev"],
    devOnlyBecause: "it sends PATCH/POST requests; prod is read-only",
    run: async (t) => {
      const nobody = "00000000-0000-4000-8000-000000000000";
      // language fix
      t.status(await t.send("PATCH", `/api/subscribers/${nobody}/lang`, { body: { lang: "es" } }), 401);
      refused(t, await post(t, `/api/subscribers/${nobody}/lang`, { lang: "fr" }, { auth: true, method: "PATCH" }), 400, /lang must be/i, "language fix with an unknown language");
      refused(t, await post(t, `/api/subscribers/${nobody}/lang`, { lang: "es" }, { auth: true, method: "PATCH" }), 404, /not found/i, "language fix for a subscriber that does not exist");
      // bounce (called by the ops-manager bounce scanner)
      t.status(await t.send("POST", "/api/subscribers/mark-bounced", { body: { email: fixtureEmail() } }), 401);
      refused(t, await post(t, "/api/subscribers/mark-bounced", {}, { auth: true }), 400, /email is required/i, "bounce with no address");
      refused(t, await post(t, "/api/subscribers/mark-bounced", { email: fixtureEmail() }, { auth: true }), 404, /no subscriber/i, "bounce for an address that is not a subscriber");
      // legacy composer send — every one of these is refused before any subscriber is read
      t.status(await t.send("POST", "/api/send-newsletter", { body: { subject: "x", storyIds: ["x"] } }), 401);
      refused(t, await post(t, "/api/send-newsletter", { storyIds: ["x"] }, { auth: true }), 400, /subject is required/i, "legacy send with no subject");
      refused(t, await post(t, "/api/send-newsletter", { subject: `${FIXTURE} subject`, storyIds: [] }, { auth: true }), 400, /at least one story/i, "legacy send with no stories");
      // NOT probed: an unknown story id. That refusal depends on the story filter working — if it ever
      // fell back to "all stories", the request would email every confirmed subscriber on the box.
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.health-and-push-key",
    basis: "ruling: mark-whole-site-e2e-release-gate.md — Mark 10/4 rule 6: the site may degrade for visitors but never silently for Mark; incident 2026-08-26, push had zero devices for five days and nothing noticed",
    title: "The site's health check answers, the push key is published for the dashboard app, the alert canary refuses anyone without its own secret, and on the live site no 'alerts are reaching nobody' fault is open",
    covers: ["GET /api/healthz", "GET /api/push/vapid-public-key", "GET /api/healthz/alerts", "GET /api/push/generate-keys", "GET /api/actions"],
    modes: ["dev", "prod"],
    incident: "2026-08-26: push had zero devices for five days; /api/healthz/alerts is what the other box's watchdog reads",
    run: async (t) => {
      const h = t.json(await t.get("/api/healthz"));
      t.equal(h.status, "ok", "the site health check status");
      t.observe("healthz keys", keysOf(h));

      const v = t.success(await t.get("/api/push/vapid-public-key"), "ok");
      // An uncompressed P-256 public key is 65 bytes: 87 base64url characters starting with "B".
      t.matches(v.key, /^B[A-Za-z0-9_-]{86}$/, "the published push key");

      // The canary uses its own secret; the dashboard token must NOT open it (it would leak "is Mark
      // receiving alerts right now" to anyone holding the far more widely used dashboard token).
      const c1 = await t.get("/api/healthz/alerts");
      t.status(c1, 401);
      t.equal(c1.json?.ok, false, "the canary's refusal body");
      t.status(await t.get("/api/healthz/alerts", { auth: true }), 401);

      // Key-pair bootstrap helper: gated; with the token it returns a fresh, unused pair (not saved).
      t.status(await t.get("/api/push/generate-keys"), 401);
      const g = t.success(await t.get("/api/push/generate-keys", { auth: true }), "ok");
      t.matches(g.publicKey, /^B[A-Za-z0-9_-]{86}$/, "a generated push public key");
      t.ok(typeof g.privateKey === "string" && g.privateKey.length >= 40, "the generated push key pair has no private half");
      t.ok(g.publicKey !== v.key, "the bootstrap helper returned the LIVE key instead of a fresh pair");

      // Is anyone receiving Mark's alerts? The device count needs the canary secret (a gap), but the
      // push-health sweep (lib/push-health.ts, boot + every 6h) raises a "Push notifications are
      // reaching nobody" action, once per UTC day, whenever the count is zero — and that action list
      // is readable with the dashboard token. Only the source_ref and type are read (the list holds
      // personal content).
      t.status(await t.get("/api/actions"), 401);
      const acts = t.success(await t.get("/api/actions", { auth: true }), "ok");
      t.ok(Array.isArray(acts.actions), "the action list has no actions array");
      const dead = acts.actions.filter((a) => a && a.type === "system-fault" && pushEmptyRefs().includes(a.source_ref));
      if (t.mode === "prod") {
        t.equal(dead.length, 0, "pending 'push notifications are reaching nobody' faults raised today or yesterday on prod (Mark's phone is receiving no alerts)");
      } else {
        // Dev has no push device by design (2026-10-07); audience.push-device-roundtrip holds dev's
        // count against this same fault, so here it is only recorded.
        t.note(`dev: ${dead.length} pending push-channel-empty fault(s) for today/yesterday`);
      }
      t.observe("pending actions (count)", acts.actions.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.push-device-roundtrip",
    basis: "ruling: stillafloat-inhouse-brief.md — agent alerts go over Web Push to the Still Afloat app; a device can register and be removed, and the push-health sweep must flag a box with none (incident 2026-08-26)",
    title: "A device can register for Mark's push alerts and be removed again, sending refuses visitors and empty messages, and the push-health sweep flags a box with no device",
    covers: ["POST /api/push/subscribe", "POST /api/push/unsubscribe", "POST /api/push/notify", "POST /api/push/test", "push:device-registration", "GET /api/actions", "job schedulePushHealth"],
    modes: ["dev"],
    devOnlyBecause: "it registers and removes a fixture push device (a write); prod is read-only",
    run: async (t) => {
      // refusals
      t.status(await t.send("POST", "/api/push/subscribe", { body: { subscription: PUSH_FIXTURE } }), 401);
      t.status(await t.send("POST", "/api/push/unsubscribe", { body: { endpoint: PUSH_FIXTURE.endpoint } }), 401);
      t.status(await t.send("POST", "/api/push/notify", { body: { title: "x" } }), 401);
      t.status(await t.send("POST", "/api/push/test", { body: {} }), 401);
      // With the token, an empty message is refused before anything is pushed. (A real notify or
      // test would push to Mark's devices — see the gap list.)
      refused(t, await post(t, "/api/push/notify", {}, { auth: true }), 400, /title or body required/i, "a push with no title or body");
      refused(t, await post(t, "/api/push/subscribe", {}, { auth: true }), 400, /missing subscription/i, "registering no device");
      refused(t, await post(t, "/api/push/subscribe", { subscription: { endpoint: PUSH_FIXTURE.endpoint } }, { auth: true }), 400, /invalid subscription/i, "registering a device with no keys");

      // Round trip with a fixture device on a .invalid host. Removing it first also cleans up after
      // a run that died half-way (a leftover fixture would make the device count look healthy).
      const before = t.success(await post(t, "/api/push/unsubscribe", { endpoint: PUSH_FIXTURE.endpoint }, { auth: true }), "ok");
      t.ok(Number.isInteger(before.devices) && before.devices >= 0, `the device count is not a number: ${before.devices}`);
      let added; let after;
      try {
        added = t.success(await post(t, "/api/push/subscribe", { subscription: PUSH_FIXTURE }, { auth: true }), "ok");
      } finally {
        after = await post(t, "/api/push/unsubscribe", { endpoint: PUSH_FIXTURE.endpoint }, { auth: true });
      }
      t.equal(added.devices, before.devices + 1, "devices after registering the fixture device");
      const a = t.success(after, "ok");
      t.equal(a.devices, before.devices, "devices after removing the fixture device (the fixture may have been left behind)");
      t.observe("registered push devices", before.devices, "info");

      // Two views of the same fact: with no device registered, the push-health sweep (boot + every
      // 6h) must have raised today's (or, just after midnight UTC, yesterday's) "reaching nobody"
      // fault. Zero devices and no fault means the sweep that exists because of the 2026-08-26
      // five-day silence has stopped. With devices, there must be no such fault from today.
      const acts = t.success(await t.get("/api/actions", { auth: true }), "ok");
      t.ok(Array.isArray(acts.actions), "the action list has no actions array");
      const faults = acts.actions.filter((x) => x && x.type === "system-fault" && pushEmptyRefs().includes(x.source_ref));
      if (before.devices === 0) {
        t.atLeast(faults.length, 1, "pending 'push notifications are reaching nobody' faults while this box has zero push devices (the push-health sweep has stopped)");
      } else {
        t.equal(faults.filter((x) => x.source_ref === pushEmptyRefs()[0]).length, 0, `'reaching nobody' faults raised today although ${before.devices} device(s) are registered`);
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.confirmation-email-links",
    basis: "code: server/src/lib/link-signing.ts — confirm and unsubscribe links are signed; a forged one is refused and changes nobody; the old public default is honoured only until 2026-10-31 (incident 2026-09-15)",
    title: "The confirm and unsubscribe links in a subscriber's email go to the right page with the right result: a real signed link unsubscribes, a forged one is refused and changes nobody",
    covers: ["GET /api/verify-email", "GET /api/unsubscribe", "flow:confirmation-email-links", "page /subscribe-verified.html", "page /unsubscribe-confirmed.html", "page /subscribe.html", "GET /api/subscribers", "GET /api/newsletter/email"],
    modes: ["dev"],
    devOnlyBecause: "GET /api/verify-email and GET /api/unsubscribe act on a link; never requested on prod",
    incident: "2026-09-15: unsubscribe links were signed with a public default (anyone could unsubscribe anyone). The old default is honoured until 2026-10-31 (lib/link-signing.ts LEGACY_SIGNATURES_UNTIL) and must be refused after it.",
    run: async (t) => {
      // A forged link and a real one land on the SAME static page; only ?result= differs. So every
      // redirect below is read with noFollow() and its destination asserted exactly — following it
      // and comparing page titles would pass even if the signature check were deleted.
      const count = async (s) => {
        const b = t.json(await t.get(`/api/subscribers?status=${s}&limit=1`, { auth: true }));
        t.ok(Number.isInteger(b.total), `the subscriber list (${s}) has no total`);
        return b.total;
      };
      const before = { confirmed: await count("confirmed"), unsubscribed: await count("unsubscribed"), pending: await count("pending") };
      const lands = (res, path, result, what) => {
        const u = redirectTo(t, res, what);
        t.equal(u.pathname, path, `${what}: the page it opens`);
        if (result) t.equal(u.searchParams.get("result"), result, `${what}: the result it reports`);
        return u;
      };

      // confirm link
      lands(await noFollow(t, "/api/verify-email"), "/subscribe.html", null, "a confirm link with no token");
      lands(await noFollow(t, `/api/verify-email?token=${FIXTURE}-not-a-real-token`), "/subscribe-verified.html", "invalid", "a forged confirm link");

      // unsubscribe link: missing, forged, and (after 2026-10-31) signed with the old public default.
      // Fixture addresses are not subscribers, so even an accepted link updates no row.
      const fx = encodeURIComponent(fixtureEmail());
      lands(await noFollow(t, `/api/unsubscribe?email=${fx}`), "/unsubscribe-confirmed.html", "invalid", "an unsubscribe link with no signature");
      lands(await noFollow(t, `/api/unsubscribe?email=${fx}&sig=000000000000000000000000`), "/unsubscribe-confirmed.html", "invalid", "a forged unsubscribe link");
      const legacyEmail = fixtureEmail();
      const legacy = await noFollow(t, `/api/unsubscribe?email=${encodeURIComponent(legacyEmail)}&sig=${legacyUnsubSig(legacyEmail)}`);
      if (TODAY() > "2026-10-31") {
        lands(legacy, "/unsubscribe-confirmed.html", "invalid", "an unsubscribe link signed with the OLD PUBLIC default (honoured only until 2026-10-31)");
      } else {
        t.observe("legacy-signed unsubscribe link result (grace period to 2026-10-31)", redirectTo(t, legacy, "a legacy-signed unsubscribe link").searchParams.get("result"), "info");
      }

      // A REAL signed link: the one this box puts in its own newsletter preview, signed for the
      // preview address (lib/newsletter.ts). Following it proves the signer and the verifier use the
      // same secret — if they ever disagree, every subscriber's unsubscribe link says "invalid".
      // Guard: the preview address must not be a subscriber here, so the accepted link updates no row.
      const nl = await t.get("/api/newsletter/email?lang=en", { auth: true });
      t.require(nl.status === 200, `this box has no English newsletter draft, so no real signed unsubscribe link can be followed (${nl.describe()})`);
      const unsubHref = H.links(t.html(nl)).map((l) => l.replace(/&amp;/g, "&")).find((l) => /\/api\/unsubscribe\?/.test(l));
      t.ok(unsubHref, "the newsletter preview has no unsubscribe link");
      const real = new URL(unsubHref);
      const who = real.searchParams.get("email") || "";
      const clash = t.json(await t.get(`/api/subscribers?status=all&limit=1&search=${encodeURIComponent(who)}`, { auth: true }));
      t.require(Number.isInteger(clash.total) && clash.total === 0,
        "the newsletter preview's address is a subscriber on this box, so following its signed unsubscribe link would change a row — not followed");
      lands(await noFollow(t, `${real.pathname}${real.search}`), "/unsubscribe-confirmed.html", "success", "the newsletter's own (validly signed) unsubscribe link");

      // the landing pages exist and handle the results sent to them
      t.html(await t.get("/subscribe.html"), { mustContain: ["/api/subscribe"] });
      t.html(await t.get("/subscribe-verified.html"), { mustContain: [/result\s*===\s*'invalid'/, "errorCard"] });
      t.html(await t.get("/unsubscribe-confirmed.html"), { mustContain: [/result\s*===\s*'invalid'/, /result\s*===\s*'success'/] });

      const after = { confirmed: await count("confirmed"), unsubscribed: await count("unsubscribed"), pending: await count("pending") };
      for (const k of Object.keys(before)) t.equal(after[k], before[k], `${k} subscribers before and after following these links`);
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.newsletter-email",
    basis: "ruling: stillafloat-newsletter.md — Still Afloat Weekly: the letter links quick hits to the prerendered /news/ pages, in the reader's language, with a signed unsubscribe link; ES first-class (stillafloat-es-first-class.md)",
    title: "The weekly newsletter email renders for every language that has subscribers, and every link in it opens a real page in the reader's language",
    covers: ["email:newsletter-weekly", "GET /api/newsletter/email", "GET /api/subscribers", "GET /api/affiliate-items", "GET /api/commentary"],
    modes: ["dev", "prod"],
    incident: "2026-09-15: unsubscribe links signed with a public default; ES first-class (8 of 11 prod subscribers read Spanish, 2026-10-07)",
    run: async (t) => {
      const conf = t.json(await t.get("/api/subscribers?status=confirmed&limit=200", { auth: true }));
      t.ok(Array.isArray(conf.subscribers), "the confirmed subscriber list is missing");
      const n = { en: conf.subscribers.filter((s) => s.lang === "en").length, es: conf.subscribers.filter((s) => s.lang === "es").length };
      // An edition with no subscribers is checked anyway if it exists; if it does not, that language
      // is UNTESTABLE on this box (reported after the other edition has been checked).
      const untested = [];

      const items = t.success(await t.get("/api/affiliate-items"));
      t.ok(Array.isArray(items.items), "the affiliate item list is missing");
      const itemIds = new Set(items.items.map((i) => i.id));
      const followed = new Set();
      for (const lang of ["en", "es"]) {
        const res = await t.get(`/api/newsletter/email?lang=${lang}`, { auth: true });
        if (n[lang] === 0 && res.status === 404) { untested.push(lang); continue; }
        t.ok(res.status === 200, `there is no ${lang.toUpperCase()} newsletter to preview although ${n[lang]} confirmed subscribers read that edition: ${res.describe()}`);
        const html = t.html(res);
        const text = H.visibleText(html);
        t.atLeast(text.length, 800, `${lang.toUpperCase()} newsletter: characters of text`);
        t.ok(!/\b(undefined|NaN|\[object Object\])\b/.test(text), `${lang.toUpperCase()} newsletter shows broken text`);
        if (lang === "es") t.matches(text, SPANISH, "ES newsletter text (should read as Spanish)");

        const links = H.links(html);
        // unsubscribe: present, signed, and NOT signed with the public default from the repo
        const unsub = links.find((l) => /\/api\/unsubscribe\?/.test(l));
        t.ok(unsub, `${lang.toUpperCase()} newsletter has no unsubscribe link`);
        const u = new URL(unsub.replace(/&amp;/g, "&"));
        t.equal(u.origin, PROD_HOST, `${lang.toUpperCase()} newsletter unsubscribe link host`);
        const sig = u.searchParams.get("sig") || "";
        t.matches(sig, /^[0-9a-f]{24}$/, `${lang.toUpperCase()} newsletter unsubscribe signature`);
        t.ok(sig !== legacyUnsubSig(u.searchParams.get("email") || ""),
          `${lang.toUpperCase()} newsletter unsubscribe link is signed with the PUBLIC default secret — anyone can unsubscribe any address (UNSUBSCRIBE_SECRET is not set on this box)`);
        // affiliate links: checked by form only (following one records a click)
        for (const l of links.filter((x) => /\/api\/go\//.test(x))) {
          const id = /\/api\/go\/([^/?#]+)/.exec(l)?.[1];
          t.ok(itemIds.has(id), `${lang.toUpperCase()} newsletter links to an affiliate item that no longer exists (${id})`);
          t.ok(new RegExp(`[?&]l=${lang}\\b`).test(l.replace(/&amp;/g, "&")), `${lang.toUpperCase()} newsletter affiliate link is not tagged with its language`);
        }
        // pages: every same-site page link is in the reader's language and opens a real page
        const pages = [...new Set(links.map((l) => H.resolve(l.replace(/&amp;/g, "&"), PROD_HOST)).filter((x) => x && H.sameSite(x, PROD_HOST) && !/\/api\//.test(new URL(x).pathname))
          .map((x) => { const v = new URL(x); return `${v.origin}${v.pathname}${v.searchParams.get("id") ? `?id=${v.searchParams.get("id")}` : ""}`; }))];
        t.atLeast(pages.length, 3, `${lang.toUpperCase()} newsletter links to our own pages`);
        t.atLeast(pages.filter((p) => /\/news\/[^/]+\.html$/.test(p)).length, 1, `${lang.toUpperCase()} newsletter story links`);
        for (const p of pages) {
          const isEs = /^\/es\//.test(pathOf(p));
          t.ok(lang === "es" ? isEs : !isEs, `the ${lang.toUpperCase()} newsletter links to a page in the other language: ${pathOf(p)}`);
        }
        // Follow EVERY story link (up to 8): a story page only exists after the hourly prerender, so a
        // newsletter can link a page that is not there yet — the likeliest broken link in the email.
        // Then up to 4 of the other pages (first, last and a spread between).
        const stories = pages.filter((p) => /\/news\/[^/]+\.html$/.test(p));
        const others = pages.filter((p) => !stories.includes(p));
        const step = Math.max(1, Math.ceil(others.length / 4));
        const toFollow = [...stories.slice(0, 8), ...others.filter((_, i) => i % step === 0 || i === others.length - 1).slice(0, 4)];
        for (const p of toFollow) {
          if (followed.has(p)) continue; followed.add(p);
          const r = await t.get(H.onBase(p, t.bases.site));
          t.ok(r.status === 200, `a link in the ${lang.toUpperCase()} newsletter is broken: ${r.describe()}`);
          const page = t.html(r);
          t.equal(H.htmlLang(page).slice(0, 2), lang, `the language of ${pathOf(p)} (linked from the ${lang.toUpperCase()} newsletter)`);
          const cid = /commentary-post\.html\?id=([^&#]+)/.exec(p)?.[1];
          if (cid) {
            // Mark's commentary page is a shell that loads the post by id: check the post it will show.
            const c = t.success(await t.get(`/api/commentary?id=${encodeURIComponent(cid)}`));
            t.fields(c.post, ["id", "title", "status", `body_${lang}`], `the commentary linked from the ${lang.toUpperCase()} newsletter`);
            t.equal(c.post.id, decodeURIComponent(cid), "the commentary the newsletter links to");
            t.equal(c.post.status, "published", `the commentary linked from the ${lang.toUpperCase()} newsletter is not published`);
            t.atLeast(H.visibleText(String(c.post[`body_${lang}`])).length, 300, `characters in the ${lang.toUpperCase()} commentary the newsletter links to`);
          } else {
            t.ok(H.title(page).length > 0 && H.visibleText(page).length > 150, `a link in the ${lang.toUpperCase()} newsletter opens an empty page: ${pathOf(p)}`);
            if (stories.includes(p)) t.ok(H.h1s(page).some((h) => h.length > 10), `the story ${pathOf(p)} linked from the ${lang.toUpperCase()} newsletter has no headline`);
          }
        }
        // our own images in the email
        for (const img of H.images(html).filter((s) => H.sameSite(s, PROD_HOST)).slice(0, 2)) {
          const r = await t.get(H.onBase(img, t.bases.site));
          t.ok(r.status === 200 && /^image\//.test(r.headers.get("content-type") || ""), `an image in the ${lang.toUpperCase()} newsletter is broken: ${r.describe()}`);
        }
        t.observe(`newsletter ${lang} own-page links`, pages.length, "info");
      }
      // A language with neither subscribers nor a draft has nothing to render: on prod that is the audience's
      // state, so it is observed. Dev holds a test subscriber per language by Mark's 2026-10-04 mirror ruling.
      t.observe("newsletter languages with nothing to preview", untested.join(",") || "(none)", "info");
      if (t.mode === "dev") t.require(untested.length === 0, `this box has no confirmed ${untested.map((l) => (l === "es" ? "Spanish" : "English")).join(" or ")} subscriber and no draft in that language, so that edition cannot be checked (seed a fixture subscriber in that language on dev)`);
      t.observe("newsletter editions with subscribers", Object.entries(n).filter(([, v]) => v > 0).map(([k]) => k).join(","));
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.storm-email-buttons",
    basis: "code: server/src/lib/storm-email-content.ts — the storm email's buttons open /storm-watch.html (listing live storms) and each ship on /wheres-my-ship.html?ship= in the reader's language; dev holds a seeded storm fixture (mark-whole-site-e2e-release-gate.md 10/4)",
    title: "The storm email's buttons open real pages: 'See all storm warnings' lists the live storms and each ship named in it opens on the tracker (English and Spanish)",
    covers: ["flow:storm-email-buttons", "GET /api/storm-watch", "GET /api/wms/ships", "page /storm-watch.html", "page /es/storm-watch.html", "page /wheres-my-ship.html", "page /es/wheres-my-ship.html"],
    modes: ["dev", "prod"],
    incident: "2026-10-07: the storm email's 'See all storm warnings' button opened /storm-watch.html with no ?id= and the page said 'No advisory selected' (fixed on dev; prod fails until the 2026-10-08 promotion)",
    run: async (t) => {
      // The links are fixed in server/src/lib/storm-email-content.ts (no preview endpoint exists):
      //   warnings button  → /storm-watch.html   | /es/storm-watch.html
      //   tracker button   → /wheres-my-ship.html | /es/wheres-my-ship.html
      //   each ship        → /wheres-my-ship.html?ship=<name>  (same /es/ split)
      for (const p of ["/storm-watch.html", "/es/storm-watch.html"]) {
        const html = t.html(await t.get(p));
        t.equal(H.htmlLang(html).slice(0, 2), p.startsWith("/es/") ? "es" : "en", `${p} language`);
        t.ok(!/if\s*\(\s*!id\s*\)\s*\{[^}]*No advisory selected/.test(html),
          `${p} opened from the storm email (no ?id=) shows "No advisory selected" instead of the storms — the email's main button leads nowhere`);
        t.ok(/fetch\(\s*["']\/api\/storm-watch["']\s*\)/.test(html), `${p} does not load the storm list when no advisory is in the address`);
      }
      const pub = t.success(await t.get("/api/storm-watch"));
      t.ok(Array.isArray(pub.systems), "the public storm list has no systems array");
      // Prod often has no live storm (then no storm email goes out either); dev must have one.
      if (t.mode === "dev") t.require(pub.systems.length > 0, "dev has no public storm, so the storm email's ship links cannot be checked — seed the dev storm fixture");

      const reg = t.success(await t.get("/api/wms/ships"), "ok");
      t.nonEmpty(reg.ships, "the ship registry behind Where's My Ship");
      const names = new Set(reg.ships.map((s) => String(s.name).toLowerCase()));
      let named = 0;
      for (const s of pub.systems.slice(0, 3)) {
        for (const v of (s.sailings || []).slice(0, 4)) {
          named++;
          t.ok(names.has(String(v.ship_name).toLowerCase()), `storm "${s.name}" names ${v.ship_name}, whose tracker link would open on a ship Where's My Ship does not know`);
        }
      }
      for (const p of ["/wheres-my-ship.html", "/es/wheres-my-ship.html"]) {
        const html = t.html(await t.get(p));
        t.equal(H.htmlLang(html).slice(0, 2), p.startsWith("/es/") ? "es" : "en", `${p} language`);
        let deep = /get\(\s*['"]ship['"]\s*\)/.test(html);
        for (const src of H.scripts(html).map((x) => H.resolve(x, t.url(p))).filter((u) => u && H.sameSite(u, t.bases.site) && /wheres-my-ship/.test(u))) {
          if (deep) break;
          const js = await t.get(H.onBase(src, t.bases.site));
          t.status(js, 200);
          deep = /get\(\s*['"]ship['"]\s*\)/.test(js.text);
        }
        t.ok(deep, `${p} no longer opens on the ship named in ?ship= — every ship link in the storm email would open a blank tracker`);
      }
      t.observe("storm email ships checked against the tracker", named, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "audience.brief-email",
    basis: "ruling: stillafloat-inhouse-brief.md — Mark's morning brief arrives as an email whose links to our site open real pages",
    title: "Mark's morning brief email renders, and every link in it to our site opens a real page when clicked from the email",
    covers: ["email:morning-brief", "GET /api/brief/email-preview"],
    modes: ["dev", "prod"],
    run: async (t) => {
      t.status(await t.get("/api/brief/email-preview"), 401);
      const res = await t.get("/api/brief/email-preview", { auth: true });
      t.status(res, 200);
      t.ok(/^text\/html/.test(res.headers.get("content-type") || ""), `the brief preview is not HTML: ${res.describe()}`);
      const html = res.text;
      const heads = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
      t.atLeast(heads.length, 2, "sections in the brief email");
      t.ok(!/\b(undefined|NaN|\[object Object\])\b/.test(H.visibleText(html)), "the brief email shows broken text");
      // Links to our own site are fetched exactly as the email has them — with no token, the way
      // Mark's mail app opens them. (Content is personal: nothing from it is recorded.)
      // SAFETY: this runs on prod. An /api/ link in an email can act when opened (approve, dismiss,
      // run, unsubscribe…), so only API paths whose GET handler has been read and found read-only
      // are followed; any other API link FAILS the check until someone reads its handler and adds it
      // here. /api/social/review: requireToken, renders the review page, writes nothing.
      const SAFE_API = new Set(["/api/social/review"]);
      const own = [...new Set(H.links(html).map((l) => H.resolve(l.replace(/&amp;/g, "&"), PROD_HOST)).filter((u) => u && H.sameSite(u, PROD_HOST)))].slice(0, 5);
      for (const u of own) {
        const path = pathOf(u);
        t.ok(!path.startsWith("/api/") || SAFE_API.has(path), `the brief email links to ${path}, an API address this check has not been cleared to open (read its GET handler; add it to SAFE_API only if it changes nothing)`);
      }
      for (const u of own) {
        const r = await t.get(H.onBase(u, t.bases.site));
        t.ok(r.status === 200, `a link in the morning brief email opens an error for Mark: ${r.describe()}`);
        t.html(r);
      }
      t.observe("brief email sections", heads.length, "info");
      t.observe("brief email links to our site", own.length, "info");
    },
  },
];
