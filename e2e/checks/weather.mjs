// e2e/checks/weather.mjs — weather cards, port lists, ten-day forecasts and Mark's synopsis.
//
// Incidents these checks exist for:
//   2026-10-02  A searched destination (Bermuda, via the search pill) showed the ten days with
//               no synopsis: the search path fetched the weather provider from the browser and
//               never reached our server. Unconnected since 2026-05-19. The Spanish weather page
//               linked every tile that way, so Spanish had no synopsis at all.
//   2026-10-02  forecast.html carried the Pexels API key in its public source.
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

// A fixed point that is NOT near any port we list, so the "any place in the world" path is
// exercised with a stable cache key (one synopsis per language per six hours, like a visitor).
const FAR_PLACE = { lat: "38.72", lon: "-9.14", name: "Lisbon" };

async function forecast(t, query, what) {
  const body = t.success(await t.get(`/api/weather?${query}`), "ok");
  const f = t.fields(body.forecast, ["slug", "name", "type", "forecastUrl"], `${what}: forecast`);
  t.equal(Array.isArray(f.forecast) ? f.forecast.length : 0, 10, `${what}: number of forecast days`);
  for (const d of f.forecast) {
    t.fields(d, ["day", "emoji"], `${what}: a forecast day`);
    t.ok(Number.isFinite(d.high) && Number.isFinite(d.low) && d.high >= d.low, `${what}: day ${d.day} has an impossible high/low (${d.high}/${d.low})`);
    t.ok(d.high > -40 && d.high < 130, `${what}: day ${d.day} high of ${d.high}°F is not a real temperature`);
  }
  return f;
}

