// e2e/lib/vacuity.mjs — prove that every check can FAIL.
//
// The Storm Watch test that passed for eight days passed because the list it looked at was
// empty. A check that passes when the site returns nothing is worse than no check. So each
// check is run against four fake sites, and it must not pass on any of them:
//   dead      every request → HTTP 500 {"success":false,"error":"…"}
//   empty     every request → HTTP 200 with a success flag and nothing else / an empty page
//   hollow    every request → HTTP 200 with `{}` / `[]` (no flag at all)
//   notfound  every request → HTTP 404
// This runs in the unit suite (server/src/e2e-gate.test.ts), so a hollow check cannot merge.

import { runCheck } from "./harness.mjs";

const page = (body) => `<!doctype html><html><head><title></title></head><body>${body}</body></html>`;
const respond = (status, body, type = "application/json") =>
  Promise.resolve(new Response(body, { status, headers: { "content-type": type } }));

export const FAKE_SITES = {
  dead: () => respond(500, JSON.stringify({ success: false, ok: false, error: "simulated failure" })),
  empty: (url) => (/\.(html?|xml|txt)(\?|$)|\/$/.test(String(url))
    ? respond(200, page(""), "text/html")
    : respond(200, JSON.stringify({ success: true, ok: true }))),
  hollow: (url) => (/\.(html?|xml|txt)(\?|$)|\/$/.test(String(url)) ? respond(200, "", "text/html") : respond(200, "{}")),
  notfound: () => respond(404, JSON.stringify({ success: false, error: "not found" })),
};

/** Returns [{ id, scenario }] for every check that PASSED against a fake site. */
export async function hollowChecks(checks, mode = "dev") {
  const bad = [];
  for (const c of checks) {
    if (!c.modes.includes(mode)) continue;
    for (const [scenario, fetchImpl] of Object.entries(FAKE_SITES)) {
      const r = await runCheck({ ...c, timeoutMs: 15_000 }, {
        mode, token: "vacuity-test-token", timeoutMs: 5_000, fetchImpl,
        bases: { site: "http://fake.invalid", news: "http://fake-news.invalid", ops: "http://fake-ops.invalid" },
      });
      if (r.status === "pass") bad.push({ id: c.id, scenario });
    }
  }
  return bad;
}
