// e2e/checks/ships.mjs — Where's My Ship (the live cruise-ship tracker), ship watches, the storm
// pages' "Track this ship" sign-up, and the live cams page with its "ships in port now" lists.
//
// Risks and incidents these checks exist for:
//   2026-09-22  MSC Meraviglia showed a 13 July position for 71 days: a ship outside the free feed's
//               subscription goes silent for months and the page still draws her. Freshness is a
//               property of the WHOLE tracker, so it is measured across the followed fleet, not on one ship.
//   2026-09-24  aisstream closed prod's sockets on sight for more than a day while the page kept
//               answering from memory. "trackerOnline" / "healthy" must be true, not just present.
//   2026-09-15  "Track this ship" on the storm pages only opened the tracker; it now opens a one-step
//               sign-up (/track-ship.html). A storm sailing whose ship the tracker does not know gets no
//               link (`trackable`), so the storm list and the tracker's registry must agree, both ways.
//   2026-09-14  The cams page lists which tracked ships are in frame at each port: it is computed from
//               the tracker's memory, so a cam's ship must be one the tracker holds, at the same fix.
//   2026-10-08  Release candidate (dev) adds estimates, route lines, nearby ships and planned sailings
//               to /api/wms/position. Those fields do not exist on prod (main) until the promotion, so
//               ships.position-route-line FAILS on prod until then — that is expected, not a reason to weaken it.
//
// FRESHNESS RULE (from server/src/lib/ship-tracker.ts, dead-reckoning.ts and position-provider.ts):
//   • the feed is healthy only if a socket is open AND a message arrived in the last 15 minutes
//     (trackerHealthy) — the endpoint reports that itself and it must be true;
//   • a fix under 20 minutes old is shown as-is (ESTIMATE_AFTER_MIN, LOOKUP_AFTER_MIN);
//   • a fix over 48 hours old is "history, not a position" (STALE_FIX_H) — the page draws nothing ahead.
//   Terrestrial AIS only hears ships near shore, so a ship at sea is legitimately hours old. The rule
//   used here: of the ships the tracker is FOLLOWING (live), at least half were heard within 48 hours
//   and at least 3 within the last hour. (2026-10-08 01:40 UTC: prod 76 of 79 within 48 h, 17 within
//   1 h; dev 41 of 45 and 14.)
//
// PAID-POSITION SAFETY: GET /api/wms/position BUYS a Live-AIS position (1 credit, $0.02) on either box
// whenever the ship's free fix is older than 20 minutes (staleForInquiry). These checks only ask for
// ships whose /api/wms/health fix is under 15 minutes old at the moment of asking (5 minutes of margin)
// and whose name the tracker holds exactly once (getPosition reads the first match),
// for at most 3 ships per run across the file (2 + 1), plus one name that is not in the registry
// (unknown names never reach the paid lookup). POST /api/wms/request, POST /api/wms/watch and
// POST /api/wms/track-signup can buy positions, write subscriber rows and send real email, so only
// their refusal paths are exercised (dev only), and the rest is recorded as gaps in coverage/ships.json.
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

const FRESH_FOR_POSITION_MIN = 15;   // must stay below LOOKUP_AFTER_MIN (20) — see the header
const NO_SUCH_SHIP = "e2e-fixture no such ship";
const NOBODY_EMAIL = "e2e-fixture-nobody@example.invalid";

const lc = (s) => String(s ?? "").trim().toLowerCase();
const ageMin = (t, iso) => (t.now() - Date.parse(iso)) / 60_000;
/** "Carnival Cruise Line", "Carnival Cruises" and "Carnival" are one line. */
const lineKey = (s) => lc(s).replace(/&/g, "and").replace(/\b(cruise lines?|cruises|cruise|international|line)\b/g, "").replace(/[^a-z0-9]+/g, "");
const validLatLon = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01);

/**
 * The tracker script (/js/wheres-my-ship.js) is shared by both languages and takes every visible
 * string from the page's inline `const T = {…}`. A key the script reads that the page does not define
 * is `undefined` on screen, or — for the function-valued ones (T.checking(ship), T.nearby(n, nm)) —
 * a TypeError that stops the tracker the moment a ship is picked. Found 2026-10-08 by this check:
 * the 2026-09-23 "bring dev up to what prod runs" merge (06a26a3) put prod's pages back on dev
 * and dropped the nine strings the 2026-09-10 tracker work added, while the script kept reading them.
 */
