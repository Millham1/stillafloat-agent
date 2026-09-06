import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeForPageLanguage, isSeoOverridePayload } from "./seo-executor";

describe("seo-executor: proposals aimed at Spanish pages", () => {
  it("moves English-keyed copy onto the ES fields for an /es/news/ page", () => {
    const p = normalizeForPageLanguage({
      type: "seo-override",
      page: "https://stillafloatcruising.com/es/news/super-typhoon-bavi-forces-royal-caribbean-to-scrap-cruise-e0d025.html",
      title: "Tifón Bavi Obliga a Royal Caribbean a Cancelar Crucero",
      metaDescription: "El super tifón Bavi forzó a Royal Caribbean a cancelar un crucero completo.",
    });
    assert.equal(p.title, undefined);
    assert.equal(p.metaDescription, undefined);
    assert.equal(p.title_es, "Tifón Bavi Obliga a Royal Caribbean a Cancelar Crucero");
    assert.equal(p.metaDescription_es, "El super tifón Bavi forzó a Royal Caribbean a cancelar un crucero completo.");
    assert.equal(isSeoOverridePayload(p), true);
  });
  it("explicit ES keys win; English keys are still dropped for an ES page", () => {
    const p = normalizeForPageLanguage({
      type: "seo-override", page: "/es/news/x-abc123.html",
      title: "EN copy", title_es: "ES copy", metaDescription: "EN meta",
    });
    assert.equal(p.title_es, "ES copy");
    assert.equal(p.metaDescription_es, "EN meta");
    assert.equal(p.title, undefined);
  });
  it("leaves English pages and storyId-targeted payloads untouched", () => {
    const en = { type: "seo-override" as const, page: "https://stillafloatcruising.com/news/x-abc123.html", title: "T", metaDescription: "M" };
    assert.deepEqual(normalizeForPageLanguage(en), en);
    const byId = { type: "seo-override" as const, storyId: "some-id", title: "T" };
    assert.deepEqual(normalizeForPageLanguage(byId), byId);
  });
});
