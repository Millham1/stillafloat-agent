// e2e/checks/news.mjs — Cruise News: the feeds, the story pages (EN + ES), the prerendered
// /news/ pages and sitemap, the dashboard's news archive, translations, and the news agent
// service (port 3003) whose editorial queue feeds all of it.
//
// Why this file exists — the risks it guards (each check names its own):
//   • THE SAME STORY IS SHOWN FIVE WAYS: the homepage cards (/api/homepage-feed), the full feed
//     (/api/news-feed), the story-details record (/api/story-details, read by /story.html), the
//     prerendered page (/news/<slug>.html, written hourly by scheduleNewsPrerender) and its
//     sitemap entry. The homepage links a card to /news/<slug>.html using a client-side COPY of
//     storySlug() (js/news.js) — if the two copies drift, every homepage card 404s while each
//     feature, tested alone, still "passes". So these views are checked against each other.
//   • SPANISH IS FIRST-CLASS: ?lang=es overlays title_es/summary_es; a story without them makes
//     /es/story.html call the PAID translate-story path on a visitor's page load.
//   • A STOPPED AGENT IS SILENT: the news agent (pm2 saf-newsagent) can stop and the site keeps
//     serving yesterday's feed with HTTP 200. The checks read freshness, not just status.
//   • 2026-10 (dev): the news agent was stopped on the dev box (72 restarts) and nginx on dev did
//     not route /api/editorial-queue or /review to it — the site answered the homepage HTML with
//     HTTP 200 instead. Dev cannot mirror prod's news until both are fixed; the checks say so.
//
// Load: every check samples (first, last and a few in between) — never a loop over all ~200
// story pages. All GETs used on prod were read for side effects:
//   • /api/translate-story is called ONLY for a story whose feed record already carries
//     title_es — the handler then returns the stored translation (no model call, no write). It
//     is never called for an untranslated story. The handler reads approved-stories, not the
//     feed (news-index); the guard is sound because every agent writer (approve, the 21-day
//     sweep, the Spanish backfill, deepen-stories) writes approved-stories and news-index from
//     the same snapshot, and news-index's title_es is copied from approved-stories' title_es
//     (publishing-output.ts buildPublishingStory). Re-read that if either side changes.
//   • /api/translate-article (fetches an arbitrary URL and makes an uncached paid model call) is
//     only ever called with no url / an invalid url — the two paths that refuse before any fetch.
//   • /api/agent-action (approves/rejects stories) is never called on prod; on dev only without
//     a token, after proving the agent enforces its token.
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

const SITE = "https://stillafloatcruising.com"; // canonical host the prerenderer writes into every page

// byte-for-byte twin of storySlug() in server/src/lib/prerender-news.ts (and js/news.js)
function djb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, "0").slice(-6); }
export function storySlug(id) {
  const raw = String(id || "story");
  const base = raw.toLowerCase().replace(/-https?-.*$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70).replace(/-+$/, "");
  return `${base || "story"}-${djb2(raw)}`;
}

const decode = (s) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const norm = (s) => decode(s).toLowerCase();
const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
const ageH = (t, iso) => (t.now() - Date.parse(iso)) / 3_600_000;
const IMPACTS = ["Low", "Medium", "High", "Critical"];
// the prerenderer's own noindex rule (isNoindex in prerender-news.ts), minus per-story SEO overrides
const noindexByRule = (s) => String(s.impactLevel || "").trim().toLowerCase() === "low" || words(s.travelerImpact) < 35 || words(s.editorialReasoning) < 70;
/** first, last and up to `n-2` evenly spaced in between */
const spread = (arr, n) => {
  if (arr.length <= n) return [...arr];
  const idx = new Set([0, arr.length - 1]);
  for (let i = 1; idx.size < n; i++) idx.add(Math.round((i * (arr.length - 1)) / (n - 1)));
  return [...idx].sort((a, b) => a - b).map((i) => arr[i]);
};
/** Stories old enough that the hourly prerender must already have written their pages. */
const PRERENDER_SLACK_H = 1.25;
const isAlert = (s) => { const i = String(s.impactLevel || "").toLowerCase(); return Boolean(s.featured || s.pinned || i.includes("high") || i.includes("critical")); };
const pageMetaRobots = (html) => H.metaContent(html, "robots");
const storyLinks = (html, lang) => new Set([...html.matchAll(lang === "es" ? /href="\/es\/news\/([a-z0-9-]+)\.html"/g : /href="\/news\/([a-z0-9-]+)\.html"/g)].map((m) => m[1]));
const isStorySlug = (slug) => /-[0-9a-f]{6}$/.test(slug);
const enLocRe = new RegExp(`^${SITE.replace(/[.]/g, "\\.")}/news/([a-z0-9-]+)\\.html$`);
/** Fields buildPublishingStory() writes identically into news-index, story-details and the homepage feed. */
const SAME_FIELDS = ["title", "summary", "title_es", "summary_es", "travelerImpact", "travelerImpact_es", "editorialReasoning", "editorialReasoning_es", "link", "originalLink", "sources", "image", "category", "impactLevel", "approvedAt", "es_source_url"];

async function loadFeed(t, lang) {
  const r = t.success(await t.get(`/api/news-feed${lang === "es" ? "?lang=es" : ""}`));
  t.ok(Array.isArray(r.stories), `the ${lang} news feed has no stories array`);
  t.equal(r.count, r.stories.length, `${lang} news feed: "count" and the number of stories`);
  t.atLeast(r.stories.length, 3, `stories in the ${lang} news feed`);
  return r;
}

