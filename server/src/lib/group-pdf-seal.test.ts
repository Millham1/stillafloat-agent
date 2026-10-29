import { test } from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import { makeSelfSignedP12, prettyFingerprint, sealerFromEnv, sealerFromP12, verifySeal } from "./group-pdf-seal";

// A small finished PDF, the way the signed copy makes one (the seal adds its own field).
function tinyPdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    doc.text(text);
    doc.end();
  });
}

const P12 = makeSelfSignedP12({ commonName: "Still Afloat Cruising (test seal)", organization: "Still Afloat LLC", passphrase: "pw-test", bits: 1024 });

test("a sealed copy verifies: the covered bytes match the digest in the seal and the signature checks against the embedded certificate", async () => {
  const sealer = sealerFromP12(P12, "pw-test");
  assert.match(sealer.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(sealer.subject, "Still Afloat Cruising (test seal)");
  const sealed = await sealer.seal(await tinyPdf("Hello, signed copy."), { reason: "test", contactInfo: "mark@stillafloatcruising.com", name: "Still Afloat LLC", location: "Raleigh, North Carolina" }, new Date("2026-10-25T06:00:00Z"));
  const check = verifySeal(sealed);
  assert.equal(check.sealed, true); assert.equal(check.intact, true, check.reason);
  assert.equal(check.fingerprint, sealer.fingerprint);
  assert.equal(check.subject, "Still Afloat Cruising (test seal)");
  assert.equal(check.signedAt, "2026-10-25T06:00:00.000Z");
  assert.equal(prettyFingerprint("abcd1234").startsWith("ABCD 1234"), true);
});

test("one sealer seals every copy, not only the first (the server keeps one for its life; 2026-10-28 only document 1 of 6 was sealed)", async () => {
  const sealer = sealerFromP12(P12, "pw-test");
  const meta = { reason: "test", contactInfo: "mark@stillafloatcruising.com", name: "Still Afloat LLC", location: "Raleigh, North Carolina" };
  for (const n of [1, 2, 3]) {
    const check = verifySeal(await sealer.seal(await tinyPdf(`Document ${n} of 3.`), meta));
    assert.equal(check.sealed, true, `document ${n} was not sealed`); assert.equal(check.intact, true, `document ${n}: ${check.reason}`);
  }
});

test("a change to the file after sealing breaks the seal; a file without a seal says so", async () => {
  const sealer = sealerFromP12(P12, "pw-test");
  const sealed = await sealer.seal(await tinyPdf("The agreed text."), { reason: "test", contactInfo: "mark@stillafloatcruising.com", name: "Still Afloat LLC", location: "Raleigh, North Carolina" });
  const tampered = Buffer.from(sealed);
  tampered[200] = tampered[200]! ^ 0x01;   // one bit inside the covered bytes (pdfkit compresses the text, so the page content is not plain)
  const broken = verifySeal(tampered);
  assert.equal(broken.sealed, true); assert.equal(broken.intact, false); assert.match(String(broken.reason), /changed after it was sealed/);
  const plain = verifySeal(await tinyPdf("no seal"));
  assert.equal(plain.sealed, false); assert.equal(plain.intact, false);
});

test("the sealer comes from the box's env, and no certificate means no sealer (never a throw)", () => {
  assert.equal(sealerFromEnv({}), null);
  assert.equal(sealerFromEnv({ GROUP_SIGN_P12_B64: "  " }), null);
  const s = sealerFromEnv({ GROUP_SIGN_P12_B64: P12.toString("base64"), GROUP_SIGN_P12_PASS: "pw-test" });
  assert.ok(s); assert.equal(s!.subject, "Still Afloat Cruising (test seal)");
  assert.throws(() => sealerFromEnv({ GROUP_SIGN_P12_B64: P12.toString("base64"), GROUP_SIGN_P12_PASS: "wrong" }), /PKCS#12 MAC could not be verified|Invalid password/);
});
