// advice-prompt.mjs — the pure parts of generate-advice.mjs: what the model is shown, and
// what a run will cost. Kept free of I/O so they can be tested without an API key.
//
// WHY (Mark, 2026-09-14): the Aura advice runs put the whole 1,949-room grid — about
// 110K tokens — in every one of ~75 calls, and the generator's "Total cost" counted only
// each archetype's final attempt, so a $14 day printed as a dollar. Two rules now live here:
//   1. COMPACT, NEVER TRIM SILENTLY. Rooms that share every attribute the model is shown are
//      sent once, as a group with the list of cabin numbers — every room stays choosable, at a
//      fraction of the tokens. The only rooms removed are ones the traveler cannot book at all
//      (a Studio sleeps one; it is dropped for any party other than a solo), and that removal
//      is reported, not hidden.
//   2. EVERY CALL IS COUNTED. The ledger below adds up every attempt, including re-rolls the
//      fidelity checks rejected and calls that failed to parse, so the printed dollar figure is
//      what the key was actually charged. --estimate prints the projection BEFORE any call.

/** Anthropic list prices per token (USD). Haiku 4.5 is what generate-advice.mjs uses. */
export const PRICES = {
  "claude-haiku-4-5": { input: 1e-6, output: 5e-6 },
  "claude-sonnet-5": { input: 2e-6, output: 10e-6 },
};
export function priceFor(model) {
  const key = Object.keys(PRICES).find((k) => String(model ?? "").startsWith(k));
  return PRICES[key] ?? PRICES["claude-haiku-4-5"];
}

/** Room kinds a party cannot book at all. Anything else stays: the model reasons trade-offs. */
export function bookable(cabin, party) {
  const kind = String(cabin.kind ?? "");
  if (/studio/i.test(kind)) return party === "solo" || party === "sologroup";
  return true;
}

/**
 * Group cabins that share every shown attribute. Order is stable (deck, kind, then first
 * appearance) so the prompt is byte-identical run to run — which is also what prompt
 * caching needs, should the ship block ever be cached.
 */
export function compactCandidates(cabins, { motionAsked = true, party = "two" } = {}) {
  const dropped = [];
  const groups = new Map();
  for (const c of cabins) {
    if (!bookable(c, party)) { dropped.push(c.id); continue; }
    const attrs = {};
    for (const [k, v] of Object.entries(c)) {
      if (k === "id" || v === null || v === undefined) continue;
      if (!motionAsked && (k === "steady" || k === "hump")) continue;
      attrs[k] = v;
    }
    const key = JSON.stringify(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    if (!groups.has(key)) groups.set(key, { attrs, cabins: [] });
    groups.get(key).cabins.push(c.id);
  }
  const rows = [...groups.values()]
    .sort((a, b) => (a.attrs.deck ?? 0) - (b.attrs.deck ?? 0) || String(a.attrs.kind ?? "").localeCompare(String(b.attrs.kind ?? "")))
    .map((g) => ({ ...g.attrs, cabins: g.cabins }));
  return { rows, dropped, kept: cabins.length - dropped.length };
}

/** Rough token estimate for English/JSON text: about four characters a token. */
export function estimateTokens(text) { return Math.ceil(String(text).length / 4); }

/**
 * What a run will cost before it is made. `attempts` is the worst case the fidelity
 * checks allow (generate-advice.mjs re-rolls up to three times), so the range is honest.
 */
export function projectCost({ promptTokens, systemTokens = 0, outputTokens = 700, calls = 1, attempts = 1, model = "claude-haiku-4-5" }) {
  const p = priceFor(model);
  const perCall = (promptTokens + systemTokens) * p.input + outputTokens * p.output;
  return { perCall, min: perCall * calls, max: perCall * calls * attempts };
}

/** Adds up every call a run makes, whatever became of its output. */
export class CostLedger {
  constructor() { this.calls = 0; this.inputTokens = 0; this.outputTokens = 0; this.usd = 0; this.failed = 0; }
  add(usage, model, ok = true) {
    const p = priceFor(model);
    const inTok = usage?.input_tokens ?? 0, outTok = usage?.output_tokens ?? 0;
    this.calls += 1; this.inputTokens += inTok; this.outputTokens += outTok;
    this.usd += inTok * p.input + outTok * p.output;
    if (!ok) this.failed += 1;
    return inTok * p.input + outTok * p.output;
  }
  summary() { return { calls: this.calls, failed: this.failed, inputTokens: this.inputTokens, outputTokens: this.outputTokens, usd: Math.round(this.usd * 1000) / 1000 }; }
}
