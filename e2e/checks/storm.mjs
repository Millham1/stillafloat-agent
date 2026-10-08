// e2e/checks/storm.mjs — the public Cruise Storm Watch (homepage panel, list, detail page).
//
// Incident this file exists for:
//   2026-09-26 → 2026-10-04  GET /api/storm-watch answered HTTP 500 whenever any storm alert was
//   public: the list query did not fetch a column its own code read. The dev box had NO public
//   storm, so the list was empty there and every test "passed"; on prod the homepage panel went
//   dark exactly while a storm was live, for eight days, and nobody was told.
//
// So: the public list is checked AGAINST the dashboard's list (two views of the same data must
// agree), and on dev a public storm MUST exist — if it does not, the check is UNTESTABLE, which
// fails the release. Seed the fixture; never skip the check.
import { keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

const isPublic = (a) => (a.status === "approved" || a.status === "sent") && a.is_threat === true;

export default [
  {
    id: "storm.watch-list-matches-dashboard",
    title: "Every storm alert Mark has approved appears on the public Storm Watch list, with its affected sailings",
    covers: ["GET /api/storm-watch", "GET /api/storm-alerts", "GET /api/storm-watch/:id", "page /storm-watch.html", "page /es/storm-watch.html"],
    modes: ["dev", "prod"],
    incident: "2026-09-26: the public list answered 500 whenever a storm was live",
    run: async (t) => {
      const dash = t.success(await t.get("/api/storm-alerts", { auth: true }));
      t.ok(Array.isArray(dash.alerts), "the dashboard's alert list is missing");
      const expected = dash.alerts.filter(isPublic);

      const pub = t.success(await t.get("/api/storm-watch"));
      t.ok(Array.isArray(pub.systems), "the public list has no systems array");
      t.nonEmpty(pub.regions, "the cruising-region names");

      // Two views of the same rows must agree, in both directions.
      const pubIds = new Set(pub.systems.map((s) => s.id));
      for (const a of expected) t.ok(pubIds.has(a.id), `"${a.name}" is approved and public in the dashboard but missing from the public Storm Watch list`);
      const expIds = new Set(expected.map((a) => a.id));
      for (const s of pub.systems) t.ok(expIds.has(s.id), `"${s.name}" is on the public list but is not an approved threat in the dashboard`);

      // On dev there must be a public storm, or none of the populated path has been exercised.
      if (t.mode === "dev") {
        t.require(expected.length > 0,
          "dev has no public storm alert, so the Storm Watch list, homepage panel and detail page cannot be tested (this is exactly how the 2026-09-26 outage got through). Seed the dev storm fixture.");
      }

      for (const s of pub.systems) {
        t.fields(s, ["id", "name", "classification", "headline", "body_md", "grounds_label", "updated", "detail_url", "source"], `storm "${s.name}"`);
        t.ok(["nhc", "nws", "manual"].includes(s.source), `storm "${s.name}" has an unknown source "${s.source}"`);
        t.nonEmpty(s.grounds, `storm "${s.name}": affected cruising grounds`);
        t.ok(Array.isArray(s.sailings), `storm "${s.name}": sailings list is missing`);
        for (const v of s.sailings.slice(0, 40)) t.fields(v, ["ship_name", "cruise_line"], `storm "${s.name}": an affected sailing`);
        t.matches(s.detail_url, /^\/storm-watch\.html\?id=[0-9a-f-]{36}$/, `storm "${s.name}": detail link`);

        // the detail page's data
        const d = t.success(await t.get(`/api/storm-watch/${s.id}`));
        t.fields(d.system, ["id", "name", "headline", "body_md", "grounds_label", "updated"], `storm "${s.name}" detail`);
        t.equal(d.system.id, s.id, `storm "${s.name}" detail id`);
        t.ok(Array.isArray(d.system.sailings), `storm "${s.name}" detail: sailings list is missing`);
        t.equal(d.system.sailings.length, s.sailings.length, `storm "${s.name}": the list and the detail page disagree on how many sailings are affected`);
        for (const adv of d.system.cruise_line_info || []) t.fields(adv, ["line", "note"], `storm "${s.name}": a cruise-line notice`);
      }

      // an id that does not exist is a clean "not found", never a crash
      const gone = await t.get("/api/storm-watch/00000000-0000-4000-8000-000000000000");
      t.ok(gone.status === 404, `an unknown storm id should be 404: ${gone.describe()}`);

      // the pages that render it
      for (const p of ["/storm-watch.html", "/es/storm-watch.html"]) {
        const html = t.html(await t.get(p), { mustContain: ["/api/storm-watch/"] });
        t.equal(H.htmlLang(html).slice(0, 2), p.startsWith("/es/") ? "es" : "en", `${p} language`);
      }
      t.observe("keys", keysOf(pub));
      t.observe("system keys", pub.systems[0] ? keysOf(pub.systems[0]) : "(no public storm)", pub.systems[0] ? "exact" : "info");
      t.observe("public storms", pub.systems.length, "info");
      t.observe("approved threats in dashboard", expected.length, "info");
    },
  },
  {
    id: "storm.home-panel-wired",
    title: "The homepage Storm Watch panel (English and Spanish) reads the public storm list",
    covers: ["page /index.html", "page /es/index.html", "GET /api/storm-watch"],
    modes: ["dev", "prod"],
    run: async (t) => {
      for (const p of ["/index.html", "/es/index.html"]) {
        const html = t.html(await t.get(p));
        const srcs = H.scripts(html).map((s) => H.resolve(s, t.url(p))).filter(Boolean).filter((u) => H.sameSite(u, t.bases.site));
        let wired = /\/api\/storm-watch/.test(html);
        for (const u of srcs) {
          if (wired) break;
          const js = await t.get(H.onBase(u, t.bases.site));
          t.status(js, 200);
          wired = /\/api\/storm-watch/.test(js.text);
        }
        t.ok(wired, `${p} no longer asks for the storm list — the Storm Watch panel can never appear`);
      }
      const pub = t.success(await t.get("/api/storm-watch"));
      t.ok(Array.isArray(pub.systems), "the public list has no systems array");
    },
  },
];
