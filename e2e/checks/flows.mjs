// e2e/checks/flows.mjs — cross-feature journeys: the site as ONE system, not features.
//
// Mark, 2026-10-04: "think of the website holistically, not as separate features. every system
// affects every other system." Each check here walks the path a visitor (or Mark) really takes,
// from one feature into the next, and checks that every hand-off lands on something real. The
// feature files (storm, ships, news, weather…) each prove their own piece; these prove the joins.
//
// Incidents and risks these checks exist for:
//   2026-09-26 → 10-04  The homepage Storm Watch panel went dark for 8 days (the list answered 500
//               whenever a storm was public). The panel, the detail page, the Track-this-ship
//               sign-up and the tracker are four features; a visitor uses them as one path.
//   2026-10-02  The weather SEARCH path never showed the synopsis while the TILES did: two roads
//               to one page, only one was walked. Same shape here: the Spanish homepage tiles and
//               the tracker's arrival-weather card are roads into the forecast nobody walked.
//   2026-10-0x  The storm emails' "See all storm warnings" button opened /storm-watch.html with no
//               ?id= and showed "No advisory selected" (prod). The release candidate lists every
//               active storm there instead; flows.storm-email-links FAILS on prod until it ships.
//   2026-10-08  (found by this gate) prod's Isaias listed ten ships "sailing" 2026-01-01 – 2027-12-31:
//               ship_deployments seasons shown as sailing dates. Two views that agree can both be
//               wrong, so each sailing row is checked for sanity as well as for agreement.
//   risk        A newsletter or email link is built by one feature and served by another; nobody
//               notices a dead link until a subscriber clicks it.
//   risk        The same ship is shown by four features (storm pages, Mark's storm dashboard, the
//               tracker, the port cams); a disagreement between them is invisible to each alone.
//   risk        Mark's to-do list (public.actions, shown in the brief) and the storm / course-change
//               queues are separate tables: a draft with no to-do item is a storm nobody approves;
//               a to-do item for a decided storm is a button that acts on the wrong thing.
//
// SAFETY (every GET below was read for side effects before it was used on prod):
//   • GET /api/wms/position is NEVER called here (it can buy a Live-AIS position); the tracker's
//     knowledge of a ship is read from /api/wms/ships and /api/wms/health, which are free reads.
//   • /api/go/:id (records an affiliate click) and /api/unsubscribe (unsubscribes) are links in the
//     newsletter / storm email: their presence and shape are checked, they are NEVER requested.
//     The gear link is checked through /api/affiliate-items instead (the item /api/go would use).
//   • /api/newsletter/email and /api/newsletter/draft are token-gated READS of the saved draft
//     (no model call, no send). /api/storm-alerts, /api/actions, /api/storm-diversions/log are
//     token-gated reads. /api/weather?place= is asked for ONE fixed place (Miami, a homepage tile)
//     in English and Spanish: its synopsis is a model call cached six hours per place+language.
//   • The only request leaving our own boxes is the newsletter video's thumbnail on i.ytimg.com
//     (the exact image the email shows its readers) — a read of a public image, once per language.
//   • flows.storm-email-links also READS ONE FILE on the box it runs on: the deployed storm-email
//     template (server/src/lib/storm-email-content.ts), to know the links the email really carries.
//   • Load: every check samples (first / last / a few between) and stays under ~40 requests.
import { readFileSync } from "node:fs";
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";
import { storySlug } from "./news.mjs";

const SITE = "https://stillafloatcruising.com";
const lc = (s) => String(s ?? "").trim().toLowerCase();
/** "Carnival Cruise Line", "Carnival Cruises" and "Carnival" are one line (same rule as ships.mjs). */
const lineKey = (s) => lc(s).replace(/&/g, "and").replace(/\b(cruise lines?|cruises|cruise|international|line)\b/g, "").replace(/[^a-z0-9]+/g, "");
const decode = (s) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const norm = (s) => decode(s).toLowerCase();
/** first, last and up to n-2 evenly spaced in between */
const spread = (arr, n) => {
  if (arr.length <= n) return [...arr];
  const idx = new Set([0, arr.length - 1]);
  for (let i = 1; idx.size < n; i++) idx.add(Math.round((i * (arr.length - 1)) / (n - 1)));
  return [...idx].sort((a, b) => a - b).map((i) => arr[i]);
};
const pathOf = (u) => { try { const x = new URL(u, SITE); return x.pathname + x.search; } catch { return String(u); } };
const langOfPath = (p) => (String(p).startsWith("/es/") ? "es" : "en");
const ES_WORDS = /\b(el|la|los|las|del|que|con|para|por|una|está|están|tormenta|huracán|barcos|cruceros|puede|podría|sobre|hacia|millas|oeste|norte|tu|su)\b/gi;
const EN_WORDS = /\b(the|and|of|with|for|is|are|storm|hurricane|ships|cruise|could|may|about|toward|miles|west|north|your|its)\b/gi;
const readsSpanish = (s) => (String(s).match(ES_WORDS) || []).length > (String(s).match(EN_WORDS) || []).length;

/**
 * A journey has many legs; the harness stops at the first failed assertion. So each journey
 * collects every broken leg and fails ONCE at the end with all of them — one broken leg must not
 * hide the next one. Messages are names, ids, paths and counts only (never personal data).
 */
function legs(t) {
  const broken = [];
  return {
    check(cond, msg) { if (!cond) broken.push(msg); return Boolean(cond); },
    done(what) {
      t.ok(broken.length === 0, `${what} — ${broken.length} broken: ${broken.slice(0, 10).join(" | ")}${broken.length > 10 ? ` | …and ${broken.length - 10} more` : ""}`);
    },
  };
}

