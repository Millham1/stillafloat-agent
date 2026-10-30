import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPacket, issueToken, linkEmail, mailAllowed, organizerBlanks, packetStatuses, signDocument, formUrl,
  type FormsDeps, type FormsStore,
 giveConsent, getCopies, getCopyPdf, copiesEmail, previewDocument, documentPdf, ESIGN_CONSENT_VERSION } from "./group-forms";
import { pagePhotos } from "./group-page-photos";
import { decryptPii, hashForAudit } from "./group-secure";
import type { SignedCopyInput } from "./group-signature-pdf";
import { blocksToText } from "./group-documents";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
type Row = Record<string, any>;

function groupRow(): Row {
  return {
    id: "g1", name: "American Legion Post 12", status: "booking", cruise_line: "MSC Cruises", ship_name: "MSC Seascape", sail_date: "2027-03-14", return_date: "2027-03-21",
    nights: 7, embark_port: "Port Canaveral", itinerary: [{ port: "Port Canaveral" }, { port: "Nassau" }], group_number: "GRP1", cabins_held: 16, deposit_per_person: 250,
    deposit_due: "2026-12-01", final_payment_due: "2027-01-12", organizer_name: "Pat Organizer", organizer_email: "pat@example.com", organizer_phone: "555-123-4567",
    organizer_token_hash: null, fees: {}, terms: {}, amenities: [],
  };
}

/** An in-memory FormsStore that behaves like the tables: unique signatures, hashed tokens, no passport_enc readback. */
function makeStore() {
  const state = {
    group: groupRow(),
    cabins: [{ id: "c1", cabin_num: "8214", category: "Balcony", category_code: "8C", booking_number: "BK77", price_total: 2598 }] as Row[],
    travelers: [
      { id: "t1", group_id: "g1", cabin_id: "c1", is_lead: true, first_name: "Jane", last_name: "Public", dob: "1960-05-04", email: "jane@example.com", phone: "555-111-2222", lang: "en", form_data: {}, passport_last4: null, newsletter_opt_in: false, form_token_hash: null },
      { id: "t2", group_id: "g1", cabin_id: "c1", is_lead: false, first_name: "John", last_name: "Public", dob: "1958-01-09", email: "john@example.com", lang: "en", form_data: {}, passport_last4: "4321", passport_expiry: "2030-01-01", newsletter_opt_in: false, form_token_hash: null, passport_enc: "v1:SECRET" },
    ] as Row[],
    signatures: [] as Row[],
    prospects: [] as Row[],
    uploads: [] as Array<{ path: string; bytes: number }>,
    files: {} as Record<string, Buffer>,
    messages: [] as Row[],
    deleted: [] as string[],
    failUpdate: false,
    failUpload: false,
    duplicate: false,
  };
  let seq = 0;
  const strip = (t: Row) => { const { passport_enc: _p, dl_enc: _d, ...rest } = t; return { ...rest }; };
  const store: FormsStore = {
    async travelerByTokenHash(hash) { const t = state.travelers.find((x) => x.form_token_hash === hash); return t ? strip(t) : null; },
    async groupByOrganizerHash(hash) { return state.group.organizer_token_hash === hash ? { ...state.group } : null; },
    async group(id) { return id === state.group.id ? { ...state.group } : null; },
    async cabins() { return state.cabins.map((c) => ({ ...c })); },
    async travelers() { return state.travelers.map(strip); },
    async signaturesFor({ travelerId }) { return state.signatures.filter((s) => (travelerId ? s.traveler_id === travelerId : !s.traveler_id && s.signer_role === "organizer")).map((s) => ({ ...s })); },
    async insertSignature(row) {
      if (state.duplicate || state.signatures.some((s) => s.traveler_id && s.traveler_id === row["traveler_id"] && s.doc_key === row["doc_key"] && s.signer_role === row["signer_role"])
        || state.signatures.some((s) => !row["traveler_id"] && !s.traveler_id && s.doc_key === row["doc_key"] && s.signer_role === "organizer")) return "duplicate";
      const id = `sig${++seq}`;
      state.signatures.push({ ...row, id });
      return { id };
    },
    async deleteSignature(id) { state.deleted.push(id); state.signatures = state.signatures.filter((s) => s.id !== id); },
    async updateTraveler(id, patch) {
      if (state.failUpdate) throw new Error("database is down");
      Object.assign(state.travelers.find((t) => t.id === id)!, patch);
    },
    async uploadPdf(path, bytes) { if (state.failUpload) throw new Error("storage is down"); state.uploads.push({ path, bytes: bytes.length }); state.files[path] = bytes; },
    async downloadPdf(path) { return state.files[path] ?? null; },
    async setSignaturePdf(id, path, meta) { Object.assign(state.signatures.find((s) => s.id === id)!, { pdf_path: path, sealed: !!meta?.sealed, seal_fingerprint: meta?.seal_fingerprint ?? null }); },
    async updateGroup(id, patch) { if (id === state.group.id) Object.assign(state.group, patch); },
    async logMessage(row) { state.messages.push({ ...row }); },
    async travelerByCopiesHash(hash) { const t = state.travelers.find((x) => x.copies_token_hash === hash); return t ? strip(t) : null; },
    async groupByOrganizerCopiesHash(hash) { return state.group.organizer_copies_token_hash === hash ? { ...state.group } : null; },
    async upsertProspect(row) {
      const found = state.prospects.find((p) => p.email.toLowerCase() === String(row["email"]).toLowerCase());
      if (found) return found.id;
      const id = `pr${state.prospects.length + 1}`;
      state.prospects.push({ ...row, id });
      return id;
    },
  };
  return { state, store };
}

function setup(over: Partial<FormsDeps> = {}) {
  const { state, store } = makeStore();
  const pdfs: SignedCopyInput[] = [];
  const notices: Array<{ title: string; body: string; groupId: string }> = [];
  const warnings: string[] = [];
  const mails: Array<{ to: string; subject: string; html: string; text: string }> = [];
  const clock = { now: new Date("2026-10-16T15:30:12Z") };
  const deps: FormsDeps = {
    store, now: () => clock.now, piiKey: KEY, logo: null,
    renderPdf: async (input) => { pdfs.push(input); return Buffer.from("%PDF-1.4 test"); },
    notify: async (n) => { notices.push(n); },
    warn: (_o, msg) => { warnings.push(msg); },
    seal: null,
    mail: async (m) => { mails.push(m); return true; },
    publicSite: "https://stillafloatcruising.com",
    ...over,
  };
  const link = (travelerId: string) => { const { token, hash } = issueToken(); state.travelers.find((t) => t.id === travelerId)!.form_token_hash = hash; return token; };
  const orgLink = () => { const { token, hash } = issueToken(); state.group.organizer_token_hash = hash; return token; };
  return { state, deps, pdfs, notices, warnings, mails, link, orgLink, clock };
}