export default [
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.feeds-agree",
    title: "The news feed, homepage news, alerts and story details all list the same approved stories, in English and Spanish, and the feed is current",
    covers: ["GET /api/news-feed", "GET /api/homepage-feed", "GET /api/story-details", "GET /api/alerts-feed"],
    modes: ["dev", "prod"],
    incident: "risk: one view of a story drifting from the others (a homepage card with no details record shows 'Story unavailable'); a stopped agent leaves a stale feed answering 200",
    run: async (t) => {
      const en = await loadFeed(t, "en");
      const es = await loadFeed(t, "es");
      t.equal(en.lang, "en", "news feed language"); t.equal(es.lang, "es", "Spanish news feed language");

      // every story is complete, in both languages
      const ids = new Set(); const slugs = new Set(); const unlinked = [];
      t.ok(en.stories.every((s) => s && typeof s === "object"), "the news feed holds something that is not a story");
      for (const s of en.stories) {
        t.fields(s, ["id", "title", "summary", "approvedAt", "category", "impactLevel", "title_es", "summary_es"], `feed story ${s.id}`);
        if (!(s.link || s.originalLink)) unlinked.push(s.id);
        t.ok(IMPACTS.includes(s.impactLevel), `feed story ${s.id} has an unknown impact level "${s.impactLevel}"`);
        t.ok(Number.isFinite(Date.parse(s.approvedAt)), `feed story ${s.id} has no readable approval date`);
        if (s.travelerImpact) t.ok(s.travelerImpact_es, `feed story ${s.id} has a "what this means for you" panel but no Spanish version of it`);
        if (s.editorialReasoning) t.ok(s.editorialReasoning_es, `feed story ${s.id} has Mark's take but no Spanish version of it`);
        t.ok(!ids.has(s.id), `story ${s.id} appears twice in the feed`); ids.add(s.id);
        const sl = storySlug(s.id);
        t.ok(!slugs.has(sl), `two feed stories share the page address /news/${sl}.html`); slugs.add(sl);
      }
      for (let i = 1; i < en.stories.length; i++) t.ok(en.stories[i - 1].approvedAt >= en.stories[i].approvedAt, "the news feed is not newest-first");

      // Spanish feed: same stories, same order, Spanish text
      t.equal(es.stories.map((s) => s.id).join("|"), en.stories.map((s) => s.id).join("|"), "the Spanish feed and the English feed list different stories");
      let differs = 0;
      for (let i = 0; i < en.stories.length; i++) {
        const s = en.stories[i]; const e = es.stories[i];
        t.equal(e.title, s.title_es, `Spanish feed title of ${s.id}`);
        t.equal(e.summary, s.summary_es, `Spanish feed summary of ${s.id}`);
        // the two panels Spanish readers see on a story (applyEsOverlay): a dropped overlay shows English
        t.equal(e.travelerImpact, s.travelerImpact_es || s.travelerImpact, `Spanish feed "what this means for you" of ${s.id}`);
        t.equal(e.editorialReasoning, s.editorialReasoning_es || s.editorialReasoning, `Spanish feed take of ${s.id}`);
        if (s.title_es.trim() !== s.title.trim()) differs++;
      }
      t.ok(differs >= Math.ceil(en.stories.length * 0.8), `only ${differs} of ${en.stories.length} Spanish titles differ from the English — the "translations" are mostly English`);

      // homepage cards are feed stories (EN and ES)
      const home = t.success(await t.get("/api/homepage-feed"));
      const homeEs = t.success(await t.get("/api/homepage-feed?lang=es"));
      t.ok(Array.isArray(home.stories) && Array.isArray(homeEs.stories), "a homepage feed has no stories array");
      t.atLeast(home.stories.length, 1, "stories in the homepage news panel");
      t.ok(home.stories.length <= 5, `the homepage news panel carries ${home.stories.length} stories (the agent writes at most 5)`);
      t.equal(home.count, home.stories.length, "homepage feed count");
      t.equal(homeEs.lang, "es", "Spanish homepage feed language");
      const byId = new Map(en.stories.map((s) => [s.id, s]));
      // the homepage, the feed and story-details are written TOGETHER by every agent writer
      // (approve, the 21-day sweep, the Spanish backfill, deepen-stories) from one approved-stories
      // snapshot — so a story must read identically in all three, field for field.
      for (const s of home.stories) {
        const f = byId.get(s.id);
        t.ok(f, `homepage story ${s.id} is not in the news feed (its card would open a page that may not exist)`);
        for (const k of SAME_FIELDS) t.equal(JSON.stringify(s[k]), JSON.stringify(f[k]), `homepage vs feed, "${k}" of ${s.id}`);
        t.equal(s.featured, true, `homepage story ${s.id} is not marked featured (the agent publishes the homepage from Mark's featured picks)`);
      }
      t.equal(homeEs.stories.map((s) => s.id).join("|"), home.stories.map((s) => s.id).join("|"), "the Spanish homepage panel lists different stories");
      for (const s of homeEs.stories) {
        t.equal(s.title, byId.get(s.id)?.title_es, `Spanish homepage title of ${s.id}`);
        t.equal(s.summary, byId.get(s.id)?.summary_es, `Spanish homepage summary of ${s.id}`);
      }

      // story-details (what /story.html and the hourly prerender read) is the feed's twin, both ways
      const det = t.success(await t.get("/api/story-details"));
      t.ok(Array.isArray(det.stories), "story-details has no stories array");
      t.equal(det.count, det.stories.length, "story-details count");
      const detById = new Map(det.stories.map((s) => [s.id, s]));
      for (const s of en.stories) {
        const d = detById.get(s.id);
        t.ok(d, `feed story ${s.id} has no story-details record — its story page would say "Story unavailable"`);
        for (const k of SAME_FIELDS) t.equal(JSON.stringify(d[k]), JSON.stringify(s[k]), `story-details vs feed, "${k}" of ${s.id}`);
      }
      for (const d of det.stories) {
        t.ok(byId.has(d.id), `story-details carries ${d.id}, which is not in the news feed (a stale details record: its prerendered page outlives the feed)`);
        // /es/story.html calls the PAID translate-story for a details record without title_es
        t.ok(d.title_es, `story-details record ${d.id} has no Spanish title — /es/story.html would pay to translate it on a visitor's page load`);
      }
      // written together, so their stamps agree; one lagging means one writer has stopped
      const stamps = { "news feed": en.generatedAt, "homepage feed": home.generatedAt, "story-details": det.generatedAt };
      for (const [k, v] of Object.entries(stamps)) t.ok(Number.isFinite(Date.parse(v)), `the ${k} has no generatedAt`);
      const spanMin = (Math.max(...Object.values(stamps).map(Date.parse)) - Math.min(...Object.values(stamps).map(Date.parse))) / 60_000;
      t.ok(spanMin <= 10, `the news feed, homepage feed and story-details were last written ${spanMin.toFixed(0)} minutes apart — the agent writes all three together, so one of them is stale`);

      // the alerts feed is exactly the feed's featured / high / critical stories, top 10
      const al = t.success(await t.get("/api/alerts-feed"));
      t.ok(Array.isArray(al.alerts), "the alerts feed has no alerts array");
      const expected = en.stories.filter(isAlert).slice(0, 10).map((s) => s.id);
      t.require(expected.length > 0, "the news feed has no featured, high or critical story, so the alerts feed cannot be tested");
      t.equal(al.alerts.map((a) => a.id).join("|"), expected.join("|"), "alerts feed vs the feed's featured/high/critical stories");
      for (const a of al.alerts) {
        t.fields(a, ["id", "title", "impactLevel", "approvedAt"], `alert ${a.id}`);
        const f = byId.get(a.id);
        for (const k of ["title", "summary", "category", "impactLevel", "travelerImpact", "link", "approvedAt"]) t.equal(a[k], f[k], `alerts feed vs feed, "${k}" of ${a.id}`);
      }

      t.observe("feed keys", keysOf(en));
      t.observe("fields every story has", Object.keys(en.stories[0]).filter((k) => en.stories.every((x) => k in x)).sort().join(","));
      t.observe("stories in feed", en.stories.length, "info");
      t.observe("homepage stories", home.stories.length, "info");
      t.observe("alerts", al.alerts.length, "info");
      t.observe("newest story age (hours)", Math.round(ageH(t, en.stories[0].approvedAt)), "info");

      // asserted last so every other view is still compared when these fail.
      // the feed is alive: a story was approved this week, and the daily 21-day sweep ran
      t.fresh(en.stories[0].approvedAt, 7 * 24, "the newest approved news story (no story approved in a week means the agent or the approvals have stopped)");
      const overdue = en.stories.filter((s) => !s.featured && !s.pinned && ageH(t, s.approvedAt) > 23 * 24);
      t.ok(overdue.length === 0, `${overdue.length} unfeatured stories older than 23 days are still in the live feed — the news agent's daily 21-day archive sweep has not run`);

      t.ok(unlinked.length === 0, `${unlinked.length} feed stories credit their sources but link none (e.g. ${unlinked[0]}) — the story page has no "read the original" link`);
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.story-lookup-en-es",
    title: "Opening a story by id (story.html / es/story.html) returns that story, with the Spanish version already translated",
    covers: ["GET /api/story-details", "page /story.html", "page /es/story.html"],
    modes: ["dev", "prod"],
    incident: "risk: a story without stored Spanish text makes /es/story.html call the paid translation on every visit",
    run: async (t) => {
      const feed = await loadFeed(t, "en");
      // sample: newest, oldest and two in between
      for (const s of spread(feed.stories, 4)) {
        const one = t.success(await t.get(`/api/story-details?id=${encodeURIComponent(s.id)}`));
        t.fields(one.story, ["id", "title", "summary", "approvedAt"], `story-details for ${s.id}`);
        t.equal(one.story.id, s.id, "story-details returned a different story");
        for (const k of ["title", "summary", "travelerImpact", "editorialReasoning", "category", "approvedAt"]) t.equal(one.story[k], s[k], `story-details "${k}" of ${s.id} (what /story.html shows) vs the feed`);
        t.equal(one.story.originalLink || one.story.link || "", s.originalLink || s.link || "", `story-details source link of ${s.id} (the page's "read the original" button)`);
        const oneEs = t.success(await t.get(`/api/story-details?id=${encodeURIComponent(s.id)}&lang=es`));
        t.ok(oneEs.story?.title_es, `story ${s.id} has no stored Spanish title — /es/story.html would call the paid translation for every visitor`);
        t.equal(oneEs.story.id, s.id, "Spanish story-details returned a different story");
        t.equal(oneEs.story.title, s.title_es, `Spanish story-details title of ${s.id}`);
        t.equal(oneEs.story.summary, s.summary_es, `Spanish story-details summary of ${s.id}`);
        t.equal(oneEs.story.travelerImpact, s.travelerImpact_es || s.travelerImpact, `Spanish story-details "what this means for you" of ${s.id}`);
        t.equal(oneEs.story.editorialReasoning, s.editorialReasoning_es || s.editorialReasoning, `Spanish story-details take of ${s.id}`);
      }
      const gone = await t.get("/api/story-details?id=e2e-no-such-story-0000");
      t.equal(gone.status, 404, `an unknown story id should be a clean 404 (${gone.describe()})`);
      t.equal(gone.json?.success, false, "an unknown story id should say success:false");

      const goneEs = await t.get("/api/story-details?id=e2e-no-such-story-0000&lang=es");
      t.equal(goneEs.status, 404, `an unknown story id in Spanish should be a clean 404 (${goneEs.describe()})`);

      // the pages read the id from their own address and fill the elements the API answer goes into
      const en = t.html(await t.get("/story.html"), { mustContain: ["/api/story-details?id=", "getParam('id')", 'id="story-title"', 'id="story-summary"', 'id="story-link"'] });
      t.equal(H.htmlLang(en).slice(0, 2), "en", "/story.html language");
      const es = t.html(await t.get("/es/story.html"), { mustContain: ["/api/story-details?id=", "&lang=es", "getParam('id')", 'id="story-title"', 'id="story-summary"', "title_es"] });
      t.equal(H.htmlLang(es).slice(0, 2), "es", "/es/story.html language");
      t.observe("story.html title", H.title(en));
      t.observe("es/story.html title", H.title(es));
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.prerendered-pages-match-feed",
    title: "Every approved story has its own English and Spanish news page, is listed on /news.html and /es/news.html, and is in the news sitemap unless the page is marked noindex",
    covers: ["GET /api/news-feed", "job scheduleNewsPrerender", "ext:page /news.html", "ext:page /es/news.html", "ext:page /news/<story>.html", "ext:page /es/news/<story>.html", "ext:page /news/<line>.html hub", "ext:page /es/news/<line>.html hub", "ext:file /news-sitemap.xml"],
    modes: ["dev", "prod"],
    incident: "risk: the hourly prerender stops (or the slug rule drifts) and new stories never get a crawlable page or sitemap entry while the API still looks fine",
    run: async (t) => {
      const feed = await loadFeed(t, "en");
      const settled = feed.stories.filter((s) => ageH(t, s.approvedAt) > PRERENDER_SLACK_H);
      t.require(settled.length > 0, "every story in the feed was approved within the last hour, so the hourly prerender cannot be judged yet");

      const listEn = t.html(await t.get("/news.html"));
      const listEs = t.html(await t.get("/es/news.html"));
      t.equal(H.htmlLang(listEn).slice(0, 2), "en", "/news.html language");
      t.equal(H.htmlLang(listEs).slice(0, 2), "es", "/es/news.html language");
      const linkedEn = storyLinks(listEn, "en"); const linkedEs = storyLinks(listEs, "es");
      // every settled feed story is on both listings (in-memory comparison: no extra requests)
      const missEn = settled.filter((s) => !linkedEn.has(storySlug(s.id)));
      const missEs = settled.filter((s) => !linkedEs.has(storySlug(s.id)));
      t.ok(missEn.length === 0, `${missEn.length} approved stories are missing from /news.html (e.g. ${missEn[0]?.id}) — the hourly news prerender has not run since they were approved`);
      t.ok(missEs.length === 0, `${missEs.length} approved stories are missing from /es/news.html (e.g. ${missEs[0]?.id})`);
      t.atLeast([...linkedEn].filter(isStorySlug).length, feed.stories.length, "story links on /news.html (live + archived)");

      const smRes = await t.get("/news-sitemap.xml");
      t.status(smRes, 200);
      const sm = smRes.text;
      t.ok(/<urlset[\s>]/.test(sm), "/news-sitemap.xml is not a sitemap");
      const locs = new Set([...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
      t.ok(locs.has(`${SITE}/news.html`) && locs.has(`${SITE}/es/news.html`), "the news sitemap does not list /news.html and /es/news.html");

      // indexable story pages (per language) must be in the sitemap; one that is not must really be
      // noindex (a per-story SEO override, or the prerenderer's Spanish-only exclusions)
      const notListed = [];
      for (const s of settled) for (const lang of ["en", "es"]) {
        const p = lang === "es" ? `/es/news/${storySlug(s.id)}.html` : `/news/${storySlug(s.id)}.html`;
        if (!noindexByRule(s) && !locs.has(`${SITE}${p}`)) notListed.push({ id: s.id, p });
      }
      t.ok(notListed.length <= 4, `${notListed.length} indexable story pages are missing from the news sitemap (e.g. ${notListed[0]?.p})`);
      for (const { id, p } of notListed) {
        const html = t.html(await t.get(p));
        t.ok(/noindex/i.test(pageMetaRobots(html)), `story ${id}: ${p} is indexable but missing from the news sitemap`);
      }

      // sampled story pages, EN + ES: newest settled, oldest, two between
      for (const s of spread(settled, 4)) {
        const slug = storySlug(s.id);
        for (const lang of ["en", "es"]) {
          const p = lang === "es" ? `/es/news/${slug}.html` : `/news/${slug}.html`;
          const html = t.html(await t.get(p));
          t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
          const h1 = decode(H.h1s(html)[0] || "");
          t.equal(norm(h1), norm(lang === "es" ? s.title_es : s.title), `${p} headline vs the feed`);
          t.equal(H.canonical(html), `${SITE}${p}`, `${p} canonical address`);
          const hl = H.hreflangs(html);
          t.equal(hl.en, `${SITE}/news/${slug}.html`, `${p} English twin link`);
          t.equal(hl.es, `${SITE}/es/news/${slug}.html`, `${p} Spanish twin link`);
          const noindex = /noindex/i.test(pageMetaRobots(html));
          t.ok(noindex !== locs.has(`${SITE}${p}`), noindex ? `${p} is marked noindex but is submitted in the news sitemap` : `${p} is indexable but not in the news sitemap`);
          // the BODY is the story, in the page's language (a dropped _es field renders English on /es/)
          const body = norm(H.visibleText(html));
          const want = (k) => norm(lang === "es" ? (s[`${k}_es`] || s[k]) : s[k]);
          t.ok(body.includes(want("summary")), `${p} does not show the story's ${lang === "es" ? "Spanish " : ""}summary from the feed`);
          for (const k of ["travelerImpact", "editorialReasoning"]) {
            const head = want(k).slice(0, 100);
            if (head) t.ok(body.includes(head), `${p} does not show the story's ${k === "travelerImpact" ? '"what this means for you"' : "take"} from the feed`);
          }
          const orig = s.originalLink || s.link;
          if (orig) t.ok(H.links(html).map(decode).includes(orig), `${p} has no "read the original" link to the story's source`);
          // related-story links on the page open stories that exist on the listing
          for (const rel of storyLinks(html, lang)) if (isStorySlug(rel) && rel !== slug) t.ok((lang === "es" ? linkedEs : linkedEn).has(rel), `${p} links a related story (${rel}) that is not on the ${lang} news listing`);
        }
      }

      // archived stories (aged out of the feed by the 21-day sweep) keep their sitemap entries — and
      // those entries must open real pages. Sample the newest and oldest such entries (EN + ES).
      const feedSlugs = new Set(feed.stories.map((s) => storySlug(s.id)));
      const archivedLocs = [...locs].map((u) => enLocRe.exec(u)?.[1]).filter((x) => x && isStorySlug(x) && !feedSlugs.has(x));
      t.observe("archived story pages in the sitemap", archivedLocs.length, "min");
      t.require(archivedLocs.length > 0, "the news sitemap lists no archived story, so 'aged-out pages keep working' cannot be tested here");
      for (const slug of spread(archivedLocs, 2)) {
        t.ok(linkedEn.has(slug), `the sitemap submits the archived story /news/${slug}.html but /news.html does not list it`);
        const html = t.html(await t.get(`/news/${slug}.html`));
        t.ok(!/noindex/i.test(pageMetaRobots(html)), `/news/${slug}.html is submitted in the sitemap but marked noindex`);
        t.nonEmpty(decode(H.h1s(html)[0] || ""), `/news/${slug}.html headline`);
        t.equal(H.canonical(html), `${SITE}/news/${slug}.html`, `/news/${slug}.html canonical address`);
        if (locs.has(`${SITE}/es/news/${slug}.html`)) {
          const es = t.html(await t.get(`/es/news/${slug}.html`));
          t.equal(H.htmlLang(es).slice(0, 2), "es", `/es/news/${slug}.html language`);
          t.nonEmpty(decode(H.h1s(es)[0] || ""), `/es/news/${slug}.html headline`);
        }
      }

      // per-line hubs: sitemap hubs exist in both languages, link real stories, and the feed's rail points at them
      const hubs = [...locs].map((u) => enLocRe.exec(u)?.[1]).filter((x) => x && !isStorySlug(x));
      t.atLeast(hubs.length, 1, "per-line news hubs in the sitemap");
      for (const h of hubs) t.ok(locs.has(`${SITE}/es/news/${h}.html`), `hub "${h}" has no Spanish twin in the sitemap`);
      const railEn = [...linkedEn].filter((x) => !isStorySlug(x));
      for (const h of railEn) t.ok(hubs.includes(h), `/news.html links the hub /news/${h}.html, which is not in the sitemap`);
      for (const h of spread(hubs, 2)) {
        for (const lang of ["en", "es"]) {
          const p = lang === "es" ? `/es/news/${h}.html` : `/news/${h}.html`;
          const html = t.html(await t.get(p));
          t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
          t.nonEmpty(H.h1s(html)[0] || "", `${p} headline`);
          const onHub = [...storyLinks(html, lang)].filter(isStorySlug);
          t.atLeast(onHub.length, 3, `stories listed on the ${h} hub (${lang})`);
          const listed = lang === "es" ? linkedEs : linkedEn;
          for (const sl of onHub) t.ok(listed.has(sl), `${p} links a story (${sl}) that is not on the ${lang} news listing`);
        }
      }

      t.observe("news.html title", H.title(listEn));
      t.observe("es/news.html title", H.title(listEs));
      t.observe("story pages linked from news.html", [...linkedEn].filter(isStorySlug).length, "min");
      t.observe("news sitemap entries", locs.size, "min");
      t.observe("news hubs", hubs.slice().sort().join(","), "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.homepage-cards-open-pages",
    title: "The English and Spanish homepages load the news panel script, and its cards link to story pages that exist (the browser's copy of the page-address rule matches the server's)",
    covers: ["GET /api/homepage-feed", "GET /api/news-feed", "page /index.html", "page /es/index.html", "ext:page /news/<story>.html", "ext:page /es/news/<story>.html"],
    modes: ["dev", "prod"],
    incident: "risk: js/news.js carries a hand-copied storySlug(); if it drifts from prerender-news.ts every homepage card 404s while both features pass alone",
    run: async (t) => {
      const js = await t.get("/js/news.js");
      t.status(js, 200);
      t.ok(/\/api\/homepage-feed/.test(js.text) && /\/api\/news-feed/.test(js.text), "js/news.js no longer reads the homepage and news feeds");
      const fnSrc = (name) => {
        const i = js.text.indexOf(`function ${name}(`);
        t.ok(i >= 0, `js/news.js no longer defines ${name}() — the homepage cannot build story links`);
        let depth = 0, j = js.text.indexOf("{", i);
        for (let k = j; k < js.text.length; k++) { if (js.text[k] === "{") depth++; else if (js.text[k] === "}" && --depth === 0) return js.text.slice(i, k + 1); }
        return "";
      };
      t.ok(/\$\{langParam\}|lang=es/.test(js.text) && /\/es\//.test(js.text), "js/news.js no longer asks for the Spanish feeds on /es/ pages");
      // evaluate only the pure functions the page uses to build a card's link — storyUrl() itself,
      // so a changed path or a fallback to the legacy story.html?… link is caught, not just the slug
      const urlFor = (isSpanish) => new Function(`const isSpanish = ${isSpanish};\n${fnSrc("djb2Hex")}\n${fnSrc("storySlug")}\n${fnSrc("storyUrl")}\nreturn (story) => storyUrl(story);`)();
      const browserUrlEn = urlFor(false); const browserUrlEs = urlFor(true);

      // the homepages really run that script into the news panel (a page that stops loading it
      // shows an empty panel while every API still answers)
      for (const [path, lang] of [["/", "en"], ["/es/", "es"]]) {
        const html = t.html(await t.get(path), { mustContain: ['id="news-container"'] });
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${path} language`);
        const src = H.scripts(html).map((s) => H.resolve(s, t.url(path))).filter(Boolean).map((u) => new URL(u).pathname);
        t.ok(src.includes("/js/news.js"), `${path} does not load /js/news.js, so its news panel stays empty`);
      }

      const home = t.success(await t.get("/api/homepage-feed"));
      const homeEs = t.success(await t.get("/api/homepage-feed?lang=es"));
      t.ok(Array.isArray(home.stories) && Array.isArray(homeEs.stories), "a homepage feed has no stories array");
      t.atLeast(home.stories.length, 1, "stories in the homepage news panel");
      const feed = await loadFeed(t, "en");
      // every feed story, both languages: the address the browser builds is the page the server writes
      for (const s of feed.stories) {
        t.equal(browserUrlEn({ id: s.id }), `/news/${storySlug(s.id)}.html`, `the homepage's link for ${s.id}`);
        t.equal(browserUrlEs({ id: s.id }), `/es/news/${storySlug(s.id)}.html`, `the Spanish homepage's link for ${s.id}`);
      }

      const settled = home.stories.filter((s) => ageH(t, s.approvedAt) > PRERENDER_SLACK_H);
      t.require(settled.length > 0, "every homepage story was approved within the last hour, so its page cannot be expected yet");
      for (const s of spread(settled, 2)) {
        const en = t.html(await t.get(browserUrlEn(s)));
        t.equal(norm(H.h1s(en)[0]), norm(s.title), `homepage card "${s.id}" opens a page with a different headline`);
        const es = homeEs.stories.find((x) => x.id === s.id);
        t.ok(es, `homepage story ${s.id} is missing from the Spanish homepage panel`);
        const esHtml = t.html(await t.get(browserUrlEs(es)));
        t.equal(H.htmlLang(esHtml).slice(0, 2), "es", `Spanish homepage card "${s.id}" opens a page that is not Spanish`);
        t.equal(norm(H.h1s(esHtml)[0]), norm(es.title), `Spanish homepage card "${s.id}" opens a page with a different headline`);
      }
      t.observe("homepage story count", home.stories.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.archive-search",
    title: "The dashboard's news archive finds old stories, every archived story still has a card on /news.html and working pages, and the archive refuses anyone without the dashboard token",
    covers: ["GET /api/news-archive", "GET /api/news-archive/story", "ext:page /news.html", "ext:page /news/<story>.html", "ext:page /es/news/<story>.html"],
    modes: ["dev", "prod"],
    incident: "risk: archived stories (aged out of the feed by the 21-day sweep) lose their pages; the archive's slug drifts from the prerenderer's",
    run: async (t) => {
      const anon = await t.get("/api/news-archive?limit=1");
      t.equal(anon.status, 401, `the news archive must refuse a request with no token (${anon.describe()})`);
      const anonOne = await t.get("/api/news-archive/story?id=x");
      t.equal(anonOne.status, 401, `an archived story must refuse a request with no token (${anonOne.describe()})`);

      const list = t.success(await t.get("/api/news-archive?limit=20", { auth: true }));
      t.ok(Array.isArray(list.stories), "the archive has no stories array");
      t.atLeast(list.total, 20, "stories in the news archive");
      t.equal(list.stories.length, 20, "archive page size");
      for (let i = 1; i < list.stories.length; i++) t.ok(String(list.stories[i - 1].approvedAt) >= String(list.stories[i].approvedAt), "the archive is not newest-first");
      for (const s of list.stories) {
        t.fields(s, ["id", "slug", "url", "urlEs", "title", "approvedAt", "status"], `archive entry ${s.id}`);
        t.equal(s.slug, storySlug(s.id), `archive page address of ${s.id} vs the prerenderer's`);
        t.equal(s.url, `${SITE}/news/${s.slug}.html`, `archive link of ${s.id}`);
        t.equal(s.urlEs, `${SITE}/es/news/${s.slug}.html`, `archive Spanish link of ${s.id}`);
        t.ok(["live", "archived"].includes(s.status), `archive entry ${s.id} has status "${s.status}"`);
      }
      // two views of every story ever approved: the archive and the /news.html listing (the prerender
      // merges the archive back in so aged-out pages persist). The newest 200 are compared one by one,
      // and the listing must carry at least as many story pages as the archive holds stories.
      const wide = t.success(await t.get("/api/news-archive?limit=200", { auth: true }));
      t.ok(Array.isArray(wide.stories), "the archive (200 newest) has no stories array");
      t.equal(wide.total, list.total, "the archive's total changed between two reads seconds apart");
      const listing = t.html(await t.get("/news.html"));
      const listed = storyLinks(listing, "en");
      const unlisted = wide.stories.filter((s) => s.title && s.approvedAt && ageH(t, s.approvedAt) > PRERENDER_SLACK_H && !listed.has(s.slug));
      t.ok(unlisted.length === 0, `${unlisted.length} archived stories have no card on /news.html (e.g. ${unlisted[0]?.id}) — their pages are no longer reachable from the site`);
      t.atLeast([...listed].filter(isStorySlug).length, list.total, "story cards on /news.html vs stories in the archive");

      const old = wide.stories.find((s) => s.status === "archived");
      t.require(old, "the archive's newest 200 stories include none that has aged out of the live feed, so the 'old pages persist' promise cannot be tested");

      // the aged-out story still has both pages (SEO pages persist after the feed drops them)
      const en = t.html(await t.get(`/news/${old.slug}.html`));
      t.equal(norm(H.h1s(en)[0]), norm(old.title), `the archived story ${old.id}'s page headline`);
      const es = t.html(await t.get(`/es/news/${old.slug}.html`));
      t.equal(H.htmlLang(es).slice(0, 2), "es", `the archived story ${old.id}'s Spanish page language`);
      if (old.title_es) t.equal(norm(H.h1s(es)[0]), norm(old.title_es), `the archived story ${old.id}'s Spanish headline`);

      // detail view and search agree with the list
      const one = t.success(await t.get(`/api/news-archive/story?id=${encodeURIComponent(old.id)}`, { auth: true }));
      t.equal(one.id, old.id, "archive detail returned a different story");
      t.equal(one.slug, old.slug, "archive detail page address");
      t.fields(one.story, ["id", "title"], "archive detail raw record");
      const terms = String(old.title).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 5).sort((a, b) => b.length - a.length).slice(0, 2);
      t.require(terms.length > 0, `archived story ${old.id} has no searchable word in its title`);
      const found = t.success(await t.get(`/api/news-archive?limit=200&q=${encodeURIComponent(terms.join(" "))}`, { auth: true }));
      t.ok(found.stories.some((s) => s.id === old.id), `searching the archive for words from a story's own title does not find it`);
      t.ok(found.total <= list.total, "a search returned more stories than the whole archive");

      const missing = await t.get("/api/news-archive/story", { auth: true });
      t.equal(missing.status, 400, `an archive lookup with no id should be 400 (${missing.describe()})`);
      const unknown = await t.get("/api/news-archive/story?id=e2e-no-such-story-0000", { auth: true });
      t.equal(unknown.status, 404, `an unknown archived story should be 404 (${unknown.describe()})`);

      t.observe("archive keys", keysOf(list));
      t.observe("archive entry keys", keysOf(list.stories[0]));
      t.observe("archived stories", list.total, "min");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.agent-alive-queue-readable",
    title: "The news agent is running, its editorial queue is readable with the token (and refused without it), and today's scan ran — the site's news status agrees with it",
    covers: ["ext:news GET /health", "ext:news GET /api/health", "ext:news GET /api/editorial-queue", "GET /api/system-status"],
    modes: ["dev", "prod"],
    incident: "2026-10: the news agent was stopped on the dev box (72 restarts) and nothing said so",
    run: async (t) => {
      const h = t.success(await t.get("/health", { service: "news" }), "ok");
      t.equal(h.service, "stillafloat-newsagent", "news agent health: service name");
      const h2 = t.success(await t.get("/api/health", { service: "news" }), "ok");
      t.fresh(h2.time, 0.1, "the news agent's own clock (api/health time)");

      const anon = await t.get("/api/editorial-queue", { service: "news" });
      t.equal(anon.status, 401, `the editorial queue must refuse a request with no token (${anon.describe()})`);
      const wrong = await t.get("/api/editorial-queue", { service: "news", headers: { "x-affiliate-token": "e2e-wrong-token" } });
      t.equal(wrong.status, 401, `the editorial queue must refuse a wrong token (${wrong.describe()})`);

      const q = t.success(await t.get("/api/editorial-queue", { service: "news", auth: true }));
      t.ok(Array.isArray(q.stories), "the editorial queue has no stories array");
      t.equal(q.count, q.stories.length, "editorial queue count");
      t.equal(q.degradedMode, false, "the news scan is in degraded mode (it ran without the AI editor)");
      // the scan runs every morning; it replaces the queue each time
      t.fresh(q.generatedAt, 36, "the editorial queue (the daily news scan)");
      for (const s of q.stories) {
        t.fields(s, ["id", "title", "summary", "link", "category"], `queued story ${s.id}`);
        t.ok(s.title_es && s.summary_es, `queued story ${s.id} has no Spanish translation — approving it would publish an English-only story`);
      }

      // two views of the same data: the site's news status reads the same collections
      const st = t.success(await t.get("/api/system-status"));
      t.fields(st, ["publishing.candidateStories", "publishing.approvedStories", "publishing.homepageStories", "systems.anthropicConfigured"], "site news status");
      t.equal(st.publishing.candidateStories, q.count, "stories awaiting review: the site's status vs the agent's queue");
      t.equal(st.pipeline?.degradedMode, false, "the site's news status reports a degraded scan");
      t.equal(st.systems.anthropicConfigured, true, "the site says the AI editor is not configured");
      const feed = await loadFeed(t, "en");
      t.atLeast(st.publishing.approvedStories, feed.stories.length, "approved stories (status) vs stories in the feed");
      const home = t.success(await t.get("/api/homepage-feed"));
      t.equal(st.publishing.homepageStories, home.stories.length, "homepage stories: the site's status vs the homepage feed");

      t.observe("queue keys", keysOf(q));
      t.observe("system-status keys", keysOf(st));
      t.observe("system-status systems", keysOf(st.systems));
      t.observe("stories awaiting review", q.count, "info");
      t.observe("site environment", st.environment, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.agent-reachable-through-site",
    title: "The editorial review page and queue that Mark's notification links open are routed from the website to the news agent",
    covers: ["ext:news GET /review", "ext:news GET /api/editorial-queue"],
    modes: ["dev", "prod"],
    incident: "2026-10 (dev): nginx did not route /review or /api/editorial-queue to the agent — /review was 404 and the queue answered the homepage HTML with HTTP 200",
    run: async (t) => {
      // the website's own address first: on a box whose nginx does not route to the agent this is
      // where it shows (the site answered its homepage HTML with HTTP 200 on dev, 2026-10)
      const q = await t.get("/api/editorial-queue");
      t.equal(q.status, 401, `the website's /api/editorial-queue should reach the agent and refuse a request with no token (${q.describe()}${q.json ? "" : ", not JSON — the request never reached the agent"})`);
      t.equal(q.json?.success, false, "the website's /api/editorial-queue did not answer as the agent does (expected a JSON refusal)");
      const qa = t.success(await t.get("/api/editorial-queue", { auth: true }));
      t.ok(Array.isArray(qa.stories), "the editorial queue (through the website) has no stories array");
      t.fresh(qa.generatedAt, 36, "the editorial queue through the website");
      const viaSite = t.html(await t.get("/review"), { mustContain: ["/api/editorial-queue", "/api/agent-action"] });
      const direct = t.html(await t.get("/review", { service: "news" }), { mustContain: ["/api/editorial-queue", "/api/agent-action"] });
      t.ok(/noindex/i.test(H.metaContent(direct, "robots")), "the editorial review page is not marked noindex");
      t.equal(H.title(viaSite), H.title(direct), "the website's /review is not the news agent's review page");
      t.observe("review page title", H.title(direct));
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.editorial-queue-page-shows-queue",
    title: "The website's /editorial-queue.html page can actually show the stories awaiting review",
    covers: ["page /editorial-queue.html"],
    modes: ["dev", "prod"],
    incident: "found 2026-10-08: the page fetches /api/editorial-queue with no token; the agent requires one, so the page can only ever say 'Editorial queue currently unavailable'",
    run: async (t) => {
      const html = t.html(await t.get("/editorial-queue.html"), { mustContain: ["/api/editorial-queue"] });
      t.equal(H.htmlLang(html).slice(0, 2), "en", "/editorial-queue.html language");
      // what the page's own request gets (it sends no token unless the page code adds one)
      const sendsToken = /x-affiliate-token|Authorization|[?&]token=/.test(html);
      const r = await t.get("/api/editorial-queue");
      const pageCanLoad = sendsToken || (r.status === 200 && r.json?.success === true && Array.isArray(r.json?.stories));
      t.ok(pageCanLoad, `/editorial-queue.html asks for the queue without a token and gets ${r.describe()} — the page can only ever show "Editorial queue currently unavailable". Retire it (the real review page is /review) or send the token`);
      const q = t.success(await t.get("/api/editorial-queue", { auth: true }));
      t.ok(Array.isArray(q.stories), "the editorial queue has no stories array");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.translations",
    title: "Spanish story translations are served from storage (no paid re-translation), and the article translator refuses bad requests",
    covers: ["GET /api/translate-story", "GET /api/translate-article", "page /es/translate-loading.html"],
    modes: ["dev", "prod"],
    incident: "risk: translate-story re-translating (a paid model call plus a rewrite of the approved-stories record) on every Spanish story view",
    run: async (t) => {
      // refusal paths — answered before any model call, fetch or write
      const noId = await t.get("/api/translate-story");
      t.equal(noId.status, 400, `translate-story with no id should be 400 (${noId.describe()})`);
      const unknown = await t.get("/api/translate-story?id=e2e-no-such-story-0000");
      t.equal(unknown.status, 404, `translate-story for an unknown story should be 404 (${unknown.describe()})`);
      const noUrl = await t.get("/api/translate-article");
      t.equal(noUrl.status, 400, `translate-article with no url should be 400 (${noUrl.describe()})`);
      const badUrl = await t.get("/api/translate-article?url=e2e-not-a-url");
      t.equal(badUrl.status, 400, `translate-article with an invalid url should be 400 (${badUrl.describe()})`);

      // the stored-translation path, ONLY for stories whose feed record already has Spanish text
      const feed = await loadFeed(t, "en");
      const translated = feed.stories.filter((s) => s.title_es && s.summary_es);
      t.require(translated.length > 0, "no story in the feed has a stored Spanish translation, so the cached path cannot be tested without a paid model call");
      for (const s of spread(translated, 2)) {
        const r = t.success(await t.get(`/api/translate-story?id=${encodeURIComponent(s.id)}`));
        t.equal(r.translated, false, `translate-story re-translated ${s.id} instead of serving the stored Spanish text (a paid model call)`);
        t.equal(r.title_es, s.title_es, `stored Spanish title of ${s.id}`);
        t.equal(r.summary_es, s.summary_es, `stored Spanish summary of ${s.id}`);
        t.equal(r.travelerImpact_es ?? null, s.travelerImpact_es ?? null, `stored Spanish "what this means for you" of ${s.id}`);
        t.equal(r.editorialReasoning_es ?? null, s.editorialReasoning_es ?? null, `stored Spanish take of ${s.id}`);
      }

      const page = t.html(await t.get("/es/translate-loading.html"), { mustContain: ["/api/translate-article"] });
      t.equal(H.htmlLang(page).slice(0, 2), "es", "/es/translate-loading.html language");
      t.observe("translate-loading title", H.title(page));
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.manifest-and-weather-scaffold",
    title: "The platform manifest lists working news endpoints, and the weather-alerts stub still answers",
    // covers only what this check judges: the manifest and the weather stub. The feeds it follows are
    // only proven to answer here; their content is judged by news.feeds-agree / news.agent-alive-queue-readable.
    covers: ["GET /api/platform-manifest", "GET /api/weather-alerts"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const m = t.success(await t.get("/api/platform-manifest"));
      t.fields(m, ["endpoints.health", "endpoints.systemStatus", "endpoints.homepageFeed", "endpoints.newsFeed", "endpoints.storyDetails", "endpoints.alertsFeed", "endpoints.weatherAlerts", "endpoints.scanNews", "endpoints.editorialActions"], "platform manifest");
      for (const [k, u] of Object.entries(m.endpoints)) t.ok(H.sameSite(u, t.bases.site), `manifest endpoint ${k} points off-site: ${u}`);
      t.equal(new URL(m.endpoints.scanNews).pathname, "/api/scan-news", "manifest scan endpoint");
      t.equal(new URL(m.endpoints.editorialActions).pathname, "/api/agent-action", "manifest editorial-action endpoint");
      // follow the read-only ones (never scan-news / agent-action / affiliate-items)
      for (const k of ["health", "systemStatus", "homepageFeed", "newsFeed", "storyDetails", "alertsFeed", "weatherAlerts"]) {
        const r = await t.get(H.onBase(m.endpoints[k], t.bases.site));
        if (k === "health") { t.equal(t.json(r).status, "ok", "the manifest's health endpoint"); continue; }
        t.success(r);
      }
      const w = t.success(await t.get("/api/weather-alerts"));
      t.equal(w.monitoringEnabled, true, "weather-alerts monitoring flag");
      t.atLeast(Array.isArray(w.monitoredPorts) ? w.monitoredPorts.length : 0, 5, "monitored home ports in weather-alerts");
      t.fresh(w.generatedAt, 1, "weather-alerts generatedAt");
      t.observe("manifest endpoints", keysOf(m.endpoints));
      t.observe("manifest capabilities", keysOf(m.capabilities));
      t.observe("weather-alerts ports", (w.monitoredPorts || []).join(","));
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "news.agent-actions-refuse-without-token",
    title: "The news agent refuses approve/reject actions, manual scans and archive sweeps without the token (refusals only — the actions themselves are not run)",
    covers: ["ext:news GET /api/agent-action", "ext:news POST /api/scan-news", "ext:news POST /api/archive-sweep"],
    modes: ["dev"],
    devOnlyBecause: "GET /api/agent-action approves or rejects stories and must never be called on prod; the POSTs are writes (and scan-news makes paid model calls and emails Mark when it runs)",
    run: async (t) => {
      // SAFETY: prove the agent enforces its token first. If it were open (no AGENT_APPROVAL_TOKEN),
      // an unauthenticated POST /api/scan-news would RUN a paid scan and email Mark — so stop here.
      const gate = await t.get("/api/editorial-queue", { service: "news" });
      t.equal(gate.status, 401, `the news agent does not enforce its token (${gate.describe()}) — refusing to probe its write routes`);
      const act = await t.get("/api/agent-action?action=approve&id=e2e-fixture-none", { service: "news" });
      t.equal(act.status, 401, `an approve action with no token must be refused (${act.describe()})`);
      const actWrong = await t.get("/api/agent-action?action=approve&id=e2e-fixture-none", { service: "news", headers: { "x-affiliate-token": "e2e-wrong-token" } });
      t.equal(actWrong.status, 401, `an approve action with a wrong token must be refused (${actWrong.describe()})`);
      const scan = await t.send("POST", "/api/scan-news", { service: "news", body: {} });
      t.equal(scan.status, 401, `a manual news scan with no token must be refused (${scan.describe()})`);
      const sweep = await t.send("POST", "/api/archive-sweep", { service: "news", body: {} });
      t.equal(sweep.status, 401, `an archive sweep with no token must be refused (${sweep.describe()})`);
    },
  },
];
