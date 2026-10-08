// e2e/checks/commentary.mjs — Mark's Commentary (EN + ES), the homepage YouTube rows, the
// dashboard's YouTube cockpit, and Mark's Favorites page.
//
// Incidents and risks these checks exist for:
//   2026-09-05  A commentary published with NO Spanish twin (no body_es, no title_es) while the
//               translation key was dead. The Spanish post page silently falls back to the
//               English body, so a Spanish reader sees English and nobody is told. Every
//               published post must carry its own Spanish title and body.
//   2026-09-04  The review page's buttons "did nothing" (suppressed browser dialogs) — the
//               review page and the draft it shows are checked together, against the public list.
//   2026-09-09  The dashboard's "record your take" button answered 501 for days after the
//               OpenAI Whisper key died; it now hops to Whisper on our own box, so the hop is
//               exercised end to end on dev with a silent clip (no vendor, no cost).
//   (risk)      The homepage video rows are built from a cache the six-hourly YouTube scan
//               writes. If the scan stops, the rows freeze and nothing errors — so the cache is
//               checked against YouTube's live numbers (the dashboard cockpit, Data API).
//   (risk)      The dashboard's "Feature on Homepage" button writes a pick the homepage no
//               longer reads (since 7e4fd05, 2026-06-18, the homepage shows top-by-views rows) —
//               but the NEWSLETTER does read it, in BOTH editions, ignoring language (the
//               2026-07-09 EN issue featured a Spanish video for exactly that reason).
//   (risk)      Favorites is linked from the navbar in BOTH languages; an empty store shows two
//               "Coming soon" boxes to every visitor.
//   (review 2026-10-08) Adversarial review added: list-vs-detail for the Spanish fields, the ES
//               list page reading title_es/body_es, the navbar/language-switcher/sitemap links
//               to Commentary, a post's embedded video still existing, the review page's
//               buttons pointing at real routes, the Tuesday writer's draft age, the homepage
//               rows' containers and the fields the page reads, most-watched ordering, the
//               newsletter's use of the pick, and favorites ordering/section filtering WITH
//               data present (both boxes hold 0 favorites, so those asserts never ran).
//
// SAFETY (read before adding requests):
//   • GET /api/youtube-scan is NEVER called: it is an unauthenticated GET that rewrites the
//     video cache and spends YouTube Data API quota. It is an admitted gap (coverage/commentary.json).
//   • POST /api/commentary, /commentary/publish-draft, /commentary/draft, /commentary/reject,
//     /commentary/synthesize (with a take) and /translate-commentary call a paid model
//     (translation / writing). Only their refusal paths are exercised, on dev. The no-token
//     probes send bodies the route would ALSO refuse (400/404) wherever one exists, and run
//     those first: if the shared token guard ever broke, a harmless probe fails the check
//     before any probe that could start a paid run is sent.
//   • GET /api/newsletter/draft (token) only reads the saved draft; nothing from it but the
//     featured video's id and title-language is used, and nothing from it is recorded.
//   • /commentary/draft/discard and /youtube-feature (with a videoId) change real rows with no
//     undo — refusal paths only.
//   • Favorites writes ARE exercised on dev, with a row titled "e2e-fixture …" that is deleted
//     in a finally block. Dev and prod use separate databases.
//   • GET /api/youtube-stats (token) makes three free YouTube Data API reads and is cached
//     15 minutes server-side — the same call the dashboard overview makes on every load.
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

const NO_SUCH_ID = "00000000-0000-4000-8000-000000000000";
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
// The server's own rule for "this title is Spanish" (routes/youtube.ts, /api/youtube-top).
const SPANISH_TITLE = /[¡¿áéíóúüñ]/i;
// A Spanish body: accented letters or common Spanish function words.
const SPANISH_BODY = /[áéíóúñ¿¡]|\b(que|los|las|del|para|una|por)\b/i;
const stripHtml = (s) => String(s ?? "").replace(/<[^>]*>/g, "");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const day = 86_400_000;
const ytIdOf = (url) => /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(String(url || ""))?.[1] || null;

/** The site navbar (every page loads it): the menu entries and the language switcher's ES twins. */
async function navbar(t) {
  const nav = await t.get("/components/navbar.js");
  t.status(nav, 200);
  t.ok(nav.text.length > 500 && /label:/.test(nav.text), "the navbar script is missing or empty");
  const link = (label) => new RegExp(`href:\\s*'([^']+)',\\s*label:\\s*'${label}'`).exec(nav.text)?.[1] || null;
  const esPages = /ES_PAGES\s*=\s*new Set\(\[([^\]]*)\]/.exec(nav.text)?.[1] || "";
  // ES_PAGES holds root-relative paths since 2026-10-08 (bare filenames before); accept either spelling
  return { text: nav.text, link, esTwin: (file) => esPages.includes(`'/${file}'`) || esPages.includes(`'${file}'`) };
}

/** The public commentary list, with the shape every page relies on. */
async function publicPosts(t) {
  const body = t.success(await t.get("/api/commentary"));
  t.ok(Array.isArray(body.posts), "the commentary list has no posts array");
  t.nonEmpty(body.posts, "the public commentary list");
  t.equal(body.count, body.posts.length, "the commentary list's count vs its posts");
  return body.posts;
}

/** Spread sample: first, middle, last (a few dozen requests at most, never the whole list). */
const spread = (list) => [...new Set([0, Math.floor((list.length - 1) / 2), list.length - 1])].map((i) => list[i]);

/** The four homepage rows, exactly as index.html / es/index.html ask for them. */
const HOME_ROWS = [
  { lang: "en", type: "long", limit: 4, page: "/index.html" },
  { lang: "en", type: "short", limit: 6, page: "/index.html" },
  { lang: "es", type: "long", limit: 4, page: "/es/index.html" },
  { lang: "es", type: "short", limit: 6, page: "/es/index.html" },
];
const rowUrl = (r, limit = r.limit) => `/api/youtube-top?limit=${limit}&lang=${r.lang}&type=${r.type}`;