const pkt = (r: { json: Record<string, unknown> }) => r.json as { docs: Array<{ key: string; status: string; text_sha256: string; html: string; fields: Array<Record<string, any>> }>; complete: boolean; traveler: Row; mates: string[]; group: Row; cabin: Row | null; pii_ready: boolean; kind: string };
const NAME = "Jane Public";

const META = { ip: "203.0.113.9", ua: "Mozilla/5.0 test" };
async function signKey(t: ReturnType<typeof setup>, token: string, key: string, extra: Record<string, unknown> = {}, name = NAME) {
  await giveConsent(t.deps, token, { agreed: true }, META);
  const p = pkt(await getPacket(t.deps, token));
  const doc = p.docs.find((d) => d.key === key)!;
  return signDocument(t.deps, token, { doc_key: key, signer_name: name, agreed: true, content_sha256: doc.text_sha256, ...extra }, { ip: "203.0.113.9", ua: "Mozilla/5.0 test" });
}

const GOOD_15 = {
  legal_name: "Jane Public", dob: "1960-05-04", gender: "female", us_citizen: "yes", address: "1 Main St", city_state_zip: "Raleigh, NC 27601", phone: "919-555-0100", email: "jane@example.com",
  passport_number: "A12345678", passport_country: "United States", passport_expiry: "2031-02-03", ec1_name: "Sam Public", ec1_relationship: "Son", ec1_cell_phone: "919-555-0199",
  health_note: "ignored",
};
// the booking document needs the insurance choice (Mark 2026-10-29)
const BOOK = { answers: {} };

// ── Mark's own PDF, filled in (Mark 2026-10-27) ───────────────────────────────

test("a document is shown as Mark's own PDF filled in with what was typed, for this link's packet only, and nothing is saved", async () => {
  const t = setup();
  const token = t.link("t2");
  const before = JSON.stringify(t.state);
  const r = await previewDocument(t.deps, token, { doc_key: "01-terms-and-conditions", answers: { ...GOOD_15, health_ack: true, extra: { no: 1 }, "../x": "y" } });
  assert.equal(r.status, 200);
  assert.ok("bytes" in r && Buffer.from(r.bytes.slice(0, 5)).toString() === "%PDF-");
  const own = await previewDocument(t.deps, token, { doc_key: "15-emergency-contact-form", answers: GOOD_15 });
  assert.equal(own.status, 200, "the passport number in the answers is shown only as its last four");
  assert.equal(JSON.stringify(t.state), before, "a preview saves nothing");
  assert.equal((await previewDocument(t.deps, "nope", { doc_key: "01-terms-and-conditions" })).status, 404);
  assert.equal((await previewDocument(t.deps, token, { doc_key: "09-group-travel-contract" })).status, 404, "not this link's document");
  assert.equal((await previewDocument(t.deps, token, { doc_key: "../../etc/passwd" })).status, 404);
});

test("a document of the packet opens as its printed form, for this link only: not yet signed with what the file holds, signed as it was signed", async () => {
  const t = setup();
  const token = t.link("t2");
  const blank = await documentPdf(t.deps, token, "01-terms-and-conditions.pdf");
  assert.equal(blank.status, 200);
  assert.ok("bytes" in blank && Buffer.from(blank.bytes.slice(0, 5)).toString() === "%PDF-");
  assert.equal((await signKey(t, token, "15-emergency-contact-form", { answers: GOOD_15 })).status, 200);
  const signed = await documentPdf(t.deps, token, "15-emergency-contact-form");
  assert.equal(signed.status, 200);
  assert.equal((await documentPdf(t.deps, "nope", "01-terms-and-conditions")).status, 404);
  assert.equal((await documentPdf(t.deps, token, "09-group-travel-contract")).status, 404, "not this link's document");
});

// ── links ─────────────────────────────────────────────────────────────────────

test("a contract's capital letters never reach a client: the paperwork page and the paperwork email show 'MSC Seashore'", async () => {
  const t = setup();
  t.state.group.cruise_line = "MSC CRUISES"; t.state.group.ship_name = "MSC SEASHORE";
  const r = await getPacket(t.deps, t.link("t2"));
  const p = r.json as { group: { cruise_line: string; ship_name: string } };
  assert.equal(p.group.cruise_line, "MSC Cruises");
  assert.equal(p.group.ship_name, "MSC Seashore");
  const m = linkEmail({ firstName: "Jane", groupName: "American Legion Post 12", ship: "MSC SEASHORE", sailDate: "2027-03-14", url: "https://x.test/forms.html?t=T" });
  assert.ok(m.text.includes("MSC Seashore, sailing March 14, 2027") && !m.text.includes("SEASHORE") && !m.html.includes("SEASHORE"));
  // a file that already reads right is left as it is
  t.state.group.ship_name = "MSC Seascape";
  assert.equal(((await getPacket(t.deps, t.link("t2"))).json as { group: { ship_name: string } }).group.ship_name, "MSC Seascape");
});

test("an unknown, malformed, replaced or cancelled link all get the same neutral 404", async () => {
  const t = setup();
  const token = t.link("t1");
  const unknown = issueToken().token;
  const answers = await Promise.all([getPacket(t.deps, "short"), getPacket(t.deps, unknown), getPacket(t.deps, undefined), getPacket(t.deps, "../../etc/passwd")]);
  for (const a of answers) { assert.equal(a.status, 404); assert.deepEqual(a.json, answers[0]!.json); }
  assert.match(String(answers[0]!.json["error"]), /not valid/);
  assert.equal((await getPacket(t.deps, token)).status, 200);
  t.link("t1"); // a new link replaces the old one
  assert.equal((await getPacket(t.deps, token)).status, 404, "the old link must stop working");
  const fresh = t.link("t1");
  t.state.group.status = "cancelled";
  assert.equal((await getPacket(t.deps, fresh)).status, 404);
});

