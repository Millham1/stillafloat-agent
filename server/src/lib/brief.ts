import { readJson, writeJson } from "./persistence";
import { loadQueue } from "./social-agent";
import { sendPush } from "./push";
import { logger } from "./logger";

// ── Daily brief assembler + delivery ───────────────────────────────────────────
// One readable, actionable brief, assembled on our own box. Ops data (calendar,
// Gmail action queue, tasks, phone notes, money) comes from the ops-manager's
// /brief/feed; the social-media queue is local. Delivery is in-house: the dashboard
// Today page reads the stored brief, Web Push nudges the phone, and an archivable
// copy goes out via Resend. No Telegram, no third-party orchestration.

const OPS_BASE = (process.env["OPS_MANAGER_URL"] ?? "http://127.0.0.1:5000").replace(/\/+$/, "");
const BRIEF_KEY = "daily-brief";
const TZ = process.env["TIMEZONE"] || "America/New_York";
const SITE = "https://stillafloatcruising.com";

export interface ActionItem {
  thread_id: string; label: string; priority: string;
  sender: string; subject: string; snippet: string; unread: boolean; url: string;
}
export interface CalEvent {
  title: string; time: string; start_iso: string | null; all_day: boolean; location: string; link: string;
}
export interface TaskItem { id: string; title: string; status: string; priority?: string | null; due_date?: string | null; }
export interface IdeaItem { id: string; note: string; category?: string | null; }
export interface BillItem { vendor: string; due_date?: string | null }
export interface PulseChannel { trend: "up" | "down" | "steady"; tip: string; views?: number; subs?: number; reach?: number; new_followers?: number }
export interface Pulse { youtube?: PulseChannel; facebook?: PulseChannel; facebook_status?: string }
export interface SocialBlock {
  pending: number;
  items: Array<{ title: string; track: string }>;
  reviewPath: string;
}

export interface Brief {
  date: string;
  generatedAt: string;
  nothingToDo: boolean;
  opsReachable: boolean;
  sections: {
    actions: ActionItem[];
    calendar: CalEvent[];
    tasks: TaskItem[];
    ideas: { count: number; items: IdeaItem[] };
    bills: BillItem[];
    pulse: Pulse;
    social: SocialBlock;
  };
  counts: { actions: number; tasks: number; ideasNew: number; socialPending: number; events: number };
}

interface OpsFeed {
  calendar?: CalEvent[];
  actions?: ActionItem[];
  tasks?: TaskItem[];
  ideas?: { count: number; items: IdeaItem[] };
  bills?: BillItem[];
  pulse?: Pulse;
}

async function fetchOpsFeed(): Promise<OpsFeed | null> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key) {
    logger.warn("brief: IDEAS_API_KEY unset — ops feed skipped");
    return null;
  }
  try {
    const r = await fetch(`${OPS_BASE}/brief/feed`, {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      logger.warn({ status: r.status }, "brief: ops feed non-200");
      return null;
    }
    return (await r.json()) as OpsFeed;
  } catch (err) {
    logger.warn({ err }, "brief: ops-manager unreachable");
    return null;
  }
}

function localDateLabel(): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: TZ,
  }).format(new Date());
}

/** Assemble the brief from all sources and persist it. */
export async function assembleBrief(): Promise<Brief> {
  const [ops, queue] = await Promise.all([
    fetchOpsFeed(),
    loadQueue().catch(() => ({ batches: [] as Array<{ status: string; title: string; track: string }> })),
  ]);

  const pending = queue.batches.filter((b) => b.status === "pending");
  const social: SocialBlock = {
    pending: pending.length,
    items: pending.slice(0, 5).map((b) => ({ title: b.title, track: b.track })),
    reviewPath: "/api/social/review",
  };

  const actions = ops?.actions ?? [];
  const calendar = ops?.calendar ?? [];
  const tasks = ops?.tasks ?? [];
  const ideas = ops?.ideas ?? { count: 0, items: [] };
  const bills = ops?.bills ?? [];
  const pulse = ops?.pulse ?? {};

  const nothingToDo =
    actions.length === 0 && tasks.length === 0 && ideas.count === 0 && social.pending === 0;

  const brief: Brief = {
    date: localDateLabel(),
    generatedAt: new Date().toISOString(),
    nothingToDo,
    opsReachable: ops !== null,
    sections: { actions, calendar, tasks, ideas, bills, pulse, social },
    counts: {
      actions: actions.length,
      tasks: tasks.length,
      ideasNew: ideas.count,
      socialPending: social.pending,
      events: calendar.length,
    },
  };

  await writeJson(BRIEF_KEY, brief);
  return brief;
}

