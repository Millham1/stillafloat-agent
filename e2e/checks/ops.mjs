// e2e/checks/ops.mjs — Mark's operations tools: the dashboard app, its token gate, the social
// pipeline (review queue, posting calendar, share kit, clip library, follower stats), finance,
// YouTube + Search Console analytics, AI visibility, the ops-manager service, and group bookings
// (the group file, booking intake, group marketing and the public group page).
//
// Incidents and risks these checks exist for:
//   2026-09-04  A missing AGENT_APPROVAL_TOKEN used to OPEN every admin endpoint (103 call sites,
//               17 route files) instead of closing them. Every gated address is asked without the
//               token and must say 401 — and with the token it must return real data, because a
//               gate that also refuses Mark is an outage of its own.
//   2026-09-06  POST /api/social/ingest was added to social.ts (042c8fa) while social-analytics.ts
//               already had it. Express runs the first one registered (social.ts), which stores a
//               LIST of snapshots under the "social-stats" key; the dashboard's Overview "social"
//               panel (/api/social-analytics) reads the same key expecting {latest, previous}, so it
//               says "No data yet" while /api/social/stats receives a snapshot every 12 hours. Only
//               comparing the two views catches it.
//   2026-09-06  Instagram posts with no clip sat "scheduled" forever; the poster now resolves a
//               retry older than 7 days as skipped. The calendar is checked for posts stuck past
//               that rule (that means the poster stopped).
//   2026-09-30  Finance capture: receipts saved with no transaction date never count in any
//               monthly total or cash-flow bar.
//   2026-10-02  Group bookings: "never store card numbers" (Mark). The group file is scanned for
//               anything card-shaped, and the card guard is proven to refuse on every write path.
//   2026-10-07  Group marketing (dev only until the 2026-10-08 promotion): the public page must
//               show exactly the approved copy, never an unapproved group, never contact details.
//
// SAFETY NOTES (read before adding a request here):
//   • Prod is read-only. GET /api/ops/conflicts PRUNES stale conflicts in the ops-manager's pending
//     store, and GET /api/social/share is on the "never call on prod" list, so both are dev-only.
//   • GET /api/ops/gsc/insights makes an UNCACHED model call (local box, Anthropic fallback) on
//     every request: it is only ever asked WITHOUT the token (401), never with it.
//   • GET /api/groups/:id/marketing and GET /api/group-page/:code write groups.ship_slug the first
//     time a group with a ship name but no slug is read (memoisation). On prod those reads are
//     only made for groups whose ship_slug is already set, so a prod sweep never writes.
//   • POST /api/group-page/:code/interest EMAILS Mark (priority lead). Only its refusal paths are
//     used: a malformed code, the bot honeypot (answers success and stores nothing) and a body
//     with no name and no email. TURNSTILE is not enforced on dev, so a request carrying a name
//     and an email WOULD be stored and e-mailed — never send one.
//   • Every write that could, if a guard regressed, change a real row also carries an invalid
//     enum value, so the database's own check constraint refuses it as a second line of defence.
//   • No personal data in failures or observations: groups are named by id, travellers and
//     replies are counted, never quoted; money is never recorded.
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

const ZERO = "00000000-0000-4000-8000-000000000000";
const FIXTURE_TITLE = "e2e-fixture release gate checklist row (safe to delete)";
const CARDLIKE = "0000 0000 0000 0000"; // Luhn-valid by construction, obviously not a card
const PROD_DASHBOARD = "https://dashboard.stillafloatcruising.com";
const GROUP_STATUSES = ["draft", "marketing", "booking", "final-paid", "sailed", "closed", "cancelled"];
const BATCH_STATUSES = ["pending", "approved", "rejected", "scheduled", "posted"];
const POST_STATES = ["scheduled", "posted", "skipped", "failed"];
const ACTIVITY_KINDS = ["domain-block", "takedown", "page", "llms", "schema", "praise", "forum", "prompt-test", "measure", "note"];
const ACTIVITY_STATUSES = ["done", "in-progress", "waiting-on-mark", "planned"];
const INTEREST_STATUSES = ["new", "contacted", "booked", "declined", "spam"];
const DAY = 86_400_000;

const isoDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const daysOld = (t, when) => (t.now() - Date.parse(when)) / DAY;
const count = (text, re) => (text.match(re) || []).length;
const langsFor = (g) => (g.lang === "es" ? ["es"] : g.lang === "both" ? ["en", "es"] : ["en"]);
const isLive = (g) => !!g.share_code && !!g.marketing_approved_at && ["marketing", "booking"].includes(g.status);
// On prod a marketing/group-page read of a group with a ship name but no slug would write the slug.
const safeMarketingRead = (t, g) => t.mode !== "prod" || !!g.ship_slug || !g.ship_name;

/** A refusal: exact status and the endpoint's own failure answer (never a 2xx, never an HTML page). */
function refused(t, res, status, what, errorRe) {
  t.ok(res.status === status, `${what}: expected HTTP ${status}: ${res.describe()}`);
  const j = res.json;
  t.ok(j && typeof j === "object" && (j.success === false || j.ok === false || typeof j.detail === "string"),
    `${what}: the refusal is not the endpoint's own answer: ${res.describe()}`);
  if (errorRe) t.ok(errorRe.test(String(j.error ?? j.detail ?? "")), `${what}: refused for the wrong reason: ${res.describe()}`);
}

/** 401 from requireToken: { success:false, error:"Unauthorized" }. */
function unauthorized(t, res, what) {
  refused(t, res, 401, `${what} without the dashboard token`, /unauthori[sz]ed/i);
}

/** Same rule as server/src/lib/group-file.ts looksLikeCardNumber (13–19 digits, Luhn). */
function cardShaped(text) {
  const cleaned = String(text)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, " ") // ids
    .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?/g, " "); // dates
  for (const run of cleaned.match(/\d(?:[ -]?\d){12,18}/g) || []) {
    const d = run.replace(/[ -]/g, "");
    if (d.length < 13 || d.length > 19) continue;
    let sum = 0; let alt = false;
    for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
    if (sum % 10 === 0 && /[1-9]/.test(d)) return true;
  }
  return false;
}

/** first, middle, last — a spread, never the whole list. */
const spread = (list, n = 3) => {
  if (list.length <= n) return list;
  const idx = [...new Set([0, Math.floor((list.length - 1) / 2), list.length - 1])];
  return idx.map((i) => list[i]);
};

/** The dashboard's main program as this box serves it (prod: through the /dashboard/ alias — see ops.dashboard-app). */
async function dashboardProgram(t) {
  const html = t.html(await t.get("/dashboard/"), { mustContain: [/<div id="root"/] });
  const main = H.scripts(html).find((s) => /\/assets\/index-[\w-]+\.js$/.test(s));
  t.ok(main, "the dashboard page names no main program (assets/index-*.js)");
  const js = await t.get(main.startsWith("/dashboard/") ? main : `/dashboard${main}`);
  t.status(js, 200);
  t.atLeast(js.text.length, 200_000, "size of the dashboard program in bytes");
  return js.text;
}

async function groupsList(t) {
  const body = t.success(await t.get("/api/groups", { auth: true }));
  t.ok(Array.isArray(body.groups), "the dashboard's group list has no groups array");
  return body.groups;
}

