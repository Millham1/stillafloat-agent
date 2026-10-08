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
    title: "Where's My Ship (English and Spanish) loads its ship search with every cruise ship we cover, says the tracker is online, and has every on-screen message the tracker shows in both languages",
    covers: ["GET /api/wms/ships", "page /wheres-my-ship.html", "page /es/wheres-my-ship.html"],
    modes: ["dev", "prod"],
    incident: "2026-09-24: the free AIS feed was refused for a day while the page kept answering from memory; since 2026-09-23 (dev, 06a26a3) both tracker pages lack nine strings the script reads, so picking a ship throws on T.checking",
    run: async (t) => {
      const { body, byName } = await registry(t);
      t.equal(body.trackerOnline, true, "the tracker reports itself online (a live socket and a message in the last 15 minutes)");
      t.fields(body, ["capacity.active", "capacity.max"], "the tracker's capacity");
      t.ok(body.capacity.max > 0 && body.capacity.active > 0 && body.capacity.active <= body.capacity.max,
        `the tracker's slots make no sense: following ${body.capacity.active} ships of ${body.capacity.max}`);
      const ships = body.ships;
      const live = ships.filter((s) => s.live).length;
      const tracked = ships.filter((s) => s.tracked).length;
      t.atLeast(live, 1, "ships the tracker is following right now");
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
      t.observe("tracker slots", body.capacity.max, "info");
    },
  },
  {
    id: "ships.tracker-hearing-ships",
    title: "The live tracker is hearing ships right now: its feed is connected and the ships it follows have recent positions",
    covers: ["GET /api/wms/health", "GET /api/wms/ships"],
    modes: ["dev", "prod"],
    incident: "2026-09-22: MSC Meraviglia sat on a 71-day-old position; 2026-09-24: the feed was refused for a day",
    run: async (t) => {
      const h = await health(t);
      t.equal(h.enabled, true, "the tracker has an AIS key (enabled)");
      t.equal(h.healthy, true, "the tracker is healthy (a live socket and a message in the last 15 minutes)");
      const { byName } = await registry(t);

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
      t.atLeast(live.length, 1, "ships the tracker is following");
      for (const s of live) t.ok(hp.has(lc(s.name)), `"${s.name}" is marked live in the search but the tracker holds nothing for her`);

      const ages = live.map((s) => hp.get(lc(s.name))).filter((p) => p?.lastPosAt).map((p) => ageMin(t, p.lastPosAt));
      const within48h = ages.filter((a) => a <= 48 * 60).length;
      const within1h = ages.filter((a) => a <= 60).length;
      t.ok(within48h >= live.length / 2,
        `only ${within48h} of the ${live.length} ships the tracker follows were heard in the last 48 hours — the rest show positions the tracker itself treats as history`);
      t.atLeast(within1h, 3, "followed ships heard in the last hour");

      // The tracker shows an arrival-day weather card from /api/weather?place=<her destination>: every
      // port the tracker decodes as a destination must be a place the weather service knows, or the card
      // silently disappears. (?list=true is the fast path: no forecast fetch, no synopsis.)
      t.atLeast(destinations.size, 5, "different destination ports among the ships the tracker holds");
      const wx = t.success(await t.get("/api/weather?list=true"), "ok");
      const places = new Set([...(wx.allEmbarkationPorts || []), ...(wx.allDestinations || [])].map((p) => p?.slug));
      t.atLeast(places.size, 40, "places the weather service knows");
      const unknown = [...destinations].filter((d) => !places.has(d));
      t.ok(unknown.length === 0, `the tracker sends ships to port(s) the weather card cannot show: ${unknown.join(", ")}`);
      t.observe("ships held by the tracker", h.ships.length, "info");
      t.observe("destination ports held", destinations.size, "info");
      t.observe("health ship keys", keysOf(h.ships[0]));
      t.observe("followed ships heard within 48 hours", within48h, "info");
      t.observe("followed ships heard within 1 hour", within1h, "info");
      t.observe("health keys", keysOf(h));
    },
  },
  {
    id: "ships.position-fresh-ship",
    title: "Picking a ship heard in the last 15 minutes shows her at a real position, with her line, course and speed",
    covers: ["GET /api/wms/position", "GET /api/wms/health", "GET /api/wms/ships"],
    modes: ["dev", "prod"],
    run: async (t) => {
      // Two ships at most (the freshest, and the freshest of a different line): see PAID-POSITION SAFETY.
      const { byName } = await registry(t);
      const h = await health(t);
      const fresh = freshShips(t, h, byName);
      t.require(fresh.length > 0,
        `no followed ship was heard in the last ${FRESH_FOR_POSITION_MIN} minutes, so a position cannot be asked for without buying one`);
      const picks = [fresh[0], fresh.find((s) => s.cruiseLine !== fresh[0].cruiseLine)].filter(Boolean);
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
      t.observe("ships asked for", picks.length, "info");

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
    title: "The tracker draws a fresh ship's travelled line and nearby ships, and does not invent an estimate while her fix is fresh",
    covers: ["GET /api/wms/position"],
    modes: ["dev", "prod"],
    incident: "2026-09-15: route lines ran straight across Baja; 2026-10-08: estimates, route lines and planned sailings are in the release candidate only — this check FAILS on prod until the promotion",
    run: async (t) => {
      // ONE ship (see PAID-POSITION SAFETY).
      const { byName } = await registry(t);
      const fresh = freshShips(t, await health(t), byName);
      t.require(fresh.length > 0,
        `no followed ship was heard in the last ${FRESH_FOR_POSITION_MIN} minutes, so a position cannot be asked for without buying one`);
      const s = fresh[0];
      const d = await position(t, s.name, s.lastPosAt);
      t.equal(d.tracking, true, `${s.name} is shown as tracked`);
      t.ok("route" in d && "estimate" in d && "nearby" in d && "planned" in d,
        `${s.name}: the position answer has no route / estimate / nearby / planned fields (the 2026-10 tracker release is not on this box)`);
      t.ok(["ais", "satellite"].includes(d.source), `${s.name}: unknown position source "${d.source}"`);
      // under 20 minutes the fix is shown as-is (ESTIMATE_AFTER_MIN): an estimate here is invented
      t.equal(d.estimate, null, `${s.name}: an estimated position for a ship heard ${s.age.toFixed(0)} minutes ago`);

      const r = d.route;
      t.ok(r && Array.isArray(r.travelled) && Array.isArray(r.between) && Array.isArray(r.ahead), `${s.name}: the route line is missing or malformed`);
      const paths = [...r.travelled, ...r.between, r.ahead].filter((p) => p.length);
      t.atLeast(paths.length, 1, `${s.name}: route segments drawn (a followed ship heard minutes ago has a line behind or ahead of her)`);
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
      // the page draws what the API sends
      const js = await t.get("/js/wheres-my-ship.js");
      t.status(js, 200);
      for (const field of ["d.estimate", "route", "nearby", "planned"]) t.ok(js.text.includes(field), `the tracker script never reads "${field}"`);
      t.observe("route keys", keysOf(r));
      t.observe("has planned sailing", Boolean(d.planned), "info");
      t.observe("nearby ships", d.nearby.length, "info");
    },
  },
  {
    id: "ships.storm-track-links",
    title: "Every \"Track this ship\" link on the Storm Watch pages (English and Spanish) names a ship the tracker is following, matches the storm's own page, and opens the sign-up page (with its Keep-tracking button) in the same language",
    covers: ["GET /api/storm-watch", "GET /api/storm-watch/:id", "GET /api/wms/ships", "page /track-ship.html", "page /es/track-ship.html",
      "page /storm-watch.html", "page /es/storm-watch.html", "page /index.html", "page /es/index.html"],
    modes: ["dev", "prod"],
    incident: "2026-09-15: the storm pages' Track-this-ship button was rebuilt as a one-step sign-up",
    run: async (t) => {
      const sw = t.success(await t.get("/api/storm-watch"));
      t.ok(Array.isArray(sw.systems), "the public storm list has no systems array");
      const sailings = sw.systems.flatMap((s) => (s.sailings || []).map((v) => ({ v, s })));
      t.require(sailings.length > 0,
        "no public storm has affected sailings, so no Track-this-ship link exists to test (dev: approve the storm fixture)");
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
      t.atLeast(trackable, 1, "storm sailings with a Track-this-ship link");

      // The storm's own page (storm-watch.html?id=…) reads the DETAIL endpoint, not the list: the same
      // storm must offer the same Track-this-ship links in both, or one view loses the button.
      const sample = sailings.find((x) => x.v.trackable);
      const det = t.success(await t.get(`/api/storm-watch/${encodeURIComponent(sample.s.id)}`));
      t.ok(det.system && Array.isArray(det.system.sailings), `storm "${sample.s.name}": the detail answer has no sailings list`);
      const sig = (list) => list.map((v) => `${lc(v.ship_name)}|${v.trackable}`).sort().join(";");
      t.equal(sig(det.system.sailings), sig(sample.s.sailings), `storm "${sample.s.name}": affected ships and their Track-this-ship links, detail page vs list`);

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
      for (const [p, lang, tracker] of [["/track-ship.html", "en", "'/wheres-my-ship.html'"], ["/es/track-ship.html", "es", "'/es/wheres-my-ship.html'"]]) {
        const label = `${sample.s.classification ? sample.s.classification + " " : ""}${sample.s.name}`.trim();
        const html = t.html(await t.get(`${p}?ship=${encodeURIComponent(sample.v.ship_name)}&from=storm&storm=${encodeURIComponent(label)}`),
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
    title: "The live cams page (English and Spanish) lists its cams with a video and Spanish labels, and any ship it shows in port is one the tracker holds",
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
      t.ok(live >= body.webcams.length / 2, `only ${live} of ${body.webcams.length} cams are live`);
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
    id: "ships.webcams-ships-in-frame",
    title: "During the cruise-port day, at least one port cam names a tracked ship that is in port now",
    covers: ["GET /api/webcams"],
    modes: ["dev", "prod"],
    run: async (t) => {
      // Ships come alongside at Miami, Galveston and Key West about 06:00–07:00 local and sail
      // about 16:00–17:00 (roughly 11:00–21:00 UTC). Outside 12:00–20:00 UTC no cam can be expected to
      // show one, so the run says UNTESTABLE rather than passing on an empty list.
      const body = t.success(await t.get("/api/webcams"));
      t.ok(Array.isArray(body.webcams), "the cams answer has no webcams array");
      const portCams = body.webcams.filter((c) => c.port_slug);
      t.atLeast(portCams.length, 4, "cams that look at a cruise port");
      const hourUtc = new Date(t.now()).getUTCHours();
      t.require(hourUtc >= 12 && hourUtc < 20,
        `it is ${hourUtc}:00 UTC — outside the cruise-port day (12:00–20:00 UTC), so no cam can be expected to show a ship in port. Re-run this check in that window.`);
      const withShips = portCams.filter((c) => Array.isArray(c.ships_in_port) && c.ships_in_port.length);
      t.require(withShips.length > 0,
        `in the middle of the port day none of the ${portCams.length} port cams names a ship: either the tracker is following no ship at those ports, or the in-port match is broken`);
      t.observe("port cams with a ship in frame", withShips.length, "info");
    },
  },
  {
    id: "ships.track-signup-refusals",
    title: "The storm Track-this-ship sign-up and the keep-tracking button refuse bad input and forged links, without saving or emailing anything (refusals only)",
    covers: ["POST /api/wms/track-signup", "POST /api/wms/watch/restart"],
    modes: ["dev"],
    devOnlyBecause: "POSTs are refused on prod. A successful sign-up writes a subscriber and a watch and sends a real email, so only the refusal paths and the bot honeypot are exercised (each returns before any write or send); the success path is a gap.",
    run: async (t) => {
      const headers = gateClient();
      const signup = async (body) => t.send("POST", "/api/wms/track-signup", { body, headers });
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
