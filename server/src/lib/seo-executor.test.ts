import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeForPageLanguage,
  isSeoOverridePayload,
  buildOverridePatch,
} from "./seo-executor";
import type { NewsStory, SeoOverride } from "./prerender-news";

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
  it("moves bodyHtml onto bodyHtml_es for an /es/news/ page, same as title/metaDescription", () => {
    const p = normalizeForPageLanguage({
      type: "seo-override",
      page: "/es/news/x-abc123.html",
      bodyHtml: "<p>Deep dive EN copy written under the wrong key</p>",
    });
    assert.equal(p.bodyHtml, undefined);
    assert.equal(p.bodyHtml_es, "<p>Deep dive EN copy written under the wrong key</p>");
  });
});

describe("seo-executor: isSeoOverridePayload", () => {
  it("accepts a payload whose only change is bodyHtml or bodyHtml_es", () => {
    assert.equal(
      isSeoOverridePayload({ type: "seo-override", storyId: "s1", bodyHtml: "<p>x</p>" }),
      true,
    );
    assert.equal(
      isSeoOverridePayload({ type: "seo-override", storyId: "s1", bodyHtml_es: "<p>x</p>" }),
      true,
    );
  });
  it("rejects a target with no change at all, including blank bodyHtml", () => {
    assert.equal(
      isSeoOverridePayload({ type: "seo-override", storyId: "s1", bodyHtml: "   " }),
      false,
    );
  });
});

describe("seo-executor: buildOverridePatch", () => {
  const story: NewsStory = { id: "s1", title: "Story Title", summary: "The gist of it." };

  it("applies bodyHtml and bodyHtml_es exactly like title/metaDescription", () => {
    const existing: SeoOverride = {};
    const { next, changes } = buildOverridePatch(existing, story, {
      type: "seo-override",
      storyId: "s1",
      bodyHtml: "<p>English deep-dive</p>",
      bodyHtml_es: "<p>Análisis en español</p>",
    });
    assert.equal(next.bodyHtml, "<p>English deep-dive</p>");
    assert.equal(next.bodyHtml_es, "<p>Análisis en español</p>");
    assert.equal(changes.length, 2);
    assert.match(changes.join(";"), /body HTML: "\(none\)" → "<p>English deep-dive<\/p>"/);
    assert.match(changes.join(";"), /ES body HTML: "\(none\)" → "<p>Análisis en español<\/p>"/);
  });

  it("updates bodyHtml when it differs from the existing override", () => {
    const existing: SeoOverride = { bodyHtml: "<p>Old copy</p>" };
    const { next, changes } = buildOverridePatch(existing, story, {
      type: "seo-override",
      storyId: "s1",
      bodyHtml: "<p>New copy</p>",
    });
    assert.equal(next.bodyHtml, "<p>New copy</p>");
    assert.equal(changes.length, 1);
    assert.match(changes[0]!, /body HTML: "<p>Old copy<\/p>" → "<p>New copy<\/p>"/);
  });

  it("reports no effective change when bodyHtml already matches the existing override", () => {
    const existing: SeoOverride = { bodyHtml: "<p>Same</p>", bodyHtml_es: "<p>Igual</p>" };
    const { next, changes } = buildOverridePatch(existing, story, {
      type: "seo-override",
      storyId: "s1",
      bodyHtml: "<p>Same</p>",
      bodyHtml_es: "<p>Igual</p>",
    });
    assert.deepEqual(changes, []);
    assert.deepEqual(next, existing);
  });

  it("reports no effective change for an entirely no-op payload (whitespace-only fields)", () => {
    const existing: SeoOverride = { title: "Existing", desc: "Existing desc" };
    const { next, changes } = buildOverridePatch(existing, story, {
      type: "seo-override",
      storyId: "s1",
      title: "  ",
      metaDescription: "",
      bodyHtml: "   ",
    });
    assert.deepEqual(changes, []);
    assert.deepEqual(next, existing);
  });
});
