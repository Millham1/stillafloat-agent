// e2e/checks/editorial.mjs — Mark's editorial dashboard: storm-alert admin, the course-change
// (diversion) log, the action queue his daily brief shows, the daily brief and its email, the
// weekly newsletter and its email preview, and the proposal / task-closure buttons.
//
// Incidents and risks these checks exist for:
//   2026-09-04  A missing AGENT_APPROVAL_TOKEN used to OPEN every admin and personal-data endpoint
//               (103 call sites). http-auth.ts now fails closed; the first check proves the lock is on.
//   2026-09-09  Mark's dashboard said "0 to review" while ten social drafts sat in the queue: the
//               stored brief was a snapshot. Two views of the same numbers must agree, so the brief's
//               counts are checked against its own sections and its email against the brief.
//   2026-09-09  Dev sends carried the BOX address in subscriber links. Every link in the newsletter
//               preview must point at the public site, and must open.
//   2026-09-24  Fay: a storm that came back after ending was never re-pinned, so the course-change
//               detector watched nothing and the tracker read offline. The diversion log's live storms
//               are checked against the storm queue, and a named live storm must have ships pinned.
//   2026-09-26  The public Storm Watch list broke while every feature test passed (see storm.mjs).
//               Here: a draft Mark has not approved must never reach the public list.
//   Risk        A button in Mark's brief that points at a storm already sent, an event already
//               handled, or nothing at all — or a storm waiting for approval with no button at all.
//   2026-07-09  The English issue featured the Spanish video (language-blind pick): each email's video
//               title must be in its own language, and EN and ES must be drafted the same week.
//   2026-07     @Review leaked marketing mail into "Waiting on you"; 2026-09-30 calendar events landed on
//               the wrong day. The brief's mail labels, task filter and event dates are checked.
//   Risk        The action queue shows 30 rows, newest first: a storm decision older than the 30th row
//               silently drops off the brief (found on dev 2026-10-08: Lowell's all-clear, since 09-11).
//   Risk        The brief drops the ops-manager feed's per-section errors, so a failed calendar or Gmail
//               read looks like an empty day. Not checkable through the site — admitted as a gap.
//
// WHAT IS NOT CALLED, AND WHY (read before adding requests):
//   • Every POST here except declare/edit/dismiss/all-clear-skip on a throwaway "e2e-fixture" storm
//     sends email, Web Push, or calls a paid model: approve (emails storm subscribers), all-clear on an
//     ended storm, storm-scan (model-written copy + notification), diversion publish (emails ship
//     watchers), newsletter draft (paid model) / send (emails subscribers) / notify (push), the
//     legacy send-newsletter, brief/run (push). Those are tested ONLY on their refusal paths (no key,
//     wrong key, malformed body, unknown id) and the real behaviour is an admitted gap in
//     coverage/editorial.json.
//   • GET /api/storm-alerts/:id/action acts on an alert — dev only, and only on our own fixture.
//   • GET /api/go/:id records an affiliate click and GET /api/unsubscribe unsubscribes: the newsletter
//     preview's links to them are validated (item exists, link signed) but never opened.
//   • The legacy POST /api/send-newsletter is only sent bodies refused BEFORE any store is read (no
//     subject; an empty story list). An unknown story id would reach the story match, and one bug
//     there would email every confirmed dev subscriber.
//   • GET /api/brief?fresh=1 re-assembles and stores the brief. It is what Mark's brief page does on
//     every open, but it writes, so it runs on dev only; prod reads the stored brief.
// Personal data: the brief and the newsletter carry names, email subjects and addresses. Nothing
// from them is put in an observation or a failure message — counts, ids, dates and statuses only.
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

// The dev mirror has no certificate: its PUBLIC_URL is http://178.156.154.144, so links to the dev
// box itself are http there by design. Anywhere else (and on prod everywhere) a link must be https.
const DEV_BOX_HOSTS = new Set(["178.156.154.144", "127.0.0.1", "localhost"]);
const httpsOrDevBox = (t, u) => u.protocol === "https:" || (t.mode === "dev" && u.protocol === "http:" && DEV_BOX_HOSTS.has(u.hostname));


const PUBLIC_HOST = "stillafloatcruising.com";
const NOBODY = "00000000-0000-4000-8000-000000000000"; // an id no row has
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIVE = ["draft", "approved", "sending", "sent"];
const ms = (v) => Date.parse(String(v ?? ""));
const dec = (u) => String(u).replace(/&amp;/g, "&");
const SPANISH = /[áéíóúñ¿¡]| (el|la|los|las|que|con|para|por|una?|tu|tus) /i;
const SPANISH_TITLE = /[¡¿áéíóúñÁÉÍÓÚÑ]/; // lib/newsletter.ts gatherFeaturedVideo's language test
// Same ladder as lib/storm-escalation.ts severityRank (2 = depression / gale and up = pins ships).
const rankOf = (c) => { const s = String(c || ""); return /major hurricane/i.test(s) ? 5 : /hurricane/i.test(s) ? 4 : /storm/i.test(s) ? 3 : /depression|gale/i.test(s) ? 2 : /potential tropical cyclone/i.test(s) ? 1 : 0; };
const namedStorm = (a) => Boolean(a.name) && !/unnamed|area\(s\)/i.test(a.name);
const isFixture = (a) => /^MANUAL-e2e-fixture/i.test(a.nhc_id || "") || /^e2e-fixture/i.test(a.name || "");
/** First, last and evenly spread items in between — never loop over hundreds. */
function spread(list, n = 6) {
  if (list.length <= n) return list;
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return [...out];
}

// Every endpoint a button in Mark's brief may call (routes/storm.ts, proposals.ts, actions.ts), with its verb.
const BUTTON_ROUTES = [
  /^POST \/api\/storm-alerts\/[0-9a-f-]{36}\/(approve|dismiss|all-clear|all-clear-skip)$/,
  /^POST \/api\/storm-diversions\/[0-9a-f-]{36}\/(publish|ignore)$/,
  /^POST \/api\/proposals\/[0-9a-f-]{36}\/(approve|dismiss)$/,
  /^POST \/api\/tasks\/[0-9a-f-]{36}\/(close|keep)$/,
  /^POST \/api\/actions\/[0-9a-f-]{36}\/resolve$/,
  /^GET \/api\/storm-watch$/, // the July "demo" action's read-only button
];

// The Gmail labels that make "Waiting on you" (saf-ops-manager agent/brief_feed.py ACTION_RULES).
const MAIL_LABELS = ["@Action", "CLIENTS/LEADS", "CLIENTS/ACTIVE BOOKINGS", "PARTNERS/CORNERSTONE"];

// Every dashboard read in this area. A refusal answers 401 and carries no data.
const GATED_READS = [
  ["/api/storm-alerts/regions", "GET /api/storm-alerts/regions"],
  ["/api/storm-diversions/log", "GET /api/storm-diversions/log"],
  ["/api/actions", "GET /api/actions"],
  ["/api/brief", "GET /api/brief"],
  ["/api/brief/email-preview", "GET /api/brief/email-preview"],
  ["/api/newsletter/draft", "GET /api/newsletter/draft"],
  ["/api/newsletter/draft?lang=es", "GET /api/newsletter/draft"],
  ["/api/newsletter/email?lang=es", "GET /api/newsletter/email"],
  ["/api/newsletter/review", "GET /api/newsletter/review"],
  ["/api/approved-stories-list", "GET /api/approved-stories-list"],
];

/** A write must be refused without the key and with a wrong one (dev only — prod never writes). */
async function refusesWithoutKey(t, method, path, body = {}) {
  for (const [label, headers] of [["no key", {}], ["a wrong key", { "x-affiliate-token": "e2e-wrong-key" }]]) {
    const r = await t.send(method, path, { headers, body });
    t.ok(r.status === 401, `${method} ${path} with ${label} should be refused (401): ${r.describe()}`);
    const leaked = r.json && typeof r.json === "object" && !Array.isArray(r.json) ? Object.keys(r.json).filter((k) => !["success", "ok", "error"].includes(k)) : [];
    t.ok(leaked.length === 0, `${method} ${path} with ${label} answered with data fields (${leaked.join(", ")}) instead of a plain refusal`);
  }
}

