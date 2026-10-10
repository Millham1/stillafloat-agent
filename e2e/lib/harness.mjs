// e2e/lib/harness.mjs — the whole-site end-to-end harness.
//
// WHY THIS EXISTS (Mark, 2026-10-04): "every time we launch a revision or feature the
// entire system is supposed to be tested end to end… think of the website holistically,
// not as separate features. every system affects every other system."
//
// Four failures had surfaced in two days, each of which a feature-level test had "passed":
//   • the public Storm Watch list answered 500 for eight days whenever a storm was live —
//     the dev test ran with no public storm, so the list was empty and looked fine;
//   • a searched destination never showed the forecast synopsis — the test clicked tiles,
//     and the search pill took a path nobody walked;
//   • a 500 response was read as "zero items" because only the JSON body was looked at.
//
// So the rules are built into the assertions, not left to whoever writes a check:
//   1. EMPTY IS NOT A PASS. Every check must assert populated, correct content. The unit
//      suite runs every check against a dead site and an empty site and fails the build
//      if any check still passes (lib/vacuity.mjs).
//   2. STATUS AND SUCCESS ARE ALWAYS READ. `t.success(res)` checks the HTTP status and
//      the body's own flag; there is no helper that reads a body without the status.
//   3. A CONDITION THE BOX CANNOT PRODUCE IS A FAILURE. `t.require(...)` reports
//      UNTESTABLE, which fails the run — it never skips quietly.
//   4. EVERYTHING OBSERVED IS RECORDED, so a release can be compared before and after
//      and say what disappeared (lib/compare.mjs).
//
// No dependencies: Node 18+ only (global fetch).

export class CheckFailure extends Error {
  constructor(message) { super(message); this.name = "CheckFailure"; }
}
export class Untestable extends Error {
  constructor(message) { super(message); this.name = "Untestable"; }
}

