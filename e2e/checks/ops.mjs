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
//   2026-10-19  Group Bookings Workspace: Mark asked for a Power BI style page, and the page and the big-picture band on the
//               Group Bookings tab read ONE dataset (GET /api/groups/analytics). It must agree with the group list and must
//               never carry a passport, a link hash, a signature answer, a message body or a plain email address.
//
// SAFETY NOTES (read before adding a request here):
//   • Prod is read-only. GET /api/ops/conflicts PRUNES stale conflicts in the ops-manager's pending
//     store, and GET /api/social/share is on the "never call on prod" list, so both are dev-only.
//   • GET /api/ops/gsc/insights makes an UNCACHED model call (local box, Anthropic fallback) on
//     every request: it is only ever asked WITHOUT the token (401), never with it.
//   • GET /api/groups/:id/marketing and GET /api/group-page/:code write groups.ship_slug the first
//     time a group with a ship name but no slug is read (memoisation). On prod those reads are
//     only made for groups whose ship_slug is already set, so a prod sweep never writes.
//   • POST /api/group-page/:code/interest EMAILS Mark (priority lead) and, since 2026-10-23, EMAILS THE GUEST an acknowledgement
//     with their private details link. Only its refusal paths are used: a malformed code, the bot honeypot (answers success and
//     stores nothing) and a body with no name and no email. TURNSTILE is not enforced on dev, so a request carrying a name
//     and an email WOULD be stored and e-mailed — never send one.
//   • ops.group-journey-plan-and-preview runs on both boxes and is the one such check that writes, on dev only and only when no group
//     there has a real traveler: it adds one throwaway "E2E Gate Preview" traveler (undeliverable address) so a message can be
//     previewed, and removes it in a finally block. Prod never writes; it opens other groups' files (GET) to find a traveler.
//   • Every write that could, if a guard regressed, change a real row also carries an invalid
//     enum value, so the database's own check constraint refuses it as a second line of defence.
//   • No personal data in failures or observations: groups are named by id, travellers and
//     replies are counted, never quoted; money is never recorded.
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

/** The lines of a journey message that quote a video from Mark's YouTube channel (title + link). The title is his,
 *  published as it is; the house-voice tests are for the sentences WE write, so these lines are left out of them. */
function withoutVideoLines(text) {
  return String(text).split("\n").filter((line) => !/youtube\.com\/watch|youtu\.be\//i.test(line)).join("\n");
}

const ZERO = "00000000-0000-4000-8000-000000000000";
const FIXTURE_TITLE = "e2e-fixture release gate checklist row (safe to delete)";
const CARDLIKE = "0000 0000 0000 0000"; // Luhn-valid by construction, obviously not a card
const TEST_ADDRESS = "e2e-fixture-nobody@example.invalid"; // a reserved name that can never be delivered; the gate's convention (ships.mjs)
const PREVIEW_LAST = "Gate Preview"; // surname of the throwaway traveler the journey preview check adds when dev has no real one
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

/**
 * One group read three times: the list's row for it, the file, and the list's row again. The list and the file are separate reads of
 * a group's roll-up, and other checks put fixture rows on the draft group (a checklist row, a traveler) and take them off again while a
 * sweep runs (three checks are in flight at once, and a group cannot be deleted through the site, so a check cannot keep a group of its
 * own). Two roll-ups read at different moments can honestly differ, so they are compared only when the list's roll-up is the same
 * before and after the file was read, which means nothing moved in between. When it did move, wait and read again. A real difference
 * between the list and the file shows on every try; only a group that keeps changing for several tries is reported as such.
 */
async function settledGroup(t, id) {
  let last = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = (await groupsList(t)).find((x) => x.id === id);
    const file = t.success(await t.get(`/api/groups/${id}?horizon=3650`, { auth: true }));
    const after = (await groupsList(t)).find((x) => x.id === id);
    t.ok(before && after, `group ${id}: the group list no longer holds a group it listed a moment ago`);
    last = { listed: after, file, attempts: attempt, settled: JSON.stringify(before.summary) === JSON.stringify(after.summary) };
    if (last.settled) return last;
    await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
  }
  return last;
}

/**
 * The workspace's dataset read between two reads of the group list. The dataset and the list are separate reads of every group's
 * roll-up, and other checks put fixture rows on the draft group and take them off again while a sweep runs (see settledGroup), so the
 * two are compared only when the list did not move while the dataset was being read. A real difference shows on every try.
 */
async function settledAnalytics(t) {
  let last = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = await groupsList(t);
    const body = t.success(await t.get("/api/groups/analytics", { auth: true }));
    const after = await groupsList(t);
    const rolls = (list) => JSON.stringify(list.map((g) => [g.id, g.summary]));
    last = { body, listed: after, attempts: attempt, settled: rolls(before) === rolls(after) };
    if (last.settled) return last;
    await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
  }
  return last;
}

/** Field → type for every row of each dataset the Group Bookings Workspace slices. "x?" may also be null. */
const ANALYTICS_SHAPE = {
  groups: { id: "string", name: "string", status: "string", lang: "string", cruiseLine: "string?", shipName: "string?", sailDate: "string?", daysToSail: "number?",
    cabinsTotal: "number", cabinsHeld: "number", cabinsOffered: "number", cabinsBooked: "number", cabinsReleased: "number",
    travelersExpected: "number", travelersOnFile: "number", formsSent: "number", formsReturned: "number", fullySigned: "number",
    depositsTotal: "number", depositsPaid: "number", paymentsOpen: "number", paymentsPaid: "number", paymentsOverdue: "number",
    amountDue: "number", amountPaid: "number", amountOverdue: "number", interestsTotal: "number", interestsNew: "number", interestsConverted: "number",
    journeyQueued: "number", journeySent: "number", journeyFailed: "number", nextDeadlineLabel: "string?", nextDeadlineDate: "string?", nextDeadlineDaysOut: "number?",
    marketingApproved: "boolean", needsAttention: "boolean", attentionReasons: "array" },
  cabins: { id: "string", groupId: "string", groupName: "string", cabinNum: "string?", category: "string?", status: "string", bookingNumber: "string?", priceTotal: "number?", depositAmount: "number?", travelerCount: "number", travelers: "string" },
  travelers: { id: "string", groupId: "string", groupName: "string", name: "string", email: "string?", lang: "string", isLead: "boolean", formStatus: "string", docsRequired: "number", docsSigned: "number", fullySigned: "boolean", passportOnFile: "boolean" },
  payments: { id: "string", groupId: "string", groupName: "string", kind: "string", status: "string", amount: "number?", dueDate: "string?", daysOut: "number?" },
  paperwork: { groupId: "string", groupName: "string", travelerId: "string", travelerName: "string", docKey: "string", docTitle: "string", status: "string" },
  messages: { id: "string", groupId: "string", groupName: "string", kind: "string", status: "string", to: "string?", journey: "boolean" },
  interests: { id: "string", groupId: "string", groupName: "string", status: "string", name: "string", lang: "string", email: "string?", daysAgo: "number?" },
  deadlines: { groupId: "string", groupName: "string", kind: "string", label: "string", date: "string", daysOut: "number", done: "boolean" },
  journey: { groupId: "string", groupName: "string", kind: "string", label: "string", planned: "number", due: "number", sent: "number", failed: "number", skipped: "number", blocked: "number" },
  docs: { key: "string", title: "string" },
};
/** Keys that may appear nowhere in the workspace's data, at any depth. */
const ANALYTICS_FORBIDDEN_KEYS = ["passport_enc", "passport_number", "passport_last4", "form_token_hash", "hub_token_hash", "organizer_token_hash", "ip_hash", "ua_hash", "consent_ip_hash", "answers", "body_html", "pdf_path", "token"];
function analyticsKeys(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) analyticsKeys(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); analyticsKeys(v, out); }
  return out;
}
function typedRow(t, row, shape, what) {
  t.ok(row && typeof row === "object" && !Array.isArray(row), `${what} is not an object`);
  for (const [field, type] of Object.entries(shape)) {
    t.ok(field in row, `${what} has no "${field}"`);
    const v = row[field];
    const nullable = type.endsWith("?");
    const base = nullable ? type.slice(0, -1) : type;
    if (v === null && nullable) continue;
    const okType = base === "array" ? Array.isArray(v) : base === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === base;
    t.ok(okType, `${what}: "${field}" should be ${base}${nullable ? " or empty" : ""}, got ${v === null ? "null" : Array.isArray(v) ? "a list" : typeof v}`);
  }
}