export async function getStoredBrief(): Promise<Brief | null> {
  return readJson<Brief | null>(BRIEF_KEY, null);
}

/** One-line summary for the push notification body. */
function pushBody(brief: Brief): string {
  if (brief.nothingToDo) return "Nothing needs you today. Enjoy it. ⚓";
  const bits: string[] = [];
  if (brief.counts.actions) bits.push(`${brief.counts.actions} to reply to`);
  if (brief.counts.events) bits.push(`${brief.counts.events} on the calendar`);
  if (brief.counts.socialPending) bits.push(`${brief.counts.socialPending} posts to review`);
  if (brief.counts.tasks) bits.push(`${brief.counts.tasks} open tasks`);
  return bits.slice(0, 3).join(" · ") || "Open your brief.";
}

function money(amount?: number, currency = "USD"): string {
  if (amount == null) return "";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render the brief as a standalone HTML email. */
export function renderBriefEmail(brief: Brief): string {
  const s = brief.sections;
  const section = (title: string, inner: string) =>
    inner
      ? `<h2 style="font:600 15px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;color:#07183f;margin:24px 0 8px;border-bottom:1px solid #e5e9f2;padding-bottom:4px">${esc(title)}</h2>${inner}`
      : "";

  const li = (html: string) =>
    `<div style="font:400 14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c2a44;padding:6px 0;border-bottom:1px solid #f0f2f7">${html}</div>`;

  const actions = s.actions.map((a) =>
    li(`<a href="${esc(a.url)}" style="color:#0b5cab;text-decoration:none;font-weight:600">${esc(a.subject)}</a>
        <span style="color:#6b7794"> — ${esc(a.sender)}</span>
        <span style="display:inline-block;font:600 10px/1 sans-serif;color:#fff;background:${a.priority === "high" ? "#d0414b" : "#c2872f"};border-radius:3px;padding:2px 5px;margin-left:6px">${esc(a.label)}</span>`)
  ).join("");

  const cal = s.calendar.map((e) =>
    li(`<b>${esc(e.time)}</b> — ${esc(e.title)}${e.location ? ` <span style="color:#6b7794">@ ${esc(e.location)}</span>` : ""}${e.link ? ` <a href="${esc(e.link)}" style="color:#0b5cab">join</a>` : ""}`)
  ).join("");

  const tasks = s.tasks.map((t) =>
    li(`${t.status === "in_progress" ? "▶ " : "• "}${esc(t.title)}${t.due_date ? ` <span style="color:#6b7794">(due ${esc(t.due_date)})</span>` : ""}`)
  ).join("");

  const social = s.social.pending
    ? li(`<b>${s.social.pending}</b> social post${s.social.pending === 1 ? "" : "s"} awaiting your review` +
        (s.social.items.length ? `<div style="color:#6b7794;margin-top:4px">${s.social.items.map((i) => esc(i.title)).join(" · ")}</div>` : "") +
        `<div style="margin-top:6px"><a href="${SITE}${esc(s.social.reviewPath)}" style="color:#0b5cab">Review &amp; approve →</a></div>`)
    : "";

  const arrow = (t: string) => (t === "up" ? "▲" : t === "down" ? "▼" : "▬");
  const billsHtml = s.bills.length
    ? s.bills.map((b) => li(`${esc(b.vendor)}${b.due_date ? ` <span style="color:#6b7794">— due ${esc(b.due_date)}</span>` : ""}`)).join("")
    : "";

  const p = s.pulse || {};
  const pulseRows: string[] = [];
  if (p.youtube) pulseRows.push(li(`<b>YouTube ${arrow(p.youtube.trend)} ${esc(p.youtube.trend)}</b> <span style="color:#6b7794">${esc(p.youtube.tip)}</span>`));
  if (p.facebook) pulseRows.push(li(`<b>Facebook ${arrow(p.facebook.trend)} ${esc(p.facebook.trend)}</b> <span style="color:#6b7794">${esc(p.facebook.tip)}</span>`));
  const pulseHtml = pulseRows.join("");

  const lead = brief.nothingToDo
    ? `<p style="font:400 15px/1.5 -apple-system,sans-serif;color:#1c2a44">Nothing needs you today — inbox, calendar, tasks and posts are all clear. ⚓</p>`
    : `<p style="font:400 14px/1.5 -apple-system,sans-serif;color:#6b7794">${esc(pushBody(brief))}</p>`;

  const offline = brief.opsReachable ? "" :
    `<p style="font:400 13px/1.4 sans-serif;color:#c2872f">⚠ Couldn't reach the ops-manager — calendar, mail, tasks and money may be incomplete.</p>`;

  return `<!doctype html><html><body style="margin:0;background:#f4f6fb;padding:24px">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e9f2">
    <div style="background:#07183f;padding:20px 24px">
      <div style="font:700 18px/1.2 -apple-system,sans-serif;color:#fff">📋 Daily Brief</div>
      <div style="font:400 13px/1.2 -apple-system,sans-serif;color:#9fb0d4;margin-top:4px">${esc(brief.date)}</div>
    </div>
    <div style="padding:8px 24px 28px">
      ${lead}
      ${offline}
      ${section("Waiting on you", actions)}
      ${section("Social posts", social)}
      ${section("Today's calendar", cal)}
      ${section("Open tasks", tasks)}
      ${section("Bills due", billsHtml)}
      ${section("Reach", pulseHtml)}
      <p style="font:400 12px/1.4 sans-serif;color:#9aa6bd;margin-top:28px">Sent by your Still Afloat ops-manager — on your own server.</p>
    </div>
  </div></body></html>`;
}

async function emailBrief(_brief: Brief): Promise<boolean> {
  // The daily brief is delivered by Web Push + the phone shortcut only
  // (Mark, 2026-07-01) — no email copy. Intentional no-op.
  return false;
}

export interface ConflictItem {
  key: string; new_title: string; new_start: string;
  existing_title: string; existing_start: string; sender: string; subject: string;
}

/** Pending calendar conflicts from the ops-manager (for the standalone page). */
export async function fetchConflicts(): Promise<ConflictItem[]> {
  const key = process.env["IDEAS_API_KEY"];
  if (!key) return [];
  try {
    const r = await fetch(`${OPS_BASE}/brief/conflicts`, {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return [];
    return ((await r.json()).conflicts ?? []) as ConflictItem[];
  } catch {
    return [];
  }
}

/** The standalone Brief page — the home-screen icon + push target. Served from
 *  the dashboard subdomain so it sits behind the SAME nginx basic-auth as the
 *  dashboard (no PII/token on the public domain). */
export function briefViewUrl(): string {
  return process.env["DASHBOARD_BRIEF_URL"] || "https://dashboard.stillafloatcruising.com/brief.html";
}

/**
 * Render the brief as a self-contained, phone-first page — NO dashboard, no nav.
 * This is the home-screen "Brief" app: open the icon, see only today's briefing.
 * Token is embedded so action buttons work and there's no login.
 */
export function renderBriefPage(brief: Brief, conflicts: ConflictItem[], token: string): string {
  const s = brief.sections;
  const t = encodeURIComponent(token);

  const card = (inner: string) => `<section class="card">${inner}</section>`;
  const h = (title: string, n?: number) =>
    `<div class="h"><span>${esc(title)}</span>${n ? `<span class="count">${n}</span>` : ""}</div>`;

  const conflictsHtml = conflicts.length
    ? card(h("Calendar conflicts — your call", conflicts.length) +
        conflicts.map((c) => `
          <div class="conflict">
            <div class="ctitle"><b>${esc(c.new_title)}</b> clashes with <b>${esc(c.existing_title)}</b></div>
            ${c.subject ? `<div class="sub">${esc(c.subject)}</div>` : ""}
            <div class="btns">
              <button class="b1" onclick="resolve('${esc(c.key)}','1',this)">Keep new</button>
              <button onclick="resolve('${esc(c.key)}','2',this)">Keep existing</button>
              <button onclick="resolve('${esc(c.key)}','3',this)">Keep both</button>
            </div>
          </div>`).join(""))
    : "";

  const actionsHtml = s.actions.length
    ? card(h("Waiting on you", s.actions.length) +
        s.actions.map((a) => `
          <a class="row" href="${esc(a.url)}" target="_blank" rel="noopener">
            <div><span class="tag ${a.priority === "high" ? "hi" : "med"}">${esc(a.label)}</span>${a.unread ? '<span class="tag unread">unread</span>' : ""} <b>${esc(a.subject)}</b></div>
            <div class="sub">${esc(a.sender)}${a.snippet ? " — " + esc(a.snippet) : ""}</div>
          </a>`).join(""))
    : "";

  const socialHtml = s.social.pending
    ? card(h("Social posts to review", s.social.pending) +
        `<div class="sub">${s.social.items.map((i) => esc(i.title)).join(" · ")}</div>
         <a class="btn-link" href="${SITE}${esc(s.social.reviewPath)}?token=${t}" target="_blank" rel="noopener">Review &amp; approve →</a>`)
    : "";

  const calHtml = s.calendar.length
    ? card(h("Today's calendar", s.calendar.length) +
        s.calendar.map((e) => `<div class="row"><b>${esc(e.time)}</b> — ${esc(e.title)}${e.location ? ` <span class="sub">@ ${esc(e.location)}</span>` : ""}${e.link ? ` <a href="${esc(e.link)}" target="_blank" rel="noopener">join</a>` : ""}</div>`).join(""))
    : "";

  const tasksHtml = s.tasks.length
    ? card(h("Open tasks", s.tasks.length) +
        s.tasks.map((tk) => `<div class="row">${tk.status === "in_progress" ? "▶ " : "• "}${esc(tk.title)}${tk.due_date ? ` <span class="sub">(due ${esc(tk.due_date)})</span>` : ""}</div>`).join(""))
    : "";

  const ideasHtml = s.ideas.count
    ? card(h("New phone notes", s.ideas.count) +
        s.ideas.items.map((i) => `<div class="row">“${esc(i.note)}”</div>`).join(""))
    : "";

  const m = s.money;
  const moneyHtml = m
    ? card(h("Money") +
        `<div class="row">This month: <b class="${m.month_net >= 0 ? "pos" : "neg"}">${money(m.month_net)}</b> net <span class="sub">(in ${money(m.month_income)} / out ${money(m.month_expense)})</span></div>` +
        (m.upcoming_charges?.length ? `<div class="row sub">Upcoming: ${m.upcoming_charges.map((c) => `${esc(c.vendor)} ${money(c.amount, c.currency || "USD")} (${esc(c.next_charge_date)})`).join(" · ")}</div>` : "") +
        (m.recent_receipts?.length ? `<div class="row sub">Recent: ${m.recent_receipts.slice(0, 3).map((r) => `${esc(r.vendor)} ${money(r.amount, r.currency || "USD")}`).join(" · ")}</div>` : ""))
    : "";

  const nothing = brief.nothingToDo && conflicts.length === 0;
  const lead = nothing
    ? `<div class="clear">✓ Nothing needs you today. Inbox, calendar, tasks and posts are all clear. ⚓</div>`
    : `<div class="lead">${esc(pushBody(brief))}</div>`;

  const offline = brief.opsReachable ? "" :
    `<div class="warn">⚠ Couldn't reach the ops-manager — some sections may be incomplete.</div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Brief">
<meta name="theme-color" content="#07183f">
<title>Daily Brief</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0a1430;color:#e9eefb;font:400 16px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased;padding:max(env(safe-area-inset-top),16px) 16px calc(env(safe-area-inset-bottom) + 40px)}
  .top{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px}
  h1{font-size:30px;font-weight:800;margin:0}
  .date{color:#9fb0d4;margin:2px 0 16px}
  .refresh{background:none;border:1px solid #2a3a63;color:#cdd8f5;border-radius:10px;padding:8px 14px;font-size:14px}
  .lead{color:#9fb0d4;margin:0 0 16px}
  .clear{background:rgba(45,212,150,.10);border:1px solid rgba(45,212,150,.35);color:#bff5dd;border-radius:14px;padding:18px;margin-bottom:16px;font-size:17px}
  .warn{background:rgba(230,170,60,.10);border:1px solid rgba(230,170,60,.4);color:#f3d9a6;border-radius:12px;padding:12px;margin-bottom:16px;font-size:14px}
  .card{background:#10204a;border:1px solid #1e2f57;border-radius:16px;padding:16px;margin-bottom:14px}
  .h{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;color:#cdd8f5;margin-bottom:10px;text-transform:uppercase;letter-spacing:.04em}
  .count{font:600 12px/1 monospace;background:#23386a;color:#cdd8f5;border-radius:6px;padding:3px 7px}
  .row{padding:8px 0;border-top:1px solid #1a2a4f}
  .row:first-of-type{border-top:none}
  .sub{color:#8fa0c6;font-size:14px}
  a{color:#7fb4ff;text-decoration:none}
  a.row{display:block;color:inherit}
  .tag{display:inline-block;font:600 10px/1 monospace;border-radius:5px;padding:3px 6px;margin-right:6px;vertical-align:middle}
  .tag.hi{background:rgba(220,70,80,.2);color:#ff9aa3}
  .tag.med{background:rgba(230,170,60,.2);color:#f3d9a6}
  .tag.unread{background:rgba(90,140,255,.2);color:#aecbff}
  .pos{color:#5ad6a0}.neg{color:#ff8b93}
  .conflict{border-top:1px solid #1a2a4f;padding:12px 0}
  .conflict:first-of-type{border-top:none}
  .ctitle{margin-bottom:6px}
  .btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .btns button{flex:1;min-width:46%;background:#1b2c54;border:1px solid #2a3a63;color:#e9eefb;border-radius:10px;padding:11px 10px;font-size:14px;font-weight:600}
  .btns button.b1{background:#2f6df0;border-color:#2f6df0;color:#fff;min-width:100%}
  .btns button:disabled{opacity:.5}
  .btn-link{display:inline-block;margin-top:10px;background:#2f6df0;color:#fff;border-radius:10px;padding:10px 16px;font-weight:600;font-size:14px}
</style></head><body>
  <div class="top"><h1>Today</h1><button class="refresh" onclick="location.href='/api/brief/view?token=${t}&fresh=1'">↻ Refresh</button></div>
  <div class="date">${esc(brief.date)}</div>
  ${lead}
  ${offline}
  ${conflictsHtml}
  ${actionsHtml}
  ${socialHtml}
  ${calHtml}
  ${tasksHtml}
  ${ideasHtml}
  ${moneyHtml}
  <script>
    var TOKEN=${JSON.stringify(token)};
    function resolve(key,choice,btn){
      var btns=btn.parentNode.querySelectorAll('button');
      btns.forEach(function(b){b.disabled=true});
      btn.textContent='…';
      fetch('/api/ops/resolve-conflict?token='+encodeURIComponent(TOKEN),{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key:key,choice:choice})
      }).then(function(r){return r.json()}).then(function(j){
        if(j&&j.ok){location.href='/api/brief/view?token='+encodeURIComponent(TOKEN)+'&fresh=1';}
        else{alert((j&&j.error)||'Failed');btns.forEach(function(b){b.disabled=false});}
      }).catch(function(e){alert(String(e));btns.forEach(function(b){b.disabled=false});});
    }
  </script>
</body></html>`;
}

/** Assemble, then deliver via Web Push + email. Returns what happened. */
export async function runAndDeliverBrief(): Promise<{
  brief: Brief; push: { sent: number; pruned: number }; emailed: boolean;
}> {
  const brief = await assembleBrief();
  const push = await sendPush({
    title: brief.nothingToDo ? "📋 Daily Brief — all clear" : "📋 Your daily brief",
    body: pushBody(brief),
    url: briefViewUrl(),
    tag: "daily-brief",
  });
  const emailed = await emailBrief(brief);
  logger.info({ counts: brief.counts, push, emailed }, "Daily brief delivered");
  return { brief, push, emailed };
}