test("a traveler's packet lists their documents in order, with their own inputs, and nothing private", async () => {
  const t = setup();
  const r = await getPacket(t.deps, t.link("t2"));
  assert.equal(r.status, 200);
  const p = pkt(r);
  assert.equal(p.kind, "traveler");
  assert.deepEqual(p.docs.map((d) => d.key), ["15-emergency-contact-form", "01-terms-and-conditions", "05-liability-waiver", "07-travel-insurance-declination", "16-passport-document-checklist"]);
  assert.ok(p.docs.every((d) => d.status === "pending" && /^[0-9a-f]{64}$/.test(d.text_sha256) && d.html.includes("<")));
  assert.equal(p.docs[0]!.fields.length, 30, "inputs on the traveler information form");
  assert.deepEqual(p.mates, ["Jane Public"]);
  assert.equal(p.traveler.passport_on_file, "ending 4321");
  assert.equal(p.pii_ready, true);
  const raw = JSON.stringify(r.json);
  for (const secret of ["SECRET", "passport_enc", "dl_enc", "form_token_hash", "consent_ip_hash", "organizer_email", "pat@example.com", "1960-05-04", "jane@example.com", "organizer_token_hash"]) {
    assert.ok(!raw.includes(secret), `the packet leaks ${secret}`);
  }
  const lead = pkt(await getPacket(t.deps, t.link("t1")));
  assert.equal(lead.docs.length, 7, "the cabin's lead signs the same five documents, the booking agreement and the card authorization (Mark 2026-10-30)");
  assert.deepEqual(lead.docs.slice(5).map((d) => d.key), ["12-cruise-booking-agreement", "22-card-authorization"]);
  assert.ok(lead.docs[5]!.html.includes("BK77"), "the booking agreement carries the cabin's booking number from the file");
  assert.ok(!JSON.stringify(lead).includes("SECRET"));
});

// ── signing ───────────────────────────────────────────────────────────────────

test("signing records a typed name, the hash of the text, hashed audit data and a signed copy in the private bucket", async () => {
  const t = setup();
  const token = t.link("t1");
  const r = await signKey(t, token, "01-terms-and-conditions", BOOK);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json["signed"], "01-terms-and-conditions");
  const [sig] = t.state.signatures;
  assert.ok(sig);
  assert.equal(t.state.signatures.length, 1);
  assert.deepEqual(
    { traveler_id: sig!.traveler_id, cabin_id: sig!.cabin_id, group_id: sig!.group_id, role: sig!.signer_role, name: sig!.signer_name, lang: sig!.lang, answers: sig!.answers, at: sig!.signed_at },
    { traveler_id: "t1", cabin_id: "c1", group_id: "g1", role: "traveler", name: "Jane Public", lang: "en", answers: { _agreed: true }, at: "2026-10-16T15:30:12.000Z" },
  );
  assert.equal(sig!.doc_version, "01-terms-and-conditions@2026-10-03");
  assert.match(sig!.content_sha256, /^[0-9a-f]{64}$/);
  assert.equal(sig!.ip_hash, hashForAudit("203.0.113.9"));
  assert.ok(sig!.ip_hash && sig!.ua_hash, "the hashes are still kept");
  // Mark 2026-10-25 (DocuSign-grade evidence): the address and browser are also kept in clear, for the evidence page
  assert.equal(sig!.ip, "203.0.113.9"); assert.equal(sig!.ua, "Mozilla/5.0 test");
  assert.equal(sig!.pdf_path, `signatures/g1/${sig!.id}.pdf`);
  assert.deepEqual(t.state.uploads.map((u) => u.path), [`signatures/g1/${sig!.id}.pdf`]);
  assert.equal(t.pdfs.length, 1);
  assert.equal(t.pdfs[0]!.businessName, "Still Afloat LLC dba Still Afloat Cruising");
  assert.equal(t.pdfs[0]!.signerName, "Jane Public");
  assert.equal(t.pdfs[0]!.contentSha256, sig!.content_sha256);
  const again = r.json["packet"] as ReturnType<typeof pkt>;
  assert.equal(again.docs.find((d) => d.key === "01-terms-and-conditions")!.status, "signed");
  assert.equal(r.json["complete"], false);
  assert.equal(t.state.travelers[0]!.form_submitted_at, undefined);
});

test("a signature is refused without agreement, a full name, a matching hash, a real document, and only once", async () => {
  const t = setup();
  const token = t.link("t1");
  const doc = pkt(await getPacket(t.deps, token)).docs.find((d) => d.key === "01-terms-and-conditions")!;
  const base = { doc_key: "01-terms-and-conditions", signer_name: NAME, agreed: true, content_sha256: doc.text_sha256, ...BOOK };
  const meta = { ip: "1.2.3.4" };
  await giveConsent(t.deps, token, { agreed: true }, meta);
  assert.equal((await signDocument(t.deps, token, { ...base, agreed: false }, meta)).status, 400);
  assert.equal((await signDocument(t.deps, token, { ...base, agreed: "true" }, meta)).status, 400);
  for (const bad of ["", "Jane", "J", "123 456", "<b>Jane</b> Public", "Jane\u0000 Public"]) assert.equal((await signDocument(t.deps, token, { ...base, signer_name: bad }, meta)).status, 400, `name ${JSON.stringify(bad)}`);
  assert.equal((await signDocument(t.deps, token, { ...base, content_sha256: "abc" }, meta)).status, 400);
  const stale = await signDocument(t.deps, token, { ...base, content_sha256: "0".repeat(64) }, meta);
  assert.equal(stale.status, 409);
  assert.equal(stale.json["code"], "document-changed");
  assert.equal((await signDocument(t.deps, token, { ...base, doc_key: "06-credit-card-authorization" }, meta)).status, 404, "the card form is in no packet");
  const mateToken = t.link("t2");
  await giveConsent(t.deps, mateToken, { agreed: true }, meta);
  assert.equal((await signDocument(t.deps, mateToken, { ...base, doc_key: "12-cruise-booking-agreement", signer_name: "John Public" }, { ip: "1" })).status, 404, "a traveler who is not the lead has no cabin agreement");
  assert.equal((await signDocument(t.deps, token, { ...base, doc_key: "09-group-travel-contract" }, meta)).status, 404);
  assert.equal((await signDocument(t.deps, issueToken().token, base, meta)).status, 404);
  assert.equal(t.state.signatures.length, 0, "nothing was stored by any refusal");
  for (const ok of ["José Núñez", "Mary-Ann O'Neil", "Wei Chen", "Jane Q. Public"]) {
    const t2 = setup();
    const tok = t2.link("t1");
    await giveConsent(t2.deps, tok, { agreed: true }, meta);
    const d = pkt(await getPacket(t2.deps, tok)).docs.find((x) => x.key === base.doc_key)!;
    assert.equal((await signDocument(t2.deps, tok, { ...base, content_sha256: d.text_sha256, signer_name: ok }, meta)).status, 200, ok);
  }
  assert.equal((await signDocument(t.deps, token, base, meta)).status, 200);
  const second = await signDocument(t.deps, token, base, meta);
  assert.equal(second.status, 409);
  assert.equal(second.json["code"], "already-signed");
  assert.equal(t.state.signatures.length, 1, "one signature per traveler, document and role");
});

