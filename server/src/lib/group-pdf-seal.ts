// group-pdf-seal.ts — seal a signed copy with OUR certificate, and check a seal (migration 0058).
//
// Mark 2026-10-25: "how am I sure the electronic signatures conform legally, like a docusign signature would."
// A typed name with intent is a valid signature under ESIGN/UETA; what DocuSign adds is evidence. One piece of
// that evidence is a tamper-evident seal: the finished PDF is signed (PKCS#7 detached, PAdES-style) with a
// certificate held by the business, so any change to the file after sealing breaks the seal.
//
// The certificate is a PKCS#12 file in the box's shared.env as GROUP_SIGN_P12_B64 (base64) + GROUP_SIGN_P12_PASS.
// No certificate configured → no seal (the signature itself is still recorded; the audit page says "not sealed").
// Pure apart from the libraries: no file or network access.

import forge from "node-forge";
import { createHash } from "node:crypto";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";

export interface Sealer {
  /** SHA-256 of the certificate (DER), lower-case hex: printed on the audit page so a copy can be matched to the certificate. */
  fingerprint: string;
  /** The certificate's common name. */
  subject: string;
  /** Adds the signature field to a finished PDF (an incremental update; the pages are untouched) and signs it. */
  seal(pdf: Buffer, meta: SealMeta, signingTime?: Date): Promise<Buffer>;
}

export interface SealMeta { reason: string; contactInfo: string; name: string; location: string }

export function sealerFromEnv(env: NodeJS.ProcessEnv = process.env): Sealer | null {
  const b64 = (env["GROUP_SIGN_P12_B64"] ?? "").trim();
  if (!b64) return null;
  return sealerFromP12(Buffer.from(b64, "base64"), env["GROUP_SIGN_P12_PASS"] ?? "");
}

export function sealerFromP12(p12: Buffer, passphrase: string): Sealer {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString("binary")));
  const store = forge.pkcs12.pkcs12FromAsn1(asn1, false, passphrase);
  const bags = store.getBags({ bagType: forge.pki.oids["certBag"] })[forge.pki.oids["certBag"]!] ?? [];
  const cert = bags.find((b) => b.cert)?.cert;
  if (!cert) throw new Error("the P12 holds no certificate");
  // A P12Signer reads its certificate from a forge buffer that the first signature uses up, so one kept for the
  // server's life sealed only the first copy after a restart ("Too few bytes to parse DER", 2026-10-28): a fresh one per seal.
  return {
    fingerprint: certFingerprint(cert),
    subject: String(cert.subject.getField("CN")?.value ?? ""),
    async seal(pdf, meta, signingTime) {
      const withField = plainAddPlaceholder({ pdfBuffer: pdf, reason: meta.reason, contactInfo: meta.contactInfo, name: meta.name, location: meta.location, signatureLength: 8192, signingTime });
      return new SignPdf().sign(withField, new P12Signer(p12, { passphrase }), signingTime);
    },
  };
}

export function certFingerprint(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return createHash("sha256").update(Buffer.from(der, "binary")).digest("hex");
}

/** The fingerprint as people read it: pairs separated by spaces, four groups a line is up to the caller. */
export function prettyFingerprint(hex: string): string {
  return (hex.match(/.{1,4}/g) ?? [hex]).join(" ").toUpperCase();
}