function checkVideoRow(t, body, r, what) {
  t.ok(body && Array.isArray(body.videos), `${what}: no videos array`);
  t.equal(body.lang, r.lang, `${what}: language of the answer`);
  t.matches(body.channelUrl, /^https:\/\/www\.youtube\.com\/@StillAfloat/i, `${what}: channel link`);
  t.nonEmpty(body.videos, what);
  for (const v of body.videos) {
    t.matches(v.id, YT_ID, `${what}: a video id`);
    t.matches(v.thumbnail, new RegExp(`^https://(i\\.ytimg\\.com|img\\.youtube\\.com)/vi/${v.id.replace(/-/g, "\\-")}/`), `${what}: thumbnail of ${v.id}`);
    t.equal(v.url, `https://www.youtube.com/watch?v=${v.id}`, `${what}: link of ${v.id}`);
    t.ok(typeof v.views === "number" && v.views >= 0, `${what}: ${v.id} has no view count`);
    t.nonEmpty(v.title, `${what}: title of ${v.id}`);
    if (r.lang === "es") t.ok(SPANISH_TITLE.test(v.title), `${what}: ${v.id} is in the Spanish row but its title does not read as Spanish`);
    else t.ok(!SPANISH_TITLE.test(v.title), `${what}: ${v.id} is in the English row but its title reads as Spanish`);
    if (r.type === "long") t.ok(!/#shorts/i.test(v.title), `${what}: ${v.id} is a Short (#shorts) sitting in the Episodes row`);
  }
  t.equal(body.videos.filter((v) => v.isLatest).length, 1, `${what}: number of videos marked "latest"`);
  t.ok(body.videos[0].isLatest === true, `${what}: the newest upload is not in the first slot`);
  t.equal(new Set(body.videos.map((v) => v.id)).size, body.videos.length, `${what}: the same video appears twice`);
}

export default [
  // ── Commentary: public list, post pages, EN + ES ─────────────────────────────────────
  {
    id: "commentary.published-list-and-posts",
    title: "The Commentary page lists Mark's published pieces, and each piece opens on its own page in English and Spanish",
    covers: ["GET /api/commentary", "page /commentary.html", "page /es/commentary.html", "page /commentary-post.html", "page /es/commentary-post.html"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const posts = await publicPosts(t);
      for (const p of posts) {
        t.fields(p, ["id", "title", "body_en", "published_at", "updated_at", "status"], `commentary post ${p.id}`);
        t.equal(p.status, "published", `post ${p.id} on the public list: status`);
        t.ok(Array.isArray(p.tags), `post ${p.id}: tags list is missing`);
        t.ok(Number.isFinite(Date.parse(p.published_at)), `post ${p.id}: unreadable publish date`);
        t.ok(stripHtml(p.body_en).trim().length >= 300, `post ${p.id}: the English body is only ${stripHtml(p.body_en).trim().length} characters — not a real piece`);
        if (p.videoUrl) t.matches(p.videoUrl, /(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)[A-Za-z0-9_-]{11}/, `post ${p.id}: video link (the page could not embed it)`);
        if (p.imageUrl) t.matches(p.imageUrl, /^(https:\/\/|\/(?!\/))/, `post ${p.id}: image link (the card would show a broken image)`);
      }
      // A post's embedded video must still exist on YouTube: the list card shows YouTube's own
      // thumbnail for it, and YouTube answers 404 for a deleted/private video. One sample.
      const withVideo = posts.find((p) => ytIdOf(p.videoUrl));
      if (withVideo) {
        const img = await t.get(`https://img.youtube.com/vi/${ytIdOf(withVideo.videoUrl)}/mqdefault.jpg`);
        t.ok(img.status === 200 && /^image\//.test(img.headers.get("content-type") || ""), `post ${withVideo.id}: its YouTube video is gone (thumbnail ${img.status}) — the post page would embed a dead video`);
      }
      for (let i = 1; i < posts.length; i++) {
        t.ok(Date.parse(posts[i - 1].published_at) >= Date.parse(posts[i].published_at), `the list is not newest-first at position ${i}`);
      }

      // list vs single-post lookup (what the post page reads) — a spread, not every post
      for (const p of spread(posts)) {
        const one = t.success(await t.get(`/api/commentary?id=${encodeURIComponent(p.id)}`));
        t.fields(one.post, ["id", "title", "body_en"], `post ${p.id} looked up alone`);
        t.equal(one.post.id, p.id, `post ${p.id}: id of the single lookup`);
        t.equal(one.post.title, p.title, `post ${p.id}: the list and the post page disagree on the title`);
        t.equal(one.post.body_en, p.body_en, `post ${p.id}: the list and the post page disagree on the body`);
        // the Spanish post page reads the same lookup — a lookup that drops the Spanish
        // fields shows Spanish readers English while the Spanish list still looks right
        t.equal(one.post.title_es ?? null, p.title_es ?? null, `post ${p.id}: the list and the Spanish post page disagree on the Spanish title`);
        t.equal(one.post.body_es ?? null, p.body_es ?? null, `post ${p.id}: the list and the Spanish post page disagree on the Spanish text`);
      }
      const gone = await t.get(`/api/commentary?id=${NO_SUCH_ID}`);
      t.ok(gone.status === 404 && gone.json?.success === false, `an unknown post id should be a clean 404: ${gone.describe()}`);

      // the pages that render it
      for (const [p, lang, postPage] of [["/commentary.html", "en", "/commentary-post.html"], ["/es/commentary.html", "es", "/es/commentary-post.html"]]) {
        const html = t.html(await t.get(p), { mustContain: ["/api/commentary?status=published", `href="${postPage}?id=`, "posts-container", "components/navbar.js"] });
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        t.ok(H.canonical(html).endsWith(p), `${p} canonical link points elsewhere ("${H.canonical(html)}")`);
        if (lang === "es") t.ok(/post\.title_es/.test(html) && /post\.body_es/.test(html), `${p} no longer reads the Spanish title/text — the Spanish list would show English cards`);
        else t.ok(/post\.body_en/.test(html), `${p} no longer reads the English text for its cards`);
        t.observe(`${p} title`, H.title(html));
      }
      const first = posts[0];
      for (const [p, lang] of [["/commentary-post.html", "en"], ["/es/commentary-post.html", "es"]]) {
        const html = t.html(await t.get(`${p}?id=${encodeURIComponent(first.id)}`), { mustContain: ["/api/commentary?id=", "components/navbar.js"] });
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        if (lang === "es") t.ok(/post\.body_es/.test(html) && /post\.title_es/.test(html), `${p} no longer reads the Spanish title/body — Spanish readers would get English`);
        else t.ok(/post\.body_en/.test(html), `${p} no longer reads the English body`);
      }

      // how visitors reach it: the menu in both languages, the language switcher, the sitemap
      const nav = await navbar(t);
      t.equal(nav.link("Commentary"), "/commentary.html", "the English menu's Commentary link");
      t.equal(nav.link("Comentarios"), "/es/commentary.html", "the Spanish menu's Comentarios link");
      t.ok(nav.esTwin("commentary.html") && nav.esTwin("commentary-post.html"), "the language switcher no longer knows Commentary has a Spanish twin — it would send readers to the Spanish home page");
      const sm = await t.get("/sitemap.xml");
      t.status(sm, 200);
      for (const loc of ["/commentary.html</loc>", "/es/commentary.html</loc>"]) t.ok(sm.text.includes(loc), `the sitemap no longer lists ${loc.replace("</loc>", "")}`);

      t.observe("published posts", posts.length, "min");
      t.observe("post keys", keysOf(posts[0]), "info");
      t.observe("newest post date", first.published_at.slice(0, 10), "info");
    },
  },
  {
    id: "commentary.spanish-twin-complete",
    title: "Every published commentary has its own Spanish title and Spanish text (no Spanish reader is shown English)",
    covers: ["GET /api/commentary", "page /es/commentary-post.html"],
    modes: ["dev", "prod"],
    incident: "2026-09-05: a commentary published with no Spanish twin; /es/ showed the English body",
    run: async (t) => {
      const posts = await publicPosts(t);
      const missing = [];
      for (const p of posts) {
        const body = stripHtml(p.body_es || "").trim();
        const problems = [];
        if (!String(p.title_es || "").trim()) problems.push("no Spanish title");
        else if (p.title_es.trim().toLowerCase() === String(p.title).trim().toLowerCase()) problems.push("the Spanish title is the English title");
        if (!body) problems.push("no Spanish text");
        else if (p.body_es === p.body_en) problems.push("the Spanish text is the English text");
        else if (!SPANISH_BODY.test(body)) problems.push("the Spanish text does not read as Spanish");
        else if (body.length < stripHtml(p.body_en).trim().length * 0.6) problems.push(`the Spanish text is ${body.length} characters against ${stripHtml(p.body_en).trim().length} in English (cut short)`);
        if (problems.length) missing.push(`post ${p.id} (published ${String(p.published_at).slice(0, 10)}): ${problems.join(", ")}`);
      }
      // the Spanish post page must exist for the newest one (it is what the ES list links to)
      t.html(await t.get(`/es/commentary-post.html?id=${encodeURIComponent(posts[0].id)}`), { mustContain: ["post.body_es"] });
      t.observe("posts missing a Spanish twin", missing.length, "info");
      t.ok(missing.length === 0, `${missing.length} of ${posts.length} published commentaries have no complete Spanish twin, so /es/ shows them in English: ${missing.join(" · ")}`);
    },
  },
  {
    id: "commentary.weekly-cadence",
    title: "A new commentary has been published within the last 15 days, and the Tuesday writer has staged a draft within the last 8 days (the weekly piece has not stopped)",
    covers: ["GET /api/commentary", "GET /api/commentary/draft", "job scheduleWeeklyMarketing"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const posts = await publicPosts(t);
      const newest = posts[0];
      const ageDays = (t.now() - Date.parse(newest.published_at)) / day;
      t.observe("days since the newest commentary", Math.round(ageDays), "info");
      // The Tuesday 09:00 (ET) tick of scheduleWeeklyMarketing always stages a fresh draft
      // (stageWeeklyCommentary overwrites, generatedAt = now), whatever Mark did with the last
      // one. A draft older than 8 days means the writer job has stopped — even if Mark happened
      // to publish something by hand recently. (Reviewer, 2026-10-08: the post date alone
      // could not see a dead writer while Mark kept posting.)
      const d = t.success(await t.get("/api/commentary/draft", { auth: true }));
      const genAgeDays = d.draft?.generatedAt ? (t.now() - Date.parse(d.draft.generatedAt)) / day : Infinity;
      t.observe("days since the commentary writer last staged a draft", Number.isFinite(genAgeDays) ? Math.round(genAgeDays) : -1, "info");
      if (t.mode === "dev") {
        // Dev has its own database and runs with DISABLE_WEEKLY_MARKETING=1, so the Tuesday writer
        // never runs there and dev cannot show the cadence. That makes the check UNTESTABLE on dev
        // (a real gap in the mirror), not a pass.
        t.require(ageDays <= 15 && genAgeDays <= 8, `dev's newest commentary is ${Math.round(ageDays)} days old and its draft was staged ${Number.isFinite(genAgeDays) ? Math.round(genAgeDays) : "never"} days ago: dev runs with the weekly writer switched off (DISABLE_WEEKLY_MARKETING=1), so the weekly cadence cannot be tested here`);
      }
      t.fresh(newest.published_at, 15 * 24, "the newest published commentary");
      t.ok(d.draft && d.draft.generatedAt, "there is no commentary draft at all — the Tuesday writer has never staged one on this box");
      t.fresh(d.draft.generatedAt, 8 * 24, "the commentary writer's latest draft (staged every Tuesday)");
    },
  },

  // ── Commentary: Mark's gated views (GET only) ────────────────────────────────────────
  {
    id: "commentary.review-and-draft-views",
    title: "Mark's commentary review page and draft status refuse strangers, and with the token show the same draft the public list agrees with",
    covers: ["GET /api/commentary/draft", "GET /api/commentary/review", "GET /api/commentary"],
    modes: ["dev", "prod"],
    run: async (t) => {
      // refusals: no token → 401, never the draft
      const noDraft = await t.get("/api/commentary/draft");
      t.ok(noDraft.status === 401 && !/suggestedTitle|draftHtml/.test(noDraft.text), `the draft status answered a stranger: ${noDraft.describe()}`);
      const noReview = await t.get("/api/commentary/review");
      t.ok(noReview.status === 401 && !/Weekly Commentary/.test(noReview.text), `the review page opened for a stranger: ${noReview.describe()}`);

      const d = t.success(await t.get("/api/commentary/draft", { auth: true }));
      t.ok(typeof d.busy === "boolean", "the draft status has no busy flag (the review page polls it)");
      t.ok(!d.lastError, `the last commentary run failed: "${String(d.lastError || "").slice(0, 160)}"`);
      t.require(d.draft && Array.isArray(d.draft.stories), "there is no commentary draft on this box at all, so the review page's draft path cannot be tested — stage one");
      const draft = d.draft;
      t.fields(draft, ["status", "suggestedTitle"], "the commentary draft");
      t.ok(["awaiting_take", "drafted", "published", "discarded"].includes(draft.status), `the draft has an unknown status "${draft.status}"`);
      t.nonEmpty(draft.stories, "the draft's subject story");
      t.fields(draft.stories[0], ["title"], "the draft's subject story");

      // Every button on the review page posts to a route; a renamed route leaves a button that
      // "does nothing" (2026-09-04). The page carries all of them in its script, whatever the state.
      const html = t.html(await t.get("/api/commentary/review", { auth: true }), {
        mustContain: ["Weekly Commentary", "/api/commentary/draft", "/api/commentary/synthesize", "/api/commentary/reject", "/api/commentary/publish-draft", "/api/commentary/draft/discard"],
      });
      const active = draft.status === "awaiting_take" || draft.status === "drafted";
      if (active) {
        t.ok(html.includes(esc(draft.stories[0].title)), "the review page does not show the draft's subject story");
        if (draft.status === "drafted") {
          t.ok(html.includes(esc(draft.suggestedTitle)), "the review page does not show the written piece's title");
          t.ok(html.includes("/api/commentary/publish-draft"), "the review page has no Approve (publish) action");
        }
      } else {
        t.ok(html.includes("No commentary in progress"), `the draft is "${draft.status}" but the review page does not say nothing is in progress`);
      }

      // two views of the posts: Mark's full list vs the public list
      const all = t.success(await t.get("/api/commentary?status=all", { auth: true }));
      t.ok(Array.isArray(all.posts), "Mark's full commentary list has no posts array");
      const pub = await publicPosts(t);
      const pubIds = new Set(pub.map((p) => p.id));
      const published = all.posts.filter((p) => p.status === "published");
      t.equal(published.length, pub.length, "published posts in Mark's list vs the public list");
      for (const p of published) t.ok(pubIds.has(p.id), `post ${p.id} is published in Mark's list but missing from the public list`);
      const hidden = all.posts.filter((p) => p.status !== "published");
      for (const p of hidden) t.ok(!pubIds.has(p.id), `post ${p.id} is unpublished but on the public list`);
      for (const p of hidden.slice(0, 2)) {
        const r = await t.get(`/api/commentary?id=${encodeURIComponent(p.id)}`);
        t.ok(r.status === 404, `unpublished post ${p.id} can be read by a stranger: ${r.describe()}`);
      }
      // the approved draft is the piece on the site
      if (draft.status === "published") {
        t.ok(pub.some((p) => p.title === stripHtml(draft.suggestedTitle)), "the draft says it was published, but no public commentary carries its title");
      }
      t.observe("draft status", draft.status, "info");
      t.observe("unpublished posts", hidden.length, "info");
      t.observe("draft status keys", keysOf(d), "info");
    },
  },

  // ── Commentary and YouTube writes: refusal paths only (each would call a paid model or
  //    change a real row with no undo) ─────────────────────────────────────────────────────
  {
    id: "commentary.write-routes-refuse",
    title: "The commentary and video-pin buttons refuse anyone without Mark's token, and refuse empty requests (refusal paths only)",
    covers: [
      "POST /api/commentary", "PATCH /api/commentary/:id", "DELETE /api/commentary/:id", "POST /api/translate-commentary",
      "POST /api/commentary/draft", "POST /api/commentary/reject", "POST /api/commentary/synthesize",
      "POST /api/commentary/publish-draft", "POST /api/commentary/draft/discard", "POST /api/youtube-feature",
    ],
    modes: ["dev"],
    devOnlyBecause: "it sends POST/PATCH/DELETE requests, which a prod sweep may never send",
    run: async (t) => {
      // Order and bodies are a safety measure (reviewer, 2026-10-08). The first six probes carry
      // bodies their route would refuse anyway (no body_en / unknown id / no text / empty take /
      // no videoId), so if a token guard ever broke they answer 400/404 — the check fails right
      // there and changes nothing. Every commentary route shares one checkToken(), so a broken
      // shared guard stops the run before the last four, which have no harmless body (they
      // start a paid run or move the real draft if their own guard line were deleted).
      const stranger = [
        ["POST", "/api/commentary", { title: "e2e-fixture" }],
        ["PATCH", `/api/commentary/${NO_SUCH_ID}`, { title: "e2e-fixture" }],
        ["DELETE", `/api/commentary/${NO_SUCH_ID}`, undefined],
        ["POST", "/api/translate-commentary", {}],
        ["POST", "/api/commentary/synthesize", { take: "" }],
        ["POST", "/api/youtube-feature", {}],
        ["POST", "/api/commentary/draft", { notify: false }],
        ["POST", "/api/commentary/reject", { reason: "e2e-fixture" }],
        ["POST", "/api/commentary/publish-draft", {}],
        ["POST", "/api/commentary/draft/discard", {}],
      ];
      for (const [m, p, body] of stranger) {
        const r = await t.send(m, p, { body });
        t.ok(r.status === 401 && r.json?.success === false, `${m} ${p} without the token should be refused with 401: ${r.describe()}`);
      }
      // a WRONG token is refused too (both guards: commentary's checkToken and the shared tokenOk)
      for (const p of ["/api/commentary", "/api/youtube-feature"]) {
        const r = await t.send("POST", p, { body: {}, headers: { "x-affiliate-token": "e2e-fixture-wrong-token" } });
        t.ok(r.status === 401 && r.json?.success === false, `POST ${p} with a wrong token should be refused with 401: ${r.describe()}`);
      }
      // with the token: only requests that stop before any model call or write
      const withToken = [
        ["POST", "/api/commentary", { title: "e2e-fixture" }, 400, "a post with no English body"],
        ["PATCH", `/api/commentary/${NO_SUCH_ID}`, { title: "e2e-fixture" }, 404, "an edit to a post that does not exist"],
        ["DELETE", `/api/commentary/${NO_SUCH_ID}`, undefined, 404, "deleting a post that does not exist"],
        ["POST", "/api/translate-commentary", {}, 400, "a translation with no text"],
        ["POST", "/api/commentary/synthesize", { take: "" }, 400, "a rewrite with no take"],
        ["POST", "/api/youtube-feature", {}, 400, "a pin with no video"],
      ];
      for (const [m, p, body, want, what] of withToken) {
        const r = await t.send(m, p, { body, auth: true });
        t.ok(r.status === want && r.json?.success === false && typeof r.json?.error === "string", `${what} (${m} ${p}) should be refused with ${want}: ${r.describe()}`);
      }
    },
  },
  {
    id: "commentary.voice-note-transcription",
    title: "The dashboard's \"record your take\" button reaches Whisper on our own box and answers (tested with a 2-second silent clip)",
    covers: ["POST /api/transcribe", "flow:commentary-voice-note-transcription"],
    modes: ["dev"],
    devOnlyBecause: "it sends a POST (and runs Whisper on the box's CPU for ~2 seconds), which a prod sweep may never do",
    incident: "2026-09-05 → 09-09: the transcribe button answered 501 for days after the vendor key died",
    timeoutMs: 150_000,
    run: async (t) => {
      const r401 = await t.send("POST", "/api/transcribe", { body: { audioBase64: "AAAA" } });
      t.ok(r401.status === 401, `transcription without the token should be refused: ${r401.describe()}`);
      const r400 = await t.send("POST", "/api/transcribe", { body: {}, auth: true });
      t.ok(r400.status === 400 && r400.json?.success === false, `transcription with no audio should be a 400: ${r400.describe()}`);

      // 2 s of 16 kHz mono silence as a WAV. Whisper (VAD on) hears nothing → 422 "Nothing was
      // said", which proves the whole hop ran: site → ops manager → ffmpeg → Whisper → back.
      const sr = 16000; const data = Buffer.alloc(sr * 2 * 2);
      const hdr = Buffer.alloc(44);
      hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write("WAVE", 8); hdr.write("fmt ", 12);
      hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(sr, 24);
      hdr.writeUInt32LE(sr * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(data.length, 40);
      const audioBase64 = Buffer.concat([hdr, data]).toString("base64");
      const r = await t.send("POST", "/api/transcribe", { body: { audioBase64, mimeType: "audio/wav", fileName: "e2e-fixture-silence.wav" }, auth: true, timeoutMs: 140_000 });
      const heardNothing = r.status === 422 && /Nothing was said/i.test(r.json?.error || "");
      const heardSomething = r.status === 200 && r.json?.success === true && typeof r.json?.transcript === "string";
      t.ok(heardNothing || heardSomething, `the transcription hop failed — Mark's "record your take" button would show an error: ${r.describe()}`);
      t.observe("silent clip answer", r.status, "exact");
    },
  },

  // ── YouTube: homepage rows, cockpit, featured pick ───────────────────────────────────
  {
    id: "commentary.youtube-home-rows",
    title: "The homepage Episodes and Shorts rows (English and Spanish) are full of real videos with working thumbnails",
    covers: ["GET /api/youtube-top", "page /index.html", "page /es/index.html"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const seen = { en: new Set(), es: new Set() };
      const rows = {};
      const channelOf = {};
      for (const r of HOME_ROWS) {
        const body = t.json(await t.get(rowUrl(r)));
        const what = `the ${r.lang === "es" ? "Spanish" : "English"} homepage ${r.type === "long" ? "Episodes" : "Shorts"} row`;
        checkVideoRow(t, body, r, what);
        t.equal(body.videos.length, r.limit, `${what}: videos shown (the row has ${r.limit} slots)`);
        for (const v of body.videos) {
          t.ok(!seen[r.lang].has(v.id), `${v.id} appears in both the Episodes and the Shorts row`);
          seen[r.lang].add(v.id);
        }
        rows[`${r.lang}-${r.type}`] = body.videos;
        channelOf[r.lang] = body.channelUrl;
        t.observe(`${r.lang} ${r.type} row size`, body.videos.length, "min");
      }
      // Episodes after the "latest" slot are most-watched first, and the counts are real
      // (the RSS fallback leaves every count at 0, which turns "most watched" into noise).
      for (const [k, vids] of Object.entries(rows)) {
        for (let i = 2; i < vids.length; i++) t.ok(vids[i - 1].views >= vids[i].views, `the ${k} row is not most-watched-first after the newest slot (position ${i})`);
      }
      t.ok(Object.values(rows).flat().some((v) => v.views > 0), "every homepage video shows 0 views — the view counts are not being refreshed");

      // the pages ask for exactly these rows, have the boxes they render into, and read the
      // fields the endpoint returns (a renamed container or field = an empty row, no error)
      for (const page of ["/index.html", "/es/index.html"]) {
        const html = t.html(await t.get(page), { mustContain: ['id="yt-top-grid"', 'id="yt-shorts-grid"', "getElementById('yt-shorts-grid')", "d.videos", "v.thumbnail", "v.isLatest"] });
        for (const r of HOME_ROWS.filter((x) => x.page === page)) {
          t.ok(html.includes(rowUrl(r)), `${page} no longer asks for ${rowUrl(r)} — that video row would be empty`);
        }
        // the "More on YouTube" button and the endpoint agree on the channel
        const lang = page.startsWith("/es/") ? "es" : "en";
        const chan = channelOf[lang];
        t.ok(chan && H.links(html).includes(chan), `${page}: the "More on YouTube" button does not open the channel the video rows come from (${chan})`);
      }
      // two thumbnails really load (YouTube's image CDN; a plain image GET)
      for (const v of [rows["en-long"][0], rows["es-short"][0]]) {
        const img = await t.get(v.thumbnail);
        t.status(img, 200);
        t.ok(/^image\//.test(img.headers.get("content-type") || ""), `thumbnail of ${v.id} is not an image (${img.headers.get("content-type")})`);
      }
      t.observe("en latest", rows["en-long"][0].id, "info");
      t.observe("es latest", rows["es-long"][0].id, "info");
    },
  },
  {
    id: "commentary.youtube-cache-matches-channel",
    title: "The homepage video rows match YouTube's live numbers (the six-hourly channel scan is still running), and the cockpit refuses strangers",
    covers: ["GET /api/youtube-stats", "GET /api/youtube-top", "job scheduleYouTubeScan"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const stranger = await t.get("/api/youtube-stats");
      t.ok(stranger.status === 401, `the YouTube cockpit answered a stranger: ${stranger.describe()}`);

      const s = t.success(await t.get("/api/youtube-stats", { auth: true }));
      t.fields(s, ["channel.title", "fetchedAt"], "the YouTube cockpit");
      t.matches(s.channel.title, /Still Afloat/i, "the channel the cockpit reads");
      t.ok(s.channel.subscribers >= 1 && s.channel.views >= 1000 && s.channel.videos >= 50, `the cockpit's channel numbers look empty (subscribers ${s.channel.subscribers}, views ${s.channel.views}, videos ${s.channel.videos})`);
      t.fresh(s.fetchedAt, 1, "the cockpit's YouTube numbers (cached 15 minutes)");
      t.ok(Array.isArray(s.topVideos), "the cockpit has no top-videos list");
      t.atLeast(s.topVideos.length, 5, "videos in the cockpit's most-watched list");
      t.observe("channel videos", s.channel.videos, "min");

      // Everything the homepage could show: the four language × kind pools, ten deep each.
      const cache = new Map();
      const pools = {};
      for (const r of HOME_ROWS) {
        const body = t.json(await t.get(rowUrl(r, 10)));
        t.ok(Array.isArray(body.videos), `youtube-top ${r.lang}/${r.type} has no videos array`);
        pools[`${r.lang}-${r.type}`] = body.videos;
        for (const v of body.videos) cache.set(v.id, v);
      }
      t.nonEmpty([...cache.keys()], "the site's cached video list");

      // YouTube's most-watched recent uploads (live, the cockpit's top 12 of the 50 newest) must
      // be in the site's cache. The scan refreshes every title and view count every six hours from
      // the same API; a missing video, an old view count or an old title means the scan has
      // stopped. Reviewer 2026-10-08: the first version looked at only the top 3, so a frozen
      // cache passed until one of the channel's three biggest videos changed; now every one of
      // the 12 is looked for — a video counts as missing only when the site's pool for its
      // language would have room for it (a pool of 10 whose 9 most-watched all out-view it hides
      // it legitimately; the kind is unknown, so either kind's full pool counts). Titles are
      // compared for the top 3 only: a title changed in the last six
      // hours trips this — re-run after the next scan before calling it a fault.
      const stale = [];
      const hiddenByRank = (live) => {
        const lang = SPANISH_TITLE.test(live.title) ? "es" : "en";
        // its kind (Episode or Short) is not in the cockpit's answer, so it is "hidden" when the
        // pool of EITHER kind in its language is full of videos that out-view it
        return ["long", "short"].some((type) => {
          const pool = pools[`${lang}-${type}`] || [];
          const ranked = pool.filter((v) => !v.isLatest);
          return pool.length >= 10 && ranked.length > 0 && Math.min(...ranked.map((v) => v.views)) >= live.views;
        });
      };
      s.topVideos.slice(0, 12).forEach((live, rank) => {
        const mine = cache.get(live.id);
        if (!mine) { if (!hiddenByRank(live)) stale.push(`${live.id} (${live.views} views on YouTube) is not in the site's video cache`); return; }
        if (rank < 3 && mine.title !== live.title) stale.push(`${live.id} carries an old title on the site`);
        if (live.views >= 200 && mine.views < live.views * (rank < 3 ? 0.8 : 0.7)) stale.push(`${live.id} shows ${mine.views} views on the site against ${live.views} on YouTube`);
      });
      t.ok(stale.length === 0, `the site's video cache is behind the channel — the YouTube scan has not refreshed it: ${stale.join(" · ")}`);
      t.observe("cockpit keys", keysOf(s), "exact");
    },
  },
  {
    id: "commentary.youtube-featured-pick",
    title: "The video Mark pins with \"Feature on Homepage\" is a real video, the homepage shows it, and the newsletter's featured video is in each edition's own language",
    covers: ["GET /api/youtube-featured", "GET /api/youtube-top", "GET /api/newsletter/draft", "page /index.html", "page /es/index.html"],
    modes: ["dev", "prod"],
    incident: "2026-07-09: the English newsletter featured a Spanish video (language-blind pick); since 7e4fd05 (2026-06-18) the homepage no longer reads the pick",
    run: async (t) => {
      const f = t.json(await t.get("/api/youtube-featured"));
      t.matches(f.videoId, YT_ID, "the featured video id");
      t.ok(f.videoId !== "qjzM4sm7cqA", "the featured video is the hard-coded fallback — the channel has never been scanned on this box");
      t.ok(String(f.thumbnail || "").includes(`/vi/${f.videoId}/`), "the featured video's thumbnail belongs to another video");
      t.nonEmpty(f.title, "the featured video's title");
      t.matches(f.channelUrl, /^https:\/\/www\.youtube\.com\/@StillAfloat/i, "the featured channel link");
      t.observe("featured video", f.videoId, "info");

      // Is it a manual pick? With no pick, /api/youtube-featured answers the newest upload, which
      // is the newest of the English and the Spanish "latest". Anything else is Mark's pin.
      const latest = {};
      for (const lang of ["en", "es"]) {
        const b = t.json(await t.get(`/api/youtube-top?limit=1&type=all&lang=${lang}`));
        t.ok(Array.isArray(b.videos) && b.videos[0]?.isLatest === true, `youtube-top (${lang}) has no newest video`);
        latest[lang] = b.videos[0].id;
      }
      const pinned = f.videoId !== latest.en && f.videoId !== latest.es;
      const pickLang = SPANISH_TITLE.test(f.title) ? "es" : "en";
      t.observe("featured video is a manual pick", pinned, "info");

      const problems = [];
      // Since 2026-10-08 the pick is language-aware: /api/youtube-featured?lang=es answers Mark's pin
      // only when the pin is a Spanish video, else the newest Spanish upload (same for en), and the
      // newsletter honours the pin only in its own edition. Each language's answer must be in that language.
      t.observe("featured pick is Mark's pin (manual)", Boolean(f.manual), "info");
      for (const lang of ["en", "es"]) {
        const fl = t.json(await t.get(`/api/youtube-featured?lang=${lang}`));
        t.matches(fl.videoId, YT_ID, `the ${lang} featured video id`);
        const isEs = SPANISH_TITLE.test(String(fl.title || ""));
        if (isEs !== (lang === "es")) problems.push(`the ${lang} featured video (${fl.videoId}, "${String(fl.title).slice(0, 50)}") is in the other language${fl.manual ? " — Mark's pin leaked into the wrong language" : ""}`);
        if (pinned && pickLang === lang) t.ok(fl.videoId === f.videoId && fl.manual === true, `the ${lang} featured video should be Mark's pin ${f.videoId}, got ${fl.videoId} (manual=${fl.manual})`);
      }
      // the saved drafts (the issue in review or the last one sent) — their video must match the edition
      let drafts = 0;
      for (const lang of ["en", "es"]) {
        const nd = t.success(await t.get(`/api/newsletter/draft?lang=${lang}`, { auth: true }));
        const v = nd.draft?.video;
        if (!nd.draft) continue;
        drafts++;
        if (!v) continue;
        t.matches(v.id, YT_ID, `the ${lang} newsletter's featured video id`);
        const isEs = SPANISH_TITLE.test(String(v.title || ""));
        if (isEs !== (lang === "es")) problems.push(`the saved ${lang.toUpperCase()} newsletter features video ${v.id}, whose title is in the other language`);
      }
      t.require(drafts > 0, "there is no saved newsletter draft in either language on this box, so the newsletter's use of the pick cannot be checked");

      // The dashboard button says "Feature on Homepage". Since 7e4fd05 the homepage shows the
      // top-by-views rows and nothing on it asks for the pick, so the button changes nothing a
      // visitor sees. Either the homepage reads the pick again, or the button is renamed.
      for (const page of ["/index.html", "/es/index.html"]) {
        const html = t.html(await t.get(page));
        let wired = /\/api\/youtube-featured/.test(html);
        const srcs = H.scripts(html).map((s) => H.resolve(s, t.url(page))).filter(Boolean).filter((u) => H.sameSite(u, t.bases.site)).slice(0, 6);
        for (const u of srcs) {
          if (wired) break;
          const js = await t.get(H.onBase(u, t.bases.site));
          t.status(js, 200);
          wired = /\/api\/youtube-featured/.test(js.text);
        }
        if (!wired) problems.push(`${page} never asks for the featured video, so the dashboard's "Feature on Homepage" pick (now ${f.videoId}) is not on the homepage`);
      }
      t.ok(problems.length === 0, problems.join(" · "));
    },
  },

  // ── Favorites ────────────────────────────────────────────────────────────────────────
  {
    id: "commentary.favorites-list",
    title: "Mark's Favorites page has YouTube channels and cruise websites to show (not two \"Coming soon\" boxes)",
    covers: ["GET /api/favorites", "page /favorites.html"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const html = t.html(await t.get("/favorites.html"), { mustContain: ["/api/favorites?category="] });
      t.equal(H.htmlLang(html).slice(0, 2), "en", "/favorites.html language");
      t.ok(html.includes("youtube-channels") && html.includes("cruise-websites"), "/favorites.html no longer loads both sections");
      t.observe("/favorites.html title", H.title(html));

      const all = t.success(await t.get("/api/favorites"));
      t.ok(Array.isArray(all.items), "the favorites list has no items array");
      t.equal(all.count, all.items.length, "the favorites count vs its items");
      t.observe("favorites", all.items.length, "min");
      const byCat = {};
      for (const cat of ["youtube-channels", "cruise-websites"]) {
        const one = t.success(await t.get(`/api/favorites?category=${cat}`));
        t.ok(Array.isArray(one.items), `favorites ${cat}: no items array`);
        t.ok(one.items.every((i) => i.category === cat), `favorites ${cat}: the filter returned items from another section`);
        byCat[cat] = one.items;
        t.observe(`favorites ${cat}`, one.items.length, "min");
      }
      const empty = Object.entries(byCat).filter(([, v]) => v.length === 0).map(([k]) => k);
      t.ok(empty.length === 0, `the Favorites page shows "Coming soon" instead of picks for: ${empty.join(", ")} (${all.items.length} favorites stored in total)`);
      t.equal(byCat["youtube-channels"].length + byCat["cruise-websites"].length, all.items.length, "favorites in the two sections vs all favorites (an item in an unknown section is never shown)");
      for (const i of all.items) {
        t.fields(i, ["id", "title", "url", "category"], `favorite ${i.id}`);
        t.matches(i.url, /^https:\/\//, `favorite ${i.id}: link`);
        if (i.imageUrl) t.matches(i.imageUrl, /^(https:\/\/|\/(?!\/))/, `favorite ${i.id}: image link`);
      }
      for (let k = 1; k < all.items.length; k++) t.ok(all.items[k - 1].sortOrder <= all.items[k].sortOrder, "favorites are not in Mark's order");
    },
  },
  {
    id: "commentary.favorites-spanish-twin",
    title: "Spanish readers who click \"Favoritos\" get a Spanish Favorites page",
    covers: ["page /favorites.html"],
    modes: ["dev", "prod"],
    run: async (t) => {
      // the Spanish navbar's "Favoritos" link — where does it go?
      const nav = await t.get("/components/navbar.js");
      t.status(nav, 200);
      const m = /href:\s*'([^']+)',\s*label:\s*'Favoritos'/.exec(nav.text);
      t.ok(m, "the Spanish navbar no longer has a Favoritos link");
      const target = m[1];
      const en = t.html(await t.get("/favorites.html"), { mustContain: ["/api/favorites?category="] });
      t.equal(H.htmlLang(en).slice(0, 2), "en", "/favorites.html language");
      t.ok(target.startsWith("/es/"), `the Spanish navbar's "Favoritos" sends Spanish readers to the English page ${target} — there is no Spanish Favorites page`);
      const es = t.html(await t.get(target));
      t.equal(H.htmlLang(es).slice(0, 2), "es", `${target} language`);
      t.ok(es.includes("/api/favorites"), `${target} does not load the favorites`);
    },
  },
  {
    id: "commentary.favorites-edit-roundtrip",
    title: "Mark can add, rename and remove favorites from the dashboard, and the public list follows them into the right section in his order (fixtures, dev only)",
    covers: ["POST /api/favorites", "PATCH /api/favorites/:id", "DELETE /api/favorites/:id", "GET /api/favorites"],
    modes: ["dev"],
    devOnlyBecause: "it creates, edits and deletes e2e-fixture favorites; prod sweeps are read-only",
    run: async (t) => {
      // refusals first. The no-token add carries no link or section, so if the guard ever broke
      // (favorites' checkToken lets EVERYONE write when AGENT_APPROVAL_TOKEN is unset) it answers
      // 400 and writes nothing, instead of leaving an undeletable-by-the-gate row behind.
      const r401 = await t.send("POST", "/api/favorites", { body: { title: "e2e-fixture" } });
      t.ok(r401.status === 401, `adding a favorite without the token should be refused: ${r401.describe()}`);
      const rWrong = await t.send("POST", "/api/favorites", { body: { title: "e2e-fixture" }, headers: { "x-affiliate-token": "e2e-fixture-wrong-token" } });
      t.ok(rWrong.status === 401, `adding a favorite with a wrong token should be refused: ${rWrong.describe()}`);
      const r400 = await t.send("POST", "/api/favorites", { body: { title: "e2e-fixture" }, auth: true });
      t.ok(r400.status === 400 && r400.json?.success === false, `a favorite with no link or section should be a 400: ${r400.describe()}`);
      for (const m of ["PATCH", "DELETE"]) {
        const s = await t.send(m, `/api/favorites/${NO_SUCH_ID}`, { body: m === "PATCH" ? { title: "e2e-fixture" } : undefined });
        t.ok(s.status === 401, `${m} of a favorite without the token should be refused: ${s.describe()}`);
        const r = await t.send(m, `/api/favorites/${NO_SUCH_ID}`, { body: m === "PATCH" ? { title: "e2e-fixture" } : undefined, auth: true });
        t.ok(r.status === 404, `${m} of a favorite that does not exist should be a 404: ${r.describe()}`);
      }

      const before = t.success(await t.get("/api/favorites"));
      t.ok(Array.isArray(before.items), "the favorites list has no items array");
      const stamp = new Date(t.now()).toISOString();
      // Three fixtures, because both boxes hold 0 real favorites and the public list's ordering
      // and section filter only show their bugs when there is data: A and B in "cruise websites"
      // (B created second but ordered FIRST), C in "YouTube channels".
      const spec = [
        { key: "A", category: "cruise-websites", sortOrder: 9999 },
        { key: "B", category: "cruise-websites", sortOrder: 9998 },
        { key: "C", category: "youtube-channels", sortOrder: 9999 },
      ];
      const ids = {};
      try {
        for (const f of spec) {
          const made = t.success(await t.send("POST", "/api/favorites", { auth: true, body: {
            title: `e2e-fixture favorite ${f.key} ${stamp}`, url: `https://example.com/e2e-fixture-${f.key}`, category: f.category,
            description: "e2e-fixture — created and deleted by the release gate", sortOrder: f.sortOrder,
          } }));
          t.fields(made.item, ["id", "title", "url", "category", "description", "createdAt"], `the new favorite ${f.key}`);
          ids[f.key] = made.item.id;
          t.equal(made.item.sortOrder, f.sortOrder, `the new favorite ${f.key}'s position`);
        }

        const web = t.success(await t.get("/api/favorites?category=cruise-websites"));
        const yt = t.success(await t.get("/api/favorites?category=youtube-channels"));
        const pos = (list, k) => list.items.findIndex((i) => i.id === ids[k]);
        t.ok(pos(web, "A") >= 0 && pos(web, "B") >= 0, "the new cruise-website favorites do not appear in the public cruise-websites list");
        t.ok(pos(web, "B") < pos(web, "A"), "the public cruise-websites list is not in Mark's order (sortOrder) — the favorite ordered first shows second");
        t.ok(pos(web, "C") === -1, "a YouTube-channel favorite leaked into the cruise-websites section");
        t.ok(pos(yt, "C") >= 0, "the new YouTube-channel favorite does not appear in the YouTube-channels section");
        t.ok(pos(yt, "A") === -1 && pos(yt, "B") === -1, "cruise-website favorites leaked into the YouTube-channels section");
        t.ok(web.items.every((i) => i.category === "cruise-websites") && yt.items.every((i) => i.category === "youtube-channels"), "a section filter returned items from another section");
        for (const list of [web, yt]) for (let k = 1; k < list.items.length; k++) t.ok(list.items[k - 1].sortOrder <= list.items[k].sortOrder, "a favorites section is not in Mark's order");
        t.equal(web.count, web.items.length, "the cruise-websites count vs its items");
        t.equal(web.items[pos(web, "A")].title, `e2e-fixture favorite A ${stamp}`, "the new favorite's title on the public list");

        const patched = t.success(await t.send("PATCH", `/api/favorites/${ids.A}`, { auth: true, body: { title: `e2e-fixture favorite A renamed ${stamp}` } }));
        t.equal(patched.item.title, `e2e-fixture favorite A renamed ${stamp}`, "the renamed favorite's title");
        t.equal(patched.item.url, "https://example.com/e2e-fixture-A", "a rename must not change the favorite's link");
        const after = t.success(await t.get("/api/favorites?category=cruise-websites"));
        t.equal(after.items.find((i) => i.id === ids.A)?.title, `e2e-fixture favorite A renamed ${stamp}`, "the public list after a rename");
      } finally {
        const left = [];
        for (const [k, id] of Object.entries(ids)) {
          const del = await t.send("DELETE", `/api/favorites/${id}`, { auth: true });
          if (!(del.status === 200 && del.json?.success === true)) left.push(`${k}=${id} (${del.describe()})`);
        }
        t.ok(left.length === 0, `e2e-fixture favorites could not be deleted — remove them by hand: ${left.join(" · ")}`);
      }
      const final = t.success(await t.get("/api/favorites"));
      t.ok(!final.items.some((i) => Object.values(ids).includes(i.id)), "a deleted favorite is still on the public list");
      t.equal(final.items.length, before.items.length, "favorites after the round trip vs before (a real favorite was lost or a fixture was left behind)");
    },
  },
];