export default [
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.auth-gate",
    basis: "code: server/src/lib/http-auth.ts — every dashboard data address fails closed: a missing or wrong token (header, Bearer or ?token=) answers 401 with no data, and Mark's own token is accepted (9/4 incident, 103 call sites)",
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
    basis: "master-ref: §3 WEB & HOSTING INFRASTRUCTURE — the dashboard is a built app served behind a password on its own address; every data address its pages read must be wired in the deployed build",
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
        "/api/ops/youtube-analytics", "/api/ops/gsc/analytics", "/api/ops/seo-proposals", "/groups/intake", "/payment-schedule", "horizon=3650",
        "/groups/analytics", "/groups/workspace"]) {
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
    basis: "master-ref: §4 SAF-OPS-MANAGER — the Python/FastAPI ops agent on port 5000 serves /health, holds the Gmail sign-in and its API key, and refuses callers without the key",
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
    basis: "code: server/src/routes/social-analytics.ts — the dashboard's Overview social panel reads the same Instagram follower snapshot that the Make 'Social Stats' scenario posts every 12 hours to /social/stats (9/6 incident: two ingest routes, panel said 'No data yet')",
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
      // 2026-10-08: @stillafloatcruising2026 really has 0 followers (confirmed against the public profile),
      // so a zero is a fact about the account, not a misread — reported, never failed on.
      const igSeen = stats.items.filter((s) => Number.isInteger(s.instagram?.followers));
      t.observe("instagram followers (latest)", ig, "info");
      t.observe("instagram snapshots with a follower count", igSeen.length, "min");

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
    basis: "ruling: stillafloat-social-engine.md — social drafts wait on a review page for Mark, English and Spanish; Spanish is first-class so a Spanish post must link to a Spanish page",
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
      t.atLeast(dests.size, 1, "pages the social posts link to");
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
    basis: "ruling: stillafloat-social-engine.md — approved social batches are scheduled at Mark's posting times; the poster resolves items it will never send as skipped after 7 days (9/6 incident: Instagram items sat scheduled forever)",
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
      // Dev runs the poster in sink mode (SOCIAL_POSTER_SINK=1, lib/social-sink.ts) on a test queue; an empty calendar means nothing above was exercised.
      // Whether Mark has approved any batch is his cadence, not the site's, so an empty calendar on prod is not a
      // failure. Dev holds a seeded approved batch by his 2026-10-08 dev-mirror ruling and must still show it.
      if (t.mode === "dev") t.require(s.items.length > 0, "the posting calendar is empty on dev, so the calendar, its page and the stuck-post rule cannot be tested (seed an approved fixture batch on dev)");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.social-share-kit",
    basis: "code: server/src/routes/social.ts — GET /social/share lists every non-rejected batch with a WhatsApp button that forwards the caption and a link",
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
    basis: "code: server/src/routes/social.ts — the Reel clip library registers public video files the Instagram poster hands to Instagram; the uploader and hook composer pages are token-gated and noindex",
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
    basis: "ruling: stillafloat-ai-visibility-program.md — the AI-visibility dashboard reports a daily roll-up of AI-assistant lookups and crawler counts, plus the agent's activity log; Mark 10/8: dev gets no AI-assistant traffic and must be made a true mirror (known-failures.json)",
    title: "The AI Visibility page has this week's roll-up of AI-assistant lookups, the crawler counts and the agent's activity log, all well-formed and current",
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
      // how many crawler visits there were is traffic, not the site: zero is a legitimate count
      t.ok(Object.values(L.crawlers).every((n) => Number.isInteger(n) && n >= 0), "a crawler count is not a count");
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
      // How many AI-assistant lookups reached the site is traffic, not the site (Mark 2026-10-09: a check tests
      // a property of the site, never the state of the world), so a window of all-zero counts is recorded and
      // not failed — dev gets no assistant traffic at all. The shape, freshness and weekly roll-up are held above.
      const lookups = L.weeks.reduce((n, w) => n + Object.values(w.assistants).reduce((a, b) => a + b, 0), 0);
      t.observe("assistant lookups in the window", lookups, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.finance-pages",
    basis: "ruling: stillafloat-finance-capture.md — the finance pages show this month's totals, transactions, cash flow and subscriptions from the ledger, and the totals must agree with the transactions behind them; Mark 10/8: dev carries a DUMMY finance table, never his real ledger",
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
      // Mark's own spending is his life, not the site, so prod is not required to show a recent transaction (the
      // agreement checks above hold on any ledger). Dev carries a DUMMY finance table by his 2026-10-08 ruling
      // (fake rows, never his real ledger) and must still show it.
      if (t.mode === "dev") t.require(tx.transactions.length > 0 && subs.subscriptions.length > 0,
        "dev's finance tables are empty (no transactions, no subscriptions) — the dummy finance fixture should be seeded, so none of the finance pages' data can be tested");
      const newest = tx.transactions.map((x) => x.created_at).sort().at(-1);
      if (newest) t.observe("days since the last captured transaction", Number(daysOld(t, newest).toFixed(1)), "info");
    },
  },
  {
    id: "ops.finance-every-receipt-complete",
    basis: "ruling: stillafloat-finance-capture.md — every captured receipt must carry a transaction date and an amount or it never counts in a monthly figure (9/30 incident)",
    title: "Every transaction captured in the last 30 days has a date and an amount, so it counts in the monthly totals and the cash-flow chart",
    covers: ["GET /api/ops/finance/transactions"],
    modes: ["dev", "prod"],
    incident: "2026-09-30: receipts captured with no transaction date (or no amount) are invisible to every monthly figure",
    run: async (t) => {
      const tx = t.success(await t.get("/api/ops/finance/transactions?limit=200", { auth: true }), "ok");
      t.ok(Array.isArray(tx.transactions), "the transactions list is missing");
      const recent = tx.transactions.filter((x) => daysOld(t, x.created_at) <= 30 && x.status !== "void");
      // (no receipt arriving in 30 days is not a failure — there is then nothing to date)
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
    basis: "master-ref: §4 SAF-OPS-MANAGER — the ops manager reads YouTube Analytics for the dashboard's YouTube panel; Mark 10/8: copy prod's Google tokens to the dev ops manager",
    title: "The dashboard's YouTube numbers are current (views, watch time, subscribers by day) and the totals add up, whatever the channel's traffic",
    covers: ["GET /api/ops/youtube-analytics"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const res = await t.get("/api/ops/youtube-analytics?days=28", { auth: true });
      if (res.status === 503) {
        const why = `the ops manager on this box is not authorised for YouTube Analytics ("${String(res.json?.detail || "").slice(0, 80)}")`;
        if (t.mode === "dev") t.require(false, `${why}, so the YouTube panel cannot be tested (Mark 2026-10-08: copy prod's Google tokens to dev)`);
        t.ok(false, `${why} — the YouTube panel is dark on the live site`);
      }
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
      // (how many views the channel got is the audience, not the site; the totals above must simply add up)
      // The Overview's subscriber figure: each day's net is gained minus lost, and the total is their sum.
      t.ok(yt.daily.every((d) => d.subs_net === d.subs_gained - d.subs_lost), "a YouTube day's net subscribers is not gained minus lost");
      t.equal(yt.totals.subs_gained, yt.daily.reduce((n, d) => n + d.subs_net, 0), "YouTube subscribers: total vs the sum of the days");
      t.ok(Number.isInteger(yt.totals.avg_view_seconds) && yt.totals.avg_view_seconds >= 0 && yt.totals.avg_view_seconds < 3600 && (yt.totals.views === 0 || yt.totals.avg_view_seconds > 0), `the average view length (${yt.totals.avg_view_seconds} s) is not plausible`);
      t.observe("keys", keysOf(yt));
      t.observe("days returned", yt.daily.length, "info");
    },
  },
  {
    id: "ops.search-console",
    basis: "master-ref: §4 SAF-OPS-MANAGER — Search Console is wired into the ops manager through its service account (GET /gsc/analytics) and feeds the SEO cockpit; Mark 10/8: copy prod's Google tokens to dev",
    title: "The SEO cockpit reads current Google Search Console data for stillafloatcruising.com (well-formed, windows consistent, not stalled) and its proposals list loads",
    covers: ["GET /api/ops/gsc/analytics", "GET /api/ops/seo-proposals"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const p = t.success(await t.get("/api/ops/seo-proposals", { auth: true }), "ok");
      t.ok(Array.isArray(p.proposals), "the SEO proposals list is missing");
      for (const x of p.proposals) t.fields(x, ["id", "title", "created_at"], `SEO proposal ${x?.id}`);
      t.observe("open SEO proposals", p.proposals.length, "info");

      const res = await t.get("/api/ops/gsc/analytics?days=28", { auth: true });
      if (res.status === 503) {
        const why = `the ops manager on this box is not authorised for Search Console ("${String(res.json?.detail || "").slice(0, 80)}")`;
        if (t.mode === "dev") t.require(false, `${why}, so the SEO cockpit cannot be tested (Mark 2026-10-08: copy prod's Google tokens to dev)`);
        t.ok(false, `${why} — the SEO cockpit is dark on the live site`);
      }
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
      // How many impressions, days with data, pages and queries Google reports is the search traffic (Google
      // returns a row only for a day or query that had impressions, and withholds low-volume queries), so none
      // of it is demanded; whatever is returned must be well-formed.
      t.ok(Array.isArray(g.trend) && Array.isArray(g.top_pages) && Array.isArray(g.top_queries), "the Search Console answer is missing its trend, top pages or top queries");
      t.ok(Number.isFinite(g.totals.impressions) && g.totals.impressions >= 0 && Number.isFinite(g.totals.clicks) && g.totals.clicks >= 0, "the Search Console totals are not counts");
      for (const pg of g.top_pages) t.matches(pg.page, /^https:\/\/(www\.)?stillafloatcruising\.com\//, "a Search Console top page");
      t.observe("keys", keysOf(g));
      t.observe("trend days", g.trend.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.calendar-conflicts",
    basis: "ruling: stillafloat-calendar-topology.md — calendar conflicts are listed on Mark's Today page and resolved only against his business calendar; resolving an unknown conflict is refused without touching the calendar",
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
    basis: "code: server/src/routes/social.ts — the social and AI-visibility write routes are token-gated (the Mac publisher and Make use their own narrow keys) and refuse bad input before generating, posting or sending anything",
    title: "The social and AI-visibility write addresses refuse bad input and missing tokens, and a clip upload can be signed (nothing is posted, sent or generated)",
    covers: ["POST /api/social/clip/sign", "POST /api/social/published"],
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
      // The publisher's "queue this upload's posts" call: bad input and wrong keys are refused before any
      // generation; an upload that already has its batch answers that batch and generates nothing.
      refused(t, await post("/api/social/published", { videoId: "e2eFixture01", title: "x", lang: "fr", format: "short" }), 400, "queueing posts for an upload with no en/es language", /lang/i);
      refused(t, await post("/api/social/published", { videoId: "e2eFixture01", title: "x", lang: "en" }), 400, "queueing posts for an upload with no format", /format/i);
      unauthorized(t, await post("/api/social/published", { videoId: "e2eFixture01", title: "x", lang: "en", format: "short" }, false), "POST /api/social/published");
      refused(t, await t.send("POST", "/api/social/published", { headers: { "x-social-clip-token": "e2e-wrong-key-not-a-secret" }, body: { videoId: "e2eFixture01", title: "x", lang: "en", format: "short" } }), 401,
        "queueing posts with a wrong publisher key", /unauthori[sz]ed/i);
      const had = q.batches.find((b) => (b.track === "A" || b.track === "B") && /^[\w-]{11}$/.test(String(b.videoId)));
      t.require(had, "no queued batch with a YouTube id on this box, so the publisher's no-duplicate answer cannot be checked");
      const again = t.success(await post("/api/social/published", { videoId: had.videoId, title: had.title || "e2e", lang: had.track === "A" ? "es" : "en", format: "short" }));
      t.ok(again.existing === true && again.id === had.id, `re-queueing ${had.videoId} (Track ${had.track}) should answer its existing batch ${had.id}, got ${JSON.stringify(again).slice(0, 160)}`);
      t.equal(again.track, had.track, "the track the publisher call derives from the language");
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
    basis: "ruling: stillafloat-group-bookings.md — Mark 10/2: never store card numbers; passport data is never read back by the API; a group file's counts agree with the group list",
    title: "Whatever group files Mark has (a spread: first, middle, last) open with the same counts as the group list, a booking document is filed and downloadable, and nothing card-shaped or passport-secret is returned",
    covers: ["GET /api/groups", "GET /api/groups/:id", "GET /api/groups/intake/:id", "GET /api/groups/intake/:id/file"],
    modes: ["dev", "prod"],
    incident: "2026-10-02: group bookings — card numbers are never stored; passport data is never read back",
    run: async (t) => {
      const groups = await groupsList(t);
      // Whether Mark has opened any group file is his business, not the site's, so prod is only compared when it
      // has some; dev holds seeded test groups by his 2026-10-04 mirror ruling and must still show them.
      if (t.mode === "dev") t.require(groups.length > 0, "there are no group files on dev (the seeded test groups should be there), so the group pages cannot be tested");
      for (const g of groups) {
        t.fields(g, ["id", "slug", "name", "status", "lang", "summary"], `group ${g?.id}`);
        t.ok(GROUP_STATUSES.includes(g.status), `group ${g.id} has an unknown status "${g.status}"`);
        t.ok(["en", "es", "both"].includes(g.lang), `group ${g.id} has an unknown language "${g.lang}"`);
      }
      t.ok(!cardShaped(JSON.stringify(groups)), "the group list contains something shaped like a payment card number");

      let intakes = 0;
      for (const g0 of spread(groups)) {
        const { listed: g, file: f, settled, attempts } = await settledGroup(t, g0.id);
        t.equal(f.group?.id, g.id, `group ${g.id}: the file opened is a different group`);
        for (const k of ["cabins", "travelers", "documents", "payments", "travel", "checklist", "messages"]) t.ok(Array.isArray(f[k]), `group ${g.id}: the file has no ${k} list`);
        for (const k of ["cabins", "travelers", "payments", "deposits", "emails", "documents", "checklist"]) {
          t.equal(JSON.stringify(f.summary?.[k]), JSON.stringify(g.summary[k]), `group ${g.id}: ${k} — the group list and the group file disagree${settled ? "" : ` (and the group kept changing for ${attempts} tries, so this may be another check's fixture row)`}`);
        }
        t.ok(f.cabins.length <= f.summary.cabins.total, `group ${g.id}: more cabin rows than the block size`);
        for (const tr of f.travelers) {
          for (const secret of ["passport_enc", "form_token_hash", "consent_ip_hash", "prospect_id"]) t.ok(!(secret in tr), `group ${g.id}: a traveller row exposes ${secret}`);
        }
        t.ok(!cardShaped(JSON.stringify(f)), `group ${g.id}: the file contains something shaped like a payment card number`);
        t.ok(!("organizer_token_hash" in f.group) && !("organizer_token_hash" in g), `group ${g.id}: the group row exposes the organizer's link hash`);

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
      if (t.mode === "dev") t.require(intakes > 0, "no group on dev was opened from a booking document (the seeded group should be), so booking intake cannot be tested");
      refused(t, await t.get(`/api/groups/${ZERO}`, { auth: true }), 404, "a group that does not exist", /not found/i);
      refused(t, await t.get(`/api/groups/intake/${ZERO}`, { auth: true }), 404, "a booking intake that does not exist", /not found/i);
      refused(t, await t.get(`/api/groups/intake/${ZERO}/file`, { auth: true }), 404, "the filed document of a booking intake that does not exist", /not found/i);
      if (groups[0]) { t.observe("group keys", keysOf(groups[0])); t.observe("summary keys", keysOf(groups[0].summary)); }
      t.observe("groups", groups.length, "min");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.group-analytics",
    basis: "ruling: stillafloat-group-bookings.md — Mark 2026-10-19: \"I need a link to open a power BI style dashboard to track this. the group booking tab in the business dashboard should give the 'big picture', the power BI should be the workhorse\" — the workspace and the big-picture band read ONE dataset, so its figures must agree with the group list, and it must never carry a passport, a link hash, a signature answer, a message body or a plain email address",
    title: "The Group Bookings Workspace's data answers only to Mark's token, carries every dataset the page slices, agrees with the group list, and holds no passport, link hash, signature answer, message body or plain email address; its page address opens the dashboard",
    covers: ["GET /api/groups/analytics", "GET /api/groups"],
    modes: ["dev", "prod"],
    run: async (t) => {
      unauthorized(t, await t.get("/api/groups/analytics"), "GET /api/groups/analytics");
      refused(t, await t.get("/api/groups/analytics", { headers: { "x-affiliate-token": "e2e-wrong-token" } }), 401, "the workspace's data with a wrong token", /unauthori[sz]ed/i);

      const { body, listed, settled, attempts } = await settledAnalytics(t);
      // Whether Mark has opened any group file is his business, so prod is only compared when it has some; dev holds the seeded test groups.
      if (t.mode === "dev") t.require(listed.length > 0, "there are no group files on dev (the seeded test groups should be there), so the workspace cannot be tested");
      t.matches(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/, "the time the data was made");
      t.matches(body.today, /^\d{4}-\d{2}-\d{2}$/, "the day the data was counted for");
      t.ok(Array.isArray(body.warnings), "the dataset has no warnings list");
      t.equal(body.warnings.length, 0, `things the dataset could not work out: ${body.warnings.join(" | ").slice(0, 300)}`);

      // Every dataset is there, and every row has the fields (and types) the page reads.
      for (const [set, shape] of Object.entries(ANALYTICS_SHAPE)) {
        t.ok(Array.isArray(body[set]), `the dataset has no "${set}" list`);
        for (const [i, row] of body[set].entries()) typedRow(t, row, shape, `${set}[${i}]`);
      }
      const groupIds = new Set(body.groups.map((g) => g.id));
      t.equal(groupIds.size, body.groups.length, "a group appears twice in the dataset");
      t.equal(body.groups.length, listed.length, "groups in the dataset vs groups in the group list");
      for (const set of ["cabins", "travelers", "payments", "paperwork", "messages", "interests", "deadlines", "journey"]) {
        for (const row of body[set]) t.ok(groupIds.has(row.groupId), `a ${set} row belongs to a group that is not in the dataset`);
      }
      const travelerIds = new Set(body.travelers.map((x) => x.id));
      for (const p of body.paperwork) t.ok(travelerIds.has(p.travelerId), "a paperwork row belongs to a traveler that is not in the dataset");
      for (const g of body.groups) t.ok(GROUP_STATUSES.includes(g.status), `group ${g.id} has an unknown status "${g.status}"`);
      for (const p of body.payments) t.ok(["paid", "due", "overdue", "no date"].includes(p.status), `payment ${p.id}: unknown status "${p.status}"`);
      for (const x of body.paperwork) t.ok(["signed", "pending"].includes(x.status), `a paperwork row has an unknown status "${x.status}"`);
      for (const d of body.deadlines) t.ok(["deposit", "names", "final", "recall", "line", "journey", "sail"].includes(d.kind), `a deadline has an unknown kind "${d.kind}"`);
      for (const d of body.deadlines) t.matches(d.date, /^\d{4}-\d{2}-\d{2}$/, "a deadline's date");
      t.ok(body.deadlines.every((d, i, all) => i === 0 || all[i - 1].daysOut <= d.daysOut || all[i - 1].groupId !== d.groupId), "a group's deadlines are not in date order");

      // Each group row agrees with the rows under it, whatever the group list says.
      for (const g of body.groups) {
        const mine = (set) => body[set].filter((r) => r.groupId === g.id);
        const pay = mine("payments");
        t.equal(pay.filter((p) => p.status === "overdue").length, g.paymentsOverdue, `group ${g.id}: overdue payments, row count vs group figure`);
        t.equal(pay.filter((p) => p.status === "paid").length, g.paymentsPaid, `group ${g.id}: paid payments, row count vs group figure`);
        t.equal(pay.filter((p) => p.status !== "paid").length, g.paymentsOpen, `group ${g.id}: open payments, row count vs group figure`);
        t.equal(mine("travelers").length, g.travelersOnFile, `group ${g.id}: travelers on file, row count vs group figure`);
        t.equal(mine("travelers").filter((x) => x.fullySigned).length, g.fullySigned, `group ${g.id}: fully signed travelers, row count vs group figure`);
        t.equal(mine("interests").length, g.interestsTotal, `group ${g.id}: leads, row count vs group figure`);
        t.ok(mine("cabins").length <= g.cabinsTotal, `group ${g.id}: more cabin rows than the block size`);
        const journeyMail = mine("messages").filter((m) => m.journey);
        for (const [status, field] of [["queued", "journeyQueued"], ["sent", "journeySent"], ["failed", "journeyFailed"]]) {
          t.equal(journeyMail.filter((m) => m.status === status).length, g[field], `group ${g.id}: ${status} journey emails, row count vs group figure`);
        }
      }

      // Nothing secret, nothing card-shaped, no plain email address — at any depth.
      const keys = analyticsKeys(body);
      for (const k of ANALYTICS_FORBIDDEN_KEYS) t.ok(!keys.has(k), `the workspace's data carries "${k}"`);
      const text = JSON.stringify(body);
      t.ok(!/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(text), "the workspace's data holds an email address that is not masked");
      t.ok(!cardShaped(text), "the workspace's data contains something shaped like a payment card number");
      for (const row of [...body.travelers, ...body.messages, ...body.interests]) {
        const masked = row.email ?? row.to;
        if (masked) t.matches(masked, /^.•••@.+\..+$/, "an email address in the dataset");
      }

      // The same figures as the group list, group by group (compared when the list did not move while the dataset was read).
      if (settled) {
        const near = (a, b, what) => t.ok(Math.abs(a - b) < 0.005, `${what}: the dataset says ${a}, the group list says ${b}`);
        for (const g of listed) {
          const row = body.groups.find((x) => x.id === g.id);
          t.ok(row, `group ${g.id} is in the group list but not in the dataset`);
          const s = g.summary;
          for (const k of ["total", "held", "offered", "booked", "released"]) t.equal(row["cabins" + k[0].toUpperCase() + k.slice(1)], s.cabins[k], `group ${g.id}: cabins ${k}, dataset vs group list`);
          t.equal(row.travelersExpected, s.travelers.total, `group ${g.id}: travelers expected, dataset vs group list`);
          t.equal(row.formsReturned, s.travelers.formsIn, `group ${g.id}: forms returned, dataset vs group list`);
          t.equal(row.paymentsOverdue, s.payments.overdueCount, `group ${g.id}: overdue payments, dataset vs group list`);
          t.equal(row.daysToSail, s.daysToSail, `group ${g.id}: days to sail, dataset vs group list`);
          near(row.amountDue, s.payments.dueTotal, `group ${g.id}: dollars still due`);
          near(row.amountPaid, s.payments.paidTotal, `group ${g.id}: dollars paid`);
          near(row.depositsTotal, s.deposits.total, `group ${g.id}: deposits for the block`);
          near(row.depositsPaid, s.deposits.paid, `group ${g.id}: deposits paid`);
          t.equal(row.name, g.name, `group ${g.id}: name, dataset vs group list`);
          t.equal(row.status, g.status, `group ${g.id}: status, dataset vs group list`);
        }
      } else {
        t.ok(false, `the group list kept changing for ${attempts} tries while the dataset was read, so the two could not be compared (another check's fixture row?)`);
      }

      // The page's own address opens the dashboard (the shell is served for any path under /dashboard/).
      t.html(await t.get("/dashboard/groups/workspace"), { mustContain: [/<div id="root"/] });

      t.observe("analytics keys", keysOf(body));
      if (body.groups[0]) t.observe("analytics group fields", keysOf(body.groups[0]));
      t.observe("analytics groups", body.groups.length, "min");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.group-file-fixture",
    basis: "ruling: stillafloat-group-bookings.md — a group's checklist rows can be added, ticked off and removed from the dashboard and the group's open to-do count follows; the card guard protects edits",
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
      // a run that crashed before its finally block leaves a fixture: clear it first (only this check's own row: another check's
      // fixture row may be on this group right now, and removing it would fail that check)
      const leftovers = file.checklist.filter((r) => r.title === FIXTURE_TITLE);
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
    basis: "ruling: stillafloat-group-bookings.md — Mark 10/2: never store card numbers; group and booking-intake writes refuse card-shaped input, missing names, unknown groups and already-accepted documents",
    title: "Group-file and booking-intake writes refuse card numbers, missing names, dates after the sailing, unknown groups and already-accepted documents (nothing is created)",
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
      refused(t, await send("POST", "/api/groups", { name: "e2e-fixture never saved", status: "e2e-invalid", sail_date: "2027-05-09", recall_date: "2027-12-01" }), 400, "opening a group whose unsold-cabins date is after the sailing", /Unsold cabins go back must be on or before the sailing, May 9, 2027/i);
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
    basis: "ruling: stillafloat-group-bookings.md — Mark's group-marketing screen: interview, facts taken from the group file, share code and replies, all agreeing with the file",
    title: "Mark's group-marketing screen shows the interview, the facts taken from the group file, the share code and the replies for whatever groups he has (a spread), refuses unknown groups, and the dashboard program is wired to it",
    covers: ["GET /api/groups/:id/marketing", "GET /api/groups/:id/interests", "GET /api/groups/:id/marketing/package"],
    modes: ["dev", "prod"],
    // Group marketing is new in the 2026-10-08 release: on prod (before the promotion) these
    // addresses do not exist and this check FAILS — that is correct, not a reason to weaken it.
    run: async (t) => {
      const groups = await groupsList(t);
      // Mark's group files are his business, not the site's (prod is compared only when it has some; dev holds
      // seeded test groups by his 2026-10-04 mirror ruling). The refusals need only an id, so any will do.
      if (t.mode === "dev") t.require(groups.length > 0, "there are no group files on dev (the seeded test groups should be there)");
      const gid = groups[0]?.id || ZERO;
      unauthorized(t, await t.get(`/api/groups/${gid}/marketing`), "GET /api/groups/:id/marketing");
      unauthorized(t, await t.get(`/api/groups/${gid}/interests`), "GET /api/groups/:id/interests");
      // On prod a group with a ship name but no slug is skipped: reading its marketing screen would save the slug (a write).
      const readable = groups.filter((g) => safeMarketingRead(t, g));
      unauthorized(t, await t.get(`/api/groups/${gid}/marketing/package`), "GET /api/groups/:id/marketing/package");
      refused(t, await t.get(`/api/groups/${ZERO}/marketing/package`, { auth: true }), 404, "the package screen of a group that does not exist", /not found/i);
      if (!readable.length) {
        refused(t, await t.get(`/api/groups/${ZERO}/marketing`, { auth: true }), 404, "the marketing screen of a group that does not exist", /not found/i);
        t.equal(t.success(await t.get(`/api/groups/${ZERO}/interests`, { auth: true })).interests.length, 0, "replies listed for a group that does not exist");
      }
      let replies = 0; let live = 0;
      for (const g of spread(readable)) {
        const m = t.success(await t.get(`/api/groups/${g.id}/marketing`, { auth: true }));
        // The marketing PACKAGE screen (Mark 2026-10-10): photos on file, his choice, the renders, the campaign — read-only.
        const pk = t.success(await t.get(`/api/groups/${g.id}/marketing/package`, { auth: true }));
        t.ok(Array.isArray(pk.assets) && Array.isArray(pk.chosen) && Array.isArray(pk.notes) && typeof pk.hasCopy === "boolean", `group ${g.id}: the package screen is missing its lists`);
        for (const a of pk.assets) t.fields(a, ["id", "subject", "public_url", "license", "attribution"], `group ${g.id}: a photo on file`);
        t.ok(pk.chosen.every((id) => pk.assets.some((a) => a.id === id)), `group ${g.id}: a chosen photo is not on file`);
        if (pk.renders) t.fields(pk.renders, ["poster_png", "poster_pdf", "facebook_landscape", "facebook_square", "credits"], `group ${g.id}: the rendered package`);
        if (pk.campaign) { t.equal(pk.campaign.emails.length, 3, `group ${g.id}: the campaign has three emails`); t.fields(pk.campaign.facebook, ["announcement", "reminder", "event_title", "event_description", "boosted"], `group ${g.id}: the Facebook campaign`); }
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
    basis: "ruling: stillafloat-group-bookings.md — a live group page shows exactly Mark's approved copy and the group's facts, never contact details, ids, a card number or the cabins still available (Mark 2026-10-19: \"why would they see the available cabins before I know they are interested\"); unapproved pages stay hidden; Mark 2026-10-20 \"we already had this discussion\": the page is handed the welcome and the button's words, never the poster's headline or pitch; ruling: Mark 2026-10-23 — no ship rating or advisor bio on the invitation page; ruling: Mark 2026-10-24 — the button is \"Save my spot!\" (\"Count me in\" is gone from the page) and after it the guest chooses a road on this page (Talk me into it, Mark! or I've got this)",
    title: "Whenever Mark has a live group page, it shows exactly his approved welcome and button words and the group's facts (English and Spanish) with no contact details, ids or cabin availability, none of the poster's headline or pitch, no ship rating and no advisor bio, and unapproved pages stay hidden",
    covers: ["GET /api/group-page/:code", "page /group.html", "page /es/group.html", "GET /api/groups/:id/marketing"],
    modes: ["dev", "prod"],
    // New in the 2026-10-08 release: prod has neither the pages nor the address before the promotion,
    // and no approved group page after it until Mark approves one — FAIL/UNTESTABLE there is correct.
    run: async (t) => {
      // The page script renders d.facts as `f.<name>` and d.copy as `c.<name>`. Collect the names each
      // twin reads, so a field renamed or dropped by the API (or by one twin only) fails below.
      const reads = {};
      for (const [p, lang] of [["/group.html", "en"], ["/es/group.html", "es"]]) {
        // After "Save my spot!" the guest chooses a road on this same page: its panel posts the choice to /api/group-details/<token>/choice.
        const html = t.html(await t.get(p), { mustContain: ["/api/group-page/", "turnstile", "/interest", "?lang=", 'id="f-website"', "cf-turnstile-response", lang === "es" ? "Aparte mi lugar" : "Save my spot", "/api/group-details/", "/choice"] });
        t.ok(!/count me in|cuenten conmigo/i.test(html), `${p} still says "Count me in" (Mark 2026-10-24: the button is "Save my spot!")`);
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        // The page asks one thing, "I'm interested": no cabin table, no cabin picker (Mark 2026-10-19).
        t.ok(!/id="gp-cabins"|id="f-cabin"|id="sec-cabins"/.test(html), `${p} still has the cabin table or the cabin picker`);
        // Mark 2026-10-23: no ship rating or advisor bio on the invitation page, and the form is one name, one email-or-phone box and how many (no newsletter box)
        t.ok(!/id="sec-rating"/.test(html) && !/Conga/i.test(html), `${p} still has the ship rating (the Conga Line score) block, which the invitation page no longer shows`);
        t.ok(!/data-t="about"|data-t="bio"/.test(html), `${p} still has the advisor bio block, which the invitation page no longer shows`);
        t.ok(/id="f-name"/.test(html) && /id="f-contact"/.test(html) && /id="f-guests"/.test(html), `${p} no longer has the one form of name, email or phone, and how many`);
        t.ok(!/id="f-news"|type="checkbox"|<textarea/.test(html), `${p} still has the newsletter box or the questions box in its form`);
        t.matches(H.metaContent(html, "robots"), /noindex/, `${p} robots (a group page must never be indexed)`);
        t.observe(`${p} title`, H.title(html));
        const names = (re) => [...new Set([...html.matchAll(re)].map((m) => m[1]))].sort();
        reads[lang] = { facts: names(/\bf\.([A-Za-z_]+)/g), copy: names(/\bc\.([A-Za-z_]+)/g) };
        t.atLeast(reads[lang].facts.length, 8, `fact names the ${lang} group page reads`);
        // The page reads the welcome, the organizer's line and the button's words (Mark 2026-10-20): four names. The poster's headline, payoff, intro,
        // why-ship and who-for are not among them.
        t.atLeast(reads[lang].copy.length, 4, `copy names the ${lang} group page reads`);
        t.ok(reads[lang].copy.includes("welcome"), `the ${lang} group page no longer reads the hosts' welcome`);
        for (const k of ["headline", "subhead", "intro", "why_ship", "who_for"]) t.ok(!reads[lang].copy.includes(k), `the ${lang} group page reads copy.${k}, which repeats the poster`);
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
      // Whether Mark has an approved, live page right now is his business, not the site's, so prod is only
      // compared when there is one; dev holds a seeded live test group by his 2026-10-04 mirror ruling.
      if (t.mode === "dev") t.require(live.length > 0, "no group on dev has an approved, live page (the seeded test group should be approved), so the public group page cannot be tested");
      if (!live.length) refused(t, await t.get(`/api/groups/${ZERO}/marketing`, { auth: true }), 404, "the marketing screen of a group that does not exist", /not found/i);
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
        for (const k of ["cabins", "cabinsAvailable", "cabinsTotal"]) t.ok(!(k in pub.facts), `group ${g.id}: the public page's answer carries "${k}" — a visitor must not see cabin availability before Mark knows they are interested`);
        t.nonEmpty(pub.facts.itinerary, `group ${g.id}: itinerary on the public page`);
        t.equal(String(pub.facts.ship).toLowerCase(), String(g.ship_name).toLowerCase(), `group ${g.id}: ship — public page vs group file`);
        t.fields(pub.copy, ["cta_label", "cta_blurb"], `group ${g.id}: public copy`);
        for (const k of ["headline", "subhead", "intro", "why_ship", "who_for"]) t.ok(!(k in pub.copy), `group ${g.id}: the public answer carries the poster's "${k}", which the page must not repeat`);
        t.ok("welcome" in pub.copy, `group ${g.id}: the public copy has no "welcome" (null when the group has none)`);
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
        for (const s of pub.facts.itinerary) t.ok(typeof s.port === "string" && s.port && typeof s.seaDay === "boolean", `group ${g.id}: an itinerary day on the public page has no port`);
        // the dashboard's approved copy and the public copy are the same words, field by field, and the
        // public facts are the dashboard's facts
        const m = t.success(await t.get(`/api/groups/${g.id}/marketing`, { auth: true }));
        const lang0 = langsFor(g)[0];
        for (const k of Object.keys(pub.copy)) {
          t.equal(pub.copy[k] ?? null, m.perLang?.[lang0]?.copy?.[k] ?? null, `group ${g.id}: copy "${k}" — public page vs Mark's approved copy`);
        }
        for (const k of ["groupName", "ship", "sailDateText", "nights", "embarkPort"]) {
          t.equal(JSON.stringify(pub.facts[k]), JSON.stringify(m.perLang?.[lang0]?.facts?.[k]), `group ${g.id}: ${k} — public page vs the marketing screen`);
        }
        // Spanish visitors (/es/group.html asks ?lang=es): a Spanish group answers in Spanish with
        // Mark's Spanish copy; an English-only group falls back to English.
        const es = t.success(await t.get(`/api/group-page/${g.share_code}?lang=es`));
        const esLang = langsFor(g).includes("es") ? "es" : lang0;
        t.equal(es.facts.lang, esLang, `group ${g.id}: language served to ?lang=es`);
        t.equal(es.copy.cta_label, m.perLang?.[esLang]?.copy?.cta_label, `group ${g.id}: button words served to ?lang=es vs Mark's ${esLang} copy`);
        t.equal(es.copy.welcome ?? null, m.perLang?.[esLang]?.copy?.welcome ?? null, `group ${g.id}: welcome served to ?lang=es vs Mark's ${esLang} copy`);
        if (langsFor(g).includes("es")) spanishLive++;
        siteKey = pub.turnstileSiteKey || siteKey;
      }
      t.observe("live group pages", live.length, "info");
      // Last, so every assertion above runs first. Two conditions this box must provide:
      //  • a live page in Spanish — otherwise the Spanish copy path above was only a fallback to English
      //    (dev's test group is English-only);
      //  • a Turnstile site key — the interest form's bot check (dev has no Turnstile keys; prod does).
      // Dev carries these on purpose (Mark's 2026-10-04 mirror ruling: a Spanish test group; Cloudflare test keys).
      // On prod, whether Mark's live group is Spanish is his choice, and the key is held by audience.turnstile-*.
      const missing = [];
      if (spanishLive === 0) missing.push("no live group page is in Spanish, so the Spanish copy and the /es/ page's own answer cannot be checked");
      if (!siteKey) missing.push("the group page offers no Turnstile site key, so the interest form's bot check cannot be exercised");
      t.observe("live group pages in Spanish", spanishLive, "info");
      if (t.mode === "dev") t.require(missing.length === 0, missing.join("; "));
    },
  },
  {
    id: "ops.group-marketing-writes-refuse",
    basis: "ruling: stillafloat-group-bookings.md — group-marketing writes are token-gated; the interest form's bot trap and validation store nothing and email no one (a real reply emails Mark)",
    title: "Group-marketing writes refuse unknown groups and bad statuses, the interest form's bot trap and validation (no name, or no email or phone) store nothing, and asking again for a share code returns the same one",
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
      const bare = await send("POST", `/api/group-page/${L.share_code}/interest`, { lang: "en" }, false); // no name and no way to reach them: can never be stored
      t.ok(bare.status === 400 || bare.status === 429, `an interest reply with no name and no email or phone was not refused: ${bare.describe()}`);
      if (bare.status === 400) refused(t, bare, 400, "an interest reply with no name and no email or phone", /your name|first name|complete the check/i);
      // Mark 2026-10-23: one way to reach them is enough (an email OR a phone), but not none: a name alone is refused and stores nothing
      const noContact = await send("POST", `/api/group-page/${L.share_code}/interest`, { first_name: "E2E Fixture", last_name: "", email: "", phone: "", lang: "en" }, false);
      t.ok(noContact.status === 400 || noContact.status === 429, `an interest reply with a name but no email or phone was not refused: ${noContact.describe()}`);
      if (noContact.status === 400) refused(t, noContact, 400, "an interest reply with a name but no email or phone", /email or a phone|complete the check/i);
      const after = t.success(await t.get(`/api/groups/${L.id}/interests`, { auth: true })).interests.length;
      t.equal(after, before, "replies stored by the refused interest submissions");
      // Both answered "too many requests": the limiter works, but neither the bot trap nor the
      // validation was reached — that is not a pass.
      t.require(trap.status !== 429 || bare.status !== 429, "the interest form's hourly limit (5 per address) was already used up on this box, so neither the bot trap nor the validation was reached this run");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "ops.group-package-roundtrip",
    basis: "ruling: mark-group-marketing-is-a-package.md — Mark 2026-10-10: a poster, email campaign and Facebook campaign built on the line's material, fetched by the system; every piece previewed to him",
    title: "On the dev test group the marketing package can fetch photographs, take Mark's choice, render the poster and Facebook images, and the write routes refuse unknown groups and missing input (writes, dev only)",
    covers: ["POST /api/groups/:id/marketing/assets/fetch", "PUT /api/groups/:id/marketing/package/choose", "POST /api/groups/:id/marketing/package/render",
      "POST /api/groups/:id/marketing/campaign/write", "PUT /api/groups/:id/marketing/campaign"],
    modes: ["dev"],
    devOnlyBecause: "fetching photos, rendering and writing the campaign change the group file and the public bucket; the campaign write is a paid model call, so only its refusal is exercised",
    run: async (t) => {
      const groups = await groupsList(t);
      t.require(groups.length > 0, "there are no group files on dev (the seeded test groups should be there)");
      // refusals first: unknown group → 404 before anything is written or paid for
      for (const [m, path, body] of [["POST", "assets/fetch", {}], ["PUT", "package/choose", { assetIds: [] }], ["POST", "package/render", {}], ["POST", "campaign/write", {}], ["PUT", "campaign", { campaign: null }]]) {
        unauthorized(t, await t.send(m, `/api/groups/${ZERO}/marketing/${path}`, { body }), `${m} /api/groups/:id/marketing/${path}`);
        refused(t, await t.send(m, `/api/groups/${ZERO}/marketing/${path}`, { body, auth: true }), 404, `${path} for a group that does not exist`, /not found/i);
      }
      const g = groups.find((x) => x.ship_name && x.marketing_copy) || groups.find((x) => x.ship_name) || groups[0];
      // fetch: idempotent (only what is missing); afterwards the ship has at least one photo or a note says why not
      const f = t.success(await t.send("POST", `/api/groups/${g.id}/marketing/assets/fetch`, { body: {}, auth: true, timeoutMs: 240_000 }));
      t.ok(Array.isArray(f.assets) && Array.isArray(f.notes), "the fetch answer lists assets and notes");
      t.ok(f.assets.some((a) => a.subject === "ship") || f.notes.some((n) => /^ship:/.test(n)), `no ship photo and no note saying why for ${g.ship_name}`);
      for (const a of f.assets) {
        t.ok(/^(CC0|CC BY|Public domain)/i.test(a.license || "") || a.share_alike || a.source === "line-kit", `a photo with a license the poster may not use: ${a.license}`);
        t.ok(a.attribution && a.public_url, "a photo without a credit line or a public address");
      }
      // choose: the first photo becomes the main one
      if (f.assets.length) {
        const c = t.success(await t.send("PUT", `/api/groups/${g.id}/marketing/package/choose`, { body: { assetIds: [f.assets[0].id] }, auth: true }));
        t.equal(c.chosen[0], f.assets[0].id, "the chosen photo");
      }
      // render: needs page copy and a photo; else it says which is missing
      const r = await t.send("POST", `/api/groups/${g.id}/marketing/package/render`, { body: {}, auth: true, timeoutMs: 240_000 });
      if (r.status === 200) {
        const rd = t.success(r).renders;
        t.fields(rd, ["poster_png", "poster_pdf", "facebook_landscape", "facebook_square", "credits"], "the rendered package");
        for (const k of ["poster_png", "poster_pdf", "facebook_landscape", "facebook_square"]) {
          const img = await t.get(rd[k]);
          t.equal(img.status, 200, `${k} is served from the public bucket`);
        }
      } else refused(t, r, 400, "render without copy or photos", /write the group page copy|no photo on file/i);
      // campaign: a group with no interview answers is refused before the model is called (no spend in a sweep)
      const bare = groups.find((x) => !x.marketing || !x.marketing.why_sailing);
      if (bare) refused(t, await t.send("POST", `/api/groups/${bare.id}/marketing/campaign/write`, { body: {}, auth: true }), 400, "campaign write with no interview", /interview/i);
      // saving an edited campaign re-validates every number against the file
      const pk = t.success(await t.get(`/api/groups/${g.id}/marketing/package`, { auth: true }));
      if (pk.campaign) {
        const edited = { ...pk.campaign, facebook: { ...pk.campaign.facebook, boosted: `${pk.campaign.facebook.boosted} Only 4321 left.` } };
        const sv = t.success(await t.send("PUT", `/api/groups/${g.id}/marketing/campaign`, { body: { campaign: edited }, auth: true }));
        t.ok(sv.problems.some((p) => /4321/.test(p.problem)), "an invented number in an edit is caught");
        t.success(await t.send("PUT", `/api/groups/${g.id}/marketing/campaign`, { body: { campaign: pk.campaign }, auth: true }));   // put it back
      }
      t.observe("photos on file for the test group", f.assets.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // The guest's two roads after "Save my spot!" (migrations 0055 and 0057; server/src/routes/group-details.ts, routes/address.ts, lib/group-details.ts).
  // The CHOICE between the roads is made on the group page (its panel posts /choice); the details page is Road B only — it has no choice call
  // (lib/details-page.test.ts: "the call link is no longer read"), so "/choice" is asserted on the group page, not here.
  // NEW IN THE RELEASE THAT ADDS IT: prod has neither the pages nor the addresses before the promotion, so these FAIL there until
  // then — correct (the same note as ops.group-page-public). The page is the guest's private link: only what a wrong link gets is
  // asked here, because a good link exists only for a real reply, and a sweep never makes one (a reply emails Mark and the guest).
  {
    id: "ops.group-details-public",
    basis: "ruling: Mark 2026-10-24 — after Save my spot! the guest chooses a road: Road B is their own details page in three short parts (who's coming, which cabin suits you, our pick) ending in \"Hold my cabin!\"; the page is private by link and refuses bad tokens",
    title: "The guest's private details page opens in English and Spanish, stays out of search, calls its own API and the address lookup with the bot trap and the hold button, checks itself field by field, shows no price, and any wrong link gets the same plain 'not found' that is never stored or cached",
    covers: ["page /details.html", "page /es/details.html", "GET /api/group-details/:token"],
    modes: ["dev", "prod"],
    run: async (t) => {
      for (const [p, lang] of [["/details.html", "en"], ["/es/details.html", "es"]]) {
        const html = t.html(await t.get(p), { mustContain: ["/api/group-details/", "/api/address/lookup", 'id="d-website"', lang === "es" ? "Apartar mi cabina" : "Hold my cabin", "/pick", "/hold", 'aria-disabled="true"', 'id="d-summary"'] });
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        // a private link: never indexed, and the address that carries it is never sent on to another site
        t.matches(H.metaContent(html, "robots"), /noindex/, `${p} robots (a guest's private page must never be indexed)`);
        t.matches(H.metaContent(html, "referrer"), /no-referrer/, `${p} referrer policy (its address carries the link)`);
        t.ok(!/type="(checkbox|password|email|tel)"/.test(html), `${p} asks for something other than names, birthdays, an address and the four answers`);
        // Mark 2026-10-24: no price is written on the page after the group page, and it no longer says "Count me in"
        t.ok(!/\$\s?\d/.test(html.replace(/<style[\s\S]*?<\/style>/g, "")), `${p} writes a dollar amount on the page (nothing after the group page repeats a price)`);
        t.ok(!/count me in|cuenten conmigo/i.test(html), `${p} still says "Count me in"`);
        // the page's look is the same-site stylesheet it links
        const sheet = /<link rel="stylesheet" href="(\/css\/[a-z-]+\.css)[^"]*"/.exec(html)?.[1];
        t.ok(sheet, `${p} links no same-site stylesheet from /css/`);
        if (sheet) {
          const css = await t.get(sheet);
          t.ok(css.status === 200 && /^text\/css/i.test(css.headers.get("content-type") || ""), `${p}'s stylesheet ${sheet} is not served as CSS: ${css.describe()}`);
          t.ok(/\.err\{[^}]*color:#d12d2d/.test(css.text) && /\.btn\[aria-disabled="true"\]/.test(css.text), `${p}'s stylesheet has lost the red notes or the dim button`);
        }
        t.observe(`${p} title`, H.title(html));
      }
      // Every kind of wrong link: the same answer, never a hint about which part was wrong.
      const bodies = new Set();
      for (const token of ["short", "A".repeat(43), "wrong-link-with-$ymbols!-and-the-right-length", "A".repeat(44)]) {
        const res = await t.get(`/api/group-details/${encodeURIComponent(token)}`);
        refused(t, res, 404, `a wrong guest link (${token.length} characters)`, /^not found$/i);
        t.matches(res.headers.get("cache-control") || "", /no-store/, "Cache-Control of the details answer");
        t.matches(res.headers.get("x-robots-tag") || "", /noindex/, "X-Robots-Tag of the details answer");
        t.matches(res.headers.get("referrer-policy") || "", /no-referrer/, "Referrer-Policy of the details answer");
        bodies.add(res.text);
      }
      t.equal(bodies.size, 1, "different wrong links must all get the identical answer (number of distinct answers)");
    },
  },
  {
    id: "ops.group-details-writes-refuse",
    basis: "ruling: Mark 2026-10-24 — after Save my spot! the guest chooses a road (Talk me into it, Mark! picks a time and gets one email; I've got this fills in the details page, holds the cabin and gets one email); the page is private by link and refuses bad tokens, a time that is not one of the four, and a robot; Mark alone adds the typed travelers to a cabin and closes his items (he books with the cruise line himself); the home address is looked up at the post office, never logged, and only for a person",
    title: "Choosing a time to be rung, picking a cabin, saving details and asking for a hold refuse a link that does not exist, the time must be one of the four answers, the bot trap stores nothing, the address lookup refuses a robot and a short street, and adding a reply's travelers to a cabin or closing Mark's items is his alone and refuses an unknown reply",
    covers: ["POST /api/group-details/:token", "POST /api/group-details/:token/choice", "POST /api/group-details/:token/pick", "POST /api/group-details/:token/hold", "POST /api/address/lookup", "POST /api/address/suggest", "POST /api/groups/:id/interests/:iid/to-file", "POST /api/groups/:id/interests/:iid/mark/:how"],
    modes: ["dev"],
    devOnlyBecause: "it sends POST requests (refusal paths only: a link that does not exist, the bot trap and a request without Mark's token; nothing is stored, nobody is told and the post office is never asked); prod sweeps are read-only",
    run: async (t) => {
      const send = (p, body, auth = false) => t.send("POST", p, { auth, body });
      const form = {
        travelers: [{ legal_name: "Fixture Tester", dob: "1970-01-01" }], address: { street: "1 Fixture Way", city: "Raleigh", state: "NC", zip: "27601", tidied: false },
        concierge: { room: "balcony", priority: "quiet", budget: "middle", motion: "yes" },
      };
      const nowhere = "A".repeat(43);
      for (const [path, body] of [[`/api/group-details/${nowhere}/choice`, { choice: "call", when: "evening" }], [`/api/group-details/${nowhere}/pick`, { concierge: form.concierge }], [`/api/group-details/${nowhere}`, form], [`/api/group-details/${nowhere}/hold`, {}],
        ["/api/group-details/short/choice", { choice: "call", when: "evening" }], ["/api/group-details/short/pick", { concierge: form.concierge }], ["/api/group-details/short", form], ["/api/group-details/short/hold", {}]]) {
        const res = await send(path, body);
        refused(t, res, 404, `POST ${path.replace(nowhere, ":token").replace("short", ":token")} with a link that does not exist`, /^not found$/i);
        t.matches(res.headers.get("cache-control") || "", /no-store/, "Cache-Control of the refused details write");
      }
      // The bot trap answers as if it had been accepted and stores nothing: no pick, no promise.
      for (const path of [`/api/group-details/${nowhere}/choice`, `/api/group-details/${nowhere}/pick`, `/api/group-details/${nowhere}`, `/api/group-details/${nowhere}/hold`]) {
        const trap = await send(path, { ...form, choice: "call", when: "evening", website: "e2e-fixture-honeypot" });
        t.ok(trap.status === 200 && trap.json?.success === true, `the details bot trap should answer as if accepted: ${trap.describe()}`);
        t.ok(!("pick" in (trap.json || {})), "the bot trap must not pretend a cabin was picked");
      }
      // A time that is not one of the four answers is refused before anything else is looked at that a robot could use (a link that does not exist is a 404 first).
      for (const when of ["night", "", null, 3]) {
        const res = await send(`/api/group-details/${nowhere}/choice`, { choice: "call", when });
        refused(t, res, 404, `a call request at a time that is not an answer (${JSON.stringify(when)}) on a link that does not exist`, /^not found$/i);
      }
      // The address lookup: a robot is answered as if nothing could be found (and the post office is never asked); a street under five characters is refused.
      const trap = await send("/api/address/lookup", { q: "123 Main Street", city: "Raleigh", state: "NC", zip: "", website: "e2e-fixture-honeypot" });
      t.ok(trap.status === 200 && trap.json?.success === true && trap.json?.available === false && !("suggestions" in (trap.json || {})), `the address bot trap should answer "not available": ${trap.describe()}`);
      t.matches(trap.headers.get("cache-control") || "", /no-store/, "Cache-Control of the address lookup");
      const short = await send("/api/address/lookup", { q: "12", website: "" });
      refused(t, short, 400, "an address lookup for a street under five characters", /five characters/i);
      // The address type-ahead (Mark 2026-10-26): the same bot trap and the same private headers; with or without its keys it answers in the same shape.
      const ahead = await send("/api/address/suggest", { q: "123 Main", website: "e2e-fixture-honeypot" });
      t.ok(ahead.status === 200 && ahead.json?.success === true && ahead.json?.available === false && !("suggestions" in (ahead.json || {})), `the type-ahead bot trap should answer "not available": ${ahead.describe()}`);
      t.matches(ahead.headers.get("cache-control") || "", /no-store/, "Cache-Control of the address type-ahead");
      const few = await send("/api/address/suggest", { q: "12", website: "" });
      t.ok(few.status === 200 && few.json?.success === true && (few.json?.available === false || (Array.isArray(few.json?.suggestions) && few.json.suggestions.length === 0)), `two characters ask nobody and suggest nothing: ${few.describe()}`);
      // Adding a reply's travelers to a cabin, and the two buttons that close Mark's items, are Mark's alone, and an unknown reply is refused (no traveler is made).
      unauthorized(t, await send(`/api/groups/${ZERO}/interests/${ZERO}/to-file`, { cabin_id: ZERO }), "POST /api/groups/:id/interests/:iid/to-file");
      refused(t, await send(`/api/groups/${ZERO}/interests/${ZERO}/to-file`, { cabin_id: ZERO }, true), 404, "adding the travelers of a reply that does not exist", /reply not found/i);
      refused(t, await send(`/api/groups/${ZERO}/interests/not-an-id/to-file`, { cabin_id: ZERO }, true), 404, "adding the travelers of a malformed reply id", /reply not found/i);
      unauthorized(t, await send(`/api/groups/${ZERO}/interests/${ZERO}/mark/talked`, {}), "POST /api/groups/:id/interests/:iid/mark/:how");
      refused(t, await send(`/api/groups/${ZERO}/interests/${ZERO}/mark/talked`, {}, true), 404, "closing the item of a reply that does not exist", /reply not found/i);
      refused(t, await send(`/api/groups/${ZERO}/interests/${ZERO}/mark/confirmed`, {}, true), 404, "confirming a reply that does not exist", /reply not found/i);
      refused(t, await send(`/api/groups/${ZERO}/interests/${ZERO}/mark/later`, {}, true), 404, "a button that does not exist", /reply not found/i);
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Client paperwork (migrations 0044 and 0052; server/src/routes/group-forms.ts, lib/group-forms.ts).
  // NEW IN THE RELEASE THAT ADDS THEM: prod has neither the page nor the addresses before the promotion,
  // so these FAIL there until then — correct (the same note as ops.group-page-public).
  {
    id: "ops.group-bookings-app",
    basis: "ruling: mark-group-dashboard-big-picture-plus-workhorse.md — Mark 2026-10-25: \"stop relating it to the dashboard. it is a separate entity\", \"the title should be stillafloatcruising.com/groups\", \"only I have access to it\": Group Bookings is its own app at /groups/, and on the live site the door asks for Mark's password before anything loads",
    title: "Group Bookings is its own app at /groups/: on the test site the page and its program load (private, never indexed) and the program talks only to the group API with Mark's key; on the live site /groups/ asks for Mark's password first",
    covers: ["ext:group-bookings app"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const res = await t.get("/groups/");
      if (t.mode === "prod") {
        // the live door: nothing of the app is served without Mark's password
        t.equal(res.status, 401, "HTTP status of /groups/ without Mark's password on the live site");
        t.matches(res.headers.get("www-authenticate") || "", /^Basic /i, "the live site's password challenge on /groups/");
        t.ok(!res.text.includes("/groups/assets/"), "the live site handed out the Group Bookings program without the password");
        return;
      }
      t.status(res, 200);
      const html = t.html(res, { mustContain: ['id="root"', "/groups/assets/", "Group Bookings"] });
      t.matches(H.metaContent(html, "robots"), /noindex/, "robots meta of Group Bookings (a private app is never indexed)");
      t.matches(res.headers.get("x-robots-tag") || "", /noindex/, "X-Robots-Tag of Group Bookings");
      const src = (/src="(\/groups\/assets\/[^"]+\.js)"/.exec(html) || [])[1];
      t.ok(src, "Group Bookings names no program file");
      if (!src) return;
      const js = await t.get(src);
      t.status(js, 200);
      t.matches(js.headers.get("content-type") || "", /javascript/, "the Group Bookings program's content type");
      for (const needle of ["/groups/analytics", "x-affiliate-token", "/api/auth-check", "saf_group_bookings_token", "form-link/send"]) {  // the program joins "/api" and "/groups/analytics" at run time
        t.ok(js.text.includes(needle), `the Group Bookings program no longer mentions ${needle}`);
      }
      t.ok(!js.text.includes("Still Afloat Command Center"), "the Group Bookings program carries the dashboard (it must be its own app)");
    },
  },
  {
    id: "ops.paperwork-link-page",
    basis: "ruling: stillafloat-group-bookings.md — Mark 2026-10-02/03: clients sign on their own private link (only its hash is stored); a wrong link gets one neutral answer that says nothing about whether it ever existed; the page is never indexed; the signed-documents list is for Mark only and never carries a passport, an answer, a token or an audit hash; Mark 2026-10-25 (\"how am I sure the electronic signatures conform legally, like a docusign signature would\"): consent to electronic records before the first signature, an evidence page and our certificate's seal on every signed copy, and the signer's own copies on a link of their own",
    title: "The private paperwork page opens and stays out of search, any wrong link gets the same 'not valid' answer, and the dashboard's signed-documents list is Mark's alone and carries no private detail",
    covers: ["page /forms.html", "GET /api/forms/:token", "GET /api/groups/:id/signatures", "GET /api/groups/:id/signatures/:sid/file", "GET /api/forms/copies/:token", "GET /api/forms/copies/:token/:sid"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const html = t.html(await t.get("/forms.html"), { mustContain: ["/api/forms/", 'id="fm-wiz"', 'id="fm-steps"', 'id="fm-progress"', 'id="fm-next"', 'id="fm-website"'] });
      t.matches(H.metaContent(html, "robots"), /noindex/, "robots meta of the paperwork page (a private link must never be indexed)");
      t.matches(H.metaContent(html, "referrer"), /no-referrer/, "referrer policy of the paperwork page (its address carries the link)");
      t.equal(H.htmlLang(html).slice(0, 2), "en", "language of the paperwork page");

      // Every kind of wrong link: the same answer, never a hint about which part was wrong.
      const bodies = new Set();
      for (const token of ["short", "A".repeat(43), "wrong-link-with-$ymbols!-and-the-right-length"]) { // a traversal-shaped token never reaches the route: the box's proxy answers it first, and that is the proxy's property, not the site's
        const res = await t.get(`/api/forms/${encodeURIComponent(token)}`);
        refused(t, res, 404, `a wrong paperwork link (${token.length} characters)`, /not valid/i);
        t.matches(res.headers.get("cache-control") || "", /no-store/, "Cache-Control of the paperwork answer");
        t.matches(res.headers.get("x-robots-tag") || "", /noindex/, "X-Robots-Tag of the paperwork answer");
        bodies.add(res.text);
      }
      t.equal(bodies.size, 1, "different wrong links must all get the identical answer (number of distinct answers)");

      // Mark 2026-10-25: the signer's copies link (from the "your signed paperwork" email) answers a wrong link the same way.
      for (const path of [`/api/forms/copies/${"A".repeat(43)}`, `/api/forms/copies/${"A".repeat(43)}/${ZERO}.pdf`, "/api/forms/copies/short"]) {
        const res = await t.get(path);
        refused(t, res, 404, `a wrong copies link (${path})`, /not valid/i);
        t.matches(res.headers.get("cache-control") || "", /no-store/, "Cache-Control of the copies answer");
      }

      // Mark's own addresses: refused without his token.
      unauthorized(t, await t.get(`/api/groups/${ZERO}/signatures`), "GET /api/groups/:id/signatures");
      unauthorized(t, await t.get(`/api/groups/${ZERO}/signatures/${ZERO}/file`), "GET /api/groups/:id/signatures/:sid/file");
      refused(t, await t.get(`/api/groups/${ZERO}/signatures`, { auth: true }), 404, "the signed documents of a group that does not exist", /not found/i);
      refused(t, await t.get(`/api/groups/${ZERO}/signatures/${ZERO}/file`, { auth: true }), 404, "the signed copy of a signature that does not exist", /not found/i);

      const groups = await groupsList(t);
      if (t.mode === "dev") t.require(groups.length > 0, "there are no group files on dev, so the signed-documents list cannot be tested");
      let opened = 0;
      for (const g of spread(groups)) {
        const file = t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
        const body = t.success(await t.get(`/api/groups/${g.id}/signatures`, { auth: true }));
        t.ok(Array.isArray(body.signatures), `group ${g.id}: the signed-documents list has no signatures list`);
        t.ok(body.packets && typeof body.packets === "object", `group ${g.id}: the signed-documents list has no per-traveler progress`);
        t.equal(JSON.stringify(body.organizer?.required), JSON.stringify(["09-group-travel-contract"]), `group ${g.id}: the documents asked of the organizer`);
        t.ok(Array.isArray(body.organizer?.signed), `group ${g.id}: the organizer's signed list`);
        // the progress agrees with the group file: one entry per traveler, 2 documents asked (Mark 2026-10-29: About you + Your booking; + the card authorization for a cabin's lead; + 2 fee agreements when the file carries a fee)
        for (const tr of file.travelers) {
          const p = body.packets[tr.id];
          t.ok(p && Array.isArray(p.required) && Array.isArray(p.signed), `group ${g.id}: traveler ${tr.id} has no paperwork progress`);
          t.equal(p.required.length, 2 + (tr.is_lead && tr.cabin_id ? 1 : 0) + (Object.keys(g.fees || {}).length ? 2 : 0), `group ${g.id}: documents asked of traveler ${tr.id} (About you and Your booking; the card authorization for a cabin's lead; the two fee agreements when the file carries a fee)`);
          t.equal(JSON.stringify(p.required.filter((k) => /^2[01]-/.test(k))), JSON.stringify(["20-about-you", "21-your-booking"]), `group ${g.id}: traveler ${tr.id} is asked for the two documents in order`);
          t.ok(!p.required.some((k) => /^(04|06|13|14|15|01|05|07|16|12)-/.test(k)), `group ${g.id}: traveler ${tr.id} is asked for a document that is in no packet (the Cornerstone set went out 2026-10-29)`);
          if (!Object.keys(g.fees || {}).length) t.ok(!p.required.some((k) => /^0[23]-/.test(k)), `group ${g.id}: a group with no fees is asked to sign a fee agreement`);
        }
        const raw = JSON.stringify(body);
        for (const secret of ["passport_enc", "form_token_hash", "consent_ip_hash", "ip_hash", "ua_hash", "pdf_path", "organizer_token_hash", '"answers"', '"ip":', '"ua":', "esign_consent_ip", "copies_token_hash"]) t.ok(!raw.includes(secret), `group ${g.id}: the signed-documents list carries ${secret}`);
        t.ok(!cardShaped(raw), `group ${g.id}: the signed-documents list contains something shaped like a card number`);
        for (const sg of body.signatures) {
          t.fields(sg, ["id", "doc_key", "doc_title", "doc_version", "signer_name", "signer_role", "signed_at", "content_sha256"], `a signature of group ${g.id}`);
          t.matches(sg.content_sha256, /^[0-9a-f]{64}$/, `the document hash of signature ${sg.id}`);
          t.matches(sg.doc_version, /^[0-9a-z-]+@\d{4}-\d{2}-\d{2}$/, `the template version of signature ${sg.id}`);
        }
        const withCopy = body.signatures.find((sg) => sg.has_pdf);
        if (withCopy && opened < 1) {
          const link = t.success(await t.get(`/api/groups/${g.id}/signatures/${withCopy.id}/file`, { auth: true }));
          t.equal(link.expiresIn, 600, `group ${g.id}: the signed copy's link lifetime (seconds)`);
          t.ok(/^https:\/\/[^/]+\/storage\/v1\/object\/sign\/group-docs\/signatures\//.test(String(link.url || "")), `group ${g.id}: the signed copy's link is not a signed private-bucket address`);
          const pdf = await t.get(link.url);
          t.ok((pdf.status === 200 || pdf.status === 206) && pdf.text.startsWith("%PDF"), `group ${g.id}: the signed copy does not download as a PDF (HTTP ${pdf.status})`);
          opened++;
        }
      }
      t.observe("groups checked for signed documents", Math.min(groups.length, 3), "info");
    },
  },
  {
    id: "ops.paperwork-assets-not-banned",
    basis: "incident: 2026-10-28 — the paperwork page loaded its PDF viewer from /vendor/pdfjs-…; the box's attack guard (fail2ban jail nginx-badprobes, /etc/fail2ban/filter.d/nginx-badprobes.conf) bans any address asking for /vendor/, so every client who reached their first document was locked out of the whole site (1 hour on dev, 24 hours on the live site); Mark: \"i cannot see the paperwork\"",
    title: "Nothing the paperwork page loads sits at an address the server's attack guard bans, and its PDF viewer answers where the page asks for it",
    covers: ["page /forms.html"],
    modes: ["dev", "prod"],
    incident: "2026-10-28: opening the first document banned the client's address from the whole site",
    run: async (t) => {
      // The guard's own pattern, word for word (filter.d/nginx-badprobes.conf on both boxes). A file the site serves to its own
      // visitors must never match it: two such requests in 10 minutes ban the visitor.
      const BANNED = /(?:\/\.env|\/\.git|\/\.aws|\/\.ssh|wp-admin|wp-includes|wp-content|xmlrpc\.php|phpmyadmin|\/config\.(?:json|php|yml|yaml)|\/\.DS_Store|\/vendor\/|\/\.vscode)/;
      const html = t.html(await t.get("/forms.html"), { mustContain: ["/js/forms.js"] });
      const pageAssets = [...html.matchAll(/\b(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
      const jsPath = pageAssets.find((p) => p.startsWith("/js/forms.js"));
      t.ok(jsPath, "the paperwork page does not load /js/forms.js");
      const js = await t.get(jsPath || "/js/forms.js");
      t.equal(js.status, 200, "HTTP status of the paperwork program");
      const programAssets = [...js.text.matchAll(/['"](\/(?:js|vendor|css|assets|fonts)\/[^'"\s]+\.(?:m?js|css|woff2?|png|jpe?g|webp|svg))['"]/g)].map((m) => m[1]);
      const pdfAssets = programAssets.filter((p) => /pdf(?:\.worker)?\.min\.js$/.test(p));
      t.equal(pdfAssets.length, 2, "PDF viewer files the paperwork program names (the viewer and its worker)");
      for (const p of [...pageAssets, ...programAssets]) t.ok(!BANNED.test(p), `the paperwork page loads ${p}, an address the attack guard bans`);
      for (const p of pdfAssets) {
        const res = await t.get(p);
        t.equal(res.status, 200, `HTTP status of ${p}`);
        t.matches(res.headers.get("content-type") || "", /javascript/, `content type of ${p}`);
      }
    },
  },
  {
    id: "ops.paperwork-writes-refuse",
    basis: "ruling: stillafloat-group-bookings.md — Mark 2026-10-03: every paperwork write needs Mark's token or the client's own link; unknown travelers, groups and links are refused; the bot trap and a missing agreement store nothing and email no one (dev never emails real people, Mark 2026-10-08); Mark 2026-10-25 (\"how am I sure the electronic signatures conform legally, like a docusign signature would\"): consent to electronic records before the first signature, an evidence page and our certificate's seal on every signed copy, and the signer's own copies on a link of their own",
    title: "Making links, emailing a link, the organizer's link and removing a signature refuse a visitor without Mark's token and unknown travelers and groups, and a signature with no link or a bot trap stores nothing",
    covers: ["POST /api/groups/:id/travelers/:tid/form-link", "POST /api/groups/:id/travelers/:tid/form-link/send", "POST /api/groups/:id/organizer-link", "DELETE /api/groups/:id/signatures/:sid", "POST /api/forms/:token/sign", "POST /api/forms/:token/consent"],
    modes: ["dev"],
    devOnlyBecause: "it sends POST/DELETE requests (refusal paths only: nothing is created and no email is sent); prod sweeps are read-only",
    run: async (t) => {
      const groups = await groupsList(t);
      t.require(groups.length > 0, "there are no group files on dev to aim the refusals at");
      const g = groups[0];
      const send = (m, p, body, auth = true) => t.send(m, p, { auth, body });
      for (const [m, p] of [
        ["POST", `/api/groups/${g.id}/travelers/${ZERO}/form-link`], ["POST", `/api/groups/${g.id}/travelers/${ZERO}/form-link/send`],
        ["POST", `/api/groups/${g.id}/organizer-link`], ["DELETE", `/api/groups/${g.id}/signatures/${ZERO}`],
      ]) unauthorized(t, await send(m, p, {}, false), `${m} ${p.replace(g.id, ":id").replace(ZERO, ":tid")}`);
      refused(t, await send("POST", `/api/groups/${g.id}/travelers/${ZERO}/form-link`, {}), 404, "a link for a traveler who does not exist", /traveler not found/i);
      refused(t, await send("POST", `/api/groups/${g.id}/travelers/${ZERO}/form-link/send`, {}), 404, "an emailed link for a traveler who does not exist", /traveler not found/i);
      refused(t, await send("POST", `/api/groups/${ZERO}/organizer-link`, {}), 404, "an organizer link for a group that does not exist", /group not found/i);
      refused(t, await send("DELETE", `/api/groups/${g.id}/signatures/${ZERO}`), 404, "removing a signature that does not exist", /not found/i);
      // The public signing address: a link that does not exist signs nothing; the bot trap answers as if it had.
      const body = { doc_key: "16-passport-document-checklist", signer_name: "Fixture Tester", agreed: true, content_sha256: "0".repeat(64), answers: {} };
      refused(t, await send("POST", `/api/forms/${"A".repeat(43)}/sign`, body, false), 404, "signing with a link that does not exist", /not valid/i);
      refused(t, await send("POST", "/api/forms/short/sign", body, false), 404, "signing with a malformed link", /not valid/i);
      refused(t, await send("POST", `/api/forms/${"A".repeat(43)}/consent`, { agreed: true }, false), 404, "agreeing to electronic signing with a link that does not exist", /not valid/i);
      const trap = await send("POST", `/api/forms/${"A".repeat(43)}/sign`, { ...body, website: "e2e-fixture-honeypot" }, false);
      t.ok(trap.status === 200 && trap.json?.success === true, `the paperwork bot trap should answer as if accepted: ${trap.describe()}`);
      t.ok(!("packet" in (trap.json || {})) && !("signed" in (trap.json || {})), "the bot trap must not pretend a document was signed");
      // A traveler with no email cannot be emailed a link (nothing is sent from a sweep).
      const file = t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
      const bare = file.travelers.find((x) => !x.email);
      if (bare) refused(t, await send("POST", `/api/groups/${g.id}/travelers/${bare.id}/form-link/send`, {}), 400, "emailing a link to a traveler with no email address", /no email address/i);
    },
  },
  {
    id: "ops.paperwork-roundtrip",
    basis: "ruling: stillafloat-group-bookings.md — Mark 2026-10-02/03: a traveler signs with a typed name and an explicit agreement on their own link; the signature pins the text they saw (changed text is refused); one signature per document; a signed PDF copy is kept in the private bucket; the business is named 'Still Afloat LLC dba Still Afloat Cruising'; no fees unless Mark enters one; the passport never comes back out; Mark 2026-10-25 (\"how am I sure the electronic signatures conform legally, like a docusign signature would\"): consent to electronic records before the first signature, an evidence page and our certificate's seal on every signed copy, and the signer's own copies on a link of their own",
    title: "A throwaway traveler gets a link, sees their documents under the business's legal name, signs one document with a typed name (a wrong hash, no agreement and a second signing are refused), Mark sees the signature and opens its PDF, and removing it asks for the document again",
    covers: ["POST /api/groups/:id/travelers/:tid/form-link", "GET /api/forms/:token", "POST /api/forms/:token/sign", "GET /api/groups/:id/signatures", "GET /api/groups/:id/signatures/:sid/file", "DELETE /api/groups/:id/signatures/:sid", "POST /api/groups/:id/:child", "DELETE /api/groups/:id/:child/:rowId", "GET /api/groups/:id", "POST /api/forms/:token/consent", "POST /api/forms/:token/preview", "GET /api/forms/:token/document/:key"],
    modes: ["dev"],
    devOnlyBecause: "it creates a fixture traveler, signs one document and stores its PDF, then deletes all three (dev database and bucket only; removed in a finally block)",
    run: async (t) => {
      const groups = await groupsList(t);
      t.require(groups.length > 0, "there are no group files on dev to attach the fixture traveler to");
      const g = groups.find((x) => x.status === "draft") || groups[0];
      const open = async () => t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
      const sigs = async () => t.success(await t.get(`/api/groups/${g.id}/signatures`, { auth: true }));
      const NAME = "Fixture Tester";
      const dropSignatures = async (travelerId) => {
        for (const s of (await sigs()).signatures.filter((x) => x.traveler_id === travelerId)) await t.send("DELETE", `/api/groups/${g.id}/signatures/${s.id}`, { auth: true });
      };
      // a run that crashed before its finally block leaves a fixture: clear it first
      let file = await open();
      for (const left of file.travelers.filter((x) => x.first_name === "E2E" && x.last_name === "Fixture")) {
        await dropSignatures(left.id);
        await t.send("DELETE", `/api/groups/${g.id}/travelers/${left.id}`, { auth: true });
        t.note("removed a fixture traveler left by an earlier run");
      }

      let travelerId = null;
      try {
        const add = await t.send("POST", `/api/groups/${g.id}/travelers`, { auth: true, body: { first_name: "E2E", last_name: "Fixture", notes: "Created and deleted by the whole-site release gate." } });
        travelerId = add.json?.row?.id || null; // taken first, so the finally block can always remove it
        t.status(add, 201);
        t.ok(travelerId, "the fixture traveler has no id");

        // the link: shown once, only its hash is kept
        const made = await t.send("POST", `/api/groups/${g.id}/travelers/${travelerId}/form-link`, { auth: true, body: {} });
        t.status(made, 201);
        t.ok(made.json?.success === true, `making the link was not reported as a success: ${made.describe()}`);
        t.matches(made.json.url, /^https?:\/\/[^/]+\/forms\.html\?t=[A-Za-z0-9_-]{43}$/, "the private link's shape");
        const token = new URL(made.json.url).searchParams.get("t");
        file = await open();
        const row = file.travelers.find((x) => x.id === travelerId);
        t.ok(row?.form_sent_at, "making a link did not record when it was sent");
        t.ok(!JSON.stringify(row).includes(token), "the traveler row carries the link itself");
        for (const secret of ["form_token_hash", "passport_enc", "consent_ip_hash", "prospect_id"]) t.ok(!(secret in row), `the traveler row exposes ${secret}`);

        // what the traveler sees
        const res = await t.get(`/api/forms/${token}`);
        const p = t.success(res);
        t.matches(res.headers.get("cache-control") || "", /no-store/, "Cache-Control of the paperwork packet");
        t.equal(p.kind, "traveler", "kind of the paperwork packet");
        const keys = p.docs.map((d) => d.key);
        const fees = Object.keys(file.group.fees || {}).length > 0;
        t.equal(JSON.stringify(keys), JSON.stringify(["15-emergency-contact-form", "01-terms-and-conditions", ...(fees ? ["02-travel-planning-agreement", "03-service-fee-planning-fee-agreement"] : []), "05-liability-waiver", "07-travel-insurance-declination", "16-passport-document-checklist"]), `documents in a traveler's packet (this group ${fees ? "has" : "has no"} fees on file)`);
        t.equal(p.business?.name, "Still Afloat LLC dba Still Afloat Cruising", "the business's legal name on the paperwork");
        for (const d of p.docs) {
          t.ok(d.status === "pending" && /^[0-9a-f]{64}$/.test(d.text_sha256) && d.html.length > 1500, `document ${d.key} is not a real pending document`);
          t.ok(d.html.includes("Still Afloat LLC dba Still Afloat Cruising") && d.html.includes("Affiliate of Cornerstone Collective") && d.html.includes("Seller of Travel"), `document ${d.key} lost the business name or Cornerstone's lines`);
          t.ok(!/\[AGENT |\[INSERT |\[City, State\]|\[list accepted|\\_/.test(d.html), `document ${d.key} still shows an unfilled template placeholder`);
          t.ok(!/Still Afloat LLC(?! dba)/.test(d.html), `document ${d.key} writes the legal name without "dba Still Afloat Cruising"`);
          t.ok(!/name="(card|cardnumber|cc)/i.test(d.html), `document ${d.key} has a card-number input`);
        }
        if (!fees) for (const d of p.docs) t.ok(!/Service Fees|AGENT SERVICE FEES|retainer fee/.test(d.html), `document ${d.key} shows a fee although the group file has none`);
        t.equal(p.docs[0].fields.length, 30, "inputs on the traveler information form (Mark 2026-10-26: one contact by cell phone, nothing medical, no insurance, prescriptions or diet)");
        t.ok(p.docs[0].fields.some((f) => f.kind === "passport" && f.value === null), "the passport input must never come pre-filled");
        const raw = JSON.stringify(p);
        for (const secret of ["passport_enc", "form_token_hash", "consent_ip_hash", "organizer_token_hash", "organizer_email", "prospect_id"]) t.ok(!raw.includes(secret), `the paperwork packet carries ${secret}`);
        t.ok(!cardShaped(raw), "the paperwork packet contains something shaped like a card number");
        t.ok(typeof p.pii_ready === "boolean", "the packet does not say whether passport numbers can be taken");
        // Mark 2026-10-25: the one-time consent to electronic records, before any signature
        t.equal(p.esign?.consent_given_at, null, "a new link's consent to electronic signing");
        t.equal(p.esign?.text?.points?.length, 5, "the things the signer agrees to before signing electronically");
        t.ok(/paper copy/i.test((p.esign?.text?.points || []).join(" ")), "the consent offers a paper copy");
        for (const secret of ["esign_consent_ip", "esign_consent_ua", "copies_token_hash"]) t.ok(!raw.includes(secret), `the paperwork packet carries ${secret}`);

        // Mark 2026-10-27: each document is shown as Mark's own PDF, filled in with what was typed so far; nothing is kept
        const shown = await t.send("POST", `/api/forms/${token}/preview`, { body: { doc_key: "15-emergency-contact-form", answers: { legal_name: "E2E Fixture" } } });
        t.status(shown, 200);
        t.matches(shown.headers.get("content-type") || "", /application\/pdf/, "the filled-in document's type");
        t.matches(shown.headers.get("cache-control") || "", /no-store/, "Cache-Control of the filled-in document");
        refused(t, await t.send("POST", `/api/forms/${token}/preview`, { body: { doc_key: "09-group-travel-contract" } }), 404, "showing a document outside this link's packet", /not part of this paperwork/i);
        const printed = await t.get(`/api/forms/${token}/document/05-liability-waiver`);
        t.status(printed, 200);
        t.matches(printed.headers.get("content-type") || "", /application\/pdf/, "a document's printed form's type");

        // refusals on the real link: nothing is stored by any of them
        const doc = p.docs.find((d) => d.key === "16-passport-document-checklist");
        const sign = (extra = {}, key = "16-passport-document-checklist") => t.send("POST", `/api/forms/${token}/sign`, { body: { doc_key: key, signer_name: NAME, agreed: true, content_sha256: doc.text_sha256, answers: {}, ...extra } });
        const early = await sign({});
        refused(t, early, 400, "signing before agreeing to electronic signing", /signing electronically/i);
        t.equal(early.json.code, "consent-required", "the code of a signature before the consent");
        refused(t, await t.send("POST", `/api/forms/${token}/consent`, { body: { agreed: false } }), 400, "the consent without its box ticked", /tick the box/i);
        const agreed = t.success(await t.send("POST", `/api/forms/${token}/consent`, { body: { agreed: true } }));
        t.fresh(agreed.packet?.esign?.consent_given_at, 1, "the consent's timestamp");
        refused(t, await sign({ agreed: false }), 400, "signing without ticking the agreement", /tick the box/i);
        refused(t, await sign({ signer_name: "Fixture" }), 400, "signing with only one name", /full name/i);
        const stale = await sign({ content_sha256: "0".repeat(64) });
        refused(t, stale, 409, "signing text that is not the text on file", /changed/i);
        t.equal(stale.json.code, "document-changed", "the code of a refused stale signature");
        refused(t, await sign({}, "06-credit-card-authorization"), 404, "signing the card authorization, which is in no packet", /not part of/i);
        refused(t, await sign({}, "09-group-travel-contract"), 404, "signing the group contract with a traveler's link", /not part of/i);
        t.equal((await sigs()).signatures.filter((x) => x.traveler_id === travelerId).length, 0, "signatures stored by the refused attempts");

        // the signature
        const ok = await sign({ newsletter_opt_in: false });
        t.status(ok, 200);
        t.ok(ok.json?.success === true && ok.json.signed === "16-passport-document-checklist", `signing was not reported as a success: ${ok.describe()}`);
        t.equal(ok.json.pdf_saved, true, "whether the signed copy was saved");
        t.equal(ok.json.packet.docs.find((d) => d.key === "16-passport-document-checklist").status, "signed", "status of the document just signed");
        t.equal(ok.json.complete, false, "a packet with one document signed is not complete");
        const again = await sign({});
        refused(t, again, 409, "signing the same document twice", /already signed/i);
        t.equal(again.json.code, "already-signed", "the code of a second signing");

        // what Mark sees
        const list = await sigs();
        const mine = list.signatures.filter((x) => x.traveler_id === travelerId);
        t.equal(mine.length, 1, "signatures on file for the fixture traveler");
        const s = mine[0];
        t.equal(s.doc_key, "16-passport-document-checklist", "document of the signature");
        t.equal(s.signer_name, NAME, "typed name of the signature");
        t.equal(s.signer_role, "traveler", "role of the signature");
        t.equal(s.content_sha256, doc.text_sha256, "the hash the signature pins vs the hash the traveler was shown");
        t.equal(s.doc_version.split("@")[0], "16-passport-document-checklist", "the template version's document");
        t.equal(s.has_pdf, true, "whether the signed copy was kept");
        t.fresh(s.signed_at, 1, "the signature's own timestamp");
        t.equal(list.packets[travelerId].signed.length, 1, "documents signed, in the traveler's progress");
        t.equal(list.packets[travelerId].required.length, keys.length, "documents asked, in the traveler's progress");
        t.equal(list.packets[travelerId].complete, false, "the traveler's progress is complete after one document");
        const link = t.success(await t.get(`/api/groups/${g.id}/signatures/${s.id}/file`, { auth: true }));
        const pdf = await t.get(link.url);
        t.ok((pdf.status === 200 || pdf.status === 206) && pdf.text.startsWith("%PDF"), `the signed copy does not download as a PDF (HTTP ${pdf.status})`);
        t.atLeast(pdf.text.length, 3000, "size of the signed copy in bytes");
        // Mark 2026-10-25: the copy is sealed with the business's certificate (the box carries GROUP_SIGN_P12_*), and the list says so
        t.equal(s.sealed, true, "whether the signed copy is sealed with the business's certificate");
        t.ok(/\/ByteRange\s*\[/.test(pdf.text) && /adbe\.pkcs7\.detached|ETSI\.CAdES\.detached/.test(pdf.text), "the signed copy carries no digital seal");

        // a new link replaces the old one
        const second = await t.send("POST", `/api/groups/${g.id}/travelers/${travelerId}/form-link`, { auth: true, body: {} });
        t.status(second, 201);
        const token2 = new URL(second.json.url).searchParams.get("t");
        t.ok(token2 !== token, "a second link is the same as the first");
        refused(t, await t.get(`/api/forms/${token}`), 404, "the replaced link", /not valid/i);
        const reopened = t.success(await t.get(`/api/forms/${token2}`));
        t.equal(reopened.docs.find((d) => d.key === "16-passport-document-checklist").status, "signed", "status of the signed document on the new link");

        // removing the signature asks for the document again
        t.success(await t.send("DELETE", `/api/groups/${g.id}/signatures/${s.id}`, { auth: true }));
        t.equal((await sigs()).signatures.filter((x) => x.traveler_id === travelerId).length, 0, "signatures left after removing it");
        const asked = t.success(await t.get(`/api/forms/${token2}`));
        t.equal(asked.docs.find((d) => d.key === "16-passport-document-checklist").status, "pending", "status of the document after its signature was removed");
        refused(t, await t.send("DELETE", `/api/groups/${g.id}/signatures/${s.id}`, { auth: true }), 404, "removing the same signature twice", /not found/i);
      } finally {
        if (travelerId) {
          await dropSignatures(travelerId).catch(() => {});
          await t.send("DELETE", `/api/groups/${g.id}/travelers/${travelerId}`, { auth: true }).catch(() => {});
        }
      }
      file = await open();
      t.ok(!file.travelers.some((x) => x.first_name === "E2E" && x.last_name === "Fixture"), "the fixture traveler is still in the group file");
    },
  },
  // ───────────────────────────────────────────────────────────────────────────────────────────
  // The group journey (migration 0053; server/src/lib/group-journey*.ts, routes/group-journey.ts and routes/my-cruise.ts).
  // NEW IN THE RELEASE THAT ADDS IT: prod has none of these addresses before the promotion, so these FAIL there until
  // then — correct (the same note as ops.paperwork-link-page). Prod runs the read-only ones: a prod sweep sends nothing and writes nothing.
  {
    id: "ops.cruise-page-private-link",
    basis: "ruling: stillafloat-group-bookings.md — Mark 2026-10-16: \"a customer CTA / adding info ... embarkation what to know\": every journey email's one button opens the traveler's private cruise page; like the paperwork link it is the only credential, a wrong link of any kind gets one neutral answer in both languages that says nothing about whether it ever existed, and the page is never cached or indexed",
    title: "The private cruise page opens and stays out of search, its script calls only its own address, and every kind of wrong link gets the same 'not valid' answer in English and Spanish",
    covers: ["page /my-cruise.html", "GET /api/my-cruise/:token"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const html = t.html(await t.get("/my-cruise.html"), { mustContain: ["/js/my-cruise.js", 'id="mc-body"', 'id="mc-state"', 'id="mc-lang"'] });
      t.matches(H.metaContent(html, "robots"), /noindex/, "robots meta of the cruise page (a private link must never be indexed)");
      t.matches(H.metaContent(html, "referrer"), /no-referrer/, "referrer policy of the cruise page (its address carries the link)");
      const js = await t.get("/js/my-cruise.js");
      t.status(js, 200);
      for (const needle of ["/api/my-cruise/", "/details", "/checklist/", "data-tick"]) t.ok(js.text.includes(needle), `the cruise page's script no longer contains ${needle}`);
      t.ok(!/https?:\/\/(?!www\.youtube)/.test(js.text.replace(/\/\/ .*$/gm, "").replace(/\^https\?:\\\/\\\//g, "")), "the cruise page's script talks to an address other than its own");

      // Every kind of wrong link: the same answer, never a hint about which part was wrong, never cached or indexed.
      const bodies = new Set();
      for (const token of ["short", "A".repeat(43), "A".repeat(44), "wrong-link-with-$ymbols!-and-the-right-length"]) { // same note as the paperwork probe: a traversal-shaped token is the proxy's to answer, not the site's
        for (const q of ["", "?lang=es"]) {
          const res = await t.get(`/api/my-cruise/${encodeURIComponent(token)}${q}`);
          refused(t, res, 404, `a wrong cruise-page link (${token.length} characters${q})`, /not valid/i);
          t.matches(res.json.error, /no es v[aá]lido/i, "the Spanish half of the neutral answer");
          t.matches(res.headers.get("cache-control") || "", /no-store/, "Cache-Control of the cruise-page answer");
          t.matches(res.headers.get("x-robots-tag") || "", /noindex/, "X-Robots-Tag of the cruise-page answer");
          bodies.add(res.text);
        }
      }
      t.equal(bodies.size, 1, "different wrong links must all get the identical answer (number of distinct answers)");
    },
  },
  {
    id: "ops.cruise-page-writes-refuse",
    basis: "ruling: stillafloat-group-bookings.md — Mark 2026-10-16: travelers add their own details and tick their own checklist on their private cruise page; with no valid link nothing is stored (unknown link: the same neutral 404), the bot trap stores nothing and says nothing, and no card number is ever taken",
    title: "Ticking a checklist item or saving details without a valid link is refused with the neutral answer, the bot trap answers as if it had saved, and an oversized body is refused before any lookup",
    covers: ["POST /api/my-cruise/:token/checklist/:id/done", "POST /api/my-cruise/:token/details"],
    modes: ["dev"],
    devOnlyBecause: "it sends POST requests (refusal paths only: nothing is stored and no email is sent); prod sweeps are read-only",
    run: async (t) => {
      const send = (p, body) => t.send("POST", p, { body });
      for (const token of ["short", "A".repeat(43)]) {
        refused(t, await send(`/api/my-cruise/${token}/checklist/${ZERO}/done`, { done: true }), 404, `ticking with a wrong link (${token.length} characters)`, /not valid/i);
        refused(t, await send(`/api/my-cruise/${token}/details`, { getting_there: "flying" }), 404, `saving details with a wrong link (${token.length} characters)`, /not valid/i);
      }
      const trap = await send(`/api/my-cruise/${"A".repeat(43)}/details`, { website: "e2e-fixture-honeypot", hotel_name: "e2e-fixture" });
      t.ok(trap.status === 200 && trap.json?.success === true, `the cruise page's bot trap should answer as if it had saved: ${trap.describe()}`);
      t.ok(!("message" in (trap.json || {})), "the bot trap must not pretend something was saved");
      const big = await send(`/api/my-cruise/${"A".repeat(43)}/details`, { hotel_name: "x".repeat(30_000) });
      t.equal(big.status, 413, "an oversized details body");
    },
  },
  {
    id: "ops.group-journey-plan-and-preview",
    basis: "ruling: stillafloat-group-bookings.md — Mark 2026-10-16: \"the follow up emails for 120,90,45,20, 10, 5 and 2 days before ... the whole package top to bottom\"; Mark 2026-10-02: templates are approved ONCE after he previews them, in both languages — so the plan lists every message with its approval, and every message renders for a real traveler in English and Spanish with one button, Mark's contact line, the business signature and no blank or invented value",
    title: "Mark's journey plan (every message, its day, its approval and each traveler's state) and the preview of every message in English and Spanish work under his token, are refused without it, and never print a blank, a hidden detail or a hurried tone",
    covers: ["GET /api/groups/:id/journey", "GET /api/groups/:id/journey/preview/:kind"],
    modes: ["dev", "prod"],
    run: async (t) => {
      unauthorized(t, await t.get(`/api/groups/${ZERO}/journey`), "GET /api/groups/:id/journey");
      unauthorized(t, await t.get(`/api/groups/${ZERO}/journey/preview/t-120`), "GET /api/groups/:id/journey/preview/:kind");
      refused(t, await t.get(`/api/groups/${ZERO}/journey`, { auth: true }), 404, "the journey of a group that does not exist", /group not found/i);
      refused(t, await t.get(`/api/groups/${ZERO}/journey/preview/t-120`, { auth: true }), 404, "a preview for a group that does not exist", /group not found/i);

      const groups = await groupsList(t);
      if (t.mode === "dev") t.require(groups.length > 0, "there are no group files on dev, so the journey plan cannot be tested");
      const KINDS = ["confirmation", "t-120", "t-90", "t-45", "t-20", "t-10", "t-5", "t-2", "payment-due", "data-needed", "change-notice"];
      const BAD_TEXT = /undefined|\bnull\b|NaN|\$0(?![\d,.])|\{\{|\[object/;
      let previewed = 0;
      // The groups walked: a spread of the list. A preview needs a traveler, and a real one is a traveler row that is not a gate fixture ("E2E …":
      // another check's fixture may come and go in the same group, so it is never counted). The list cannot say which groups have one (its
      // traveler count is the expected one, two to a cabin), so the files are opened.
      const walk = [...spread(groups)];
      const realTravelers = (f) => f.travelers.filter((x) => x.first_name !== "E2E");
      const openFile = async (g) => t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
      let seed = null;   // the throwaway traveler this check adds when no group walked has a real one (dev only), { groupId, id }
      let travelersExist = false;
      try {
        let real = 0;
        for (const g of walk) {
          const f = await openFile(g);
          if (t.mode === "dev") {
            // one left by an earlier run that crashed before its finally block
            for (const left of f.travelers.filter((x) => x.first_name === "E2E" && x.last_name === PREVIEW_LAST)) {
              await t.send("DELETE", `/api/groups/${g.id}/travelers/${left.id}`, { auth: true });
              t.note("removed a preview traveler left by an earlier run");
            }
          }
          real += realTravelers(f).length;
        }
        if (t.mode === "prod" && real === 0) {
          // Prod is read-only, so nothing can be added there: look at the other groups until one has a traveler, and walk that one too.
          // "Nothing was previewed" is then acceptable only when no group on prod has a traveler at all.
          for (const g of groups.filter((x) => !walk.includes(x))) {
            if (realTravelers(await openFile(g)).length) { walk.push(g); real = 1; break; }
          }
        }
        // Dev's test data has no real traveler whenever its walkthrough was reset (that deletes them), and then no message can be previewed
        // and nothing about the messages is tested. So the check brings its own: one throwaway traveler on a group of the walk, named like
        // every gate fixture ("E2E …": the checks that compare a group's travelers with its plan, and Mark's change-notice preview, leave those
        // out), with the gate's undeliverable address, removed in the finally block.
        if (t.mode === "dev" && real === 0) {
          const home = walk.find((x) => x.sail_date) || walk[0];
          const add = await t.send("POST", `/api/groups/${home.id}/travelers`, { auth: true, body: { first_name: "E2E", last_name: PREVIEW_LAST, email: TEST_ADDRESS, notes: "Created and deleted by the whole-site release gate." } });
          seed = { groupId: home.id, id: add.json?.row?.id || null };   // taken first, so the finally block can always remove it
          t.status(add, 201);
          t.ok(seed.id, "the preview traveler has no id");
          real = 1;
        }
        travelersExist = real > 0;
        for (const g of walk) {
          const file = t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
          const j = t.success(await t.get(`/api/groups/${g.id}/journey`, { auth: true }));
          t.equal(j.milestones.map((m) => m.kind).join(","), KINDS.join(","), `group ${g.id}: the messages in the plan`);
          t.matches(j.template_version, /^\d{4}-\d{2}-\d{2}\.\d+$/, "the template version");
          t.equal(typeof j.sim_enabled, "boolean", "whether this box can run the dry run");
          if (t.mode === "prod") t.equal(j.sim_enabled, false, "the dry run must never be switched on at the production site");
          t.ok(typeof j.link_key_set === "boolean" && typeof j.test_list_set === "boolean" && typeof j.live === "boolean", `group ${g.id}: the plan does not say whether this box can write links, has a test list, or is live`);
          let items = 0;
          for (const m of j.milestones) {
            t.fields(m, ["kind", "label", "counts", "approval"], `plan line ${m.kind}`);
            t.ok(["group", "default", "none"].includes(m.approval.source) && typeof m.approval.approved === "boolean" && typeof m.approval.stale === "boolean", `plan line ${m.kind}: its approval is not readable`);
            const n = /^t-(\d+)$/.exec(m.kind)?.[1];
            if (n && g.sail_date) {
              const want = new Date(Date.parse(`${String(g.sail_date).slice(0, 10)}T00:00:00Z`) - Number(n) * DAY).toISOString().slice(0, 10);
              t.equal(m.date, want, `group ${g.id}: the day the ${n}-day message goes out`);
            }
            items += Object.values(m.counts).reduce((a, b) => a + b, 0) - m.counts.blocked;   // blocked is a count inside due
          }
          // (a release-gate fixture traveler may come and go in this group while the sweep runs: only the real travelers are compared)
          const realIds = file.travelers.filter((x) => x.first_name !== "E2E").map((x) => x.id);
          t.ok(realIds.every((id) => j.travelers.some((x) => x.id === id)), `group ${g.id}: a traveler on the file is missing from the plan`);
          t.equal(j.travelers.filter((x) => !x.name.startsWith("E2E ")).length, realIds.length, `group ${g.id}: travelers in the plan vs the group file`);
          const inTravelers = j.travelers.reduce((a, x) => a + x.items.length, 0);
          t.equal(items, inTravelers, `group ${g.id}: the counts per message add up to the items per traveler`);
          for (const x of j.travelers) t.ok(x.items.every((i) => ["planned", "due", "sent", "failed", "skipped"].includes(i.status)), `group ${g.id}: a plan item has an unknown state`);
          const raw = JSON.stringify(j);
          for (const secret of ["hub_token_hash", "form_token_hash", "passport_enc", "organizer_token_hash", "consent_ip_hash", '"form_data"', "my-cruise.html?t="]) t.ok(!raw.includes(secret), `group ${g.id}: the journey plan carries ${secret}`);
          t.ok(!cardShaped(raw), `group ${g.id}: the journey plan contains something shaped like a card number`);

          // every message, written for a real traveler of this group (or the throwaway one this check added), in both languages
          const asSeed = !realIds.length && seed?.id && seed.groupId === g.id;
          if ((!realIds.length && !asSeed) || previewed >= (t.mode === "prod" ? 1 : 3)) continue;   // (a fixture traveler of another check may be here for a moment: a preview needs a real one)
          previewed++;
          const kinds = previewed === 1 ? KINDS.filter((k) => k !== "change-notice") : ["t-120", "t-5"];
          for (const kind of kinds) {
            for (const lang of ["en", "es"]) {
              const res = await t.get(`/api/groups/${g.id}/journey/preview/${kind}?lang=${lang}${asSeed ? `&traveler_id=${seed.id}` : ""}`, { auth: true });
              if ((kind === "payment-due" || kind === "data-needed") && res.status === 400) {
                refused(t, res, 400, `the ${kind} preview of group ${g.id} when there is nothing to say`, /no unpaid payment|missing nothing|does not hold enough/i);
                continue;
              }
              const p = t.success(res);
              const where = `the ${kind} message of group ${g.id} in ${lang}`;
              t.equal(p.lang, lang, `${where}: its language`);
              t.fields(p, ["subject", "html", "text", "sections", "traveler.id"], where);
              t.ok(Array.isArray(p.sections) && p.sections.length >= 1, `${where}: no sections`);
              t.equal((p.html.match(/data-cta="1"/g) || []).length, 1, `${where}: buttons in the email`);
              t.ok(p.html.includes("/my-cruise.html?t="), `${where}: the button does not open the cruise page`);
              t.matches(p.text, lang === "es" ? /¿Preguntas\? Mark Millham · 919-346-6127 · mark@stillafloatcruising\.com/ : /Questions\? Mark Millham · 919-346-6127 · mark@stillafloatcruising\.com/, `${where}: Mark's contact line`);
              t.equal(p.text.trimEnd().split("\n").pop(), "Still Afloat Cruising", `${where}: the last line`);
              t.matches(p.subject, lang === "es" ? /^(Su reserva está confirmada|Faltan? \d+ días?|Pago con vencimiento|Algunos datos)/ : /^(You are booked|\d+ days? to go|Payment due|A few details)/, `${where}: its subject`);
              const all = `${p.subject}\n${p.text}`;
              t.ok(!BAD_TEXT.test(all), `${where}: has a blank or placeholder (${BAD_TEXT.exec(all)?.[0]})`);
              // The house voice is OUR prose. A video line quotes one of Mark's own published titles as it is
              // ("¡Nunca reserves un camarote a ciegas!" is his title, not our sentence), so those lines are left out.
              const ours = withoutVideoLines(all);
              t.ok(!/!/.test(ours) && !/\bactually\b|\bcheap(er|est)?\b|\bbarat[oa]s?\b/i.test(ours), `${where}: breaks the house voice (an exclamation mark or a banned word)`);
              t.ok(!/\p{Extended_Pictographic}/u.test(ours), `${where}: has an emoji`);
              t.ok(!cardShaped(all), `${where}: contains something shaped like a card number`);
            }
          }
        }
      } finally {
        if (seed?.id) await t.send("DELETE", `/api/groups/${seed.groupId}/travelers/${seed.id}`, { auth: true }).catch(() => {});
      }
      if (seed) {
        const after = t.success(await t.get(`/api/groups/${seed.groupId}?horizon=3650`, { auth: true }));
        t.ok(!after.travelers.some((x) => x.id === seed.id), "the throwaway preview traveler is still in the group file");
      }
      // Dev always has one to preview (its own, if need be). On prod nothing can be added, so no preview is acceptable only when no group
      // there has a traveler (every group file was opened above, or the check would have stopped).
      t.atLeast(previewed, t.mode === "dev" || travelersExist ? 1 : 0, "groups whose messages were previewed");
      t.observe("groups checked for the journey plan", Math.min(groups.length, 3), "info");
    },
  },
  {
    id: "ops.group-journey-writes-refuse",
    basis: "ruling: stillafloat-group-bookings.md — Mark 2026-10-02: a template is approved by him, once; Mark 2026-10-16: change notices and the dry run are his and his alone — so approving, a change notice, a cruise-page link and the dry run refuse a visitor without his token, an unknown group or traveler, a bad kind, a card number and a hopeless notice, and a previewed notice sends and stores nothing (dev never emails real people, Mark 2026-10-08)",
    title: "Approving a template, sending or previewing a change notice, making a cruise-page link and the dry run refuse a visitor without Mark's token and bad requests, and previewing a change notice sends and stores nothing",
    covers: ["PUT /api/groups/:id/journey/approve", "POST /api/groups/:id/journey/change-notice", "POST /api/groups/:id/travelers/:tid/cruise-link", "POST /api/groups/:id/journey/simulate", "DELETE /api/groups/:id/journey/simulate", "GET /api/groups/:id/journey"],
    modes: ["dev"],
    devOnlyBecause: "it sends PUT/POST/DELETE requests (refusal paths and one preview that writes nothing); prod sweeps are read-only",
    run: async (t) => {
      const groups = await groupsList(t);
      t.require(groups.length > 0, "there are no group files on dev to aim the refusals at");
      const g = groups[0];
      const before = t.success(await t.get(`/api/groups/${g.id}/journey`, { auth: true }));
      const send = (m, p, body, auth = true) => t.send(m, p, { auth, body });
      const simOn = before.sim_enabled === true;
      for (const [m, p] of [
        ["PUT", `/api/groups/${g.id}/journey/approve`], ["POST", `/api/groups/${g.id}/journey/change-notice`], ["POST", `/api/groups/${g.id}/travelers/${ZERO}/cruise-link`],
      ]) unauthorized(t, await send(m, p, {}, false), `${m} ${p.replace(g.id, ":id").replace(ZERO, ":tid")}`);
      // the dry run answers like a page that does not exist unless the box asks for it; asked, it wants Mark's token
      for (const m of ["POST", "DELETE"]) {
        const r = await send(m, `/api/groups/${g.id}/journey/simulate`, m === "POST" ? { traveler_id: ZERO, to_email: "e2e-fixture-nobody@example.invalid" } : undefined, false);
        if (simOn) unauthorized(t, r, `${m} /api/groups/:id/journey/simulate`);
        else refused(t, r, 404, `the dry run on a box that does not ask for it (${m})`, /not found/i);
      }

      const approve = (body, gid = g.id) => send("PUT", `/api/groups/${gid}/journey/approve`, body);
      refused(t, await approve({ kinds: [], approved: true }), 400, "approving no message", /kinds must be/i);
      refused(t, await approve({ kinds: ["t-121"], approved: true }), 400, "approving a message that does not exist", /kinds must be/i);
      refused(t, await approve({ kinds: ["change-notice"], approved: true }), 400, "approving a change notice (sending it is its approval)", /kinds must be/i);
      refused(t, await approve({ kinds: ["t-5"], approved: "yes" }), 400, "approving with something that is not yes or no", /approved must be/i);
      refused(t, await approve({ kinds: ["t-5"], approved: true }, ZERO), 404, "approving for a group that does not exist", /group not found/i);

      const notice = (body, q = "", gid = g.id) => send("POST", `/api/groups/${gid}/journey/change-notice${q}`, body);
      refused(t, await notice({}), 400, "a change notice with no text", /Write what changed/i);
      refused(t, await notice({ text: "x".repeat(4001) }), 400, "a change notice that is too long", /too long/i);
      refused(t, await notice({ text: "e2e-fixture", fields: Array.from({ length: 13 }, () => ({ label: "a", before: "b", after: "c" })) }), 400, "a change notice with 13 changed items", /at most 12/i);
      refused(t, await notice({ text: `e2e-fixture ${CARDLIKE}` }), 400, "a change notice holding a card-shaped number", /card number/i);
      refused(t, await notice({ text: "e2e-fixture" }, "", ZERO), 404, "a change notice for a group that does not exist", /group not found/i);
      refused(t, await send("POST", `/api/groups/${g.id}/travelers/${ZERO}/cruise-link`, {}), 404, "a cruise-page link for a traveler who does not exist", /traveler not found/i);
      refused(t, await send("GET", `/api/groups/${g.id}/journey/preview/t-121`), 404, "a preview of a message that does not exist", /unknown message kind/i);
      refused(t, await send("GET", `/api/groups/${g.id}/journey/preview/change-notice`), 404, "a preview of a change notice through the template route", /unknown message kind/i);

      // a previewed notice shows what would go out and to whom, and sends and stores nothing
      const file = t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
      if (file.travelers.length) {
        const pv = await notice({ text: "e2e-fixture preview only", fields: [{ label: "Ship", before: "A", after: "B" }] }, "?preview=1");
        const body = t.success(pv);
        t.fields(body, ["subject", "html", "text", "recipients"], "the change notice preview");
        t.ok(Array.isArray(body.recipients) && file.travelers.filter((x) => x.first_name !== "E2E").every((x) => body.recipients.some((r) => r.id === x.id)), "the preview's recipients vs the travelers on file");
        t.ok(body.recipients.every((r) => typeof r.willSend === "boolean" && (r.willSend || r.reason)), "a recipient who will not be written to has no reason");
        t.equal(body.sections.join(","), "notice,change", "the sections of a change notice with a changed item");
        t.ok(body.html.includes("e2e-fixture preview only"), "the preview does not show Mark's text");
        const after = t.success(await t.get(`/api/groups/${g.id}/journey`, { auth: true }));
        const real = (r) => r.messages.filter((m) => !m.sim);   // a dry run of the same sweep may add and remove simulated rows meanwhile
        t.equal(real(after).length, real(before).length, "journey emails in the log before and after a previewed notice");
        t.equal(real(after).filter((m) => m.template === "change-notice").length, real(before).filter((m) => m.template === "change-notice").length, "change notices on record before and after a preview");
      }

      // an approval round trip on a real group, put back exactly as it was: approve, see it, hand the decision back to the site default
      const pick = before.milestones.find((m) => m.kind === "t-5" && m.approval.source !== "group") ?? before.milestones.find((m) => m.kind !== "change-notice" && m.approval.source !== "group");
      t.require(pick, "every message on the test group already has a decision of its own, so an approval cannot be tried and put back");
      try {
        t.success(await approve({ kinds: [pick.kind], approved: true }));
        const on = t.success(await t.get(`/api/groups/${g.id}/journey`, { auth: true })).milestones.find((m) => m.kind === pick.kind);
        t.ok(on.approval.approved === true && on.approval.source === "group", `after approving ${pick.kind} it is not shown as approved for the group`);
        t.fresh(on.approval.at, 1, "the approval's own timestamp");
      } finally {
        t.success(await approve({ kinds: [pick.kind], approved: null }));
      }
      const back = t.success(await t.get(`/api/groups/${g.id}/journey`, { auth: true })).milestones.find((m) => m.kind === pick.kind);
      t.equal(back.approval.source, pick.approval.source, `where the ${pick.kind} approval comes from, before and after the round trip`);
      t.equal(back.approval.approved, pick.approval.approved, `whether ${pick.kind} is approved, before and after the round trip`);
    },
  },
  {
    id: "ops.cruise-page-roundtrip",
    basis: "ruling: stillafloat-group-bookings.md — Mark 2026-10-16: \"a customer CTA / adding info\": a traveler opens their private cruise page (one link, derived so every email can carry it, and it opens their paperwork too), sees their cruise in their language, ticks their checklist and tells us how they are getting there; what they say lands on their file, a bad answer or a card number is refused, and the page never carries a passport, a token or a hash",
    title: "A throwaway traveler gets a cruise-page link, opens the page in English and Spanish, ticks and unticks a checklist item, saves and then corrects their flight and emergency contact, and Mark sees it on the file; the same link opens their paperwork; all of it is removed afterwards",
    covers: ["POST /api/groups/:id/travelers/:tid/cruise-link", "GET /api/my-cruise/:token", "POST /api/my-cruise/:token/checklist/:id/done", "POST /api/my-cruise/:token/details", "GET /api/forms/:token", "GET /api/groups/:id/journey", "GET /api/groups/:id", "POST /api/groups/:id/:child", "DELETE /api/groups/:id/:child/:rowId"],
    modes: ["dev"],
    devOnlyBecause: "it creates a fixture traveler and checklist row, writes to them through the public cruise-page routes, then deletes both (dev database only; removed in a finally block)",
    run: async (t) => {
      const groups = await groupsList(t);
      t.require(groups.length > 0, "there are no group files on dev to attach the fixture traveler to");
      const g = groups.find((x) => x.status === "draft") || groups[0];
      const open = async () => t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
      const ROW = "e2e-fixture journey checklist row (safe to delete)";
      // a run that crashed before its finally block leaves fixtures: clear them first
      let file = await open();
      for (const left of file.travelers.filter((x) => x.first_name === "E2E" && x.last_name === "Journey Fixture")) { await t.send("DELETE", `/api/groups/${g.id}/travelers/${left.id}`, { auth: true }); t.note("removed a fixture traveler left by an earlier run"); }
      for (const left of file.checklist.filter((x) => x.title === ROW)) await t.send("DELETE", `/api/groups/${g.id}/checklist/${left.id}`, { auth: true });

      let travelerId = null; let rowId = null;
      try {
        const add = await t.send("POST", `/api/groups/${g.id}/travelers`, { auth: true, body: { first_name: "E2E", last_name: "Journey Fixture", notes: "Created and deleted by the whole-site release gate." } });
        travelerId = add.json?.row?.id || null;
        t.status(add, 201);
        const mk = await t.send("POST", `/api/groups/${g.id}/checklist`, { auth: true, body: { title: ROW, audience: "client", kind: "task", detail: "Written by the release gate." } });
        rowId = mk.json?.row?.id || null;
        t.status(mk, 201);
        t.ok(travelerId && rowId, "the fixture traveler or checklist row has no id");

        // the link: derived, so asking again gives the same one
        const made = await t.send("POST", `/api/groups/${g.id}/travelers/${travelerId}/cruise-link`, { auth: true, body: {} });
        t.status(made, 201);
        t.matches(made.json.url, /^https?:\/\/[^/]+\/my-cruise\.html\?t=[A-Za-z0-9_-]{43}$/, "the cruise-page link's shape");
        const token = new URL(made.json.url).searchParams.get("t");
        const again = await t.send("POST", `/api/groups/${g.id}/travelers/${travelerId}/cruise-link`, { auth: true, body: {} });
        t.equal(again.json?.url, made.json.url, "asking for the cruise-page link a second time (it is derived, so it never changes)");
        file = await open();
        const row = file.travelers.find((x) => x.id === travelerId);
        t.ok(!JSON.stringify(row).includes(token), "the traveler row carries the cruise-page link itself");
        for (const secret of ["hub_token_hash", "form_token_hash", "passport_enc"]) t.ok(!(secret in row), `the traveler row exposes ${secret}`);

        // what the traveler sees, in English and in Spanish
        const res = await t.get(`/api/my-cruise/${token}`);
        const p = t.success(res);
        t.matches(res.headers.get("cache-control") || "", /no-store/, "Cache-Control of the cruise page");
        t.equal(p.lang, "en", "language of the cruise page");
        t.equal(p.hello, "Hello E2E.", "the greeting");
        t.fields(p, ["ui.save", "business.contact", "sections", "details.fields"], "the cruise page");
        const keys = p.sections.map((s) => s.key);
        for (const k of ["details", "checklist", "embark", "documents", "passport"]) t.ok(keys.includes(k), `the cruise page has no ${k} section (has: ${keys.join(", ")})`);
        if (file.group.sail_date) {
          const days = Math.round((Date.parse(`${String(file.group.sail_date).slice(0, 10)}T00:00:00Z`) - Date.parse(`${new Date(t.now()).toISOString().slice(0, 10)}T00:00:00Z`)) / DAY);
          if (days >= 0) t.ok(p.countdown && Math.abs(p.countdown.days - days) <= 1, `the countdown (${p.countdown?.days}) is not the days to sailing (${days})`);
        }
        const item = p.sections.find((s) => s.key === "checklist").checklist.find((x) => x.id === rowId);
        t.ok(item && item.done === false, "the fixture checklist row is not on the page, or already done");
        const raw = JSON.stringify(p);
        for (const secret of ["passport_enc", "form_token_hash", "hub_token_hash", "organizer_token_hash", "prospect_id"]) t.ok(!raw.includes(secret), `the cruise page carries ${secret}`);
        t.ok(!cardShaped(raw), "the cruise page contains something shaped like a card number");
        const es = t.success(await t.get(`/api/my-cruise/${token}?lang=es`));
        t.equal(es.lang, "es", "language of the Spanish cruise page");
        t.equal(es.hello, "Hola E2E.", "the Spanish greeting");
        t.equal(es.ui.save, "Guardar", "a Spanish button");
        for (const k of ["details", "checklist", "embark", "documents", "passport"]) t.ok(es.sections.some((s) => s.key === k), `the Spanish page has no ${k} section`);

        // the same link opens the paperwork page's data
        const forms = t.success(await t.get(`/api/forms/${token}`));
        t.equal(forms.kind, "traveler", "the cruise-page link opening the paperwork");
        t.equal(forms.traveler.first_name, "E2E", "whose paperwork the cruise-page link opens");

        // ticking, and taking it back
        const tick = (done) => t.send("POST", `/api/my-cruise/${token}/checklist/${rowId}/done`, { body: { done } });
        const doneNow = async () => t.success(await t.get(`/api/my-cruise/${token}`)).sections.find((s) => s.key === "checklist").checklist.find((x) => x.id === rowId).done;
        t.success(await tick(true));
        t.equal(await doneNow(), true, "the fixture item after the traveler ticked it");
        refused(t, await t.send("POST", `/api/my-cruise/${token}/checklist/${ZERO}/done`, { body: {} }), 404, "ticking an item that is not on the traveler's list", /not on your list/i);
        t.success(await tick(false));
        t.equal(await doneNow(), false, "the fixture item after the traveler took the tick back");

        // telling us how they are getting there
        const save = (body, q = "") => t.send("POST", `/api/my-cruise/${token}/details${q}`, { body });
        const bad = await save({ getting_there: "teleport", flight_in_date: "2099-02-30", flight_in_time: "25:00", hotel_name: CARDLIKE, emergency_name: "E2E Contact" });
        refused(t, bad, 400, "saving details with wrong answers", /check the lines marked/i);
        t.equal(Object.keys(bad.json.fields).sort().join(","), "emergency_phone,flight_in_date,flight_in_time,getting_there,hotel_name", "which answers were marked");
        t.matches(bad.json.fields.hotel_name, /Card numbers are never collected/i, "the card refusal");
        file = await open();
        const stored = file.travelers.find((x) => x.id === travelerId)?.form_data?.journey || {};
        t.ok(!["getting_there", "flight_in_date", "flight_in_time", "hotel_name"].some((k) => k in stored), "a refused save stored something");
        const ok = await save({ getting_there: "flying", flight_in_flight: "E2E 100", flight_in_date: "2099-03-05", flight_in_time: "14:30", port_arrival_time: "11:00", emergency_name: "E2E Contact", emergency_phone: "919-555-0100" });
        t.success(ok);
        const saved = t.success(await t.get(`/api/my-cruise/${token}`));
        t.equal(saved.details.values.flight_in_flight, "E2E 100", "the flight the traveler saved, read back on their page");
        t.equal(saved.details.values.emergency_phone, "919-555-0100", "the emergency phone, read back on their page");
        t.ok(!saved.sections.some((s) => s.key === "missing" && s.items.some((i) => /How you are getting to the port/.test(i.text))), "the page still asks how they are getting to the port after they said");
        t.ok(JSON.stringify(saved.sections.find((s) => s.key === "travel")).includes("E2E 100"), "the page's own list of travel plans does not show the flight");
        file = await open();
        const mine = file.travelers.find((x) => x.id === travelerId);
        t.equal(mine.form_data.journey.flight_in_flight, "E2E 100", "the flight on the group file");
        t.equal(mine.emergency_name, "E2E Contact", "the emergency contact on the group file");
        // correcting it clears what is blanked and keeps the rest
        t.success(await save({ flight_in_flight: "", flight_in_time: "" }));
        file = await open();
        const fixed = file.travelers.find((x) => x.id === travelerId).form_data.journey;
        t.ok(!("flight_in_flight" in fixed) && !("flight_in_time" in fixed) && fixed.flight_in_date === "2099-03-05" && fixed.getting_there === "flying", "a blanked answer is cleared and the others are kept");
        // Mark sees it too
        const told = t.success(await t.get(`/api/groups/${g.id}/journey`, { auth: true })).told.find((x) => x.traveler_id === travelerId);
        t.ok(told && told.answers.getting_there === "flying", "what the traveler told us is not on Mark's journey card");
      } finally {
        if (rowId) await t.send("DELETE", `/api/groups/${g.id}/checklist/${rowId}`, { auth: true }).catch(() => {});
        if (travelerId) await t.send("DELETE", `/api/groups/${g.id}/travelers/${travelerId}`, { auth: true }).catch(() => {});
      }
      file = await open();
      t.ok(!file.travelers.some((x) => x.first_name === "E2E" && x.last_name === "Journey Fixture"), "the fixture traveler is still in the group file");
      t.ok(!file.checklist.some((x) => x.title === ROW), "the fixture checklist row is still in the group file");
    },
  },
  {
    id: "ops.group-journey-simulate",
    basis: "ruling: stillafloat-group-bookings.md — Mark 2026-10-16: \"simulate the entire process ... the follow up emails for 120,90,45,20, 10, 5 and 2 days before ... the whole package top to bottom\"; Mark 2026-10-08: dev never emails real people — so the dry run writes the whole sequence for a throwaway traveler in either language, to a test address only if the box's list names it, logs it under simulation keys and removes cleanly",
    title: "The dry run writes the booking confirmation and the 120, 90, 45, 20, 10, 5 and 2-day emails for a throwaway traveler in English and in Spanish, each with its sections and no blank or placeholder, emails no one it should not, and its log is removed afterwards",
    covers: ["POST /api/groups/:id/journey/simulate", "DELETE /api/groups/:id/journey/simulate", "GET /api/groups/:id/journey", "GET /api/groups/:id", "POST /api/groups/:id/:child", "DELETE /api/groups/:id/:child/:rowId"],
    modes: ["dev"],
    devOnlyBecause: "it exists only on a box that asks for it (GROUP_JOURNEY_SIM=1, never the production site), creates throwaway travelers and simulated log rows, and deletes them all (dev database only; removed in a finally block)",
    run: async (t) => {
      const groups = await groupsList(t);
      t.require(groups.length > 0, "there are no group files on dev to run the dry run on");
      const g = groups.find((x) => x.sail_date && x.status === "draft") || groups.find((x) => x.sail_date);
      t.require(g, "no group file on dev has a sail date, which the countdown needs");
      const plan = async () => t.success(await t.get(`/api/groups/${g.id}/journey`, { auth: true }));
      t.require((await plan()).sim_enabled === true, "the dry run is off on this box: add GROUP_JOURNEY_SIM=1 to this box's shared.env (it is never allowed on the production site)");
      const open = async () => t.success(await t.get(`/api/groups/${g.id}?horizon=3650`, { auth: true }));
      let file = await open();
      for (const left of file.travelers.filter((x) => x.first_name === "E2E" && /^Sim Fixture/.test(x.last_name || ""))) { await t.send("DELETE", `/api/groups/${g.id}/travelers/${left.id}`, { auth: true }); t.note("removed a fixture traveler left by an earlier run"); }
      await t.send("DELETE", `/api/groups/${g.id}/journey/simulate`, { auth: true });

      const SUBJECTS = {
        // A countdown subject names only the sections that message carries (Mark 2026-10-19: the 45-day message promised excursions and dining
        // the file did not hold), so each may open with any of its topics, or with its fallback when it has none (group-journey-strings topicFor).
        en: [/^You are booked/, /^\d+ days to go: (payments|paperwork|what to do first)/, /^\d+ days to go: (final payment|line deadlines|getting to the ship|what is open on your file)/, /^\d+ days to go: (excursions|dining|what is still open|where your cruise stands)/, /^\d+ days to go: check-in, documents and packing/, /^\d+ days to go: (your ship|how boarding day works)/, /^\d+ days to go: (the forecast for your cruise|Storm Watch and your cruise|a last note before you sail)/, /^\d+ days? to go: check-in, boarding/],
        es: [/^Su reserva está confirmada/, /^Faltan \d+ días: (pagos|documentos|qué hacer primero)/, /^Faltan \d+ días: (pago final|fechas de la naviera|cómo llegar al barco|lo que está pendiente en su archivo)/, /^Faltan \d+ días: (excursiones|comidas|lo que sigue pendiente|cómo va su crucero)/, /^Faltan \d+ días: registro, documentos/, /^Faltan \d+ días: (su barco|cómo funciona el día de embarque)/, /^Faltan \d+ días: (el pronóstico del tiempo para su crucero|Storm Watch y su crucero|una última nota antes de zarpar)/, /^Faltan? \d+ días?: registro, embarque/],
      };
      const KINDS = ["confirmation", "t-120", "t-90", "t-45", "t-20", "t-10", "t-5", "t-2"];
      const BAD_TEXT = /undefined|\bnull\b|NaN|\$0(?![\d,.])|\{\{|\[object/;
      const made = [];
      try {
        for (const [lang, last] of [["en", "Sim Fixture"], ["es", "Sim Fixture ES"]]) {
          const add = await t.send("POST", `/api/groups/${g.id}/travelers`, { auth: true, body: { first_name: "E2E", last_name: last, email: TEST_ADDRESS, lang, notes: "Created and deleted by the whole-site release gate." } });
          t.status(add, 201);
          const tid = add.json?.row?.id; t.ok(tid, "the fixture traveler has no id");
          made.push(tid);
          const run = await t.send("POST", `/api/groups/${g.id}/journey/simulate`, { auth: true, body: { traveler_id: tid, to_email: TEST_ADDRESS } });
          t.status(run, 201);
          t.ok(run.json?.success === true, `the dry run was not reported as a success: ${run.describe()}`);
          t.equal(run.json.count, 8, `messages written by the dry run (${lang})`);
          t.equal(run.json.messages.map((m) => m.kind).join(","), KINDS.join(","), `the order of the dry run (${lang})`);
          run.json.messages.forEach((m, i) => {
            const where = `the ${m.kind} message in ${lang}`;
            t.matches(m.subject, SUBJECTS[lang][i], `${where}: its subject`);
            t.ok(Array.isArray(m.sections) && m.sections.length >= 1 && m.sections.every((s) => /^[a-z-]+$/.test(s)), `${where}: its section names`);
            const all = `${m.subject}\n${m.text}`;
            t.ok(!BAD_TEXT.test(all), `${where}: has a blank or placeholder (${BAD_TEXT.exec(all)?.[0]})`);
            const ours = withoutVideoLines(all); // video titles are Mark's own, quoted as published (see the plan-and-preview check)
            t.ok(!/!/.test(ours) && !/\p{Extended_Pictographic}/u.test(ours), `${where}: has an exclamation mark or an emoji`);
            t.ok(m.text.includes("/my-cruise.html?t="), `${where}: the link to the cruise page is missing`);
            t.equal(m.text.trimEnd().split("\n").pop(), "Still Afloat Cruising", `${where}: the last line`);
            // nothing is emailed unless the box's test list names this address: a reserved address never is
            t.ok(m.status === "skipped" || m.status === "sent", `${where}: was ${m.status} (${m.reason})`);
            if (m.status === "skipped") t.matches(m.reason, /test address/i, `${where}: why it was not sent`);
          });
          t.equal(run.json.messages.filter((m) => m.kind === "t-5").every((m) => m.sections.includes("sailing")), true, `the 5-day message keeps its sailing section (${lang})`);
          // Mark's log shows them, marked as simulated, for this traveler only
          const log = (await plan()).messages.filter((m) => m.traveler_id === tid);
          t.equal(log.length, 8, `simulated messages in the log (${lang})`);
          t.ok(log.every((m) => m.sim === true && m.to_email === TEST_ADDRESS), `a simulated message in the log is not marked as simulated (${lang})`);
          // and none of them blocks or counts as a real send
          const mine = (await plan()).travelers.find((x) => x.id === tid);
          t.ok(mine && !mine.items.some((i) => i.status === "sent"), `a simulated message counted as sent in the plan (${lang})`);
          const gone = await t.send("DELETE", `/api/groups/${g.id}/journey/simulate?traveler_id=${tid}`, { auth: true });
          t.equal(t.success(gone).removed, 8, `simulated messages removed (${lang})`);
        }
        refused(t, await t.send("POST", `/api/groups/${g.id}/journey/simulate`, { auth: true, body: { traveler_id: ZERO, to_email: TEST_ADDRESS } }), 404, "a dry run for a traveler that does not exist", /traveler not found/i);
        refused(t, await t.send("POST", `/api/groups/${g.id}/journey/simulate`, { auth: true, body: { traveler_id: made[0], to_email: "not-an-address" } }), 400, "a dry run to something that is not an address", /test address/i);
      } finally {
        await t.send("DELETE", `/api/groups/${g.id}/journey/simulate`, { auth: true }).catch(() => {});
        for (const tid of made) await t.send("DELETE", `/api/groups/${g.id}/travelers/${tid}`, { auth: true }).catch(() => {});
      }
      file = await open();
      t.ok(!file.travelers.some((x) => x.first_name === "E2E" && /^Sim Fixture/.test(x.last_name || "")), "a fixture traveler is still in the group file");
      t.equal((await plan()).messages.filter((m) => m.sim).length, 0, "simulated messages left in the log");
    },
  },
];
