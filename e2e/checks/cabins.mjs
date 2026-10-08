// e2e/checks/cabins.mjs — Room Concierge, the cabin finder, Conga Line ship ratings and the
// Cruising Guides (the prerendered guide pages and their sitemap).
//
// Incidents and risks these checks exist for:
//   2026-08-17  /api/cabins/fleet reported "no rooms" for 137 of 138 ships, and /api/cabins/check
//               told a booked cruiser their real cabin did not exist — both because a database read
//               silently stopped at 1,000 rows. A fleet list that LOOKS populated can still be wrong,
//               so the fleet is checked against the ratings list and the concierge's own ship list.
//   2026-08-17  Five Carnival ships were served Norwegian Spirit's cabins (class names matched across
//               lines) — every recommended room was a number that does not exist on the ship. So the
//               deck map and the cabin lookup are checked against each other, room by room.
//   2026-08-16  Mark's rule: the cabin check's internal confidence score is NEVER sent to the page
//               ("publishing it gives away the method"). Checked on every answer.
//   2026-08-14  Conga Line: nothing reaches the public until BOTH gates (approved + published) are
//               crossed, and a score is never shown that the ratings table does not hold. The
//               dashboard's list and the public list are two views of the same rows and must agree;
//               the hand-written "My Score" numbers in the 30-largest-ships guide must match the live
//               scores, or the guide quietly contradicts the concierge.
//   2026-08-27  A guide was stored correctly and its page was a 404 for most of an hour, with nothing
//               saying which state the site was in. /api/guides/status, the guides sitemap, the index
//               pages and the pages themselves are checked as one system.
//   2026-10-08  (found writing these checks) A Spanish guide page that is no longer in the data
//               (/es/guides/como-elegir-tu-primer-crucero.html) is still served on BOTH boxes, with
//               its own canonical — a duplicate of /es/guides/how-to-choose-your-first-cruise.html.
//   2026-10-08  (found writing these checks) /cabin-request.html and its Spanish twin put the ?ship=
//               and ?cabins= link text straight into the page as HTML, so a crafted link runs script
//               on stillafloatcruising.com.
//   2026-10-08  (found reviewing these checks) The "I'm already booked" answer serves stored research
//               prose raw: on Wonder of the Seas a sea-facing Ocean View Balcony is told its balcony
//               "faces inward" onto the Boardwalk, quoting "Royal Caribbean Blog" word for word (EN and
//               ES). The research zone is matched by deck and section only, never by which way the
//               room faces. 34 zones on 19 ships name a review source.
//   2026-10-08  (found reviewing these checks) /es/cabin-request.html sends no preferred_lang, so a
//               Spanish cabin request is filed as an English-speaking lead.
//   2026-08-21  Mark: "money is no object" suggested a Margaritaville ship — the budget answer must
//               change the ships; the language must not.
//
// SAFETY (read before adding anything here):
//   • POST /api/cabins/recommend writes every answer with a paid model call (jobs cabins.live and
//     cabins.steer) — only its refusal paths are exercised. Same for the Conga Line draft writer
//     (conga.draft). POST /api/cabins/check and /api/cabins/suggest-ships are pure database lookups
//     with no side effects; they are POSTs, so they run on dev only (prod mode refuses every POST).
//   • The Conga Line admin writes have no delete route, so nothing is ever created: only the paths
//     that refuse before touching the database (401, 400, 404) are exercised, plus an unpublish of a
//     slug that does not exist (an update that matches no row), proven to create nothing.
//   • POST /api/cabins/session writes an analytics row with no way to remove it — only a malformed
//     beacon (dropped before any write) is sent.
//   • POST /api/guides/prerender rewrites files in the site's public folder — never called with the
//     token; its refusal is checked, and its RESULT (pages on disk = pages in the data) is checked by
//     reading /api/guides/status, the sitemap and the pages the hourly job writes.
//   • Nothing here sends email, push or social posts, or buys anything. Samples are small
//     (first / middle / last), never whole lists.
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

const PROD_HOST = "stillafloatcruising.com";
const FIXTURE_SLUG = "e2e-fixture-no-such-ship";
const RATING_DISPLAY = /^[1-5]\.\d\/5 Conga Line$/;
// Words that must never appear in a rating's copy: "actually" is banned site-wide (Mark), and the
// score is presented as Still Afloat's own — the sources it is built from must never be named.
const BANNED_COPY = /\bactually\b|cruise\s*critic|cruiseline\.com|tripadvisor|\breview counts?\b/i;

/** How many common Spanish function words a text uses — 0 or 1 means it is not Spanish copy. */
const spanishWords = (s) => (String(s || "").toLowerCase().match(/(?:^|[^a-záéíóúñ])(el|la|los|las|del|que|con|para|por|una|pero|es|muy|más|si|te|tu|sin|hay|barco)(?=$|[^a-záéíóúñ])/g) || []).length;