test("a file that changed after the page loaded cannot be signed on the old text", async () => {
  const t = setup();
  const token = t.link("t2");
  await giveConsent(t.deps, token, { agreed: true }, META);
  const doc = pkt(await getPacket(t.deps, token)).docs.find((d) => d.key === "16-passport-document-checklist")!;
  t.state.group.sail_date = "2027-03-15";
  const r = await signDocument(t.deps, token, { doc_key: "16-passport-document-checklist", signer_name: "John Public", agreed: true, content_sha256: doc.text_sha256, answers: {} }, {});
  assert.equal(r.status, 409);
  assert.equal(r.json["code"], "document-changed");
  assert.equal(t.state.signatures.length, 0);
});

test("About you files the answers on the traveler, encrypts the passport, and keeps the number out of everything else", async () => {
  const t = setup();
  const token = t.link("t1");
  const r = await signKey(t, token, "15-emergency-contact-form", { answers: GOOD_15 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const tr = t.state.travelers[0]!;
  assert.equal(tr.passport_last4, "5678");
  assert.equal(decryptPii(tr.passport_enc, KEY), "A12345678");
  assert.ok(!tr.passport_enc.includes("A12345678"));
  assert.equal(tr.passport_country, "United States");
  assert.equal(tr.passport_expiry, "2031-02-03");
  assert.equal(tr.phone, "919-555-0100");
  assert.equal(tr.emergency_name, "Sam Public");
  assert.equal(tr.emergency_phone, "919-555-0199");
  assert.equal(tr.gender, "Female");
  assert.equal(tr.form_data.address, "1 Main St");
  assert.equal(tr.form_data.emergency.secondary, undefined, "no second contact is asked");
  const sig = t.state.signatures[0]!;
  assert.equal(sig.answers.passport_number, "ending 5678");
  for (const where of [JSON.stringify(sig), JSON.stringify(t.state.travelers[0]!.form_data), JSON.stringify(r.json), JSON.stringify(t.pdfs.map((p) => blocksToText(p.blocks)))]) {
    assert.ok(!where.includes("A12345678"), "the passport number appears in plaintext somewhere it must not");
  }
  assert.ok(/Passport Number:\*{0,2} ending 5678/i.test(blocksToText(t.pdfs[0]!.blocks)), "the signed copy shows the last four only");
  assert.ok(blocksToText(t.pdfs[0]!.blocks).includes("Home Address: 1 Main St"), "the signed copy carries the answers");
  // the next document now shows the address the traveler gave, so its hash moved: the page reloads on the response
  const next = (r.json["packet"] as ReturnType<typeof pkt>).docs.find((d) => d.key === "12-cruise-booking-agreement")!; // the lead's booking agreement shows the address
  assert.ok(next.html.includes("1 Main St"));
});

test("the page reloads between documents: a stale hash for a document that now shows the new address is refused", async () => {
  const t = setup();
  const token = t.link("t1");
  const before = pkt(await getPacket(t.deps, token)).docs.find((d) => d.key === "12-cruise-booking-agreement")!.text_sha256;
  assert.equal((await signKey(t, token, "15-emergency-contact-form", { answers: GOOD_15 })).status, 200);
  const stale = await signDocument(t.deps, token, { doc_key: "12-cruise-booking-agreement", signer_name: NAME, agreed: true, content_sha256: before, answers: {} }, {});
  assert.equal(stale.status, 409);
  assert.equal((await signKey(t, token, "12-cruise-booking-agreement", { answers: {} })).status, 200);
});

test("bad answers are refused field by field and nothing is stored", async () => {
  const t = setup();
  const token = t.link("t1");
  const r = await signKey(t, token, "15-emergency-contact-form", { answers: { ...GOOD_15, dob: "2999-01-01", email: "nope", passport_expiry: "2001-01-01", notes: "card 4111 1111 1111 1111" } });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.json["fields"] as object).sort(), ["dob", "email", "notes", "passport_expiry"]);
  assert.equal(t.state.signatures.length, 0);
  assert.equal(t.state.travelers[0]!.dob, "1960-05-04");
  assert.equal(t.state.travelers[0]!.passport_enc, undefined);
});

test("no GROUP_PII_KEY: the passport step is refused with a plain message and nothing is saved; leaving it empty still works", async () => {
  const t = setup({ piiKey: undefined });
  const token = t.link("t1");
  assert.equal(pkt(await getPacket(t.deps, token)).pii_ready, false);
  const r = await signKey(t, token, "15-emergency-contact-form", { answers: GOOD_15 });
  assert.equal(r.status, 503);
  assert.equal(r.json["code"], "passport-unavailable");
  assert.match(String(r.json["error"]), /leave that line empty/);
  assert.equal(t.state.signatures.length, 0);
  assert.equal(t.state.travelers[0]!.phone, "555-111-2222", "nothing was written");
  const { passport_number: _n, passport_country: _c, passport_expiry: _e, ...noPassport } = GOOD_15;
  const ok = await signKey(t, token, "15-emergency-contact-form", { answers: noPassport });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(t.state.travelers[0]!.passport_enc, undefined);
  const bad = setup({ piiKey: "not-a-key" });
  assert.equal((await signKey(bad, bad.link("t1"), "15-emergency-contact-form", { answers: GOOD_15 })).status, 503, "a malformed key fails closed too");
});