/** The "Track this ship" link a storm page builds: [prefix, from-tag] from its trackHref(). */
function trackHrefParts(html) {
  const m = /function trackHref\(sh,s\)\{[\s\S]*?return "([^"]+)"\+encodeURIComponent\(sh\.ship_name\)\+"([^"]+)"/.exec(html);
  return m ? { prefix: m[1], from: /from=([^&"]+)/.exec(m[2])?.[1] || "" } : null;
}
const stormLabel = (s) => `${s.classification ? `${s.classification} ` : ""}${s.name || ""}`.trim();

/**
 * What a visitor reads in one row of a storm's "affected sailings" (homepage list, storm page
 * table, Mark's dashboard): a ship, her line, real dates in order, and a span that is a SAILING.
 * Two equal-but-broken views (both with no dates, both with a two-year "sailing") agree with each
 * other, so every cross-view comparison below is only worth something if each row is sane too.
 * The longest real cruises we list are grand voyages of ~120 nights; a longer span is a ship's
 * season or a placeholder (seen on prod 2026-10-08: ship_deployments seasons "2026-01-01 –
 * 2027-12-31" shown as sailing dates under Isaias — storm-sailings.deploymentsForStorm).
 */
const MAX_SAILING_DAYS = 120;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function sailingProblems(v, stormName) {
  const who = `"${stormName}": the sailing of "${v?.ship_name || "(no name)"}"`;
  const out = [];
  if (!v || typeof v !== "object") return [`"${stormName}": an affected sailing is not a record`];
  if (!String(v.ship_name || "").trim()) out.push(`"${stormName}": an affected sailing has no ship name`);
  if (!String(v.cruise_line || "").trim()) out.push(`${who} has no cruise line`);
  if (typeof v.trackable !== "boolean") out.push(`${who} does not say whether she can be tracked`);
  if (!ISO_DAY.test(String(v.start_date)) || !ISO_DAY.test(String(v.end_date))) { out.push(`${who} has no readable dates (${v.start_date} – ${v.end_date})`); return out; }
  const days = (Date.parse(`${v.end_date}T00:00:00Z`) - Date.parse(`${v.start_date}T00:00:00Z`)) / 86_400_000;
  if (!(days >= 0)) out.push(`${who} ends before it starts (${v.start_date} – ${v.end_date})`);
  else if (days > MAX_SAILING_DAYS) out.push(`${who} is shown as ${v.start_date} – ${v.end_date} (${Math.round(days)} days) — that is a season or a placeholder, not a sailing`);
  return out;
}

/** The deployed storm-email template, read on the box the sweep runs on (null if unreadable). */
const AGENT_DIR = process.env.SAF_E2E_AGENT_DIR || "/root/saf-full";
function emailTemplate() {
  try { return readFileSync(`${AGENT_DIR}/server/src/lib/storm-email-content.ts`, "utf8"); } catch { return null; }
}

async function publicStorms(t) {
  const sw = t.success(await t.get("/api/storm-watch"));
  t.ok(Array.isArray(sw.systems), "the public storm list has no systems array");
  return sw;
}

export default [
  // ───────────────────────────────────────────────────────────────────────────────────────────
  // FLOW 1 — homepage → Storm Watch panel → "More details" → storm page → "Track this ship"
  //          → track-ship sign-up → "See where she is now" → Where's My Ship (tracker knows her).
  // Steps, exactly as a visitor walks them (English from /, Spanish from /es/):
  //   1. the homepage loads and its panel asks /api/storm-watch (the same answer we read);
  //   2. each storm's "More details" link (EN: s.detail_url, ES: /es/storm-watch.html?id=) opens a
  //      page in the reader's language that asks /api/storm-watch/<id>, and that answer is the
  //      same storm as the panel showed (headline, class, grounds, sailings);
  //   3. a trackable sailing's "Track this ship" link opens /track-ship.html (ES: /es/…) whose
  //      "See where she is now" link opens the tracker page in the same language;
  //   4. the tracker's own lists know the ship: in the search list, tracked, followed live, held.
  // Requires a public storm on BOTH boxes (UNTESTABLE otherwise — a storm-free week cannot show
  // that this path works; dev has Isaias approved since 2026-10-07).
  {
    id: "flows.storm-visitor-journey",
    title: "A visitor can follow a storm from the homepage panel to its details page, press Track this ship and reach the tracker for a ship it is following (English and Spanish)",
    covers: ["flow:storm-visitor-journey", "page /index.html", "page /es/index.html", "GET /api/storm-watch", "GET /api/storm-watch/:id",
      "page /storm-watch.html", "page /es/storm-watch.html", "page /track-ship.html", "page /es/track-ship.html",
      "GET /api/wms/ships", "GET /api/wms/health", "page /wheres-my-ship.html", "page /es/wheres-my-ship.html"],
    modes: ["dev", "prod"],
    incident: "2026-09-26: the homepage Storm Watch panel was dark for 8 days while a storm was live",
    run: async (t) => {
      const L = legs(t);
      const sw = await publicStorms(t);
      t.require(sw.systems.length > 0,
        "no storm is public, so the homepage panel, storm page and Track-this-ship path do not exist for a visitor to walk (dev: approve the storm fixture)");

      // 1. the homepage panels (EN + ES)
      const home = {};
      for (const [lang, path] of [["en", "/"], ["es", "/es/"]]) {
        const html = t.html(await t.get(path), { mustContain: ['id="storm-watch"', 'fetch("/api/storm-watch")'] });
        t.equal(H.htmlLang(html).slice(0, 2), lang, `the ${lang} homepage language`);
        const more = /var moreBtn=([^\n]*)/.exec(html)?.[1] || "";
        t.ok(more, `the ${lang} homepage panel no longer builds a "More details" link`);
        const lit = /(\/(?:es\/)?storm-watch\.html\?id=)/.exec(more)?.[1] || "";
        const track = trackHrefParts(html);
        t.ok(track, `the ${lang} homepage panel no longer builds a Track-this-ship link`);
        home[lang] = { usesDetailUrl: /s\.detail_url/.test(more), lit, track };
      }

      // 2. each storm: panel link → page in the reader's language → the same storm's detail data
      const storms = spread(sw.systems, 3);
      const detailPage = {};
      for (const s of storms) {
        // what the panel renders: headline, "class · grounds", the "what this means for you"
        // paragraph of body_md (para() in index.html), the ship list and the More-details link.
        // A field dropped from the list query renders as a blank panel, not an error.
        t.fields(s, ["id", "name", "headline", "classification", "grounds_label", "body_md", "updated", "detail_url"], `public storm ${s?.name}`);
        t.ok(Array.isArray(s.sailings), `"${s.name}": the public list has no sailings array`);
        const para = String(s.body_md).replace(/\*\*/g, "").split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
        L.check((para.find((p) => /what this means/i.test(p)) || para[0] || "").length >= 40, `"${s.name}": the homepage panel's "what this means for you" text is missing or a stub`);
        const bad = s.sailings.flatMap((v) => sailingProblems(v, s.name));
        L.check(bad.length === 0, `${bad.length} affected-sailing row(s) a visitor cannot trust: ${bad.slice(0, 3).join("; ")}${bad.length > 3 ? "; …" : ""}`);
        const d = t.success(await t.get(`/api/storm-watch/${encodeURIComponent(s.id)}`)).system;
        t.fields(d, ["id", "headline", "updated"], `storm "${s.name}" detail`);
        // the storm page's "What this means for you" card renders detail_md || body_md
        L.check(String(d.detail_md || d.body_md || "").trim().length >= 80, `"${s.name}": the storm page's "What this means for you" card would be empty`);
        L.check(d.id === s.id, `"${s.name}": the details answer is a different storm (${d.id})`);
        for (const f of ["headline", "classification", "grounds_label", "updated"]) {
          L.check(d[f] === s[f], `"${s.name}": the homepage panel and the storm page disagree on ${f}`);
        }
        const key = (v) => `${lc(v.ship_name)}|${v.start_date}|${v.end_date}|${v.trackable}`;
        L.check((d.sailings || []).map(key).sort().join(",") === (s.sailings || []).map(key).sort().join(","),
          `"${s.name}": the panel lists ${s.sailings?.length} affected sailings and the storm page ${d.sailings?.length}, or not the same ones`);
        for (const lang of ["en", "es"]) {
          const h = home[lang];
          const link = h.usesDetailUrl ? (s.detail_url || `${h.lit}${s.id}`) : `${h.lit}${encodeURIComponent(s.id)}`;
          const want = lang === "es" ? "/es/storm-watch.html?id=" : "/storm-watch.html?id=";
          L.check(link === `${want}${s.id}` || link === `${want}${encodeURIComponent(s.id)}`,
            `the ${lang} homepage's "More details" for "${s.name}" opens ${link.slice(0, 60)} — not the ${lang} storm page for that storm`);
          if (!detailPage[lang]) {
            const html = t.html(await t.get(link), { mustContain: ['fetch("/api/storm-watch/"+encodeURIComponent(id))'] });
            L.check(H.htmlLang(html).slice(0, 2) === lang, `the ${lang} storm page ${pathOf(link)} is not in ${lang}`);
            detailPage[lang] = trackHrefParts(html);
            L.check(Boolean(detailPage[lang]), `the ${lang} storm page no longer builds Track-this-ship links`);
          }
        }
      }
      for (const lang of ["en", "es"]) {
        const want = lang === "es" ? "/es/track-ship.html?ship=" : "/track-ship.html?ship=";
        L.check(home[lang].track?.prefix === want, `the ${lang} homepage's Track this ship opens ${home[lang].track?.prefix} instead of ${want}`);
        L.check(detailPage[lang]?.prefix === want, `the ${lang} storm page's Track this ship opens ${detailPage[lang]?.prefix} instead of ${want}`);
      }

      // 3 + 4. Track this ship → sign-up page → tracker; the tracker knows her
      const trackable = sw.systems.flatMap((s) => (s.sailings || []).filter((v) => v.trackable).map((v) => ({ v, s })));
      const reg = t.success(await t.get("/api/wms/ships"), "ok");
      t.ok(Array.isArray(reg.ships) && reg.ships.length > 0, "the tracker's ship list is empty");
      const byName = new Map(reg.ships.map((x) => [lc(x.name), x]));
      // a ship the tracker CAN follow must get the button (trackable comes from the tracker's
      // in-memory registry, tracked from the ships table — a stale registry hides every button)
      const notOffered = [...new Set(sw.systems.flatMap((s) => (s.sailings || []).filter((v) => !v.trackable && byName.get(lc(v.ship_name))?.tracked).map((v) => v.ship_name)))];
      t.ok(trackable.length > 0 || notOffered.length === 0, `no storm offers Track this ship at all, yet the tracker can follow ${notOffered.length} of the storms' ships (e.g. ${notOffered.slice(0, 3).join(", ")})`);
      L.check(notOffered.length === 0, `${notOffered.length} storm ship(s) the tracker can follow have no Track-this-ship button: ${notOffered.slice(0, 4).join(", ")}`);
      t.require(trackable.length > 0, "no public storm has a trackable sailing, so no Track-this-ship button exists to follow");
      const picks = [...new Map(spread(trackable, 2).map((x) => [lc(x.v.ship_name), x])).values()];
      const held = t.success(await t.get("/api/wms/health"), "ok");
      t.ok(Array.isArray(held.ships), "the tracker health answer has no ships array");
      const heldBy = new Map(held.ships.map((x) => [lc(x.name), x]));
      for (const { v, s } of picks) {
        for (const lang of ["en", "es"]) {
          const p = detailPage[lang] || home[lang].track;
          const url = `${p.prefix}${encodeURIComponent(v.ship_name)}&from=${p.from}&storm=${encodeURIComponent(stormLabel(s))}`;
          const html = t.html(await t.get(url), { mustContain: ["/api/wms/track-signup", 'id="liveLink"'] });
          L.check(H.htmlLang(html).slice(0, 2) === lang, `the ${lang} Track-this-ship page for ${v.ship_name} is not in ${lang}`);
          // the sign-up records the follower's language: it picks the language of every watch
          // email she gets afterwards. A Spanish page sending lang 'en' mails Spanish readers in English.
          const signupLang = /fetch\('\/api\/wms\/track-signup'[\s\S]{0,400}?lang:\s*'([a-z]{2})'/.exec(html)?.[1];
          L.check(signupLang === lang, `the ${lang} Track-this-ship page signs followers up as "${signupLang}" — their ship emails would come in the wrong language`);
          const tracker = /var trackerUrl = '([^']+)'\s*\+\s*\(ship \? '\?ship='/.exec(html)?.[1];
          const wantTracker = lang === "es" ? "/es/wheres-my-ship.html" : "/wheres-my-ship.html";
          L.check(tracker === wantTracker, `the ${lang} Track-this-ship page's "See where she is now" opens ${tracker} instead of ${wantTracker}`);
        }
        const r = byName.get(lc(v.ship_name));
        L.check(r && r.tracked, `"${v.ship_name}" has a Track-this-ship button on "${s.name}" but the tracker's ship search does not know her`);
        L.check(r?.live, `"${v.ship_name}" is in "${s.name}"'s path but the tracker is not following her`);
        // "held" means a position the tracker can draw: hasFix (lat/lon), not just a name in its cache
        L.check(heldBy.get(lc(v.ship_name))?.hasFix === true, `"${v.ship_name}" is followed but the tracker has no position for her — "See where she is now" opens an empty map`);
        L.check(!r || lineKey(r.cruiseLine) === lineKey(v.cruise_line), `"${v.ship_name}" sails for ${v.cruise_line} on the storm page but ${r?.cruiseLine} in the tracker`);
      }
      // the tracker page each sign-up page opens reads ?ship= and selects her
      for (const [lang, p] of [["en", "/wheres-my-ship.html"], ["es", "/es/wheres-my-ship.html"]]) {
        const html = t.html(await t.get(`${p}?ship=${encodeURIComponent(picks[0].v.ship_name)}`), { mustContain: ["/js/wheres-my-ship.js"] });
        L.check(H.htmlLang(html).slice(0, 2) === lang, `${p} is not in ${lang}`);
      }
      const js = await t.get("/js/wheres-my-ship.js");
      t.status(js, 200);
      L.check(/get\(['"]ship['"]\)/.test(js.text) && /selectShip\(deepShip\)/.test(js.text), "the tracker no longer opens the ship named in its link (?ship=)");
      L.done("the storm visitor journey");
      t.observe("public storms walked", storms.length, "info");
      t.observe("ships followed from Track this ship", picks.length, "info");
      t.observe("homepage detail-link forms", `${home.en.lit}|${home.es.lit}`);
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // FLOW 2 — a storm ALERT EMAIL (and the all-clear, which carries the same links), English and
  // Spanish. The email is built in server/src/lib/storm-email-content.ts and is not served over
  // HTTP, so this check reads that file AS DEPLOYED ON THE BOX THE SWEEP RUNS ON (a read-only file
  // read of /root/saf-full, or $SAF_E2E_AGENT_DIR) and follows the paths it builds — so a template
  // that starts linking a page that does not exist fails here even while the pages themselves work.
  // Unreadable (a sweep run off the box) → UNTESTABLE. The links it builds today:
  //   • each pinned ship → <base>/wheres-my-ship.html?ship=<name>  (ES: /es/wheres-my-ship.html)
  //   • "Track your ship"         → <base>/wheres-my-ship.html     (ES: /es/…)
  //   • "See all storm warnings"  → <base>/storm-watch.html, NO ?id= (ES: /es/storm-watch.html)
  //   • footer Unsubscribe        → /api/unsubscribe?email=&sig=  — NEVER requested (it unsubscribes).
  // The ships listed are the storm's pins (storm_tracked_ships). Their count is read from Mark's
  // course-change log (live_pins); the pins are the storm page's sailings plus ships the grounds
  // still justify, so pins ≥ the ships the storm page lists. Every ship the page lists must be one
  // the tracker's search knows, or her email link dead-ends.
  // KNOWN on prod until the 2026-10-08 promotion: the warnings button opens a page that says
  // "No advisory selected". This check stays strict and FAILS on prod until then.
  {
    id: "flows.storm-email-links",
    title: "Every link in a storm alert email (English and Spanish) opens a page with the storm or the ship on it — including the See all storm warnings button",
    covers: ["email:storm-alert-links", "GET /api/storm-watch", "GET /api/storm-diversions/log", "GET /api/wms/ships",
      "page /wheres-my-ship.html", "page /es/wheres-my-ship.html", "page /storm-watch.html", "page /es/storm-watch.html"],
    modes: ["dev", "prod"],
    incident: "storm emails' 'See all storm warnings' button showed 'No advisory selected' (prod, until the release candidate ships)",
    run: async (t) => {
      const L = legs(t);
      const sw = await publicStorms(t);
      t.require(sw.systems.length > 0, "no storm is public, so no storm alert email exists whose links could be followed (dev: approve the storm fixture)");

      // the email's ship list (pins) holds at least every ship the storm page lists
      const log = t.success(await t.get("/api/storm-diversions/log?days=30", { auth: true }));
      t.ok(Array.isArray(log.storms), "Mark's course-change log has no storms list");
      const pins = new Map(log.storms.map((s) => [s.id, s]));
      const reg = t.success(await t.get("/api/wms/ships"), "ok");
      t.ok(Array.isArray(reg.ships) && reg.ships.length > 0, "the tracker's ship list is empty");
      const byName = new Map(reg.ships.map((x) => [lc(x.name), x]));
      let emailed = 0;
      for (const s of sw.systems) {
        const ships = [...new Set((s.sailings || []).map((v) => lc(v.ship_name)))];
        const p = pins.get(s.id);
        L.check(p, `"${s.name}" is public but missing from the live storms in Mark's course-change log — its email would list no ships`);
        if (p) L.check(p.live_pins >= ships.length, `"${s.name}": the storm page lists ${ships.length} ships but only ${p.live_pins} are pinned, so the email lists fewer ships than the page`);
        for (const n of ships) L.check(byName.has(n), `"${s.name}": the email links "${n}" to the tracker, which has no ship by that name`);
        emailed += Math.min(ships.length, 40); // SHIP_LIST_MAX
      }

      // the pages the links open
      const sample = [...new Set(sw.systems.flatMap((s) => (s.sailings || []).map((v) => v.ship_name)))][0];
      t.ok(sample, "no public storm lists a ship");
      // The links as the email on THIS box builds them: read from the box's own deployed template
      // (the email is not served over HTTP). Hard-coding them here would keep passing after the
      // template changed to a path that does not exist.
      const tpl = emailTemplate();
      t.require(tpl, `the storm email template deployed on this box (${AGENT_DIR}/server/src/lib/storm-email-content.ts) could not be read, so the email's links cannot be known — run the sweep on the box (site-e2e.sh)`);
      t.ok(/\?ship=\$\{encodeURIComponent\(shipName\)\}/.test(tpl), "the storm email no longer links each ship to the tracker by name (?ship=)");
      t.ok(/btn\(trackerUrl\(base, lang\)/.test(tpl) && /btn\(warningsUrl\(base, lang\)/.test(tpl), "the storm email lost its Track-your-ship or See-all-storm-warnings button");
      t.ok(/trackerUrl\(base, lang, s\.ship_name\)/.test(tpl), "the storm email's ship list no longer links each ship to the tracker");
      for (const lang of ["en", "es"]) {
        const block = new RegExp(`\\b${lang}:\\s*\\{[\\s\\S]*?trackerPath:\\s*"([^"]+)",\\s*warningsPath:\\s*"([^"]+)"`).exec(tpl);
        t.ok(block, `the ${lang} storm email's tracker and warnings links cannot be read from the template`);
        const [, tracker, warnings] = block;
        t.observe(`${lang} storm email link paths`, `${tracker}|${warnings}`);
        for (const link of [`${tracker}?ship=${encodeURIComponent(sample)}`, tracker]) {
          const html = t.html(await t.get(link), { mustContain: ["/js/wheres-my-ship.js", 'id="ship-input"'] });
          L.check(H.htmlLang(html).slice(0, 2) === lang, `the ${lang} email's tracker link ${link} opens a page not in ${lang}`);
        }
        // "See all storm warnings": no ?id= — the page must list the active storms, not give up
        const html = t.html(await t.get(warnings));
        L.check(H.htmlLang(html).slice(0, 2) === lang, `the ${lang} email's warnings button opens a page not in ${lang}`);
        L.check(!/No advisory selected/i.test(html),
          `the ${lang} email's "See all storm warnings" button opens ${warnings}, which says "No advisory selected" instead of listing the ${sw.systems.length} active storm(s)`);
        const noId = /if\(!id\)\{[\s\S]{0,400}?fetch\("\/api\/storm-watch"\)/.test(html);
        L.check(noId, `the ${lang} email's "See all storm warnings" page (${warnings} with no storm chosen) does not load the active-storm list`);
        if (noId) L.check(html.includes(`href="${warnings}?id=`), `the ${lang} warnings list does not link each storm to its ${lang} storm page`);
      }
      const js = await t.get("/js/wheres-my-ship.js");
      t.status(js, 200);
      L.check(/get\(['"]ship['"]\)/.test(js.text), "the tracker ignores the ship named in an email link (?ship=)");
      L.done("the storm alert email's links");
      t.observe("ships the storm emails link to", emailed, "info");
      t.observe("course-change log storms keys", log.storms[0] ? keysOf(log.storms[0]) : "(none)", log.storms[0] ? "exact" : "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // FLOW 3 — a SPANISH reader and a live storm. Steps: /es/ homepage panel → "Más detalles" →
  // /es/storm-watch.html?id= . Both pages are in Spanish around the storm, but the storm itself
  // (headline and "what this means for you") comes from /api/storm-watch, which has no Spanish
  // text: storm_alerts has no _es fields and the endpoints take no lang. This check reads exactly
  // the URL and fields each Spanish page renders and asks whether that text reads as Spanish.
  // (The Spanish storm EMAIL has the same gap — its body is the English body_md — but the email
  // is not observable over HTTP; see the report.)
  {
    id: "flows.storm-spanish-reader",
    title: "A Spanish reader sees the storm warning itself in Spanish on the Spanish homepage panel and the Spanish storm page",
    covers: ["flow:storm-spanish-reader", "page /es/index.html", "page /es/storm-watch.html", "GET /api/storm-watch", "GET /api/storm-watch/:id"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const L = legs(t);
      const home = t.html(await t.get("/es/"), { mustContain: ['id="storm-watch"'] });
      const page = t.html(await t.get("/es/storm-watch.html"), { mustContain: ["/api/storm-watch/"] });
      t.equal(H.htmlLang(home).slice(0, 2), "es", "the Spanish homepage language");
      t.equal(H.htmlLang(page).slice(0, 2), "es", "the Spanish storm page language");
      // the exact requests the Spanish pages make, and the fields they render
      const listUrl = /fetch\("(\/api\/storm-watch(?:\?[^"]*)?)"\)/.exec(home)?.[1];
      t.ok(listUrl, "the Spanish homepage no longer asks for the storm list");
      const detailSuffix = /fetch\("\/api\/storm-watch\/"\+encodeURIComponent\(id\)(?:\+"([^"]*)")?\)/.exec(page);
      t.ok(detailSuffix, "the Spanish storm page no longer asks for a storm's details");
      const field = (html, base) => (new RegExp(`s\\.${base}_es\\b`).test(html) ? `${base}_es` : base);
      const sw = t.success(await t.get(listUrl));
      t.ok(Array.isArray(sw.systems), "the storm list has no systems array");
      t.require(sw.systems.length > 0, "no storm is public, so there is no storm text for a Spanish reader to read (dev: approve the storm fixture)");
      for (const s of spread(sw.systems, 3)) {
        const panelText = `${s[field(home, "headline")] || s.headline || ""} ${s[field(home, "body_md")] || s.body_md || ""}`.slice(0, 600);
        L.check(readsSpanish(panelText), `"${s.name}": the Spanish homepage panel shows the storm in English ("${decode(s.headline).slice(0, 70)}")`);
        const d = t.success(await t.get(`/api/storm-watch/${encodeURIComponent(s.id)}${detailSuffix[1] || ""}`)).system;
        t.fields(d, ["id", "headline"], `storm "${s.name}" detail`);
        const shown = `${d[field(page, "headline")] || d.headline} ${d[field(page, "detail_md")] || d[field(page, "body_md")] || d.detail_md || d.body_md || ""}`.slice(0, 600);
        L.check(readsSpanish(shown), `"${s.name}": the Spanish storm page shows the storm's headline and "Lo que esto significa para ti" in English`);
      }
      L.done("Spanish storm text");
      t.observe("Spanish list request", listUrl);
      t.observe("Spanish detail request suffix", detailSuffix[1] || "");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // FLOW 4 — homepage news → story page → its related stories, its cruise-line hub, the news feed,
  // the gear and Work-with-Mark links → the Spanish twin of the same story. Steps:
  //   1. / and /es/ load js/news.js, which links each card to /news/<slug>.html (ES: /es/news/…);
  //   2. for a spread of homepage stories (first, middle, last; skipping any approved under 1.25 h
  //      ago — the hourly prerender may not have written them yet) the English page exists, IS that
  //      story (h1 = feed title, canonical = itself) and names its Spanish twin, which exists, is
  //      Spanish (h1 = the Spanish feed title) and names the English page back;
  //   (up to 4 stories: first, last and two between — about 30 requests in all)
  //   3. for one story (the first sampled story that links a cruise-line page, else the first) every
  //      same-site link a reader can press is followed (related ≤3, hubs ≤2, feed, gear, Work with Mark): each opens a real page in the same language; the hub and the
  //      feed list the story; the Spanish page's links are the Spanish twins of the English links.
  {
    id: "flows.news-reader-journey",
    title: "A homepage news card opens its story, whose related stories, cruise-line page, feed and gear links all work, and whose Spanish twin is the same story in Spanish",
    covers: ["flow:news-reader-journey", "page /index.html", "page /es/index.html", "GET /api/homepage-feed", "GET /api/affiliate-items", "page /work-with-mark.html", "page /es/work-with-mark.html"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const L = legs(t);
      for (const [lang, path] of [["en", "/"], ["es", "/es/"]]) {
        const html = t.html(await t.get(path), { mustContain: ['id="news-container"'] });
        t.ok(H.scripts(html).some((s) => /(^|\/)js\/news\.js$/.test(s)), `the ${lang} homepage no longer loads the news cards (js/news.js)`);
      }
      const js = await t.get("/js/news.js");
      t.status(js, 200);
      t.ok(/'\/es\/news\/'\s*:\s*'\/news\/'/.test(js.text) && /\/api\/homepage-feed/.test(js.text), "the homepage news cards no longer link to /news/<story>.html (EN) and /es/news/<story>.html (ES)");

      const en = t.success(await t.get("/api/homepage-feed"));
      const es = t.success(await t.get("/api/homepage-feed?lang=es"));
      t.ok(Array.isArray(en.stories) && Array.isArray(es.stories), "a homepage feed has no stories array");
      t.atLeast(en.stories.length, 1, "stories on the homepage");
      const esById = new Map(es.stories.map((s) => [s.id, s]));
      const ready = en.stories.filter((s) => s.id && Number.isFinite(Date.parse(s.approvedAt)) && (t.now() - Date.parse(s.approvedAt)) / 3_600_000 > 1.25);
      t.require(ready.length > 0, "every homepage story was approved in the last 75 minutes, before the hourly prerender — re-run in an hour");
      const picks = spread(ready, 4);

      const gearOf = new Map(); // gear page → how many sampled stories link it
      let first = null; // the story whose every link is followed: the first pick with a cruise-line page, else the first pick
      for (const s of picks) {
        const slug = storySlug(s.id);
        const enPath = `/news/${slug}.html`; const esPath = `/es/news/${slug}.html`;
        const enHtml = t.html(await t.get(enPath));
        L.check(H.htmlLang(enHtml).slice(0, 2) === "en", `${enPath} is not in English`);
        L.check(norm(H.h1s(enHtml)[0]) === norm(s.title), `${enPath} does not show the homepage card's story ("${decode(s.title).slice(0, 60)}")`);
        L.check(pathOf(H.canonical(enHtml)) === enPath, `${enPath} names ${pathOf(H.canonical(enHtml))} as itself`);
        const alt = H.hreflangs(enHtml);
        L.check(pathOf(alt.es || "") === esPath, `${enPath} does not point Spanish readers to ${esPath}`);
        const esHtml = t.html(await t.get(esPath));
        L.check(H.htmlLang(esHtml).slice(0, 2) === "es", `${esPath} is not in Spanish`);
        const esTitle = esById.get(s.id)?.title || s.title_es;
        L.check(esTitle && norm(H.h1s(esHtml)[0]) === norm(esTitle), `${esPath} does not show the Spanish title of the story`);
        // "the same story in Spanish": an English headline under a Spanish page chrome matches the
        // feed too when the feed itself fell back to English (title_es missing → title)
        L.check(norm(H.h1s(esHtml)[0]) !== norm(H.h1s(enHtml)[0]), `${esPath} shows the English headline ("${decode(H.h1s(enHtml)[0]).slice(0, 60)}") — the Spanish twin is not translated`);
        const gearHref = H.links(enHtml).find((h) => /^\/affiliate\/[a-z0-9-]+\.html$/.test(h));
        if (gearHref) gearOf.set(gearHref, (gearOf.get(gearHref) || 0) + 1);
        L.check(pathOf(H.hreflangs(esHtml).en || "") === enPath, `${esPath} does not point back to ${enPath}`);
        const hasHub = H.links(enHtml).some((h) => /^\/news\/[a-z0-9-]+\.html$/.test(h) && !/-[0-9a-f]{6}\.html$/.test(h));
        if (!first || (hasHub && !first.hasHub)) first = { s, slug, enPath, esPath, enHtml, esHtml, hasHub };
      }

      // every link a reader can press on the first story, EN and ES
      const own = (html) => H.links(html).filter((h) => h.startsWith("/"));
      const enLinks = own(first.enHtml); const esLinks = own(first.esHtml);
      L.check(esLinks.every((h) => h.startsWith("/es/")), `${first.esPath} sends Spanish readers to English pages: ${esLinks.filter((h) => !h.startsWith("/es/")).slice(0, 4).join(", ")}`);
      L.check(JSON.stringify(esLinks.map((h) => h.replace(/^\/es\//, "/"))) === JSON.stringify(enLinks),
        `the Spanish story page's links are not the Spanish twins of the English page's links`);
      const related = enLinks.filter((h) => /^\/news\/[a-z0-9-]+-[0-9a-f]{6}\.html$/.test(h) && h !== first.enPath);
      const hubs = enLinks.filter((h) => /^\/news\/[a-z0-9-]+\.html$/.test(h) && !/-[0-9a-f]{6}\.html$/.test(h));
      L.check(enLinks.includes("/news.html"), `${first.enPath} has no way back to the news feed`);
      L.check(enLinks.includes("/work-with-mark.html"), `${first.enPath} lost its Work with Mark button`);
      const gear = enLinks.find((h) => /^\/affiliate\/[a-z0-9-]+\.html$/.test(h));
      L.check(gear, `${first.enPath} lost its gear link`);
      for (const h of related.slice(0, 3)) {
        const html = t.html(await t.get(h));
        L.check(pathOf(H.canonical(html)) === h && H.h1s(html)[0], `the related story ${h} is not a story page`);
      }
      for (const h of hubs.slice(0, 2)) {
        const html = t.html(await t.get(h));
        L.check(html.includes(`href="${first.enPath}"`), `the cruise-line page ${h} that the story links to does not list the story`);
        L.check(pathOf(H.hreflangs(html).es || "") === `/es${h}`, `the cruise-line page ${h} has no Spanish twin`);
      }
      if (hubs[0]) {
        const html = t.html(await t.get(`/es${hubs[0]}`));
        L.check(html.includes(`href="${first.esPath}"`), `the Spanish cruise-line page /es${hubs[0]} does not list the story's Spanish page`);
      }
      for (const [p, story] of [["/news.html", first.enPath], ["/es/news.html", first.esPath]]) {
        const html = t.html(await t.get(p));
        L.check(html.includes(`href="${story}"`), `the news feed ${p} does not list ${story}`);
      }
      for (const p of [gear, gear && `/es${gear}`, "/work-with-mark.html", "/es/work-with-mark.html"].filter(Boolean)) {
        const html = t.html(await t.get(p));
        L.check(H.htmlLang(html).slice(0, 2) === langOfPath(p), `${p} (linked from the story) is not in ${langOfPath(p)}`);
        // the gear list renders its product text by the page config's lang (descriptionEs for 'es')
        if (/^\/es\/affiliate\//.test(p)) L.check(/SAF_AFFILIATE_CONFIG\s*=\s*\{[\s\S]*?lang:\s*'es'/.test(html), `${p} shows its products with English descriptions (no lang 'es' in its config)`);
      }
      // every gear page a sampled story links must have products: the page asks
      // /api/affiliate-items?category=<its category> and shows "being curated" when that is empty.
      // (prerender-news.gearLinkFor maps a story category to a gear page; the gear list is a
      // different feature — an Aviation story links /affiliate/air-travel.html whatever it holds.)
      t.nonEmpty([...gearOf.keys()], "gear links on the sampled stories");
      const items = t.success(await t.get("/api/affiliate-items"));
      t.ok(Array.isArray(items.items), "the gear list has no items array");
      const perCat = new Map();
      for (const it of items.items) perCat.set(it.category, (perCat.get(it.category) || 0) + 1);
      for (const [g, n] of gearOf) {
        const html = t.html(await t.get(g), { mustContain: ["/components/affiliate-page.js"] });
        const cat = /SAF_AFFILIATE_CONFIG\s*=\s*\{[\s\S]*?category:\s*'([^']+)'/.exec(html)?.[1];
        L.check(cat, `the gear page ${g} no longer says which products it shows`);
        if (cat) L.check((perCat.get(cat) || 0) > 0, `${n} sampled stor${n === 1 ? "y links" : "ies link"} ${g}, which has 0 products ("${cat}") — readers land on "being curated"`);
      }
      L.done("the news reader journey");
      t.observe("story page link kinds (the story walked)", [...new Set(enLinks.map((h) => h.replace(/[a-z0-9-]+-[0-9a-f]{6}\.html$/, "<story>").replace(/^\/news\/[a-z0-9-]+\.html$/, "/news/<hub>").replace(/^\/affiliate\/[a-z0-9-]+\.html$/, "/affiliate/<gear>")))].sort().join(","), "info");
      t.observe("related stories on the first story", related.length, "info");
      t.observe("cruise-line pages on the first story", hubs.length, "info");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // FLOW 5 — into the ten-day forecast from the OTHER doors (weather.mjs walks the weather page
  // and the search pill). Steps:
  //   1. the homepage weather tiles (js/weather.js, shared by / and /es/) link each port to
  //      "forecast.html?place=<slug>" — RELATIVE, so from /es/ it resolves to /es/forecast.html;
  //      the tile a reader taps must open a forecast page, in the reader's language (lang=es);
  //   2. the English tile's forecast page asks /api/weather?place=<slug>&lang=en (exactly what
  //      forecast.html requests), which is the same port as the tile, at a temperature within
  //      10 °F of the tile's, with ten days and Mark's synopsis; the Spanish request has a
  //      Spanish synopsis;
  //   3. Where's My Ship's arrival-weather card ("Full 10-day forecast →") opens the forecast in
  //      the reader's language too (js/wheres-my-ship.js, wx-more).
  // ONE fixed place (Miami, a homepage tile) is asked for, in EN and ES: cached 6 h per language.
  //   4. every destination the tracker holds is a place the forecast knows (the card's link works).
  {
    id: "flows.weather-journey",
    title: "Tapping a homepage weather tile or the tracker's arrival-weather card opens that port's ten-day forecast with Mark's synopsis, in English and in Spanish",
    covers: ["flow:weather-journey", "page /index.html", "page /es/index.html", "GET /api/weather", "GET /api/wms/health", "page /forecast.html"],
    modes: ["dev", "prod"],
    incident: "2026-10-02: one road into the forecast (search) never showed the synopsis while another (tiles) did",
    run: async (t) => {
      const L = legs(t);
      const cards = t.success(await t.get("/api/weather"), "ok");
      t.ok(Array.isArray(cards.embarkation) && cards.embarkation.length > 0, "the weather tiles' port list is empty");
      const wjs = await t.get("/js/weather.js");
      t.status(wjs, 200);
      const tpl = /class="home-weather-tile" href="([^"$]*)\$\{port\.slug\}([^"]*)"/.exec(wjs.text);
      t.ok(tpl, "the homepage weather tiles no longer link to a forecast");
      const shown = Number(/\.slice\(0,\s*(\d+)\)/.exec(wjs.text)?.[1] || 0);
      t.ok(shown > 0, "the homepage no longer says how many weather tiles it shows");
      // ONE fixed place: Miami (the first featured homepage tile), so the synopsis below stays inside
      // the same 6-hour model cache whatever order the tiles come back in.
      const tile = cards.embarkation.find((c) => c.slug === "miami");
      t.ok(tile, "Miami is no longer one of the homepage weather tiles");
      t.ok(cards.embarkation.slice(0, shown).some((c) => c.slug === "miami"), "Miami is not among the tiles the homepage shows");
      t.fields(tile, ["slug", "name"], "the Miami homepage weather tile");
      t.ok(Number.isFinite(tile.temp), `the ${tile.name} tile has no temperature`);

      // 1. the tile link from each homepage
      const target = {};
      for (const [lang, path] of [["en", "/"], ["es", "/es/"]]) {
        const html = t.html(await t.get(path), { mustContain: ['id="weather-container"'] });
        t.ok(H.scripts(html).some((s) => /(^|\/)js\/weather\.js$/.test(s)), `the ${lang} homepage no longer loads the weather tiles`);
        const url = new URL(`${tpl[1]}${tile.slug}${tpl[2]}`, t.url(path));
        target[lang] = url;
        L.check(url.pathname === "/forecast.html", `the ${lang} homepage's ${tile.name} tile opens ${url.pathname}, which is not the forecast page`);
        L.check(lang === "en" || url.searchParams.get("lang") === "es", `the ${lang} homepage's ${tile.name} tile opens the forecast in English (no lang=es)`);
      }
      const esTile = await t.get(target.es.toString());
      L.check(esTile.status === 200 && esTile.text.includes("/api/weather?"),
        `the Spanish homepage's weather tiles open ${target.es.pathname} — HTTP ${esTile.status}, not a forecast page`);

      // 2. the forecast page and the data it asks for
      // the page renders d.forecast: its days and its .synopsis — a renamed field on either side
      // gives a page with a title and nothing else, with every API check still green
      const page = t.html(await t.get(`/forecast.html?place=${encodeURIComponent(tile.slug)}`),
        { mustContain: ["/api/weather?", "const loc = d.forecast", "renderDays(loc.forecast)", "if (loc.synopsis)", "textContent = loc.synopsis"] });
      t.ok(/query\.set\('lang', LANG\)/.test(page), "the forecast page no longer passes the reader's language to /api/weather");
      const fc = {};
      for (const lang of ["en", "es"]) {
        const f = t.success(await t.get(`/api/weather?place=${encodeURIComponent(tile.slug)}&lang=${lang}`), "ok").forecast;
        t.fields(f, ["slug", "name"], `the ${tile.name} forecast (${lang})`);
        L.check(f.slug === tile.slug && f.name === tile.name, `the ${tile.name} tile opens the forecast of ${f.name} (${f.slug})`);
        L.check(Array.isArray(f.forecast) && f.forecast.length === 10, `the ${tile.name} forecast (${lang}) has ${f.forecast?.length} days, not 10`);
        L.check(typeof f.synopsis === "string" && f.synopsis.trim().length >= 80, `the ${tile.name} forecast (${lang}) has no synopsis from Mark`);
        fc[lang] = f;
      }
      L.check(Number.isFinite(fc.en.temp) && Math.abs(fc.en.temp - tile.temp) <= 10,
        `the ${tile.name} tile shows ${tile.temp}°F but its forecast says ${fc.en.temp}°F now`);
      const d0 = fc.en.forecast?.[0];
      L.check(d0 && tile.temp >= d0.low - 10 && tile.temp <= d0.high + 10, `the ${tile.name} tile shows ${tile.temp}°F, outside today's forecast ${d0?.low}–${d0?.high}°F`);
      L.check(fc.es.synopsis !== fc.en.synopsis && /[áéíóúñ¿¡]| (el|la|los|las|que|con|para|por|una?) /i.test(fc.es.synopsis || ""),
        `the ${tile.name} synopsis a Spanish reader gets is not Spanish`);

      // 3. Where's My Ship → arrival-weather card → forecast
      const tjs = await t.get("/js/wheres-my-ship.js");
      t.status(tjs, 200);
      const wx = /\$\('wx-more'\)\.href\s*=\s*`([^`]+)`/.exec(tjs.text)?.[1];
      t.ok(wx, "the tracker's arrival-weather card no longer links to the forecast");
      L.check(/^\/forecast\.html\?place=\$\{dest\.slug\}/.test(wx), `the tracker's "Full 10-day forecast" opens ${wx}, not the forecast page`);
      L.check(/lang/.test(wx), "the Spanish tracker's \"Pronóstico completo de 10 días\" opens the forecast in English (the link carries no lang=es)");
      // the slug the card links is the tracker's own destination match (ports.matchDestination);
      // every destination the tracker holds right now must be a place the forecast knows, or the
      // card's link opens "Forecast unavailable". Free reads: the health list and the port list.
      const held = t.success(await t.get("/api/wms/health"), "ok");
      t.ok(Array.isArray(held.ships), "the tracker health answer has no ships array");
      const dests = [...new Set(held.ships.map((x) => x.destination).filter(Boolean))];
      t.require(dests.length > 0, "the tracker holds no ship with a matched destination, so no arrival-weather card exists to follow");
      const list = t.success(await t.get("/api/weather?list=true"), "ok");
      const known = new Set([...(list.allEmbarkationPorts || []), ...(list.allDestinations || [])].map((p) => p.slug));
      t.atLeast(known.size, 10, "places the forecast knows");
      const unknown = dests.filter((d) => !known.has(d));
      L.check(unknown.length === 0, `${unknown.length} destination(s) on the tracker's arrival-weather card are not places the forecast knows: ${unknown.slice(0, 5).join(", ")}`);
      t.observe("tracker destinations with a forecast", dests.length, "info");
      L.done("the roads into the forecast");
      t.observe("homepage tile link form", `${tpl[1]}<slug>${tpl[2]}`);
      t.observe("homepage tiles shown", shown);
      t.observe("tracker forecast link form", wx);
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // FLOW 6 — the weekly NEWSLETTER, as a subscriber clicks through it. Steps (English, then Spanish):
  //   1. the saved issue (GET /api/newsletter/draft) and the email exactly as it is mailed
  //      (GET /api/newsletter/email — the review page's preview) — both token-gated reads;
  //   2. every link in the email is classified and followed to LIVE content on this box (links
  //      are written with the production host; they are moved onto the box being tested):
  //        story      /news/<slug>.html (ES /es/news/…)   → a story page in the issue's language
  //        commentary /commentary-post.html?id=           → a published post (ES: Spanish title+text)
  //        video      youtube.com/watch?v=<id>            → its thumbnail (the image the email shows)
  //        gear       /api/go/<id>                        → NOT requested (records a click); the item
  //                                                         must exist with an Amazon link instead
  //        booking    /work-with-mark.html#contact        → a page with the contact form
  //        unsubscribe /api/unsubscribe?email=&sig=       → NOT requested (it unsubscribes)
  //        images     /assets/…                           → load
  //   3. every quick-hit, video, gear and commentary in the saved issue is in the email.
  // A missing Spanish issue on dev (prod has one) is UNTESTABLE: dev does not mirror prod.
  {
    id: "flows.newsletter-links",
    title: "Every story, commentary, video, gear and booking link in this week's newsletter (English and Spanish) opens live content",
    covers: ["email:newsletter-issue-links", "GET /api/newsletter/draft", "GET /api/newsletter/email", "GET /api/commentary", "GET /api/affiliate-items",
      "page /commentary-post.html", "page /es/commentary-post.html", "page /work-with-mark.html", "page /es/work-with-mark.html"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const L = legs(t);
      let itemById = null; // the gear list, read only when an issue carries a gear link
      for (const lang of ["en", "es"]) {
        const draft = t.success(await t.get(`/api/newsletter/draft?lang=${lang}`, { auth: true })).draft;
        t.require(draft && draft.subject, `there is no ${lang === "es" ? "Spanish" : "English"} newsletter issue on this box, so its links cannot be followed${t.mode === "dev" ? " (prod has one: dev does not mirror prod's newsletter)" : ""}`);
        t.equal(draft.lang || "en", lang, `the ${lang} issue's language`);
        const res = await t.get(`/api/newsletter/email?lang=${lang}`, { auth: true });
        const html = t.html(res);
        L.check(!/\b(undefined|NaN)\b|\[object Object\]/.test(H.visibleText(html)), `the ${lang} issue shows broken text (undefined / NaN / [object Object]) to every subscriber`);
        const hrefs = [...new Set(H.links(html))];
        const story = []; let commentary = null; let video = null; let gear = null; let booking = 0; let unsub = 0; const other = [];
        for (const h of hrefs) {
          let u; try { u = new URL(h); } catch { other.push(h); continue; }
          const own = H.sameSite(h, t.bases.site);
          if (own && /^\/(es\/)?news\/[a-z0-9-]+\.html$/.test(u.pathname)) story.push(u);
          else if (own && /^\/(es\/)?commentary-post\.html$/.test(u.pathname)) commentary = u;
          else if (own && /^\/api\/go\/[^/]+$/.test(u.pathname)) gear = u;
          else if (own && /^\/(es\/)?work-with-mark\.html$/.test(u.pathname)) { booking++; L.check(u.hash === "#contact", `the ${lang} issue's booking link does not open the contact form (#contact)`); L.check(langOfPath(u.pathname) === lang, `the ${lang} issue's booking link opens ${u.pathname}`); }
          else if (own && u.pathname === "/api/unsubscribe") { unsub++; L.check(u.searchParams.get("email") && u.searchParams.get("sig"), `the ${lang} issue's unsubscribe link is not signed`); }
          else if (/(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/watch") video = u.searchParams.get("v");
          else other.push(u.hostname);
        }
        L.check(unsub === 1, `the ${lang} issue has ${unsub} unsubscribe links (must be exactly 1)`);
        L.check(booking >= 1, `the ${lang} issue has no Work-with-Mark link`);
        t.atLeast(story.length, 1, `story links in the ${lang} issue`);
        // the saved issue's pieces are all in the email
        for (const h of draft.quickHits || []) if (h && h.url) L.check(story.some((u) => u.pathname === new URL(h.url).pathname), `the ${lang} issue's quick hit "${String(h.text).slice(0, 40)}" lost its story link in the email`);
        L.check(!draft.video || (video === draft.video.id && hrefs.includes(draft.video.url)), `the ${lang} issue features video ${draft.video?.id} but the email links ${video}`);
        L.check(!draft.commentary || (commentary && commentary.searchParams.get("id") === draft.commentary.id), `the ${lang} issue's commentary link is missing or points at another post`);
        L.check(!draft.affiliate || hrefs.includes(draft.affiliate.link), `the ${lang} issue's gear pick "${draft.affiliate?.title}" has no link in the email`);

        // stories → live pages in the issue's language (sample of 4)
        for (const u of spread(story, 4)) {
          L.check(langOfPath(u.pathname) === lang, `the ${lang} issue links a story in the other language: ${u.pathname}`);
          const page = t.html(await t.get(H.onBase(`${SITE}${u.pathname}`, t.bases.site)));
          L.check(pathOf(H.canonical(page)) === u.pathname && H.h1s(page)[0], `the ${lang} issue links ${u.pathname}, which is not a live story page`);
          L.check(H.htmlLang(page).slice(0, 2) === lang, `the ${lang} issue's story ${u.pathname} is not in ${lang}`);
        }
        // commentary → a published post, with Spanish text for the Spanish issue
        if (commentary) {
          L.check(langOfPath(commentary.pathname) === lang, `the ${lang} issue links the commentary page ${commentary.pathname}`);
          const page = t.html(await t.get(commentary.pathname + commentary.search), { mustContain: ["/api/commentary?id="] });
          L.check(H.htmlLang(page).slice(0, 2) === lang, `${commentary.pathname} is not in ${lang}`);
          const post = await t.get(`/api/commentary?id=${encodeURIComponent(commentary.searchParams.get("id"))}`);
          L.check(post.status === 200 && post.json?.success === true && post.json.post?.status === "published",
            `the ${lang} issue links commentary ${commentary.searchParams.get("id")}, which is not a published post (${post.describe()})`);
          if (lang === "es") L.check(post.json?.post?.title_es && post.json?.post?.body_es, "the Spanish issue links a commentary with no Spanish title or text");
        }
        // video → its thumbnail loads (the picture the email shows; a deleted video's is gone)
        if (video) {
          L.check(/^[A-Za-z0-9_-]{11}$/.test(video), `the ${lang} issue's video id "${video}" is not a YouTube id`);
          const thumb = await t.get(`https://i.ytimg.com/vi/${encodeURIComponent(video)}/hqdefault.jpg`);
          L.check(thumb.status === 200, `the ${lang} issue's video ${video} has no thumbnail on YouTube (HTTP ${thumb.status}) — the video is gone or private`);
        }
        // gear → the item /api/go would redirect to (never requested)
        if (gear) {
          if (!itemById) {
            const items = t.success(await t.get("/api/affiliate-items"));
            t.ok(Array.isArray(items.items), "the gear list has no items array");
            itemById = new Map(items.items.map((i) => [i.id, i]));
          }
          const it = itemById.get(decodeURIComponent(gear.pathname.split("/").pop()));
          const target = it && (/^https?:\/\//i.test(String(it.smartStrip || "").trim()) ? it.smartStrip : it.affiliateLink);
          L.check(it, `the ${lang} issue's gear link names an item that is no longer in the gear list`);
          L.check(!it || /^https:\/\/(www\.)?(amazon\.[a-z.]+|amzn\.to)\//i.test(String(target || "")), `the ${lang} issue's gear item "${it?.title}" has no Amazon link to send the reader to`);
          L.check(gear.searchParams.get("l") === lang && gear.searchParams.get("p") === "newsletter", `the ${lang} issue's gear click would be logged without its page/language`);
        }
        // booking page and the site's own images
        const wwm = t.html(await t.get(lang === "es" ? "/es/work-with-mark.html" : "/work-with-mark.html"), { mustContain: ['id="contact"'] });
        L.check(H.htmlLang(wwm).slice(0, 2) === lang, `the ${lang} issue's booking page is not in ${lang}`);
        for (const src of H.images(html).filter((s) => H.sameSite(s, t.bases.site)).slice(0, 2)) {
          const img = await t.get(H.onBase(src, t.bases.site));
          L.check(img.status === 200, `the ${lang} issue shows an image that does not load: ${pathOf(src)} (HTTP ${img.status})`);
        }
        t.observe(`${lang} issue link kinds`, [story.length ? "story" : "", commentary ? "commentary" : "", video ? "video" : "", gear ? "gear" : "", booking ? "booking" : "", unsub ? "unsubscribe" : ""].filter(Boolean).join(","));
        t.observe(`${lang} issue status`, draft.status, "info");
        t.observe(`${lang} issue age (days)`, Math.round((t.now() - Date.parse(draft.generatedAt)) / 86_400_000), "info");
        t.observe(`${lang} issue story links`, story.length, "info");
        t.observe(`${lang} issue outside hosts`, [...new Set(other)].sort().join(","), "info");
      }
      L.done("the newsletter's links");
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // FLOW 7 — ONE SHIP, EVERY VIEW. A ship in a storm's path appears in: the public storm list
  // (and its pages), Mark's storm dashboard, the tracker's ship search and its live list, and —
  // when she is alongside a cam port — the cams' "ships in port now". They must agree:
  //   • the dashboard and the public list show the same sailings for the same storm;
  //   • every storm ship is in the tracker's search under the same name and the same line;
  //     a trackable one is followed and held;
  //   • a ship listed under TWO storms is on ONE sailing: overlapping sailings (more than a
  //     turnaround day) with different dates or departure ports contradict each other;
  //   • a ship a cam shows in port is one the tracker holds, at a fix no newer than the tracker's.
  {
    id: "flows.one-ship-every-view",
    title: "A ship in a storm's path reads the same everywhere: the public storm pages, Mark's storm dashboard, the ship tracker and the port cams",
    covers: ["flow:one-ship-every-view", "GET /api/storm-watch", "GET /api/storm-alerts", "GET /api/wms/ships", "GET /api/wms/health", "GET /api/webcams"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const L = legs(t);
      const sw = await publicStorms(t);
      const sailings = sw.systems.flatMap((s) => (s.sailings || []).map((v) => ({ v, s })));
      t.require(sailings.length > 0, "no public storm lists a sailing, so no ship appears in more than one view (dev: approve the storm fixture)");
      const dash = t.success(await t.get("/api/storm-alerts", { auth: true }));
      t.ok(Array.isArray(dash.alerts), "Mark's storm dashboard has no alerts list");
      const dashById = new Map(dash.alerts.map((a) => [a.id, a]));
      const reg = t.success(await t.get("/api/wms/ships"), "ok");
      t.ok(Array.isArray(reg.ships) && reg.ships.length > 0, "the tracker's ship list is empty");
      const byName = new Map(reg.ships.map((x) => [lc(x.name), x]));
      const held = t.success(await t.get("/api/wms/health"), "ok");
      t.ok(Array.isArray(held.ships), "the tracker health answer has no ships array");
      const heldBy = new Map(held.ships.map((x) => [lc(x.name), x]));
      const cams = t.success(await t.get("/api/webcams"));
      t.ok(Array.isArray(cams.webcams) && cams.webcams.length > 0, "the cams list is empty");

      // public list vs Mark's dashboard, storm by storm
      const key = (v) => `${lc(v.ship_name)}|${v.cruise_line}|${v.start_date}|${v.end_date}|${v.depart_port ?? ""}|${v.trackable}`;
      for (const s of sw.systems) {
        const a = dashById.get(s.id);
        L.check(a, `"${s.name}" is on the public list but not in Mark's storm dashboard`);
        if (!a) continue;
        const pub = (s.sailings || []).map(key).sort(); const mine = (a.sailings || []).map(key).sort();
        L.check(pub.join("\n") === mine.join("\n"), `"${s.name}": Mark's dashboard lists ${mine.length} affected sailings and the public page ${pub.length}, or not the same ones`);
      }
      // storm ships vs the tracker
      for (const { v, s } of sailings) {
        const r = byName.get(lc(v.ship_name));
        if (!L.check(r, `"${s.name}" lists "${v.ship_name}", whom the tracker's ship search does not know`)) continue;
        L.check(r.name === v.ship_name, `"${s.name}" spells her "${v.ship_name}", the tracker "${r.name}"`);
        L.check(lineKey(r.cruiseLine) === lineKey(v.cruise_line), `"${v.ship_name}" sails for ${v.cruise_line} on "${s.name}" but for ${r.cruiseLine} in the tracker`);
        // trackable (the storm pages' Track-this-ship button) comes from the tracker's in-memory
        // registry; tracked (the tracker's search) from the ships table. Both mean "active ship
        // with an MMSI": a difference is a stale registry — a button missing, or one that dead-ends.
        L.check(v.trackable === Boolean(r.tracked), `"${v.ship_name}" on "${s.name}": the storm page ${v.trackable ? "shows" : "hides"} Track this ship but the tracker ${r.tracked ? "can" : "cannot"} follow her`);
        if (v.trackable) {
          L.check(r.tracked && r.live, `"${v.ship_name}" has a Track-this-ship button on "${s.name}" but the tracker is not following her`);
          L.check(heldBy.get(lc(v.ship_name))?.hasFix === true, `"${v.ship_name}" is followed for "${s.name}" but the tracker has no position for her`);
        }
      }
      // the same ship under two storms is on one sailing
      const byShip = new Map();
      for (const x of sailings) { const k = lc(x.v.ship_name); if (!byShip.has(k)) byShip.set(k, []); byShip.get(k).push(x); }
      let shared = 0;
      const day = (d) => Date.parse(`${d}T00:00:00Z`);
      for (const list of byShip.values()) {
        if (new Set(list.map((x) => x.s.id)).size < 2) continue;
        shared++;
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const [a, b] = [list[i], list[j]];
          if (a.s.id === b.s.id) continue;
          L.check(lineKey(a.v.cruise_line) === lineKey(b.v.cruise_line), `"${a.v.ship_name}" sails for ${a.v.cruise_line} on "${a.s.name}" but ${b.v.cruise_line} on "${b.s.name}"`);
          const overlapDays = (Math.min(day(a.v.end_date), day(b.v.end_date)) - Math.max(day(a.v.start_date), day(b.v.start_date))) / 86_400_000;
          const same = a.v.start_date === b.v.start_date && a.v.end_date === b.v.end_date && (a.v.depart_port || "") === (b.v.depart_port || "");
          // unreadable dates make the overlap NaN, which must not read as "no overlap"
          L.check(same || Number.isFinite(overlapDays), `"${a.v.ship_name}" is listed under "${a.s.name}" and "${b.s.name}" with dates that cannot be compared`);
          L.check(same || !(overlapDays > 1),
            `"${a.v.ship_name}" is on two different sailings at once: "${a.s.name}" says ${a.v.depart_port || "unknown port"} ${a.v.start_date}–${a.v.end_date}, "${b.s.name}" says ${b.v.depart_port || "unknown port"} ${b.v.start_date}–${b.v.end_date}`);
        }
      }
      // (each row's own sanity — names, dates, span — is flows.storm-visitor-journey's; here the
      //  dashboard-vs-public comparison includes dates and port, and unreadable dates fail above)
      // cams' ships in port vs the tracker (and vs the storms, when a storm ship is alongside).
      // A cam that looks at a port (port_slug) must ANSWER the question — an array, even an empty
      // one; null means the port lookup broke and the "ships in port now" strip vanished silently.
      const portCams = cams.webcams.filter((c) => c.port_slug);
      t.atLeast(portCams.length, 1, "cams that look at a cruise port");
      for (const c of portCams) L.check(Array.isArray(c.ships_in_port), `the ${c.slug} cam looks at port "${c.port_slug}" but cannot say which ships are there (ships_in_port is ${c.ships_in_port === null ? "null" : typeof c.ships_in_port})`);
      let inFrame = 0;
      for (const c of cams.webcams) for (const sh of c.ships_in_port || []) {
        inFrame++;
        const h = heldBy.get(lc(sh.name));
        L.check(h, `the ${c.slug} cam shows "${sh.name}" in port, whom the tracker does not hold`);
        L.check(!h || Date.parse(h.lastPosAt) >= Date.parse(sh.lastPosAt), `the ${c.slug} cam shows "${sh.name}" at a newer fix than the tracker holds`);
        L.check(byName.has(lc(sh.name)), `the ${c.slug} cam names "${sh.name}", who is not in the tracker's ship search`);
      }
      L.done("one ship across the storm pages, dashboard, tracker and cams");
      t.observe("storm sailings", sailings.length, "info");
      t.observe("ships listed under two storms", shared, "info");
      t.observe("ships in port on a cam", inFrame, "info");
      t.observe("storm sailing keys", keysOf(sailings[0].v));
    },
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // FLOW 8 — the numbers and to-dos Mark sees in two places agree.
  //   • every storm DRAFT that is a threat has exactly one pending to-do (public.actions, the brief)
  //     whose Approve / Dismiss buttons act on THAT storm; every pending storm to-do acts on a storm
  //     still in the dashboard, and an Approve/Dismiss to-do only on a storm still waiting (draft),
  //     an all-clear to-do only on an ended storm whose all-clear has not gone out or been skipped;
  //   • every course change waiting for Mark (storm_diversion_events, the course-change log) has
  //     one pending to-do, and every course-change to-do is one still waiting;
  //   • the course-change log's live storms are exactly the dashboard's live threats, and every
  //     public storm is one of them.
  // The to-do list is read 30 rows at a time (listPendingActions): if it is full, a storm whose
  // to-do is not among those 30 cannot be judged — UNTESTABLE, and that full list is worth a look.
  {
    id: "flows.mark-queue-matches-storm-queues",
    title: "Mark's to-do list has one Approve/Dismiss item for every storm draft and one item for every course change waiting on him, and no buttons for storms already decided",
    covers: ["flow:mark-queue-matches-storm-queues", "GET /api/actions", "GET /api/storm-alerts", "GET /api/storm-diversions/log", "GET /api/storm-watch"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const L = legs(t);
      const acts = t.success(await t.get("/api/actions", { auth: true }), "ok");
      t.ok(Array.isArray(acts.actions), "Mark's to-do list has no actions array");
      const full = acts.actions.length >= 30;
      const dash = t.success(await t.get("/api/storm-alerts", { auth: true }));
      t.ok(Array.isArray(dash.alerts), "Mark's storm dashboard has no alerts list");
      t.nonEmpty(dash.alerts, "Mark's storm dashboard (no storm alert at all, live or ended)");
      const byId = new Map(dash.alerts.map((a) => [a.id, a]));
      const log = t.success(await t.get("/api/storm-diversions/log?days=180", { auth: true }));
      t.ok(Array.isArray(log.pings) && Array.isArray(log.storms), "the course-change log has no pings or storms");
      const pub = await publicStorms(t);

      // storm to-dos ↔ storm alerts
      const stormActs = acts.actions.filter((a) => a.type === "storm_alert");
      const liveThreats = dash.alerts.filter((a) => ["draft", "approved", "sending", "sent"].includes(a.status) && a.is_threat === true);
      const waiting = log.pings.filter((p) => p.event?.status === "pending").length;
      // With no live storm, no storm to-do and no course change waiting, every comparison below is
      // between empty sets — that proves nothing about the hand-off between the two queues.
      t.require(liveThreats.length + stormActs.length + waiting > 0,
        "no live storm, no storm to-do and no course change waiting for Mark, so there is nothing to match between his to-do list and the storm queues (dev: approve or draft the storm fixture)");
      for (const a of stormActs) {
        const al = byId.get(a.source_ref);
        if (!L.check(al, `a pending storm to-do (${a.created_at?.slice(0, 10)}) acts on a storm that is gone or dismissed (${String(a.source_ref).slice(0, 8)})`)) continue;
        const paths = (a.buttons || []).map((b) => String(b.path || ""));
        for (const p of paths) L.check(p.startsWith(`/api/storm-alerts/${al.id}/`), `the to-do for "${al.name}" has a button that acts on a different storm (${p.slice(0, 60)})`);
        if (paths.some((p) => /\/(approve|dismiss)$/.test(p))) L.check(al.status === "draft", `the to-do "Approve/Dismiss ${al.name}" is still open but the storm is already ${al.status}`);
        if (paths.some((p) => /\/all-clear$/.test(p))) L.check(al.status === "ended" && !al.all_clear_sent_at && !al.all_clear_skipped_at, `the all-clear to-do for "${al.name}" is still open but the all-clear is ${al.all_clear_sent_at ? "sent" : al.all_clear_skipped_at ? "skipped" : `not due (storm ${al.status})`}`);
      }
      const drafts = dash.alerts.filter((a) => a.status === "draft" && a.is_threat === true);
      for (const d of drafts) {
        const mine = stormActs.filter((a) => a.source_ref === d.id && (a.buttons || []).some((b) => /\/approve$/.test(String(b.path))));
        if (!mine.length && full) t.require(false, `Mark's to-do list is full (30 shown), so whether the "${d.name}" draft has its Approve to-do cannot be told`);
        L.check(mine.length === 1, `the storm draft "${d.name}" has ${mine.length} Approve/Dismiss to-dos (must be exactly 1 — with none, nobody is asked to send it)`);
      }

      // course-change to-dos ↔ course changes waiting for Mark
      const pendingEvents = new Set(log.pings.filter((p) => p.event?.status === "pending").map((p) => p.event.id));
      const divActs = acts.actions.filter((a) => a.type === "storm_diversion");
      for (const a of divActs) L.check(pendingEvents.has(a.source_ref), `a pending course-change to-do (${a.created_at?.slice(0, 10)}) is for a change that is no longer waiting (or older than 180 days)`);
      const divRefs = new Set(divActs.map((a) => a.source_ref));
      for (const id of pendingEvents) {
        if (!divRefs.has(id) && full) t.require(false, "Mark's to-do list is full (30 shown), so whether every waiting course change has its to-do cannot be told");
        L.check(divRefs.has(id), `a course change waiting for Mark (${String(id).slice(0, 8)}) has no to-do — nobody is asked to publish or ignore it`);
      }

      // the course-change log's live storms vs the dashboard vs the public list
      const live = new Set(liveThreats.map((a) => a.id));
      const logLive = new Set(log.storms.map((s) => s.id));
      for (const id of live) L.check(logLive.has(id), `the live storm "${byId.get(id)?.name}" is missing from the course-change log's storms`);
      for (const id of logLive) L.check(live.has(id), `the course-change log shows a live storm the dashboard does not (${String(id).slice(0, 8)})`);
      for (const s of pub.systems) L.check(live.has(s.id), `"${s.name}" is public but not a live threat in Mark's dashboard`);
      L.done("Mark's to-do list vs the storm queues");
      t.observe("pending to-dos", acts.actions.length, "info");
      t.observe("storm drafts waiting", drafts.length, "info");
      t.observe("course changes waiting", pendingEvents.size, "info");
      t.observe("to-do types", [...new Set(acts.actions.map((a) => a.type))].sort().join(","), "info");
    },
  },
  // ───────────────────────────────────────────────────────────────────────────────────────────
  // FLOW 9 — a GROUP page, from Mark's dashboard to the public. Steps:
  //   1. Mark's group list (GET /api/groups, token) — only ids, status, share code and approval
  //      time are read (the rows carry organiser details; nothing from them is recorded);
  //   2. for each group whose page is live (approved, status marketing/booking, has a share code):
  //      the dashboard's marketing view (GET /api/groups/:id/marketing) is what Mark approved —
  //      its copy has no validation problems, and its share code is the group's;
  //   3. the public answer for that code (GET /api/group-page/:code, NO token — a visitor) is live,
  //      in the same languages, with the SAME copy and the same public facts (ship, dates, nights,
  //      port, cabins left per category, prices when shown) as the dashboard;
  //   4. the ship's score on the page is the published Conga Line score (GET /api/ships/ratings);
  //   5. /group.html?g=<code> loads, accepts the code by its own rule and asks /api/group-page/;
  //      a made-up code is a clean 404; on prod the interest form has a Turnstile site key (dev
  //      runs without Turnstile by design — lib/turnstile.ts).
  // The interest form itself (POST /api/group-page/:code/interest) EMAILS Mark: never submitted.
  //   6. /es/group.html (the language switch's target) is Spanish, asks for lang=es and accepts the
  //      same share codes as the English page.
  // Two agreeing views can both be blank, so the facts a visitor decides on (ship, dates, nights,
  // itinerary, cabins with counts and prices, the business named in the footer) must be present.
  // Group pages are in the release candidate only: prod has no approved group page until the
  // 2026-10-08 promotion, so this check is UNTESTABLE on prod until then (dev: 4a5fg8ypac, EN).
  {
    id: "flows.group-page-journey",
    title: "A group page Mark approved in the dashboard is what visitors see: same words, same ship, dates, cabins and prices, and the ship's real Conga Line score",
    covers: ["flow:group-page-journey", "GET /api/groups", "GET /api/groups/:id/marketing", "GET /api/group-page/:code", "page /group.html", "page /es/group.html", "GET /api/ships/ratings"],
    modes: ["dev", "prod"],
    incident: "release candidate 2026-10-08: group marketing pages (dev only until the promotion)",
    run: async (t) => {
      const L = legs(t);
      const list = t.success(await t.get("/api/groups", { auth: true }));
      t.ok(Array.isArray(list.groups), "Mark's group list has no groups array");
      const live = list.groups.filter((g) => g.share_code && g.marketing_approved_at && ["marketing", "booking"].includes(g.status));
      t.require(live.length > 0, `none of the ${list.groups.length} groups has an approved public page${t.mode === "prod" ? " (group pages arrive on prod with the 2026-10-08 promotion)" : " (dev: the test group 4a5fg8ypac should be approved)"}`);
      const ratings = t.success(await t.get("/api/ships/ratings"), "ok");
      t.ok(Array.isArray(ratings.ratings) && ratings.ratings.length > 0, "the published Conga Line ratings list is empty");
      const bySlug = new Map(ratings.ratings.map((r) => [r.ship_slug, r]));
      const COPY = ["headline", "subhead", "intro", "why_ship", "who_for", "organizer_note", "cta_label", "cta_blurb"];
      const FACTS = ["groupName", "line", "ship", "sailDateText", "returnDateText", "nights", "embarkPort", "cabinsAvailable", "bookByText", "finalPaymentText"];
      let pageCode = null; let lastPub = null;
      for (const g of spread(live, 2)) {
        const m = t.success(await t.get(`/api/groups/${encodeURIComponent(g.id)}/marketing`, { auth: true }));
        t.ok(Array.isArray(m.langs) && m.langs.length > 0, `group ${g.share_code}: the dashboard lists no languages for its page`);
        L.check(m.shareCode === g.share_code, `group ${g.share_code}: the marketing view has a different share code`);
        L.check(Boolean(m.approvedAt), `group ${g.share_code}: the marketing view does not show the approval`);
        for (const lang of m.langs) {
          const mine = m.perLang?.[lang];
          t.ok(mine && mine.copy && mine.facts, `group ${g.share_code}: the dashboard has no ${lang} copy for an approved page`);
          L.check((mine.problems || []).length === 0, `group ${g.share_code} (${lang}): the approved copy fails its own checks: ${(mine.problems || []).slice(0, 3).join("; ")}`);
          const pub = t.success(await t.get(`/api/group-page/${encodeURIComponent(g.share_code)}?lang=${lang}`));
          lastPub = pub;
          L.check(pub.live === true && pub.preview === false, `group ${g.share_code} (${lang}): a visitor does not get the live page`);
          L.check(JSON.stringify(pub.langs) === JSON.stringify(m.langs), `group ${g.share_code}: the public page offers ${pub.langs} but the dashboard ${m.langs}`);
          for (const k of COPY) L.check((pub.copy?.[k] ?? "") === (mine.copy[k] ?? ""), `group ${g.share_code} (${lang}): the public page's "${k}" is not the copy Mark approved`);
          t.fields(pub.copy, ["headline", "intro", "cta_label"], `group ${g.share_code} (${lang}) public copy`);
          // values are printed only for public sailing facts — a group's NAME can carry a person's
          // name ("the Smith reunion"), so a groupName mismatch is reported without its values
          for (const k of FACTS) L.check(JSON.stringify(pub.facts?.[k] ?? null) === JSON.stringify(mine.facts[k] ?? null),
            k === "groupName" ? `group ${g.share_code} (${lang}): the public page's group name is not the dashboard's`
              : `group ${g.share_code} (${lang}): the public page shows ${k} ${JSON.stringify(pub.facts?.[k])} but the dashboard ${JSON.stringify(mine.facts[k])}`);
          // the page also renders these (group.html: f.itinerary, f.amenities, f.ports, f.business
          // footer). Compared whole; values are not printed (business carries the contact address).
          for (const k of ["itinerary", "amenities", "ports", "business"]) L.check(JSON.stringify(pub.facts?.[k] ?? null) === JSON.stringify(mine.facts[k] ?? null), `group ${g.share_code} (${lang}): the public page's ${k} is not what the dashboard shows`);
          // Two views that agree can both be blank (a column dropped from the group/cabin query fills
          // both with null): the facts a visitor decides on must be THERE.
          t.fields(pub.facts, ["groupName", "line", "ship", "sailDateText", "returnDateText", "embarkPort", "bookByText"], `group ${g.share_code} (${lang}) public facts`);
          L.check(Number.isInteger(pub.facts.nights) && pub.facts.nights >= 1 && pub.facts.nights <= 120, `group ${g.share_code} (${lang}): the page says the cruise is ${pub.facts.nights} nights`);
          L.check(Array.isArray(pub.facts.itinerary) && pub.facts.itinerary.length >= 2 && pub.facts.itinerary.every((d) => d && d.dateText && (d.port || d.seaDay)),
            `group ${g.share_code} (${lang}): the day-by-day itinerary is missing or has days with no date or port`);
          L.check(/still afloat/i.test(String(pub.facts.business?.legalName || "")), `group ${g.share_code} (${lang}): the page's footer does not name the business visitors are booking with`);
          const showPrices = m.answers?.show_prices !== false;
          // "Mark is sailing too" is an interview answer, not a fact (publicFacts in group-marketing.ts)
          L.check(pub.facts?.markSailing === (m.answers?.mark_sailing === true), `group ${g.share_code} (${lang}): the page says Mark is ${pub.facts?.markSailing ? "" : "not "}sailing, the dashboard's answer says otherwise`);
          const pc = pub.facts?.cabins || []; const mc = mine.facts.cabins || [];
          t.atLeast(pc.length, 1, `group ${g.share_code} (${lang}): cabin categories on the public page`);
          L.check(pc.length === mc.length, `group ${g.share_code} (${lang}): ${pc.length} cabin categories public, ${mc.length} in the dashboard`);
          pc.forEach((c, i) => {
            L.check(c.category === mc[i]?.category && c.available === mc[i]?.available, `group ${g.share_code} (${lang}): cabin "${c.category}" shows ${c.available} left publicly, ${mc[i]?.available} in the dashboard`);
            L.check(c.perPersonText === (showPrices ? mc[i]?.perPersonText : null), `group ${g.share_code} (${lang}): cabin "${c.category}" price differs from the dashboard`);
            L.check(c.depositPerPersonText === (showPrices ? mc[i]?.depositPerPersonText : null), `group ${g.share_code} (${lang}): cabin "${c.category}" deposit differs from the dashboard`);
            L.check(String(c.category || "").trim() && Number.isInteger(c.available) && c.available >= 0, `group ${g.share_code} (${lang}): a cabin row has no category or no count left`);
            if (showPrices) L.check(/^\$\d/.test(String(c.perPersonText || "")), `group ${g.share_code} (${lang}): cabin "${c.category}" shows no price although prices are on`);
          });
          L.check(pub.facts?.cabinsAvailable === pc.reduce((n, c) => n + (Number(c.available) || 0), 0), `group ${g.share_code} (${lang}): "${pub.facts?.cabinsAvailable} cabins left" does not add up the categories`);
          L.check(pub.facts?.fromPerPersonText === (showPrices ? mine.facts.fromPerPersonText : null), `group ${g.share_code} (${lang}): the "from" price differs from the dashboard`);
          // the ship's score: shown unless Mark turned it off, and then it must be the published one
          const shipSlug = lc(pub.facts?.ship).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          if (m.answers?.show_rating === false) L.check(!pub.facts?.rating, `group ${g.share_code} (${lang}): the page shows a cruiser score although Mark turned it off`);
          else if (bySlug.has(shipSlug)) L.check(Boolean(pub.facts?.rating?.scoreText), `group ${g.share_code} (${lang}): ${pub.facts?.ship} has a published Conga Line score but the page shows none`);
          if (pub.facts?.rating) {
            const r = bySlug.get(lc(pub.facts.ship).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
            L.check(r, `group ${g.share_code}: the page shows a cruiser score for ${pub.facts.ship}, which has no published Conga Line rating`);
            L.check(!r || Number(r.rating).toFixed(1) === pub.facts.rating.scoreText, `group ${g.share_code}: the page scores ${pub.facts.ship} ${pub.facts.rating.scoreText} but the Conga Line says ${r?.rating}`);
          }
          if (t.mode === "prod") L.check(Boolean(pub.turnstileSiteKey), `group ${g.share_code}: the interest form has no Turnstile key on prod, so no visitor can send it`);
        }
        pageCode = pageCode || g.share_code;
      }
      const page = t.html(await t.get(`/group.html?g=${encodeURIComponent(pageCode)}`), { mustContain: ["/api/group-page/", "'/interest'"] });
      t.equal(H.htmlLang(page).slice(0, 2), "en", "the group page language");
      const rule = /if\(!\/(\^[^/]+\$)\/\.test\(code\)\)/.exec(page)?.[1];
      t.ok(rule, "the group page no longer checks the code in its link");
      L.check(new RegExp(rule).test(pageCode), `the group page would refuse its own share code ${pageCode} as "no longer available"`);
      // the Spanish page (a group with Spanish copy is shared as /es/group.html?g=; group.html's
      // language switch links there): it must be Spanish, ask for lang=es and accept the same codes
      const es = t.html(await t.get(`/es/group.html?g=${encodeURIComponent(pageCode)}`), { mustContain: ["/api/group-page/", "'/interest'"] });
      t.equal(H.htmlLang(es).slice(0, 2), "es", "the Spanish group page language");
      L.check(/var ES = document\.documentElement\.lang === 'es'/.test(es) && /'\?lang=' \+ \(ES \? 'es' : 'en'\)/.test(es), "the Spanish group page does not ask for the Spanish copy (lang=es)");
      L.check(/if\(!\/(\^[^/]+\$)\/\.test\(code\)\)/.exec(es)?.[1] === rule, "the Spanish group page accepts different share codes than the English one");
      const gone = await t.get("/api/group-page/zzzzzzzzzz");
      L.check(gone.status === 404, `a made-up group code should be a clean 404: ${gone.describe()}`);
      L.done("the group page journey");
      t.observe("live group pages", live.length, "info");
      t.observe("public group page keys", keysOf(lastPub));
      t.observe("public group page fact keys", keysOf(lastPub?.facts));
    },
  },
];
