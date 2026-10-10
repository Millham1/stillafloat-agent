// e2e/checks/jobs.mjs — the scheduled jobs and background services are really doing their work.
//
// Why this file exists: a job that stops fails SILENTLY. Nothing errors, nothing 500s — the
// thing it maintains just goes stale, and every feature test still passes because the data
// it reads is still there.
//   2026-08-26  Web Push had ZERO devices for five days; the push-health job logged it every
//               six hours and raised one action, which nobody saw.
//   2026-08-30  after the archive wipe ~100 prerendered story pages kept serving with no story
//               behind them, and nothing noticed for days.
//   2026-09-06  Instagram items sat "scheduled" forever — the calendar promised posts that the
//               social poster could never send.
//   2026-08-27  a stored guide was a 404 for most of an hour with nothing saying which state
//               the site was in.
//   2026-10-04  Mark's standing order: the whole system is tested end to end on every release.
//
// So each check below reads what a job PRODUCES and asserts it was produced recently, against
// the job's own cadence (limit = cadence + start-up delay + slack, stated per check), and
// cross-checks it against a second view of the same data where one exists.
//
// DEV vs PROD. The dev box deliberately switches some jobs off so it never posts, emails or
// nudges twice (shared.env on 178.156.154.144, 2026-10-08): DISABLE_DAILY_BRIEF,
// DISABLE_SOCIAL_POSTER, DISABLE_WEEKLY_MARKETING, DISABLE_WMS_ALERTS, DISABLE_YOUTUBE_SCAN.
// A check for one of those reports UNTESTABLE on dev when the output is stale (never a pass):
// the candidate cannot show that job works before it reaches prod. That is a true statement
// about the release, and it fails the run until dev can exercise the job (e.g. a dry-run mode).
//
// SAFETY. Every request here is a GET whose handler only reads (checked 2026-10-08):
//   /api/social/schedule, /api/newsletter/draft, /api/commentary/draft, /api/subscribers,
//   /api/storm-alerts, /api/storm-watch, /api/ai-visibility, /api/guides/status, /api/news-feed,
//   the news agent's /api/health and /api/editorial-queue, the ops-manager's /health, and static
//   files. Nothing here triggers a scan, a send, a post or a paid call. GET /api/brief is NOT
//   used: when no brief is stored it assembles and stores one (see the gap for the daily brief).
//   No personal data is recorded: subscriber rows and newsletter recipients are only counted.
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SITE = "https://stillafloatcruising.com";

const DEV_OFF = {
  weekly: "the weekly marketing job is switched off on the dev box (DISABLE_WEEKLY_MARKETING=1), so the release candidate cannot show it still writes the newsletter and commentary drafts",
  poster: "the social poster is switched off on the dev box (DISABLE_SOCIAL_POSTER=1) and dev has no scheduled posts, so the release candidate cannot show the poster still handles due posts",
};

/** Age in hours of an ISO time or ms; NaN when unreadable. */
const ageH = (t, when) => {
  const ms = typeof when === "number" ? when : Date.parse(String(when ?? ""));
  return Number.isFinite(ms) ? (t.now() - ms) / HOUR : NaN;
};

/** The Last-Modified time nginx reports for a file the job writes in place. */
function lastModified(t, res, what) {
  const lm = res.headers.get("last-modified");
  t.ok(lm && Number.isFinite(Date.parse(lm)), `${what} carries no Last-Modified date, so the job that writes it cannot be seen running (${res.describe()})`);
  return Date.parse(lm);
}

const maxTime = (xs) => xs.reduce((m, x) => Math.max(m, x), -Infinity);

/** The prerender's story slug (server/src/lib/prerender-news.ts storySlug + djb2). A pure function
 *  of the story id, so the feed can be matched to the pages the job wrote. Change them together. */
function storySlug(story) {
  const raw = String(story.id || "story");
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  const hash = h.toString(16).padStart(8, "0").slice(-6);
  const base = raw.toLowerCase().replace(/-https?-.*$/, "").replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 70).replace(/-+$/, "");
  return `${base || "story"}-${hash}`;
}

/** The prerender's escapeHtml, so a title can be found in the page it wrote. */
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The most recent weekly slot (weekday + hour, New York time — TIMEZONE and WEEKLY_MARKETING_HOUR
 * are unset on both boxes, so the job's defaults apply) that is at least `settleMin` minutes in the
 * past. The job polls every 5 minutes; the settle covers the poll and the writing itself.
 */
function lastWeeklySlot(nowMs, weekday, hour, settleMin = 30) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit" });
  const top = Math.floor(nowMs / HOUR) * HOUR;
  for (let ms = top; ms > nowMs - 9 * DAY; ms -= HOUR) {
    if (ms + settleMin * 60_000 > nowMs) continue;
    const parts = fmt.formatToParts(new Date(ms));
    const get = (k) => parts.find((p) => p.type === k)?.value ?? "";
    if (get("weekday") === weekday && Number(get("hour")) % 24 === hour) return ms;
  }
  return NaN;
}