const trim = (s, n = 180) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** A response as every check sees it. `json` is null when the body is not JSON. */
export class Res {
  constructor({ url, status, headers, text, ms }) {
    this.url = url; this.status = status; this.headers = headers; this.text = text; this.ms = ms;
    try { this.json = text && /^[\s]*[{[]/.test(text) ? JSON.parse(text) : null; } catch { this.json = null; }
  }
  /** Short, secret-free description for failure messages. */
  describe() {
    const flag = this.json && typeof this.json === "object" && !Array.isArray(this.json)
      ? ("success" in this.json ? ` success=${this.json.success}` : "ok" in this.json ? ` ok=${this.json.ok}` : "")
      : "";
    const err = this.json && typeof this.json === "object" && this.json.error ? ` error="${trim(this.json.error, 80)}"` : "";
    return `${redactUrl(this.url)} → HTTP ${this.status}${flag}${err}`;
  }
}

/** Never let a token in a query string reach a report. */
export function redactUrl(u) {
  return String(u).replace(/([?&](?:token|sig|key|secret|apikey|api_key)=)[^&#]+/gi, "$1<hidden>");
}

export const SERVICES = ["site", "news", "ops"];

/**
 * One check's working context. All HTTP goes through here so that load, timeouts,
 * auth and recording are uniform, and so the vacuity test can swap the transport.
 */
export class Ctx {
  constructor(opts) {
    this.mode = opts.mode;                       // "dev" | "prod"
    this.bases = opts.bases;                     // { site, news, ops } — absolute, no trailing slash
    this.token = opts.token || "";               // dashboard token (x-affiliate-token); never logged
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs || 30_000;
    this.now = opts.now || (() => Date.now());
    this.asserts = 0;
    this.requests = 0;
    this.observations = {};                      // key → { value, kind }
    this.notes = [];
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────
  url(path, service = "site") {
    if (/^https?:\/\//i.test(path)) return path;
    const base = this.bases[service];
    if (!base) throw new Untestable(`no address was given for the "${service}" service, so nothing behind it can be checked`);
    return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  /** GET (the only verb a prod run may use). `auth: true` sends the dashboard token. */
  async get(path, { service = "site", auth = false, headers = {}, timeoutMs } = {}) {
    return this.#send("GET", path, { service, auth, headers, timeoutMs });
  }

  /** A write. Refused outright on prod: a prod sweep must never change anything. */
  async send(method, path, { service = "site", auth = false, headers = {}, body, timeoutMs } = {}) {
    if (this.mode === "prod") throw new CheckFailure(`a ${method} was attempted in prod mode (${path}) — prod sweeps are read-only`);
    return this.#send(method, path, { service, auth, headers, body, timeoutMs });
  }

  async #send(method, path, { service, auth, headers, body, timeoutMs }) {
    const url = this.url(path, service);
    const h = { "user-agent": "saf-e2e/1 (whole-site release gate)", ...headers };
    if (auth) {
      if (!this.token) throw new Untestable(`this check needs the dashboard token and none was supplied (${redactUrl(path)})`);
      h["x-affiliate-token"] = this.token;
    }
    let payload;
    if (body !== undefined) { payload = typeof body === "string" ? body : JSON.stringify(body); h["content-type"] ??= "application/json"; }
    this.requests++;
    const t0 = this.now();
    let r;
    try {
      r = await this.fetchImpl(url, { method, headers: h, body: payload, redirect: "follow", signal: AbortSignal.timeout(timeoutMs || this.timeoutMs) });
    } catch (e) {
      throw new CheckFailure(`${method} ${redactUrl(url)} did not answer (${trim(e?.message || e, 100)})`);
    }
    const text = await r.text().catch(() => "");
    return new Res({ url, status: r.status, headers: r.headers, text, ms: this.now() - t0 });
  }

  // ── assertions (each counts; a check with zero assertions fails) ────────────
  ok(cond, message) {
    this.asserts++;
    if (!cond) throw new CheckFailure(message);
  }

  /** HTTP status is exactly `expected`. */
  status(res, expected = 200) {
    this.ok(res.status === expected, `expected HTTP ${expected}: ${res.describe()}`);
    return res;
  }

  /**
   * The endpoint answered 200 AND its own success flag is true. `flag` names the field
   * ("success" or "ok"); it must be present — a body with no flag is a failure, because
   * that is what an error page or a proxy answer looks like.
   */
  success(res, flag = "success") {
    this.status(res, 200);
    this.ok(res.json && typeof res.json === "object", `expected a JSON object: ${res.describe()} body="${trim(res.text, 80)}"`);
    this.ok(flag in res.json, `the answer has no "${flag}" flag: ${res.describe()}`);
    this.ok(res.json[flag] === true, `the endpoint reported failure: ${res.describe()}`);
    return res.json;
  }

  /** 200 and a JSON body, for the few endpoints that return bare data with no flag. */
  json(res) {
    this.status(res, 200);
    this.ok(res.json !== null, `expected JSON: ${res.describe()} body="${trim(res.text, 80)}"`);
    return res.json;
  }

  /** 200 and an HTML document that is really the page asked for (not the home-page fallback). */
  html(res, { mustContain } = {}) {
    this.status(res, 200);
    this.ok(/<html[\s>]/i.test(res.text) && res.text.length > 500, `expected an HTML page: ${res.describe()} (${res.text.length} bytes)`);
    for (const needle of [].concat(mustContain || [])) {
      this.ok(needle instanceof RegExp ? needle.test(res.text) : res.text.includes(needle),
        `the page ${redactUrl(res.url)} does not contain ${needle instanceof RegExp ? needle : `"${needle}"`}`);
    }
    return res.text;
  }

  /** A list/string/object that must have content. `what` says what it is, in plain words. */
  nonEmpty(value, what) {
    const n = Array.isArray(value) ? value.length
      : typeof value === "string" ? value.trim().length
      : value && typeof value === "object" ? Object.keys(value).length
      : 0;
    this.ok(n > 0, `${what} is empty`);
    return value;
  }

  atLeast(n, min, what) {
    this.ok(typeof n === "number" && n >= min, `${what}: expected at least ${min}, got ${n}`);
    return n;
  }

  /** Every listed field (dot paths allowed) is present and not null/blank. */
  fields(obj, paths, what) {
    this.ok(obj && typeof obj === "object", `${what} is missing`);
    for (const p of paths) {
      const v = p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
      const blank = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
      this.ok(!blank, `${what} has no "${p}"`);
    }
    return obj;
  }

  matches(value, re, what) {
    this.ok(typeof value === "string" && re.test(value), `${what} does not look right: "${trim(value, 100)}"`);
    return value;
  }

  equal(actual, expected, what) {
    this.ok(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  /** A timestamp (ISO string or ms) no older than `maxAgeHours`. */
  fresh(when, maxAgeHours, what) {
    const ms = typeof when === "number" ? when : Date.parse(String(when ?? ""));
    this.ok(Number.isFinite(ms), `${what} has no readable time ("${trim(when, 40)}")`);
    const ageH = (this.now() - ms) / 3_600_000;
    this.ok(ageH <= maxAgeHours, `${what} is stale: ${ageH.toFixed(1)} hours old, limit ${maxAgeHours} hours`);
    return ageH;
  }

  /**
   * A condition the box must provide for this check to mean anything (a live storm
   * alert, a pending draft, a subscriber in each language…). Missing → UNTESTABLE,
   * which FAILS the run: seed the condition, do not skip the check.
   */
  require(cond, what) {
    this.asserts++;
    if (!cond) throw new Untestable(what);
  }

  // ── before/after record ─────────────────────────────────────────────────────
  /**
   * Record something a release must not silently change.
   *   kind "exact" — any change is reported (a set of keys, a page title, a flag)
   *   kind "min"   — a drop is reported (counts that only grow or wobble upward)
   *   kind "info"  — recorded for the report, never compared
   */
  observe(key, value, kind = "exact") {
    this.observations[key] = { value, kind };
    return value;
  }

  note(text) { this.notes.push(String(text)); }
}

/** Sorted top-level keys of an object — the usual "shape" observation. */
export const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o).sort().join(",") : "");

/**
 * Run one check and never throw. Status:
 *   pass · fail · untestable (a required condition is missing — counts as a failure)
 */
export async function runCheck(check, ctxOpts) {
  const t = new Ctx(ctxOpts);
  const started = t.now();
  const out = { id: check.id, title: check.title, area: check.area || check.id.split(".")[0], status: "pass", failures: [], asserts: 0, requests: 0, observations: {}, notes: [], ms: 0 };
  try {
    await Promise.race([
      check.run(t),
      new Promise((_, rej) => setTimeout(() => rej(new CheckFailure(`the check did not finish within ${(check.timeoutMs || 120_000) / 1000} seconds`)), check.timeoutMs || 120_000).unref?.()),
    ]);
    if (t.asserts === 0) { out.status = "fail"; out.failures.push("the check made no assertions, so it proves nothing"); }
  } catch (e) {
    if (e instanceof Untestable) { out.status = "untestable"; out.failures.push(`cannot be tested here: ${e.message}`); }
    else if (e instanceof CheckFailure) { out.status = "fail"; out.failures.push(e.message); }
    else { out.status = "fail"; out.failures.push(`the check itself crashed: ${trim(e?.stack || e, 300)}`); }
  }
  out.asserts = t.asserts; out.requests = t.requests; out.observations = t.observations; out.notes = t.notes; out.ms = t.now() - started;
  return out;
}

/** Validate a check definition; returns a list of problems (empty = fine). */
export function lintCheck(c) {
  const p = [];
  if (!c || typeof c !== "object") return ["not an object"];
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(c.id || "")) p.push(`id "${c.id}" must look like area.what-it-checks`);
  if (!c.title || c.title.length < 15) p.push(`${c.id}: title must say, in plain English, what a visitor or Mark would see`);
  if (!Array.isArray(c.covers) || c.covers.length === 0) p.push(`${c.id}: covers[] must name the pages, endpoints, jobs or flows this check exercises`);
  if (!Array.isArray(c.modes) || !c.modes.length || c.modes.some((m) => m !== "dev" && m !== "prod")) p.push(`${c.id}: modes must be ["dev"], ["prod"] or both`);
  if (Array.isArray(c.modes) && !c.modes.includes("prod") && !c.devOnlyBecause) p.push(`${c.id}: a check that does not run on prod must say why (devOnlyBecause)`);
  if (Array.isArray(c.modes) && !c.modes.includes("dev") && !c.prodOnlyBecause) p.push(`${c.id}: a check that does not run on dev must say why (prodOnlyBecause) — dev is supposed to mirror prod`);
  if (typeof c.run !== "function") p.push(`${c.id}: run(t) is missing`);
  if (typeof c.basis !== "string" || !/^(ruling|tad|master-ref|code|incident): .{20,}/.test(c.basis)) p.push(`${c.id}: basis must cite the design source (ruling: | tad: | master-ref: | code: | incident: …) — a gate check tests a property of the site, never a state of the world (Mark 2026-10-09)`);
  return p;
}
