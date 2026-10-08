// storm-spanish.test.ts — the Spanish twin of storm texts (2026-10-08): templates, the sanity read a
// translation must pass, and which text a reader in each language is shown.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { allClearEs, declaredAlertEs, looksLikeSpanishTwin, textFor } from "./storm-spanish";

const EN = { headline: "Hurricane Isaias: 65-kt storm about 200 miles northwest of Progreso", body_md: "**Isaias** is a hurricane in the Gulf.\n\n**What this means for you:** itineraries can change; nothing to do right now — we are watching it." };

test("looksLikeSpanishTwin: accepts a faithful Spanish twin, rejects English, empties and wild lengths", () => {
  const es = { headline_es: "Huracán Isaias: tormenta de 65 kt a unas 200 millas al noroeste de Progreso", body_md_es: "**Isaias** es un huracán en el Golfo.\n\n**Qué significa esto para usted:** los itinerarios pueden cambiar; no hay nada que hacer por ahora — lo estamos vigilando." };
  assert.equal(looksLikeSpanishTwin(EN, es), true);
  assert.equal(looksLikeSpanishTwin(EN, { headline_es: EN.headline, body_md_es: EN.body_md }), false, "English handed back is not a translation");
  assert.equal(looksLikeSpanishTwin(EN, { headline_es: "", body_md_es: es.body_md_es }), false);
  assert.equal(looksLikeSpanishTwin(EN, { headline_es: es.headline_es, body_md_es: "Sí." }), false, "far too short");
  assert.equal(looksLikeSpanishTwin(EN, null), false);
});

test("declaredAlertEs / allClearEs: Spanish templates carry the name, grounds and the 'Qué significa esto para usted' lead-in", () => {
  const d = declaredAlertEs({ name: "Gale Alpha", classification: "Gale Warning", grounds: ["bahamas"], windowStart: "2026-10-08", windowEnd: "2026-10-12", note: "Nota de Mark", declared: true });
  assert.match(d.headline_es, /^Gale Alpha: vigilando /);
  assert.match(d.body_md_es, /\*\*Qué significa esto para usted:\*\*/);
  assert.match(d.body_md_es, /entre el 2026-10-08 y el 2026-10-12/);
  assert.match(d.body_md_es, /Nota de Mark$/);
  const ac = allClearEs({ name: "Isaias", classification: "Hurricane", affected_grounds: ["western_caribbean"] });
  assert.equal(ac.all_clear_headline_es, "Todo despejado: Isaias ya no es una amenaza");
  assert.match(ac.all_clear_body_md_es, /\*\*Isaias\*\* \(Hurricane\)/);
  assert.match(ac.all_clear_body_md_es, /Qué significa esto para usted/);
});

test("textFor: Spanish readers get Spanish only when BOTH Spanish fields exist, else English — never a mix", () => {
  const row = { headline: "H", body_md: "B", headline_es: "T", body_md_es: "C" };
  assert.deepEqual(textFor(row, "es"), { headline: "T", body_md: "C", lang: "es" });
  assert.deepEqual(textFor(row, "en"), { headline: "H", body_md: "B", lang: "en" });
  assert.deepEqual(textFor({ ...row, body_md_es: null }, "es"), { headline: "H", body_md: "B", lang: "en" });
  assert.deepEqual(textFor({ headline: "H", body_md: "B" }, "es"), { headline: "H", body_md: "B", lang: "en" });
});