// ── newsletter preview, one check per language ───────────────────────────────
function newsletterCheck(lang) {
  const LANG = lang.toUpperCase();
  const name = lang === "es" ? "Spanish" : "English";
  return {
    id: `editorial.newsletter-preview-${lang}`,
    title: `The ${name} newsletter issue opens on Mark's review page with its email preview, and every link and picture in that email works and stays in ${name}`,
    covers: ["GET /api/newsletter/draft", "GET /api/newsletter/email", "GET /api/newsletter/review", "email:newsletter-preview-links"],
    modes: ["dev", "prod"],
    incident: "2026-09-09: subscriber links carried the box address; 2026-10-03: the ES issue is first-class (Dulce)",
    timeoutMs: 110_000,
    run: async (t) => {
      const q = `?lang=${lang}`;
      const d = t.success(await t.get(`/api/newsletter/draft${q}`, { auth: true })).draft;
      t.require(d && typeof d === "object",
        `there is no ${name} newsletter issue on this box, so its email preview and links cannot be tested` +
        (t.mode === "dev" ? " — the weekly draft job is switched off on dev (DISABLE_WEEKLY_MARKETING); copy prod's current issue into dev's newsletter-draft" + (lang === "es" ? "-es" : "") + " store (no model call needed)" : ""));
      t.fields(d, ["subject", "lang", "status", "generatedAt"], `the ${name} issue`);
      t.equal(d.lang, lang, `the ${name} issue's language`);
      t.ok(["pending", "sending", "sent"].includes(d.status), `the ${name} issue has an unknown status "${d.status}"`);
      t.ok(Boolean(d.letter) || (d.quickHits || []).length > 0 || Boolean(d.booking), `the ${name} issue has no letter, no quick hits and no booking section — an empty email`);
      if (lang === "es") t.ok(SPANISH.test(`${d.subject} ${d.letter || ""}`), "the Spanish issue does not read as Spanish");
      if (d.status === "sent") {
        t.fields(d, ["sentAt"], `the sent ${name} issue`);
        t.ok(d.delivery && d.delivery.finishedAt, `the ${name} issue says "sent" but its delivery record never finished`);
        t.atLeast((d.delivery.recipients || []).length, 1, `subscribers the ${name} issue went to`);
      }

      // the email exactly as a subscriber gets it (rendered for "preview@…")
      const html = t.html(await t.get(`/api/newsletter/email${q}`, { auth: true }));
      if (d.letterTitle) t.ok(html.includes(d.letterTitle), `the ${name} email preview does not show the issue's headline`);
      if (d.booking) t.ok(html.includes(d.booking.headline), `the ${name} email preview is missing the "worth booking" section`);
      for (const h of d.quickHits || []) t.ok(html.includes(h.text), `a quick hit of the ${name} issue is missing from its email preview`);
      // every section the issue HAS is in the email (a renderer that drops a block still answers 200)
      if (d.sunnySide) t.ok(html.includes(d.sunnySide), `the ${name} email preview is missing "The Sunny Side"`);
      if (d.agencyPs) t.ok(html.includes(d.agencyPs), `the ${name} email preview is missing the P.S.`);
      if (d.photo?.url) t.ok(html.includes(d.photo.url) || html.includes(d.photo.url.replace(/&/g, "&amp;")), `the ${name} email preview is missing the week's photo`);

      const hrefs = [...new Set(H.links(html).map(dec))];
      const pics = [...new Set([...H.images(html), ...[...html.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1])].map(dec))];
      t.atLeast(hrefs.length, 3, `links in the ${name} email`);
      t.atLeast(pics.length, 2, `pictures in the ${name} email`);
      const unsub = hrefs.filter((u) => /\/api\/unsubscribe\b/.test(u));
      t.equal(unsub.length, 1, `unsubscribe links in the ${name} email`);
      const booking = hrefs.filter((u) => /\/work-with-mark\.html/.test(u));
      t.nonEmpty(booking, `the "work with Mark" booking links in the ${name} email`);
      if (d.video?.id) t.ok(hrefs.some((u) => u.includes(`watch?v=${d.video.id}`)), `the ${name} issue features a video but its email has no link to it`);
      if (d.affiliate) t.ok(hrefs.some((u) => /\/api\/go\//.test(u)), `the ${name} issue has a gear pick but its email has no link to it`);
      if (d.commentary?.url) t.ok(hrefs.some((u) => /commentary-post\.html\?id=/.test(u)), `the ${name} issue quotes Mark's commentary but its email has no link to it`);

      let affiliateItems = null;
      let opened = 0;
      for (const raw of [...hrefs, ...pics]) {
        let u;
        try { u = new URL(raw); } catch { t.ok(false, `the ${name} email has a link that is not a web address`); }
        t.ok(httpsOrDevBox(t, u), `the ${name} email links over ${u.protocol} (${u.host}${u.pathname})`);
        const isPic = pics.includes(raw);
        if (u.host === PUBLIC_HOST || u.host === `www.${PUBLIC_HOST}`) {
          // language: the Spanish email keeps Spanish readers on /es/ pages, the English one never sends them there
          if (/\.html$/.test(u.pathname)) {
            t.ok(lang === "es" ? u.pathname.startsWith("/es/") : !u.pathname.startsWith("/es/"),
              `the ${name} email links to a page in the wrong language: ${u.pathname}`);
          }
          if (u.pathname === "/api/unsubscribe") {
            // NOT opened: it would unsubscribe. It must carry the address and its signature.
            t.ok(u.searchParams.get("email") && u.searchParams.get("sig"), `the ${name} unsubscribe link is not signed (it would not work)`);
            continue;
          }
          const go = /^\/api\/go\/([^/]+)$/.exec(u.pathname);
          if (go) {
            // NOT opened: it records an affiliate click. The item must exist and have somewhere to go.
            affiliateItems ??= t.success(await t.get("/api/affiliate-items")).items;
            const item = (affiliateItems || []).find((i) => i.id === go[1]);
            t.ok(item, `the ${name} email's gear pick (${go[1]}) is no longer in the affiliate list — the click would go nowhere`);
            t.ok(/^https?:\/\//i.test(item.smartStrip || "") || Boolean(item.affiliateLink), `the ${name} email's gear pick has no product link to send the click to`);
            t.equal(u.searchParams.get("l"), lang, `the ${name} email's gear-pick click is tagged with the wrong language`);
            continue;
          }
          t.ok(!u.pathname.startsWith("/api/"), `the ${name} email links to an API address (${u.pathname}) that this check does not know is safe to open`);
          const r = await t.get(H.onBase(u.toString(), t.bases.site));
          opened++;
          if (isPic) {
            t.status(r, 200);
            t.ok(/^image\//.test(r.headers.get("content-type") || ""), `the ${name} email's picture ${u.pathname} is not an image`);
            continue;
          }
          const page = t.html(r);
          const can = H.canonical(page);
          if (can && !/commentary-post\.html$/.test(u.pathname)) t.equal(new URL(can).pathname, u.pathname, `the page the ${name} email links to (${u.pathname}) is really`);
          t.equal(H.htmlLang(page).slice(0, 2), u.pathname.startsWith("/es/") ? "es" : "en", `language of ${u.pathname}`);
          if (/commentary-post\.html$/.test(u.pathname)) {
            const id = u.searchParams.get("id");
            t.ok(id, `the ${name} email's commentary link names no post`);
            const post = t.success(await t.get(`/api/commentary?id=${encodeURIComponent(id)}`)).post;
            t.equal(post && post.status, "published", `the commentary post the ${name} email links to`);
            if (lang === "es") t.ok(post.title_es && post.body_es, "the Spanish email links to a commentary post that has no Spanish version");
          }
          continue;
        }
        if (u.host === "www.youtube.com" && u.pathname === "/watch") {
          const v = u.searchParams.get("v");
          t.matches(v, /^[A-Za-z0-9_-]{11}$/, `the ${name} email's video link`);
          if (d.video?.thumbnail) t.ok(d.video.thumbnail.includes(v), `the ${name} email's video thumbnail shows a different video than its link`);
          // oEmbed answers 200 for a public embeddable video, 401 for a PUBLIC video whose owner switched
          // embedding off (2026-10-09: the pinned Shokz video is public, embeddable=false — the email links
          // to the watch page, which plays it fine), 404 for a deleted one. Private videos answer 401 too,
          // so a 401 is confirmed against the site's own video cache, which the six-hourly scan prunes of
          // anything the YouTube Data API no longer returns (private and deleted alike).
          const oe = await t.get(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${v}`)}&format=json`);
          opened++;
          let vt = String(oe.json?.title || "");
          if (oe.status !== 200) {
            t.ok(oe.status === 401, `the video in the ${name} email (${v}) cannot be watched — YouTube says HTTP ${oe.status} (deleted or removed)`);
            const cached = t.json(await t.get(`/api/youtube-top?limit=10&lang=${lang}&type=all`)).videos || [];
            const hit = cached.find((x) => x.id === v);
            t.ok(hit, `the video in the ${name} email (${v}) is not embeddable AND is not in the site's video cache — the scan pruned it, so it is private or gone`);
            vt = String(hit?.title || "");
            t.observe(`${name} email video is public with embedding off`, true);
          }
          // the video is in the edition's language (2026-07-09: the English issue featured the Spanish
          // site-tour video; newsletter.ts picks by a Spanish-title test, the same test used here)
          t.ok(vt.length > 0, `no title could be read for the ${name} email's video`);
          t.ok(lang === "es" ? SPANISH_TITLE.test(vt) : !SPANISH_TITLE.test(vt), `the ${name} email features a video whose title is in the other language`);
          continue;
        }
        if (/^www\.pexels\.com$/.test(u.host)) { t.matches(u.pathname, /^\/@[\w.-]+/, `the ${name} email's photographer credit link`); continue; } // Pexels blocks robots; format only
        // every other picture or link: it must open
        const r = await t.get(u.toString());
        opened++;
        t.ok(r.status === 200, `the ${name} email links to ${u.host}${u.pathname}, which answers HTTP ${r.status}`);
        if (isPic) t.ok(/^image\//.test(r.headers.get("content-type") || ""), `the ${name} email's picture on ${u.host} is not an image`);
      }
      t.atLeast(opened, 4, `links and pictures of the ${name} email that were opened`);

      // Mark's review page wraps the same preview, with the language tabs
      const review = t.html(await t.get(`/api/newsletter/review${q}`, { auth: true }),
        { mustContain: [`Newsletter Review (${LANG})`, `/api/newsletter/email?lang=${lang}`, "/api/newsletter/review?lang=en", "/api/newsletter/review?lang=es"] });
      if (d.status === "pending") t.ok(review.includes('id="edit"'), `the ${name} review page has no edit panel for an issue that has not gone out`);
      // the review page describes the same issue (its pills are built from the draft)
      t.ok(review.includes(`${(d.quickHits || []).length} quick hits`), `the ${name} review page shows a different number of quick hits than the issue has`);
      t.ok(review.includes(`>${d.status}</span>`), `the ${name} review page does not show the issue's status (${d.status})`);
      t.ok(review.includes(`/api/newsletter/email?lang=${lang}&`), `the ${name} review page does not embed its email preview`);

      // English and Spanish go out the same week: a Spanish issue that stopped being drafted while
      // the English one carries on is the "Spanish path broken, English fine" failure.
      if (lang === "es") {
        const en = t.success(await t.get("/api/newsletter/draft?lang=en", { auth: true })).draft;
        t.ok(en && en.generatedAt, "there is a Spanish newsletter issue but no English one");
        const gapH = Math.abs(ms(en.generatedAt) - ms(d.generatedAt)) / 3_600_000;
        t.ok(gapH <= 36, `the English and Spanish newsletter issues were drafted ${Math.round(gapH)} hours apart — one language has stopped being drafted`);
        t.ok(!(d.video?.id && en.video?.id) || d.video.id !== en.video.id, "the Spanish issue features the same video as the English one");
      }

      t.observe(`${lang} issue status`, d.status, "info");
      t.observe(`${lang} email links`, hrefs.length, "info");
      t.observe(`${lang} email sections`, ["letterTitle", "booking", "quickHits", "video", "affiliate", "photo", "commentary"].filter((k) => d[k] && (!Array.isArray(d[k]) || d[k].length)).join(","), "info");

      // last: the issue must be current. Prod drafts every Thursday; a box whose issue is weeks old is
      // previewing something no subscriber will get.
      const ageDays = (Date.now() - ms(d.generatedAt)) / 86_400_000;
      if (t.mode === "prod") t.fresh(d.generatedAt, 8 * 24, `the ${name} newsletter issue (drafted weekly on Thursday)`);
      else t.require(ageDays <= 8, `dev's ${name} newsletter issue is ${Math.round(ageDays)} days old (prod drafts weekly; the job is off on dev), so the preview does not test what subscribers get — copy prod's current issue into dev`);
    },
  };
}

export default [
  {
    id: "editorial.dashboard-reads-refuse-without-key",
    title: "The lock on Mark's editorial dashboard data: storm admin, diversion log, action queue, daily brief and newsletter all refuse anyone without the dashboard key (the lock only — the data itself is checked below)",
    covers: [...new Set(GATED_READS.map(([, k]) => k))],
    modes: ["dev", "prod"],
    incident: "2026-09-04: a missing AGENT_APPROVAL_TOKEN opened every admin and personal-data endpoint",
    run: async (t) => {
      // requireToken also reads "Authorization: Bearer" and ?token= (the review page and the old
      // email links use the query form). Those two doors are tried on the two pages that use them.
      const variants = (path) => [["no key", path, {}], ["a wrong key", path, { "x-affiliate-token": "e2e-wrong-key" }],
        ...(/\/api\/(brief|newsletter\/review)$/.test(path.split("?")[0])
          ? [["a wrong ?token=", `${path}${path.includes("?") ? "&" : "?"}token=e2e-wrong-key`, {}], ["a wrong Bearer key", path, { authorization: "Bearer e2e-wrong-key" }]]
          : [])];
      for (const [base] of GATED_READS) {
        for (const [label, path, headers] of variants(base)) {
          const r = await t.get(path, { headers });
          t.ok(r.status === 401, `${base} with ${label} should be refused (401): ${r.describe()}`);
          const leaked = r.json && typeof r.json === "object" && !Array.isArray(r.json) ? Object.keys(r.json).filter((k) => !["success", "ok", "error"].includes(k)) : [];
          t.ok(leaked.length === 0, `${base} with ${label} still answered with data fields (${leaked.join(", ")})`);
          t.ok(!/<html|<!doctype/i.test(r.text), `${base} with ${label} answered with a page instead of a refusal`);
        }
      }
      t.observe("dashboard reads that refuse without the key", GATED_READS.length, "min");
    },
  },

  {
    id: "editorial.storm-regions-match-queue-and-public",
    title: "The storm admin's cruising-region list matches the public Storm Watch regions, keeps the Caribbean in season, and every storm in Mark's queue is labelled with those regions",
    covers: ["GET /api/storm-alerts/regions", "GET /api/storm-alerts", "GET /api/storm-watch"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const reg = t.success(await t.get("/api/storm-alerts/regions", { auth: true }));
      const keys = Object.keys(reg.regions || {});
      t.atLeast(keys.length, 8, "cruising regions Mark can declare a storm for");
      for (const k of keys) t.ok(typeof reg.regions[k] === "string" && reg.regions[k].trim().length > 2, `region "${k}" has no name`);
      t.ok(Array.isArray(reg.classifications), "the declare form's classification list is missing");
      for (const c of ["Gale Warning", "Tropical Storm", "Hurricane"]) t.ok(reg.classifications.includes(c), `the declare form no longer offers "${c}"`);

      // two views of the same names: the public Storm Watch uses the same region labels
      const pub = t.success(await t.get("/api/storm-watch"));
      t.equal(keysOf(pub.regions), keysOf(reg.regions), "region keys: public Storm Watch vs storm admin");
      for (const k of keys) t.equal(pub.regions[k], reg.regions[k], `region "${k}" name: public vs admin`);

      // every live storm in Mark's queue is on known grounds and labelled the way the list says
      const dash = t.success(await t.get("/api/storm-alerts", { auth: true }));
      t.ok(Array.isArray(dash.alerts), "Mark's storm queue is missing");
      t.nonEmpty(dash.alerts, "Mark's storm queue (it keeps ended storms too, so it is never empty on a real box)");
      const live = dash.alerts.filter((a) => LIVE.includes(a.status) && a.is_threat && !isFixture(a));
      for (const a of live) t.nonEmpty(a.affected_grounds || [], `live storm "${a.name}": cruising grounds`);
      // Every storm in the queue (ended ones too — so this never depends on a storm being live) is on
      // grounds the region list knows, and its label is built from that list's names, in order.
      const labelled = dash.alerts.filter((a) => !isFixture(a) && Array.isArray(a.affected_grounds) && a.affected_grounds.length);
      t.atLeast(labelled.length, 1, "storms in Mark's queue with cruising grounds (none means the grounds column is not being read)");
      for (const a of labelled) {
        for (const g of a.affected_grounds) t.ok(keys.includes(g), `storm "${a.name}" (${a.status}) is on ground "${g}", which the region list does not know`);
        t.equal(a.grounds_label, a.affected_grounds.map((g) => reg.regions[g]).join(", "), `storm "${a.name}" (${a.status}): grounds label`);
      }
      t.observe("region keys", keys.slice().sort().join(","));
      t.observe("declarable classifications", reg.classifications.join("|"));
      t.observe("live storms in queue", live.length, "info");

      // LAST (dev-only feature until the 2026-10-08 promotion — prod fails here until then):
      // the declare form greys out grounds that are out of season.
      t.ok(Array.isArray(reg.outOfSeason), "the region list does not say which grounds are out of season (the declare form needs it; on prod this arrives with the 2026-10-08 promotion)");
      for (const g of reg.outOfSeason) t.ok(keys.includes(g), `out-of-season ground "${g}" is not a known region`);
      // only Alaska has a season (storm-grounds GROUND_SEASONS); a list that greys out the Caribbean
      // would block every manual declaration
      t.ok(reg.outOfSeason.length < keys.length, "the region list says every cruising ground is out of season, so Mark cannot declare a storm anywhere");
      for (const g of ["e_caribbean", "w_caribbean", "bahamas"]) t.ok(!reg.outOfSeason.includes(g), `the region list says "${g}" is out of season (Caribbean grounds are sailed all year)`);
      t.observe("region answer keys", keysOf(reg));
    },
  },

  {
    id: "editorial.diversion-log-matches-storm-queue",
    title: "The course-change log lists exactly the live storms in Mark's queue, with ships pinned, consistent counts, and the same open course changes the storm queue shows",
    covers: ["GET /api/storm-diversions/log", "GET /api/storm-alerts", "flow:editorial-diversion-log-vs-storm-queue"],
    modes: ["dev", "prod"],
    incident: "2026-09-24: a returning storm was never re-pinned, so the detector watched nothing",
    run: async (t) => {
      const log = t.success(await t.get("/api/storm-diversions/log", { auth: true }));
      t.equal(log.days, 30, "the log's default window (days)");
      t.fresh(log.generated_at, 1, "the course-change log");
      const span = (ms(log.generated_at) - ms(log.since)) / 86_400_000;
      t.ok(Math.abs(span - 30) < 0.1, `the log says 30 days but covers ${span.toFixed(1)}`);
      t.ok(Array.isArray(log.pings) && Array.isArray(log.storms), "the log has no ping or storm list");
      t.require(log.storms.length > 0, "no live storm on this box, so the course-change log and its pins cannot be tested");
      t.nonEmpty(log.pings, "course changes seen in the last 30 days while storms are live");

      const c = log.counts || {};
      t.equal(c.pings, log.pings.length, "log count of pings vs the list");
      t.equal(c.diversions + c.swaps + c.routine + c.unknown, c.pings, "diversions + swaps + routine + unknown vs all pings");
      const pendingEvents = log.pings.filter((p) => p.event?.status === "pending");
      t.equal(c.pending, pendingEvents.length, "log count of open course changes vs the list");
      for (let i = 1; i < log.pings.length; i++) t.ok(ms(log.pings[i - 1].at) >= ms(log.pings[i].at), "the log is not newest-first");
      for (const p of spread(log.pings)) {
        t.fields(p, ["at", "ship_name", "kind", "verdict", "label"], "a course change in the log");
        t.ok(["diversion", "swap", "routine", "unknown"].includes(p.verdict), `a course change has an unknown verdict "${p.verdict}"`);
        t.ok(ms(p.at) >= ms(log.since) - 60_000, "a course change older than the log's window is listed");
        t.nonEmpty(p.alert_ids || [], `course change of ${p.ship_name}: which storm it belongs to`);
        if (p.event) t.ok(["pending", "ignored", "published"].includes(p.event.status), `a course-change event has an unknown status "${p.event.status}"`);
      }

      // two views of the same storms: the log's live storms are the queue's live threats
      const dash = t.success(await t.get("/api/storm-alerts", { auth: true }));
      const liveDash = dash.alerts.filter((a) => LIVE.includes(a.status) && a.is_threat && !isFixture(a));
      const logStorms = log.storms.filter((s) => !/^MANUAL-e2e-fixture/i.test(s.nhc_id || ""));
      const byId = new Map(dash.alerts.map((a) => [a.id, a]));
      for (const s of logStorms) {
        const a = byId.get(s.id);
        t.ok(a, `"${s.name}" is live in the course-change log but missing from Mark's storm queue`);
        t.equal(s.status, a.status, `"${s.name}" status: log vs queue`);
      }
      const logIds = new Set(logStorms.map((s) => s.id));
      for (const a of liveDash) t.ok(logIds.has(a.id), `"${a.name}" is a live threat in Mark's queue but missing from the course-change log`);
      // a live NAMED storm with sailings in its path must have ships pinned, or no course change can be seen
      for (const s of logStorms) {
        const a = byId.get(s.id);
        if (rankOf(a.classification) >= 2 && namedStorm(a) && (a.sailings || []).length > 0) {
          t.ok(s.live_pins > 0, `"${s.name}" has ${a.sailings.length} sailings in its path but the course-change detector is watching none of them`);
          // The lifecycle pins from the same answer the queue shows (storm-sailings.impactedShipsForAlert),
          // one pin per ship, and pins are sticky — so pins cover (nearly) every ship in the path. A pin
          // pass that stops part-way (a limit, a failed batch) leaves ships nobody is watching.
          const ships = new Set(a.sailings.map((v) => String(v.ship_name || "").toLowerCase())).size;
          t.ok(s.live_pins >= Math.floor(ships * 0.8), `"${s.name}": ${ships} ships in its path but only ${s.live_pins} pinned — the course-change detector is not watching the rest`);
        }
        // the other way round: ships pinned to a named storm, but Mark's queue shows no sailing in its path
        // (the queue's sailing lookup broke, or the window column is no longer read)
        if (rankOf(a.classification) >= 2 && namedStorm(a) && s.live_pins > 0) {
          t.atLeast((a.sailings || []).length, 1, `sailings Mark's storm queue shows in the path of "${s.name}" (${s.live_pins} ships are pinned to it)`);
        }
      }
      t.ok(logStorms.some((s) => s.live_pins > 0), "no live storm has a single ship pinned — the course-change detector is watching nothing");
      // the queue's open course changes are the log's open events
      const dashPending = new Set(dash.alerts.flatMap((a) => (a.diversions || []).map((d) => d.id)));
      for (const p of pendingEvents) {
        if ((p.alert_ids || []).some((id) => byId.has(id))) t.ok(dashPending.has(p.event.id), `an open course change (${p.ship_name}) is in the log but not on the storm queue`);
      }
      for (const id of dashPending) t.ok(pendingEvents.some((p) => p.event.id === id), "an open course change on the storm queue is missing from the log");

      // the window parameter
      const week = t.success(await t.get("/api/storm-diversions/log?days=7", { auth: true }));
      t.equal(week.days, 7, "the 7-day log's window");
      t.ok(week.counts.pings <= c.pings, `the 7-day log has more course changes (${week.counts.pings}) than the 30-day log (${c.pings})`);
      for (const p of spread(week.pings || [])) t.ok(ms(p.at) >= ms(week.since) - 60_000, "the 7-day log lists a course change older than 7 days");

      t.observe("log keys", keysOf(log));
      t.observe("log count keys", keysOf(c));
      t.observe("ping keys", log.pings[0] ? keysOf(log.pings[0]) : "", "info");
      t.observe("live storms in log", logStorms.length, "info");
      t.observe("course changes in 30 days", c.pings, "info");
      t.observe("open course changes", c.pending, "info");
    },
  },

  {
    id: "editorial.action-queue-matches-its-sources",
    title: "Every button in Mark's daily-brief action queue points at a storm, course change, proposal or task that is still waiting for him — and every storm or course change waiting for him has a button",
    covers: ["GET /api/actions", "GET /api/storm-alerts", "GET /api/storm-diversions/log", "flow:editorial-brief-buttons-match-sources"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const acts = t.success(await t.get("/api/actions", { auth: true }), "ok").actions;
      t.ok(Array.isArray(acts), "the action queue is missing");
      t.require(acts.length > 0, "Mark's action queue is empty on this box, so none of its buttons can be checked against what they act on");
      const dash = t.success(await t.get("/api/storm-alerts", { auth: true }));
      const log = t.success(await t.get("/api/storm-diversions/log", { auth: true }));
      const alerts = new Map(dash.alerts.map((a) => [a.id, a]));
      const events = new Map(log.pings.filter((p) => p.event).map((p) => [p.event.id, p.event]));
      // listPendingActions stopped at 30 until 2026-10-08; it now returns every pending action

      const types = {};
      for (const a of acts) {
        t.fields(a, ["id", "type", "title", "status", "created_at"], "an action in Mark's queue");
        t.equal(a.status, "pending", `an action of type ${a.type} in the pending queue`);
        t.ok(Array.isArray(a.buttons), `action ${a.id}: buttons missing`);
        types[a.type] = (types[a.type] || 0) + 1;
        for (const b of a.buttons) {
          t.ok(typeof b.label === "string" && b.label.trim(), `action ${a.id}: a button has no label`);
          t.ok((["GET", "POST"].includes(b.method) && /^\/api\//.test(b.path || "")) || /^(\/|https:\/\/)/.test(b.href || ""), `action ${a.id}: a button goes nowhere`);
          if (b.path) {
            t.ok(!/[?&]token=/.test(b.path), `action ${a.id}: a button carries the dashboard key in its address`);
            // the button must call an endpoint that exists, with the verb it is registered under —
            // a renamed route leaves a button that answers 404 when Mark taps it
            t.ok(BUTTON_ROUTES.some((re) => re.test(`${b.method} ${b.path}`)), `action ${a.id} (${a.type}): its "${b.method} ${b.path.replace(/[0-9a-f-]{36}/g, ":id")}" button calls an endpoint the site does not have`);
          }
        }
        const paths = a.buttons.map((b) => b.path || "").filter(Boolean);
        const ref = a.source_ref || "";
        if (a.type === "storm_alert") {
          const al = alerts.get(ref);
          t.ok(al, `a storm button in Mark's brief points at an alert that is gone from his queue (${ref})`);
          for (const p of paths) t.ok(p.includes(`/api/storm-alerts/${ref}/`), `a storm button acts on a different alert than its own (${ref})`);
          if (paths.some((p) => p.endsWith("/approve"))) {
            t.ok(["draft", "approved"].includes(al.status), `Mark's brief still offers "Approve & send" for "${al.name}", which is already ${al.status}`);
          }
          if (paths.some((p) => p.endsWith("/all-clear"))) {
            t.equal(al.status, "ended", `the all-clear button for "${al.name}" — storm status`);
            t.ok(al.all_clear_headline && !al.all_clear_sent_at && !al.all_clear_skipped_at, `Mark's brief offers an all-clear for "${al.name}" that has no draft or was already sent/skipped`);
          }
        } else if (a.type === "storm_diversion") {
          for (const p of paths) t.ok(p.includes(`/api/storm-diversions/${ref}/`), "a course-change button acts on a different event than its own");
          const young = Date.now() - ms(a.created_at) < 29 * 86_400_000;
          if (young) {
            const ev = events.get(ref);
            t.ok(ev, "a course-change button in Mark's brief points at an event the course-change log does not have");
            t.equal(ev.status, "pending", "a course-change button in Mark's brief is for an event that was already handled — status");
          }
        } else if (a.type === "site_proposal") {
          t.ok(paths.length > 0 && paths.every((p) => p === `/api/proposals/${ref}/approve` || p === `/api/proposals/${ref}/dismiss`), "a proposal's buttons do not approve/dismiss that proposal");
        } else if (a.type === "task_closure") {
          t.ok(paths.length > 0 && paths.every((p) => p === `/api/tasks/${ref}/close` || p === `/api/tasks/${ref}/keep`), "a task-closure's buttons do not close/keep that task");
        }
      }

      t.observe("action types", Object.keys(types).sort().join(","), "info");
      t.observe("pending actions", acts.length, "info");
      t.observe("action keys", keysOf(acts[0]));

      // the other direction: everything waiting on Mark has a button.
      const why = "";
      const alertActs = new Set(acts.filter((a) => a.type === "storm_alert").map((a) => a.source_ref));
      for (const al of dash.alerts) {
        if (isFixture(al) || /^MANUAL-/.test(al.nhc_id || "")) continue; // Mark declared it himself: no nudge by design
        if (al.status === "draft" && al.is_threat) t.ok(alertActs.has(al.id), `storm "${al.name}" is waiting for Mark's approval but his brief has no button for it${why}`);
        if (al.status === "ended" && al.all_clear_headline && !al.all_clear_sent_at && !al.all_clear_skipped_at) t.ok(alertActs.has(al.id), `the all-clear for "${al.name}" is waiting for Mark but his brief has no button for it${why}`);
      }
      const divActs = new Set(acts.filter((a) => a.type === "storm_diversion").map((a) => a.source_ref));
      for (const [id, ev] of events) if (ev.status === "pending") t.ok(divActs.has(id), `an open course change is waiting for Mark but his brief has no button for it${why}`);
      // the whole queue is shown now (no cap since 2026-10-08); how long it is, is for Mark to see, not for the gate to hide
      t.observe("pending actions by type", Object.entries(types).map(([k, v]) => `${v} ${k}`).join(", "), "info");
    },
  },

  {
    id: "editorial.daily-brief-and-its-email",
    title: "Mark's daily brief assembles with the ops-manager's calendar, mail, tasks and money, shows today's events and only real action mail and priority tasks, its numbers match its own lists, and the brief email shows the same day and numbers with working links",
    covers: ["GET /api/brief", "GET /api/brief/email-preview"],
    modes: ["dev", "prod"],
    incident: "2026-09-09: the dashboard said 0 to review while 10 drafts waited (stale snapshot)",
    timeoutMs: 110_000,
    run: async (t) => {
      // dev: the brief job is off there (DISABLE_DAILY_BRIEF), so assemble it now — exactly what Mark's
      // brief page does on every open (no push, no email). prod: read the stored brief (no writes).
      const path = t.mode === "dev" ? "/api/brief?fresh=1" : "/api/brief";
      const b = t.success(await t.get(path, { auth: true, timeoutMs: 60_000 }), "ok").brief;
      t.fields(b, ["date", "generatedAt", "sections", "counts"], "the daily brief");
      t.equal(b.opsReachable, true, "the brief reached the ops-manager (calendar, mail, tasks and money come from it)");
      if (t.mode === "dev") t.fresh(b.generatedAt, 0.25, "the brief just assembled");
      else t.fresh(b.generatedAt, 20, "the stored brief (assembled at 7am, noon and 4pm Eastern)");
      const day = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" }).format(new Date(ms(b.generatedAt)));
      t.equal(b.date, day, "the brief's date label vs when it was assembled (Eastern)");

      const s = b.sections; const c = b.counts;
      for (const k of ["actions", "calendar", "tasks", "bills"]) t.ok(Array.isArray(s[k]), `the brief's ${k} section is missing`);
      t.equal(c.actions, s.actions.length, "brief count of mail waiting vs its list");
      t.equal(c.events, s.calendar.length, "brief count of calendar events vs its list");
      t.equal(c.tasks, s.tasks.length, "brief count of tasks vs its list");
      t.equal(c.ideasNew, s.ideas?.count, "brief count of new phone notes vs its section");
      t.equal(c.socialPending, s.social?.pending, "brief count of social posts to review vs its section");
      t.ok(Number.isInteger(s.tasksTotal) && s.tasksTotal >= s.tasks.length, "the brief lists more tasks than its total");
      t.atLeast(s.tasksTotal, 1, "open tasks in Mark's list (zero means the ops-manager's task read failed)");
      t.ok(Number.isInteger(c.affiliateClicks28d) && c.affiliateClicks28d >= 0, "the brief's affiliate-click count is not a number");
      t.equal(b.nothingToDo, c.actions === 0 && c.tasks === 0 && c.ideasNew === 0 && c.socialPending === 0, "the brief's \"nothing to do\" flag vs its counts");
      t.equal(s.social?.reviewPath, "/api/social/review", "the brief's social-review link");
      // "Waiting on you" is only the real action labels (ops-manager brief_feed ACTION_RULES, max 15):
      // 2026-07 the @Review catch-all leaked marketing and surveys into it.
      t.ok(c.actions <= 15, `the brief lists ${c.actions} mail items; the ops-manager caps it at 15`);
      for (const a of spread(s.actions, 4)) {
        t.fields(a, ["subject", "label", "priority", "url"], "a mail item in the brief");
        t.matches(a.url, /^https:\/\/mail\.google\.com\//, "a mail item's link");
        t.ok(MAIL_LABELS.includes(a.label), `a mail item in "Waiting on you" carries the label "${a.label}", which is not one of the action labels`);
      }
      // Tasks: signal only (P1–P2 or in progress), open ones only, each once.
      const taskIds = new Set();
      for (const k of s.tasks) {
        t.fields(k, ["id", "title", "status"], "a task in the brief");
        t.ok(["open", "in_progress"].includes(k.status), `a task in the brief is "${k.status}" — finished work is back on Mark's list`);
        t.ok(k.status === "in_progress" || (Number(k.priority) || 3) <= 2, `a P${k.priority} task that is not in progress is listed (the brief shows P1–P2 only)`);
        t.ok(!taskIds.has(k.id), "a task is listed twice in the brief");
        taskIds.add(k.id);
      }
      // Calendar: TODAY's events (Eastern). 2026-09-30: date-only and time-zone bugs put events on the
      // wrong day. A timed event may have started late yesterday; none may start after today.
      const etDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
      const today = etDay(new Date(ms(b.generatedAt)));
      const yesterday = etDay(new Date(ms(b.generatedAt) - 86_400_000));
      for (const e of s.calendar) {
        t.fields(e, ["title", "time"], "a calendar item in the brief");
        if (e.all_day || !e.start_iso) continue;
        const day = String(e.start_iso).slice(0, 10);
        t.ok(day === today || day === yesterday, `a calendar event in the brief for ${today} starts on ${day}`);
      }

      // the brief email (rendered from the stored brief — on dev, the one just assembled)
      const html = t.html(await t.get("/api/brief/email-preview", { auth: true }), { mustContain: ["Daily Brief"] });
      t.ok(html.includes(b.date), "the brief email shows a different day than the brief");
      if (c.tasks > 0) t.ok(html.includes("Open tasks"), "the brief email is missing the open-tasks section");
      if (c.actions > 0) t.ok(html.includes("Waiting on you"), "the brief email is missing the mail-waiting section");
      if (c.events > 0) t.ok(html.includes("Today's calendar"), "the brief email is missing today's calendar");
      t.ok(!html.includes("Couldn't reach the ops-manager"), "the brief email says the ops-manager could not be reached");
      // the email's summary line carries the same numbers as the brief (the social count is left out:
      // the brief overlays the live social queue, the stored email does not)
      if (!b.nothingToDo) {
        if (c.actions) t.ok(html.includes(`${c.actions} to reply to`), `the brief email does not say "${c.actions} to reply to" like the brief does`);
        if (c.events) t.ok(html.includes(`${c.events} on the calendar`), `the brief email does not say "${c.events} on the calendar" like the brief does`);
        if (c.tasks) t.ok(html.includes(`${c.tasks} open tasks`), `the brief email does not say "${c.tasks} open tasks" like the brief does`);
      }
      const links = [...new Set(H.links(html).map(dec))];
      for (const raw of links) {
        let u; try { u = new URL(raw); } catch { t.ok(false, "the brief email has a link that is not a web address"); }
        t.ok(httpsOrDevBox(t, u), `the brief email links over ${u.protocol} (${u.host})`);
        if (u.host === PUBLIC_HOST) {
          t.equal(u.pathname, "/api/social/review", "the only site link in the brief email is the social review page");
          t.html(await t.get(H.onBase(u.toString(), t.bases.site), { auth: true }));
        }
      }
      t.observe("brief keys", keysOf(b));
      t.observe("brief sections", keysOf(s));
      t.observe("brief counts", keysOf(c));
      t.observe("open tasks", s.tasksTotal, "info");
      t.observe("brief email links", links.length, "info");
    },
  },

  newsletterCheck("en"),
  newsletterCheck("es"),

  {
    id: "editorial.approved-stories-for-newsletter",
    title: "The approved-story list the newsletter is written from is populated, every story has a real Spanish twin, and the newest one is recent",
    covers: ["GET /api/approved-stories-list"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const body = t.json(await t.get("/api/approved-stories-list", { auth: true }));
      t.ok(Array.isArray(body.stories), "the approved-story list is missing");
      t.nonEmpty(body.stories, "approved stories");
      const ids = new Set();
      let noSpanish = 0;
      const badSpanish = [];
      for (const s of body.stories) {
        t.ok(s.id && s.title, "an approved story has no id or title");
        t.ok(!ids.has(s.id), "an approved story is listed twice");
        ids.add(s.id);
        t.ok(s.summary || s.synopsis, "an approved story has no summary");
        t.ok(Number.isFinite(ms(s.publishedAt ?? s.approvedAt)), "an approved story has no readable date");
        if (!(s.title_es && s.summary_es)) { noSpanish++; continue; }
        // a twin that is really Spanish: not the English copied over (failed translation), not the
        // model's raw JSON (the ES translation JSON leak), and reading as Spanish
        if (s.title_es === s.title && s.summary_es === s.summary) badSpanish.push("copied from English");
        else if (/^\s*[{[]|"(title|summary)(_es)?"\s*:/.test(`${s.title_es}${s.summary_es}`)) badSpanish.push("raw model JSON");
        else if (!SPANISH.test(` ${s.title_es} ${s.summary_es} `)) badSpanish.push("does not read as Spanish");
      }
      t.equal(noSpanish, 0, "approved stories with no Spanish title or summary (the Spanish issue falls back to English for them)");
      t.ok(badSpanish.length === 0, `${badSpanish.length} approved stories have a broken Spanish twin (${[...new Set(badSpanish)].join(", ")})`);
      t.observe("story keys", keysOf(body.stories[0]), "info");
      t.observe("approved stories", body.stories.length, "info");
      // LAST: the newsletter uses only stories under 48 hours old; a stale list means an issue with no news.
      const newest = Math.max(...body.stories.map((s) => ms(s.publishedAt ?? s.approvedAt)));
      t.fresh(newest, 72, "the newest approved story (the newsletter only uses stories under 48 hours old)");
    },
  },

  {
    id: "editorial.storm-declare-edit-dismiss-fixture",
    title: "On dev, a storm Mark declares by hand lands in his storm queue and the course-change log with the right regions, takes his headline and text edits, stays off the public Storm Watch until approved, refuses an all-clear before it ends, and dismisses — on a throwaway e2e-fixture storm",
    covers: ["POST /api/storm-alerts/declare", "PATCH /api/storm-alerts/:id", "POST /api/storm-alerts/:id/all-clear", "POST /api/storm-alerts/:id/all-clear-skip",
      "GET /api/storm-alerts/:id/action", "POST /api/storm-alerts/:id/dismiss", "GET /api/storm-alerts", "GET /api/storm-alerts/regions", "GET /api/storm-watch", "GET /api/storm-diversions/log", "flow:editorial-storm-manual-declare"],
    modes: ["dev"],
    devOnlyBecause: "it creates, edits and dismisses a storm-alert row (prod is read-only). The fixture is a Gale Warning with a window in 2020: no sailings, no ship pins, no Live-AIS, no storm-intel lookups, no email",
    timeoutMs: 120_000,
    run: async (t) => {
      const FIX = `e2e-fixture ${Date.now().toString(36)}`;
      const reg = t.success(await t.get("/api/storm-alerts/regions", { auth: true }));
      const dormant = new Set(reg.outOfSeason || []);
      const ground = Object.keys(reg.regions || {}).find((k) => !dormant.has(k));
      t.ok(ground, "no cruising region is in season, so a storm cannot be declared");
      await refusesWithoutKey(t, "POST", "/api/storm-alerts/declare", { name: FIX, classification: "Gale Warning", grounds: [ground] });
      await refusesWithoutKey(t, "PATCH", `/api/storm-alerts/${NOBODY}`, { headline: FIX });
      await refusesWithoutKey(t, "POST", `/api/storm-alerts/${NOBODY}/dismiss`);
      await refusesWithoutKey(t, "POST", `/api/storm-alerts/${NOBODY}/all-clear`);
      await refusesWithoutKey(t, "POST", `/api/storm-alerts/${NOBODY}/all-clear-skip`);

      const made = [];
      try {
        // malformed declarations are refused before anything is written
        const BAD = [
          [{}, /name/i, "no name"],
          [{ name: FIX, classification: "Light breeze", grounds: [ground] }, /classification/i, "a classification not on the list"],
          [{ name: FIX, classification: "Gale Warning", grounds: ["e2e-no-such-ground"] }, /ground/i, "an unknown cruising ground"],
          [{ name: FIX, classification: "Gale Warning", grounds: [ground], window_start: "2020-01-05", window_end: "2020-01-01" }, /window/i, "a window that ends before it starts"],
        ];
        // a ground out of season (Alaska after 10 Oct) is refused; only testable while one is dormant
        const asleep = Object.keys(reg.regions || {}).find((k) => dormant.has(k));
        if (asleep) BAD.push([{ name: FIX, classification: "Gale Warning", grounds: [asleep] }, /out of season/i, "a cruising ground that is out of season"]);
        for (const [body, re, what] of BAD) {
          const r = await t.send("POST", "/api/storm-alerts/declare", { auth: true, body });
          if (r.status === 200 && r.json?.id) made.push(r.json.id);
          t.ok(r.status === 400 && r.json?.success === false && re.test(r.json?.error || ""), `declaring a storm with ${what} should be refused (400): ${r.describe()}`);
        }

        const out = t.success(await t.send("POST", "/api/storm-alerts/declare", {
          auth: true,
          body: { name: FIX, classification: "Gale Warning", grounds: [ground], window_start: "2020-01-01", window_end: "2020-01-02", note: "Release-gate fixture: declared and dismissed by the e2e suite." },
        }));
        t.matches(out.id, UUID, "the declared storm's id");
        made.push(out.id);
        const id = out.id;
        t.matches(out.nhc_id, /^MANUAL-e2e-fixture-/, "the declared storm's feed id");

        let q = t.success(await t.get("/api/storm-alerts", { auth: true }));
        let row = q.alerts.find((a) => a.id === id);
        t.ok(row, "a storm Mark just declared is missing from his storm queue");
        t.equal(row.status, "draft", "a just-declared storm's status");
        t.equal(row.classification, "Gale Warning", "the declared storm's classification");
        t.equal(row.is_threat, true, "a declared storm counts as a threat");
        t.ok((row.affected_grounds || []).includes(ground), "the declared storm lost its cruising ground");
        t.equal(row.grounds_label, reg.regions[ground], "the declared storm's grounds label vs the region list");
        t.ok(typeof row.body_md === "string" && row.body_md.includes(FIX), "the declared storm's subscriber text does not name it");
        t.ok(Array.isArray(row.sailings) && Array.isArray(row.diversions), "the declared storm has no sailing or course-change list");

        // one system: a live draft is a live storm in the course-change log too (no ships: 2020 window)
        let log = t.success(await t.get("/api/storm-diversions/log?days=1", { auth: true }));
        const inLog = (log.storms || []).find((s) => s.id === id);
        t.ok(inLog, "a storm Mark just declared is missing from the course-change log's live storms");
        t.equal(inLog.live_pins, 0, "ships pinned to a fixture storm whose window is in 2020");

        const head = `${FIX} edited headline`;
        const bodyMd = `**${FIX}** edited subscriber text.`;
        t.success(await t.send("PATCH", `/api/storm-alerts/${id}`, { auth: true, body: { headline: head, body_md: bodyMd } }));

        // a draft is not public — on either public view
        const pub = t.success(await t.get("/api/storm-watch"));
        t.ok(Array.isArray(pub.systems) && !pub.systems.some((s) => s.id === id), "a storm Mark has NOT approved is on the public Storm Watch list");
        const det = await t.get(`/api/storm-watch/${id}`);
        t.ok(det.status === 404, `a storm Mark has NOT approved has a public detail page: ${det.describe()}`);

        q = t.success(await t.get("/api/storm-alerts", { auth: true }));
        row = q.alerts.find((a) => a.id === id);
        t.equal(row && row.headline, head, "Mark's headline edit was not saved");
        t.equal(row.body_md, bodyMd, "Mark's edit to the subscriber text was not saved");
        t.equal(row.status, "draft", "editing a draft changed its status");

        const ac = await t.send("POST", `/api/storm-alerts/${id}/all-clear`, { auth: true });
        t.ok(ac.status === 409 && ac.json?.success === false, `an all-clear for a storm that has not ended should be refused (409): ${ac.describe()}`);
        t.success(await t.send("POST", `/api/storm-alerts/${id}/all-clear-skip`, { auth: true }));
        const acGone = await t.send("POST", `/api/storm-alerts/${NOBODY}/all-clear`, { auth: true });
        t.ok(acGone.status === 404, `an all-clear for a storm that does not exist should be 404: ${acGone.describe()}`);

        // the email-link path (GET …/action) — on our own fixture only
        t.status(await t.get(`/api/storm-alerts/${id}/action?do=dismiss`), 401);
        const bogus = await t.get(`/api/storm-alerts/${id}/action?do=e2e-bogus`, { auth: true });
        t.ok(bogus.status === 400, `an unknown email-link action should be refused (400): ${bogus.describe()}`);
        const viaLink = await t.get(`/api/storm-alerts/${id}/action?do=dismiss`, { auth: true });
        t.status(viaLink, 200);
        t.ok(/dismissed/i.test(viaLink.text), "the email-link dismiss did not confirm");
        // the dashboard dismiss (also releases pins and clears brief buttons); idempotent
        t.success(await t.send("POST", `/api/storm-alerts/${id}/dismiss`, { auth: true }));
        q = t.success(await t.get("/api/storm-alerts", { auth: true }));
        t.ok(!q.alerts.some((a) => a.id === id), "a dismissed storm is still in Mark's storm queue");
        log = t.success(await t.get("/api/storm-diversions/log?days=1", { auth: true }));
        t.ok(!(log.storms || []).some((s) => s.id === id), "a dismissed storm is still a live storm in the course-change log");
        t.observe("declare answer keys", keysOf(out));
      } finally {
        for (const sid of made) {
          try { await t.send("POST", `/api/storm-alerts/${sid}/dismiss`, { auth: true }); } catch { /* best effort: never mask the real failure */ }
        }
      }
    },
  },

  {
    id: "editorial.storm-sends-refuse-bad-requests",
    title: "On dev, the storm buttons that email subscribers or call the storm scan (approve, scan, course-change publish/ignore/simulate) refuse requests without the key and reject unknown events — the sends themselves are not exercised",
    covers: ["POST /api/storm-alerts/:id/approve", "POST /api/storm-scan", "POST /api/storm-diversions/:id/publish", "POST /api/storm-diversions/:id/ignore", "POST /api/storm-diversions/simulate"],
    modes: ["dev"],
    devOnlyBecause: "it sends POST requests (refusal paths only); prod is read-only",
    run: async (t) => {
      await refusesWithoutKey(t, "POST", `/api/storm-alerts/${NOBODY}/approve`);
      await refusesWithoutKey(t, "POST", "/api/storm-scan");
      await refusesWithoutKey(t, "POST", `/api/storm-diversions/${NOBODY}/publish`);
      await refusesWithoutKey(t, "POST", `/api/storm-diversions/${NOBODY}/ignore`);
      await refusesWithoutKey(t, "POST", "/api/storm-diversions/simulate", {});
      // with the key, only paths that cannot send: an event that does not exist
      const pub = await t.send("POST", `/api/storm-diversions/${NOBODY}/publish`, { auth: true });
      t.ok(pub.status === 404 && pub.json?.success === false, `publishing a course change that does not exist should be 404: ${pub.describe()}`);
      t.success(await t.send("POST", `/api/storm-diversions/${NOBODY}/ignore`, { auth: true })); // only flips a PENDING event: a no-op
      const sim = await t.send("POST", "/api/storm-diversions/simulate", { auth: true, body: {} });
      t.ok((sim.status === 400 || sim.status === 404) && sim.json?.success === false, `a simulated course change with no storm should be refused: ${sim.describe()}`);
      t.observe("simulate on dev", sim.status === 400 ? "enabled" : "disabled", "exact");
    },
  },

  {
    id: "editorial.newsletter-brief-queue-writes-refuse",
    title: "On dev, the newsletter generate/edit/send/notify, legacy send, brief run, and the brief's resolve/approve/dismiss/close/keep buttons refuse requests without the key, reject empty or unknown input, and do nothing to items that do not exist",
    covers: ["POST /api/newsletter/draft", "POST /api/newsletter/draft/update", "POST /api/newsletter/send", "POST /api/newsletter/notify", "POST /api/send-newsletter",
      "POST /api/brief/run", "POST /api/actions", "POST /api/actions/:id/resolve", "POST /api/proposals/:id/approve", "POST /api/proposals/:id/dismiss", "POST /api/tasks/:id/close", "POST /api/tasks/:id/keep",
      "GET /api/newsletter/draft"],
    modes: ["dev"],
    devOnlyBecause: "it sends POST requests (refusal and no-op paths only); prod is read-only",
    run: async (t) => {
      for (const p of ["/api/newsletter/draft", "/api/newsletter/draft/update", "/api/newsletter/send", "/api/newsletter/notify", "/api/send-newsletter", "/api/brief/run",
        "/api/actions", `/api/actions/${NOBODY}/resolve`, `/api/proposals/${NOBODY}/approve`, `/api/proposals/${NOBODY}/dismiss`, `/api/tasks/${NOBODY}/close`, `/api/tasks/${NOBODY}/keep`]) {
        await refusesWithoutKey(t, "POST", p);
      }

      // Filing an action for Mark (POST /api/actions, 2026-10-08) refuses a typeless, titleless or
      // badly named request even WITH the key: nothing is stored and no notification goes out.
      for (const body of [{}, { type: "release_gate" }, { type: "release_gate", title: "short" }, { type: "bad type!", title: "A sentence long enough to pass" }]) {
        const r = await t.send("POST", "/api/actions", { auth: true, body });
        t.equal(r.status, 400, `filing an action with ${JSON.stringify(body)} must be refused`);
      }

      // Newsletter edit: an edit that would empty the issue is refused BEFORE anything is saved.
      // Should that ever answer 200, the original fields are put back at once and the check fails.
      for (const lang of ["en", "es"]) {
        const before = t.success(await t.get(`/api/newsletter/draft?lang=${lang}`, { auth: true })).draft;
        const r = await t.send("POST", `/api/newsletter/draft/update?lang=${lang}`, { auth: true, body: { letter: "", quickHits: [], removeBooking: true } });
        if (r.status === 200 && before) {
          await t.send("POST", `/api/newsletter/draft/update?lang=${lang}`, {
            auth: true,
            body: { letter: before.letter ?? "", quickHits: before.quickHits ?? [], ...(before.booking ? { bookingHeadline: before.booking.headline, bookingBody: before.booking.body } : {}) },
          });
        }
        const expected = !before ? [404] : before.status === "pending" ? [400] : [409];
        t.ok(expected.includes(r.status) && r.json?.success === false,
          `an edit that would empty the ${lang.toUpperCase()} newsletter should be refused (${expected.join("/")}): ${r.describe()}`);
      }

      // Legacy composer send: refused on bad input before any subscriber is read
      const s1 = await t.send("POST", "/api/send-newsletter", { auth: true, body: {} });
      t.ok(s1.status === 400 && /subject/i.test(s1.json?.error || ""), `the legacy newsletter send with no subject should be refused (400): ${s1.describe()}`);
      // An EMPTY story list, not an unknown story id: the unknown-id path reads the story store and
      // only a story-matching bug stands between it and an email to every confirmed dev subscriber.
      // The empty list is refused before anything is read.
      const s2 = await t.send("POST", "/api/send-newsletter", { auth: true, body: { subject: "e2e-fixture", storyIds: [] } });
      t.ok(s2.status === 400 && /at least one story/i.test(s2.json?.error || ""), `the legacy newsletter send with no stories should be refused (400): ${s2.describe()}`);

      // The brief's buttons on items that do not exist: answered, and nothing changes
      t.success(await t.send("POST", `/api/actions/${NOBODY}/resolve`, { auth: true, body: { status: "dismissed" } }), "ok");
      const ap = t.success(await t.send("POST", `/api/proposals/${NOBODY}/approve`, { auth: true }));
      t.equal(ap.implemented, false, "approving a proposal that does not exist implemented something");
      t.success(await t.send("POST", `/api/proposals/${NOBODY}/dismiss`, { auth: true }));
      t.success(await t.send("POST", `/api/tasks/${NOBODY}/close`, { auth: true }));
      t.success(await t.send("POST", `/api/tasks/${NOBODY}/keep`, { auth: true }));
    },
  },
];