/** A self-signed certificate + key as a P12, for the test suite and for first set-up (openssl does the same on the box). */
export function makeSelfSignedP12(input: { commonName: string; organization: string; passphrase: string; days?: number; bits?: number }): Buffer {
  const keys = forge.pki.rsa.generateKeyPair({ bits: input.bits ?? 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + createHash("sha1").update(String(Date.now())).digest("hex").slice(0, 16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + (input.days ?? 3650) * 86_400_000);
  const attrs = [{ name: "commonName", value: input.commonName }, { name: "organizationName", value: input.organization }, { name: "countryName", value: "US" }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true, nonRepudiation: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], input.passphrase, { algorithm: "3des", generateLocalKeyId: true, friendlyName: input.commonName });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
}

export interface SealCheck {
  sealed: boolean;
  /** True when the seal is present AND the file is unchanged since sealing AND the signature verifies against the embedded certificate. */
  intact: boolean;
  fingerprint?: string;
  subject?: string;
  signedAt?: string;
  reason?: string;
}

const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";

/** The leading DER element of a padded buffer: its tag, its length bytes and the length they state. */
function derOnly(buf: Buffer): Buffer {
  if (buf.length < 2) throw new Error("the seal is empty");
  const first = buf[1]!;
  if (first < 0x80) return buf.subarray(0, 2 + first);
  const n = first & 0x7f;
  if (n < 1 || n > 4 || buf.length < 2 + n) throw new Error("the seal's length cannot be read");
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + buf[2 + i]!;
  if (2 + n + len > buf.length) throw new Error("the seal is longer than its placeholder");
  return buf.subarray(0, 2 + n + len);
}

/** Checks a sealed PDF: the covered bytes hash to the digest inside the signature, and the signature verifies with the certificate. */
export function verifySeal(pdf: Buffer): SealCheck {
  const text = pdf.toString("latin1");
  const br = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  if (!br) return { sealed: false, intact: false, reason: "no seal" };
  const [a, b, c, d] = [Number(br[1]), Number(br[2]), Number(br[3]), Number(br[4])];
  const contentsAt = text.indexOf("/Contents", br.index + br[0].length);
  const lt = text.indexOf("<", contentsAt); const gt = text.indexOf(">", lt);
  if (contentsAt < 0 || lt < 0 || gt < 0) return { sealed: false, intact: false, reason: "no signature contents" };
  const hex = text.slice(lt + 1, gt).replace(/\s+/g, "");
  if (a + b !== lt || c !== gt + 1 || c + d !== pdf.length) return { sealed: true, intact: false, reason: "the byte range does not cover the file" };
  try {
    // The signature sits in a zero-padded placeholder; it is cut at its own DER length, never by trimming zeros
    // (a signature that itself ends in a zero byte, about 1 in 256, was cut short and read as "could not be read").
    const der = forge.util.createBuffer(derOnly(Buffer.from(hex, "hex")).toString("binary"));
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der)) as forge.pkcs7.PkcsSignedData & { rawCapture: Record<string, any>; certificates: forge.pki.Certificate[] };
    const cert = p7.certificates[0];
    if (!cert) return { sealed: true, intact: false, reason: "no certificate in the seal" };
    const raw = p7.rawCapture;
    const attrs: forge.asn1.Asn1[] = raw["authenticatedAttributes"] ?? [];
    let digestInSeal = ""; let signedAt: string | undefined;
    for (const attr of attrs) {
      const oid = forge.asn1.derToOid((attr.value as forge.asn1.Asn1[])[0]!.value as string);
      const val = ((attr.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[])[0]!;
      if (oid === OID_MESSAGE_DIGEST) digestInSeal = forge.util.bytesToHex(val.value as string);
      if (oid === OID_SIGNING_TIME) signedAt = forge.asn1.utcTimeToDate(val.value as string).toISOString();
    }
    const covered = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
    const digestOfFile = createHash("sha256").update(covered).digest("hex");
    if (!digestInSeal || digestInSeal !== digestOfFile) return { sealed: true, intact: false, fingerprint: certFingerprint(cert), reason: "the file changed after it was sealed" };
    // The signature covers the signed attributes, DER-encoded as a SET.
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
    const md = forge.md.sha256.create(); md.update(forge.asn1.toDer(set).getBytes());
    const ok = (cert.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().getBytes(), raw["signature"] as string);
    return { sealed: true, intact: ok, fingerprint: certFingerprint(cert), subject: String(cert.subject.getField("CN")?.value ?? ""), signedAt, ...(ok ? {} : { reason: "the seal's signature does not verify" }) };
  } catch (err) {
    return { sealed: true, intact: false, reason: `the seal could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}