const stripStrings = (src) => src.replace(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");
function pageStringKeys(html) {
  const m = /const T\s*=\s*\{([\s\S]*?)\n\};/.exec(html);
  if (!m) return null;
  let depth = 0, top = "";
  for (const ch of stripStrings(m[1])) {
    if ("{[(".includes(ch)) { depth++; continue; }
    if ("}])".includes(ch)) { depth--; continue; }
    if (depth === 0) top += ch;
  }
  return new Set([...top.matchAll(/(?:^|[,\s])([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]));
}
const scriptStringKeys = (js) => [...new Set([...js.matchAll(/\bT\.([A-Za-z_$][\w$]*)/g)].map((x) => x[1]))].sort();

/**
 * GET without following the redirect, so a check can tell WHICH branch a redirecting handler took
 * (the harness follows redirects and keeps only the first address). Counted like any request.
 * Used only for GET /api/wms/watch/stop on dev with a forged link.
 */
async function getNoFollow(t, path) {
  t.requests++;
  try {
    const r = await t.fetchImpl(t.url(path), {
      method: "GET", redirect: "manual", headers: { "user-agent": "saf-e2e/1 (whole-site release gate)" }, signal: AbortSignal.timeout(20_000),
    });
    await r.text().catch(() => "");
    return { status: r.status, location: r.headers.get("location") || "" };
  } catch (e) {
    t.ok(false, `GET ${path.split("?")[0]} did not answer (${String(e?.message || e).slice(0, 100)})`);
  }
}

/**
 * Each write-refusal run uses its own client address. The per-IP limits in wms.ts / track-signup.ts
 * (10–20 an hour) key on X-Forwarded-For, and without one every request through nginx shares a
 * single bucket — so the gate must neither eat real visitors' budget nor be refused by its own last run.
 * 198.18.0.0/15 is the benchmarking range: never a real visitor.
 */
const gateClient = () => ({ "x-forwarded-for": `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}` });

async function registry(t) {
  const body = t.success(await t.get("/api/wms/ships"), "ok");
  t.ok(Array.isArray(body.ships), "the tracker's ship list has no ships array");
  t.atLeast(body.ships.length, 250, "ships in the tracker's search list");
  const byName = new Map();
  for (const s of body.ships) {
    t.fields(s, ["name", "cruiseLine"], `a ship in the search list (${s?.name || "unnamed"})`);
    t.ok(typeof s.live === "boolean" && typeof s.tracked === "boolean", `ship "${s.name}" has no live/tracked flags`);
    t.ok(!byName.has(lc(s.name)), `ship "${s.name}" is listed twice in the search list`);
    byName.set(lc(s.name), s);
  }
  return { body, byName };
}

async function health(t) {
  const h = t.success(await t.get("/api/wms/health"), "ok");
  t.ok(Array.isArray(h.ships), "the tracker health answer has no ships array");
  return h;
}

/** Ships safe to ask /api/wms/position about: followed, fix under 15 minutes old (never a purchase). */
function freshShips(t, h, byName) {
  // getPosition() answers with the FIRST position held under a name. If the tracker holds two under
  // one name (an old and a new MMSI after a rename), health could show the fresh one while the position
  // endpoint reads the stale one — and buys. So a name held twice is never asked about.
  const held = new Map();
  for (const s of h.ships) held.set(lc(s.name), (held.get(lc(s.name)) || 0) + 1);
  return h.ships
    .filter((s) => held.get(lc(s.name)) === 1)
    .filter((s) => s.hasFix && s.lastPosAt && byName.get(lc(s.name))?.live)
    .map((s) => ({ ...s, age: ageMin(t, s.lastPosAt), cruiseLine: byName.get(lc(s.name)).cruiseLine }))
    .filter((s) => s.age >= -10 && s.age < FRESH_FOR_POSITION_MIN)
    .sort((a, b) => a.age - b.age);
}

async function position(t, ship, healthFix) {
  // re-check just before asking: never let a slow run turn this into a paid lookup
  t.ok(ageMin(t, healthFix) < FRESH_FOR_POSITION_MIN,
    `refusing to ask for ${ship}: its fix is now ${ageMin(t, healthFix).toFixed(1)} minutes old and asking could buy a position`);
  return t.success(await t.get(`/api/wms/position?ship=${encodeURIComponent(ship)}`), "ok");
}

export default [
  {
    id: "ships.search-list-and-pages",
    basis: "ruling: stillafloat-tracker-design-mark-2026-09-24.md — Mark 9/24: the tracker is inquiry-driven and live slots exist only for watches and storms, so an idle tracker is legitimate; search covers every ship in the registry (ship-tracker.ts header)",
    title: "Where's My Ship (English and Spanish) loads its ship search with every cruise ship we cover, reports the tracker's state and slots truthfully, and has every on-screen message the tracker shows in both languages",
    covers: ["GET /api/wms/ships", "page /wheres-my-ship.html", "page /es/wheres-my-ship.html"],
    modes: ["dev", "prod"],
    incident: "2026-09-24: the free AIS feed was refused for a day while the page kept answering from memory; since 2026-09-23 (dev, 06a26a3) both tracker pages lack nine strings the script reads, so picking a ship throws on T.checking",
    run: async (t) => {
      const { body, byName } = await registry(t);
      // Whether the tracker is following anyone right now is not a property of the site: by Mark's design a
      // slot exists only for a ship pinned to a live storm, a 15-day watch, or a ship asked for in the last
      // hour (ship-tracker.ts header; tracker design 2026-09-24), so an idle tracker is legitimate.
      // What the site promises is that it says so truthfully and that the box has the AIS key (slots > 0).
      t.ok(typeof body.trackerOnline === "boolean", "the ship list does not say whether the tracker is online");
      t.fields(body, ["capacity.active", "capacity.max"], "the tracker's capacity");
      t.ok(body.capacity.max > 0 && body.capacity.active >= 0 && body.capacity.active <= body.capacity.max,
        `the tracker's slots make no sense: following ${body.capacity.active} ships of ${body.capacity.max}`);
      const ships = body.ships;
      const live = ships.filter((s) => s.live).length;
      const tracked = ships.filter((s) => s.tracked).length;
      t.ok(live <= body.capacity.active, `${live} ships are marked live but the tracker only holds ${body.capacity.active} slots`);
      t.ok(tracked / ships.length >= 0.9, `only ${tracked} of ${ships.length} ships have an AIS identity on file — the rest can never be found`);
      const lines = new Set(ships.map((s) => s.cruiseLine));
      t.atLeast(lines.size, 25, "cruise lines in the search list");
      for (const must of ["Carnival", "Royal Caribbean", "Norwegian", "MSC", "Princess", "Celebrity"]) {
        t.ok(lines.has(must), `the search list has no ${must} ships`);
      }

      // The pages: right language, wired to the API, and their promise matches the list.
      const js = await t.get("/js/wheres-my-ship.js");
      t.status(js, 200);
      t.ok(js.text.length > 5000, `the tracker script is only ${js.text.length} bytes`);
      for (const api of ["/api/wms/ships", "/api/wms/position", "/api/wms/request", "/api/wms/watch", "/api/weather?place="]) {
        t.ok(js.text.includes(api), `the tracker script no longer calls ${api}`);
      }
      // The fields the API test below and ships.position-* assert are the ones the page draws from.
      for (const field of ["d.ships", "d.tracking", "d.reason", "d.ship", "d.cruiseLine", "d.position", "d.lastReportedMinAgo", "d.stale", "d.destination", "d.courseDeg", "d.speedKn"]) {
        t.ok(js.text.includes(field), `the tracker script no longer reads "${field}" from the API`);
      }
      const used = scriptStringKeys(js.text);
      t.atLeast(used.length, 15, "page strings the tracker script reads (T.…)");
      for (const [p, lang, shipsRe, linesRe] of [
        ["/wheres-my-ship.html", "en", /(\d{3}) ships/, /(\d{2}) lines/],
        ["/es/wheres-my-ship.html", "es", /(\d{3}) barcos/, /(\d{2}) líneas/],
      ]) {
        const html = t.html(await t.get(p), { mustContain: ["/js/wheres-my-ship.js", 'id="ship-input"'] });
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        // The script picks its language from the page, and every string it shows from the page's T.
        t.equal(/const LANG\s*=\s*['"](\w+)['"]/.exec(html)?.[1], lang, `${p}: the language the tracker script is told (LANG)`);
        const defined = pageStringKeys(html);
        t.ok(defined && defined.size >= 15, `${p} no longer defines the tracker's strings (const T = {…})`);
        const missing = used.filter((k) => !defined.has(k));
        t.ok(missing.length === 0,
          `${p} does not define ${missing.length} string(s) the tracker script reads (T.${missing.join(", T.")}) — a visitor sees "undefined", and a missing function (T.checking, T.nearby, T.planned) stops the tracker when a ship is picked`);
        // the script's cache-buster on this page: recorded so a release that changes the script without bumping it shows up
        t.observe(`${lang} tracker script version`, /\/js\/wheres-my-ship\.js\?v=([\w.-]+)/.exec(html)?.[1] || "none", "info");
        const alt = H.hreflangs(html);
        t.ok(/\/wheres-my-ship\.html$/.test(alt.en || "") && /\/es\/wheres-my-ship\.html$/.test(alt["es-419"] || alt.es || ""),
          `${p} does not link its English and Spanish twins (hreflang)`);
        // "315 ships across 36 lines": a page that promises more than the search can find misleads.
        // A couple of ships are routinely off the list (renames, refits), so 3% is tolerated.
        const claimed = Number(shipsRe.exec(html)?.[1]);
        t.ok(Number.isFinite(claimed), `${p} no longer says how many ships it covers`);
        t.ok(Math.abs(claimed - ships.length) <= Math.ceil(ships.length * 0.03),
          `${p} promises ${claimed} ships but the search list has ${ships.length}`);
        const claimedLines = Number(linesRe.exec(html)?.[1]);
        t.ok(Number.isFinite(claimedLines) && Math.abs(claimedLines - lines.size) <= 1,
          `${p} promises ${claimedLines} cruise lines but the search list has ${lines.size}`);
        t.observe(`${lang} title`, H.title(html));
        t.observe(`${lang} promised ship count`, claimed, "info");
      }
      t.ok(byName.size === ships.length, "ship names collide in the search list");
      t.observe("keys", keysOf(body));
      t.observe("ship keys", keysOf(ships[0]));
      t.observe("page strings the tracker script reads", used.join(","));
      t.observe("ships in search list", ships.length, "min");
      t.observe("cruise lines", lines.size, "min");
      t.observe("ships followed live", live, "info");
      t.observe("tracker online", body.trackerOnline, "info");
      t.observe("tracker slots", body.capacity.max, "info");
    },
  },
  {
    id: "ships.tracker-hearing-ships",
    basis: "ruling: stillafloat-tracker-design-mark-2026-09-24.md — Mark 9/24 and 10/9: positions are pulled only on a tracking request or a named storm's track, so how many ships are heard is the world; the site must keep its own two views of the tracker in agreement (routes/wms.ts)",
    title: "The tracker's two views of the fleet agree: its health list, the ship search list and the weather cards name the same ships and ports, and its online flag says the same on both endpoints",
    covers: ["GET /api/wms/health", "GET /api/wms/ships"],
    modes: ["dev", "prod"],
    incident: "2026-09-22: MSC Meraviglia sat on a 71-day-old position; 2026-09-24: the feed was refused for a day",
    run: async (t) => {
      // Mark, 2026-10-09 (positions are pulled only on a tracking request or a named storm's track, by
      // design): how many ships the tracker holds, how recently they were heard and whether a message
      // arrived in the last 15 minutes depend on who asked and on the weather, not on the site. The
      // earlier version of this check demanded >= 3 ships heard in the last hour and a healthy feed;
      // both are states of the world. What the site does promise: the box has its AIS key, the two
      // endpoints that report the tracker's state agree with each other, and every ship and port the
      // tracker names is one the rest of the site knows.
      const h = await health(t);
      t.equal(h.enabled, true, "the tracker has an AIS key (enabled)");
      t.ok(typeof h.healthy === "boolean", "the tracker health answer does not say whether the feed is healthy");
      const { body, byName } = await registry(t);
      // two reads of the health answer bracket the ship-list read, so a feed that flips online/offline between
      // the requests cannot make the two endpoints look like they disagree
      const h2 = await health(t);
      t.ok(body.trackerOnline === (h.enabled && h.healthy) || body.trackerOnline === (h2.enabled && h2.healthy),
        `the ship search list says the tracker is ${body.trackerOnline ? "online" : "offline"} but the tracker health list says ${h.healthy ? "healthy" : "not healthy"} (then ${h2.healthy ? "healthy" : "not healthy"})`);

      // Two views of the same fleet: everything health reports is a registry ship, and every ship the
      // search list marks "live" is one the tracker is holding.
      const hp = new Map();
      const destinations = new Set();
      for (const s of h.ships) {
        t.fields(s, ["name"], "a ship in the tracker health list");
        t.ok(byName.has(lc(s.name)), `the tracker holds "${s.name}", which is not in the ship search list`);
        // getPosition() takes the first position under a name: two under one name means the map can show
        // the stale one (and the position endpoint buys a fix for it every time she is asked about)
        t.ok(!hp.has(lc(s.name)), `the tracker holds two positions under the name "${s.name}" (an old MMSI after a rename?)`);
        if (s.destination) destinations.add(s.destination);
        if (s.lastPosAt) {
          t.ok(Number.isFinite(Date.parse(s.lastPosAt)), `"${s.name}" has an unreadable last-position time`);
          t.ok(ageMin(t, s.lastPosAt) > -10, `"${s.name}" reports a position from the future (${s.lastPosAt})`);
        }
        t.ok(!s.hasFix || s.lastPosAt, `"${s.name}" has a fix with no time`);
        hp.set(lc(s.name), s);
      }
      const live = [...byName.values()].filter((s) => s.live);
      for (const s of live) t.ok(hp.has(lc(s.name)), `"${s.name}" is marked live in the search but the tracker holds nothing for her`);

      // The tracker shows an arrival-day weather card from /api/weather?place=<her destination>: every
      // port the tracker decodes as a destination must be a place the weather service knows, or the card
      // silently disappears. (?list=true is the fast path: no forecast fetch, no synopsis.)
      const wx = t.success(await t.get("/api/weather?list=true"), "ok");
      const places = new Set([...(wx.allEmbarkationPorts || []), ...(wx.allDestinations || [])].map((p) => p?.slug));
      t.atLeast(places.size, 40, "places the weather service knows");
      const unknown = [...destinations].filter((d) => !places.has(d));
      t.ok(unknown.length === 0, `the tracker sends ships to port(s) the weather card cannot show: ${unknown.join(", ")}`);
      t.observe("ships held by the tracker", h.ships.length, "info");
      t.observe("tracker healthy", h.healthy, "info");
      t.observe("destination ports held", destinations.size, "info");
      if (h.ships.length) t.observe("health ship keys", keysOf(h.ships[0]));
      t.observe("health keys", keysOf(h));
    },
  },
  {
    id: "ships.position-fresh-ship",
    basis: "ruling: stillafloat-tracker-design-mark-2026-09-24.md — Mark 9/24: an inquiry answers from the held fix and only buys a Live-AIS position when it is stale; an unknown ship is answered cleanly",
    title: "Picking a ship the tracker already holds a fresh fix for shows her at that real position, with her line, course and speed; an unknown ship or no ship is answered cleanly",
    covers: ["GET /api/wms/position", "GET /api/wms/health", "GET /api/wms/ships"],
    modes: ["dev", "prod"],
    run: async (t) => {
      // Two ships at most (the freshest, and the freshest of a different line): see PAID-POSITION SAFETY.
      const { byName } = await registry(t);
      const h = await health(t);
      const fresh = freshShips(t, h, byName);
      // Whether any ship was heard in the last 15 minutes is a state of the world (positions are pulled
      // only for a tracking request or a storm's track — Mark 2026-10-09), so its absence is not a failure:
      // asking about a ship whose fix is older would BUY a position. When one exists, assert it; either
      // way the unknown-ship and missing-name answers below are the site's own promises.
      const picks = fresh.length ? [fresh[0], fresh.find((s) => s.cruiseLine !== fresh[0].cruiseLine)].filter(Boolean) : [];
      for (const s of picks) {
        const d = await position(t, s.name, s.lastPosAt);
        t.equal(d.tracking, true, `${s.name} is shown as tracked`);
        t.equal(lc(d.ship), lc(s.name), `${s.name}: the position answer names`);
        t.equal(d.cruiseLine, s.cruiseLine, `${s.name}: the line shown on the map vs the search list`);
        t.fields(d, ["position.lat", "position.lon", "lastReportedAt"], `${s.name}'s position`);
        t.ok(validLatLon(d.position.lat, d.position.lon), `${s.name} is placed at an impossible point (${d.position.lat}, ${d.position.lon})`);
        t.ok(Date.parse(d.lastReportedAt) >= Date.parse(s.lastPosAt),
          `${s.name}: the map shows an older fix (${d.lastReportedAt}) than the tracker holds (${s.lastPosAt})`);
        t.ok(Number.isFinite(d.lastReportedMinAgo) && d.lastReportedMinAgo <= 20, `${s.name}: "${d.lastReportedMinAgo} minutes ago" for a ship heard within ${FRESH_FOR_POSITION_MIN}`);
        t.equal(d.stale, false, `${s.name}: the out-of-range caveat on a fresh fix`);
        t.ok(d.speedKn === null || (d.speedKn >= 0 && d.speedKn <= 40), `${s.name}: speed ${d.speedKn} knots is not a cruise ship's`);
        t.ok(d.courseDeg === null || (d.courseDeg >= 0 && d.courseDeg <= 360), `${s.name}: course ${d.courseDeg}° is not a heading`);
        if (d.destination) {
          t.fields(d.destination, ["slug", "name"], `${s.name}'s next port`);
          t.ok(validLatLon(d.destination.lat, d.destination.lon), `${s.name}'s next port has no real coordinates`);
        }
        if (s === picks[0]) t.observe("position keys", keysOf(d));
      }
      t.observe("ships asked for (0 = none had a fix fresh enough to ask without buying one)", picks.length, "info");

      // a name the registry does not know: a clean "unknown", never a crash (and never a paid lookup)
      const unknown = t.success(await t.get(`/api/wms/position?ship=${encodeURIComponent(NO_SUCH_SHIP)}`), "ok");
      t.equal(unknown.tracking, false, "an unknown ship is not shown as tracked");
      t.equal(unknown.reason, "unknown_ship", "the reason given for a ship we do not cover");
      const missing = await t.get("/api/wms/position");
      t.status(missing, 400);
    },
  },
  {
    id: "ships.position-route-line",
    basis: "code: server/src/routes/wms.ts — GET /wms/position returns route, estimate, nearby and planned; no estimate under 20 minutes; a line exists only where a water path does ('No path → no line')",
    title: "The tracker script draws the travelled line, estimate, nearby ships and planned sailing; for a ship with a fresh fix the answer carries them well-formed and invents no estimate",
    covers: ["GET /api/wms/position"],
    modes: ["dev", "prod"],
    incident: "2026-09-15: route lines ran straight across Baja; 2026-10-08: estimates, route lines and planned sailings are in the release candidate only — this check FAILS on prod until the promotion",
    run: async (t) => {
      // ONE ship (see PAID-POSITION SAFETY). The page promise is unconditional; the shape of the answer is
      // asserted for a ship whose fix is already fresh. That one exists only if someone asked for a ship
      // or a storm named one (Mark 2026-10-09: by design) — its absence is not a failure, and asking about
      // an older one would buy a position.
      const js = await t.get("/js/wheres-my-ship.js");
      t.status(js, 200);
      for (const field of ["d.estimate", "route", "nearby", "planned"]) t.ok(js.text.includes(field), `the tracker script never reads "${field}"`);
      const { byName } = await registry(t);
      const fresh = freshShips(t, await health(t), byName);
      t.observe("ships asked for (0 = none had a fix fresh enough to ask without buying one)", fresh.length ? 1 : 0, "info");
      if (!fresh.length) return;
      const s = fresh[0];
      const d = await position(t, s.name, s.lastPosAt);
      t.equal(d.tracking, true, `${s.name} is shown as tracked`);
      t.ok("route" in d && "estimate" in d && "nearby" in d && "planned" in d,
        `${s.name}: the position answer has no route / estimate / nearby / planned fields (the 2026-10 tracker release is not on this box)`);
      t.ok(["ais", "satellite"].includes(d.source), `${s.name}: unknown position source "${d.source}"`);
      // under 20 minutes the fix is shown as-is (ESTIMATE_AFTER_MIN): an estimate here is invented
      t.equal(d.estimate, null, `${s.name}: an estimated position for a ship heard ${s.age.toFixed(0)} minutes ago`);

      // A line exists only where a water path does (route lines never cross land — wms.ts: "No path → no
      // line"), so a ship with no declared destination and no track has none; what is drawn must be real.
      const r = d.route;
      t.ok(r && Array.isArray(r.travelled) && Array.isArray(r.between) && Array.isArray(r.ahead), `${s.name}: the route line is missing or malformed`);
      const paths = [...r.travelled, ...r.between, r.ahead].filter((p) => p.length);
      for (const p of paths) {
        t.atLeast(p.length, 2, `${s.name}: points in a route segment`);
        for (const pt of [p[0], p[Math.floor(p.length / 2)], p[p.length - 1]]) {
          t.ok(Array.isArray(pt) && validLatLon(pt[0], pt[1]), `${s.name}: a route point is not a real coordinate (${JSON.stringify(pt)})`);
        }
      }
      if (r.travelled.length) {
        const run = r.travelled[r.travelled.length - 1];
        const end = run[run.length - 1];
        t.ok(end[0] === d.position.lat && end[1] === d.position.lon, `${s.name}: the travelled line does not end where she was last heard`);
      }
      t.equal(d.nearbyRadiusNm, 10, `${s.name}: the "nearby ships" radius in nautical miles`);
      t.ok(Array.isArray(d.nearby), `${s.name}: the nearby-ships list is missing`);
      for (const n of d.nearby.slice(0, 10)) {
        t.fields(n, ["name", "cruiseLine"], `${s.name}: a nearby ship`);
        t.ok(lc(n.name) !== lc(s.name), `${s.name} is listed as near herself`);
        t.ok(byName.has(lc(n.name)), `${s.name}: nearby ship "${n.name}" is not in the search list`);
        t.ok(n.distanceNm <= d.nearbyRadiusNm && n.minAgo <= 60, `${s.name}: nearby ship "${n.name}" is ${n.distanceNm} nm / ${n.minAgo} min away`);
      }
      if (d.planned) {
        t.fields(d.planned, ["ref", "source", "startDate"], `${s.name}: the planned sailing`);
        t.ok(Array.isArray(d.planned.ports) && d.planned.ports.length >= 2, `${s.name}: a planned sailing with fewer than two ports`);
        t.ok(Array.isArray(d.planned.segments), `${s.name}: the planned sailing has no water line`);
      }
      t.observe("route keys", keysOf(r));
      t.observe("has planned sailing", Boolean(d.planned), "info");
      t.observe("nearby ships", d.nearby.length, "info");
    },
  },
  {
    id: "ships.storm-track-links",
    basis: "ruling: stillafloat-storm-alerts.md — Mark 9/15: a Track-this-ship call to action next to each ship in a storm's affected area, one-step 15-day sign-up; dev holds a seeded storm fixture (mark-whole-site-e2e-release-gate 10/4)",
    title: "Every \"Track this ship\" link the Storm Watch pages (English and Spanish) offer names a ship the tracker is following, matches the storm's own page, and opens the sign-up page (with its Keep-tracking button) in the same language",
    covers: ["GET /api/storm-watch", "GET /api/storm-watch/:id", "GET /api/wms/ships", "page /track-ship.html", "page /es/track-ship.html",
      "page /storm-watch.html", "page /es/storm-watch.html", "page /index.html", "page /es/index.html"],
    modes: ["dev", "prod"],
    incident: "2026-09-15: the storm pages' Track-this-ship button was rebuilt as a one-step sign-up",
    run: async (t) => {
      const sw = t.success(await t.get("/api/storm-watch"));
      t.ok(Array.isArray(sw.systems), "the public storm list has no systems array");
      const sailings = sw.systems.flatMap((s) => (s.sailings || []).map((v) => ({ v, s })));
      // Whether a named storm is threatening a sailing right now is the weather, not the site, so prod is
      // never required to have one: with no storm there is no link to compare, and the pages' link builder
      // and the sign-up page (below) are still tested. DEV is different: Mark's 2026-10-04 mirror ruling is
      // that dev holds the conditions prod can have (a live storm alert), seeded on purpose as a fixture.
      if (t.mode === "dev") {
        t.require(sailings.length > 0,
          "dev has no public storm with affected sailings, so no Track-this-ship link exists to compare (Mark 2026-10-04: dev holds a seeded storm fixture — approve it)");
      }
      const { byName } = await registry(t);

      // `trackable` comes from the tracker's in-memory registry; the search list comes from the database.
      // They must agree both ways: a known ship with no link, or a link to a ship the tracker cannot find, both break.
      let trackable = 0;
      for (const { v, s } of sailings) {
        t.ok(typeof v.trackable === "boolean", `storm "${s.name}": sailing of "${v.ship_name}" has no trackable flag`);
        const reg = byName.get(lc(v.ship_name));
        if (v.trackable) {
          trackable++;
          // a link to a ship missing from the active list dead-ends: the sign-up answers "unknown_ship"
          t.ok(reg && reg.tracked, `storm "${s.name}": "${v.ship_name}" gets a Track-this-ship link but is not a tracked ship in the tracker's search list`);
          // a ship pinned to a live storm is always followed (ship-tracker.ts, setStormShips)
          t.ok(reg.live, `storm "${s.name}": "${v.ship_name}" is in the storm's path but the tracker is not following her`);
          // the storm sailings and the registry spell lines differently ("Carnival Cruise Line" / "Carnival"):
          // the same line is fine, a different line means the link names the wrong ship
          t.ok(lineKey(reg.cruiseLine) === lineKey(v.cruise_line),
            `storm "${s.name}": "${v.ship_name}" sails for "${v.cruise_line}" on the storm page but for "${reg.cruiseLine}" in the tracker`);
        } else {
          t.ok(!reg?.tracked, `storm "${s.name}": "${v.ship_name}" is a tracked ship but the storm page gives her no Track-this-ship link`);
        }
      }

      // The storm's own page (storm-watch.html?id=…) reads the DETAIL endpoint, not the list: the same
      // storm must offer the same Track-this-ship links in both, or one view loses the button.
      const sample = sailings.find((x) => x.v.trackable);
      if (sample) {
        const det = t.success(await t.get(`/api/storm-watch/${encodeURIComponent(sample.s.id)}`));
        t.ok(det.system && Array.isArray(det.system.sailings), `storm "${sample.s.name}": the detail answer has no sailings list`);
        const sig = (list) => list.map((v) => `${lc(v.ship_name)}|${v.trackable}`).sort().join(";");
        t.equal(sig(det.system.sailings), sig(sample.s.sailings), `storm "${sample.s.name}": affected ships and their Track-this-ship links, detail page vs list`);
      } else {
        // no storm: the detail route still answers an id it does not hold with a clean "not found"
        t.status(await t.get("/api/storm-watch/00000000-0000-4000-8000-000000000000"), 404);
      }

      // The link each page builds: /track-ship.html?ship=…&from=storm (Spanish pages: /es/track-ship.html).
      for (const [page, prefix] of [["/storm-watch.html", "/track-ship.html?ship="], ["/es/storm-watch.html", "/es/track-ship.html?ship="],
        ["/index.html", "/track-ship.html?ship="], ["/es/index.html", "/es/track-ship.html?ship="]]) {
        const html = t.html(await t.get(page));
        const m = /function trackHref\(sh,s\)\{[\s\S]*?return "([^"]+)"\+encodeURIComponent\(sh\.ship_name\)\+"([^"]+)"/.exec(html);
        t.ok(m, `${page} no longer builds a Track-this-ship link`);
        t.equal(m[1], prefix, `${page}: where Track this ship goes`);
        const from = /from=([^&"]+)/.exec(m[2])?.[1] || "";
        t.ok(/^[a-z-]{1,24}$/.test(from), `${page}: the link's source tag "${from}" would be dropped by the sign-up form`);
        t.ok(/trackable\s*\?/.test(html), `${page} shows the link without checking that the ship is trackable`);
      }
      // the sign-up page opens for any tracked ship (a storm's own, or — with no storm — the first in the list)
      const shipName = sample ? sample.v.ship_name : [...byName.values()].find((x) => x.tracked)?.name;
      t.ok(shipName, "no tracked ship in the search list to open the Track-this-ship page for");
      for (const [p, lang, tracker] of [["/track-ship.html", "en", "'/wheres-my-ship.html'"], ["/es/track-ship.html", "es", "'/es/wheres-my-ship.html'"]]) {
        const label = sample ? `${sample.s.classification ? sample.s.classification + " " : ""}${sample.s.name}`.trim() : "e2e-fixture storm";
        const html = t.html(await t.get(`${p}?ship=${encodeURIComponent(shipName)}&from=storm&storm=${encodeURIComponent(label)}`),
          { mustContain: ["/api/wms/track-signup", "/api/wms/watch/restart", 'id="restartBtn"', 'id="shipName"', 'id="liveLink"', `lang: '${lang}'`, tracker] });
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        t.observe(`${lang} track-ship title`, H.title(html));
      }
      t.observe("storm sailings", sailings.length, "info");
      t.observe("storm sailings with a track link", trackable, "info");
    },
  },
  {
    id: "ships.webcams-list",
    basis: "ruling: stillafloat-webcams-page.md — Mark 9/14 (approved rebuild): cams at cruise terminals, one cam per city, each cam lists the tracked ships in port from Where's My Ship; Spanish labels (es-first-class)",
    title: "The live cams page (English and Spanish) lists its cams with a video, a status and Spanish labels, and any ship it shows in port is one the tracker holds",
    covers: ["GET /api/webcams", "page /webcams.html", "page /es/webcams.html", "GET /api/wms/health"],
    modes: ["dev", "prod"],
    incident: "2026-09-14: cams list the tracked ships in frame, computed from the tracker's memory",
    run: async (t) => {
      const body = t.success(await t.get("/api/webcams"));
      t.ok(Array.isArray(body.webcams), "the cams answer has no webcams array");
      t.equal(body.count, body.webcams.length, "the cams count vs the cams listed");
      t.atLeast(body.webcams.length, 8, "cams on the page");
      t.fresh(body.generatedAt, 1, "the cams answer");
      const slugs = new Set();
      let live = 0, portCams = 0;
      const inFrame = [];
      for (const c of body.webcams) {
        t.fields(c, ["slug", "section", "title", "title_es", "description", "description_es", "video_id", "status"], `cam "${c?.slug || "?"}"`);
        t.ok(!slugs.has(c.slug), `cam "${c.slug}" is listed twice`);
        slugs.add(c.slug);
        t.matches(c.video_id, /^[A-Za-z0-9_-]{11}$/, `cam "${c.slug}" video id`);
        // Titles are often proper names ("PortMiami") and may match; a description that is the English
        // one copied over means the Spanish page shows English.
        t.ok(c.description_es.trim() !== c.description.trim(), `cam "${c.slug}": the Spanish description is the English one`);
        t.ok(["live", "offline"].includes(c.status), `cam "${c.slug}" has an unknown status "${c.status}"`);
        if (c.status === "live") live++;
        if (c.port_slug) {
          portCams++;
          t.ok(Array.isArray(c.ships_in_port), `cam "${c.slug}" looks at port "${c.port_slug}" but has no ships-in-port list (unknown port?)`);
          for (const sh of c.ships_in_port) inFrame.push({ cam: c.slug, ...sh });
        } else {
          t.equal(c.ships_in_port, null, `cam "${c.slug}" (no port) ships-in-port`);
        }
      }
      // How many streams are up this minute is YouTube's and the camera operators' doing, not the site's
      // (the daily monitor records it; offline cards render "temporarily offline") — so it is observed,
      // not demanded.
      t.atLeast(portCams, 4, "cams that look at a cruise port");
      t.ok(new Set(body.webcams.map((c) => c.section)).has("ports"), "the cams page has no ports section");

      // Ships in frame vs the tracker: same ship, same fix, recent enough (IN_PORT_MAX_AGE_H = 12).
      const h = await health(t);
      const hp = new Map(h.ships.map((s) => [lc(s.name), s]));
      for (const sh of inFrame) {
        t.fields(sh, ["name", "lastPosAt"], `cam "${sh.cam}": a ship in port`);
        t.ok(typeof sh.docked === "boolean", `cam "${sh.cam}": "${sh.name}" has no docked flag`);
        t.ok(ageMin(t, sh.lastPosAt) <= 12 * 60, `cam "${sh.cam}" shows "${sh.name}" in port on a fix ${(ageMin(t, sh.lastPosAt) / 60).toFixed(1)} hours old`);
        const held = hp.get(lc(sh.name));
        t.ok(held, `cam "${sh.cam}" shows "${sh.name}", whom the tracker does not hold`);
        t.ok(Date.parse(held.lastPosAt) >= Date.parse(sh.lastPosAt), `cam "${sh.cam}": "${sh.name}" fix disagrees with the tracker`);
      }

      for (const [p, lang] of [["/webcams.html", "en"], ["/es/webcams.html", "es"]]) {
        const html = t.html(await t.get(p), { mustContain: ["/api/webcams", "ships_in_port", "title_es"] });
        t.equal(H.htmlLang(html).slice(0, 2), lang, `${p} language`);
        t.observe(`${lang} title`, H.title(html));
      }
      t.observe("keys", keysOf(body));
      t.observe("cam keys", keysOf(body.webcams[0]));
      t.observe("cams", body.webcams.length, "min");
      t.observe("port cams", portCams, "min");
      t.observe("cams live", live, "info");
      t.observe("ships in frame", inFrame.length, "info");
    },
  },
  {
    id: "ships.webcams-agree-with-tracker",
    basis: "ruling: stillafloat-tracker-design-mark-2026-09-24.md — Mark 10/9: positions are pulled only on a tracking request or a storm track, so a ship in frame is not a property of the site; the cams must agree with the tracker's held fixes (webcam-ships.ts: 8 km, 12 h)",
    title: "Each port cam names exactly the tracked ships whose held position puts them in that port right now, and none when none is",
    covers: ["GET /api/webcams", "GET /api/wms/health"],
    modes: ["dev", "prod"],
    run: async (t) => {
      // Positions are only pulled when a visitor files a tracking request or a storm's track names a
      // ship (Mark, 2026-10-09: "that is the way we designed it"). So whether a ship is in frame is not
      // a property of the site, and the earlier version of this check (which waited for one) was
      // untestable most of the time. What IS a property of the site: the cam cards must agree with the
      // positions the tracker already holds — the same rules the page applies (within 8 km of the
      // port, a fix under 12 h old), computed here from GET /api/wms/health (fixes shown with the
      // dashboard token; nothing is pulled or bought).
      const RADIUS_KM = 8, MAX_AGE_H = 12;
      const km = (aLat, aLon, bLat, bLon) => {
        const r = (d) => (d * Math.PI) / 180;
        const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
        return 2 * 6371 * Math.asin(Math.sqrt(h));
      };
      const cams = t.success(await t.get("/api/webcams"));
      t.ok(Array.isArray(cams.webcams), "the cams answer has no webcams array");
      const portCams = cams.webcams.filter((c) => c.port_slug);
      t.atLeast(portCams.length, 4, "cams that look at a cruise port");
      const health = t.success(await t.get("/api/wms/health", { auth: true }), "ok");
      t.ok(Array.isArray(health.ships), "the tracker health answer has no ships list");
      const held = health.ships.filter((p) => typeof p.lat === "number" && typeof p.lon === "number" && p.lastPosAt);
      t.ok(held.length > 0 || health.ships.every((p) => !p.hasFix), "the tracker says it holds fixes but shows none even with the token — the health route no longer carries lat/lon");
      const ports = t.success(await t.get("/api/weather?list=true"), "ok");
      const coords = new Map([...(ports.allEmbarkationPorts || []), ...(ports.allDestinations || [])].map((p) => [p.slug, p]));
      const now = t.now();
      let inFrame = 0;
      for (const cam of portCams) {
        const port = coords.get(cam.port_slug);
        t.ok(port, `cam "${cam.slug}" looks at port "${cam.port_slug}", which the port list does not know`);
        if (!port) continue;
        const expected = held
          .filter((p) => { const age = now - Date.parse(p.lastPosAt); return age >= 0 && age <= MAX_AGE_H * 3_600_000 && km(p.lat, p.lon, port.lat, port.lon) <= RADIUS_KM; })
          .map((p) => p.name).sort();
        t.ok(Array.isArray(cam.ships_in_port), `cam "${cam.slug}" has no ships_in_port list`);
        const shown = (cam.ships_in_port || []).map((s) => s.name).sort();
        t.equal(shown.join(" | "), expected.join(" | "), `cam "${cam.slug}" (${cam.port_slug}) names [${shown.join(", ")}] but the tracker's held fixes put [${expected.join(", ")}] in that port`);
        for (const s of cam.ships_in_port || []) t.ok(typeof s.docked === "boolean" && s.lastPosAt, `cam "${cam.slug}": ship "${s.name}" lacks docked/lastPosAt`);
        inFrame += shown.length;
      }
      t.observe("port cams", portCams.length, "min");
      t.observe("held fixes", held.length, "info");
      t.observe("ships in frame across the port cams", inFrame, "info");
    },
  },
  {
    id: "ships.track-signup-refusals",
    basis: "code: server/src/routes/track-signup.ts — the storm sign-up refuses a missing name, bad email, missing or unknown ship and forged restart links before any write or send; the honeypot answers like success and does nothing",
    title: "The storm Track-this-ship sign-up and the keep-tracking button refuse bad input and forged links, without saving or emailing anything (refusals only)",
    covers: ["POST /api/wms/track-signup", "POST /api/wms/watch/restart"],
    modes: ["dev"],
    devOnlyBecause: "POSTs are refused on prod. A successful sign-up writes a subscriber and a watch and sends a real email, so only the refusal paths and the bot honeypot are exercised (each returns before any write or send); the success path is a gap.",
    run: async (t) => {
      const headers = gateClient();
      // Since 2026-10-08 the sign-up refuses a missing Turnstile token before it looks anything up
      // (audience.turnstile-enforced-by-server proves that). These probes test the OTHER refusals, so
      // on a box running Cloudflare's test keys (dev) they carry a token the test secret accepts;
      // a box with no Turnstile skips the check anyway.
      const cfg = t.json(await t.get("/api/public-config"));
      const turnstile = cfg.turnstileTestMode ? { "cf-turnstile-response": "e2e-fixture-test-mode-token" } : {};
      t.require(!cfg.turnstileSiteKey || cfg.turnstileTestMode, "this box runs a REAL Turnstile key, so the gate cannot pass the security check to reach the other refusals (dev should run Cloudflare's test key)");
      const signup = async (body) => t.send("POST", "/api/wms/track-signup", { body: { ...turnstile, ...body }, headers });
      const refused = (res, status, code, what) => {
        t.status(res, status);
        t.ok(res.json && res.json.ok === false, `${what}: expected a refusal: ${res.describe()}`);
        t.equal(res.json.error, code, `${what}: refusal reason`);
      };
      refused(await signup({ name: "", email: NOBODY_EMAIL, ship: NO_SUCH_SHIP, lang: "en" }), 400, "name_required", "no name");
      refused(await signup({ name: "e2e-fixture", email: "not-an-email", ship: NO_SUCH_SHIP, lang: "en" }), 400, "email_invalid", "a bad email");
      refused(await signup({ name: "e2e-fixture", email: NOBODY_EMAIL, ship: "", lang: "es" }), 400, "ship_required", "no ship");
      // reaches the ships table (a read) and stops: proves the lookup path works without touching a subscriber
      refused(await signup({ name: "e2e-fixture", email: NOBODY_EMAIL, ship: NO_SUCH_SHIP, lang: "en", source: "storm" }), 404, "unknown_ship", "a ship we do not cover");
      // the bot honeypot: answers like a normal sign-up and does nothing
      const bot = t.success(await signup({ name: "e2e-fixture", email: NOBODY_EMAIL, ship: NO_SUCH_SHIP, website: "http://e2e-fixture.invalid" }), "ok");
      t.equal(bot.state, "confirm_email", "the honeypot's answer to a bot");

      const restart = async (body) => t.send("POST", "/api/wms/watch/restart", { body, headers });
      refused(await restart({ id: "not-a-watch", sig: "x" }), 400, "invalid_link", "a restart link with no watch id");
      refused(await restart({ id: "00000000-0000-4000-8000-000000000000", sig: "e2e-forged" }), 400, "invalid_link", "a forged restart link");
    },
  },
  {
    id: "ships.watch-and-wake-refusals",
    basis: "code: server/src/routes/wms.ts — POST /wms/request and /wms/watch refuse a missing or unknown ship, bad or past or over-long sailing dates and non-subscribers before buying a position or sending email",
    title: "The tracker's save-my-sailing form and ship wake-up refuse bad input and non-subscribers, without buying a position or sending email (refusals only)",
    covers: ["POST /api/wms/watch", "POST /api/wms/request"],
    modes: ["dev"],
    devOnlyBecause: "POSTs are refused on prod. A successful wake-up can buy a Live-AIS position and a successful save sends a real email, so only refusal paths are exercised; the success paths are gaps.",
    run: async (t) => {
      const headers = gateClient();
      const refused = (res, status, code, what) => {
        t.status(res, status);
        t.ok(res.json && res.json.ok === false, `${what}: expected a refusal: ${res.describe()}`);
        t.equal(res.json.error, code, `${what}: refusal reason`);
      };
      const wake = async (body) => t.send("POST", "/api/wms/request", { body, headers });
      refused(await wake({}), 400, "ship required", "waking no ship");
      // not in the registry → refused before the tracker, the database or a paid lookup is touched
      refused(await wake({ ship: NO_SUCH_SHIP }), 404, "Unknown ship", "waking a ship we do not cover");

      const { byName } = await registry(t);
      const real = [...byName.values()].find((s) => s.tracked)?.name;
      t.ok(real, "no tracked ship to name in the watch form");
      const day = (n) => new Date(t.now() + n * 86_400_000).toISOString().slice(0, 10);
      const save = async (body) => t.send("POST", "/api/wms/watch", { body, headers });
      refused(await save({ email: NOBODY_EMAIL, ship: real }), 400, "email, ship, sailingStart, sailingEnd required", "a sailing with no dates");
      refused(await save({ email: NOBODY_EMAIL, ship: real, sailingStart: day(10), sailingEnd: day(3) }), 400, "Invalid sailing dates", "a sailing that ends before it starts");
      refused(await save({ email: NOBODY_EMAIL, ship: real, sailingStart: "2020-01-01", sailingEnd: "2020-01-08" }), 400, "That sailing has already ended", "a sailing in the past");
      refused(await save({ email: NOBODY_EMAIL, ship: real, sailingStart: day(1), sailingEnd: day(60) }), 400, "Sailing window too long (40-day max)", "a 59-day sailing");
      // a valid sailing from an address that is not a confirmed subscriber: a read, then 403 — nothing saved or sent
      refused(await save({ email: NOBODY_EMAIL, ship: real, sailingStart: day(1), sailingEnd: day(8) }), 403, "subscriber_required", "a non-subscriber saving a sailing");
    },
  },
  {
    id: "ships.watch-stop-forged-link",
    basis: "code: server/src/routes/wms.ts — GET /wms/watch/stop redirects a bad signature to /wheres-my-ship.html?watch=invalid and stops nothing",
    title: "A forged or broken \"stop watching\" email link is refused (sent back to the tracker marked invalid, not stopped) and changes nothing",
    covers: ["GET /api/wms/watch/stop", "page /wheres-my-ship.html"],
    modes: ["dev"],
    devOnlyBecause: "GET /api/wms/watch/stop stops a watch when its signature is valid; the release gate never calls it on prod. On dev it is called only with a forged signature for an id that cannot exist.",
    run: async (t) => {
      // The handler redirects: a bad signature → ?watch=invalid (nothing touched); a good one →
      // ?watch=stopped. Read the redirect itself (not followed) so a signature check that stopped
      // checking — which would let anyone stop anyone's watch — fails here instead of looking the same.
      for (const [q, what] of [["id=00000000-0000-4000-8000-000000000000&sig=e2e-forged", "a forged signature"], ["sig=e2e-forged", "a link with no watch id"]]) {
        const r = await getNoFollow(t, `/api/wms/watch/stop?${q}`);
        t.ok(r.status === 302 || r.status === 301 || r.status === 303, `a stop link with ${what} answered HTTP ${r.status}, not a redirect`);
        t.matches(r.location, /^(https?:\/\/[^/]+)?\/wheres-my-ship\.html\?watch=invalid$/, `where a stop link with ${what} sends the visitor`);
      }
      const res = await t.get("/api/wms/watch/stop?id=00000000-0000-4000-8000-000000000000&sig=e2e-forged");
      const html = t.html(res, { mustContain: ["/js/wheres-my-ship.js", 'id="ship-input"'] });
      t.equal(H.htmlLang(html).slice(0, 2), "en", "the page a stop link lands on");
      const page = t.html(await t.get("/wheres-my-ship.html"));
      t.equal(H.title(html), H.title(page), "the stop link's landing page vs the tracker page");
    },
  },
];