test("signing the booking document records consent; the last signature completes the packet and tells Mark once", async () => {
  const t = setup();
  const token = t.link("t2");
  const mate = "John Public";
  const order = ["15-emergency-contact-form", "01-terms-and-conditions", "05-liability-waiver", "07-travel-insurance-declination", "16-passport-document-checklist"];
  const answers: Record<string, unknown> = {
    "15-emergency-contact-form": { ...GOOD_15, legal_name: "John Public", email: "john@example.com", passport_number: "B99887766" },
    "05-liability-waiver": { health_ack: true },
    "07-travel-insurance-declination": { insurance_choice: "quote" },
  };
  for (const [i, key] of order.entries()) {
    const r = await signKey(t, token, key, { answers: answers[key] ?? {} }, mate);
    assert.equal(r.status, 200, `${key}: ${JSON.stringify(r.json)}`);
    const tr = t.state.travelers[1]!;
    if (key === "01-terms-and-conditions") {
      assert.equal(tr.consent_name, "John Public");
      assert.equal(tr.consent_signed_at, "2026-10-16T15:30:12.000Z");
      assert.equal(tr.consent_ip_hash, hashForAudit("203.0.113.9"));
    }
    assert.equal(r.json["complete"], i === order.length - 1);
    assert.equal(tr.form_submitted_at ?? null, i === order.length - 1 ? "2026-10-16T15:30:12.000Z" : null);
    assert.equal(t.notices.length, i === order.length - 1 ? 1 : 0);
  }
  assert.equal(t.notices[0]!.title, "Paperwork returned: John Public");
  assert.equal(t.notices[0]!.groupId, "g1");
  assert.equal(t.state.signatures.length, 5);
  assert.equal(t.state.signatures.find((s) => s.doc_key.startsWith("07"))!.answers.insurance_choice, "quote");
  assert.equal(t.state.travelers[1]!.form_data.insurance.choice, "quote");
  assert.equal(((await getPacket(t.deps, token)).json as { complete: boolean }).complete, true);
});

test("the cabin's lead authorizes the card: last four, expiry and the licence, whose number is encrypted and never shown again", async () => {
  const t = setup();
  const token = t.link("t1");
  const card = { card_name: "Jane Public", card_address: "1 Main St", card_city_state_zip: "Raleigh, NC 27601", card_phone: "919-555-0100", card_type: "visa", card_last4: "6666", card_expiry: "03/30", dl_state: "NC", dl_number: "0000554321" };
  const r = await signKey(t, token, "22-card-authorization", { answers: card });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const tr = t.state.travelers[0]!;
  assert.equal(tr.signer_role, undefined);
  assert.equal(t.state.signatures[0]!.signer_role, "lead");
  assert.equal(decryptPii(tr.dl_enc, KEY), "0000554321");
  assert.deepEqual([tr.dl_last4, tr.dl_state], ["4321", "NC"]);
  assert.equal(t.state.signatures[0]!.answers.dl_number, "ending 4321");
  for (const where of [JSON.stringify(t.state.signatures), JSON.stringify(r.json), JSON.stringify(t.pdfs.map((p) => blocksToText(p.blocks)))]) assert.ok(!where.includes("0000554321"), "the licence number appears in plaintext somewhere it must not");
  assert.ok(blocksToText(t.pdfs[0]!.blocks).includes("Driver's licence: NC · ending 4321"), "the signed copy shows the state and the last four only");
  const noKey = setup({ piiKey: undefined });
  const refused = await signKey(noKey, noKey.link("t1"), "22-card-authorization", { answers: card });
  assert.equal(refused.status, 503); assert.equal(refused.json["code"], "license-unavailable");
});

test("the newsletter box records the choice and a prospect, sends no email, and reuses an existing prospect", async () => {
  const t = setup();
  const token = t.link("t1");
  assert.equal((await signKey(t, token, "01-terms-and-conditions", { ...BOOK, newsletter_opt_in: true })).status, 200);
  assert.equal(t.state.travelers[0]!.newsletter_opt_in, true);
  assert.equal(t.state.travelers[0]!.prospect_id, "pr1");
  assert.deepEqual(t.state.prospects.map((p) => ({ e: p.email, f: p.first_name, l: p.last_name, src: p.referral_source, s: p.status })), [{ e: "jane@example.com", f: "Jane", l: "Public", src: "group-paperwork", s: "new" }]);
  assert.match(t.state.prospects[0]!.notes, /American Legion Post 12/);
  assert.equal(t.state.prospects[0]!.destination, "MSC Seascape — American Legion Post 12");
  // an unticked box (or anything but true) writes nothing
  const u = setup();
  assert.equal((await signKey(u, u.link("t1"), "01-terms-and-conditions", { ...BOOK, newsletter_opt_in: "yes" })).status, 200);
  assert.equal(u.state.prospects.length, 0);
  assert.equal(u.state.travelers[0]!.newsletter_opt_in, false);
  // the same email already on the contact list is reused, not duplicated
  const v = setup();
  v.state.prospects.push({ id: "pr0", email: "JANE@example.com" });
  assert.equal((await signKey(v, v.link("t1"), "01-terms-and-conditions", { ...BOOK, newsletter_opt_in: true })).status, 200);
  assert.equal(v.state.prospects.length, 1);
  assert.equal(v.state.travelers[0]!.prospect_id, "pr0");
});

test("a failed save of the traveler's answers removes the signature; a failed PDF copy keeps it and says so", async () => {
  const t = setup();
  const token = t.link("t1");
  await giveConsent(t.deps, token, { agreed: true }, META);
  t.state.failUpdate = true;
  const r = await signKey(t, token, "15-emergency-contact-form", { answers: GOOD_15 });
  assert.equal(r.status, 500);
  assert.match(String(r.json["error"]), /nothing was saved/);
  assert.equal(t.state.signatures.length, 0, "a signature without its data cannot stay");
  assert.equal(t.state.deleted.length, 1);
  assert.equal(t.pdfs.length, 0);
  assert.ok(t.warnings.some((w) => /signature was removed/.test(w)));

  const u = setup();
  u.state.failUpload = true;
  const ok = await signKey(u, u.link("t1"), "01-terms-and-conditions", BOOK);
  assert.equal(ok.status, 200);
  assert.equal(ok.json["pdf_saved"], false);
  assert.equal(u.state.signatures.length, 1, "the signature itself is recorded");
  assert.equal(u.state.signatures[0]!.pdf_path, undefined);
  assert.ok(u.warnings.some((w) => /signed copy could not be saved/.test(w)));
});

