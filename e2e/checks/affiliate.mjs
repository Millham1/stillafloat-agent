// e2e/checks/affiliate.mjs — the Cruising Gear pages (affiliate store), the /api/go click
// redirect, the click report and the gear review queue.
//
// Why these checks exist (incidents and risks):
//   2026-08-11  Four new clothing items had a real Amazon link but no "smartStrip", so the
//               category page silently rendered them with NO buy button. A page that loads
//               and shows cards is not enough: every product must produce a working,
//               tracked buy link. (components/affiliate-page.js comment)
//   2026-09-09  Mark: "build the click tracking" — every buy button goes through our own
//               /api/go/<item id> redirect, which records the click and must land on the
//               Amazon page WITH the stillafloatcr-20 tag (no tag = no commission). A link
//               to an id that does not exist is a dead buy button.
//   2026-10-07  (found while building this gate) the dev box has NO gear products at all
//               while prod has 33 — every gear page on dev says "Coming soon", so nothing a
//               customer sees on the gear pages had been exercised on dev. The content checks
//               below are UNTESTABLE on dev until dev's gear store is seeded from prod.
//   ES first-class: the six Spanish category pages read the same items and show the Spanish
//               blurb (descriptionEs) — an item with no Spanish blurb shows English on /es/.
//
// SAFETY (read before adding a request here):
//   • GET /api/go/:itemId RECORDS A CLICK. It is never requested on prod. On dev it is
//     requested once per run, for a fixture item this file creates and deletes, with
//     redirects NOT followed (the box never contacts Amazon). That leaves one click row
//     (item "e2e-fixture…") in the DEV click table — the dev click report is not real data.
//   • POST /api/affiliate/ingest calls a paid model and notifies Mark; POST
//     /api/affiliate/notify notifies Mark. Only their refusal paths are exercised (no token,
//     bad token, empty body) — never a successful call.
//   • GET /api/affiliate/review embeds the dashboard token in its HTML. Its body is never
//     printed or observed; only counts are.
//   • ONE successful ingest IS sent on dev (affiliate.review-actions-refuse-safely): a single
//     pick with an invalid ASIN. ingestProducts skips it before describeAndCategorize, so
//     there is no model call, nothing is queued and notifyMark is not reached (added = 0).
//     The check asserts added=0 / notified=false and rejects (no side effect) anything that
//     a regression did queue. Residual risk, accepted: if a future release dropped the ASIN
//     validation, this one request would make one cheap model call and nudge Mark once on
//     dev — the check then FAILS loudly and names it.
//
// Adversarial review 2026-10-08 (what the first version would have missed, now asserted):
//   • the page script reading a product field the API renamed (item.imageUrl → image…) —
//     every item.<field> the renderer reads must be in the API answer;
//   • the buy button built without the product id (/api/go/undefined) or without the page
//     name (the click report's "by page" goes all "unknown");
//   • the click report's query losing its page column (sums still add up) — a known source
//     page must appear;
//   • /api/go replacing a WRONG Amazon tag, not just adding a missing one;
//   • a product added a moment ago with a dead buy button (/api/go's 10-minute product
//     cache) — was reported UNTESTABLE ("re-run later"); it is the site failing, so FAIL;
//   • wrong-token writes to the gear store: routes/affiliate.ts has its OWN checkToken
//     (not lib/http-auth), which still fails OPEN when AGENT_APPROVAL_TOKEN is unset;
//   • the EN hub's featured button (not routed through /api/go) losing the tag, or two
//     featured products (the hub and the newsletter then pick different ones);
//   • EN/ES gear pages with no language link to their twin (page or sitemap hreflang);
//   • a fixture from the dev write check leaking into the read checks when the sweep runs
//     them side by side (it lives in category "e2e-fixture" and is ignored there).
import { CheckFailure, keysOf } from "../lib/harness.mjs";
import * as H from "../lib/html.mjs";