export default [
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.auth-gate",
    title: "Every dashboard data address refuses a visitor without Mark's token (or with a wrong one), and the token itself is accepted",
    covers: ["GET /api/auth-check"],
    modes: ["dev", "prod"],
    incident: "2026-09-04: a missing secret opened every admin endpoint instead of closing it",
    run: async (t) => {
      // The guard is what is under test here; each feature's real data is checked with the token
      // in its own check below. Paths exist on prod AND dev (group marketing is checked in its own
      // check because prod does not have it until the promotion).
      const gated = [
        "/api/auth-check", "/api/ai-visibility", "/api/social-analytics", "/api/social/stats",
        "/api/social/queue", "/api/social/media", "/api/social/config", "/api/social/schedule-config",
        "/api/social/schedule", "/api/social/upload", "/api/social/compose", "/api/social/review",
        "/api/ops/finance/summary", "/api/ops/finance/transactions", "/api/ops/finance/cashflow",
        "/api/ops/finance/subscriptions", "/api/ops/youtube-analytics", "/api/ops/social-analytics",
        "/api/ops/conflicts", "/api/ops/gsc/analytics", "/api/ops/gsc/insights", "/api/ops/seo-proposals",
        "/api/groups", `/api/groups/${ZERO}`, `/api/groups/intake/${ZERO}`, `/api/groups/intake/${ZERO}/file`,
      ];
      // GET /api/social/share is on the never-call-on-prod list; without a token it cannot reach
      // its handler, but the list is obeyed literally.
      if (t.mode === "dev") gated.push("/api/social/share");
      for (const p of gated) unauthorized(t, await t.get(p), p);
      for (const p of ["/api/auth-check", "/api/groups", "/api/ops/finance/summary"]) {
        refused(t, await t.get(p, { headers: { "x-affiliate-token": "e2e-wrong-token-not-a-secret" } }), 401,
          `${p} with a wrong token`, /unauthori[sz]ed/i);
      }
      // The guard reads the token from three places (lib/http-auth.ts extractToken): the header, a
      // Bearer authorization and ?token= (the review/calendar links Mark gets on his phone). A wrong
      // value in EACH must be refused — a guard that only compares the header would let any ?token= in.
      // (The value in the query string is a fixed fake, never the real token.)
      refused(t, await t.get("/api/auth-check", { headers: { authorization: "Bearer e2e-wrong-token-not-a-secret" } }), 401,
        "/api/auth-check with a wrong Bearer token", /unauthori[sz]ed/i);
      refused(t, await t.get("/api/auth-check?token=e2e-wrong-token-not-a-secret"), 401,
        "/api/auth-check with a wrong ?token=", /unauthori[sz]ed/i);
      refused(t, await t.get("/api/social/review?token=e2e-wrong-token-not-a-secret"), 401,
        "the social review page with a wrong ?token=", /unauthori[sz]ed/i);
      const ok = t.success(await t.get("/api/auth-check", { auth: true }), "ok");
      t.observe("auth-check keys", keysOf(ok));
      t.observe("gated addresses asked", gated.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.dashboard-app",
    title: "Mark's dashboard app is deployed: its page and main program load, it checks his token, and on prod the dashboard address asks for a password",
    covers: ["ext:dashboard-app"],
    modes: ["dev", "prod"],
    run: async (t) => {
      // Dev serves the dashboard at <dev>/dashboard/ (built with base /dashboard/). Prod serves it at
      // dashboard.stillafloatcruising.com behind a password (HTTP Basic). The same files are also
      // reachable on prod at stillafloatcruising.com/dashboard/ WITHOUT that password — reported as a
      // site problem 2026-10-08; this check reads the build through that path because the harness has
      // no Basic-auth credential. If that path is closed, read the bundle another way — do not drop it.
      if (t.mode === "prod") {
        const gate = await t.get(`${PROD_DASHBOARD}/`);
        t.equal(gate.status, 401, "the dashboard address without its password");
        t.matches(gate.headers.get("www-authenticate") || "", /^Basic /i, "the dashboard's password prompt");
        const man = t.json(await t.get(`${PROD_DASHBOARD}/manifest.json`));
        t.fields(man, ["name", "start_url", "icons"], "the dashboard's app manifest (public by design)");
      }
      const html = t.html(await t.get("/dashboard/"), { mustContain: [/<div id="root"/] });
      t.matches(H.title(html), /Still Afloat/, "the dashboard page title");
      const main = H.scripts(html).find((s) => /\/assets\/index-[\w-]+\.js$/.test(s));
      t.ok(main, "the dashboard page names no main program (assets/index-*.js)");
      const jsPath = main.startsWith("/dashboard/") ? main : `/dashboard${main}`;
      const js = await t.get(jsPath);
      t.status(js, 200);
      t.matches(js.headers.get("content-type") || "", /javascript/, "the dashboard program's content type");
      t.atLeast(js.text.length, 200_000, "size of the dashboard program in bytes");
      // Every data address the ops pages read (Overview, Finance, Subscriptions, Search, AI Visibility,
      // Groups). A stale or partial dashboard build on a box drops one of these while the API is fine.
      // (Group MARKETING's addresses are checked in ops.group-marketing-dashboard: dev-only until the
      // 2026-10-08 promotion.)
      for (const needle of ["/api/auth-check", "x-affiliate-token", "/api/ai-visibility", "/api/social-analytics",
        "/api/ops/finance/summary", "/api/ops/finance/cashflow", "/api/ops/finance/transactions", "/api/ops/finance/subscriptions",
        "/api/ops/youtube-analytics", "/api/ops/gsc/analytics", "/api/ops/seo-proposals", "/groups/intake", "/payment-schedule", "horizon=3650"]) {
        t.ok(js.text.includes(needle), `the dashboard program no longer mentions ${needle} — a page of the dashboard is unwired`);
      }
      t.observe("dashboard title", H.title(html));

      // The Today page (brief.html) is the one place calendar conflicts are decided. It is served from
      // the server's copy (dashboard/public) on the site origin AND from the dashboard build on the
      // dashboard host (prod, no password by design). The two must be the same file — a different one
      // means the dashboard build on the box is stale.
      const brief = t.html(await t.get("/brief.html"), { mustContain: ["/api/ops/conflicts", "/api/ops/resolve-conflict"] });
      if (t.mode === "prod") {
        const built = t.html(await t.get(`${PROD_DASHBOARD}/brief.html`));
        t.ok(built === brief, `the Today page on the dashboard address (${built.length} bytes) is not the server's copy (${brief.length} bytes) — the dashboard build on prod is out of date`);
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.ops-manager-health",
    title: "The ops manager (finance, calendar, Gmail, analytics service) is up, has its Gmail and push keys, and refuses callers without its key",
    covers: ["ext:ops-manager-health"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const h = t.success(await t.get("/health", { service: "ops" }), "ok");
      t.equal(h.gmail_token_present, true, "the ops manager's Gmail sign-in is present");
      t.equal(h.push_configured, true, "the ops manager's API key is configured");
      t.ok(Number.isInteger(h.pending_actions) && h.pending_actions >= 0, `the ops manager's pending-action count is not a count: ${h.pending_actions}`);
      // Its finance data must never answer without the key (the site proxies with it; browsers never see it).
      refused(t, await t.get("/finance/summary", { service: "ops" }), 401, "the ops manager's finance summary with no key", /invalid api key/i);
      refused(t, await t.get("/finance/subscriptions", { service: "ops", headers: { "x-api-key": "e2e-wrong-key" } }), 401,
        "the ops manager's subscriptions with a wrong key", /invalid api key/i);
      t.observe("health keys", keysOf(h));
      t.observe("gmail token present", h.gmail_token_present);
      t.observe("pending actions", h.pending_actions, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.social-pulse-matches-stats",
    title: "The dashboard's social panel shows the same Instagram follower count the 12-hourly stats feed recorded, and that feed is fresh",
    covers: ["GET /api/social-analytics", "GET /api/social/stats", "GET /api/ops/social-analytics"],
    modes: ["dev", "prod"],
    incident: "2026-09-06: POST /api/social/ingest defined twice; the Overview panel's snapshot has never been written since",
    run: async (t) => {
      const stats = t.success(await t.get("/api/social/stats", { auth: true }));
      t.ok(Array.isArray(stats.items), "the follower stats series is missing");
      t.fields(stats.summary, ["snapshots", "followers"], "the follower stats summary");
      t.equal(stats.summary.snapshots, stats.items.length, "the stats summary's snapshot count vs the series");
      t.atLeast(stats.items.length, 1, "follower stats snapshots");
      for (const s of spread(stats.items)) t.ok(Number.isFinite(Date.parse(s.at)), "a stats snapshot has no readable time");
      const ig = stats.summary.followers?.instagram?.latest;
      t.ok(Number.isInteger(ig), `the stats feed has no Instagram follower count (${ig})`);
      t.equal(stats.summary.latestAt, stats.items.map((s) => s.at).sort().at(-1), "the stats summary's latest time vs the newest snapshot");

      // The ops manager's own Graph-API pulse (no Meta token by design: the developer app is blocked).
      const opsPulse = t.json(await t.get("/api/ops/social-analytics", { auth: true }));
      for (const p of ["facebook", "instagram"]) {
        t.ok(opsPulse[p] && typeof opsPulse[p].connected === "boolean", `the ops manager's ${p} pulse has no connected flag`);
        if (!opsPulse[p].connected) t.ok(typeof opsPulse[p].reason === "string" && opsPulse[p].reason.length > 0, `the ops manager's ${p} pulse is off with no reason`);
      }

      // What the dashboard's Overview page actually shows (pages/overview.tsx → /api/social-analytics).
      const pulse = t.json(await t.get("/api/social-analytics", { auth: true }));
      t.ok(pulse.instagram && typeof pulse.instagram === "object", "the dashboard's social panel has no Instagram block");
      t.ok(pulse.instagram.connected === true,
        `the dashboard's social panel says Instagram is not connected ("${String(pulse.instagram.reason || "").slice(0, 80)}") while the stats feed holds ${stats.items.length} snapshots — the ingest route that runs (social.ts) stores a list of snapshots under the same key, and the panel looks for a single "latest" snapshot that is never written`);
      t.equal(pulse.instagram.followers, ig, "Instagram followers: dashboard panel vs the stats feed");
      // the panel shows the feed's newest snapshot; whether THAT is fresh is judged below, per box
      t.equal(pulse.updated_at, stats.summary.latestAt, "the dashboard social panel's snapshot time vs the feed's newest");
      // A real account's follower count is not zero for a month: zero means the feed reads the wrong thing.
      const igSeen = stats.items.filter((s) => Number.isInteger(s.instagram?.followers));
      t.ok(ig > 0, `every one of the ${igSeen.length} Instagram snapshots since ${String(stats.summary.firstAt).slice(0, 10)} reports 0 followers — the Make "Social Stats" scenario is not reading the real count`);

      t.observe("stats keys", keysOf(stats));
      t.observe("stats snapshots", stats.items.length, "min");
      t.observe("facebook followers recorded", stats.summary.followers?.facebook?.latest != null);
      t.observe("ops-manager pulse connected", `fb=${opsPulse.facebook?.connected},ig=${opsPulse.instagram?.connected}`);
      // Prod: the Make scenario posts every 12 hours, so a snapshot older than 26 hours means the feed
      // has STOPPED — a failure. Dev does not receive the Make scenario's snapshots at all; that is a
      // missing condition (UNTESTABLE), not a pass.
      const ageH = (t.now() - Date.parse(stats.summary.latestAt)) / 3_600_000;
      if (t.mode === "prod") t.fresh(stats.summary.latestAt, 26, "the newest follower snapshot from the Make \"Social Stats\" scenario (every 12 hours)");
      else t.require(ageH <= 26, `the newest follower snapshot is ${ageH.toFixed(0)} hours old: this box is not receiving the Make "Social Stats" snapshots (every 12 hours on prod)`);
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.social-queue-and-review",
    title: "The social review queue holds English and Spanish drafts, and the review page shows exactly the drafts waiting for Mark",
    covers: ["GET /api/social/queue", "GET /api/social/review"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const q = t.success(await t.get("/api/social/queue", { auth: true }));
      t.ok(Array.isArray(q.batches), "the social queue has no batches array");
      t.equal(q.count, q.batches.length, "the social queue's count vs its list");
      t.atLeast(q.batches.length, 1, "social batches in the queue");
      t.equal(new Set(q.batches.map((b) => b.id)).size, q.batches.length, "distinct social batch ids");
      for (const b of q.batches) {
        t.fields(b, ["id", "videoId", "title", "track", "lang", "status", "createdAt"], `social batch ${b?.id}`);
        t.ok(["A", "B"].includes(b.track), `social batch ${b.id} has an unknown track "${b.track}"`);
        t.ok(["en", "es"].includes(b.lang), `social batch ${b.id} has an unknown language "${b.lang}"`);
        t.ok(BATCH_STATUSES.includes(b.status), `social batch ${b.id} has an unknown status "${b.status}"`);
        t.ok(Array.isArray(b.posts) && b.posts.length > 0, `social batch ${b.id} has no posts`);
      }
      for (const b of spread(q.batches)) for (const p of b.posts) {
        t.fields(p, ["platform", "surface", "caption", "link"], `a post in social batch ${b.id}`);
      }
      const langs = new Set(q.batches.map((b) => b.lang));
      t.ok(langs.has("en") && langs.has("es"), `the social queue is missing a language (has ${[...langs].join(", ")}) — Spanish is first-class`);

      // Where the posts send people. A Spanish post must land on a Spanish page and an English post on
      // an English one, on our own site; and every page a post links to must really open on this box
      // (not the home-page fallback the server gives an unknown path). The handful of distinct pages
      // is visited, never every post (utm tags are stripped; nothing about the post is printed).
      const dests = new Map(); // path → lang
      for (const b of q.batches) for (const p of b.posts) {
        let u; try { u = new URL(p.link); } catch { t.ok(false, `a post in social batch ${b.id} has an unreadable link`); }
        t.equal(u.host, "stillafloatcruising.com", `the site a post in social batch ${b.id} links to`);
        t.ok(b.lang === "es" ? u.pathname.startsWith("/es/") : !u.pathname.startsWith("/es/"),
          `a ${b.lang === "es" ? "Spanish" : "English"} post in social batch ${b.id} links to ${u.pathname}, a page in the other language`);
        if (!dests.has(u.pathname)) dests.set(u.pathname, b.lang);
      }
      t.atLeast(dests.size, 2, "distinct pages the social posts link to");
      const homeTitle = H.title(t.html(await t.get("/")));
      for (const [path, lang] of [...dests].slice(0, 8)) {
        const page = t.html(await t.get(path));
        t.equal(H.htmlLang(page).slice(0, 2), lang, `language of ${path}, a page the ${lang === "es" ? "Spanish" : "English"} posts link to`);
        if (path !== "/" && path !== "/es/") t.ok(H.title(page) !== homeTitle, `${path}, which the social posts link to, does not exist on this box (the server answered with the home page)`);
      }
      t.observe("pages the social posts link to", [...dests.keys()].sort().join(","), "info");

      const pending = q.batches.filter((b) => b.status === "pending");
      const html = t.html(await t.get("/api/social/review", { auth: true }), { mustContain: ["Still Afloat — Social Review", "/api/social/queue/", "/api/social/share", "/api/social/schedule"] });
      t.equal(count(html, /<div class="batch" id="b-/g), pending.length, "drafts on the review page vs pending drafts in the queue");
      if (pending.length === 0) t.ok(html.includes("No pending batches"), "the review page with nothing pending does not say so");
      for (const b of pending.slice(0, 5)) t.ok(html.includes(`id="b-${b.id}"`), `pending draft ${b.id} is not on the review page`);

      t.observe("batch keys", keysOf(q.batches[0]));
      t.observe("social batches", q.batches.length, "min");
      t.observe("pending drafts", pending.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.social-calendar",
    title: "The posting calendar (data and page) matches the approved batches, follows the posting times, and no post is stuck past the 7-day retry rule",
    covers: ["GET /api/social/schedule", "GET /api/social/schedule-config", "GET /api/social/queue"],
    modes: ["dev", "prod"],
    incident: "2026-09-06: Instagram posts with no clip sat 'scheduled' forever",
    run: async (t) => {
      const cfg = t.success(await t.get("/api/social/schedule-config", { auth: true })).config;
      t.fields(cfg, ["tz", "times"], "the posting-time settings");
      let tzOk = true; try { new Intl.DateTimeFormat("en-US", { timeZone: cfg.tz }); } catch { tzOk = false; }
      t.ok(tzOk, `the posting time zone "${cfg.tz}" is not a real time zone`);
      t.ok(Array.isArray(cfg.times) && cfg.times.length > 0 && cfg.times.every((x) => /^\d{1,2}:\d{2}$/.test(x)), `the posting times are not HH:MM (${JSON.stringify(cfg.times)})`);
      t.ok(Number.isFinite(cfg.leadMinutes), "the posting lead time is not a number");

      const q = t.success(await t.get("/api/social/queue", { auth: true }));
      const byId = new Map((q.batches || []).map((b) => [b.id, b]));
      const s = t.success(await t.get("/api/social/schedule?format=json", { auth: true }));
      t.ok(Array.isArray(s.items), "the posting calendar has no items array");
      t.equal(s.count, s.items.length, "the posting calendar's count vs its list");
      let stuck = 0;
      for (const it of s.items) {
        const b = byId.get(it.batchId);
        t.ok(b, `a calendar post points at batch ${it.batchId}, which is not in the queue`);
        t.ok(["scheduled", "posted"].includes(b.status), `a calendar post belongs to batch ${it.batchId}, whose status is "${b.status}"`);
        t.ok(["instagram", "facebook"].includes(it.platform), `a calendar post has an unknown platform "${it.platform}"`);
        t.ok(!it.postState || POST_STATES.includes(it.postState), `a calendar post has an unknown state "${it.postState}"`);
        const when = it.scheduledFor || it.postedAt;
        t.ok(Number.isFinite(Date.parse(when)), `a calendar post in batch ${it.batchId} has no readable time`);
        if ((!it.postState || it.postState === "scheduled") && daysOld(t, it.scheduledFor) > 7.5) stuck++;
      }
      t.equal(stuck, 0, "calendar posts still 'scheduled' more than 7½ days after their slot (the poster resolves these at 7 days — it is not running)");

      const html = t.html(await t.get("/api/social/schedule", { auth: true }), { mustContain: ["Still Afloat — Posting Calendar"] });
      t.equal(count(html, /<div class="row">/g), s.items.length, "rows on the calendar page vs posts in the calendar data");
      t.ok(html.includes(cfg.times.join(", ")) && html.includes(cfg.tz), "the calendar page does not show the configured posting times");
      // Each row's badge must say what really happened to that post. The poster marks posts it will
      // never send as "skipped" (Instagram language off, or no clip after 7 days, since 2026-07-08);
      // a page that shows those as "scheduled" tells Mark dozens of posts are still coming.
      const byState = (st) => s.items.filter((it) => (it.postState || "scheduled") === st).length;
      const badges = { posted: count(html, /class="st posted"/g), failed: count(html, /class="st failed"/g), sched: count(html, /class="st sched"/g), skipped: count(html, /class="st skipped"/g) };
      t.equal(badges.posted, byState("posted"), "posts shown as posted on the calendar page vs posted in the data");
      t.equal(badges.failed, byState("failed"), "posts shown as failed on the calendar page vs failed in the data");
      t.ok(badges.sched === byState("scheduled"),
        `the calendar page shows ${badges.sched} posts as "scheduled" but only ${byState("scheduled")} are still waiting to be posted (${byState("skipped")} were skipped by the poster and will never be sent)`);

      const overdue = s.items.filter((it) => (!it.postState || it.postState === "scheduled") && daysOld(t, it.scheduledFor) > 0.1).length;
      const posted = s.items.filter((it) => it.postState === "posted").map((it) => it.postedAt || it.scheduledFor).sort();
      t.observe("calendar item keys", s.items[0] ? keysOf(s.items[0]) : "(empty)", s.items[0] ? "exact" : "info");
      t.observe("schedule config", `${cfg.tz} ${cfg.times.join(",")} lead ${cfg.leadMinutes}`);
      t.observe("calendar posts", s.items.length, "info");
      t.observe("posts waiting past their slot (retrying)", overdue, "info");
      t.observe("days since last post", posted.length ? Number(daysOld(t, posted.at(-1)).toFixed(1)) : null, "info");
      // Dev runs with DISABLE_SOCIAL_POSTER=1 and a test queue: no calendar → nothing above was exercised.
      t.require(s.items.length > 0, "the posting calendar is empty on this box, so the calendar, its page and the stuck-post rule cannot be tested (seed an approved fixture batch on dev)");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.social-share-kit",
    title: "The one-tap Share Kit lists every approved or pending social batch with a WhatsApp button",
    covers: ["GET /api/social/share"],
    modes: ["dev"],
    devOnlyBecause: "GET /api/social/share is on the release gate's never-call-on-prod list (its handler reads only, per server/src/routes/social.ts, but the list is obeyed)",
    run: async (t) => {
      const q = t.success(await t.get("/api/social/queue", { auth: true }));
      t.ok(Array.isArray(q.batches) && q.batches.length > 0, "the social queue is empty");
      const shown = q.batches.filter((b) => b.status !== "rejected");
      const html = t.html(await t.get("/api/social/share", { auth: true }), { mustContain: ["Share Kit"] });
      t.equal(count(html, /<div class="card">/g), shown.length, "cards in the Share Kit vs non-rejected batches in the queue");
      t.equal(count(html, /href="https:\/\/wa\.me\/\?text=/g), shown.length, "WhatsApp buttons in the Share Kit");
      for (const b of shown.slice(0, 3)) t.ok(html.includes(`id="cap-${b.id}"`), `batch ${b.id} is missing from the Share Kit`);
      // What a WhatsApp tap forwards: the caption plus a link people can open (checked, never printed).
      const texts = [...html.matchAll(/href="https:\/\/wa\.me\/\?text=([^"]+)"/g)].map((m) => { try { return decodeURIComponent(m[1]); } catch { return ""; } });
      for (const txt of spread(texts)) t.ok(txt.length > 20 && /https:\/\/\S+/.test(txt), "a Share Kit WhatsApp button forwards no caption or no link");
      t.observe("share kit cards", shown.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.social-clip-tools",
    title: "The Reel clip library points at real video files, and the clip uploader and hook composer pages load wired to the API",
    covers: ["GET /api/social/media", "GET /api/social/config", "GET /api/social/upload", "GET /api/social/compose"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const m = t.success(await t.get("/api/social/media", { auth: true }));
      const items = Object.entries(m.items || {});
      t.atLeast(items.length, 1, "registered Reel clips");
      const hosts = new Set();
      for (const [vid, it] of items) {
        t.fields(it, ["videoUrl", "addedAt"], `clip ${vid}`);
        t.matches(it.videoUrl, /^https:\/\//, `clip ${vid} address`);
        t.ok(!it.lang || ["en", "es"].includes(it.lang), `clip ${vid} has an unknown language "${it.lang}"`);
        try { hosts.add(new URL(it.videoUrl).host); } catch { t.ok(false, `clip ${vid} has an unreadable address`); }
      }
      // The newest clip must really be a video file (first kilobyte only).
      // A spread of clips (oldest, middle, newest) must really be video files (first kilobyte only):
      // the Instagram poster hands these addresses to Instagram, which fetches them itself.
      items.sort((a, b) => String(a[1].addedAt).localeCompare(String(b[1].addedAt)));
      for (const [vid, it] of spread(items)) {
        const file = await t.get(it.videoUrl, { headers: { range: "bytes=0-1023" } });
        t.ok(file.status === 200 || file.status === 206, `clip ${vid} does not download: HTTP ${file.status}`);
        t.matches(file.headers.get("content-type") || "", /^video\//, `clip ${vid} content type`);
      }
      // Clips hosted on our own bucket (2026-09-06 onward) carry their language and bucket path.
      for (const [vid, it] of items.filter(([, it]) => it.source === "supabase")) {
        t.ok(["en", "es"].includes(it.lang) && typeof it.path === "string" && it.videoUrl.endsWith(it.path), `clip ${vid} (our bucket) has no language or its address does not match its bucket path`);
      }

      const cfg = t.success(await t.get("/api/social/config", { auth: true }));
      t.nonEmpty(cfg.cloudName, "the uploader's Cloudinary account name");
      const up = t.html(await t.get("/api/social/upload", { auth: true }), { mustContain: ["Clip Uploader", "/api/social/config", "/api/social/media"] });
      t.ok(up.includes("noindex"), "the clip uploader page is not marked noindex");
      const comp = t.html(await t.get("/api/social/compose", { auth: true }), { mustContain: ["Compose", "/api/social/generate", "/api/social/review"] });
      t.ok(comp.includes("noindex"), "the hook composer page is not marked noindex");

      t.observe("clips registered", items.length, "min");
      t.observe("clip hosts", [...hosts].sort().join(","));
      t.observe("cloudinary preset configured", cfg.uploadPreset != null);
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.ai-visibility",
    title: "The AI Visibility page has this week's AI-assistant lookups, the crawler counts and the agent's activity log",
    covers: ["GET /api/ai-visibility"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const v = t.success(await t.get("/api/ai-visibility", { auth: true }));
      t.fields(v, ["updatedAt", "lookups", "activity"], "the AI visibility data");
      const L = t.fields(v.lookups, ["generatedAt", "weeks", "crawlers"], "the AI lookups");
      t.fresh(L.generatedAt, 30, "the AI lookups (rebuilt daily at 14:00 UTC)");
      t.atLeast(L.weeks.length, 4, "weeks of AI lookups");
      for (const w of L.weeks) {
        t.matches(w.weekStart, /^\d{4}-\d{2}-\d{2}$/, "a lookup week's start");
        t.ok(w.assistants && typeof w.assistants === "object" && Object.keys(w.assistants).length > 0, `lookup week ${w.weekStart} has no assistant counts`);
        t.ok(Object.values(w.assistants).every((n) => Number.isInteger(n) && n >= 0), `lookup week ${w.weekStart} has a count that is not a count`);
      }
      const newestWeek = L.weeks.map((w) => w.weekStart).sort().at(-1);
      t.ok(daysOld(t, `${newestWeek}T00:00:00Z`) < 8, `the newest lookup week starts ${newestWeek} — the weekly roll-up has stopped`);
      t.ok(Object.keys(L.crawlers).length >= 3, "the crawler counts list fewer than 3 crawlers");
      t.ok(Object.values(L.crawlers).every((n) => Number.isInteger(n) && n >= 0) && Object.values(L.crawlers).some((n) => n > 0), "the crawler counts are all zero or not counts");
      for (const w of L.weeks) for (const p of w.topPages || []) {
        t.ok(typeof p.path === "string" && p.path.startsWith("/") && typeof p.assistant === "string" && Number.isInteger(p.count) && p.count > 0, `lookup week ${w.weekStart} lists a top page with no path, assistant or count`);
      }
      t.observe("lookup week keys", keysOf(L.weeks.at(-1)));
      t.atLeast(v.activity.length, 1, "entries in the agent's activity log");
      for (const a of v.activity) {
        t.ok(ACTIVITY_KINDS.includes(a.kind), `an activity entry has an unknown kind "${a.kind}"`);
        t.ok(ACTIVITY_STATUSES.includes(a.status), `an activity entry has an unknown status "${a.status}"`);
        t.ok(Number.isFinite(Date.parse(a.at)) && typeof a.title === "string" && a.title.trim(), "an activity entry has no time or title");
      }
      t.observe("keys", keysOf(v));
      t.observe("lookup keys", keysOf(L));
      t.observe("lookup weeks", L.weeks.length, "min");
      t.observe("crawlers tracked", Object.keys(L.crawlers).length, "min");
      t.observe("activity entries", v.activity.length, "min");
      // "Has this week's AI-assistant lookups": four weeks of all-zero counts is what a broken log
      // reader looks like (it is also what dev looks like — dev gets no assistant traffic, so there it
      // is a missing condition, not a pass). Last, so every shape assertion above runs on both boxes.
      const lookups = L.weeks.reduce((n, w) => n + Object.values(w.assistants).reduce((a, b) => a + b, 0), 0);
      t.observe("assistant lookups in the window", lookups, "info");
      if (t.mode === "prod") t.ok(lookups > 0, `every AI-assistant lookup count in the last ${L.weeks.length} weeks is zero — the lookup roll-up is not reading the site's logs`);
      else t.require(lookups > 0, `every AI-assistant lookup count on this box is zero (dev gets no AI-assistant traffic), so the lookup counts cannot be told apart from a broken log reader`);
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.finance-pages",
    title: "The Finance pages show this month's totals, the transactions, cash flow and subscriptions — and the totals agree with the transactions behind them",
    covers: ["GET /api/ops/finance/summary", "GET /api/ops/finance/transactions", "GET /api/ops/finance/cashflow", "GET /api/ops/finance/subscriptions"],
    modes: ["dev", "prod"],
    run: async (t) => {
      // Amounts are compared, never recorded.
      const month = new Date(t.now()).toISOString().slice(0, 7);
      const sum = t.success(await t.get("/api/ops/finance/summary", { auth: true }), "ok");
      t.equal(sum.month, month, "the finance summary's month");
      for (const k of ["total_expense", "total_income", "net", "count"]) t.ok(Number.isFinite(sum[k]), `the finance summary's ${k} is not a number`);
      t.ok(Math.abs(sum.net - (sum.total_income - sum.total_expense)) < 0.02, "the finance summary's net is not income minus expenses");

      const tx = t.success(await t.get("/api/ops/finance/transactions?limit=200", { auth: true }), "ok");
      t.ok(Array.isArray(tx.transactions), "the transactions list is missing");
      t.equal(tx.count, tx.transactions.length, "the transactions count vs its list");
      for (const x of tx.transactions) {
        t.fields(x, ["id", "direction", "status", "created_at"], `transaction ${x?.id}`);
        t.ok(["expense", "income"].includes(x.direction), `transaction ${x.id} has an unknown direction "${x.direction}"`);
        t.ok(x.amount === null || Number.isFinite(x.amount), `transaction ${x.id} has an amount that is not a number`);
      }
      if (tx.transactions.length < 200) {
        // the list is the whole recent ledger, so it must account for the month's summary
        const inMonth = tx.transactions.filter((x) => String(x.txn_date || "").startsWith(month) && x.status !== "void");
        t.equal(inMonth.length, sum.count, "this month's transactions: summary count vs the transactions list");
      }

      // The category breakdown (Overview + Finance pie) must add up to the month's expenses.
      t.ok(sum.by_category && typeof sum.by_category === "object", "the finance summary has no category breakdown");
      t.ok(Math.abs(Object.values(sum.by_category).reduce((a, b) => a + b, 0) - sum.total_expense) < 0.05, "this month's categories do not add up to this month's expenses");
      // The list is newest first by transaction date (the Finance page's "Recent transactions").
      const dated = tx.transactions.map((x) => x.txn_date).filter(Boolean);
      t.ok(dated.every((d, i) => i === 0 || dated[i - 1] >= d), "the transactions list is not newest first");
      // The Finance page asks for 25: that must be the first 25 of the same list.
      const page25 = t.success(await t.get("/api/ops/finance/transactions?limit=25", { auth: true }), "ok");
      // (Rows with the same date may come back in either order, so the comparison is by membership,
      // count and the date cut-off, not by exact position.)
      const allIds = new Set(tx.transactions.map((x) => x.id));
      t.equal(page25.transactions.length, Math.min(25, tx.transactions.length), "transactions on the Finance page (asks for 25)");
      t.ok(page25.transactions.every((x) => allIds.has(x.id)), "the Finance page shows a transaction that is not in the full list");
      const cutoff = tx.transactions[Math.min(25, tx.transactions.length) - 1]?.txn_date;
      if (cutoff) t.ok(page25.transactions.every((x) => !x.txn_date || x.txn_date >= cutoff), "the Finance page's 25 are not the most recent transactions");

      const cf = t.success(await t.get("/api/ops/finance/cashflow?months=7", { auth: true }), "ok");
      t.ok(Array.isArray(cf.series) && cf.series.length <= 7, "the cash-flow series is missing or longer than asked");
      for (const s of cf.series) t.matches(s.month, /^\d{4}-\d{2}$/, "a cash-flow month");
      if (sum.count > 0) {
        const cur = cf.series.find((s) => s.month === month);
        t.ok(cur, "the cash-flow chart has no bar for this month although the summary has transactions");
        t.ok(Math.abs(cur.expense - sum.total_expense) < 0.02 && Math.abs(cur.income - sum.total_income) < 0.02, "this month: the cash-flow bar and the summary totals disagree");
      }
      if (tx.transactions.length < 200) {
        // Every bar in the window against the transactions behind it (the list is the whole ledger).
        const now = new Date(t.now());
        const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1)).toISOString().slice(0, 7); // 7-month window
        const want = new Map();
        for (const x of tx.transactions) {
          if (!x.txn_date || x.status === "void") continue;
          const m = x.txn_date.slice(0, 7);
          if (m < first || m > month) continue;
          const w = want.get(m) || { expense: 0, income: 0 };
          w[x.direction === "income" ? "income" : "expense"] += Number(x.amount) || 0;
          want.set(m, w);
        }
        for (const [m, w] of want) {
          const bar = cf.series.find((s) => s.month === m);
          t.ok(bar, `the cash-flow chart has no bar for ${m} although the ledger has transactions dated then`);
          t.ok(Math.abs(bar.expense - w.expense) < 0.05 && Math.abs(bar.income - w.income) < 0.05, `${m}: the cash-flow bar and the transactions behind it disagree`);
        }
      }
      // The projection (Finance page) is the average of the last three bars, and a year is twelve months.
      const last3 = cf.series.slice(-3).map((s) => s.expense);
      t.ok(Number.isFinite(cf.projected_monthly_spend) && Math.abs(cf.projected_monthly_spend - (last3.length ? last3.reduce((a, b) => a + b, 0) / last3.length : 0)) < 0.02, "the projected monthly spend is not the average of the last three months");
      t.ok(Math.abs(cf.projected_yearly_spend - cf.projected_monthly_spend * 12) < 0.12, "the projected yearly spend is not twelve months");

      const subs = t.success(await t.get("/api/ops/finance/subscriptions", { auth: true }), "ok");
      t.ok(Array.isArray(subs.subscriptions), "the subscriptions list is missing");
      t.equal(subs.count, subs.subscriptions.length, "the subscriptions count vs its list");
      t.equal(subs.active_count, subs.subscriptions.filter((s) => s.status === "active").length, "active subscriptions: the count vs the list");
      for (const s of subs.subscriptions) t.fields(s, ["id", "vendor", "cadence", "status"], `subscription ${s?.id}`);
      t.ok(Number.isFinite(subs.monthly_burn) && Math.abs(subs.annual_burn - subs.monthly_burn * 12) < 0.12, "the yearly subscription cost is not twelve months");
      // The monthly burn (Subscriptions page + Overview) is the active subscriptions normalised to a month.
      const PER_MONTH = { monthly: 1, annual: 1 / 12, quarterly: 1 / 3, weekly: 52 / 12, other: 1 };
      const burn = subs.subscriptions.filter((s) => s.status === "active").reduce((n, s) => n + Math.round((Number(s.amount) || 0) * (PER_MONTH[s.cadence] ?? 1) * 100) / 100, 0);
      t.ok(Math.abs(subs.monthly_burn - burn) < 0.05, "the monthly subscription burn does not match the active subscriptions behind it");

      t.observe("summary keys", keysOf(sum));
      t.observe("transaction keys", tx.transactions[0] ? keysOf(tx.transactions[0]) : "(none)", tx.transactions[0] ? "exact" : "info");
      t.observe("transactions listed", tx.transactions.length, "min");
      t.observe("subscriptions", subs.subscriptions.length, "info");
      t.observe("cash-flow months", cf.series.length, "info");
      // Freshness last, so every agreement above is checked first.
      t.require(tx.transactions.length > 0 && subs.subscriptions.length > 0,
        "this box's finance tables are empty (no transactions, no subscriptions), so none of the finance pages' data can be tested — dev's database is not a copy of prod's");
      const newest = tx.transactions.map((x) => x.created_at).sort().at(-1);
      t.observe("days since the last captured transaction", Number(daysOld(t, newest).toFixed(1)), "info");
      t.fresh(newest, 14 * 24, "the newest captured transaction (finance capture runs from the receipts inbox)");
    },
  },
  {
    id: "ops.finance-every-receipt-complete",
    title: "Every transaction captured in the last 30 days has a date and an amount, so it counts in the monthly totals and the cash-flow chart",
    covers: ["GET /api/ops/finance/transactions"],
    modes: ["dev", "prod"],
    incident: "2026-09-30: receipts captured with no transaction date (or no amount) are invisible to every monthly figure",
    run: async (t) => {
      const tx = t.success(await t.get("/api/ops/finance/transactions?limit=200", { auth: true }), "ok");
      t.ok(Array.isArray(tx.transactions), "the transactions list is missing");
      const recent = tx.transactions.filter((x) => daysOld(t, x.created_at) <= 30 && x.status !== "void");
      t.require(recent.length > 0, "no transaction was captured in the last 30 days on this box, so dating cannot be checked");
      const undated = recent.filter((x) => !x.txn_date).length;
      const noAmount = recent.filter((x) => !Number.isFinite(x.amount)).length;
      t.observe("undated transactions in the list", tx.transactions.filter((x) => !x.txn_date).length, "info");
      t.observe("transactions with no amount in the list", tx.transactions.filter((x) => !Number.isFinite(x.amount)).length, "info");
      t.ok(undated === 0 && noAmount === 0,
        `of ${recent.length} transactions captured in the last 30 days, ${undated} have no date and ${noAmount} have no amount — they are missing from this month's totals and the cash-flow chart`);
    },
  },
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.youtube-analytics",
    title: "The dashboard's YouTube numbers are current (views, watch time, subscribers by day) and the totals add up",
    covers: ["GET /api/ops/youtube-analytics"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const res = await t.get("/api/ops/youtube-analytics?days=28", { auth: true });
      if (res.status === 503) t.require(false, `the ops manager on this box is not authorised for YouTube Analytics ("${String(res.json?.detail || "").slice(0, 80)}"), so the YouTube panel cannot be tested`);
      const yt = t.success(res, "ok");
      t.equal(yt.period_days, 28, "the YouTube period");
      t.atLeast(yt.daily.length, 20, "days of YouTube data in a 28-day window");
      for (const d of yt.daily) {
        t.matches(d.date, /^\d{4}-\d{2}-\d{2}$/, "a YouTube day");
        t.ok([d.views, d.minutes, d.subs_gained, d.subs_lost].every((n) => Number.isInteger(n) && n >= 0), `YouTube ${d.date} has a count that is not a count`);
      }
      const last = yt.daily.map((d) => d.date).sort().at(-1);
      t.ok(daysOld(t, `${last}T00:00:00Z`) <= 4, `the newest YouTube day is ${last} — the analytics feed has stalled`);
      t.equal(yt.totals.views, yt.daily.reduce((n, d) => n + d.views, 0), "YouTube views: total vs the sum of the days");
      t.ok(Math.abs(yt.totals.watch_hours - yt.daily.reduce((n, d) => n + d.minutes, 0) / 60) <= 0.1, "YouTube watch hours: total vs the sum of the days");
      t.atLeast(yt.totals.views, 1, "YouTube views in 28 days");
      // The Overview's subscriber figure: each day's net is gained minus lost, and the total is their sum.
      t.ok(yt.daily.every((d) => d.subs_net === d.subs_gained - d.subs_lost), "a YouTube day's net subscribers is not gained minus lost");
      t.equal(yt.totals.subs_gained, yt.daily.reduce((n, d) => n + d.subs_net, 0), "YouTube subscribers: total vs the sum of the days");
      t.ok(Number.isInteger(yt.totals.avg_view_seconds) && yt.totals.avg_view_seconds > 0 && yt.totals.avg_view_seconds < 3600, `the average view length (${yt.totals.avg_view_seconds} s) is not plausible`);
      t.observe("keys", keysOf(yt));
      t.observe("days returned", yt.daily.length, "info");
    },
  },
  {
    id: "ops.search-console",
    title: "The SEO cockpit has current Google Search Console numbers for stillafloatcruising.com and its proposals list loads",
    covers: ["GET /api/ops/gsc/analytics", "GET /api/ops/seo-proposals"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const p = t.success(await t.get("/api/ops/seo-proposals", { auth: true }), "ok");
      t.ok(Array.isArray(p.proposals), "the SEO proposals list is missing");
      for (const x of p.proposals) t.fields(x, ["id", "title", "created_at"], `SEO proposal ${x?.id}`);
      t.observe("open SEO proposals", p.proposals.length, "info");

      const res = await t.get("/api/ops/gsc/analytics?days=28", { auth: true });
      if (res.status === 503) t.require(false, `the ops manager on this box is not authorised for Search Console ("${String(res.json?.detail || "").slice(0, 80)}"), so the SEO cockpit cannot be tested`);
      const g = t.success(res, "ok");
      t.equal(g.property, "https://stillafloatcruising.com/", "the Search Console property");
      // The SEO cockpit asks for 28 and 90 days (pages/search.tsx); the longer window must hold at
      // least as much as the shorter one, and both must end on the same day.
      const g90 = t.success(await t.get("/api/ops/gsc/analytics?days=90", { auth: true }), "ok");
      // (each window is cached 30 minutes on its own, so across midnight the two may end a day apart)
      t.ok(Math.abs(Date.parse(g90.end) - Date.parse(g.end)) <= DAY, `the 90-day Search Console window ends ${g90.end} but the 28-day one ends ${g.end}`);
      t.ok(g90.totals.impressions >= g.totals.impressions && g90.totals.clicks >= g.totals.clicks, "the 90-day Search Console totals are smaller than the 28-day totals");
      t.ok(g90.trend.length >= g.trend.length, "the 90-day Search Console trend is shorter than the 28-day trend");
      t.ok(daysOld(t, `${g.end}T00:00:00Z`) <= 4, `the Search Console window ends ${g.end} — the data has stalled`);
      t.atLeast(g.trend.length, 14, "days in the Search Console trend");
      t.atLeast(g.totals.impressions, 1, "Search Console impressions in the window");
      t.nonEmpty(g.top_pages, "Search Console top pages");
      for (const pg of g.top_pages) t.matches(pg.page, /^https:\/\/(www\.)?stillafloatcruising\.com\//, "a Search Console top page");
      t.nonEmpty(g.top_queries, "Search Console top queries");
      t.observe("keys", keysOf(g));
      t.observe("trend days", g.trend.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.calendar-conflicts",
    title: "The Today page's calendar-conflict list loads, and resolving a conflict that does not exist is refused without touching the calendar",
    covers: ["GET /api/ops/conflicts"],
    modes: ["dev"],
    devOnlyBecause: "GET /api/ops/conflicts prunes stale conflicts from the ops manager's pending store (a write), and POST /api/ops/resolve-conflict acts on Mark's calendar",
    run: async (t) => {
      const c = t.success(await t.get("/api/ops/conflicts", { auth: true }), "ok");
      t.ok(Array.isArray(c.conflicts), "the conflicts list is missing");
      // brief.html shows new_title / existing_title and resolves by key; the times are compared by Mark.
      for (const x of c.conflicts) t.fields(x, ["key", "new_title", "existing_title", "new_start"], "a calendar conflict");
      // The list and the ops manager's own pending store are the same store (the site proxies to it):
      // a list longer than the store means the site reads some other ops manager.
      const h = t.success(await t.get("/health", { service: "ops" }), "ok");
      t.ok(c.conflicts.length <= h.pending_actions, `the Today page lists ${c.conflicts.length} conflicts but the ops manager holds ${h.pending_actions} pending actions`);
      t.observe("conflicts waiting", c.conflicts.length, "info");
      // The ops manager looks the key up before it touches anything: an unknown key is a clean 404.
      refused(t, await t.send("POST", "/api/ops/resolve-conflict", { auth: true, body: { key: "e2e-fixture-no-such-conflict", choice: "1" } }), 404,
        "resolving an unknown conflict", /conflict not found/i);
      unauthorized(t, await t.send("POST", "/api/ops/resolve-conflict", { body: { key: "e2e-fixture-no-such-conflict", choice: "1" } }), "POST /api/ops/resolve-conflict");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.social-writes-refuse",
    title: "The social and AI-visibility write addresses refuse bad input and missing tokens, and a clip upload can be signed (nothing is posted, sent or generated)",
    covers: ["POST /api/social/clip/sign"],
    modes: ["dev"],
    devOnlyBecause: "it sends POSTs (refusal paths only); prod sweeps are read-only",
    run: async (t) => {
      const q = t.success(await t.get("/api/social/queue", { auth: true }));
      t.require(Array.isArray(q.batches) && q.batches.length > 0, "the social queue on this box is empty, so the approve/reject refusal cannot use a real batch id");
      const real = q.batches[0].id;
      const post = (p, body, auth = true) => t.send("POST", p, { auth, body });

      refused(t, await post("/api/social/generate", {}), 400, "generating hooks with no video", /required/i);
      // the action is checked before the batch is looked up, so a real id is safe here
      refused(t, await post(`/api/social/queue/${encodeURIComponent(real)}/e2e-not-an-action`, {}), 400, "an unknown queue action", /approve or reject/i);
      refused(t, await post("/api/social/queue/e2e-fixture-no-such-batch/reject", {}), 404, "rejecting a batch that does not exist", /not found/i);
      refused(t, await post("/api/social/media", { videoId: "e2eFixture01", videoUrl: "ftp://not-public" }), 400, "registering a clip with no public address", /videoUrl/i);
      refused(t, await post("/api/social/clip/sign", {}), 400, "signing a clip upload with no video id", /videoId/i);
      unauthorized(t, await post("/api/social/clip/sign", { videoId: "e2eFixture01", lang: "en" }, false), "POST /api/social/clip/sign");
      // The Mac publisher and Make use their own narrow keys (x-social-clip-token, x-social-stats-token);
      // a wrong one must be refused like a missing one.
      refused(t, await t.send("POST", "/api/social/clip/sign", { headers: { "x-social-clip-token": "e2e-wrong-key-not-a-secret" }, body: { videoId: "e2eFixture01", lang: "en" } }), 401,
        "signing a clip upload with a wrong publisher key", /unauthori[sz]ed/i);
      refused(t, await t.send("POST", "/api/social/ingest", { headers: { "x-social-stats-token": "e2e-wrong-key-not-a-secret" }, body: [] }), 401,
        "a stats snapshot with a wrong Make key", /unauthori[sz]ed/i);
      // Signing creates nothing: it returns a one-time upload address (never recorded).
      const signed = t.success(await post("/api/social/clip/sign", { videoId: "e2eFixture01", lang: "en" }));
      t.equal(signed.bucket, "social-clips", "the bucket a clip upload is signed for");
      t.ok(typeof signed.path === "string" && signed.path.includes("e2eFixture01"), "the signed clip path does not name the video");
      t.ok(/^https:\/\//.test(String(signed.signedUrl || "")), "the signed clip upload has no https address");
      // A clip that was never uploaded cannot be registered (answers 500 today; a 4xx would be better).
      const reg = await post("/api/social/clip/register", { videoId: "e2eFixture01", lang: "en" });
      t.ok(reg.status >= 400 && /upload it first/i.test(String(reg.json?.error || "")), `registering a clip that was never uploaded was not refused: ${reg.describe()}`);
      refused(t, await post("/api/social/ingest", []), 400, "a stats snapshot that is not an object", /object/i);
      for (const p of ["/api/social/ingest", "/api/social/notify", "/api/social/scan", "/api/social/regenerate", "/api/social/schedule-config", "/api/social/media", "/api/ops/gsc/insights/run", "/api/ai-visibility/activity"]) {
        unauthorized(t, await post(p, {}, false), `POST ${p}`);
      }
      refused(t, await post("/api/ai-visibility/activity", { kind: "e2e-not-a-kind", title: "e2e-fixture" }), 400, "an activity entry of an unknown kind", /kind must be/i);
      refused(t, await post("/api/ai-visibility/activity", { kind: "note" }), 400, "an activity entry with no title", /title is required/i);
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.groups-file",
    title: "Group files (a spread: first, middle, last) open with the same counts as the group list, the booking document is filed and downloadable, and nothing card-shaped or passport-secret is returned",
    covers: ["GET /api/groups", "GET /api/groups/:id", "GET /api/groups/intake/:id", "GET /api/groups/intake/:id/file"],
    modes: ["dev", "prod"],
    incident: "2026-10-02: group bookings — card numbers are never stored; passport data is never read back",
    run: async (t) => {
      const groups = await groupsList(t);
      t.require(groups.length > 0, "there are no group files on this box, so the group pages cannot be tested");
      for (const g of groups) {
        t.fields(g, ["id", "slug", "name", "status", "lang", "summary"], `group ${g?.id}`);
        t.ok(GROUP_STATUSES.includes(g.status), `group ${g.id} has an unknown status "${g.status}"`);
        t.ok(["en", "es", "both"].includes(g.lang), `group ${g.id} has an unknown language "${g.lang}"`);
      }
      t.ok(!cardShaped(JSON.stringify(groups)), "the group list contains something shaped like a payment card number");

      let intakes = 0;
      for (const g of spread(groups)) {
        const f = t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
        t.equal(f.group?.id, g.id, `group ${g.id}: the file opened is a different group`);
        for (const k of ["cabins", "travelers", "documents", "payments", "travel", "checklist", "messages"]) t.ok(Array.isArray(f[k]), `group ${g.id}: the file has no ${k} list`);
        for (const k of ["cabins", "travelers", "payments", "deposits", "emails", "documents", "checklist"]) {
          t.equal(JSON.stringify(f.summary?.[k]), JSON.stringify(g.summary[k]), `group ${g.id}: ${k} — the group list and the group file disagree`);
        }
        t.ok(f.cabins.length <= f.summary.cabins.total, `group ${g.id}: more cabin rows than the block size`);
        for (const tr of f.travelers) {
          for (const secret of ["passport_enc", "form_token_hash", "consent_ip_hash"]) t.ok(!(secret in tr), `group ${g.id}: a traveller row exposes ${secret}`);
        }
        t.ok(!cardShaped(JSON.stringify(f)), `group ${g.id}: the file contains something shaped like a payment card number`);

        if (g.source_intake_id && intakes < 2) {
          intakes++;
          const i = t.success(await t.get(`/api/groups/intake/${g.source_intake_id}`, { auth: true }));
          t.equal(i.intake?.id, g.source_intake_id, `group ${g.id}: the booking intake opened is a different one`);
          t.equal(i.intake.status, "accepted", `group ${g.id}: status of the booking document it was opened from`);
          t.equal(i.intake.group_id, g.id, `group ${g.id}: the booking intake points at another group`);
          t.ok(Array.isArray(i.found), `group ${g.id}: the intake has no list of what was read`);
          const filed = f.documents.find((d) => d.storage_path && d.storage_path === i.intake.storage_path);
          t.ok(filed, `group ${g.id}: the booking document it was opened from is not filed on the group`);
          const link = t.success(await t.get(`/api/groups/intake/${g.source_intake_id}/file`, { auth: true }));
          t.equal(link.expiresIn, 600, `group ${g.id}: the document link lifetime (seconds)`);
          t.ok(/^https:\/\/[^/]+\/storage\/v1\/object\/sign\/group-docs\//.test(String(link.url || "")), `group ${g.id}: the document link is not a signed private-bucket address`);
          // the first bytes only — the address and the file name are never printed
          const pdf = await t.get(link.url, { headers: { range: "bytes=0-7" } });
          t.ok((pdf.status === 200 || pdf.status === 206) && pdf.text.startsWith("%PDF"), `group ${g.id}: the filed booking document does not download as a PDF (HTTP ${pdf.status})`);
        }
      }
      t.require(intakes > 0, "no group on this box was opened from a booking document, so booking intake cannot be tested");
      refused(t, await t.get(`/api/groups/${ZERO}`, { auth: true }), 404, "a group that does not exist", /not found/i);
      refused(t, await t.get(`/api/groups/intake/${ZERO}`, { auth: true }), 404, "a booking intake that does not exist", /not found/i);
      t.observe("group keys", keysOf(groups[0]));
      t.observe("summary keys", keysOf(groups[0].summary));
      t.observe("groups", groups.length, "min");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.group-file-fixture",
    title: "Adding, ticking off and removing a checklist row on a group file works, and the group's to-do count follows it",
    covers: ["POST /api/groups/:id/:child", "PATCH /api/groups/:id/:child/:rowId", "DELETE /api/groups/:id/:child/:rowId", "GET /api/groups/:id"],
    modes: ["dev"],
    devOnlyBecause: "it creates, edits and deletes a fixture checklist row (dev database only; deleted in a finally block)",
    run: async (t) => {
      const groups = await groupsList(t);
      t.require(groups.length > 0, "there are no group files on dev to attach the fixture row to");
      const g = groups.find((x) => x.status === "draft") || groups[0];
      const open = async () => t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
      const del = (rowId) => t.send("DELETE", `/api/groups/${g.id}/checklist/${rowId}`, { auth: true });

      let file = await open();
      // a run that crashed before its finally block leaves a fixture: clear it first
      const leftovers = file.checklist.filter((r) => String(r.title || "").startsWith("e2e-fixture"));
      for (const r of leftovers) t.success(await del(r.id));
      if (leftovers.length) { t.note(`removed ${leftovers.length} fixture row(s) left by an earlier run`); file = await open(); }
      const before = file.summary.checklist.open;

      let rowId = null;
      try {
        const add = await t.send("POST", `/api/groups/${g.id}/checklist`, { auth: true, body: { title: FIXTURE_TITLE, audience: "mark", kind: "task", detail: "Created and deleted by the whole-site release gate." } });
        rowId = add.json?.row?.id || null; // taken first, so the finally block can always remove it
        t.status(add, 201);
        t.ok(add.json?.success === true, `adding the checklist row was not reported as a success: ${add.describe()}`);
        const row = add.json.row;
        t.ok(rowId, "the new checklist row has no id");
        t.equal(row.group_id, g.id, "the new checklist row's group");
        t.equal(row.title, FIXTURE_TITLE, "the new checklist row's title");

        file = await open();
        t.ok(file.checklist.some((r) => r.id === rowId), "the new checklist row is not in the group file");
        t.equal(file.summary.checklist.open, before + 1, "the group's open to-do count after adding a row");
        t.ok(file.summary.attention.some((a) => a.kind === "checklist" && a.label === FIXTURE_TITLE), "the new to-do is not in the group's needs-attention list");

        // the card guard also protects edits
        refused(t, await t.send("PATCH", `/api/groups/${g.id}/checklist/${rowId}`, { auth: true, body: { title: CARDLIKE } }), 400, "a checklist edit holding a card-shaped number", /card number/i);
        const done = t.success(await t.send("PATCH", `/api/groups/${g.id}/checklist/${rowId}`, { auth: true, body: { done_at: new Date(t.now()).toISOString() } }));
        t.ok(done.row?.done_at, "ticking off the checklist row did not record when");
        file = await open();
        t.equal(file.summary.checklist.open, before, "the group's open to-do count after ticking the row off");

        t.success(await del(rowId));
        const deleted = rowId; rowId = null;
        file = await open();
        t.ok(!file.checklist.some((r) => r.id === deleted), "the deleted checklist row is still in the group file");
        refused(t, await del(deleted), 404, "deleting the same row twice", /not found/i);
      } finally {
        if (rowId) await del(rowId).catch(() => {});
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.group-writes-refuse",
    title: "Group-file and booking-intake writes refuse card numbers, missing names, unknown groups and already-accepted documents (nothing is created)",
    covers: ["GET /api/groups"],
    modes: ["dev"],
    devOnlyBecause: "it sends POST/PATCH/DELETE requests (refusal paths only); prod sweeps are read-only",
    run: async (t) => {
      const groups = await groupsList(t);
      t.require(groups.length > 0, "there are no group files on dev to aim the refusals at");
      const g = groups[0];
      const send = (m, p, body) => t.send(m, p, { auth: true, body });
      // Each body that a broken guard could save also carries an invalid status/audience, so the
      // database's check constraint refuses it as well — a regression fails the check, not the data.
      refused(t, await send("POST", "/api/groups", {}), 400, "opening a group with no name", /needs a name/i);
      refused(t, await send("POST", "/api/groups", { name: "e2e-fixture never saved", status: "e2e-invalid", notes: CARDLIKE }), 400, "opening a group whose notes hold a card-shaped number", /card number/i);
      refused(t, await send("PATCH", `/api/groups/${g.id}`, {}), 400, "an empty group edit", /nothing to update/i);
      refused(t, await send("PATCH", `/api/groups/${g.id}`, { status: "e2e-invalid", notes: CARDLIKE }), 400, "a group edit holding a card-shaped number", /card number/i);
      refused(t, await send("PATCH", `/api/groups/${ZERO}`, { notes: "e2e-fixture" }), 404, "editing a group that does not exist", /not found/i);
      refused(t, await send("POST", `/api/groups/${ZERO}/payment-schedule`, {}), 404, "a payment schedule for a group that does not exist", /not found/i);
      refused(t, await send("POST", `/api/groups/${g.id}/e2e-no-such-section`, {}), 404, "adding to an unknown section", /unknown section/i);
      refused(t, await send("POST", `/api/groups/${ZERO}/checklist`, { title: "e2e-fixture", audience: "e2e-invalid" }), 404, "adding a row to a group that does not exist", /not found/i);
      refused(t, await send("POST", `/api/groups/${g.id}/travelers`, { first_name: "e2e-fixture", lang: "e2e-invalid", notes: CARDLIKE }), 400, "a traveller row holding a card-shaped number", /card number/i);
      refused(t, await send("PATCH", `/api/groups/${g.id}/e2e-no-such-section/${ZERO}`, { notes: "x" }), 404, "editing a row in an unknown section", /unknown section/i);
      refused(t, await send("DELETE", `/api/groups/${g.id}/checklist/${ZERO}`), 404, "deleting a row that does not exist", /not found/i);

      // Booking intake: refused before anything is uploaded or read by the model.
      refused(t, await send("POST", "/api/groups/intake", {}), 400, "a booking upload with no file", /no file/i);
      const notPdf = Buffer.from("e2e-fixture: this is plain text, not a PDF. ".repeat(6)).toString("base64");
      refused(t, await send("POST", "/api/groups/intake", { filename: "e2e-fixture.pdf", data: notPdf }), 400, "a booking upload that is not a PDF", /only pdf/i);
      refused(t, await send("POST", `/api/groups/intake/${ZERO}/retry`, {}), 404, "re-reading an intake that does not exist", /not found/i);
      refused(t, await send("POST", `/api/groups/intake/${ZERO}/accept`, { group: { name: "e2e-fixture" } }), 404, "accepting an intake that does not exist", /not found/i);
      // An intake already accepted into a group must refuse both a re-read (paid model) and a second group.
      const withIntake = groups.find((x) => x.source_intake_id);
      t.require(withIntake, "no group on dev was opened from a booking document, so the already-accepted refusals cannot be tested");
      const i = t.success(await t.get(`/api/groups/intake/${withIntake.source_intake_id}`, { auth: true }));
      t.equal(i.intake?.status, "accepted", "status of the booking intake used for the already-accepted refusals");
      refused(t, await send("POST", `/api/groups/intake/${withIntake.source_intake_id}/retry`, {}), 409, "re-reading an intake already accepted", /already accepted/i);
      refused(t, await send("POST", `/api/groups/intake/${withIntake.source_intake_id}/accept`, { group: { name: "e2e-fixture never saved" } }), 409, "accepting an intake twice", /already accepted/i);
      for (const [m, p] of [["POST", "/api/groups"], ["PATCH", `/api/groups/${g.id}`], ["POST", "/api/groups/intake"], ["DELETE", `/api/groups/${g.id}/checklist/${ZERO}`]]) {
        unauthorized(t, await t.send(m, p, { body: {} }), `${m} ${p}`);
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.group-marketing-dashboard",
    title: "Mark's group-marketing screen shows the interview, the facts taken from the group file, the share code and the replies (a spread of groups), and the dashboard program is wired to it",
    covers: ["GET /api/groups/:id/marketing", "GET /api/groups/:id/interests"],
    modes: ["dev", "prod"],
    // Group marketing is new in the 2026-10-08 release: on prod (before the promotion) these
    // addresses do not exist and this check FAILS — that is correct, not a reason to weaken it.
    run: async (t) => {
      const groups = await groupsList(t);
      t.require(groups.length > 0, "there are no group files on this box");
      unauthorized(t, await t.get(`/api/groups/${groups[0].id}/marketing`), "GET /api/groups/:id/marketing");
      unauthorized(t, await t.get(`/api/groups/${groups[0].id}/interests`), "GET /api/groups/:id/interests");
      const readable = groups.filter((g) => safeMarketingRead(t, g));
      t.require(readable.length > 0, "every group on this box has a ship name but no ship slug, and reading its marketing screen on prod would save the slug (a write)");
      let replies = 0; let live = 0;
      for (const g of spread(readable)) {
        const m = t.success(await t.get(`/api/groups/${g.id}/marketing`, { auth: true }));
        // What pages/group-marketing.tsx reads: interview[].key/label/type, answers, missing[],
        // copyFields[].key/label/max, langs, perLang[l].facts/copy/problems, shareCode, approvedAt.
        t.nonEmpty(m.interview, `group ${g.id}: the marketing interview`);
        for (const q of m.interview) t.fields(q, ["key", "label", "type"], `group ${g.id}: an interview question`);
        t.nonEmpty(m.copyFields, `group ${g.id}: the copy fields`);
        for (const f of m.copyFields) t.ok(f && f.key && f.label && Number.isInteger(f.max) && f.max > 0, `group ${g.id}: a copy field has no key, label or length limit`);
        t.ok(m.answers && typeof m.answers === "object" && !Array.isArray(m.answers), `group ${g.id}: the interview answers are missing`);
        t.ok(Array.isArray(m.missing) && m.missing.every((k) => m.interview.some((q) => q.key === k)), `group ${g.id}: the "still needed" list is missing or names a question that does not exist`);
        t.equal(JSON.stringify(m.langs), JSON.stringify(langsFor(g)), `group ${g.id}: languages on the marketing screen vs the group file`);
        // The facts are read from the group file on every request: they must agree with it.
        const file = t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
        const liveCabins = file.cabins.filter((c) => ["held", "offered", "booked"].includes(c.status));
        for (const l of m.langs) {
          const pl = m.perLang?.[l];
          t.ok(pl && pl.facts, `group ${g.id}: no ${l} facts on the marketing screen`);
          t.ok(Array.isArray(pl.problems), `group ${g.id}: no ${l} problem list`);
          t.equal(pl.facts.lang, l, `group ${g.id}: language of the ${l} facts`);
          t.equal(pl.facts.groupName, g.name, `group ${g.id}: group name — ${l} facts vs the group file`);
          t.equal(pl.facts.nights ?? null, Number.isInteger(g.nights) ? g.nights : null, `group ${g.id}: nights — ${l} facts vs the group file`);
          t.equal(pl.facts.cabinsTotal, liveCabins.length, `group ${g.id}: cabins in the block — ${l} facts vs the group file`);
          t.equal(pl.facts.cabinsAvailable, liveCabins.filter((c) => c.status !== "booked").length, `group ${g.id}: cabins still available — ${l} facts vs the group file`);
          if (g.ship_name) t.equal(String(pl.facts.ship || "").toLowerCase(), String(g.ship_name).toLowerCase(), `group ${g.id}: ship — ${l} facts vs the group file`);
        }
        t.equal(m.shareCode, g.share_code ?? null, `group ${g.id}: share code — marketing screen vs group list`);
        t.equal(m.approvedAt, g.marketing_approved_at ?? null, `group ${g.id}: approval time — marketing screen vs group list`);
        if (isLive(g)) {
          live++;
          for (const l of m.langs) t.ok(m.perLang[l].copy && m.perLang[l].problems.length === 0, `group ${g.id}: its page is live but the ${l} copy is missing or has problems`);
        }
        const r = t.success(await t.get(`/api/groups/${g.id}/interests`, { auth: true }));
        t.ok(Array.isArray(r.interests), `group ${g.id}: the replies list is missing`);
        // The replies table shows name, contact, cabin, guests and status (counted, never printed).
        for (const x of r.interests) {
          t.ok(INTEREST_STATUSES.includes(x.status) && Number.isFinite(Date.parse(x.created_at)), `group ${g.id}: a reply has an unknown status or no time`);
          t.ok(["id", "first_name", "email", "lang", "cabin_type", "guests", "newsletter_opt_in"].every((k) => k in x), `group ${g.id}: a reply is missing a column the replies table shows`);
        }
        replies += r.interests.length;
      }
      t.observe("group replies", replies, "info");
      t.observe("live group pages", live, "info");
      // The dashboard program on this box must be the one that has the marketing screen.
      const js = await dashboardProgram(t);
      for (const needle of ["/marketing/share-code", "/marketing/approve", "/marketing/answers", "/interests"]) {
        t.ok(js.includes(needle), `the dashboard program on this box does not call ${needle} — its group-marketing screen is missing or unwired`);
      }
    },
  },
  {
    id: "ops.group-page-public",
    title: "A live group page (English and Spanish) shows exactly Mark's approved copy and the group's facts, with no contact details or ids, and unapproved pages stay hidden",
    covers: ["GET /api/group-page/:code", "page /group.html", "page /es/group.html", "GET /api/groups/:id/marketing"],
    modes: ["dev", "prod"],
    // New in the 2026-10-08 release: prod has neither the pages nor the address before the promotion,
    // and no approved group page after it until Mark approves one — FAIL/UNTESTABLE there is correct.
    run: async (t) => {
      // The page script renders d.facts as `f.<name>` and d.copy as `c.<name>`. Collect the names each
      // twin reads, so a field renamed or dropped by the API (or by one twin only) fails below.
      const reads = {};
      for (const [p, lang] of [["/group.html", "en"], ["/es/group.html", "es"]]) {
        const html = t.html(await t.get(p), { mustContain: ["/api/group-page/", "turnstile", "/interest", "?lang=", 'id="f-website"', "cf-turnstile-response"] });
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        t.matches(H.metaContent(html, "robots"), /noindex/, `${p} robots (a group page must never be indexed)`);
        t.observe(`${p} title`, H.title(html));
        const names = (re) => [...new Set([...html.matchAll(re)].map((m) => m[1]))].sort();
        reads[lang] = { facts: names(/\bf\.([A-Za-z_]+)/g), copy: names(/\bc\.([A-Za-z_]+)/g) };
        t.atLeast(reads[lang].facts.length, 8, `fact names the ${lang} group page reads`);
        t.atLeast(reads[lang].copy.length, 5, `copy names the ${lang} group page reads`);
      }
      t.equal(JSON.stringify(reads.es), JSON.stringify(reads.en), "the fields the Spanish and the English group pages read (the twins have drifted apart)");
      t.observe("group page reads", `facts:${reads.en.facts.join(",")} copy:${reads.en.copy.join(",")}`);
      refused(t, await t.get("/api/group-page/NOT-A-CODE"), 404, "a malformed group-page code", /not found/i);
      refused(t, await t.get("/api/group-page/zzzzzzzzzz"), 404, "a group-page code that does not exist", /not found/i);

      const groups = await groupsList(t);
      // Unapproved pages: the public address must not show them (a share code exists before approval).
      for (const g of groups.filter((x) => x.share_code && !isLive(x) && safeMarketingRead(t, x)).slice(0, 2)) {
        refused(t, await t.get(`/api/group-page/${g.share_code}`), 404, `the unapproved group page of group ${g.id}`, /not found/i);
      }
      const live = groups.filter((g) => isLive(g) && safeMarketingRead(t, g));
      t.require(live.length > 0, "no group on this box has an approved, live page, so the public group page cannot be tested");
      let siteKey = ""; let spanishLive = 0;
      for (const g of live.slice(0, 2)) {
        const res = await t.get(`/api/group-page/${g.share_code}`);
        const pub = t.success(res);
        t.equal(pub.live, true, `group ${g.id}: the public page says it is not live`);
        t.equal(pub.preview, false, `group ${g.id}: a visitor is shown a preview`);
        t.matches(res.headers.get("x-robots-tag") || "", /noindex/, `group ${g.id}: X-Robots-Tag`);
        t.matches(res.headers.get("cache-control") || "", /no-store/, `group ${g.id}: Cache-Control`);
        t.equal(JSON.stringify(pub.langs), JSON.stringify(langsFor(g)), `group ${g.id}: languages — public page vs group file`);
        t.fields(pub.facts, ["groupName", "line", "ship", "sailDateText", "nights", "embarkPort", "business.email"], `group ${g.id}: public facts`);
        t.nonEmpty(pub.facts.cabins, `group ${g.id}: cabin categories on the public page`);
        t.nonEmpty(pub.facts.itinerary, `group ${g.id}: itinerary on the public page`);
        t.equal(String(pub.facts.ship).toLowerCase(), String(g.ship_name).toLowerCase(), `group ${g.id}: ship — public page vs group file`);
        t.fields(pub.copy, ["headline", "intro", "cta_label"], `group ${g.id}: public copy`);
        // nothing private on a public page (checked without printing it)
        const text = res.text;
        t.ok(!text.includes(g.id), `group ${g.id}: the public page carries the group's internal id`);
        for (const k of ["organizer_email", "organizer_phone", "notes"]) {
          if (typeof g[k] === "string" && g[k].length >= 6) t.ok(!text.includes(g[k]), `group ${g.id}: the public page carries the group's ${k.replace("_", " ")}`);
        }
        t.ok(!cardShaped(text), `group ${g.id}: the public page contains something shaped like a card number`);
        // the dashboard's approved copy and the public copy are the same words
        // Every name the page script reads is in the answer (a missing one renders as a blank).
        const noFact = reads.en.facts.filter((k) => !(k in pub.facts));
        const noCopy = reads.en.copy.filter((k) => !(k in pub.copy));
        t.ok(noFact.length === 0 && noCopy.length === 0, `group ${g.id}: the group page reads ${[...noFact.map((k) => `facts.${k}`), ...noCopy.map((k) => `copy.${k}`)].join(", ")}, which the public answer no longer has`);
        t.fields(pub.facts, ["business.legalName", "business.host", "business.email"], `group ${g.id}: the page footer's business details`);
        for (const c of pub.facts.cabins) t.ok(typeof c.category === "string" && Number.isInteger(c.available), `group ${g.id}: a cabin category on the public page has no name or availability`);
        for (const s of pub.facts.itinerary) t.ok(typeof s.port === "string" && s.port && typeof s.seaDay === "boolean", `group ${g.id}: an itinerary day on the public page has no port`);
        // the dashboard's approved copy and the public copy are the same words, field by field, and the
        // public facts are the dashboard's facts
        const m = t.success(await t.get(`/api/groups/${g.id}/marketing`, { auth: true }));
        const lang0 = langsFor(g)[0];
        for (const k of Object.keys(pub.copy)) {
          t.equal(pub.copy[k] ?? null, m.perLang?.[lang0]?.copy?.[k] ?? null, `group ${g.id}: copy "${k}" — public page vs Mark's approved copy`);
        }
        for (const k of ["groupName", "ship", "sailDateText", "nights", "embarkPort", "cabinsAvailable"]) {
          t.equal(JSON.stringify(pub.facts[k]), JSON.stringify(m.perLang?.[lang0]?.facts?.[k]), `group ${g.id}: ${k} — public page vs the marketing screen`);
        }
        // Spanish visitors (/es/group.html asks ?lang=es): a Spanish group answers in Spanish with
        // Mark's Spanish copy; an English-only group falls back to English.
        const es = t.success(await t.get(`/api/group-page/${g.share_code}?lang=es`));
        const esLang = langsFor(g).includes("es") ? "es" : lang0;
        t.equal(es.facts.lang, esLang, `group ${g.id}: language served to ?lang=es`);
        t.equal(es.copy.headline, m.perLang?.[esLang]?.copy?.headline, `group ${g.id}: headline served to ?lang=es vs Mark's ${esLang} copy`);
        if (langsFor(g).includes("es")) spanishLive++;
        siteKey = pub.turnstileSiteKey || siteKey;
      }
      t.observe("live group pages", live.length, "info");
      // Last, so every assertion above runs first. Two conditions this box must provide:
      //  • a live page in Spanish — otherwise the Spanish copy path above was only a fallback to English
      //    (dev's test group is English-only);
      //  • a Turnstile site key — the interest form's bot check (dev has no Turnstile keys; prod does).
      const missing = [];
      if (spanishLive === 0) missing.push("no live group page is in Spanish, so the Spanish copy and the /es/ page's own answer cannot be checked");
      if (!siteKey) missing.push("the group page offers no Turnstile site key, so the interest form's bot check cannot be exercised (dev has no Turnstile keys)");
      t.require(missing.length === 0, missing.join("; "));
    },
  },
  {
    id: "ops.group-marketing-writes-refuse",
    title: "Group-marketing writes refuse unknown groups and bad statuses, the interest form's bot trap and validation store nothing, and asking again for a share code returns the same one",
    covers: ["POST /api/groups/:id/marketing/share-code"],
    modes: ["dev"],
    devOnlyBecause: "it sends POST/PUT/PATCH requests (refusal paths and an idempotent share-code read); a successful interest submit would e-mail Mark, so it is never sent",
    run: async (t) => {
      const groups = await groupsList(t);
      const L = groups.find(isLive);
      t.require(L, "no group on dev has a live page, so the interest-form refusals cannot be aimed at a real page");
      const send = (m, p, body, auth = true) => t.send(m, p, { auth, body });
      refused(t, await send("PUT", `/api/groups/${ZERO}/marketing/answers`, {}), 404, "saving interview answers for a group that does not exist", /not found/i);
      refused(t, await send("POST", `/api/groups/${ZERO}/marketing/write`, { lang: "en" }), 404, "writing copy for a group that does not exist", /not found/i);
      refused(t, await send("PUT", `/api/groups/${ZERO}/marketing/copy`, { lang: "en", copy: {} }), 404, "saving copy for a group that does not exist", /not found/i);
      refused(t, await send("POST", `/api/groups/${ZERO}/marketing/approve`, { approved: true }), 404, "approving a group that does not exist", /not found/i);
      refused(t, await send("POST", `/api/groups/${ZERO}/marketing/share-code`, {}), 404, "a share code for a group that does not exist", /not found/i);
      refused(t, await send("PATCH", `/api/groups/${L.id}/interests/${ZERO}`, { status: "e2e-not-a-status" }), 400, "a reply status that does not exist", /unknown status/i);
      refused(t, await send("PATCH", `/api/groups/${L.id}/interests/${ZERO}`, { status: "contacted" }), 404, "updating a reply that does not exist", /not found/i);
      for (const [m, p] of [["PUT", `/api/groups/${L.id}/marketing/answers`], ["POST", `/api/groups/${L.id}/marketing/approve`], ["POST", `/api/groups/${L.id}/marketing/write`], ["PATCH", `/api/groups/${L.id}/interests/${ZERO}`]]) {
        unauthorized(t, await send(m, p, {}, false), `${m} ${p.replace(L.id, ":id")}`);
      }
      // A group that already has a code keeps it (no write).
      const sc = t.success(await send("POST", `/api/groups/${L.id}/marketing/share-code`, {}));
      t.equal(sc.shareCode, L.share_code, "asking again for a live group's share code");

      // The public interest form — refusal paths only (a real submit e-mails Mark).
      const before = t.success(await t.get(`/api/groups/${L.id}/interests`, { auth: true })).interests.length;
      refused(t, await send("POST", "/api/group-page/NOT-A-CODE/interest", {}, false), 404, "an interest reply to a malformed page code", /not found/i);
      const trap = await send("POST", `/api/group-page/${L.share_code}/interest`, { website: "e2e-fixture-honeypot", lang: "en" }, false);
      if (trap.status === 429) t.note("the interest form's hourly limit was reached (5 per address per hour); the bot trap was not reached this run");
      else t.ok(trap.status === 200 && trap.json?.success === true, `the interest form's bot trap should answer as if accepted: ${trap.describe()}`);
      const bare = await send("POST", `/api/group-page/${L.share_code}/interest`, { lang: "en" }, false); // no name, no email: can never be stored
      t.ok(bare.status === 400 || bare.status === 429, `an interest reply with no name and no email was not refused: ${bare.describe()}`);
      if (bare.status === 400) refused(t, bare, 400, "an interest reply with no name and no email", /first name|complete the check/i);
      const after = t.success(await t.get(`/api/groups/${L.id}/interests`, { auth: true })).interests.length;
      t.equal(after, before, "replies stored by the refused interest submissions");
      // Both answered "too many requests": the limiter works, but neither the bot trap nor the
      // validation was reached — that is not a pass.
      t.require(trap.status !== 429 || bare.status !== 429, "the interest form's hourly limit (5 per address) was already used up on this box, so neither the bot trap nor the validation was reached this run");
    },
  },
];
