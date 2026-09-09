// hashtags.test.ts — the normalizer sits on every path a hashtag takes to a
// platform (batch builder, review page, Share Kit, Make webhooks), so the cases
// here are exactly the shapes found in the stored prod queue on 2026-09-09.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeHashtags, hashtagLine, composeCaption } from "./hashtags";

describe("normalizeHashtags", () => {
  it("keeps already-prefixed tags as-is", () => {
    assert.deepEqual(normalizeHashtags(["#royalcaribbean", "#crucero"]), ["#royalcaribbean", "#crucero"]);
  });
  it("prefixes unprefixed tags (the shape that posted as plain words)", () => {
    assert.deepEqual(normalizeHashtags(["cruceros", "viajes", "humornautico"]), [
      "#cruceros",
      "#viajes",
      "#humornautico",
    ]);
  });
  it("lowercases mixed case", () => {
    assert.deepEqual(normalizeHashtags(["#RoyalCaribbean", "CruiseTips"]), ["#royalcaribbean", "#cruisetips"]);
  });
  it("drops empty strings, whitespace-only and a bare '#'", () => {
    assert.deepEqual(normalizeHashtags(["", "  ", "#", "crucero"]), ["#crucero"]);
  });
  it("collapses a stray '##' to a single '#'", () => {
    assert.deepEqual(normalizeHashtags(["##crucero", "###viajes"]), ["#crucero", "#viajes"]);
  });
  it("trims padding and removes internal spaces (a tag ends at the first space)", () => {
    assert.deepEqual(normalizeHashtags([" #crucero ", "cruise tips"]), ["#crucero", "#cruisetips"]);
  });
  it("dedupes after normalizing", () => {
    assert.deepEqual(normalizeHashtags(["#crucero", "crucero", "CRUCERO"]), ["#crucero"]);
  });
  it("tolerates junk input: non-array, non-string items", () => {
    assert.deepEqual(normalizeHashtags(undefined), []);
    assert.deepEqual(normalizeHashtags("crucero"), []);
    assert.deepEqual(normalizeHashtags([42, null, "crucero"]), ["#crucero"]);
  });
});

describe("hashtagLine / composeCaption", () => {
  it("joins with single spaces, empty when no tags", () => {
    assert.equal(hashtagLine(["a", "#b"]), "#a #b");
    assert.equal(hashtagLine([]), "");
    assert.equal(hashtagLine(undefined), "");
  });
  it("composeCaption = caption, tag line, link — blank parts omitted", () => {
    assert.equal(composeCaption("Hola 🚢", ["crucero", "#viajes"], "https://x.test/v"), "Hola 🚢\n\n#crucero #viajes\n\nhttps://x.test/v");
    assert.equal(composeCaption("Hola", [], undefined), "Hola");
    assert.equal(composeCaption("Hola", ["crucero"]), "Hola\n\n#crucero");
  });
});
