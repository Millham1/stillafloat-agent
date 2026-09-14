// storm-email-content.test.ts — Mark, 2026-09-14: storm emails carry the ships
// that may be affected and two buttons, tracker and storm warnings, EN and ES.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { affectedShipsHtml, ctaRowHtml, stormAlertEmailHtml, allClearEmailHtml, emailLang, trackerUrl, SHIP_LIST_MAX } from "./storm-email-content";

const base = "https://stillafloatcruising.com";
const ships = [
  { ship_name: "Carnival Sunrise", cruise_line: "Carnival" },
  { ship_name: "Wonder of the Seas", cruise_line: "Royal Caribbean" },
  { ship_name: "Carnival Celebration", cruise_line: "Carnival" },
  { ship_name: "Carnival Sunrise", cruise_line: "Carnival" }, // duplicate pin
  { ship_name: "Norwegian Getaway", cruise_line: null },
];

describe("affected ships block", () => {
  it("groups by line, sorts, dedups, and links each ship to her tracker page", () => {
    const html = affectedShipsHtml(ships, "en", base);
    assert.match(html, /Ships that may be affected/);
    assert.ok(html.indexOf("<strong>Carnival</strong>") < html.indexOf("<strong>Other lines</strong>"));
    assert.ok(html.indexOf("<strong>Other lines</strong>") < html.indexOf("<strong>Royal Caribbean</strong>"));
    assert.equal((html.match(/>Carnival Sunrise</g) || []).length, 1, "the duplicate pin is listed once");
    assert.equal((html.match(/Carnival%20Sunrise/g) || []).length, 1, "and linked once");
    assert.match(html, /href="https:\/\/stillafloatcruising\.com\/wheres-my-ship\.html\?ship=Wonder%20of%20the%20Seas"/);
    assert.doesNotMatch(html, /8080|178\.156/);
  });
  it("is empty when nothing is pinned", () => {
    assert.equal(affectedShipsHtml([], "en", base), "");
    assert.equal(affectedShipsHtml([{ ship_name: "  ", cruise_line: "X" }], "en", base), "");
  });
  it("caps a very long list and says how many more", () => {
    const many = Array.from({ length: SHIP_LIST_MAX + 7 }, (_, i) => ({ ship_name: `Ship ${String(i).padStart(3, "0")}`, cruise_line: "Line" }));
    const html = affectedShipsHtml(many, "en", base);
    assert.equal((html.match(/\?ship=/g) || []).length, SHIP_LIST_MAX);
    assert.match(html, /and 7 more/);
  });
  it("Spanish readers get Spanish labels and the Spanish tracker", () => {
    const html = affectedShipsHtml(ships, "es", base);
    assert.match(html, /Barcos que podrían verse afectados/);
    assert.match(html, /Otras navieras/);
    assert.match(html, /\/es\/wheres-my-ship\.html\?ship=/);
  });
});

describe("call-to-action row", () => {
  it("links the tracker and the storm-watch page on the public site", () => {
    const en = ctaRowHtml("en", base);
    assert.match(en, /href="https:\/\/stillafloatcruising\.com\/wheres-my-ship\.html"[^>]*>Track your ship</);
    assert.match(en, /href="https:\/\/stillafloatcruising\.com\/storm-watch\.html"[^>]*>See all storm warnings</);
    const es = ctaRowHtml("es", base);
    assert.match(es, /\/es\/wheres-my-ship\.html"[^>]*>Rastrea tu barco</);
    assert.match(es, /\/es\/storm-watch\.html"[^>]*>Ver todas las alertas de tormenta</);
  });
});

describe("whole emails", () => {
  const input = { headline: "Hurricane Karina: Western Caribbean calls at risk", name: "Karina", groundsLabel: "Western Caribbean", bodyHtml: "<p>Body.</p>", ships, unsubscribeUrl: `${base}/unsubscribe?x=1`, base, lang: "en" as const };
  it("alert: headline, body, ships, both buttons, unsubscribe, in that order", () => {
    const html = stormAlertEmailHtml(input);
    const order = ["Hurricane Karina", "<p>Body.</p>", "Ships that may be affected", "Track your ship", "See all storm warnings", "Unsubscribe"].map((n) => html.indexOf(n));
    assert.ok(order.every((i) => i > 0), String(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });
  it("all-clear: green header, still lists the ships that were watched, still carries both buttons", () => {
    const html = allClearEmailHtml({ ...input, headline: "All clear: Karina" });
    assert.match(html, /🟢 All clear: Karina/);
    assert.match(html, /Ships that may be affected/);
    assert.match(html, /Track your ship/);
    assert.match(html, /See all storm warnings/);
  });
  it("Spanish twin end to end", () => {
    const html = stormAlertEmailHtml({ ...input, lang: "es" });
    assert.match(html, /Alerta meteorológica de cruceros/);
    assert.match(html, /Cancelar suscripción/);
    assert.doesNotMatch(html, /Track your ship/);
  });
  it("escapes what it prints", () => {
    const html = stormAlertEmailHtml({ ...input, headline: "<b>x</b>", ships: [{ ship_name: "A<b>", cruise_line: "L&M" }] });
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(html, /L&amp;M/);
  });
});

describe("emailLang", () => {
  it("es, es-MX and ES are Spanish; anything else, including null, is English", () => {
    assert.equal(emailLang("es"), "es"); assert.equal(emailLang("es-MX"), "es"); assert.equal(emailLang("ES"), "es");
    assert.equal(emailLang("en"), "en"); assert.equal(emailLang(null), "en"); assert.equal(emailLang(""), "en");
    assert.equal(trackerUrl(base, "en", "Icon of the Seas"), `${base}/wheres-my-ship.html?ship=Icon%20of%20the%20Seas`);
  });
});