test("a signature that loses the race to an identical one stores nothing else", async () => {
  const t = setup();
  const token = t.link("t1");
  t.state.duplicate = true;
  const r = await signKey(t, token, "15-emergency-contact-form", { answers: GOOD_15 });
  assert.equal(r.status, 409);
  assert.equal(t.state.travelers[0]!.phone, "555-111-2222");
  assert.equal(t.pdfs.length, 0);
});

// ── the organizer ─────────────────────────────────────────────────────────────

test("the organizer's link opens the group contract only; signing it is recorded without a traveler and Mark is told to countersign", async () => {
  const t = setup();
  const token = t.orgLink();
  const r = await getPacket(t.deps, token);
  assert.equal(r.status, 200);
  const p = pkt(r);
  assert.equal(p.kind, "organizer");
  assert.deepEqual(p.docs.map((d) => d.key), ["09-group-travel-contract"]);
  assert.equal(p.docs[0]!.fields.find((f) => f.name === "org_phone")!.value, "555-123-4567");
  assert.equal(p.docs[0]!.fields.find((f) => f.name === "accommodation")!.value, "cruise");
  assert.equal(p.docs[0]!.fields.find((f) => f.name === "org_address")!.required, true);
  assert.ok(!JSON.stringify(r.json).includes("organizer_token_hash"));
  const bad = await signKey(t, token, "09-group-travel-contract", { answers: {} }, "Pat Organizer");
  assert.equal(bad.status, 400);
  const ok = await signKey(t, token, "09-group-travel-contract", { answers: { org_address: "5 Elm", org_city_state_zip: "Cary, NC 27511", org_phone: "555-123-4567", org_email: "pat@example.com", group_type: "family" } }, "Pat Organizer");
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const sig = t.state.signatures[0]!;
  assert.equal(sig.signer_role, "organizer");
  assert.equal(sig.traveler_id, null);
  assert.equal(sig.cabin_id, null);
  assert.equal(t.pdfs[0]!.agentCountersignPending, true);
  assert.equal(t.notices.length, 1);
  assert.match(t.notices[0]!.title, /Group contract signed: Pat Organizer/);
  assert.match(t.notices[0]!.body, /countersignature is still to do/);
  assert.equal((await signKey(t, token, "09-group-travel-contract", { answers: {} }, "Pat Organizer")).status, 409);
  // a traveler's own link cannot open the contract
  const tl = t.link("t1");
  assert.equal((await signDocument(t.deps, tl, { doc_key: "09-group-travel-contract", signer_name: NAME, agreed: true, content_sha256: sig.content_sha256 }, {})).status, 404);
});

// ── the dashboard's helpers ───────────────────────────────────────────────────

test("the emailed link is plain and short, carries the business signature, and mail goes only where the box allows", () => {
  const url = formUrl("https://stillafloatcruising.com/", "T".repeat(43));
  assert.equal(url, `https://stillafloatcruising.com/forms.html?t=${"T".repeat(43)}`);
  const m = linkEmail({ firstName: "Jane", groupName: "American Legion Post 12", ship: "MSC Seascape", sailDate: "2027-03-14", url });
  assert.equal(m.subject, "Your travel paperwork for American Legion Post 12");
  assert.ok(m.text.startsWith("Hello Jane,"));
  assert.ok(m.text.includes(url) && m.html.includes(`href="${url}"`));
  assert.ok(m.text.includes("MSC Seascape, sailing March 14, 2027"));
  assert.ok(m.text.includes("Still Afloat LLC dba Still Afloat Cruising") && m.text.includes("mark@stillafloatcruising.com"));
  assert.ok(!/actually/i.test(m.text), "Mark's banned word");
  assert.ok(m.text.length < 900, "short");
  assert.ok(linkEmail({ firstName: "", groupName: "G", ship: null, sailDate: null, url }).text.startsWith("Hello,\n"));
  assert.equal(mailAllowed("jane@real.com", undefined), true);
  assert.equal(mailAllowed("jane@real.com", ""), true);
  assert.equal(mailAllowed("test@stillafloatcruising.com", "@stillafloatcruising.com, mmillham1@gmail.com"), true);
  assert.equal(mailAllowed("MMillham1@gmail.com", "@stillafloatcruising.com, mmillham1@gmail.com"), true);
  assert.equal(mailAllowed("jane@real.com", "@stillafloatcruising.com, mmillham1@gmail.com"), false);
  assert.equal(mailAllowed("jane@stillafloatcruising.com.evil.com", "@stillafloatcruising.com"), false);
});

test("each traveler's progress is the documents asked for against the ones signed, and the organizer's is separate", () => {
  const g = groupRow();
  const cabins = [{ id: "c1" }];
  const travelers = [{ id: "t1", cabin_id: "c1", is_lead: true }, { id: "t2", cabin_id: "c1", is_lead: false }];
  const signatures = [
    { traveler_id: "t2", doc_key: "15-emergency-contact-form", signer_role: "traveler" },
    { traveler_id: "t2", doc_key: "01-terms-and-conditions", signer_role: "traveler" },
    { traveler_id: null, doc_key: "09-group-travel-contract", signer_role: "organizer" },
  ];
  const s = packetStatuses({ group: g, cabins, travelers, signatures });
  assert.equal(s.travelers["t1"]!.required.length, 7);
  assert.equal(s.travelers["t1"]!.signed.length, 0);
  assert.deepEqual(s.travelers["t2"]!.signed, ["15-emergency-contact-form", "01-terms-and-conditions"]);
  assert.equal(s.travelers["t2"]!.complete, false);
  assert.deepEqual(s.organizer, { required: ["09-group-travel-contract"], signed: ["09-group-travel-contract"], complete: true });
  assert.deepEqual(organizerBlanks(g, cabins, travelers, new Date()).sort(), ["Complimentary berth ratio", "Minimum group size", "Per-person estimated cost"]);
});


