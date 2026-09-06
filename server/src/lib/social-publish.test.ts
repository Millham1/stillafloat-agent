import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { igLangAllowed } from "./social-publish";

describe("IG_POST_LANGS gate", () => {
  it("unset or empty = every language", () => {
    assert.equal(igLangAllowed("en", undefined), true);
    assert.equal(igLangAllowed("es", ""), true);
    assert.equal(igLangAllowed("en", " , "), true);
  });
  it("Spanish-only test: es posts, en does not", () => {
    assert.equal(igLangAllowed("es", "es"), true);
    assert.equal(igLangAllowed("en", "es"), false);
    assert.equal(igLangAllowed("EN", " es, en "), true);
  });
});