function synopsis(t, f, what) {
  t.ok(typeof f.synopsis === "string" && f.synopsis.trim().length >= 80,
    `${what}: the synopsis is missing or too short (${(f.synopsis || "").length} characters) — the page would show the ten days with no note from Mark`);
  t.ok(!/\b(as an ai|i cannot|i can't help|language model)\b/i.test(f.synopsis), `${what}: the synopsis reads like a model refusal`);
  return f.synopsis;
}

export default [
  {
    id: "weather.home-cards",
    basis: "code: server/src/routes/weather.ts — MIN_CARDS_PER_TYPE = 6: a list short of six departure ports or destinations is topped up from the last good set, never shown thin",
    title: "The weather cards for departure ports and destinations load with real temperatures",
    covers: ["GET /api/weather"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const body = t.success(await t.get("/api/weather"), "ok");
      for (const [list, what] of [[body.embarkation, "departure-port cards"], [body.destinations, "destination cards"]]) {
        t.nonEmpty(list, what);
        t.atLeast(list.length, 6, what);
        for (const c of list) {
          t.fields(c, ["slug", "name", "emoji", "forecastUrl"], `${what}: ${c?.name || "a card"}`);
          t.ok(Number.isFinite(c.temp) && c.temp > -40 && c.temp < 130, `${what}: ${c.name} shows ${c.temp}°, which is not a real temperature`);
          t.matches(c.forecastUrl, /^\/forecast\.html\?place=[a-z0-9-]+$/, `${what}: ${c.name} forecast link`);
        }
      }
      t.atLeast((body.allEmbarkationPorts || []).length, 20, "the full list of departure ports");
      t.atLeast((body.allDestinations || []).length, 20, "the full list of destinations");
      t.fresh(body.generatedAt, 2, "the weather cards");
      t.observe("keys", keysOf(body));
      t.observe("departure-port cards", body.embarkation.length, "min");
      t.observe("destination cards", body.destinations.length, "min");
      t.observe("ports listed", body.allEmbarkationPorts.length + body.allDestinations.length, "min");
    },
  },
  {
    id: "weather.port-forecast-synopsis",
    basis: "ruling: stillafloat-forecast-synopsis-and-pexels.md — Mark 10/2: every ten-day page carries Mark's synopsis, in Spanish on the Spanish pages (stillafloat-es-first-class.md)",
    title: "A port's ten-day page shows the forecast and Mark's synopsis, in English and in Spanish",
    covers: ["GET /api/weather"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const all = t.success(await t.get("/api/weather?list=true"), "ok");
      const ports = [all.allEmbarkationPorts?.[0], all.allDestinations?.find((p) => p.slug === "bermuda") || all.allDestinations?.[0]];
      for (const p of ports) {
        t.fields(p, ["slug", "name"], "a port in the list");
        const en = synopsis(t, await forecast(t, `place=${encodeURIComponent(p.slug)}`, `${p.name} (English)`), `${p.name} (English)`);
        const es = synopsis(t, await forecast(t, `place=${encodeURIComponent(p.slug)}&lang=es`, `${p.name} (Spanish)`), `${p.name} (Spanish)`);
        t.ok(en !== es, `${p.name}: the Spanish synopsis is identical to the English one`);
        t.ok(/[áéíóúñ¿¡]| (el|la|los|las|que|con|para|por|una?) /i.test(es), `${p.name}: the Spanish synopsis does not read as Spanish: "${es.slice(0, 80)}"`);
      }
      const missing = await t.get("/api/weather?place=no-such-port-e2e");
      t.status(missing, 404);
    },
  },
  {
    id: "weather.search-path-synopsis",
    basis: "ruling: stillafloat-forecast-synopsis-and-pexels.md — Mark 10/2: a destination typed into the weather search must show the synopsis too; every path goes through /api/weather",
    title: "Typing a destination into the weather search shows the synopsis too (English and Spanish)",
    covers: ["GET /api/weather", "page /forecast.html", "page /weather.html", "page /es/weather.html"],
    modes: ["dev", "prod"],
    incident: "2026-10-02: searched Bermuda, no synopsis (gap since 2026-05-19)",
    run: async (t) => {
      // 1. the exact link the search pill builds for a place we list: coordinates, not a slug
      const near = await forecast(t, "lat=32.33022&lon=-64.74003&name=Bermuda", "Bermuda by coordinates");
      t.equal(near.slug, "bermuda", "coordinates beside a listed port resolve to that port");
      synopsis(t, near, "Bermuda by coordinates (English)");
      synopsis(t, await forecast(t, "lat=32.33022&lon=-64.74003&name=Bermuda&lang=es", "Bermuda by coordinates (Spanish)"), "Bermuda by coordinates (Spanish)");
      // 2. a place we do not list
      const far = await forecast(t, `lat=${FAR_PLACE.lat}&lon=${FAR_PLACE.lon}&name=${FAR_PLACE.name}`, "a place we do not list");
      t.matches(far.slug, /^ll:/, "an unlisted place gets its own key");
      synopsis(t, far, "a place we do not list");
      // 3. nonsense is refused cleanly, not served as a broken page
      t.status(await t.get("/api/weather?lat=abc&lon=1"), 400);
      // 4. the pages themselves must go through our server on every path
      const page = t.html(await t.get("/forecast.html"), { mustContain: ["/api/weather?"] });
      t.ok(!/api\.open-meteo\.com\/v1\/forecast/.test(page), "forecast.html fetches the weather provider directly from the browser — that path never gets the synopsis");
      const en = t.html(await t.get("/weather.html"), { mustContain: ["forecast.html?"] });
      const es = t.html(await t.get("/es/weather.html"), { mustContain: ["forecast.html?"] });
      const esLinks = [...es.matchAll(/forecast\.html\?[^"'`<\s]+/g)].map((m) => m[0]);
      t.nonEmpty(esLinks, "forecast links on the Spanish weather page");
      for (const l of esLinks) t.ok(/[?&]lang=es\b/.test(l), `the Spanish weather page links to an English forecast: ${l.slice(0, 90)}`);
      t.observe("forecast link forms (EN)", [...new Set([...en.matchAll(/forecast\.html\?([a-z]+)=/g)].map((m) => m[1]))].sort().join(","));
      t.observe("forecast link forms (ES)", [...new Set(esLinks.map((l) => /\?([a-z]+)=/.exec(l)?.[1]))].sort().join(","));
    },
  },
  {
    id: "weather.hero-photo",
    basis: "ruling: stillafloat-forecast-synopsis-and-pexels.md — 10/2 incident, Pexels key readable in forecast.html: the page calls /api/weather/hero on our server and carries no key",
    title: "Forecast pages get their destination photo from our server, and the page carries no API key",
    covers: ["GET /api/weather/hero", "page /forecast.html"],
    modes: ["dev", "prod"],
    incident: "2026-10-02: the Pexels key was readable in forecast.html",
    run: async (t) => {
      const body = t.success(await t.get("/api/weather/hero?q=Bermuda"), "ok");
      t.matches(body.url, /^https:\/\/images\.pexels\.com\/\S+$/, "the photo address for Bermuda");
      const page = t.html(await t.get("/forecast.html"), { mustContain: ["/api/weather/hero"] });
      t.ok(!/api\.pexels\.com/i.test(page), "forecast.html calls Pexels from the browser");
      t.ok(!/Authorization\s*:\s*[A-Za-z_]*KEY|['"][A-Za-z0-9]{50,}['"]/.test(page), "forecast.html appears to contain an API key");
      t.observe("page title", H.title(page));
    },
  },
];