// The "I'm already booked" answer is built from stored research. Two rules apply to anything a
// guest reads on that card (the steer-clear writer enforces both in validateSteerProse, and the
// Conga Line copy is held to them too): never name a review site, forum or reviewer, and never
// lift a reviewer's words verbatim.
const NAMES_A_SOURCE = /royal caribbean blog|cruise\s*critic|cruiseline\.com|tripadvisor|reddit|\bforums?\b|\breviewers?\b|\brese[ñn]as?\b|\bper [A-Z][\w&' ]{1,40}(?:blog|review)/i;
const LIFTED_QUOTE = /(?:^|[\s:(])['"“‘][a-záéíóúñ][^'"”’]{30,}['"”’]/;
// Lines /api/cabins/check only says when the research layer is missing or the ship's grid is thin.
const NO_RESEARCH = /I don't have research on this ship yet|our data on this ship is partial|No tengo investigaci[oó]n de este barco|nuestros datos de este barco son parciales/;
const RESEARCH_HEADLINES = ["Something may sit in your view", "Worth knowing what's near you"];
// What a neighbourhood (Central Park / Boardwalk) balcony is warned about — wrong for a room that faces the sea.
const INWARD_WARNING = /face inward|see into your cabin|miran hacia adentro|ver hacia el interior de tu camarote/i;

/** first, middle and last of a list (deduplicated) — a spread, never the whole list. */
const spread = (list, n = 3) => {
  if (list.length <= n) return [...list];
  const idx = new Set([0, list.length - 1]);
  for (let i = 1; idx.size < n; i++) idx.add(Math.floor((list.length * i) / n));
  return [...idx].sort((a, b) => a - b).map((i) => list[i]);
};

async function fleet(t) {
  const body = t.json(await t.get("/api/cabins/fleet"));
  t.ok(Array.isArray(body.ships), "the fleet answer has no ships list");
  t.atLeast(body.ships.length, 100, "ships in the Room Concierge fleet");
  return body.ships;
}

async function publicRatings(t) {
  const body = t.success(await t.get("/api/ships/ratings"), "ok");
  t.ok(Array.isArray(body.ratings), "the public ratings answer has no ratings list");
  t.atLeast(body.ratings.length, 100, "published Conga Line ratings");
  return body.ratings;
}

async function guidesStatus(t) {
  const s = t.success(await t.get("/api/guides/status"), "ok");
  t.fields(s, ["expected.en", "expected.es", "rendered.en", "rendered.es"], "the guides status");
  t.atLeast(s.expected.en, 5, "English guides the data says should be published");
  t.atLeast(s.expected.es, 5, "Spanish guides the data says should be published");
  return s;
}

async function guidesSitemap(t) {
  const res = await t.get("/guides-sitemap.xml");
  t.status(res, 200);
  t.ok(/<urlset[\s>]/.test(res.text), `the guides sitemap is not a sitemap: ${res.describe()}`);
  const locs = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  t.atLeast(locs.length, 7, "URLs in the guides sitemap");
  const paths = [];
  for (const loc of locs) {
    let u;
    try { u = new URL(loc); } catch { u = null; }
    t.ok(u && u.host === PROD_HOST && u.protocol === "https:", `the guides sitemap lists a URL that is not on https://${PROD_HOST}: "${loc}"`);
    paths.push(u.pathname);
  }
  return { res, paths };
}

export default [
  // ── Fleet, ships, ratings ──────────────────────────────────────────────────
  {
    id: "cabins.fleet-agrees-with-ratings",
    title: "Room Concierge's ship list is full, and every score on it is the published Conga Line score for that ship",
    covers: ["GET /api/cabins/fleet", "GET /api/ships/ratings"],
    modes: ["dev", "prod"],
    incident: "2026-08-17: the fleet list reported 'no rooms' for 137 of 138 ships (a read cut off at 1,000 rows)",
    run: async (t) => {
      const ships = await fleet(t);
      const slugs = new Set();
      const lines = new Set();
      for (const s of ships) {
        t.fields(s, ["ship", "slug", "line", "shipClass", "repSlug"], `fleet ship "${s?.slug || "?"}"`);
        t.ok(!slugs.has(s.slug), `ship "${s.slug}" is listed twice in the fleet`);
        slugs.add(s.slug); lines.add(s.line);
        t.ok(typeof s.hasRooms === "boolean", `ship "${s.slug}": hasRooms is not true/false`);
        t.ok(Array.isArray(s.regions), `ship "${s.slug}": regions is not a list`);
        t.ok(s.rating === null || (typeof s.rating === "number" && s.rating >= 1 && s.rating <= 5), `ship "${s.slug}": score ${s.rating} is outside 1 to 5`);
        // 2026-08-17: five Carnival ships were sent to Norwegian Spirit's rows because the rooms
        // were looked up by class NAME. Since then every ship reads its OWN rows ("Show me the
        // rooms" posts repSlug to /api/cabins/recommend); a repSlug pointing at another ship is
        // that bug coming back.
        t.equal(s.repSlug, s.slug, `"${s.ship}": the ship whose rooms "Show me the rooms" asks for`);
      }
      t.atLeast(lines.size, 6, "cruise lines in the fleet");
      const withRooms = ships.filter((s) => s.hasRooms).length;
      t.atLeast(withRooms, 100, "fleet ships with room-by-room picks (the 1,000-row bug showed 1)");
      t.atLeast(ships.filter((s) => s.regions.length).length, 20, "fleet ships with known sailing regions");

      // Two views of the same scores must agree, in both directions.
      const ratings = await publicRatings(t);
      const bySlug = new Map(ratings.map((r) => [r.ship_slug, r]));
      const rated = ships.filter((s) => s.rating !== null);
      t.atLeast(rated.length, 100, "fleet ships showing a Conga Line score");
      for (const s of rated) {
        t.ok(bySlug.has(s.slug), `"${s.ship}" shows a score of ${s.rating} in Room Concierge but has no published rating`);
        t.equal(bySlug.get(s.slug).rating, s.rating, `"${s.ship}": the concierge score and the published Conga Line score`);
      }
      for (const s of ships.filter((x) => x.rating === null)) {
        t.ok(!bySlug.has(s.slug), `"${s.ship}" has a published rating (${bySlug.get(s.slug)?.rating}) but Room Concierge shows no score`);
      }

      t.observe("fleet keys", keysOf(ships[0]));
      t.observe("fleet ships", ships.length, "min");
      t.observe("fleet ships with rooms", withRooms, "min");
      t.observe("fleet ships with a score", rated.length, "min");
      t.observe("cruise lines", [...lines].sort().join(","));
    },
  },
  {
    id: "cabins.ratings-list-and-detail-agree",
    title: "Each published Conga Line rating reads the same on the ship card as in the list, in English and Spanish, with clean copy",
    covers: ["GET /api/ships/ratings", "GET /api/ships/:slug/rating"],
    modes: ["dev", "prod"],
    incident: "2026-08-14: the score must read as Still Afloat's own — copy that names its sources or uses a banned word must never reach the page",
    run: async (t) => {
      const ratings = await publicRatings(t);
      const seen = new Set();
      for (const r of ratings) {
        t.fields(r, ["ship_slug", "rating", "rating_display", "comment", "salty_mark_take", "computed_at"], `rating "${r?.ship_slug || "?"}"`);
        t.ok(!seen.has(r.ship_slug), `ship "${r.ship_slug}" has two published ratings`);
        seen.add(r.ship_slug);
        t.ok(typeof r.rating === "number" && r.rating >= 1 && r.rating <= 5, `"${r.ship_slug}": score ${r.rating} is outside 1 to 5`);
        t.matches(r.rating_display, RATING_DISPLAY, `"${r.ship_slug}": the score label`);
        t.ok(!BANNED_COPY.test(r.comment) && !BANNED_COPY.test(r.salty_mark_take), `"${r.ship_slug}": the rating copy uses a banned word or names a review source`);
        t.ok(r.comment.trim() !== r.salty_mark_take.trim(), `"${r.ship_slug}": the Salty Mark take repeats the comment word for word`);
      }

      // The ship card (detail) for a spread of ships: first, middle, last.
      for (const r of spread(ratings)) {
        const en = t.success(await t.get(`/api/ships/${encodeURIComponent(r.ship_slug)}/rating`), "ok");
        t.equal(en.shipSlug, r.ship_slug, `the ship card for "${r.ship_slug}" answers for`);
        t.equal(en.rating, r.rating, `"${r.ship_slug}": the ship card's score and the list's score`);
        t.equal(en.ratingDisplay, r.rating_display, `"${r.ship_slug}": the ship card's score label and the list's`);
        t.equal(en.comment, r.comment, `"${r.ship_slug}": the ship card's comment and the list's`);
        t.nonEmpty(en.saltyMarkTake, `"${r.ship_slug}": the Salty Mark take`);
        const es = t.success(await t.get(`/api/ships/${encodeURIComponent(r.ship_slug)}/rating?lang=es`), "ok");
        t.equal(es.rating, r.rating, `"${r.ship_slug}": the Spanish ship card's score`);
        t.nonEmpty(es.comment, `"${r.ship_slug}": the Spanish comment`);
        t.ok(es.comment !== en.comment && es.saltyMarkTake !== en.saltyMarkTake,
          `"${r.ship_slug}": the Spanish Room Concierge shows the English rating copy (no Spanish translation is stored)`);
        t.ok(!BANNED_COPY.test(es.comment) && !BANNED_COPY.test(es.saltyMarkTake), `"${r.ship_slug}": the Spanish rating copy names a review source`);
        // "different from the English" is not enough — a stale or mis-keyed row can hold another
        // ship's English copy. The Spanish card must read as Spanish.
        t.ok(spanishWords(es.comment) >= 2 && spanishWords(es.saltyMarkTake) >= 2,
          `"${r.ship_slug}": the Spanish ship card's copy does not read as Spanish`);
        t.equal(es.ratingDisplay, r.rating_display, `"${r.ship_slug}": the Spanish ship card's score label`);
      }

      // A ship with no published rating is a clean "not found" (the page then shows no score).
      const none = await t.get(`/api/ships/${FIXTURE_SLUG}/rating`);
      t.ok(none.status === 404 && none.json?.ok === false, `a ship with no rating should answer 404 ok=false: ${none.describe()}`);

      t.observe("ratings keys", keysOf(ratings[0]));
      t.observe("ship card keys", keysOf((await t.get(`/api/ships/${encodeURIComponent(ratings[0].ship_slug)}/rating`)).json));
      t.observe("published ratings", ratings.length, "min");
    },
  },
  {
    id: "cabins.dashboard-ratings-match-public",
    title: "The Conga Line ratings Mark approved and published in the dashboard are exactly the ones the public sees (and the list refuses anyone without the token)",
    covers: ["GET /api/admin/conga-line", "GET /api/ships/ratings"],
    modes: ["dev", "prod"],
    incident: "2026-08-14: nothing reaches the public until BOTH gates (approved, published) are crossed",
    run: async (t) => {
      const anon = await t.get("/api/admin/conga-line");
      t.ok(anon.status === 401, `the ratings admin list must refuse a visitor without the token: ${anon.describe()}`);

      const admin = t.success(await t.get("/api/admin/conga-line", { auth: true }), "ok");
      t.ok(Array.isArray(admin.ratings) && Array.isArray(admin.sources), "the ratings admin list has no ratings or sources list");
      t.atLeast(admin.ratings.length, 100, "ratings in the dashboard");
      t.atLeast(admin.sources.length, 100, "captured review-source rows in the dashboard");
      const live = admin.ratings.filter((r) => r.status === "published" && r.comment_status === "approved");

      const pub = await publicRatings(t);
      const pubBy = new Map(pub.map((r) => [r.ship_slug, r]));
      const liveBy = new Map(live.map((r) => [r.ship_slug, r]));
      for (const r of live) {
        t.ok(pubBy.has(r.ship_slug), `"${r.ship_slug}" is approved and published in the dashboard but missing from the public ratings`);
        t.equal(Number(pubBy.get(r.ship_slug).rating), Number(r.rating), `"${r.ship_slug}": dashboard score vs public score`);
      }
      for (const r of pub) t.ok(liveBy.has(r.ship_slug), `"${r.ship_slug}" is public but is not approved AND published in the dashboard`);

      t.observe("dashboard ratings", admin.ratings.length, "min");
      t.observe("dashboard ratings held back (draft or unapproved)", admin.ratings.length - live.length, "info");
      t.observe("dashboard rating keys", keysOf(admin.ratings[0]));
    },
  },
  {
    id: "cabins.concierge-ship-list-in-fleet",
    title: "The cabin finder's ship list is populated and every ship on it can be opened in Room Concierge",
    covers: ["GET /api/cabins/ships", "GET /api/cabins/fleet", "page /cabin-finder.html"],
    modes: ["dev", "prod"],
    run: async (t) => {
      // the (English-only) page that reads this list
      const html = t.html(await t.get("/cabin-finder.html"), { mustContain: ["/api/cabins/ships", "/api/cabins/recommend"] });
      t.equal(H.htmlLang(html).slice(0, 2), "en", "/cabin-finder.html language");
      t.nonEmpty(H.title(html), "/cabin-finder.html title");
      t.observe("/cabin-finder.html title", H.title(html));

      const body = t.json(await t.get("/api/cabins/ships"));
      t.ok(Array.isArray(body.ships), "the cabin finder's ship list is missing");
      t.atLeast(body.ships.length, 30, "ships the cabin finder offers");
      const ships = await fleet(t);
      const bySlug = new Map(ships.map((s) => [s.slug, s]));
      for (const s of body.ships) {
        t.fields(s, ["slug", "ship", "line", "class"], `cabin finder ship "${s?.slug || "?"}"`);
        t.ok(Number.isInteger(s.total_cabins) && s.total_cabins >= 100 && s.total_cabins <= 4000,
          `"${s.ship}": ${s.total_cabins} cabins is not a plausible count for a cruise ship`);
        t.ok(bySlug.has(s.slug), `"${s.ship}" is offered by the cabin finder but is not in the Room Concierge fleet (held out of the fleet, or not a sailing ship)`);
        t.ok(bySlug.get(s.slug).hasRooms === true, `"${s.ship}" is offered by the cabin finder but Room Concierge says it has no room picks`);
        t.equal(bySlug.get(s.slug).ship, s.ship, `"${s.slug}": ship name in the cabin finder vs Room Concierge`);
      }


      t.observe("cabin finder ship keys", keysOf(body.ships[0]));
      t.observe("cabin finder ships", body.ships.length, "min");
    },
  },
  {
    id: "cabins.deck-maps-for-loaded-ships",
    title: "Our own deck map draws real cabins for a spread of ships that have room picks",
    covers: ["GET /api/cabins/deckmap", "GET /api/cabins/fleet"],
    modes: ["dev", "prod"],
    incident: "2026-08-17: ships were served another ship's cabins; the deck map is the ground truth for which rooms exist",
    run: async (t) => {
      const ships = (await fleet(t)).filter((s) => s.hasRooms);
      // Four ships (first, two between, last) — never the whole fleet. Each is asked for its decks in a
      // fixed order until one draws cabins (MSC numbers its cabin decks differently, so 8 is not enough).
      const DECKS = [8, 7, 6, 9, 5, 10, 4];
      const sample = spread(ships, 4);
      for (const s of sample) {
        let found = null;
        for (const deck of DECKS) {
          const d = t.json(await t.get(`/api/cabins/deckmap?ship=${encodeURIComponent(s.repSlug)}&deck=${deck}`));
          t.ok(Array.isArray(d.cabins), `"${s.ship}" deck ${deck}: the deck map has no cabins list`);
          t.equal(d.deck, deck, `"${s.ship}": the deck map answered for deck`);
          if (d.cabins.length) { found = d; break; }
        }
        t.ok(found, `"${s.ship}" has room picks but its deck map is empty on decks ${DECKS.join(", ")}`);
        t.atLeast(found.cabins.length, 15, `"${s.ship}" deck ${found.deck}: cabins drawn`);
        const nums = new Set();
        let categorised = 0;
        for (const c of found.cabins) {
          t.nonEmpty(String(c.cabin_num ?? ""), `"${s.ship}" deck ${found.deck}: a cabin number`);
          t.ok(!nums.has(String(c.cabin_num)), `"${s.ship}" deck ${found.deck}: cabin ${c.cabin_num} is drawn twice`);
          nums.add(String(c.cabin_num));
          t.ok(Number.isFinite(c.x) && Number.isFinite(c.y), `"${s.ship}" cabin ${c.cabin_num}: no position on the map`);
          if (c.category) categorised++;
        }
        t.ok(categorised / found.cabins.length >= 0.9, `"${s.ship}" deck ${found.deck}: only ${categorised} of ${found.cabins.length} cabins have a category`);
      }
      // A request without a deck is refused cleanly, not crashed.
      const bad = await t.get(`/api/cabins/deckmap?ship=${encodeURIComponent(sample[0].repSlug)}`);
      t.ok(bad.status === 400, `a deck map request with no deck should be 400: ${bad.describe()}`);
      t.observe("deck map ships sampled", sample.map((s) => s.slug).join(","), "info");
    },
  },

  // ── The concierge's lookups (POSTs that only read — dev only) ──────────────
  {
    id: "cabins.cabin-check-matches-deck-map",
    title: "\"I'm already booked — is my view OK?\" answers for real rooms on two cruise lines (English and Spanish) from our own research, without quoting review sites, helps with a typo, and never shows the internal confidence score",
    covers: ["POST /api/cabins/check", "GET /api/cabins/deckmap", "GET /api/cabins/fleet"],
    modes: ["dev"],
    devOnlyBecause: "the cabin lookup is a POST and prod sweeps are read-only (it is a pure database read with no side effect: no model call, no write)",
    incident: "2026-08-17: a booked cruiser was told their real cabin did not exist (a read cut off at 1,000 rows), and the answer ignored the 478 research zones it exists for; 2026-08-16: confidence must never be sent to the page",
    run: async (t) => {
      // Wonder of the Seas (2,886 cabins — well past the old 1,000-row cut; deck 8 numbers sort
      // last, so they are the rows a capped read loses). Six rooms: a spread of the whole deck plus
      // a spread of its ocean-view balconies (the rooms most guests ask about). ~20 requests in all.
      const ship = "wonder-of-the-seas";
      const map = t.json(await t.get(`/api/cabins/deckmap?ship=${ship}&deck=8`));
      t.atLeast((map.cabins || []).length, 100, "Wonder of the Seas deck 8 cabins on the deck map");
      const sorted = [...map.cabins].sort((a, b) => String(a.cabin_num).localeCompare(String(b.cabin_num), "en", { numeric: true }));
      const onMap = new Set(sorted.map((c) => String(c.cabin_num)));
      const seaBalconies = sorted.filter((c) => /ocean/i.test(c.category || "") && /balcony/i.test(c.category || "") && !/park|boardwalk|promenade/i.test(c.category || ""));
      t.require(seaBalconies.length >= 3, "the deck map shows no sea-facing balconies on Wonder of the Seas deck 8, so the balcony answers cannot be checked");
      const sample = [...new Map([...spread(sorted, 3), ...spread(seaBalconies, 3)].map((c) => [String(c.cabin_num), c])).values()];

      const copyRules = (r, label) => {
        const text = [r.headline, ...(r.body || [])].join(" ");
        t.ok(!/confidence/i.test(JSON.stringify(r)), `${label}: the answer exposes the internal confidence score (Mark, 2026-08-16: never rendered)`);
        t.ok(!NAMES_A_SOURCE.test(text), `${label}: the answer names a review site, blog, forum or reviewer ("${(text.match(NAMES_A_SOURCE) || [""])[0]}")`);
        t.ok(!LIFTED_QUOTE.test(text), `${label}: the answer quotes a reviewer word for word`);
        t.ok(!NO_RESEARCH.test(text), `${label}: says it has no research or only partial data for Wonder of the Seas — the research layer did not load`);
      };

      const en = new Map();
      let researched = 0;
      for (const c of sample) {
        const label = `cabin ${c.cabin_num} (${c.category || "no category"})`;
        const r = t.json(await t.send("POST", "/api/cabins/check", { body: { ship, cabin: String(c.cabin_num) } }));
        t.equal(r.found, true, `${label} (on the deck map) found by the cabin check`);
        t.equal(String(r.cabin), String(c.cabin_num), "the cabin the check answered for");
        t.ok(Array.isArray(r.where) && r.where.includes("Deck 8"), `${label}: the check does not place it on Deck 8 (${JSON.stringify(r.where)})`);
        if (c.category) t.ok(r.where.includes(c.category), `${label}: the check's category disagrees with the deck map`);
        t.nonEmpty(r.headline, `${label}: headline`);
        t.ok(Array.isArray(r.body) && r.body.length >= 1 && r.body.every((p) => typeof p === "string" && p.trim().length > 20), `${label}: the answer has no real text`);
        t.nonEmpty(r.cta, `${label}: the next-step question`);
        copyRules(r, label);
        if (seaBalconies.includes(c)) {
          t.ok(!INWARD_WARNING.test(r.body.join(" ")), `${label}: a sea-facing balcony is told its balcony faces inward onto the Boardwalk/Central Park and that passers-by can see in`);
        }
        if (RESEARCH_HEADLINES.includes(r.headline)) researched++;
        en.set(String(c.cabin_num), r);
      }
      // Every deck-8 window room on Wonder sits in at least one researched zone; if none of the
      // sampled answers comes from the research, the zones did not load (the moat silently off).
      t.ok(researched >= 1, `none of the ${sample.length} sampled Wonder of the Seas rooms got an answer from our research (headlines: ${[...en.values()].map((r) => r.headline).join(" | ")})`);

      // Spanish: the same rooms, really in Spanish — not the English answer with a Spanish label.
      for (const c of [sample[0], seaBalconies[Math.floor(seaBalconies.length / 2)]]) {
        const label = `cabin ${c.cabin_num} in Spanish`;
        const es = t.json(await t.send("POST", "/api/cabins/check", { body: { ship, cabin: String(c.cabin_num), lang: "es" } }));
        t.equal(es.found, true, `${label}: found`);
        t.ok(Array.isArray(es.where) && es.where.includes("Cubierta 8"), `${label}: does not say "Cubierta 8" (${JSON.stringify(es.where)})`);
        t.matches(es.cta, /^¿/, `${label}: the next-step question`);
        const enR = en.get(String(c.cabin_num)) || t.json(await t.send("POST", "/api/cabins/check", { body: { ship, cabin: String(c.cabin_num) } }));
        t.ok(es.headline !== enR.headline, `${label}: the headline is the English one`);
        t.ok(Array.isArray(es.body) && es.body.length >= 1 && !es.body.some((p) => enR.body.includes(p)), `${label}: part of the answer is served in English`);
        t.ok(spanishWords(es.body.join(" ")) >= 3, `${label}: the answer does not read as Spanish`);
        copyRules(es, label);
        if (seaBalconies.includes(c)) t.ok(!INWARD_WARNING.test(es.body.join(" ")), `${label}: a sea-facing balcony is told its balcony faces inward`);
      }

      // A typo: not found, with near matches that really are on the ship.
      const typo = t.json(await t.send("POST", "/api/cabins/check", { body: { ship, cabin: "81ZZ9" } }));
      t.equal(typo.found, false, "a cabin number that does not exist");
      t.nonEmpty(typo.message, "the not-found message");
      t.ok(Array.isArray(typo.near) && typo.near.length > 0 && typo.near.every((n) => String(n).startsWith("81")),
        `a typo should offer near matches starting "81": ${JSON.stringify(typo.near)}`);
      t.ok(typo.near.some((n) => onMap.has(String(n))), `none of the near matches offered for a typo is a deck 8 room on the deck map: ${JSON.stringify(typo.near)}`);

      // A second line, so a lookup that only works for the ship it was built on is caught (the
      // 2026-08-17 Carnival/Norwegian mix-up): the first Carnival ship with room picks in the fleet.
      const fleetShips = await fleet(t);
      const other = fleetShips.find((s) => /carnival/i.test(s.line) && s.hasRooms);
      t.require(other, "no Carnival ship in the fleet has room picks, so the cabin check cannot be tested on a second line");
      let found = null;
      for (const deck of [8, 7, 6, 9, 5]) {
        const d = t.json(await t.get(`/api/cabins/deckmap?ship=${encodeURIComponent(other.repSlug)}&deck=${deck}`));
        if ((d.cabins || []).length) { found = d; break; }
      }
      t.ok(found, `"${other.ship}" has room picks but its deck map is empty`);
      const pick = [...found.cabins].sort((a, b) => String(a.cabin_num).localeCompare(String(b.cabin_num), "en", { numeric: true }))[Math.floor(found.cabins.length / 2)];
      const oc = t.json(await t.send("POST", "/api/cabins/check", { body: { ship: other.slug, cabin: String(pick.cabin_num) } }));
      t.equal(oc.found, true, `"${other.ship}" cabin ${pick.cabin_num} (on its deck map) found by the cabin check`);
      t.ok(Array.isArray(oc.where) && oc.where.includes(`Deck ${found.deck}`), `"${other.ship}" cabin ${pick.cabin_num}: placed on the wrong deck (${JSON.stringify(oc.where)})`);
      copyRules(oc, `"${other.ship}" cabin ${pick.cabin_num}`);

      // Missing fields are refused.
      const missing = await t.send("POST", "/api/cabins/check", { body: { ship } });
      t.ok(missing.status === 400, `a cabin check with no cabin number should be 400: ${missing.describe()}`);
      t.observe("cabin check keys", keysOf([...en.values()][0]));
      t.observe("cabin check second ship", other.slug, "info");
    },
  },
  {
    id: "cabins.ship-suggestions",
    title: "\"Help me choose a ship\" suggests two real ships from different lines that fit the answers, in English and Spanish",
    covers: ["POST /api/cabins/suggest-ships", "GET /api/cabins/fleet"],
    modes: ["dev"],
    devOnlyBecause: "ship suggestions are a POST and prod sweeps are read-only (it is a pure database lookup — no model call, no write)",
    run: async (t) => {
      const ships = await fleet(t);
      const bySlug = new Map(ships.map((s) => [s.slug, s]));
      const westCarib = ships.filter((s) => s.regions.includes("w_caribbean")).length;
      t.require(westCarib > 0, "no ship in the fleet has a Western Caribbean deployment, so the destination answer cannot be tested");
      const personas = [
        { what: "a sociable couple headed to the Western Caribbean", lang: "en", body: { personality: { energy: "social", social: "extrovert", structure: "planner", splurge: "value", crowds: "fine" }, party: "couple", traits: { food: 2 }, budget: "treat", destination: "w_caribbean" } },
        { what: "a quiet couple for whom money is no object (Spanish)", lang: "es", body: { personality: { energy: "quiet", social: "introvert", splurge: "cabin", crowds: "avoids" }, party: "couple", budget: "sky", lang: "es" } },
        // The same answers in English: the language must change the words, never the ships.
        { what: "a quiet couple for whom money is no object (English)", lang: "en", body: { personality: { energy: "quiet", social: "introvert", splurge: "cabin", crowds: "avoids" }, party: "couple", budget: "sky" } },
      ];
      const shipsFor = {};
      for (const p of personas) {
        const r = t.json(await t.send("POST", `/api/cabins/suggest-ships${p.lang === "es" ? "?lang=es" : ""}`, { body: p.body }));
        t.ok(Array.isArray(r.picks), `${p.what}: no picks list`);
        t.equal(r.picks.length, 2, `${p.what}: number of ships suggested`);
        t.ok(r.picks[0].line !== r.picks[1].line, `${p.what}: both suggestions are from the same cruise line`);
        for (const s of r.picks) {
          t.fields(s, ["ship", "slug", "line", "repSlug"], `${p.what}: a suggested ship`);
          t.ok(bySlug.has(s.slug), `${p.what}: suggested "${s.ship}" is not in the Room Concierge fleet`);
          t.equal(s.rating, bySlug.get(s.slug).rating, `${p.what}: "${s.ship}" score in the suggestion vs the fleet (only published scores may show)`);
        }
        t.nonEmpty(r.reason, `${p.what}: the reason`);
        if (p.lang === "es") t.matches(r.reason, /^Las? elegí/, `${p.what}: the Spanish reason`);
        else t.matches(r.reason, /^I picked/, `${p.what}: the English reason`);
        if (r.worthALook) {
          t.fields(r.worthALook, ["ship", "slug", "line", "why"], `${p.what}: the "worth a look" ship`);
          t.ok(!r.picks.some((x) => x.line === r.worthALook.line), `${p.what}: the "worth a look" ship repeats a suggested line`);
          t.equal(r.worthALook.rating, bySlug.get(r.worthALook.slug)?.rating, `${p.what}: "worth a look" score vs the fleet`);
        }
        if (p.body.destination) {
          t.ok(r.picks.some((s) => s.regions.includes(p.body.destination)), `${p.what}: neither suggestion sails where they said they are headed`);
        }
        if (p.body.budget === "sky") {
          // Mark, 2026-08-21: "we chose money is no object and the result was MAS paradise as one
          // of the ships. not one i would consider luxury." Margaritaville is the value line.
          const value = [...r.picks, ...(r.worthALook ? [r.worthALook] : [])].filter((s) => /margaritaville/i.test(s.line));
          t.ok(value.length === 0, `${p.what}: "money is no object" still suggests ${value.map((s) => s.ship).join(", ")}`);
        }
        if (p.lang === "es") {
          for (const s of r.picks) {
            if (s.nextLevel) t.ok(spanishWords(s.nextLevel.why) >= 2 && !/\bthe\b|\byou\b/i.test(s.nextLevel.why), `${p.what}: the "step up" note on "${s.ship}" is not in Spanish`);
          }
          if (r.worthALook) t.matches(r.worthALook.why, /^Quizá/, `${p.what}: the Spanish "worth a look" note`);
        }
        shipsFor[p.what.replace(/ \((English|Spanish)\)$/, "")] ??= {};
        shipsFor[p.what.replace(/ \((English|Spanish)\)$/, "")][p.lang] = [...r.picks.map((s) => s.slug), r.worthALook?.slug || "-"].join(",");
        t.observe(`suggestion keys (${p.lang})`, keysOf(r));
      }
      const twin = shipsFor["a quiet couple for whom money is no object"];
      t.equal(twin.es, twin.en, "the same answers in Spanish and English: ships suggested (the language changed the ships)");
    },
  },
  {
    id: "cabins.recommend-refuses-bad-requests",
    title: "Room picks refuse a request with no ship or an unknown ship (refusal only: a real request is written by a paid model)",
    covers: ["POST /api/cabins/recommend"],
    modes: ["dev"],
    devOnlyBecause: "it sends POSTs; a successful request calls the paid model (cabins.live / cabins.steer), so only the refusals are exercised",
    run: async (t) => {
      const none = await t.send("POST", "/api/cabins/recommend", { body: { room: "balcony" } });
      t.ok(none.status === 400 && /ship/i.test(none.json?.error || ""), `room picks with no ship should be 400 "ship is required": ${none.describe()}`);
      const unknown = await t.send("POST", "/api/cabins/recommend", { body: { ship: FIXTURE_SLUG, room: "balcony" } });
      t.ok(unknown.status === 404 && /unknown ship/i.test(unknown.json?.error || ""), `room picks for a ship we do not have should be 404 "Unknown ship": ${unknown.describe()}`);
    },
  },
  {
    id: "cabins.session-beacon-drops-junk",
    title: "The concierge's visit beacon answers instantly and drops a malformed beacon (refusal only: a real beacon writes an analytics row nothing can remove)",
    covers: ["POST /api/cabins/session"],
    modes: ["dev"],
    devOnlyBecause: "it sends a POST; only a malformed beacon is sent so nothing is written",
    run: async (t) => {
      const r = await t.send("POST", "/api/cabins/session", { body: { sessionId: "e2e-fixture-not-a-uuid", lang: "en", path: "ship" } });
      t.ok(r.status === 204, `the beacon must answer 204 no matter what: ${r.describe()}`);
      t.equal(r.text, "", "the beacon's answer must carry nothing a caller could probe");
    },
  },

  // ── Conga Line admin writes: refusal paths only ─────────────────────────────
  {
    id: "cabins.rating-admin-writes-refused",
    title: "The Conga Line admin actions refuse anyone without the token and refuse incomplete input before touching any rating (refusal paths only)",
    covers: [
      "POST /api/admin/conga-line/:slug/sources", "POST /api/admin/conga-line/:slug/draft-comment",
      "POST /api/admin/conga-line/:slug/save", "POST /api/admin/conga-line/:slug/publish",
      "POST /api/admin/conga-line/:slug/unpublish", "GET /api/admin/conga-line",
    ],
    modes: ["dev"],
    devOnlyBecause: "it sends POSTs; there is no delete route, so no rating row is ever created — only refusals, and an unpublish of a slug that does not exist",
    run: async (t) => {
      const base = `/api/admin/conga-line/${FIXTURE_SLUG}`;
      for (const action of ["sources", "draft-comment", "save", "publish", "unpublish"]) {
        const r = await t.send("POST", `${base}/${action}`, { body: {} });
        t.ok(r.status === 401, `"${action}" must refuse a request without the token: ${r.describe()}`);
      }
      const src = await t.send("POST", `${base}/sources`, { auth: true, body: { source: "tripadvisor", sourceScore: 4 } });
      t.ok(src.status === 400 && src.json?.ok === false, `a source other than the two locked ones must be refused: ${src.describe()}`);
      // no source score → refused before the paid draft writer is ever called
      const draft = await t.send("POST", `${base}/draft-comment`, { auth: true, body: { ship: "E2E Fixture" } });
      t.ok(draft.status === 400 && draft.json?.ok === false, `a draft with no source score must be refused before any model call: ${draft.describe()}`);
      const low = await t.send("POST", `${base}/save`, { auth: true, body: { rating: 0, comment: "x", saltyMarkTake: "y" } });
      t.ok(low.status === 400 && /between 1 and 5/.test(low.json?.error || ""), `a score below 1 must be refused: ${low.describe()}`);
      const half = await t.send("POST", `${base}/save`, { auth: true, body: { rating: 4 } });
      t.ok(half.status === 400 && half.json?.ok === false, `a save with no comment or Salty Mark take must be refused: ${half.describe()}`);
      const pub = await t.send("POST", `${base}/publish`, { auth: true, body: {} });
      t.ok(pub.status === 404 && pub.json?.ok === false, `publishing a ship with no saved draft must be refused: ${pub.describe()}`);
      const unpub = t.success(await t.send("POST", `${base}/unpublish`, { auth: true, body: {} }), "ok");
      t.equal(unpub.unpublished, true, "unpublish answer");
      // ...and it created nothing.
      const admin = t.success(await t.get("/api/admin/conga-line", { auth: true }), "ok");
      t.atLeast((admin.ratings || []).length, 100, "ratings in the dashboard");
      t.ok(!admin.ratings.some((r) => r.ship_slug === FIXTURE_SLUG) && !admin.sources.some((r) => r.ship_slug === FIXTURE_SLUG),
        "a refused or no-op admin action left a fixture row behind in the ratings tables");
    },
  },

  // ── Cruising Guides ─────────────────────────────────────────────────────────
  {
    id: "cabins.guides-site-matches-data",
    title: "Every published Cruising Guide has its page, in each language it is written in, and the hourly guide job has run",
    covers: ["GET /api/guides/status", "job scheduleGuidesPrerender", "data:guides-sitemap"],
    modes: ["dev", "prod"],
    incident: "2026-08-27: a stored guide was a 404 for most of an hour with nothing saying so",
    run: async (t) => {
      const s = await guidesStatus(t);
      t.equal(s.missing.en.length, 0, "English guides published in the data with no page (each is a 404)");
      t.equal(s.missing.es.length, 0, "Spanish guides published in the data with no page (each is a 404)");
      t.atLeast(s.rendered.en, s.expected.en, "English guide pages on disk");
      t.atLeast(s.rendered.es, s.expected.es, "Spanish guide pages on disk");
      // The job rewrites the sitemap every hour (and 50 seconds after boot).
      const { res } = await guidesSitemap(t);
      const lm = res.headers.get("last-modified");
      t.ok(lm, "the guides sitemap carries no Last-Modified date, so the hourly guide job cannot be seen running");
      t.fresh(Date.parse(lm), 2.5, "the guides sitemap (rewritten by the hourly guide job)");
      t.observe("guides expected (en)", s.expected.en, "min");
      t.observe("guides expected (es)", s.expected.es, "min");
    },
  },
  {
    id: "cabins.guides-no-orphan-pages",
    title: "No guide page is still being served after its guide left the data (an orphan is a duplicate Google can index)",
    covers: ["GET /api/guides/status", "data:guide-pages"],
    modes: ["dev", "prod"],
    incident: "2026-10-08: /es/guides/como-elegir-tu-primer-crucero.html is still served on both boxes, duplicating /es/guides/how-to-choose-your-first-cruise.html",
    run: async (t) => {
      const s = await guidesStatus(t);
      t.equal(s.rendered.en, s.expected.en, "English guide pages on disk vs English guides in the data (extra pages are orphans still being served)");
      t.equal(s.rendered.es, s.expected.es, "Spanish guide pages on disk vs Spanish guides in the data (extra pages are orphans still being served)");
    },
  },
  {
    id: "cabins.guides-sitemap-index-pages-agree",
    title: "The guides sitemap, the English and Spanish guide index pages and the guide pages themselves all list the same guides, and each page is the right language with correct links",
    covers: ["GET /api/guides/status", "data:guides-sitemap", "data:guides-index-pages", "data:guide-pages"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const s = await guidesStatus(t);
      const { paths } = await guidesSitemap(t);
      const enPages = paths.filter((p) => /^\/guides\/[a-z0-9-]+\.html$/.test(p));
      const esPages = paths.filter((p) => /^\/es\/guides\/[a-z0-9-]+\.html$/.test(p));
      t.ok(paths.includes("/guides.html") && paths.includes("/es/guides.html"), "the guides sitemap does not list both guide index pages");
      t.equal(enPages.length, s.expected.en, "English guide pages in the sitemap vs the data");
      t.equal(esPages.length, s.expected.es, "Spanish guide pages in the sitemap vs the data");
      t.equal(new Set(paths).size, paths.length, "the guides sitemap lists a URL twice");

      // the index pages link to exactly the guides in the sitemap
      for (const [idx, list, lang] of [["/guides.html", enPages, "en"], ["/es/guides.html", esPages, "es"]]) {
        const html = t.html(await t.get(idx));
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${idx} language`);
        t.nonEmpty(H.h1s(html), `${idx} heading`);
        const linked = [...new Set(H.links(html).map((h) => { try { return new URL(h, `https://${PROD_HOST}/`).pathname; } catch { return ""; } })
          .filter((p) => (lang === "es" ? /^\/es\/guides\/[^/]+\.html$/ : /^\/guides\/[^/]+\.html$/).test(p)))].sort();
        t.equal(linked.join(","), [...list].sort().join(","), `${idx}: the guides it links to vs the sitemap`);
        t.observe(`${idx} title`, H.title(html));
      }

      // a spread of guide pages in each language (first, middle, last)
      const all = new Set(paths);
      for (const p of [...spread(enPages), ...spread(esPages)]) {
        const lang = p.startsWith("/es/") ? "es" : "en";
        const html = t.html(await t.get(p));
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        t.nonEmpty(H.title(html), `${p} title`);
        t.nonEmpty(H.h1s(html), `${p} heading`);
        t.atLeast(H.visibleText(html).length, 1500, `${p}: characters of readable text`);
        // lang="es" on the page is not the same as Spanish words in it (an untranslated body
        // rendered into the Spanish template would pass every other assertion here).
        if (lang === "es") t.atLeast(spanishWords(H.visibleText(html)), 40, `${p}: common Spanish words in the article (is the body in Spanish?)`);
        t.equal(H.canonical(html), `https://${PROD_HOST}${p}`, `${p} canonical link`);
        for (const [hl, href] of Object.entries(H.hreflangs(html))) {
          let hp = "";
          try { hp = new URL(href).pathname; } catch { /* bad URL fails below */ }
          t.ok(all.has(hp), `${p}: its "${hl}" language link points to ${href}, which is not a published guide page`);
        }
        t.ok(H.links(html).some((h) => h === (lang === "es" ? "/es/work-with-mark.html" : "/work-with-mark.html")),
          `${p}: the "Work with Mark" button is missing or points to the wrong language`);
      }
      const gone = await t.get("/guides/e2e-fixture-no-such-guide.html");
      t.ok(gone.status === 404, `a guide that does not exist should be 404: ${gone.describe()}`);
      t.observe("guides in sitemap", paths.length, "min");
    },
  },
  {
    id: "cabins.guide-scores-match-ratings",
    title: "The \"My Score\" numbers in the 30-largest-ships guide (English and Spanish) match the live Conga Line ratings",
    covers: ["GET /api/ships/ratings", "GET /api/cabins/fleet", "data:guide-pages", "flow:guide-scores-match-conga-ratings"],
    modes: ["dev", "prod"],
    incident: "2026-08-14: guide scores are typed into the guide; a quarterly ratings refresh would leave the guide contradicting Room Concierge",
    run: async (t) => {
      const slug = "30-largest-cruise-ships-in-the-world";
      const { paths } = await guidesSitemap(t);
      t.require(paths.includes(`/guides/${slug}.html`) && paths.includes(`/es/guides/${slug}.html`),
        `the 30-largest-ships guide is not published in both languages on this box, so its scores cannot be compared`);
      const ratings = await publicRatings(t);
      const rating = new Map(ratings.map((r) => [r.ship_slug, r.rating]));
      const ships = await fleet(t);
      // ship name → slug: the fleet's names, plus a title-cased name for rated ships outside the fleet (Arvia, Iona…)
      const names = new Map(ships.map((s) => [s.slug, s.ship]));
      for (const r of ratings) if (!names.has(r.ship_slug)) names.set(r.ship_slug, r.ship_slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "));
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const [path, label, tooSoon] of [[`/guides/${slug}.html`, "My Score", "Too soon to tell"], [`/es/guides/${slug}.html`, "Mi Puntaje", "Muy pronto para saber"]]) {
        const text = H.visibleText(t.html(await t.get(path))).replace(/&amp;/g, "&");
        let matched = 0;
        for (const [shipSlug, name] of names) {
          const re = new RegExp(`${esc(name)} \\([^)]{2,40}\\) ${label} (\\d\\.\\d|${esc(tooSoon)})`, "g");
          for (const m of text.matchAll(re)) {
            matched++;
            if (m[1] === tooSoon) t.ok(!rating.has(shipSlug), `${path}: "${name}" says "${tooSoon}" but has a published score of ${rating.get(shipSlug)}`);
            else t.equal(Number(m[1]), rating.get(shipSlug), `${path}: "${name}" guide score vs the live Conga Line score`);
          }
        }
        t.atLeast(matched, 20, `${path}: ship scores found and compared`);
        t.observe(`${path} scores compared`, matched, "min");
      }
    },
  },
  {
    id: "cabins.guides-prerender-refused",
    title: "The \"re-render the guides now\" action refuses anyone without the token (refusal only: with the token it rewrites the site's files)",
    covers: ["POST /api/guides/prerender"],
    modes: ["dev"],
    devOnlyBecause: "it sends a POST; with the token it rewrites files in the public folder, so only the refusal is exercised",
    run: async (t) => {
      const r = await t.send("POST", "/api/guides/prerender", { body: {} });
      t.ok(r.status === 401 && r.json?.success === false, `re-rendering the guides must refuse a request without the token: ${r.describe()}`);
    },
  },

  // ── The pages ────────────────────────────────────────────────────────────────
  {
    id: "cabins.concierge-pages-wired",
    title: "Room Concierge (English and Spanish) loads, asks the right endpoints in its own language, and its \"Send my picks\" button opens the request page in the same language",
    covers: ["page /room-concierge.html", "page /es/room-concierge.html", "page /cabin-request.html", "page /es/cabin-request.html", "flow:concierge-to-cabin-request"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const NEEDS = ["/api/cabins/fleet", "/api/cabins/suggest-ships", "/api/cabins/recommend", "/api/cabins/check", "/api/cabins/session", "/api/ships/"];
      for (const [p, lang, request] of [["/room-concierge.html", "en", "/cabin-request.html"], ["/es/room-concierge.html", "es", "/es/cabin-request.html"]]) {
        const html = t.html(await t.get(p), { mustContain: NEEDS });
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        t.equal(H.canonical(html), `https://${PROD_HOST}${p}`, `${p} canonical link`);
        t.nonEmpty(H.title(html), `${p} title`);
        t.ok(html.includes(`href="${request}`), `${p}: "Send my picks" does not open ${request}`);
        if (lang === "es") {
          for (const call of ["/api/cabins/fleet?lang=es", "/api/cabins/suggest-ships?lang=es", "/api/cabins/recommend?lang=es", "/rating?lang=es"]) {
            t.ok(html.includes(call), `${p} asks for ${call.split("?")[0]} without ?lang=es — Spanish visitors would get English`);
          }
          t.ok(/lang:\s*LANG/.test(html) && /const\s+LANG\s*=\s*["']es["']/.test(html), `${p}: the cabin check is not sent in Spanish`);
          t.ok(!html.includes('href="/cabin-request.html'), `${p} links to the English request page`);
        } else {
          t.ok(!/\?lang=es|&lang=es/.test(html), `${p} asks the API for Spanish answers on the English page`);
          t.ok(/const\s+LANG\s*=\s*["']en["']/.test(html), `${p}: the page does not declare itself English for the cabin check`);
        }
        // The link "Send my picks" builds and the request page reads must use the same names, or
        // the picks silently vanish on the way to Mark.
        const sent = [...html.matchAll(new RegExp(`href="${request.replace(/\./g, "\\.")}\\?([^"]+)"`, "g"))]
          .flatMap((m) => [...m[1].matchAll(/(?:^|&)([a-z_]+)=/g)].map((x) => x[1]));
        t.ok(sent.includes("ship") && sent.includes("cabins"), `${p}: "Send my picks" does not carry ?ship= and ?cabins= (${sent.join(",") || "nothing"})`);
        const req = t.html(await t.get(request), { mustContain: ["/api/contact", "cabin-concierge"] });
        for (const name of ["ship", "cabins"]) {
          t.ok(new RegExp(`\\.get\\(\\s*["']${name}["']\\s*\\)`).test(req), `${request} never reads ?${name}= — the picks Room Concierge sends would not show`);
        }
        t.equal(H.htmlLang(req).slice(0, 2), lang, `${request} language`);
        t.equal(H.canonical(req), `https://${PROD_HOST}${request}`, `${request} canonical link`);
        t.observe(`${p} title`, H.title(html));
        t.observe(`${request} title`, H.title(req));
      }
    },
  },
  {
    id: "cabins.concierge-language-twins",
    title: "Room Concierge's English and Spanish pages point search engines at each other",
    covers: ["page /room-concierge.html", "page /es/room-concierge.html"],
    modes: ["dev", "prod"],
    run: async (t) => {
      // hreflang only counts when it is reciprocal: an English page that does not name its Spanish
      // twin makes Google ignore the Spanish page's claim too.
      const en = H.hreflangs(t.html(await t.get("/room-concierge.html")));
      const es = H.hreflangs(t.html(await t.get("/es/room-concierge.html")));
      const twin = (map, l) => Object.entries(map).find(([k]) => k.toLowerCase().startsWith(l))?.[1] || "";
      t.equal(twin(es, "en"), `https://${PROD_HOST}/room-concierge.html`, "/es/room-concierge.html: its English twin link");
      t.equal(twin(es, "es"), `https://${PROD_HOST}/es/room-concierge.html`, "/es/room-concierge.html: its own Spanish link");
      t.equal(twin(en, "es"), `https://${PROD_HOST}/es/room-concierge.html`, "/room-concierge.html: its Spanish twin link (missing, so the pair is not reciprocal)");
      t.equal(twin(en, "en"), `https://${PROD_HOST}/room-concierge.html`, "/room-concierge.html: its own English link");
    },
  },
  {
    id: "cabins.spanish-request-reaches-mark-as-spanish",
    title: "A cabin request sent from the Spanish page reaches Mark marked as a Spanish speaker, the way the Spanish \"Work with Mark\" form does",
    covers: ["page /es/cabin-request.html", "flow:concierge-to-cabin-request"],
    modes: ["dev", "prod"],
    incident: "found 2026-10-08 reviewing these checks: /es/cabin-request.html posts to /api/contact without preferred_lang, which the route stores as \"en\" — a Spanish lead is filed as English",
    run: async (t) => {
      // A successful POST /api/contact emails Mark and the visitor, so the request itself is read
      // from the page (the same body the browser sends), not submitted.
      const wwm = t.html(await t.get("/es/work-with-mark.html"), { mustContain: ["/api/contact"] });
      t.ok(/preferred_lang/.test(wwm), "/es/work-with-mark.html no longer sends preferred_lang — the reference this check compares against changed");
      const es = t.html(await t.get("/es/cabin-request.html"), { mustContain: ["/api/contact"] });
      const body = (es.match(/fetch\(\s*["']\/api\/contact["'][\s\S]*?JSON\.stringify\(\{([\s\S]*?)\}\)/) || [])[1] || "";
      t.nonEmpty(body, "/es/cabin-request.html: the request it sends to /api/contact");
      t.ok(/referral_source:\s*["']cabin-concierge-es["']/.test(body), "/es/cabin-request.html: the request is not tagged as coming from the Spanish concierge");
      t.ok(/preferred_lang:\s*["']es["']/.test(body), "/es/cabin-request.html sends no preferred_lang: \"es\", so /api/contact files the Spanish visitor as an English speaker");
    },
  },
  {
    id: "cabins.request-page-escapes-link-text",
    title: "The \"Send your cabins to Mark\" page (English and Spanish) shows the ship and cabins from its link as text, never as page code",
    covers: ["page /cabin-request.html", "page /es/cabin-request.html"],
    modes: ["dev", "prod"],
    incident: "2026-10-08: ?ship= and ?cabins= are written into the page with innerHTML unescaped — a crafted link runs script on stillafloatcruising.com",
    run: async (t) => {
      const unsafe = [];
      for (const p of ["/cabin-request.html", "/es/cabin-request.html"]) {
        const html = t.html(await t.get(p), { mustContain: ["URLSearchParams"] });
        // every variable read from the link…
        const vars = [...html.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*[A-Za-z_$][\w$]*\.get\(\s*["'][^"']+["']\s*\)/g)].map((m) => m[1]);
        t.nonEmpty(vars, `${p}: the values it reads from its link`);
        // …must never be interpolated raw into an innerHTML template.
        // Every HTML sink: innerHTML / outerHTML assignment, insertAdjacentHTML, document.write —
        // as a template literal or as string concatenation (a rewrite from one to the other must not
        // slip past). A value passed through a function first (an escaper) is not flagged.
        const htmlWrites = [
          ...[...html.matchAll(/\.(?:inner|outer)HTML\s*[+]?=\s*`([\s\S]*?)`\s*;/g)].map((m) => ({ tpl: true, code: m[1] })),
          ...[...html.matchAll(/(?:\.(?:inner|outer)HTML\s*[+]?=|insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\()\s*([^`][^;]*);/g)].map((m) => ({ tpl: false, code: m[1] })),
        ];
        t.nonEmpty(htmlWrites, `${p}: the places it writes the picks into the page`);
        for (const v of vars) {
          const id = v.replace(/\$/g, "\\$");
          const raw = htmlWrites.some(({ tpl, code }) => (tpl && new RegExp(`\\$\\{\\s*${id}\\s*\\}`).test(code))
            || new RegExp(`(?:^|[+]\\s*)${id}\\s*(?:[+]|$|\\))`).test(code.trim()));
          if (raw) unsafe.push(`${p} ?${v}=`);
        }
      }
      t.ok(unsafe.length === 0, `the link's values are written into the page as HTML without escaping, so a crafted link can run script on the site: ${unsafe.join(", ")}`);
    },
  },
];
