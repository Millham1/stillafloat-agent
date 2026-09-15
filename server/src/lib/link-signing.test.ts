// link-signing.test.ts — email links are signed with UNSUBSCRIBE_SECRET, and links signed with
// the old public default keep working through LEGACY_SIGNATURES_UNTIL (unsubscribe and stop only).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { LEGACY_SIGNATURES_UNTIL, signLink, verifyLink } from "./link-signing";

const env = { UNSUBSCRIBE_SECRET: "test-secret-0123456789" };
const ID = "0b6f7a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const hmac = (secret: string, text: string) => crypto.createHmac("sha256", secret).update(text).digest("hex").slice(0, 24);
const oldSig = (text: string) => hmac("still-afloat-unsub-v1", text);
const BEFORE = "2026-09-20";
const AFTER = "2026-11-01";

describe("signLink", () => {
  it("signs with the secret, so a signature built from the public default no longer matches", () => {
    const sig = signLink("unsubscribe", "pat@example.com", env);
    assert.equal(sig, hmac(env.UNSUBSCRIBE_SECRET, "pat@example.com"));
    assert.notEqual(sig, oldSig("pat@example.com"));
  });

  it("signs the same text the old links did: the address in lower case, watch:<id>, watch-restart:<id>", () => {
    assert.equal(signLink("unsubscribe", "Pat@Example.COM", env), hmac(env.UNSUBSCRIBE_SECRET, "pat@example.com"));
    assert.equal(signLink("watch-stop", ID, env), hmac(env.UNSUBSCRIBE_SECRET, `watch:${ID}`));
    assert.equal(signLink("watch-restart", ID, env), hmac(env.UNSUBSCRIBE_SECRET, `watch-restart:${ID}`));
  });

  it("uses the old default only when no secret is set, and reads a quoted value without its quotes", () => {
    assert.equal(signLink("unsubscribe", "pat@example.com", {}), oldSig("pat@example.com"));
    assert.equal(signLink("unsubscribe", "pat@example.com", { UNSUBSCRIBE_SECRET: "  " }), oldSig("pat@example.com"));
    assert.equal(
      signLink("unsubscribe", "pat@example.com", { UNSUBSCRIBE_SECRET: `"${env.UNSUBSCRIBE_SECRET}"` }),
      signLink("unsubscribe", "pat@example.com", env),
    );
  });
});

describe("verifyLink", () => {
  it("accepts a link signed with the secret on any day, whatever case the address arrives in", () => {
    const sig = signLink("unsubscribe", "pat@example.com", env);
    assert.equal(verifyLink("unsubscribe", "pat@example.com", sig, { env, today: AFTER }), true);
    assert.equal(verifyLink("unsubscribe", "Pat@Example.com", sig, { env, today: BEFORE }), true);
    assert.equal(verifyLink("watch-stop", ID, signLink("watch-stop", ID, env), { env, today: AFTER }), true);
    assert.equal(verifyLink("watch-restart", ID, signLink("watch-restart", ID, env), { env, today: AFTER }), true);
  });

  it("accepts old-default unsubscribe and stop links through October 31, and refuses them after", () => {
    assert.equal(LEGACY_SIGNATURES_UNTIL, "2026-10-31");
    assert.equal(verifyLink("unsubscribe", "pat@example.com", oldSig("pat@example.com"), { env, today: BEFORE }), true);
    assert.equal(verifyLink("unsubscribe", "pat@example.com", oldSig("pat@example.com"), { env, today: "2026-10-31" }), true);
    assert.equal(verifyLink("watch-stop", ID, oldSig(`watch:${ID}`), { env, today: "2026-10-31" }), true);
    assert.equal(verifyLink("unsubscribe", "pat@example.com", oldSig("pat@example.com"), { env, today: AFTER }), false);
    assert.equal(verifyLink("watch-stop", ID, oldSig(`watch:${ID}`), { env, today: AFTER }), false);
  });

  it("never accepts an old-default keep-tracking link, since none were ever sent", () => {
    assert.equal(verifyLink("watch-restart", ID, oldSig(`watch-restart:${ID}`), { env, today: BEFORE }), false);
  });

  it("refuses a signature for another address or another purpose, and anything that is not a signature", () => {
    const sig = signLink("unsubscribe", "pat@example.com", env);
    assert.equal(verifyLink("unsubscribe", "someone@example.com", sig, { env, today: BEFORE }), false);
    assert.equal(verifyLink("watch-restart", ID, signLink("watch-stop", ID, env), { env, today: BEFORE }), false);
    assert.equal(verifyLink("unsubscribe", "", sig, { env, today: BEFORE }), false);
    for (const bad of [undefined, null, "", "abc", sig.toUpperCase(), `${sig}0`, 123, [sig]]) {
      assert.equal(verifyLink("unsubscribe", "pat@example.com", bad, { env, today: BEFORE }), false, String(bad));
    }
  });
});
