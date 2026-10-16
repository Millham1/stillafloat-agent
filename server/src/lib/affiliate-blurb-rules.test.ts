// affiliate-blurb-rules.test.ts — the gear-page blurb guard. The cases are the real blurbs the
// writer produced on 2026-10-15 (four "actually", one "cheap", one invented habit in Mark's name).
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { blurbProblems, scrubBlurb } from "./affiliate-blurb-rules";

test("the 2026-10-15 offenders are all caught", () => {
  assert.ok(blurbProblems("The 3D contour actually works—blocks light completely.", "").some((p) => p.includes("actually")));
  assert.ok(blurbProblems("Pack a few pairs—they're cheap and you'll lose at least one.", "").some((p) => p.includes("cheap")));
  assert.ok(blurbProblems("Three small packs fit in a carry-on. I keep one in my day pack, always.", "").some((p) => p.includes("first person")));
  assert.ok(blurbProblems("", "El contorno 3D realmente funciona.").some((p) => p.includes("realmente")));
});

test("clean blurbs in both languages pass", () => {
  assert.deepEqual(
    blurbProblems(
      "Soft foam plugs for the hallway chatter, the ice machine and the cabin next door that laughs until 2 a.m.",
      "Tapones de espuma suave para las conversaciones del pasillo y la máquina de hielo.",
    ),
    [],
  );
});

test("first-person check does not trip on ordinary words", () => {
  // "Wi-Fi", "iPhone", "mine" inside "determine", "me" inside "meds"/"home" are not first person.
  assert.deepEqual(blurbProblems("Works with any iPhone, helps you determine the Wi-Fi spot, holds meds at home.", ""), []);
  assert.deepEqual(blurbProblems("", "Mismo tamaño, mitad del peso; ideal para mímicas."), []);
});

test("scrub removes banned words, swaps cheaper, and drops first-person sentences", () => {
  assert.equal(scrubBlurb("Foam plugs that actually stay in.", "en"), "Foam plugs that stay in.");
  assert.equal(scrubBlurb("A cheaper way to stay organized.", "en"), "A less expensive way to stay organized.");
  assert.equal(scrubBlurb("Three packs fit in a carry-on. I keep one in my day pack, always.", "en"), "Three packs fit in a carry-on.");
  assert.equal(scrubBlurb("El contorno realmente funciona y es barato.", "es"), "El contorno funciona y es económico.");
  assert.deepEqual(blurbProblems(scrubBlurb("It actually works and it's cheap. My favorite.", "en"), ""), []);
});