const TAG = "stillafloatcr-20";
const CATEGORIES = ["air-travel", "cabin-essentials", "clothing", "cruise-fun", "great-ideas", "health-at-sea"];
// The review agent may only file into these (lib/affiliate-agent.ts CATEGORIES).
const AGENT_CATEGORIES = ["air-travel", "cabin-essentials", "clothing", "cruise-fun", "great-ideas"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NO_SUCH_ID = "00000000-0000-4000-8000-000000000000";
const isUrl = (s) => /^https?:\/\//i.test(String(s || "").trim());
// The URL /api/go sends the shopper to (routes/go.ts targetUrlFor) …
const goTarget = (i) => (isUrl(i.smartStrip) ? i.smartStrip.trim() : String(i.affiliateLink || "").trim());
// … and the value the category page turns into a tracked /api/go button (affiliate-page.js).
const pageStrip = (i) => String(i.smartStrip || i.affiliateLink || "").trim();
const amazonHost = (u) => { try { return /(^|\.)amazon\.com$|^amzn\.to$/i.test(new URL(u).host); } catch { return false; } };
const pageCategory = (html) => /category:\s*['"]([^'"]+)['"]/.exec(html)?.[1] || "";
const pathOnly = (u) => { try { return new URL(u).pathname; } catch { return ""; } };

const TAGGED = new RegExp(`[?&]tag=${TAG}(&|$)`);
// The dev write check's fixture: category "e2e-fixture" (no page shows it) AND a title
// starting "e2e-fixture". Both must hold, so a real product can never be ignored.
const FIXTURE_CAT = "e2e-fixture";
const isFixture = (i) => i && i.category === FIXTURE_CAT && /^e2e-fixture/.test(String(i.title || ""));
// The EN hub's featured button (affiliate.html loadFeatured): affiliateLink, else the first link in smartStrip.
const hubFeaturedLink = (i) => {
  if (i.affiliateLink) return String(i.affiliateLink).trim();
  const s = String(i.smartStrip || "").trim();
  return isUrl(s) ? s : (/href=["']([^"']+)["']/i.exec(s)?.[1] || "");
};

/** The public product list, with the store's own invariants asserted (e2e fixtures in flight are ignored). */
async function loadItems(t) {
  const body = t.success(await t.get("/api/affiliate-items"));
  t.ok(Array.isArray(body.items), "the gear product list has no items array");
  t.equal(body.count, body.items.length, "the gear product list's count");
  const real = body.items.filter((i) => !isFixture(i));
  if (real.length !== body.items.length) t.note(`ignored ${body.items.length - real.length} e2e fixture product(s) another check had in flight`);
  return real;
}

/** dev must hold gear products or none of the customer-facing path has been exercised. */
function requireProducts(t, items) {
  if (t.mode === "dev") {
    t.require(items.length > 0,
      "dev has no gear products at all (prod has them), so every gear page on dev shows \"Coming soon\" and no buy link can be checked. Seed dev's gear store (platform_state \"affiliate-items\") from prod.");
  } else {
    t.ok(items.length > 0, "the gear store is EMPTY: every Cruising Gear page shows \"Coming soon\" to visitors");
  }
}

/** GET without following the redirect: the box must never be sent on to Amazon. */
async function getNoFollow(t, path) {
  const url = t.url(path);
  t.requests++;
  let r;
  try {
    r = await t.fetchImpl(url, { method: "GET", redirect: "manual", headers: { "user-agent": "saf-e2e/1 (whole-site release gate)" }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new CheckFailure(`GET ${path} did not answer (${String(e?.message || e).slice(0, 100)})`);
  }
  await r.text().catch(() => "");
  return { status: r.status, location: r.headers.get("location") || "", describe: () => `GET ${path} → HTTP ${r.status}` };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export default [
  {
    id: "affiliate.category-pages-show-products",
    title: "Every Cruising Gear category page, in English and Spanish, has real products with a tracked Amazon buy link",
    covers: [
      "GET /api/affiliate-items",
      ...CATEGORIES.map((c) => `page /affiliate/${c}.html`),
      ...CATEGORIES.map((c) => `page /es/affiliate/${c}.html`),
    ],
    modes: ["dev", "prod"],
    incident: "2026-08-11: products rendered with no buy button; 2026-10-07: dev had no products at all",
    run: async (t) => {
      const items = await loadItems(t);
      requireProducts(t, items);

      // Every product: identity, picture, words and a buy link the page turns into /api/go/<id>.
      const ids = new Set();
      for (const i of items) {
        t.fields(i, ["id", "title", "category", "description", "imageUrl", "createdAt"], `gear product ${i.id || "(no id)"}`);
        t.matches(i.id, UUID, `gear product id (the /api/go/<id> buy link is built from it)`);
        t.ok(!ids.has(i.id), `two gear products share the id ${i.id} — one of their buy buttons opens the other's product`);
        ids.add(i.id);
        t.ok(CATEGORIES.includes(i.category), `gear product ${i.id} is in category "${i.category}", which no gear page shows — it is invisible to visitors`);
        t.ok(/^https:\/\//.test(i.imageUrl), `gear product ${i.id}: picture address is not https`);
        t.ok(isUrl(pageStrip(i)), `gear product ${i.id} has no plain buy-link URL, so its card shows no tracked "Buy on Amazon" button (the 2026-08-11 failure)`);
        const target = goTarget(i);
        t.ok(isUrl(target) && amazonHost(target), `gear product ${i.id}: the buy link does not go to Amazon (host ${(() => { try { return new URL(target).host; } catch { return "unreadable"; } })()})`);
        t.ok(typeof i.featured === "boolean" && typeof i.sortOrder === "number", `gear product ${i.id}: featured/sortOrder are missing`);
      }

      // The category filter each page uses must partition the full list exactly.
      const empty = [];
      for (const c of CATEGORIES) {
        const body = t.success(await t.get(`/api/affiliate-items?category=${encodeURIComponent(c)}`));
        t.ok(Array.isArray(body.items), `category "${c}": no items array`);
        for (const i of body.items) t.equal(i.category, c, `category "${c}" returned a product from another category`);
        const expected = items.filter((i) => i.category === c).map((i) => i.id).sort().join(",");
        t.equal(body.items.map((i) => i.id).sort().join(","), expected, `category "${c}": the page's product list disagrees with the full gear list`);
        const orders = body.items.map((i) => i.sortOrder);
        t.ok(orders.every((v, k) => k === 0 || v >= orders[k - 1]), `category "${c}": products are not in Mark's sort order`);
        if (body.items.length === 0) empty.push(c);
        t.observe(`products in ${c}`, body.items.length, "min");
      }

      // The shared renderer: reads the category list, builds /api/go/<id> buttons, prefers the Spanish blurb on /es/.
      const js = await t.get("/components/affiliate-page.js");
      t.status(js, 200);
      t.ok(js.text.includes("/api/affiliate-items?category="), "the gear page script no longer asks for its category's products");
      t.ok(/['"]\/api\/go\/['"]\s*\+\s*encodeURIComponent\(itemId\)/.test(js.text), "the gear page script no longer routes buy buttons through /api/go/<id> — clicks are not counted");
      t.ok(/ES\s*&&\s*item\.descriptionEs/.test(js.text), "the gear page script no longer shows the Spanish blurb on Spanish pages");
      t.ok(/\bdata\.items\b/.test(js.text), "the gear page script no longer reads the product list from the API's items field");
      t.ok(/renderStrip\(\s*\w+\s*,\s*\w+\s*,\s*item\.id\s*\)/.test(js.text), "the gear page script no longer passes the product id to the buy button — buttons would open /api/go/undefined");
      t.ok(/\bp:\s*CATEGORY\b/.test(js.text), "the buy button no longer tells the click report which gear page the click came from");
      // Two views of one product: every field the renderer reads must be one the API sends.
      const read = [...new Set([...js.text.matchAll(/\bitem\.([A-Za-z_]\w*)/g)].map((m) => m[1]))].sort();
      t.atLeast(read.length, 5, "product fields the gear page script reads");
      const apiKeys = new Set(items.flatMap((i) => Object.keys(i)));
      const unsent = read.filter((k) => !apiKeys.has(k));
      t.ok(unsent.length === 0, `the gear page script reads product fields the API no longer sends, so cards render blank: ${unsent.join(", ")}`);
      t.observe("product fields the gear page reads", read.join(","));

      // All twelve pages: right language, right category, loads the shared renderer.
      for (const c of CATEGORIES) {
        for (const es of [false, true]) {
          const p = `${es ? "/es" : ""}/affiliate/${c}.html`;
          const html = t.html(await t.get(p), { mustContain: ['id="items-container"', "/components/affiliate-page.js"] });
          t.equal(H.htmlLang(html).slice(0, 2), es ? "es" : "en", `${p} language`);
          t.equal(pageCategory(html), c, `${p} asks for the wrong category's products`);
          t.ok(es ? /lang:\s*['"]es['"]/.test(html) : !/lang:\s*['"]es['"]/.test(html), `${p}: the page is set to the wrong language for its buttons and blurbs`);
          t.ok(/Amazon/i.test(H.visibleText(html)), `${p} has lost the Amazon Associate disclosure`);
          const back = H.links(html).map((h) => pathOnly(H.resolve(h, t.url(p)) || ""));
          t.ok(back.includes(`${es ? "/es" : ""}/affiliate.html`), `${p} has no link back to its own language's gear hub`);
          t.observe(`title ${p}`, H.title(html));
        }
      }

      // Pictures: sample the first, middle and last product (as the page requests them).
      const sample = [...new Set([items[0], items[Math.floor(items.length / 2)], items[items.length - 1]])];
      for (const i of sample) {
        const src = i.imageUrl.replace(/\._[A-Z]{2}_[A-Z0-9,_]+_\./g, "._AC_SL500_.");
        const img = await t.get(src);
        t.ok(img.status === 200 && /^image\//.test(img.headers.get("content-type") || ""), `gear product ${i.id}: its picture does not load (HTTP ${img.status})`);
      }

      t.observe("gear products", items.length, "min");
      t.observe("product keys", [...new Set(items.flatMap((i) => Object.keys(i)))].sort().join(",")); // union: one product lacking a field must not look like a change
      t.observe("empty categories", empty.join(",") || "(none)", "info");
      t.ok(empty.length === 0, `these gear category pages have NO products and show "Coming soon" to visitors (EN and ES), though the gear hub links to them: ${empty.join(", ")}`);
    },
  },
  {
    id: "affiliate.spanish-blurbs",
    title: "Every gear product has a Spanish description, so the Spanish gear pages are not English pages with a Spanish address",
    covers: ["GET /api/affiliate-items", "page /es/affiliate/clothing.html"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const items = await loadItems(t);
      requireProducts(t, items);
      const html = t.html(await t.get("/es/affiliate/clothing.html"));
      t.ok(/lang:\s*['"]es['"]/.test(html), "the Spanish clothing page is not set to Spanish");
      const missing = items.filter((i) => !String(i.descriptionEs || "").trim());
      t.observe("products without a Spanish blurb", missing.length, "info");
      const byCat = {};
      for (const i of missing) byCat[i.category] = (byCat[i.category] || 0) + 1;
      t.ok(missing.length === 0, `${missing.length} of ${items.length} gear products have no Spanish description, so the Spanish pages show their English text (${Object.entries(byCat).map(([c, n]) => `${c}: ${n}`).join(", ")})`);
      for (const i of items) t.ok(i.descriptionEs.trim() !== i.description.trim(), `gear product ${i.id}: the "Spanish" description is the English one`);
    },
  },
  {
    id: "affiliate.hub-links-and-featured-pick",
    title: "The Cruising Gear hub (English and Spanish) links to every category and shows this week's featured product with a tracked buy link",
    covers: ["page /affiliate.html", "page /es/affiliate.html", "GET /api/affiliate-items"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const items = await loadItems(t);
      requireProducts(t, items);
      const feat = t.success(await t.get("/api/affiliate-items?featured=true"));
      t.ok(Array.isArray(feat.items), "the featured list has no items array");
      t.equal(feat.items.length, items.filter((i) => i.featured).length, "featured products: the filter and the full list disagree");
      t.ok(feat.items.length >= 1, "no gear product is featured, so the hub's \"Highlighted Item of the Week\" box is hidden");
      t.observe("featured products", feat.items.length, "info");
      const top = feat.items[0];
      t.fields(top, ["id", "title", "imageUrl", "category"], "the featured product");
      t.ok(CATEGORIES.includes(top.category), `the featured product is in category "${top.category}", which no gear page shows`);

      const featuredProblems = [];
      // The hub shows featured[0] (by sort order); the newsletter mails the first featured in
      // store order (lib/newsletter.ts gatherFeaturedAffiliate). With two, they can differ.
      if (feat.items.length > 1) featuredProblems.push(`${feat.items.length} products are marked featured — the gear hub shows only the first, and the newsletter may mail a different one`);
      for (const es of [false, true]) {
        const p = es ? "/es/affiliate.html" : "/affiliate.html";
        const html = t.html(await t.get(p));
        t.equal(H.htmlLang(html).slice(0, 2), es ? "es" : "en", `${p} language`);
        const hrefs = H.links(html).map((h) => pathOnly(H.resolve(h, t.url(p)) || ""));
        for (const c of CATEGORIES) {
          const want = `${es ? "/es" : ""}/affiliate/${c}.html`;
          t.ok(hrefs.includes(want), `${p} has no link to ${want}`);
        }
        for (const h of hrefs.filter((x) => /\/affiliate\//.test(x))) {
          t.ok(es ? h.startsWith("/es/") : !h.startsWith("/es/"), `${p} sends visitors to the other language's gear page ${h}`);
        }
        t.observe(`title ${p}`, H.title(html));
        // The featured box must be filled from the featured product, and its button must be
        // a tracked /api/go/<id> link like every other buy button (Mark 2026-09-09).
        if (!html.includes("/api/affiliate-items?featured=true")) featuredProblems.push(`${p} never loads the featured product — its "featured item of the week" box shows no product`);
        else if (!/\/api\/go\//.test(html)) {
          featuredProblems.push(`${p}: the featured product's button goes straight to Amazon instead of through /api/go, so its clicks are never counted`);
          // …and with no /api/go, nothing adds the tag: the stored link itself must carry it.
          const link = hubFeaturedLink(top);
          if (!(isUrl(link) && amazonHost(link) && TAGGED.test(link))) featuredProblems.push(`${p}: the featured product's button is not a tagged Amazon link (${TAG}), so a purchase through it earns nothing`);
        }
      }
      t.ok(featuredProblems.length === 0, featuredProblems.join("; "));
    },
  },
  {
    id: "affiliate.pages-findable-in-search",
    title: "Each gear page (English and Spanish) names itself as the page Google should index, is linked to its other-language twin, and is listed in the sitemap",
    covers: [
      "page /affiliate.html", "page /es/affiliate.html",
      ...CATEGORIES.map((c) => `page /affiliate/${c}.html`),
      ...CATEGORIES.map((c) => `page /es/affiliate/${c}.html`),
    ],
    modes: ["dev", "prod"],
    run: async (t) => {
      const pages = ["/affiliate.html", "/es/affiliate.html", ...CATEGORIES.map((c) => `/affiliate/${c}.html`), ...CATEGORIES.map((c) => `/es/affiliate/${c}.html`)];
      const sm = await t.get("/sitemap.xml");
      t.status(sm, 200);
      const locs = new Set([...sm.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => pathOnly(m[1])));
      t.atLeast(locs.size, 10, "pages listed in the sitemap");
      // Language links (hreflang) as the sitemap declares them, per <url> block: "es:/es/x.html".
      const smAlts = new Map();
      for (const b of sm.text.match(/<url>[\s\S]*?<\/url>/g) || []) {
        const loc = pathOnly(/<loc>\s*([^<\s]+)/.exec(b)?.[1] || "");
        smAlts.set(loc, new Set([...b.matchAll(/hreflang=["']([^"']+)["'][^>]*href=["']([^"']+)["']/g)].map((m) => `${m[1].slice(0, 2)}:${pathOnly(m[2])}`)));
      }
      t.atLeast([...smAlts.values()].filter((s) => s.size > 0).length, 1, "sitemap entries with language links (hreflang)");
      const wrongCanon = []; const notListed = []; const noTwin = [];
      for (const p of pages) {
        const html = t.html(await t.get(p));
        const canon = H.canonical(html);
        t.ok(canon, `${p} has no canonical link`);
        if (pathOnly(canon) !== p) wrongCanon.push(`${p} → ${pathOnly(canon)}`);
        if (!locs.has(p)) notListed.push(p);
        // EN and ES twins must be tied together, on the page or in the sitemap, or Google
        // treats the Spanish page as a stray duplicate of the English one.
        const es = p.startsWith("/es/");
        const twin = es ? p.slice(3) : `/es${p}`;
        const want = `${es ? "en" : "es"}:${twin}`;
        const onPage = Object.entries(H.hreflangs(html)).some(([l, h]) => `${String(l).slice(0, 2)}:${pathOnly(H.resolve(h, t.url(p)) || "")}` === want);
        if (!onPage && !(smAlts.get(p)?.has(want))) noTwin.push(p);
      }
      t.observe("gear pages with a wrong canonical", wrongCanon.length, "info");
      t.observe("gear pages missing from the sitemap", notListed.length, "info");
      t.observe("gear pages with no language link to their twin", noTwin.length, "info");
      t.ok(wrongCanon.length === 0 && notListed.length === 0 && noTwin.length === 0, [
        wrongCanon.length ? `${wrongCanon.length} gear pages tell Google that a DIFFERENT page is the real one, so they cannot rank on their own: ${wrongCanon.join("; ")}` : "",
        notListed.length ? `${notListed.length} gear pages are not in sitemap.xml: ${notListed.join(", ")}` : "",
        noTwin.length ? `${noTwin.length} gear pages have no hreflang link to their other-language twin (neither on the page nor in the sitemap): ${noTwin.join(", ")}` : "",
      ].filter(Boolean).join(" — AND — "));
    },
  },
  {
    id: "affiliate.buy-click-redirect-and-report",
    title: "A buy click on a gear product lands on Amazon with Mark's tag and shows up in the click report; adding, editing and deleting a product works",
    covers: [
      "POST /api/affiliate-items", "PATCH /api/affiliate-items/:id", "DELETE /api/affiliate-items/:id",
      "GET /api/affiliate-items", "GET /api/go/:itemId", "GET /api/affiliate/clicks",
    ],
    modes: ["dev"],
    devOnlyBecause: "it creates, edits and deletes a fixture product and requests /api/go, which records a click — never on prod",
    incident: "2026-09-09: first-party click tracking; a click must keep the stillafloatcr-20 tag",
    run: async (t) => {
      // refusal paths first (no product is created by any of these)
      const noTok = await t.send("POST", "/api/affiliate-items", { body: { title: "e2e-fixture refused", category: "e2e-fixture" } });
      t.ok(noTok.status === 401, `adding a product with no token must be refused: ${noTok.describe()}`);
      const noTitle = await t.send("POST", "/api/affiliate-items", { auth: true, body: { category: "e2e-fixture" } });
      t.ok(noTitle.status === 400, `adding a product with no title must be refused: ${noTitle.describe()}`);
      const patchGone = await t.send("PATCH", `/api/affiliate-items/${NO_SUCH_ID}`, { auth: true, body: { title: "x" } });
      t.ok(patchGone.status === 404, `editing a product that does not exist must be 404: ${patchGone.describe()}`);
      // routes/affiliate.ts guards these with its OWN checkToken, not lib/http-auth: a WRONG
      // token must be refused too (aimed at an id that does not exist, so nothing can change).
      const WRONG = { "x-affiliate-token": "e2e-fixture-wrong-token" };
      for (const [m, p, body] of [
        ["POST", "/api/affiliate-items", { title: "e2e-fixture refused", category: FIXTURE_CAT }],
        ["PATCH", `/api/affiliate-items/${NO_SUCH_ID}`, { title: "e2e-fixture refused" }],
        ["DELETE", `/api/affiliate-items/${NO_SUCH_ID}`, undefined],
      ]) {
        const r = await t.send(m, p, { headers: WRONG, body });
        t.ok(r.status === 401, `${m} ${p.replace(NO_SUCH_ID, ":id")} with a WRONG token must be refused (401): ${r.describe()}`);
      }

      // The fixture: in a category no page shows, with an Amazon link carrying SOMEONE ELSE'S tag —
      // the redirect must replace it with Mark's (adding a missing tag is the easier half).
      let fixtureId = null;
      let failure = null;
      try {
        const made = t.success(await t.send("POST", "/api/affiliate-items", {
          auth: true,
          body: { title: "e2e-fixture gear product", description: "e2e fixture — deleted by the release gate", category: "e2e-fixture", affiliateLink: "https://www.amazon.com/dp/B0E2EFIXT0?tag=e2e-wrong-21", imageUrl: "https://stillafloatcruising.com/assets/images/still-afloat-text.png", featured: false },
        }));
        t.fields(made.item, ["id", "title", "category", "createdAt"], "the created fixture product");
        fixtureId = made.item.id;
        t.matches(fixtureId, UUID, "the created fixture product id");

        const edited = t.success(await t.send("PATCH", `/api/affiliate-items/${fixtureId}`, { auth: true, body: { descriptionEs: "e2e-fixture — producto de prueba" } }));
        t.equal(edited.item?.descriptionEs, "e2e-fixture — producto de prueba", "the edited fixture's Spanish description");

        const listed = t.success(await t.get("/api/affiliate-items?category=e2e-fixture"));
        t.ok(Array.isArray(listed.items) && listed.items.some((i) => i.id === fixtureId && i.descriptionEs === "e2e-fixture — producto de prueba"),
          "the product just added and edited is not in the public product list");

        // The buy click. Redirect NOT followed; the box never contacts Amazon.
        const clickPage = `e2e-fixture-${fixtureId.slice(0, 8)}`; // unique per run, so an earlier run's click cannot satisfy the page assertion
        const go = await getNoFollow(t, `/api/go/${fixtureId}?p=${clickPage}&l=en`);
        // A 404 here is the SITE failing, not the box lacking a condition: /api/go keeps its
        // product list for 10 minutes (routes/go.ts CACHE_MS) and never reloads on a miss, so
        // a product published in the last 10 minutes shows on its gear page with a dead buy
        // button whenever anyone clicked any buy button shortly before. (Was UNTESTABLE.)
        t.ok(go.status !== 404,
          "the product added a moment ago is listed, but its buy button answers 404 \"Not found\": /api/go serves a product list up to 10 minutes old and does not reload when an id is missing (any buy click in the last 10 minutes — e.g. an earlier sweep — warms it)");
        t.ok(go.status === 302, `a buy click must redirect (302): ${go.describe()}`);
        let target;
        try { target = new URL(go.location); } catch { target = null; }
        t.ok(target && /(^|\.)amazon\.com$/.test(target.host), `the buy click does not land on amazon.com (went to "${target?.host || go.location.slice(0, 40)}")`);
        t.equal(target.searchParams.get("tag"), TAG, "the Amazon tag on the buy click's landing page (no tag = no commission)");
        t.ok(target.pathname.includes("/dp/B0E2EFIXT0"), "the buy click landed on a different Amazon product than the one stored");
        t.note("recorded one click on the dev box for the e2e fixture product (dev click data is not real)");
        // Only AFTER the fixture's click: /api/go caches its product list for 10 minutes on first use.
        const goGone = await getNoFollow(t, `/api/go/${NO_SUCH_ID}`);
        t.ok(goGone.status === 404, `a buy link to a product that does not exist must be 404: ${goGone.describe()}`);

        // …and the click reached the report (logged fire-and-forget, so give it a moment).
        let rep = null;
        for (let k = 0; k < 4; k++) {
          await sleep(1500);
          rep = t.success(await t.get("/api/affiliate/clicks?days=1", { auth: true }));
          if ((rep.byItem || []).some((r) => r.item_id === fixtureId)) break;
        }
        t.equal(rep.days, 1, "the click report's period");
        t.ok(Array.isArray(rep.byItem) && rep.byItem.some((r) => r.item_id === fixtureId && r.count >= 1),
          "the buy click was redirected but never reached the click report — clicks are not being counted");
        // The page the click came from (?p=) must survive into the report (the report's query
        // could drop its page column and every sum would still add up).
        t.ok(Array.isArray(rep.byPage) && rep.byPage.some((r) => r.page === clickPage && r.count >= 1),
          "the buy click reached the report without the page it came from — Mark's \"clicks by page\" would read \"unknown\"");
      } catch (e) {
        failure = e;
      } finally {
        // Always remove the fixture; a cleanup problem never hides the first failure.
        if (fixtureId) {
          try {
            const del = await t.send("DELETE", `/api/affiliate-items/${fixtureId}`, { auth: true });
            t.success(del);
            const after = t.success(await t.get("/api/affiliate-items?category=e2e-fixture"));
            t.ok(Array.isArray(after.items) && !after.items.some((i) => i.id === fixtureId), "the deleted fixture product is still listed");
          } catch (e) {
            if (!failure) failure = e;
          }
        }
      }
      if (failure) throw failure;
      const delGone = await t.send("DELETE", `/api/affiliate-items/${NO_SUCH_ID}`, { auth: true });
      t.ok(delGone.status === 404, `deleting a product that does not exist must be 404: ${delGone.describe()}`);
    },
  },
  {
    id: "affiliate.click-report",
    title: "Mark's gear click report answers with the token, adds up, refuses anyone without it, and has seen clicks this month",
    covers: ["GET /api/affiliate/clicks"],
    modes: ["dev", "prod"],
    run: async (t) => {
      const anon = await t.get("/api/affiliate/clicks");
      t.ok(anon.status === 401, `the click report must refuse a visitor with no token: ${anon.describe()}`);
      const wrong = await t.get("/api/affiliate/clicks", { headers: { "x-affiliate-token": "e2e-fixture-wrong-token" } });
      t.ok(wrong.status === 401, `the click report must refuse a WRONG token: ${wrong.describe()}`);
      const rep = t.success(await t.get("/api/affiliate/clicks", { auth: true }));
      t.equal(rep.days, 28, "the click report's default period (days)");
      t.ok(typeof rep.total === "number" && Array.isArray(rep.byItem) && Array.isArray(rep.byPage) && Array.isArray(rep.byDay), "the click report is missing its totals or breakdowns");
      const sum = (a) => a.reduce((n, r) => n + (r.count || 0), 0);
      t.equal(sum(rep.byItem), rep.total, "clicks by product add up to the total");
      t.equal(sum(rep.byPage), rep.total, "clicks by page add up to the total");
      t.equal(sum(rep.byDay), rep.total, "clicks by day add up to the total");
      for (const d of rep.byDay) t.matches(d.day, /^\d{4}-\d{2}-\d{2}$/, "a click-report day");
      t.ok(rep.byItem.every((r) => typeof r.item_id === "string" && r.item_id.length > 0), "a click-report row has no product id");
      // On dev the only clicks are the e2e fixture's (affiliate.buy-click-redirect-and-report).
      t.require(rep.total > 0, t.mode === "dev"
        ? "the dev click report has no clicks in 28 days — run affiliate.buy-click-redirect-and-report once (it records a fixture click), or seed dev's gear store"
        : "no gear click recorded in the last 28 days");
      // The report's "by page" must name real sources (a gear page, the newsletter; on dev the
      // fixture) — if the query lost its page column every row reads "unknown" and the sums
      // above still add up.
      const known = (pg) => CATEGORIES.includes(pg) || pg === "newsletter" || (t.mode === "dev" && /^e2e-fixture/.test(pg));
      t.ok(rep.byPage.some((r) => known(r.page)), `the click report no longer says which page any click came from (${rep.byPage.length} page value(s) seen, none of them a gear page or the newsletter)`);
      t.observe("click report pages seen", rep.byPage.filter((r) => known(r.page)).length, "info");
      if (t.mode === "prod") {
        // two views of the same data: clicked products should mostly still be on the gear pages
        const items = await loadItems(t);
        const live = new Set(items.map((i) => i.id));
        t.ok(rep.byItem.some((r) => live.has(r.item_id)), "none of the products clicked this month exists on the gear pages any more");
      }
      t.observe("click report keys", keysOf(rep));
      t.observe("clicks in 28 days", rep.total, "info");
    },
  },
  {
    id: "affiliate.review-queue",
    title: "The gear review queue (Approve/Feature/Reject page) opens with the token, matches the queue data, and refuses anyone without it",
    covers: ["GET /api/affiliate/pending", "GET /api/affiliate/review", "GET /api/affiliate-items"],
    modes: ["dev", "prod"],
    run: async (t) => {
      for (const p of ["/api/affiliate/pending", "/api/affiliate/review"]) {
        const anon = await t.get(p);
        t.ok(anon.status === 401, `${p} must refuse a visitor with no token: ${anon.describe()}`);
        const wrong = await t.get(p, { headers: { "x-affiliate-token": "e2e-fixture-wrong-token" } });
        t.ok(wrong.status === 401, `${p} must refuse a WRONG token: ${wrong.describe()}`);
      }
      const q = t.success(await t.get("/api/affiliate/pending", { auth: true }));
      t.ok(Array.isArray(q.items), "the review queue has no items array");
      t.equal(q.count, q.items.length, "the review queue's count");
      const items = await loadItems(t);
      const published = new Set(items.map((i) => (/\/dp\/([A-Z0-9]{10})/.exec(goTarget(i)) || [])[1]).filter(Boolean));
      for (const it of q.items) {
        t.fields(it, ["id", "asin", "title", "category", "affiliateLink", "createdAt"], `queued pick ${it.id || "(no id)"}`);
        t.matches(it.asin, /^[A-Z0-9]{10}$/, `queued pick ${it.id} ASIN`);
        t.ok(AGENT_CATEGORIES.includes(it.category), `queued pick ${it.id} has category "${it.category}"`);
        t.ok(new RegExp(`[?&]tag=${TAG}(&|$)`).test(it.affiliateLink), `queued pick ${it.id} has no ${TAG} tag — Approve would refuse it`);
        t.ok(!published.has(it.asin), `queued pick ${it.id} is already on a gear page`);
      }
      const res = await t.get("/api/affiliate/review", { auth: true });
      const html = t.html(res, { mustContain: ["Gear Review", "noindex"] });
      const cards = (html.match(/<div class="card" id="c-/g) || []).length;
      t.equal(cards, q.items.length, "cards on the review page vs picks in the queue");
      if (q.items.length === 0) t.ok(html.includes("No picks awaiting review"), "the empty review page does not say the queue is empty");
      for (const it of q.items) t.ok(html.includes(`id="c-${it.id}"`), `queued pick ${it.id} has no card on the review page`);
      t.observe("picks awaiting review", q.items.length, "info");
      t.observe("queue keys", keysOf(q));
    },
  },
  {
    id: "affiliate.review-actions-refuse-safely",
    title: "Gear review actions refuse bad requests (no token, wrong token, unknown pick, unknown action, empty upload), and an upload of an invalid product is skipped without queueing it or nudging Mark",
    covers: ["POST /api/affiliate/ingest", "POST /api/affiliate/notify", "POST /api/affiliate/pending/:id/:action", "GET /api/affiliate/pending"],
    modes: ["dev"],
    devOnlyBecause: "it sends POST requests (refused, plus one skipped upload that rewrites the dev review queue unchanged) — prod sweeps are read-only",
    run: async (t) => {
      // Never a successful ingest (paid model call + notifies Mark) or notify (notifies Mark).
      const before = t.success(await t.get("/api/affiliate/pending", { auth: true }));
      t.ok(Array.isArray(before.items), "the review queue has no items array");
      const cases = [
        ["POST", "/api/affiliate/ingest", { body: { items: [] } }, 401, "an upload with no token"],
        ["POST", "/api/affiliate/ingest", { body: { items: [] }, headers: { "x-affiliate-token": "e2e-wrong-token" } }, 401, "an upload with a wrong token"],
        ["POST", "/api/affiliate/ingest", { auth: true, body: { items: [] } }, 400, "an empty upload"],
        ["POST", "/api/affiliate/notify", {}, 401, "a review nudge with no token"],
        ["POST", "/api/affiliate/notify", { headers: { "x-affiliate-token": "e2e-wrong-token" } }, 401, "a review nudge with a wrong token"],
        ["POST", `/api/affiliate/pending/${NO_SUCH_ID}/approve`, {}, 401, "an approval with no token"],
        ["POST", `/api/affiliate/pending/${NO_SUCH_ID}/feature`, { headers: { "x-affiliate-token": "e2e-wrong-token" } }, 401, "featuring with a wrong token"],
        ["POST", `/api/affiliate/pending/${NO_SUCH_ID}/approve`, { auth: true }, 404, "approving a pick that does not exist"],
        ["POST", `/api/affiliate/pending/${NO_SUCH_ID}/feature`, { auth: true }, 404, "featuring a pick that does not exist"],
        ["POST", `/api/affiliate/pending/${NO_SUCH_ID}/reject`, { auth: true }, 404, "rejecting a pick that does not exist"],
        ["POST", `/api/affiliate/pending/${NO_SUCH_ID}/e2e-bogus`, { auth: true }, 400, "an unknown review action"],
      ];
      for (const [m, p, opt, want, what] of cases) {
        const r = await t.send(m, p, opt);
        t.ok(r.status === want, `${what} should be HTTP ${want}: ${r.describe()}`);
        t.ok(r.json && r.json.success === false, `${what}: the answer does not say it failed: ${r.describe()}`);
      }
      // The ingest SUCCESS path, with no side effect: one pick whose ASIN is invalid. The
      // handler reads the published gear store and the queue, skips the pick before any model
      // call, queues nothing and notifies no one (see SAFETY at the top of this file).
      let ingest = null;
      let failure = null;
      try {
        ingest = t.success(await t.send("POST", "/api/affiliate/ingest", { auth: true, body: { items: [{ asin: "e2e-fixture", title: "e2e-fixture invalid ASIN — never queued" }] } }));
        t.equal(ingest.added, 0, "picks queued from an upload whose only ASIN is invalid");
        t.equal(ingest.notified, false, "whether that upload nudged Mark");
        t.ok(Array.isArray(ingest.skipped) && ingest.skipped.length === 1 && ingest.skipped[0].asin === "e2e-fixture" && /ASIN/i.test(String(ingest.skipped[0].reason || "")),
          "the upload did not report its invalid pick as skipped for having no valid ASIN");
      } catch (e) { failure = e; }
      const after = t.success(await t.get("/api/affiliate/pending", { auth: true }));
      // A regression that queued the pick anyway: take it back out (reject has no side effect).
      const was = new Set((before.items || []).map((i) => i.id));
      const leaked = (after.items || []).filter((i) => !was.has(i.id) && /^e2e-fixture/.test(String(i.title || "")));
      for (const i of leaked) await t.send("POST", `/api/affiliate/pending/${encodeURIComponent(i.id)}/reject`, { auth: true });
      t.ok(leaked.length === 0, `an upload with an invalid ASIN was QUEUED (${leaked.length} pick(s), now rejected) — the ASIN check is gone; this request may also have made a model call and nudged Mark`);
      if (failure) throw failure;
      t.equal(after.count, before.count, "the review queue changed while only refused or skipped requests were sent");
    },
  },
];
