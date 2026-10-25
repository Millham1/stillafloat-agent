import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderSignedPdf, pdfSafe } from "./group-signature-pdf";
import { fillBlocks, renderDocument, buildCtx } from "./group-documents";
import { BUSINESS } from "./group-secure";

/** The text of an UNCOMPRESSED pdfkit file: its text operators hold hex strings (WinAnsi bytes), run after run. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  let out = "";
  for (const op of raw.matchAll(/\[((?:<[0-9a-fA-F]*>|\s|-?\d+(?:\.\d+)?)*)\]\s*TJ/g)) {
    for (const hex of op[1]!.matchAll(/<([0-9a-fA-F]*)>/g)) out += Buffer.from(hex[1]!, "hex").toString("latin1");
    out += "\u0001"; // a line / run boundary
  }
  return out;
}

const NOW = new Date("2026-10-16T15:30:12Z");
const group = { id: "g1", name: "Legion", cruise_line: "MSC", ship_name: "MSC Seascape", sail_date: "2027-03-14", return_date: "2027-03-21", nights: 7, embark_port: "Port Canaveral", fees: {}, terms: {} };
const traveler = { id: "t1", first_name: "José", last_name: "Núñez", cabin_id: null, form_data: {} };

test("pdfSafe keeps Latin-1, turns boxes into [x] / [ ], and never emits a character the standard fonts cannot print", () => {
  assert.equal(pdfSafe("José Núñez — “ok” ☒ ☐"), "José Núñez — “ok” [x] [ ]");
  assert.equal(pdfSafe("Nguyễn Łukasz 田"), "Nguyen ?ukasz ?");
  assert.equal(pdfSafe("a b c"), "a b c");
});

test("the signed copy is a real PDF that carries the document, the typed name, the UTC time, the version and the hash", async () => {
  const doc = renderDocument("05-liability-waiver", buildCtx({ business: BUSINESS, group, traveler, now: NOW }));
  const blocks = fillBlocks(doc, { health_ack: true, insurance_status: "declined" }, NOW);
  const logo = readFileSync(`${process.cwd()}/public${BUSINESS.logoPath}`);
  const pdf = await renderSignedPdf({
    businessName: BUSINESS.legalName, title: doc.title, blocks, signerName: "José Núñez", signerRole: "traveler", signedAt: NOW,
    docVersion: doc.version, contentSha256: doc.sha256, signatureId: "sig-123", logo, compress: false,
  });
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.length > 5000);
  const text = pdfText(pdf).replace(/\u0001/g, "");
  for (const want of [
    "Still Afloat LLC dba Still Afloat Cruising", "Liability Waiver and Release", "ELECTRONIC SIGNATURE", "Signed electronically by: José Núñez",
    "Date and time: 2026-10-16 15:30:12 UTC", `Document version: ${doc.version}`, doc.sha256, "Signature record: sig-123",
    "[x] I/We HAVE", "Seller of Travel: CA #2158353-50",
  ].filter((w) => !w.includes("[x] I/We HAVE"))) assert.ok(text.includes(want), `the signed copy is missing: ${want}`);
  assert.ok(text.includes("[x] I/We have DECLINED travel insurance"), "the box the signer ticked shows as [x]");
  assert.ok(text.includes("[ ] I/We HAVE purchased"), "a box left alone shows as [ ]");
  assert.ok(!text.includes("{{") && !text.includes("☒"));
  assert.ok(!text.includes("not yet recorded"), "only the group contract waits for the agent");
  assert.match(text, /page 1 of \d+/);
});

test("the group contract's copy says the agent's countersignature is still to come", async () => {
  const doc = renderDocument("09-group-travel-contract", buildCtx({ business: BUSINESS, group, now: NOW }));
  const pdf = await renderSignedPdf({
    businessName: BUSINESS.legalName, title: doc.title, blocks: fillBlocks(doc, { org_address: "5 Elm" }, NOW), signerName: "Pat Organizer",
    signerRole: "organizer", signedAt: NOW, docVersion: doc.version, contentSha256: doc.sha256, agentCountersignPending: true, compress: false,
  });
  const text = pdfText(pdf).replace(/\u0001/g, "");
  assert.ok(text.includes("Signing as: group organizer"));
  assert.ok(text.includes("Agent countersignature (Still Afloat LLC dba Still Afloat Cruising): not yet recorded."));
  assert.ok(text.includes("Address: 5 Elm"));
});

// Mark 2026-10-25: DocuSign-grade evidence. The evidence page, and the real seal on the real copy.
import { makeSelfSignedP12, sealerFromP12, verifySeal } from "./group-pdf-seal";

test("the signed copy ends with a signature-evidence page: the email the link went to, sent, opened, consent, address, browser, and the seal", async () => {
  const doc = renderDocument("05-liability-waiver", buildCtx({ business: BUSINESS, group, traveler, now: NOW }));
  const input = {
    businessName: BUSINESS.legalName, title: doc.title, blocks: fillBlocks(doc, { health_ack: true }, NOW), signerName: "José Núñez", signerRole: "traveler", signedAt: NOW,
    docVersion: doc.version, contentSha256: doc.sha256, signatureId: "sig-123", logo: null, compress: false,
    audit: {
      signerEmail: "jose@example.com", linkSentAt: "2026-10-15T12:00:00.000Z", firstOpenedAt: "2026-10-16T15:20:00.000Z",
      consentAt: "2026-10-16T15:21:05.000Z", consentVersion: "2026-10-25", consentIp: "203.0.113.9",
      ip: "203.0.113.9", ua: "Mozilla/5.0 (iPhone)", seal: { fingerprint: "ab".repeat(32), subject: "Still Afloat Cruising" },
    },
  };
  const text = pdfText(await renderSignedPdf(input)).replace(/\u0001/g, "");
  for (const want of [
    "SIGNATURE EVIDENCE", "Signer: José Núñez (traveler)", "where the private link went: jose@example.com",
    "Private link sent: 2026-10-15 12:00:00 UTC", "Link first opened: 2026-10-16 15:20:00 UTC",
    "Consent to electronic records and signatures: 2026-10-16 15:21:05 UTC (consent text version 2026-10-25), from 203.0.113.9",
    "Signed: 2026-10-16 15:30:12 UTC, from 203.0.113.9", "Browser and device at signing: Mozilla/5.0 (iPhone)",
    "This PDF is sealed with a digital certificate held by Still Afloat LLC dba Still Afloat Cruising", "ABAB ABAB",
  ]) assert.ok(text.includes(want), `the evidence page is missing: ${want}`);
  const unsealed = pdfText(await renderSignedPdf({ ...input, audit: { ...input.audit, seal: null } })).replace(/\u0001/g, "");
  assert.ok(unsealed.includes("This PDF is not sealed"), "an unsealed copy says so");
  assert.ok(!unsealed.includes("sealed with a digital certificate"));
  const old = pdfText(await renderSignedPdf({ ...input, audit: undefined })).replace(/\u0001/g, "");
  assert.ok(!old.includes("SIGNATURE EVIDENCE"), "no evidence page without evidence");
});

test("the real copy, sealed with a real certificate, verifies; and a change of one byte breaks it", async () => {
  const p12 = makeSelfSignedP12({ commonName: "Still Afloat Cruising", organization: "Still Afloat LLC", passphrase: "pw", bits: 1024 });
  const sealer = sealerFromP12(p12, "pw");
  const doc = renderDocument("16-passport-document-checklist", buildCtx({ business: BUSINESS, group, traveler, now: NOW }));
  const pdf = await renderSignedPdf({ businessName: BUSINESS.legalName, title: doc.title, blocks: fillBlocks(doc, {}, NOW), signerName: "José Núñez", signerRole: "traveler", signedAt: NOW, docVersion: doc.version, contentSha256: doc.sha256, signatureId: "sig-9", logo: null });
  const sealed = await sealer.seal(pdf, { reason: `Signed copy: ${doc.title}`, contactInfo: BUSINESS.email, name: BUSINESS.legalName, location: "Raleigh, North Carolina" }, NOW);
  const ok = verifySeal(sealed);
  assert.equal(ok.intact, true, ok.reason);
  assert.equal(ok.fingerprint, sealer.fingerprint);
  assert.equal(ok.signedAt, NOW.toISOString());
  const bad = Buffer.from(sealed); bad[300] = bad[300]! ^ 0x20;
  assert.equal(verifySeal(bad).intact, false);
});
