import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clipObjectPath, isValidVideoId, isClipLang } from "./social-clips";

describe("social-clips paths", () => {
  it("accepts YouTube ids and en|es only", () => {
    assert.equal(isValidVideoId("cVYO5l_0FEE"), true);
    assert.equal(isValidVideoId("../etc/passwd"), false);
    assert.equal(isValidVideoId("a b"), false);
    assert.equal(isValidVideoId(42), false);
    assert.equal(isClipLang("es"), true);
    assert.equal(isClipLang("fr"), false);
  });
  it("builds <lang>/<videoId>.mp4 and refuses anything else", () => {
    assert.equal(clipObjectPath("cVYO5l_0FEE", "es"), "es/cVYO5l_0FEE.mp4");
    assert.throws(() => clipObjectPath("x", "es"), /invalid videoId/);
    assert.throws(() => clipObjectPath("cVYO5l_0FEE", "de"), /lang/);
  });
});
