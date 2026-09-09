// cabin-facts-sentence.test.ts — the never-empty fallback behind Mark's
// 2026-09-08 report ("no description for these rooms"). Pure and synchronous:
// no network, no Supabase, no llmJson.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { factsSentence } from "./cabin-facts-sentence";

describe("factsSentence — EN", () => {
  it("full facts (deck + section + side + real ocean + quiet above/below) — Mark's own worked example", () => {
    const out = factsSentence({
      deck: 8, section: "midship", side: "starboard", real_ocean: true,
      above_kind: "cabins", below_kind: "cabins",
    }, "en");
    assert.equal(out, "Deck 8, midship on the starboard side, with an open sea view and a quiet cabin above and below.");
  });

  it("degrades to deck + side only", () => {
    assert.equal(factsSentence({ deck: 8, side: "starboard" }, "en"), "Deck 8, on the starboard side.");
  });

  it("degrades to deck alone", () => {
    assert.equal(factsSentence({ deck: 8 }, "en"), "Deck 8.");
  });

  it("an interior cabin never claims a sea view, regardless of other flags", () => {
    const out = factsSentence({ deck: 5, category: "Interior", real_ocean: false }, "en");
    assert.match(out, /no window, since it's an interior cabin/);
    assert.doesNotMatch(out, /sea view/);
  });

  it("a disclosed obstruction outranks a bare real_ocean flag (matches cabins/check's headline priority)", () => {
    const out = factsSentence({ deck: 10, real_ocean: true, obstructed: true }, "en");
    assert.match(out, /a view with something outside the window/);
    assert.doesNotMatch(out, /open sea view/);
  });

  it("falls back to the line's own `view` field when real_ocean is not true", () => {
    assert.match(factsSentence({ view: "boardwalk" }, "en"), /a Boardwalk view/);
    assert.match(factsSentence({ view: "garden" }, "en"), /a garden view/);
  });

  it("view: 'none' is spoken as an explicit no-view, not silence", () => {
    assert.match(factsSentence({ deck: 3, view: "none" }, "en"), /no outside view/);
  });

  it("a known noisy neighbour (lift/stairs/venue) beats the generic above/below read", () => {
    assert.match(
      factsSentence({ above_kind: "cabins", below_kind: "cabins", noise_kind: "lift" }, "en"),
      /close to a lift lobby/,
    );
    assert.match(factsSentence({ noise_kind: "stairs" }, "en"), /close to a stairwell/);
    assert.match(factsSentence({ noise_kind: "venue" }, "en"), /close to a busy venue/);
  });

  it("never quotes the freeform noise_nearby text — only the controlled noise_kind vocabulary", () => {
    const out = factsSentence({ noise_kind: "venue", noise_nearby: "Bliss Ultra Lounge nightclub two decks down" }, "en");
    assert.doesNotMatch(out, /Bliss Ultra Lounge/);
  });

  it("mixed above/below kinds (cabin one side, open deck the other)", () => {
    assert.match(factsSentence({ above_kind: "open", below_kind: "cabins" }, "en"), /open deck above and a cabin below/);
  });

  it("only above known, below unknown", () => {
    assert.equal(factsSentence({ above_kind: "cabins" }, "en"), "This cabin has a cabin above.");
  });

  it("category + sleeps become a second sentence when location/view facts exist", () => {
    const out = factsSentence({ deck: 8, category: "Ocean View Balcony", sleeps: 4 }, "en");
    assert.equal(out, "Deck 8. It's a Ocean View Balcony and sleeps up to 4.");
  });

  it("category + sleeps alone (no deck/section/side/view/above/below at all) falls back to the category sentence itself", () => {
    assert.equal(factsSentence({ category: "Ocean View Balcony", sleeps: 2 }, "en"),
      "It's a Ocean View Balcony and sleeps up to 2.");
  });

  it("no facts at all returns the honest admission, never an empty string", () => {
    assert.equal(factsSentence(null, "en"), "I have this cabin on the plan but not enough detail to describe it — ask me and I'll check.");
    assert.equal(factsSentence(undefined, "en"), "I have this cabin on the plan but not enough detail to describe it — ask me and I'll check.");
    assert.equal(factsSentence({}, "en"), "I have this cabin on the plan but not enough detail to describe it — ask me and I'll check.");
  });

  it("null-ish fields (the real shape a Supabase row comes back as) degrade the same as absent fields", () => {
    const out = factsSentence({
      deck: null, section: null, side: null, view: null, real_ocean: null,
      obstructed: null, obstruction: null, above_kind: null, below_kind: null,
      noise_nearby: null, noise_kind: null, sleeps: null, category: null,
    }, "en");
    assert.equal(out, "I have this cabin on the plan but not enough detail to describe it — ask me and I'll check.");
  });

  it("above_kind/below_kind of 'unknown' behave as absent, not as a fact", () => {
    assert.equal(factsSentence({ above_kind: "unknown", below_kind: "unknown" }, "en"),
      "I have this cabin on the plan but not enough detail to describe it — ask me and I'll check.");
  });
});

describe("factsSentence — es-419", () => {
  it("full facts — Mark's own worked example, translated", () => {
    const out = factsSentence({
      deck: 8, section: "midship", side: "starboard", real_ocean: true,
      above_kind: "cabins", below_kind: "cabins",
    }, "es");
    assert.equal(out, "Cubierta 8, a mitad del barco por estribor, con vista abierta al mar y camarotes tranquilos arriba y abajo.");
  });

  it("degrades to deck + side only", () => {
    assert.equal(factsSentence({ deck: 8, side: "starboard" }, "es"), "Cubierta 8, por estribor.");
  });

  it("interior cabin", () => {
    assert.match(factsSentence({ deck: 5, category: "Interior" }, "es"), /sin ventana, ya que es un camarote interior/);
  });

  it("obstruction beats real_ocean", () => {
    const out = factsSentence({ real_ocean: true, obstructed: true }, "es");
    assert.match(out, /una vista con algo frente a la ventana/);
    assert.doesNotMatch(out, /vista abierta al mar/);
  });

  it("category is never translated — it's the line's own product name", () => {
    const out = factsSentence({ deck: 8, category: "Ocean View Balcony", sleeps: 4 }, "es");
    assert.match(out, /Ocean View Balcony/);
  });

  it("no facts at all returns the honest Spanish admission", () => {
    assert.equal(factsSentence(null, "es"),
      "Tengo este camarote en el plano, pero no el detalle suficiente para describirlo — pregúntame y lo reviso.");
    assert.equal(factsSentence({}, "es"),
      "Tengo este camarote en el plano, pero no el detalle suficiente para describirlo — pregúntame y lo reviso.");
  });

  it("noise_kind vocabulary in Spanish", () => {
    assert.match(factsSentence({ noise_kind: "lift" }, "es"), /cerca de una zona de ascensores/);
    assert.match(factsSentence({ noise_kind: "stairs" }, "es"), /cerca de una escalera/);
    assert.match(factsSentence({ noise_kind: "venue" }, "es"), /cerca de una zona con actividad/);
  });
});

describe("factsSentence — never returns an empty string", () => {
  it("across a spread of partial fact combinations", () => {
    const cases: Array<Parameters<typeof factsSentence>[0]> = [
      null, undefined, {},
      { deck: 4 }, { side: "port" }, { section: "aft" },
      { view: "ocean" }, { view: "inward" }, { sleeps: 2 },
      { category: "Suite" }, { obstructed: true }, { above_kind: "open" },
      { below_kind: "open" }, { noise_kind: "lift" },
    ];
    for (const c of cases) {
      for (const lang of ["en", "es"] as const) {
        const out = factsSentence(c, lang);
        assert.ok(out && out.trim().length > 0, `factsSentence(${JSON.stringify(c)}, ${lang}) was empty`);
      }
    }
  });
});