// ── Mark 2026-10-25: DocuSign-grade evidence ──────────────────────────────────

const ORDER_T2 = ["15-emergency-contact-form", "01-terms-and-conditions", "05-liability-waiver", "07-travel-insurance-declination", "16-passport-document-checklist"];
const ANSWERS_T2: Record<string, unknown> = {
  "15-emergency-contact-form": { ...GOOD_15, legal_name: "John Public", email: "john@example.com", passport_number: "B99887766" },
  "05-liability-waiver": { health_ack: true },
  "07-travel-insurance-declination": { insurance_choice: "quote" },
};
async function signAllT2(t: ReturnType<typeof setup>, token: string) {
  for (const key of ORDER_T2) {
    const r = await signKey(t, token, key, { answers: ANSWERS_T2[key] ?? {} }, "John Public");
    assert.equal(r.status, 200, `${key}: ${JSON.stringify(r.json)}`);
  }
}

test("no signature before the one-time consent to electronic records; the consent is kept once with its time, address, browser and text version", async () => {
  const t = setup();
  const token = t.link("t1");
  const p0 = pkt(await getPacket(t.deps, token)) as any;
  assert.equal(p0.esign.consent_given_at, null);
  assert.equal(p0.esign.version, ESIGN_CONSENT_VERSION);
  assert.equal(p0.esign.text.points.length, 5, "the five things the signer agrees to");
  assert.match(p0.esign.text.points.join(" "), /emailed to you once every document is done; if you'd ever like a paper copy, just ask, at no charge/);
  const doc = p0.docs.find((d: any) => d.key === "01-terms-and-conditions");
  const early = await signDocument(t.deps, token, { doc_key: doc.key, signer_name: NAME, agreed: true, content_sha256: doc.text_sha256, ...BOOK }, META);
  assert.equal(early.status, 400); assert.equal(early.json["code"], "consent-required");
  assert.equal(t.state.signatures.length, 0, "nothing stored before consent");
  assert.equal((await giveConsent(t.deps, token, { agreed: false }, META)).status, 400);
  assert.equal((await giveConsent(t.deps, issueToken().token, { agreed: true }, META)).status, 404);
  const ok = await giveConsent(t.deps, token, { agreed: true }, META);
  assert.equal(ok.status, 200);
  assert.equal((ok.json["packet"] as any).esign.consent_given_at, "2026-10-16T15:30:12.000Z");
  const tr = t.state.travelers[0]!;
  assert.deepEqual([tr.esign_consent_at, tr.esign_consent_ip, tr.esign_consent_ua, tr.esign_consent_version], ["2026-10-16T15:30:12.000Z", "203.0.113.9", "Mozilla/5.0 test", ESIGN_CONSENT_VERSION]);
  t.clock.now = new Date("2026-10-17T09:00:00Z");
  await giveConsent(t.deps, token, { agreed: true }, { ip: "198.51.100.1" });
  assert.equal(t.state.travelers[0]!.esign_consent_at, "2026-10-16T15:30:12.000Z", "a second tick never moves the first consent");
  assert.equal((await signDocument(t.deps, token, { doc_key: doc.key, signer_name: NAME, agreed: true, content_sha256: doc.text_sha256, ...BOOK }, META)).status, 200);
  // the Spanish signer reads it in Spanish
  t.state.travelers[1]!.lang = "es";
  const es = pkt(await getPacket(t.deps, t.link("t2"))) as any;
  assert.match(es.esign.text.title, /firmar en línea/);
});

test("opening the link is recorded (first and latest) and the evidence page gets the email, link, opening, consent, address, browser and seal", async () => {
  const t = setup();
  t.state.travelers[0]!.form_sent_at = "2026-10-15T12:00:00.000Z";
  const token = t.link("t1");
  await getPacket(t.deps, token);
  assert.equal(t.state.travelers[0]!.form_opened_at, "2026-10-16T15:30:12.000Z");
  t.clock.now = new Date("2026-10-16T16:00:00Z");
  assert.equal((await signKey(t, token, "01-terms-and-conditions", BOOK)).status, 200);
  assert.equal(t.state.travelers[0]!.form_opened_at, "2026-10-16T15:30:12.000Z", "the first opening stays");
  assert.equal(t.state.travelers[0]!.form_last_opened_at, "2026-10-16T16:00:00.000Z");
  const a = t.pdfs.at(-1)!.audit!;
  assert.deepEqual(a, {
    signerEmail: "jane@example.com", linkSentAt: "2026-10-15T12:00:00.000Z", firstOpenedAt: "2026-10-16T15:30:12.000Z",
    consentAt: "2026-10-16T16:00:00.000Z", consentVersion: ESIGN_CONSENT_VERSION, consentIp: "203.0.113.9",
    ip: "203.0.113.9", ua: "Mozilla/5.0 test", seal: null,
  });
  const sig = t.state.signatures[0]!;
  assert.equal(sig.sealed, false); assert.equal(sig.seal_fingerprint, null);
});

test("with a certificate the copy is sealed and marked so; a seal that fails is saved unsealed, and its evidence page never claims a seal", async () => {
  const sealCalls: Array<{ reason: string }> = [];
  const sealer = { fingerprint: "ab".repeat(32), subject: "Still Afloat Cruising", async seal(pdf: Buffer, meta: { reason: string }) { sealCalls.push(meta); return Buffer.concat([pdf, Buffer.from(" sealed")]); } };
  const t = setup({ seal: sealer });
  const token = t.link("t1");
  assert.equal((await signKey(t, token, "01-terms-and-conditions", BOOK)).status, 200);
  assert.equal(sealCalls.length, 1); assert.match(sealCalls[0]!.reason, /^Signed copy: /);
  assert.deepEqual(t.pdfs.at(-1)!.audit!.seal, { fingerprint: "ab".repeat(32), subject: "Still Afloat Cruising" });
  const sig = t.state.signatures[0]!;
  assert.equal(sig.sealed, true); assert.equal(sig.seal_fingerprint, "ab".repeat(32));
  assert.match(t.state.files[sig.pdf_path]!.toString(), /sealed$/);

  const broken = { ...sealer, async seal() { throw new Error("bad key"); } };
  const t2 = setup({ seal: broken });
  const tok2 = t2.link("t1");
  assert.equal((await signKey(t2, tok2, "01-terms-and-conditions", BOOK)).status, 200);
  assert.equal(t2.pdfs.length, 2, "rendered again without the seal");
  assert.equal(t2.pdfs.at(-1)!.audit!.seal, null);
  assert.equal(t2.state.signatures[0]!.sealed, false);
  assert.ok(t2.warnings.some((w) => /could not be sealed/.test(w)));
});

test("the last signature emails the signer their copies once: one link per document, logged, and the links open only that signer's PDFs", async () => {
  const t = setup();
  const token = t.link("t2");
  await signAllT2(t, token);
  assert.equal(t.mails.length, 1, "one email, on the last signature only");
  const m = t.mails[0]!;
  assert.equal(m.to, "john@example.com");
  assert.equal(m.subject, `Your signed paperwork for ${t.state.group.name}`);
  assert.match(m.text, /^Hi John,/);
  assert.match(m.text, /Smart-cruiser tip/); assert.match(m.text, /See you on board!/);
  const links = [...m.text.matchAll(/https:\/\/stillafloatcruising\.com\/api\/forms\/copies\/([A-Za-z0-9_-]{43})\/(sig\d+)\.pdf/g)];
  assert.equal(links.length, ORDER_T2.length, "one link per signed document");
  assert.deepEqual(t.state.messages.map((r) => [r.template, r.status, r.to_email]), [["paperwork-copies", "sent", "john@example.com"]]);
  assert.ok(!JSON.stringify(t.state.messages).includes(links[0]![1]!), "the email log never keeps the link");
  assert.equal(t.state.travelers[1]!.copies_sent_at, "2026-10-16T15:30:12.000Z");
  const copiesToken = links[0]![1]!;
  const list = await getCopies(t.deps, copiesToken);
  assert.equal(list.status, 200);
  assert.equal((list.json["docs"] as unknown[]).length, ORDER_T2.length);
  const one = await getCopyPdf(t.deps, copiesToken, `${links[0]![2]}.pdf`);
  assert.ok("bytes" in one && one.bytes.toString().startsWith("%PDF"));
  // another traveler's signature id under this link: refused, the same answer as a wrong link
  const other = setup(); const otok = other.link("t1"); await signKey(other, otok, "01-terms-and-conditions", BOOK);
  t.state.signatures.push({ ...other.state.signatures[0]!, id: "sigX", traveler_id: "t1" });
  assert.equal(((await getCopyPdf(t.deps, copiesToken, "sigX.pdf")) as { status: number }).status, 404);
  assert.equal((await getCopies(t.deps, issueToken().token)).status, 404);
  assert.equal((await getCopies(t.deps, token)).status, 404, "the signing link is not a copies link");
});

test("a refused copies email is logged as failed and leaves the file saying not sent; the signatures stand", async () => {
  const t = setup({ mail: async () => false });
  await signAllT2(t, t.link("t2"));
  assert.deepEqual(t.state.messages.map((r) => [r.template, r.status]), [["paperwork-copies", "failed"]]);
  assert.equal(t.state.travelers[1]!.copies_sent_at, null);
  assert.equal(t.state.signatures.length, ORDER_T2.length);
});

test("the copies email reads in the signer's language and in Mark's register", () => {
  const en = copiesEmail({ lang: "en", firstName: "Ana", groupName: "Millham F/F 2027", trip: "Millham F/F 2027 — MSC Seashore, sailing May 9, 2027", docs: [{ title: "Liability Waiver", url: "https://x/y.pdf" }], sealed: true });
  assert.match(en.text, /^Hi Ana,\n\nSigned, sealed… and here it is, delivered! Your document for Millham F\/F 2027/);
  assert.match(en.text, /sealed with our certificate/);
  const es = copiesEmail({ lang: "es", firstName: "Ana", groupName: "Millham F/F 2027", trip: "Millham F/F 2027", docs: [{ title: "Exención", url: "https://x/y.pdf" }, { title: "Términos", url: "https://x/z.pdf" }], sealed: false });
  assert.equal(es.subject, "Sus documentos firmados: Millham F/F 2027");
  assert.match(es.text, /^Hola Ana,/); assert.match(es.text, /¡Nos vemos a bordo!/);
  assert.ok(!/certificado|sello digital/.test(es.text), "no seal claimed when the copies are not sealed");
});

test("the paperwork page opens on the group's own photos: up to three, our /assets/ files or https only, the rest left out", () => {
  const journey = { photos: { paperwork: [
    { url: "/assets/images/trips/g/sunset.jpg", alt: "Sunset at sea" },
    { url: "https://example.test/ship.jpg", alt: "The ship" },
    { url: "javascript:alert(1)", alt: "x" },
    { url: "/assets/../secret.jpg" },
  ], cruise: [{ url: "/assets/a.jpg" }] } };
  assert.deepEqual(pagePhotos(journey, "paperwork"), [
    { url: "/assets/images/trips/g/sunset.jpg", alt: "Sunset at sea" }, { url: "https://example.test/ship.jpg", alt: "The ship" },
  ]);
  assert.deepEqual(pagePhotos(journey, "cruise"), [{ url: "/assets/a.jpg", alt: "" }]);
  assert.deepEqual(pagePhotos({}, "paperwork"), []);
  assert.deepEqual(pagePhotos(null, "paperwork"), []);
  assert.deepEqual(pagePhotos({ photos: { paperwork: [{ url: "http://plain.test/a.jpg" }, { url: "https://a.test/x\"onerror=1" }] } }, "paperwork"), []);
});

test("guests see the group's page label, never the file's short name (Mark 2026-10-26: 'Friends and Family 2027', not 'Millham F/F 2027')", async () => {
  const { guestGroupName } = await import("./group-marketing");
  assert.equal(guestGroupName({ name: "Millham F/F 2027", marketing: { page_label: "Friends and Family 2027" } }), "Friends and Family 2027");
  assert.equal(guestGroupName({ name: "Millham F/F 2027", marketing: { page_label: "  " } }), "Millham F/F 2027");
  assert.equal(guestGroupName({ name: "Millham F/F 2027" }), "Millham F/F 2027");
});