export default [
  // ───────────────────────────────────────────────────────────────────────────────────────────
  // scheduleNewsPrerender: on boot (+40 s) and hourly, rewrites /news.html, /es/news.html,
  // /news-sitemap.xml (and every story/hub page) in place from story-details. Limit 2.5 hours =
  // two ticks + 30 minutes. A deploy restart resets the clock (+40 s), never more than that.
  {
    id: "jobs.news-prerender-ran-this-hour",
    basis: "ruling: stillafloat-news-prerender.md — the hourly prerender writes a crawlable page for every live story and the EN and ES listings and news sitemap; a card is a teaser, the gist lives on the story page (scheduleNewsPrerender, server/src/index.ts)",
    title: "The hourly news job rebuilt the English and Spanish news listings, the newest story's pages and the news sitemap in one run within the last two and a half hours: every live story has its card, Spanish titles on the Spanish listing",
    covers: ["job scheduleNewsPrerender", "ext:page /news.html", "ext:page /es/news.html", "ext:file /news-sitemap.xml", "GET /api/news-feed"],
    modes: ["dev", "prod"],
    incident: "risk: the hourly prerender stops and new stories never get a crawlable page while the API still looks fine",
    run: async (t) => {
      const feed = t.success(await t.get("/api/news-feed"));
      t.nonEmpty(feed.stories, "the live news feed the prerender renders from");
      const times = [];
      const pages = [];
      for (const [p, lang] of [["/news.html", "en"], ["/es/news.html", "es"]]) {
        const res = await t.get(p);
        const html = t.html(res);
        pages.push(html);
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        const dir = lang === "es" ? "/es/news/" : "/news/";
        const storyLinks = new Set(H.links(html).map((h) => { try { return new URL(h, `${SITE}/`).pathname; } catch { return ""; } })
          .filter((x) => x.startsWith(dir) && x.endsWith(".html")));
        t.atLeast(storyLinks.size, Math.min(5, feed.stories.length), `story links on ${p}`);
        const lm = lastModified(t, res, p);
        t.fresh(lm, 2.5, `${p} (rewritten by the hourly news prerender)`);
        times.push(lm);
        t.observe(`${p} story links`, storyLinks.size, "info");
      }
      const sm = await t.get("/news-sitemap.xml");
      t.status(sm, 200);
      t.ok(/<urlset[\s>]/.test(sm.text), "/news-sitemap.xml is not a sitemap");
      const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      t.atLeast(locs.length, 3, "URLs in the news sitemap");
      const lm = lastModified(t, sm, "/news-sitemap.xml");
      t.fresh(lm, 2.5, "/news-sitemap.xml (rewritten by the hourly news prerender)");
      times.push(lm);

      // WHAT the job wrote, not only WHEN (adversarial review 2026-10-08). The prerender reads
      // story-details; the feed reads the news index. If the job ran but read stale or empty
      // data, the files are fresh and still wrong. Every live story must have its card on both
      // listings (prod 2026-10-08: 176 of 176), the newest Spanish titles must be on the Spanish
      // listing and not the English ones, and most live stories must be in the sitemap (low-impact
      // and thin stories are noindex and left out on purpose — prod: 161 of 176).
      const [enHtml, esHtml] = pages;
      const slugs = feed.stories.map(storySlug);
      const offEn = slugs.filter((s) => !enHtml.includes(`/news/${s}.html`));
      const offEs = slugs.filter((s) => !esHtml.includes(`/es/news/${s}.html`));
      t.ok(offEn.length === 0, `${offEn.length} of ${slugs.length} live stories have no card on /news.html (e.g. ${offEn[0]}) — the hourly prerender is building the listing from stale data`);
      t.ok(offEs.length === 0, `${offEs.length} of ${slugs.length} live stories have no card on /es/news.html (e.g. ${offEs[0]})`);
      const inSitemap = slugs.filter((s) => sm.text.includes(`/news/${s}.html</loc>`)).length;
      // Which stories the sitemap must carry: not low-impact, and above the depth floor
      // (prerender-news.ts isNoindex: travelerImpact >= 35 words, editorialReasoning >= 70). An SEO
      // override can pin a page noindex, so up to two may be missing (prod 2026-10-08: 157
      // indexable, 0 missing; dev: 3 live stories, all thin, so none required).
      const words = (x) => String(x || "").trim().split(/\s+/).filter(Boolean).length;
      const indexable = feed.stories.filter((x) => String(x.impactLevel || "").trim().toLowerCase() !== "low"
        && words(x.travelerImpact) >= 35 && words(x.editorialReasoning) >= 70);
      const notInSitemap = indexable.filter((x) => !sm.text.includes(`/news/${storySlug(x)}.html</loc>`));
      t.ok(notInSitemap.length <= 2, `${notInSitemap.length} of ${indexable.length} indexable live stories are missing from /news-sitemap.xml (e.g. ${notInSitemap[0]?.id})`);
      const newest = [...feed.stories].sort((a, b) => String(b.approvedAt || "").localeCompare(String(a.approvedAt || "")));
      const bilingual = newest.filter((s) => s.title_es && s.title && s.title_es.trim() !== s.title.trim()).slice(0, 5);
      t.atLeast(bilingual.length, 1, "recent live stories with a Spanish title");
      for (const s of bilingual) {
        t.ok(enHtml.includes(esc(s.title)), `/news.html does not show the English title of story ${s.id}`);
        t.ok(esHtml.includes(esc(s.title_es)), `/es/news.html does not show the Spanish title of story ${s.id} — the Spanish listing is not being built from the Spanish text`);
        t.ok(!esHtml.includes(esc(s.title)), `/es/news.html shows the ENGLISH title of story ${s.id}`);
      }
      // The newest story's own pages (EN + ES) are rewritten by the same run.
      const top = newest[0];
      for (const [p, lang, title] of [[`/news/${storySlug(top)}.html`, "en", top.title], [`/es/news/${storySlug(top)}.html`, "es", top.title_es || top.title]]) {
        const res = await t.get(p);
        const html = t.html(res);
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        t.ok(H.h1s(html).some((h) => h.length > 10), `${p} has no headline`);
        t.ok(html.includes(esc(title)), `${p} (the newest story) does not carry its ${lang === "es" ? "Spanish" : "English"} title`);
        const plm = lastModified(t, res, p);
        t.fresh(plm, 2.5, `${p} (the newest story's page, rewritten by the hourly news prerender)`);
        times.push(plm);
      }
      // one run writes all of these within seconds; a spread means one of them stopped being written
      const spreadMin = (maxTime(times) - Math.min(...times)) / 60_000;
      t.ok(spreadMin <= 10, `the news listings, the newest story's pages and the sitemap were last written ${spreadMin.toFixed(0)} minutes apart — one of them is no longer written by the hourly job`);
      t.observe("news sitemap URLs", locs.length, "min");
      t.observe("live stories in the sitemap", inSitemap, "info");
      t.observe("indexable live stories", indexable.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // scheduleGuidesPrerender: on boot (+50 s) and hourly renders the guide pages, then rewrites
  // /llms.txt (also once immediately on boot). The guides sitemap's freshness is checked by
  // cabins.guides-site-matches-data; this check reads the other file the same tick writes and
  // cross-checks it against the guide data and against the news job's hub pages.
  {
    id: "jobs.guides-tick-rewrote-llms-txt",
    basis: "ruling: stillafloat-cruising-guides.md — the hourly guides job renders every published guide in each language and rewrites the guide indexes and /llms.txt together (8/27 incident: a stored guide was a 404 for an hour)",
    title: "The hourly guides job rebuilt the guide indexes, the guide pages and the AI-assistant index (/llms.txt) together: it lists exactly the published guides in English and Spanish, the indexes link them all, and its links open freshly built pages",
    covers: ["job scheduleGuidesPrerender", "GET /api/guides/status", "ext:file /llms.txt"],
    modes: ["dev", "prod"],
    incident: "2026-08-27: a stored guide was a 404 for most of an hour with nothing saying so; llms.txt is how assistants find the guides",
    run: async (t) => {
      const st = t.success(await t.get("/api/guides/status"), "ok");
      t.fields(st, ["expected.en", "expected.es"], "the guides status");
      t.atLeast(st.expected.en, 1, "published English guides in the data");
      const res = await t.get("/llms.txt");
      t.status(res, 200);
      t.ok(/^# Still Afloat Cruising/.test(res.text), `/llms.txt is not the site's AI index (${res.text.length} bytes)`);
      t.fresh(lastModified(t, res, "/llms.txt"), 2.5, "/llms.txt (rewritten after every hourly guides tick)");
      const urls = [...res.text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
      const path = (u) => { try { return new URL(u).pathname; } catch { return ""; } };
      const en = urls.filter((u) => /^\/guides\/[a-z0-9-]+\.html$/.test(path(u)));
      const es = urls.filter((u) => /^\/es\/guides\/[a-z0-9-]+\.html$/.test(path(u)));
      t.equal(en.length, st.expected.en, "English guides listed in /llms.txt vs published English guides in the data");
      t.equal(es.length, st.expected.es, "Spanish guides listed in /llms.txt vs published Spanish guides in the data");
      // llms.txt is written AFTER the guides prerender and even when the prerender throws, so a
      // fresh llms.txt alone does not prove the guide pages were rebuilt (adversarial review
      // 2026-10-08). The same tick rewrites /guides.html and /es/guides.html: they must be as
      // fresh as llms.txt and link every guide llms.txt lists (two views of one publish).
      const llmsAt = Date.parse(res.headers.get("last-modified"));
      for (const [p, listed] of [["/guides.html", en], ["/es/guides.html", es]]) {
        const ir = await t.get(p);
        const ih = t.html(ir);
        t.equal(H.htmlLang(ih).slice(0, 2), p.startsWith("/es/") ? "es" : "en", `${p} language`);
        const ilm = lastModified(t, ir, p);
        t.fresh(ilm, 2.5, `${p} (rewritten by the hourly guides prerender)`);
        t.ok(Math.abs(llmsAt - ilm) <= 15 * 60_000, `${p} was last written ${(Math.abs(llmsAt - ilm) / 60_000).toFixed(0)} minutes apart from /llms.txt — the guides prerender is failing while llms.txt is still rewritten`);
        const linked = new Set(H.links(ih).map((h) => { try { return new URL(h, `${SITE}${p}`).pathname; } catch { return ""; } }));
        const missing = listed.filter((u) => !linked.has(path(u)));
        t.ok(missing.length === 0, `${p} does not link ${missing.length} guide(s) that /llms.txt lists (e.g. ${missing[0] ? path(missing[0]) : ""})`);
      }
      // a sample of what it links to must open on this box: first English guide, last Spanish
      // guide, and (when the news job has written any) the first English and Spanish news hubs
      const hubs = urls.filter((u) => /^\/(es\/)?news\/[a-z0-9-]+\.html$/.test(path(u)));
      const sample = [en[0], es[es.length - 1], hubs.find((u) => !path(u).startsWith("/es/")), hubs.find((u) => path(u).startsWith("/es/"))].filter(Boolean);
      for (const u of sample) {
        const gr = await t.get(H.onBase(u, t.bases.site));
        const html = t.html(gr);
        t.equal(H.htmlLang(html).slice(0, 2), path(u).startsWith("/es/") ? "es" : "en", `${path(u)} language`);
        t.nonEmpty(H.h1s(html), `${path(u)} heading`);
        // guide pages and news hubs are rewritten every hour by their jobs, like the indexes
        t.fresh(lastModified(t, gr, path(u)), 2.5, `${path(u)} (rewritten by its hourly prerender)`);
      }
      t.observe("llms.txt guides (en)", en.length, "min");
      t.observe("llms.txt guides (es)", es.length, "min");
      t.observe("llms.txt news hubs", hubs.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // scheduleStormScan: on boot (+30 s) and hourly pulls NHC and touches `last_updated` (and the
  // raw advisory) of every system NHC still lists; the lifecycle pass marks dissipated ones
  // "ended". So while any named NHC storm is live in the alert list, the newest refresh must be
  // under 2.5 hours old (two ticks + 30 minutes). Runs on BOTH boxes (dev does not switch it off).
  {
    id: "jobs.storm-scan-refreshes-live-storms",
    basis: "ruling: stillafloat-storm-alerts.md — the hourly NHC scan refreshes every live system with the newest advisory, or ends it once the Center drops it (lifecycle v3); a stopped scan freezes the public storm text",
    title: "Whenever a storm is live, the hourly storm scan is refreshing it with the Hurricane Center's latest advisory (or ending it once the Center drops it): the dashboard and the public Storm Watch show data under two and a half hours old",
    covers: ["job scheduleStormScan", "GET /api/storm-alerts", "GET /api/storm-watch"],
    modes: ["dev", "prod"],
    incident: "2026-09-26: the public storm list broke while a storm was live, and Odalys and Nolo kept stale tracks because the scan touched only the time; a stopped scan would leave the public text frozen the same way",
    run: async (t) => {
      const dash = t.success(await t.get("/api/storm-alerts", { auth: true }));
      t.ok(Array.isArray(dash.alerts), "the dashboard's alert list is missing");
      t.nonEmpty(dash.alerts, "the dashboard's storm alert list");
      const NHC = /^(al|ep|cp)\d{6}$/i;
      // Every feed-backed row (named NHC storms, outlook areas, NWS marine storms) is either
      // seen by each hourly scan (last_updated touched) or counted missing and ended after
      // MISSING_SCANS_TO_END = 3 scans (storm-lifecycle.ts). Hand-declared (MANUAL-) and demo rows
      // are judged by their window, not a feed, and are left out.
      const FEED = /^((al|ep|cp)\d{6}|TWO-[a-z_]+|NWS-.+)$/i;
      const LIVE = new Set(["draft", "approved", "sending", "sent"]);
      const fed = dash.alerts.filter((a) => FEED.test(a.nhc_id || "") && LIVE.has(a.status));
      const live = fed.filter((a) => NHC.test(a.nhc_id || ""));
      // Whether a named storm is live is the weather, not the site (Mark 2026-10-09), so off-season is not a
      // failure: with none live there is nothing the scan must be refreshing, the other feed-backed rows
      // are still judged below, and the scan's own ticking is held by vitals.jobs-ran-on-time.
      for (const a of live) t.fields(a, ["id", "name", "status", "last_updated", "raw.lastUpdate"], `live storm "${a.name}"`);
      if (live.length) {
        const newest = maxTime(live.map((a) => Date.parse(a.last_updated)));
        t.fresh(newest, 2.5, "the newest refresh of a live storm by the hourly storm scan");
      }
      // EVERY live row, not just the newest (adversarial review 2026-10-08: one basin's feed can
      // stop while another refreshes). Fresh within 2.5 hours, or on its way to being ended:
      // counted missing by the lifecycle pass (1-2 scans) and refreshed within 4.5 hours.
      for (const a of fed) {
        const h = ageH(t, a.last_updated);
        const ending = Number(a.missing_scans) >= 1 && Number(a.missing_scans) < 3;
        t.ok(h <= 2.5 || (ending && h <= 4.5),
          `the ${a.status} storm alert "${a.name}" (${a.nhc_id}) was last refreshed ${h.toFixed(1)} hours ago and is neither being refreshed nor being ended by the hourly scan (missing scans: ${a.missing_scans ?? "?"})${a.status === "approved" || a.status === "sent" ? " — visitors see frozen storm text" : ""}`);
      }
      // The scan must carry the Hurricane Center's NEWEST advisory, not only touch the time.
      // Before c2c0195 (2026-09-26, in the release candidate, NOT on prod as of 2026-10-08) an
      // unchanged storm got last_updated and nothing else, so its stored advisory, position and
      // forecast track froze while the page said "updated minutes ago". NHC advises every 6 hours
      // (3-hourly intermediates near land); a storm the last scan saw must hold an advisory under
      // 12 hours old. THIS FAILS ON PROD UNTIL THE PROMOTION (prod 2026-10-08: Rachel's stored
      // advisory was 29 hours old; dev's copy of the same storm was 5 hours old).
      for (const a of live.filter((x) => Number(x.missing_scans || 0) === 0)) {
        const adv = ageH(t, a.raw?.lastUpdate);
        t.ok(adv <= 12, `the storm "${a.name}" (${a.nhc_id}) carries a Hurricane Center advisory ${Number.isFinite(adv) ? `${adv.toFixed(1)} hours` : "of unknown age"} old although the hourly scan saw it ${ageH(t, a.last_updated).toFixed(1)} hours ago — the scan touches the time but does not store the new advisory`);
      }
      const publicLive = fed.filter((a) => a.status === "approved" || a.status === "sent");
      // Second view of the same rows: what visitors read carries the same refresh time.
      const pub = t.success(await t.get("/api/storm-watch"));
      t.ok(Array.isArray(pub.systems), "the public list has no systems array");
      const byId = new Map(fed.map((a) => [a.id, a]));
      let seen = 0;
      for (const s of pub.systems) {
        const a = byId.get(s.id);
        if (!a) continue;
        seen++;
        t.ok(Date.parse(s.updated) >= Date.parse(a.last_updated) - 1000,
          `the public Storm Watch shows "${s.name}" as updated ${s.updated}, older than the dashboard's ${a.last_updated}`);
      }
      t.equal(seen, publicLive.filter((a) => a.is_threat === true).length, "public live storms on the Storm Watch list vs approved threats in the dashboard");
      t.observe("live NHC storms", live.length, "info");
      t.observe("live feed-backed alerts", fed.length, "info");
      if (live[0]) t.observe("alert keys", keysOf(live[0]), "exact");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // scheduleSocialPoster: every 10 minutes (+20 s on boot) resolves every scheduled post whose
  // slot has passed — posted, failed, or skipped (language off / manual-only) — except "retry"
  // reasons (platform not configured, no Instagram clip), which stay scheduled for up to 7 days
  // and are then skipped as stale. Observable consequence of a running poster:
  //   • nothing due more than 7 days + 30 minutes ago is still unresolved;
  //   • the newest due slot that was resolved is within 24 hours of the newest due slot (slots
  //     are three a day; one retry slot cannot open a 24-hour hole, a stopped poster does).
  {
    id: "jobs.social-poster-handles-due-posts",
    basis: "master-ref: §6 PA SOCIAL POSTING PIPELINE — approved posts go out through the Make Facebook scenario at their scheduled slot; the poster ticks every 10 minutes and skips retry-forever items after seven days (scheduleSocialPoster, server/src/index.ts); 9/6 incident",
    title: "The social poster handles posts when their time comes: any that fell due this week were handled, Facebook posts went out within the hour, none failed, and nothing due is left waiting past its slot or the seven-day retry limit",
    covers: ["job scheduleSocialPoster", "GET /api/social/schedule"],
    modes: ["dev", "prod"],
    incident: "2026-09-06: Instagram items sat \"scheduled\" indefinitely and the calendar promised posts that never went out",
    run: async (t) => {
      const anon = await t.get("/api/social/schedule?format=json");
      t.equal(anon.status, 401, `the posting calendar must refuse a request with no token (${anon.describe()})`);
      const s = t.success(await t.get("/api/social/schedule?format=json", { auth: true }));
      t.ok(Array.isArray(s.items), "the posting calendar has no items array");
      t.equal(s.count, s.items.length, "posting calendar count");
      const now = t.now();
      const at = (i) => Date.parse(i.scheduledFor || "");
      const unresolved = (i) => !i.postedAt && (!i.postState || i.postState === "scheduled");
      const due = s.items.filter((i) => Number.isFinite(at(i)) && at(i) <= now - 20 * 60_000);
      const recent = due.filter((i) => at(i) >= now - 7 * DAY);
      // Whether a post fell due this week depends on whether Mark approved a batch (his cadence, not the
      // site's — 2026-10-09 grounding pass), so prod with nothing due is not a failure: the stale-post rule
      // below still holds and the timing rules apply to whatever did fall due. Dev, with the poster switched
      // off on purpose, cannot show the poster working (Mark's 2026-10-08 dev-mirror ruling: decide which
      // disabled jobs must run for parity).
      if (t.mode === "dev" && recent.length === 0) t.require(false, DEV_OFF.poster);
      for (const i of recent) t.fields(i, ["platform", "surface", "scheduledFor"], "a due social post");
      const overdue = due.filter((i) => unresolved(i) && at(i) < now - 7 * DAY - 30 * 60_000);
      t.ok(overdue.length === 0, `${overdue.length} social posts due more than 7 days ago are still waiting (oldest slot ${overdue.map((i) => i.scheduledFor).sort()[0]}) — the poster skips those as stale on its next run, so it has not run`);
      if (recent.length) {
        const newestDue = maxTime(recent.map(at));
        const newestResolved = maxTime(recent.filter((i) => !unresolved(i)).map(at));
        const holeH = (newestDue - newestResolved) / HOUR;
        t.ok(holeH <= 24, Number.isFinite(newestResolved)
          ? `no due social post has been handled since the ${new Date(newestResolved).toISOString()} slot, ${holeH.toFixed(0)} hours before the newest due slot — the 10-minute poster has stopped`
          : `none of the ${recent.length} social posts due in the last 7 days has been handled — the 10-minute poster has stopped`);
      }
      for (const i of recent.filter((x) => x.postedAt)) {
        t.ok(Date.parse(i.postedAt) >= at(i) - 60_000, `a ${i.platform} post went out before its slot (${i.scheduledFor} → ${i.postedAt})`);
      }
      // "Handled" must not mean "failed" (adversarial review 2026-10-08): a broken Make webhook
      // resolves every post as failed, which closes the hole above while nothing goes out. Skips
      // are by design (language off, manual-only, stale Instagram clip); a failure is a promised
      // post that never went out. Error text is not printed (it can carry a caption).
      const failed = recent.filter((i) => i.postState === "failed");
      t.ok(failed.length === 0, `${failed.length} social post(s) due in the last 7 days FAILED to post (${[...new Set(failed.map((i) => i.platform))].join(", ")}; newest slot ${failed.map((i) => i.scheduledFor).sort().pop()})`);
      // The poster ticks every 10 minutes and Facebook has no clip to wait for, so a Facebook post
      // goes out within minutes of its slot (prod: 0.1 to 8.7 minutes, Sept-Oct 2026). An hour
      // late means the poster is not ticking (or Facebook was unconfigured for that long).
      for (const i of recent.filter((x) => x.postedAt && x.platform === "facebook")) {
        const lateMin = (Date.parse(i.postedAt) - at(i)) / 60_000;
        t.ok(lateMin <= 60, `the Facebook post for the ${i.scheduledFor} slot went out ${lateMin.toFixed(0)} minutes late — the 10-minute poster is not keeping time`);
      }
      t.observe("posts sent in the last 7 days", recent.filter((x) => x.postedAt).length, "info");
      t.observe("posts due in the last 7 days", recent.length, "info");
      t.observe("calendar platforms", [...new Set(s.items.map((i) => i.platform))].sort().join(","), "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // scheduleWeeklyMarketing (polls every 5 minutes, acts at 09:00 New York time):
  //   Tuesday  — stages and writes the week's commentary (draft generatedAt)
  //   Thursday — writes the newsletter draft, English always, Spanish once a Spanish subscriber
  //              is confirmed (skipped while the last issue's delivery is still open)
  //   Friday   — auto-sends a draft that is still pending (NEWSLETTER_AUTOSEND unset on both
  //              boxes, 2026-10-08; set it to 0 and this check must change with it)
  //   daily    — the social scan (creates drafts only for new uploads: no timestamp to read)
  // Judged against the job's own SLOTS, not a rolling 7 days (adversarial review 2026-10-08): a
  // draft Mark re-rolled by hand on Saturday kept a 174-hour window open until the next Sunday,
  // so a Thursday run that failed passed for three days. Now each draft must be at least as new
  // as the last Tuesday/Thursday 09:00 slot (+30 minutes to settle). The Thursday job overwrites
  // whatever draft exists, so a hand-made draft from before the slot does not excuse it.
  {
    id: "jobs.weekly-marketing-drafts-current",
    basis: "ruling: stillafloat-newsletter.md — the newsletter is drafted Thursday 09:00 Eastern (English always, Spanish once a Spanish subscriber is confirmed) and the weekly commentary is staged Tuesday (scheduleWeeklyMarketing, server/src/index.ts)",
    title: "This week's newsletter draft (English, and Spanish once a Spanish subscriber exists) was written at Thursday's 9am run, this week's commentary at Tuesday's, and no draft is left unsent after Friday's auto-send",
    covers: ["job scheduleWeeklyMarketing", "GET /api/newsletter/draft", "GET /api/commentary/draft", "GET /api/subscribers"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const anon = await t.get("/api/commentary/draft");
      t.equal(anon.status, 401, `the commentary draft must refuse a request with no token (${anon.describe()})`);
      const now = t.now();
      const thu = lastWeeklySlot(now, "Thu", 9);
      const tue = lastWeeklySlot(now, "Tue", 9);
      const fri = lastWeeklySlot(now, "Fri", 9);
      t.ok(Number.isFinite(thu) && Number.isFinite(tue) && Number.isFinite(fri), "could not work out the job's weekly slots");
      const iso = (ms) => new Date(ms).toISOString();
      /** The draft is at least as new as the slot; on dev (job switched off) a miss is UNTESTABLE. */
      const sinceSlot = (when, slot, what) => {
        const ok = Date.parse(when || "") >= slot - 60_000;
        if (!ok && t.mode === "dev") t.require(false, `${what} was written ${when || "never"}, before the ${iso(slot)} run: ${DEV_OFF.weekly}`);
        t.ok(ok, `${what} was written ${when || "never"}, before the job's ${iso(slot)} run — that run did not write it`);
      };

      // Who the Thursday run had to write for (counted, never listed): confirmed Spanish readers
      // who were confirmed before the slot.
      let subs = [], total = 0;
      for (let page = 1; page <= 5; page++) {
        const cb = t.json(await t.get(`/api/subscribers?status=confirmed&limit=200&page=${page}`, { auth: true }));
        t.ok(Array.isArray(cb.subscribers) && typeof cb.total === "number", "the subscriber list did not answer as a list");
        subs = subs.concat(cb.subscribers);
        total = cb.total;
        if (subs.length >= total || cb.subscribers.length === 0) break;
      }
      // how many people are signed up is the audience, not the site; dev holds test addresses (Mark 2026-10-08)
      // and must carry at least one so the editions are exercised
      if (t.mode === "dev") t.require(total >= 1, "dev has no confirmed test subscriber (seed one), so the newsletter has nobody to be drafted for");
      const esAtSlot = subs.filter((x) => x.lang === "es" && Date.parse(x.confirmed_at || x.created_at || "") <= thu).length;

      const editions = [["en", "English"]].concat(esAtSlot > 0 ? [["es", "Spanish"]] : []);
      let enDraft = null;
      for (const [lang, name] of editions) {
        const b = t.success(await t.get(`/api/newsletter/draft?lang=${lang}`, { auth: true }));
        t.ok(b.draft && typeof b.draft === "object", lang === "es" ? `${esAtSlot} Spanish subscribers were confirmed by Thursday's run but there is no Spanish newsletter draft` : "there is no English newsletter draft at all");
        const d = b.draft;
        if (lang === "en") enDraft = d;
        t.fields(d, ["subject", "generatedAt", "status", "lang", "letter"], `the ${name} newsletter draft`);
        t.equal(d.lang, lang, `the ${name} newsletter draft's language`);
        t.ok(["pending", "sending", "sent"].includes(d.status), `the ${name} newsletter draft has an unknown status "${d.status}"`);
        // the Thursday run skips an edition whose last issue still owed someone a retry at 09:00
        const openAtSlot = Boolean(d.delivery && (!d.delivery.finishedAt || Date.parse(d.delivery.finishedAt) > thu));
        if (!openAtSlot) sinceSlot(d.generatedAt, thu, `the ${name} newsletter draft (written every Thursday 09:00 New York time)`);
        // Friday 09:00: a pending draft under 8 days old is sent as saved
        if (d.status === "pending") {
          const g = Date.parse(d.generatedAt);
          t.ok(!(fri > g && fri - g < 8 * DAY), `the ${name} newsletter draft written ${d.generatedAt} is still pending after the ${iso(fri)} Friday auto-send — the auto-send did not run`);
        }
      }

      const c = t.success(await t.get("/api/commentary/draft", { auth: true }));
      t.ok(c.draft && typeof c.draft === "object", "there is no commentary draft at all");
      t.fields(c.draft, ["generatedAt", "status"], "the commentary draft");
      t.ok(Array.isArray(c.draft.stories) && c.draft.stories.length >= 1, "the commentary draft has no subject story");
      t.ok(["awaiting_take", "drafted", "published", "discarded"].includes(c.draft.status), `the commentary draft has an unknown status "${c.draft.status}"`);
      sinceSlot(c.draft.generatedAt, tue, "this week's commentary draft (written every Tuesday 09:00 New York time)");
      t.observe("newsletter draft keys", keysOf(enDraft), "exact");
      t.observe("commentary draft status", c.draft.status, "info");
      t.observe("Spanish edition active", esAtSlot > 0, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // scheduleNewsletterDelivery: every 5 minutes (+90 s on boot) resumes a send a restart
  // interrupted and runs the single retry an hour after the first round. The delivery ledger is
  // saved after every email, so a running job means no ledger is ever left due and untouched:
  //   • queued recipients: the round must finish within queued × 45 s + 2 min settle + 10 min;
  //   • parked for the retry: retryAt may be at most 15 minutes past;
  //   • finished: every recipient is in a final state and the issue is marked sent.
  // Dev has never sent an issue, so there is nothing to judge there (UNTESTABLE).
  {
    id: "jobs.newsletter-delivery-never-stuck",
    basis: "ruling: stillafloat-transactional-email.md — the weekly send is paced one email every 45 seconds and resumed by the five-minute delivery job, so no ledger is left half-sent (9/18 incident: 11 emails in 18 seconds)",
    title: "No newsletter send is stuck half-way: every issue sent from this box finished at one email every 45 seconds (not all at once), or is still moving, and its retry ran on time",
    covers: ["job scheduleNewsletterDelivery", "GET /api/newsletter/draft"],
    modes: ["dev", "prod"],
    incident: "2026-09-18: the Friday auto-send pushed 11 emails in 18 seconds, the relay blocked the mailbox, and the send still logged 11/11",
    run: async (t) => {
      const deliveries = [];
      for (const lang of ["en", "es"]) {
        const b = t.success(await t.get(`/api/newsletter/draft?lang=${lang}`, { auth: true }));
        if (b.draft?.delivery) deliveries.push({ lang, draft: b.draft, d: b.draft.delivery });
      }
      t.require(deliveries.length > 0, "no newsletter has ever been sent from this box (no delivery ledger on either edition), so the delivery job has nothing to show");
      const now = t.now();
      for (const { lang, draft, d } of deliveries) {
        const what = `the ${lang === "es" ? "Spanish" : "English"} newsletter delivery`;
        t.fields(d, ["startedAt", "roundAt", "round"], what);
        t.ok(Array.isArray(d.recipients) && d.recipients.length > 0, `${what} has nobody on its ledger`);
        const states = d.recipients.map((r) => r.state);
        t.ok(states.every((s) => ["queued", "sent", "failed", "bounced", "undeliverable"].includes(s)), `${what} has a recipient in an unknown state`);
        const queued = states.filter((s) => s === "queued").length;
        if (d.finishedAt) {
          t.equal(queued, 0, `${what} is marked finished with recipients still queued`);
          t.ok(states.every((s) => s === "sent" || s === "undeliverable"), `${what} is marked finished but a recipient is still waiting for the retry`);
          t.ok(Date.parse(d.finishedAt) >= Date.parse(d.startedAt), `${what} finished before it started`);
          t.equal(draft.status, "sent", `${what} finished but the issue is not marked sent`);
          // The 2026-09-18 incident in numbers: 11 emails in 18 seconds. A paced first round takes
          // at least (recipients - 1) x 45 s before its bounce check (prod 2026-10-04: 8 Spanish
          // emails, 11 minutes). Allow 10% for clock jitter. Per-email times are not stored, so
          // the round as a whole is what can be timed.
          if (Number(d.round) === 1 && d.checkedAt) {
            const roundMin = (Date.parse(d.checkedAt) - Date.parse(d.roundAt)) / 60_000;
            const needMin = ((d.recipients.length - 1) * 45_000 * 0.9) / 60_000;
            t.ok(roundMin >= needMin, `${what} sent ${d.recipients.length} emails and checked bounces ${roundMin.toFixed(1)} minutes after starting — at one email every 45 seconds it needs at least ${needMin.toFixed(1)}; the sends are no longer paced`);
          }
        } else if (queued > 0) {
          const allowH = (queued * 45_000 + 12 * 60_000) / HOUR;
          const h = ageH(t, d.roundAt);
          t.ok(h <= allowH, `${what} has ${queued} recipients still queued ${h.toFixed(1)} hours after the round started (it should take ${(allowH * 60).toFixed(0)} minutes) — the send is stuck and the 5-minute resume job is not moving it`);
        } else if (d.retryAt) {
          const lateMin = (now - Date.parse(d.retryAt)) / 60_000;
          t.ok(lateMin <= 15, `${what}'s retry was due ${lateMin.toFixed(0)} minutes ago and has not run — the 5-minute resume job is not running`);
        } else {
          const h = ageH(t, d.roundAt);
          t.ok(h <= (d.recipients.length * 45_000 + 15 * 60_000) / HOUR, `${what} sent its round ${h.toFixed(1)} hours ago and never finished its bounce check`);
        }
        t.observe(`${lang} last delivery recipients`, d.recipients.length, "info");
      }
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // scheduleSubscriberHygiene: once a day at 10:00 Eastern reminds never-confirmed subscribers
  // after 3 days, archives them after 21 days, deletes bounced rows after 7 days. Only the
  // archive step is visible over HTTP (reminder_sent_at and bounced_at are not returned):
  // nobody may still be "pending" more than 22 days + 1 hour after signing up.
  {
    id: "jobs.subscriber-hygiene-archives-unconfirmed",
    basis: "code: server/src/index.ts — scheduleSubscriberHygiene runs daily at 10:00 Eastern: reminds unconfirmed sign-ups after 3 days, archives them after 21, deletes bounced rows after 7",
    title: "The daily subscriber clean-up is running: people are waiting to confirm and none has waited more than 22 days (and the subscriber list refuses strangers)",
    covers: ["job scheduleSubscriberHygiene", "GET /api/subscribers", "GET /api/healthz/jobs"],
    modes: ["dev", "prod"],
    incident: "2026-10-02: subscription bombing left bot rows pending; 2026-08-26: bounced rows had never been cleared",
    run: async (t) => {
      const anon = await t.get("/api/subscribers?status=pending&limit=1");
      t.equal(anon.status, 401, `the subscriber list must refuse a request with no token (${anon.describe()})`);
      const list = async (status, limit, page = 1) => {
        const b = t.json(await t.get(`/api/subscribers?status=${status}&limit=${limit}&page=${page}`, { auth: true }));
        t.ok(Array.isArray(b.subscribers) && typeof b.total === "number", `the ${status} subscriber list did not answer as a list`);
        for (const r of b.subscribers) t.equal(r.status, status, `a row in the ${status} subscriber list`);
        return b;
      };
      const confirmed = await list("confirmed", 1);   // how many are signed up is the audience, not the site
      const archived = await list("archived", 1);
      const pending = await list("pending", 200);
      // newest first: the oldest pending rows are on the last page
      const last = pending.total > 200 ? await list("pending", 200, Math.ceil(pending.total / 200)) : pending;
      // With nobody pending, "nobody pending too long" is true of an empty list and says nothing
      // about whether the 10:00 clean-up still runs (adversarial review 2026-10-08: prod had 0
      // pending; archived rows do not show who archived them). Since 2026-10-08 the job-health
      // ledger (GET /api/healthz/jobs) records the job's runs, so the run itself is checked there:
      // the daily job must have succeeded within the last 26 hours once the box has been up a day
      // (the ledger survives restarts, so a deploy does not reset it).
      const ledger = t.json(await t.get("/api/healthz/jobs", { auth: true }));
      const job = (ledger.jobs || []).find((j) => j.name === "scheduleSubscriberHygiene");
      t.ok(job, "the job-health ledger has no entry for scheduleSubscriberHygiene");
      if (job && !job.disabled) {
        const bootedH = (t.now() - Date.parse(ledger.bootedAt)) / HOUR;
        if (job.lastOkAt) {
          t.fresh(job.lastOkAt, 26, "the daily subscriber clean-up's last successful run (10:00 Eastern)");
          t.ok(job.consecutiveFailures === 0, `the subscriber clean-up has failed ${job.consecutiveFailures} time(s) in a row: ${job.lastError}`);
          t.observe("clean-up last result", job.lastResult || "", "info");
        } else {
          t.require(bootedH > 26, `the subscriber clean-up has not run yet on this box (up ${bootedH.toFixed(1)} h; it runs daily at 10:00 Eastern) — nothing to judge until it has`);
          t.ok(false, `the daily subscriber clean-up has never succeeded on a box that has been up ${bootedH.toFixed(0)} hours${job.lastError ? ` — last error: ${job.lastError}` : ""}`);
        }
      } else if (job) t.observe("subscriber clean-up disabled on this box", job.disabledWhy || true);
      const tooOld = last.subscribers.filter((r) => ageH(t, r.created_at) > 22 * 24 + 1);
      t.ok(tooOld.length === 0, `${tooOld.length} subscribers have been pending for more than 22 days (oldest signed up ${tooOld.map((r) => r.created_at).sort()[0]}) — the 10:00 Eastern clean-up archives them after 21, so it has not run`);
      t.observe("confirmed subscribers", confirmed.total, "info");
      t.observe("archived subscribers", archived.total, "info");
      t.observe("pending subscribers", pending.total, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // News agent (port 3003, stillafloat-newsagent): its own scheduler POSTs /api/scan-news at
  // 08:00 Eastern daily. The scan REPLACES the editorial queue (generatedAt is written only by a
  // scan — approve/reject keep it) and first runs the 21-day archive sweep, which moves every
  // non-featured story approved more than 21 days ago out of the live feed.
  //   queue limit 30 hours (24 + 6 for scan time and restarts); a missed day shows as ~48;
  //   live feed: no non-featured story older than 22 days + 2 hours.
  // On dev the agent process is stopped (2026-10-07), so this check fails there — correctly.
  {
    id: "jobs.news-daily-scan-ran",
    basis: "master-ref: §5 NEWS / EDITORIAL AGENT — the news agent self-schedules a daily scan at 08:00 America/New_York that replaces the editorial queue, preceded by the 21-day archive sweep",
    title: "The news agent's 08:00 daily scan ran in the last day and its 21-day archive sweep is keeping old stories out of the live news feed",
    covers: ["ext:news job daily scan", "GET /api/news-feed"],
    modes: ["dev", "prod"],
    incident: "2026-10: the news agent was stopped on the dev box (72 restarts) and nothing said so",
    run: async (t) => {
      const h = t.success(await t.get("/api/health", { service: "news" }), "ok");
      t.fresh(h.time, 0.1, "the news agent's own clock");
      const q = t.success(await t.get("/api/editorial-queue", { service: "news", auth: true }));
      t.ok(Array.isArray(q.stories), "the editorial queue has no stories array");
      t.fresh(q.generatedAt, 30, "the editorial queue (replaced by the news agent's 08:00 Eastern scan every day)");
      t.equal(q.degradedMode, false, "the last news scan ran in degraded mode (without the AI editor)");
      // how many stories the scan found worth queueing is the news (and Mark's approvals shrink the queue
      // through the day), so only the scan's own stamp is demanded; each queued story must be well-formed
      for (const s of [q.stories[0], q.stories[q.stories.length - 1]].filter(Boolean)) t.fields(s, ["id", "title", "category"], "a story in the editorial queue");

      const feed = t.success(await t.get("/api/news-feed"));
      t.nonEmpty(feed.stories, "the live news feed");
      const sweepable = feed.stories.filter((s) => !(s.featured || s.pinned));
      t.ok(sweepable.every((s) => Number.isFinite(Date.parse(s.approvedAt || ""))), "a live story has no readable approval date, so the archive sweep can never age it out");
      const stale = sweepable.filter((s) => ageH(t, s.approvedAt) > 22 * 24 + 2);
      t.ok(stale.length === 0, `${stale.length} stories approved more than 22 days ago are still in the live news feed (e.g. ${stale[0]?.id}) — the 21-day archive sweep that runs with the daily scan has not run`);
      t.observe("live stories", feed.stories.length, "info");
      t.observe("queue keys", keysOf(q), "exact");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Ops manager (saf-ops-manager): the scheduler loop runs the AI-visibility measurement daily at
  // 10:00 Eastern and writes platform_state "ai-visibility" (payload.updatedAt + lookups.
  // generatedAt), which the dashboard reads through GET /api/ai-visibility. Limit 27 hours.
  // It is the one ops-manager job whose result the gate can read with the dashboard token; the
  // others are listed as gaps in coverage/jobs.json. Runs on both boxes.
  {
    id: "jobs.ops-ai-visibility-measured-today",
    basis: "master-ref: §4 SAF-OPS-MANAGER — the ops manager's scheduler measures AI-assistant visibility daily at 10:00 Eastern and writes platform_state 'ai-visibility', which the dashboard reads",
    title: "The ops manager is up and its daily AI-visibility measurement ran in the last day with well-formed crawler counts and this week's numbers, readable from the dashboard",
    covers: ["ext:ops job ai-visibility", "GET /api/ai-visibility"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const o = t.success(await t.get("/health", { service: "ops" }), "ok");
      t.equal(o.gmail_token_present, true, "the ops manager has no Gmail token (its mail jobs cannot run)");
      const anon = await t.get("/api/ai-visibility");
      t.equal(anon.status, 401, `AI visibility must refuse a request with no token (${anon.describe()})`);
      const v = t.success(await t.get("/api/ai-visibility", { auth: true }));
      t.fields(v, ["updatedAt", "lookups.generatedAt", "lookups.crawlers"], "the AI-visibility data");
      t.fresh(v.updatedAt, 27, "the AI-visibility data (measured daily at 10:00 Eastern by the ops manager)");
      t.fresh(v.lookups.generatedAt, 27, "the AI-visibility lookups (assistant crawlers and referrals from the web logs)");
      // How many AI-assistant crawlers visited is traffic, not the site (dev gets none), so the count may be
      // zero; it must be a well-formed set of non-negative numbers.
      const crawlerCounts = Object.values(v.lookups.crawlers || {});
      t.ok(crawlerCounts.every((x) => Number.isFinite(Number(x)) && Number(x) >= 0), "an AI crawler count is not a non-negative number");
      const crawlerTotal = crawlerCounts.reduce((n, x) => n + (Number(x) || 0), 0);
      t.observe("AI crawler visits counted in 28 days", crawlerTotal, "info");
      t.ok(Array.isArray(v.lookups.weeks) && v.lookups.weeks.length >= 1, "the AI-visibility lookups have no weekly breakdown");
      // A run that stamps the time but rebuilds from an old log window shows no current week
      // (adversarial review 2026-10-08). The newest week starts on this week's Monday: at most
      // 7 days + the 10:00 run's offset (8 days) ago. The weeks run oldest first.
      const starts = v.lookups.weeks.map((w) => Date.parse(`${w?.weekStart}T00:00:00Z`));
      t.ok(starts.every(Number.isFinite), "a week in the AI-visibility breakdown has no readable start date");
      t.ok(starts.every((x, i) => i === 0 || x > starts[i - 1]), "the AI-visibility weeks are out of order");
      t.fresh(starts[starts.length - 1], 8 * 24, "the newest week in the AI-visibility breakdown");
      t.observe("ai-visibility keys", keysOf(v), "exact");
      t.observe("crawlers tracked", Object.keys(v.lookups.crawlers || {}).length, "min");
    },
  },
];
