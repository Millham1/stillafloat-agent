// group-forms.ts — the client-paperwork flow, with its I/O injected so every rule is unit-tested
// (routes/group-forms.ts wires it to Supabase, the mailer and the notifier).
//
// A traveler (or the group's organizer) opens a private link, sees the documents their role calls for,
// and signs each one with a typed full name, an explicit "I agree" and a server timestamp.
//
// THE RULES THIS FILE ENFORCES (Mark 2026-10-02/03):
//   * the link is the only credential: a random 43-character token, only its sha256 is stored; an
//     unknown or malformed token gets one neutral 404 whatever the reason;
//   * a signature pins the TEXT the signer saw: the page sends the sha256 it was given, the server
//     re-renders from the file and refuses (409) when it no longer matches;
//   * one signature per traveler, document and role; a second attempt is a 409, never a second row;
//   * passport numbers: entered only here, encrypted (GROUP_PII_KEY, fails closed with a plain
//     message), never stored in the signature's answers and never returned by any API;
//   * ip and user agent are kept only as salted hashes;
//   * the traveler's file changes only after the signature row is saved, and a failed save removes
//     the signature again, so a signature without its data (or data without its signature) cannot stay;
//   * no email goes out from the sign path; the newsletter box only records the choice and a prospect.

import {
  BUSINESS, encryptPii, hashForAudit, hashLinkToken, looksLikeLinkToken, newLinkToken, piiConfigured, safeEqualHex,
} from "./group-secure";
import {
  DOC_SPECS, applyAnswers, blocksFor, buildCtx, fillBlocks, packetFor, prefillValue, publicField, renderDocument,
  type Answers, type DocCtx, type RenderedDoc, type Row,
} from "./group-documents";
import { renderFormPdf } from "./group-form-pdf";
import type { AuditInfo, SignedCopyInput } from "./group-signature-pdf";
import type { Sealer } from "./group-pdf-seal";
import { fmtLong, type Advisory } from "./group-document-kit";
import { QUOTE_NOTE, fetchAllianzQuote, plansFromText, quoteInputFor, type QuoteEnv, type QuoteRecord } from "./allianz-quote";
import { displayName, guestGroupName } from "./group-marketing";
import { pagePhotos } from "./group-page-photos";

export type Reply = { status: number; json: Record<string, unknown> };
const reply = (status: number, json: Record<string, unknown>): Reply => ({ status, json });
const NOT_FOUND = reply(404, { success: false, error: "This link is not valid. Please check that you opened the whole link from your email, or ask for a new one." });

// ── What the flow needs from the outside ──────────────────────────────────────

export interface FormsStore {
  travelerByTokenHash(hash: string): Promise<Row | null>;
  groupByOrganizerHash(hash: string): Promise<Row | null>;
  group(id: string): Promise<Row | null>;
  cabins(groupId: string): Promise<Row[]>;
  travelers(groupId: string): Promise<Row[]>;
  /** The signatures one signer has made: a traveler's own, or the organizer's for the group. */
  signaturesFor(who: { groupId: string; travelerId: string | null }): Promise<Row[]>;
  insertSignature(row: Row): Promise<{ id: string } | "duplicate">;
  deleteSignature(id: string): Promise<void>;
  updateTraveler(id: string, patch: Row): Promise<void>;
  uploadPdf(path: string, bytes: Buffer): Promise<void>;
  downloadPdf(path: string): Promise<Buffer | null>;
  setSignaturePdf(id: string, path: string, meta?: { sealed: boolean; seal_fingerprint: string | null }): Promise<void>;
  /** Find a prospect by email or add one; returns its id (null when the website's contact list refused it). */
  upsertProspect(row: Row): Promise<string | null>;
  // Mark 2026-10-25, signature evidence (migration 0058):
  updateGroup(id: string, patch: Row): Promise<void>;
  /** The email log (group_messages): who, when, which template. Never a link. */
  logMessage(row: Row): Promise<void>;
  travelerByCopiesHash(hash: string): Promise<Row | null>;
  groupByOrganizerCopiesHash(hash: string): Promise<Row | null>;
}

export interface FormsDeps {
  store: FormsStore;
  now: () => Date;
  /** GROUP_PII_KEY; undefined or malformed means no passport number is taken. */
  piiKey: string | undefined;
  renderPdf: (input: SignedCopyInput) => Promise<Buffer>;
  logo: Buffer | null;
  /** Tell Mark a packet is complete (one notification per traveler, on the last signature). */
  notify: (n: { title: string; body: string; groupId: string }) => Promise<void>;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  /** The certificate that seals signed copies (GROUP_SIGN_P12_*); null = none configured, copies are saved unsealed and their evidence page says so. */
  seal: Sealer | null;
  /** Sends the signer their copies; false = the mail sender refused (the box's test-address rule lives in here too). */
  mail: (m: { to: string; subject: string; html: string; text: string }) => Promise<boolean>;
  /** The site the copies links point at (PUBLIC_URL). */
  publicSite: string;
  /** The State Department advisory per port of the itinerary (Mark 2026-10-30); absent = the waiver says they could not be read. */
  advisories?: (group: Row) => Promise<Advisory[]>;
  /** The insurance step: the video, the box's browser and Allianz sign-in for the background quote, and Mark's row when it cannot quote. */
  insurance?: InsuranceDeps;
}

export interface InsuranceDeps extends QuoteEnv {
  /** GROUP_INSURANCE_VIDEO_URL: the video the client watches before choosing; null = no video yet. */
  videoUrl: string | null;
  /** "Waiting on you": send this traveler an Allianz quote by hand (made once per traveler). */
  quoteNeeded: (n: { title: string; body: string; groupId: string; travelerId: string }) => Promise<void>;
}

// ── Loading a link ────────────────────────────────────────────────────────────

/** The traveler columns any private page may read. Never passport_enc, dl_enc, form_token_hash, hub_token_hash or consent_ip_hash. */
export const TRAVELER_COLS =
  "id, group_id, cabin_id, is_lead, first_name, middle_name, last_name, dob, gender, citizenship, email, phone, lang, " +
  "passport_last4, passport_country, passport_expiry, dl_last4, dl_state, emergency_name, emergency_phone, special_needs, form_data, " +
  "newsletter_opt_in, prospect_id, form_sent_at, form_submitted_at, consent_name, consent_signed_at, " +
  "esign_consent_at, esign_consent_version, form_opened_at, copies_sent_at";
/** The signer's own row adds the consent's network address, for the evidence page only (never in the shared list above). */
export const SIGNER_COLS = `${TRAVELER_COLS}, esign_consent_ip`;

export interface Loaded {
  kind: "traveler" | "organizer";
  group: Row;
  traveler: Row | null;
  cabin: Row | null;
  mates: Row[];
  ctx: DocCtx;
  packet: string[];
  /** doc_key → the signature row */
  signed: Map<string, Row>;
}

/** Look a link up. null for every kind of failure: malformed, unknown, replaced, or a group that was cancelled. */
export async function loadByToken(deps: Pick<FormsDeps, "store" | "now" | "advisories">, token: unknown): Promise<Loaded | null> {
  if (!looksLikeLinkToken(token)) return null;
  const hash = hashLinkToken(token);
  const { store } = deps;
  const traveler = await store.travelerByTokenHash(hash);
  const now = deps.now();
  if (traveler) {
    const group = await store.group(traveler.group_id);
    if (!group || group.status === "cancelled") return null;
    const [cabins, travelers] = await Promise.all([store.cabins(group.id), store.travelers(group.id)]);
    const advisories = deps.advisories ? await deps.advisories(group).catch(() => [] as Advisory[]) : [];
    const ctx = buildCtx({ business: BUSINESS, group, cabins, travelers, traveler, now, advisories });
    const packet = packetFor({ group, cabin: ctx.cabin, traveler });
    const sigs = await store.signaturesFor({ groupId: group.id, travelerId: traveler.id });
    return { kind: "traveler", group, traveler, cabin: ctx.cabin, mates: ctx.mates, ctx, packet, signed: new Map(sigs.map((s) => [s.doc_key as string, s])) };
  }
  const group = await store.groupByOrganizerHash(hash);
  if (!group || group.status === "cancelled") return null;
  const [cabins, travelers] = await Promise.all([store.cabins(group.id), store.travelers(group.id)]);
  const ctx = buildCtx({ business: BUSINESS, group, cabins, travelers, traveler: null, now });
  const packet = packetFor({ group, organizer: true });
  const sigs = await store.signaturesFor({ groupId: group.id, travelerId: null });
  return { kind: "organizer", group, traveler: null, cabin: null, mates: [], ctx, packet, signed: new Map(sigs.map((s) => [s.doc_key as string, s])) };
}

const personName = (t: Row | null) => [t?.first_name, t?.middle_name, t?.last_name].filter(Boolean).join(" ");

/** What the page may see: the safe columns of the signer, the group's headline facts, the cabin's other
 * travelers by name, and each document (its page, the hash to send back, its inputs). Never a passport
 * number, a token, an audit hash or another traveler's details. */
export function publicPacket(loaded: Loaded, deps: Pick<FormsDeps, "piiKey" | "insurance">): Record<string, unknown> {
  const { group, traveler, ctx } = loaded;
  const docs = loaded.packet.map((key) => {
    const sig = loaded.signed.get(key);
    const d: RenderedDoc = renderDocument(key, ctx);
    return {
      key, title: d.title, status: sig ? "signed" : "pending",
      signed_at: sig?.signed_at ?? null,
      html: d.html,
      text_sha256: d.sha256,
      fields: sig ? [] : d.fields.map((f) => publicField(f, ctx)),
      agent_countersign_pending: !!DOC_SPECS[key]?.agentCountersign,
    };
  });
  return {
    success: true,
    kind: loaded.kind,
    business: { name: BUSINESS.legalName, trade_name: BUSINESS.tradeName, email: BUSINESS.email, phone: BUSINESS.phone, contact: BUSINESS.contactLine },
    traveler: traveler
      ? { first_name: traveler.first_name ?? null, last_name: traveler.last_name ?? null, is_lead: !!traveler.is_lead, passport_on_file: traveler.passport_last4 ? `ending ${traveler.passport_last4}` : null, newsletter_opt_in: !!traveler.newsletter_opt_in }
      : { first_name: group.organizer_name ?? null, last_name: null, is_lead: false, passport_on_file: null, newsletter_opt_in: false },
    group: {
      name: guestGroupName(group) || null, cruise_line: displayName(group.cruise_line) || null, ship_name: displayName(group.ship_name) || null,
      sail_date_text: fmtLong(group.sail_date) || null, return_date_text: fmtLong(group.return_date) || null,
      nights: group.nights ?? null, embark_port: group.embark_port ?? null,
      photos: pagePhotos(group.journey, "paperwork"),
    },
    cabin: loaded.cabin ? { cabin_num: loaded.cabin.cabin_num ?? null, category: loaded.cabin.category ?? null } : null,
    mates: loaded.mates.map(personName).filter(Boolean),
    docs,
    complete: loaded.packet.length > 0 && loaded.packet.every((k) => loaded.signed.has(k)),
    pii_ready: piiConfigured(deps.piiKey),
    insurance: insurancePublic(loaded, deps),
    // Mark 2026-10-25: consent to electronic records comes first, once per signer; the page shows the box until it is given.
    esign: { consent_given_at: consentOf(loaded), version: ESIGN_CONSENT_VERSION, text: esignConsentText(loaded.ctx.lang) },
    copies_sent_at: (traveler ? traveler.copies_sent_at : group.organizer_copies_sent_at) ?? null,
  };
}

// ── Consent to electronic records (ESIGN consumer consent), once per signer ──

// 2026-10-26: the paper-copy point reworded (Mark: copies are emailed once every document is done; paper on request, still free).
export const ESIGN_CONSENT_VERSION = "2026-10-26";

export interface ConsentText { title: string; intro: string; points: string[]; tick: string; button: string }

/** The disclosure a signer agrees to before the first signature. Plain words; the legal substance is the five points. */
export function esignConsentText(lang: "en" | "es"): ConsentText {
  return lang === "es"
    ? {
        title: "Antes de empezar: firmar en línea",
        intro: "Estos documentos se firman electrónicamente, aquí mismo en esta página. Al marcar la casilla usted acepta que:",
        points: [
          "podemos entregarle estos documentos, y sus copias firmadas, de forma electrónica a la dirección de correo de su expediente;",
          "escribir su nombre en un documento es su firma legal, igual que firmar en papel;",
          "sus copias firmadas se le envían por correo cuando todos los documentos estén listos; si alguna vez desea una copia en papel, solo pídala, sin costo;",
          "puede cambiar de opinión para documentos futuros avisándonos, y firmarlos en papel;",
          "para leer y guardar sus copias necesita un dispositivo con navegador web, una dirección de correo y un lector de PDF.",
        ],
        tick: "Acepto recibir y firmar estos documentos electrónicamente.",
        button: "Continuar a mis documentos",
      }
    : {
        title: "Before you start: signing online",
        intro: "These documents are signed electronically, right here on this page. By ticking the box you agree that:",
        points: [
          "we may give you these documents, and your signed copies, electronically at the email address on your file;",
          "typing your name on a document is your legal signature, the same as signing on paper;",
          "your signed copies are emailed to you once every document is done; if you'd ever like a paper copy, just ask, at no charge;",
          "you can change your mind for future documents by telling us, and sign those on paper instead;",
          "to read and keep your copies you need a device with a web browser, an email address and a PDF reader.",
        ],
        tick: "I agree to receive and sign these documents electronically.",
        button: "Continue to my paperwork",
      };
}

/** When this signer agreed to electronic records, or null. */
export function consentOf(loaded: Loaded): string | null {
  const v = loaded.traveler ? loaded.traveler.esign_consent_at : loaded.group.organizer_esign_consent_at;
  return typeof v === "string" && v ? v : null;
}

export async function giveConsent(deps: FormsDeps, token: unknown, body: { agreed?: unknown }, meta: { ip?: string; ua?: string }): Promise<Reply> {
  const loaded = await loadByToken(deps, token);
  if (!loaded) return NOT_FOUND;
  if (body.agreed !== true) return reply(400, { success: false, error: "Please tick the box to agree to signing electronically, then continue." });
  if (!consentOf(loaded)) {
    const at = deps.now().toISOString();
    const ip = meta.ip?.trim() || null;
    const ua = (meta.ua ?? "").trim().slice(0, 300) || null;
    if (loaded.traveler) await deps.store.updateTraveler(loaded.traveler.id, { esign_consent_at: at, esign_consent_ip: ip, esign_consent_ua: ua, esign_consent_version: ESIGN_CONSENT_VERSION });
    else await deps.store.updateGroup(loaded.group.id, { organizer_esign_consent_at: at, organizer_esign_consent_ip: ip, organizer_esign_consent_ua: ua, organizer_esign_consent_version: ESIGN_CONSENT_VERSION });
  }
  const again = await loadByToken(deps, token);
  return reply(200, { success: true, ...(again ? { packet: publicPacket(again, deps) } : {}) });
}

/** The first and latest opening of the link, for the evidence page. Best effort: a failure here never costs the page. */
async function recordOpen(deps: FormsDeps, loaded: Loaded): Promise<void> {
  const at = deps.now().toISOString();
  try {
    if (loaded.traveler) await deps.store.updateTraveler(loaded.traveler.id, { form_opened_at: loaded.traveler.form_opened_at ?? at, form_last_opened_at: at });
    else await deps.store.updateGroup(loaded.group.id, { organizer_form_opened_at: loaded.group.organizer_form_opened_at ?? at, organizer_form_last_opened_at: at });
  } catch (err) {
    deps.warn({ err: err instanceof Error ? err.message : String(err), group: loaded.group.id }, "paperwork: the link's opening could not be recorded");
  }
}

export async function getPacket(deps: FormsDeps, token: unknown): Promise<Reply> {
  const loaded = await loadByToken(deps, token);
  if (!loaded) return NOT_FOUND;
  await recordOpen(deps, loaded);
  return reply(200, publicPacket(loaded, deps));
}

// ── Signing ───────────────────────────────────────────────────────────────────

export interface SignBody {
  doc_key?: unknown;
  signer_name?: unknown;
  agreed?: unknown;
  content_sha256?: unknown;
  answers?: unknown;
  newsletter_opt_in?: unknown;
}

const CHANGED = reply(409, { success: false, code: "document-changed", error: "This document changed while you had it open. Please reload the page and read it again before signing." });

function deepMerge(base: unknown, patch: Row): Row {
  const out: Row = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Row) } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v as Row) : v;
  }
  return out;
}

const SIGNER_NAME = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]{1,118}[\p{L}\p{M}.]$/u;

export async function signDocument(deps: FormsDeps, token: unknown, body: SignBody, meta: { ip?: string; ua?: string }): Promise<Reply> {
  const loaded = await loadByToken(deps, token);
  if (!loaded) return NOT_FOUND;
  const docKey = typeof body.doc_key === "string" ? body.doc_key : "";
  if (!loaded.packet.includes(docKey)) return reply(404, { success: false, error: "That document is not part of this paperwork." });
  if (loaded.signed.has(docKey)) return reply(409, { success: false, code: "already-signed", error: "This document is already signed. Thank you." });
  // Mark 2026-10-25: no signature before the one-time consent to electronic records (ESIGN consumer consent).
  if (!consentOf(loaded)) return reply(400, { success: false, code: "consent-required", error: "Please agree to signing electronically first: the box at the top of your paperwork." });
  if (body.agreed !== true) return reply(400, { success: false, error: "Please tick the box to say you agree, then sign." });
  const signerName = typeof body.signer_name === "string" ? body.signer_name.replace(/\s+/g, " ").trim() : "";
  if (!SIGNER_NAME.test(signerName) || signerName.split(" ").length < 2) {
    return reply(400, { success: false, error: "Please type your full name (first and last) as your signature." });
  }
  const sha = typeof body.content_sha256 === "string" ? body.content_sha256 : "";
  if (!/^[0-9a-f]{64}$/.test(sha)) return reply(400, { success: false, error: "Please reload the page and try again." });

  const doc = renderDocument(docKey, loaded.ctx);
  if (!safeEqualHex(doc.sha256, sha)) return CHANGED;

  const applied = applyAnswers(doc, body.answers, loaded.ctx);
  if (!applied.ok) return reply(400, { success: false, error: "Please check the answers marked below.", fields: applied.errors });
  // FAIL CLOSED: no key, no passport number — never a plaintext fallback.
  if (applied.passport && !piiConfigured(deps.piiKey)) {
    return reply(503, {
      success: false, code: "passport-unavailable",
      error: "We cannot take a passport number on this page right now. Please leave that line empty and sign; we will collect it another way.",
      fields: { passport_number: "Not available right now. Leave this empty." },
    });
  }
  if (applied.license && !piiConfigured(deps.piiKey)) {
    return reply(503, {
      success: false, code: "license-unavailable",
      error: "We cannot take a driver's licence number on this page right now. Please leave that line empty; we will collect it another way.",
      fields: { dl_number: "Not available right now. Leave this empty." },
    });
  }

  const now = deps.now();
  const spec = DOC_SPECS[docKey]!;
  const traveler = loaded.traveler;
  const ipHash = hashForAudit(meta.ip);
  const stored: Answers = { ...applied.answers, _agreed: true };
  const saved = await deps.store.insertSignature({
    group_id: loaded.group.id,
    cabin_id: traveler?.cabin_id ?? null,
    traveler_id: traveler?.id ?? null,
    doc_key: docKey,
    doc_version: doc.version,
    lang: loaded.ctx.lang,
    signer_role: spec.signerRole,
    signer_name: signerName,
    signed_at: now.toISOString(),
    ip_hash: ipHash,
    ua_hash: hashForAudit(meta.ua),
    // Mark 2026-10-25: in clear as well, as an e-signature service records them; the table is service-key only.
    ip: meta.ip?.trim() || null,
    ua: (meta.ua ?? "").trim().slice(0, 300) || null,
    answers: stored,
    content_sha256: doc.sha256,
  });
  if (saved === "duplicate") return reply(409, { success: false, code: "already-signed", error: "This document is already signed. Thank you." });

  // The traveler's file: only now that the signature is safely saved.
  const signedKeys = new Set([...loaded.signed.keys(), docKey]);
  const complete = loaded.packet.every((k) => signedKeys.has(k));
  let newsletterProspect: string | null = null;
  if (traveler) {
    try {
      const patch: Row = { ...applied.travelerPatch, updated_at: now.toISOString() };
      if (Object.keys(applied.formData).length) patch["form_data"] = deepMerge(traveler.form_data, applied.formData);
      if (applied.passport) patch["passport_enc"] = encryptPii(applied.passport.number, deps.piiKey);
      if (applied.license) patch["dl_enc"] = encryptPii(applied.license.number, deps.piiKey);
      // the terms are on 01 (the Cornerstone set) or inside 21 (Mark 2026-10-29): signing either records the consent to them
      if (docKey === "01-terms-and-conditions" || docKey === "21-your-booking") Object.assign(patch, { consent_name: signerName, consent_signed_at: now.toISOString(), consent_ip_hash: ipHash });
      if (complete) patch["form_submitted_at"] = now.toISOString();
      const email = String(patch["email"] ?? traveler.email ?? "").trim().toLowerCase();
      if (body.newsletter_opt_in === true && !traveler.newsletter_opt_in && email) {
        newsletterProspect = await deps.store.upsertProspect({
          first_name: String(patch["first_name"] ?? traveler.first_name ?? "").trim() || signerName.split(" ")[0],
          last_name: String(patch["last_name"] ?? traveler.last_name ?? "").trim(),
          email, phone: String(patch["phone"] ?? traveler.phone ?? "").trim() || null,
          destination: `${loaded.group.ship_name ?? "Group cruise"} — ${loaded.group.name}`,
          preferred_lang: traveler.lang === "es" ? "es" : "en",
          cruise_line_pref: loaded.group.cruise_line ?? null,
          referral_source: "group-paperwork",
          notes: `Group: ${loaded.group.name}. Ticked the newsletter box on the paperwork form.`,
          status: "new",
        });
        patch["newsletter_opt_in"] = true;
        if (newsletterProspect) patch["prospect_id"] = newsletterProspect;
      }
      await deps.store.updateTraveler(traveler.id, patch);
    } catch (err) {
      await deps.store.deleteSignature(saved.id).catch(() => undefined);
      deps.warn({ err: err instanceof Error ? err.message : String(err), group: loaded.group.id }, "paperwork: saving the traveler's answers failed; the signature was removed");
      return reply(500, { success: false, error: "Something went wrong on our side and nothing was saved. Please try again in a minute." });
    }
  }

  // The signed copy, with its evidence page, sealed when the server has a certificate. A failure here never undoes a
  // valid signature: the hash and answers are stored.
  let pdfSaved = true;
  try {
    const base = {
      businessName: BUSINESS.legalName, title: doc.title, blocks: fillBlocks(doc, stored, now),
      signerName, signerRole: spec.signerRole, signedAt: now, docVersion: doc.version, contentSha256: doc.sha256,
      signatureId: saved.id, agentCountersignPending: !!spec.agentCountersign, logo: deps.logo,
    };
    const audit = auditFor(loaded, { ip: meta.ip, ua: meta.ua, at: now, seal: deps.seal });
    let bytes = await deps.renderPdf({ ...base, audit });
    let sealed = false;
    if (deps.seal) {
      try {
        bytes = await deps.seal.seal(bytes, { reason: `Signed copy: ${doc.title}`, contactInfo: BUSINESS.email, name: BUSINESS.legalName, location: BUSINESS.arbitrationCity }, now);
        sealed = true;
      } catch (err) {
        // The copy must not claim a seal it does not carry: render again saying so.
        deps.warn({ err: err instanceof Error ? err.message : String(err), signature: saved.id }, "paperwork: the signed copy could not be sealed; saved unsealed");
        bytes = await deps.renderPdf({ ...base, audit: { ...audit, seal: null } });
      }
    }
    const path = `signatures/${loaded.group.id}/${saved.id}.pdf`;
    await deps.store.uploadPdf(path, bytes);
    await deps.store.setSignaturePdf(saved.id, path, { sealed, seal_fingerprint: sealed && deps.seal ? deps.seal.fingerprint : null });
  } catch (err) {
    pdfSaved = false;
    deps.warn({ err: err instanceof Error ? err.message : String(err), signature: saved.id }, "paperwork: the signed copy could not be saved (the signature itself is recorded)");
  }

  if (complete) {
    // One notice per signer, on the last signature. The organizer's contract also waits for Mark's countersignature.
    void deps.notify(traveler
      ? { title: `Paperwork returned: ${personName(traveler) || signerName}`, body: `${loaded.group.name} — all ${loaded.packet.length} documents signed.`, groupId: loaded.group.id }
      : { title: `Group contract signed: ${signerName}`, body: `${loaded.group.name} — the organizer signed. Your countersignature is still to do.`, groupId: loaded.group.id },
    ).catch((err: unknown) => deps.warn({ err: err instanceof Error ? err.message : String(err) }, "paperwork: the completion notice failed"));
  }

  // The refreshed packet: the documents after this one may now show what was just entered (and so carry a new hash).
  let again = await loadByToken(deps, token);
  // Mark 2026-10-25: the signer keeps their own copies. One email on the last signature, with a long-lived link per document.
  if (complete && again) {
    try { await sendCopies(deps, again); again = (await loadByToken(deps, token)) ?? again; } catch (err) {
      deps.warn({ err: err instanceof Error ? err.message : String(err), group: loaded.group.id }, "paperwork: the signer's copies email failed (the signatures are recorded)");
    }
  }
  return reply(200, {
    success: true, signed: docKey, complete, pdf_saved: pdfSaved,
    ...(again ? { packet: publicPacket(again, deps) } : {}),
  });
}

/** The evidence page's facts, read from the file at the moment of signing. */
function auditFor(loaded: Loaded, m: { ip?: string; ua?: string; at: Date; seal: Sealer | null }): AuditInfo {
  const t = loaded.traveler; const g = loaded.group;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    signerEmail: str(t ? t.email : g.organizer_email),
    linkSentAt: str(t ? t.form_sent_at : g.organizer_link_sent_at),
    firstOpenedAt: str(t ? t.form_opened_at : g.organizer_form_opened_at) ?? m.at.toISOString(),
    consentAt: consentOf(loaded),
    consentVersion: str(t ? t.esign_consent_version : g.organizer_esign_consent_version),
    consentIp: str(t ? t.esign_consent_ip : g.organizer_esign_consent_ip),
    ip: m.ip?.trim() || null,
    ua: (m.ua ?? "").trim().slice(0, 300) || null,
    seal: m.seal ? { fingerprint: m.seal.fingerprint, subject: m.seal.subject } : null,
  };
}

// ── The signer's own copies (Mark 2026-10-25) ─────────────────────────────────

export function copiesUrl(publicSite: string, token: string, signatureId: string): string {
  return `${publicSite.replace(/\/$/, "")}/api/forms/copies/${token}/${signatureId}.pdf`;
}

/** The email that carries the signer's copies: warm, one tip, the facts. Mark's register (a laugh and a cruise-smart tip in every beat). */
export function copiesEmail(input: { lang: "en" | "es"; firstName: string; groupName: string; trip: string; docs: Array<{ title: string; url: string }>; sealed: boolean }): { subject: string; text: string; html: string } {
  const es = input.lang === "es"; const n = input.docs.length;
  const hello = es ? (input.firstName ? `Hola ${input.firstName},` : "Hola,") : (input.firstName ? `Hi ${input.firstName},` : "Hi,");
  const opening = es
    ? `¡Firmado, sellado… y entregado! ${n === 1 ? "Su documento" : `Los ${n} documentos`} de ${input.trip} ${n === 1 ? "está listo" : "están listos"}. Aquí ${n === 1 ? "tiene su copia" : "tiene sus copias, un PDF por documento"}:`
    : `Signed, sealed… and here it is, delivered! ${n === 1 ? "Your document" : `All ${n} documents`} for ${input.trip} ${n === 1 ? "is" : "are"} done. ${n === 1 ? "Your copy is" : "Your copies are"} below${n === 1 ? "" : ", one PDF each"}:`;
  const tip = es
    ? "Consejo de crucerista: guárdelos en la misma carpeta que la copia de su pasaporte, así todo el viaje vive en un solo lugar."
    : "Smart-cruiser tip: save them in the same folder as your passport scan, so the whole trip lives in one place.";
  const seal = input.sealed
    ? (es ? "Cada PDF lleva nuestro sello digital: cualquier cambio al archivo después de hoy quedaría a la vista. Los enlaces son solo suyos; por favor no los reenvíe."
          : "Each PDF is sealed with our certificate, which means any change to the file after today would show. The links are yours alone, so please don't forward them.")
    : (es ? "Los enlaces son solo suyos; por favor no los reenvíe." : "The links are yours alone, so please don't forward them.");
  const fix = es ? `¿Algo que corregir? Responda a este correo o llame al ${BUSINESS.phone} y lo resolvemos juntos.` : `Spot something that needs fixing? Reply to this email or call ${BUSINESS.phone}, and we'll sort it together.`;
  const bye = es ? "¡Nos vemos a bordo!" : "See you on board!";
  const sign = [BUSINESS.agentName, BUSINESS.tradeName, BUSINESS.contactLine.split(" · ").slice(1).join(" · ")]; // Mark 2026-10-30: the signature reads "Still Afloat Cruising"
  const text = [hello, opening, ...input.docs.map((d) => `${d.title}\n${d.url}`), tip, seal, fix, bye, sign.join("\n")].join("\n\n") + "\n";
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#07183f">`
    + `<p>${esc(hello)}</p><p>${esc(opening)}</p>`
    + `<ul>${input.docs.map((d) => `<li><a href="${esc(d.url)}">${esc(d.title)}</a></li>`).join("")}</ul>`
    + `<p>${esc(tip)}</p><p>${esc(seal)}</p><p>${esc(fix)}</p><p>${esc(bye)}</p><p>${sign.map(esc).join("<br>")}</p></div>`;
  return { subject: es ? `Sus documentos firmados: ${input.groupName}` : `Your signed paperwork for ${input.groupName}`, text, html };
}

/** On the last signature: a long-lived copies link is issued, the email goes to the address on file, and the send is logged. */
async function sendCopies(deps: FormsDeps, loaded: Loaded): Promise<void> {
  const t = loaded.traveler; const g = loaded.group;
  const to = String((t ? t.email : g.organizer_email) ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
    deps.warn({ group: g.id, traveler: t?.id ?? null }, "paperwork: packet complete but no email address on file for the signer's copies");
    return;
  }
  const now = deps.now().toISOString();
  const { token, hash } = issueToken();
  if (t) await deps.store.updateTraveler(t.id, { copies_token_hash: hash, copies_sent_at: now });
  else await deps.store.updateGroup(g.id, { organizer_copies_token_hash: hash, organizer_copies_sent_at: now });
  const docs = loaded.packet.map((key) => ({ key, sig: loaded.signed.get(key) })).filter((d): d is { key: string; sig: Row } => !!d.sig)
    .map((d) => ({ title: renderDocument(d.key, loaded.ctx).title, url: copiesUrl(deps.publicSite, token, String(d.sig.id)) }));
  const when = fmtLong(g.sail_date);
  const trip = [guestGroupName(g), [displayName(g.ship_name), when ? (loaded.ctx.lang === "es" ? `zarpa ${when}` : `sailing ${when}`) : ""].filter(Boolean).join(", ")].filter(Boolean).join(" — ");
  const mail = copiesEmail({ lang: loaded.ctx.lang, firstName: String((t ? t.first_name : g.organizer_name) ?? ""), groupName: guestGroupName(g), trip, docs, sealed: !!deps.seal });
  const ok = await deps.mail({ to, subject: mail.subject, html: mail.html, text: mail.text });
  await deps.store.logMessage({
    group_id: g.id, cabin_id: t?.cabin_id ?? null, traveler_id: t?.id ?? null, audience: "client", template: "paperwork-copies",
    to_email: to, subject: mail.subject, status: ok ? "sent" : "failed", sent_at: ok ? now : null, error: ok ? null : "mail sender refused or was unreachable",
  });
  if (!ok) {
    if (t) await deps.store.updateTraveler(t.id, { copies_sent_at: null });
    else await deps.store.updateGroup(g.id, { organizer_copies_sent_at: null });
  }
}

/** The copies link's owner: a traveler, or the group's organizer. */
async function loadByCopiesToken(deps: FormsDeps, token: unknown): Promise<Loaded | null> {
  if (!looksLikeLinkToken(token)) return null;
  const hash = hashLinkToken(token);
  const t = await deps.store.travelerByCopiesHash(hash);
  const now = deps.now();
  if (t) {
    const group = await deps.store.group(t.group_id);
    if (!group || group.status === "cancelled") return null;
    const [cabins, travelers] = await Promise.all([deps.store.cabins(group.id), deps.store.travelers(group.id)]);
    const ctx = buildCtx({ business: BUSINESS, group, cabins, travelers, traveler: t, now });
    const sigs = await deps.store.signaturesFor({ groupId: group.id, travelerId: t.id });
    return { kind: "traveler", group, traveler: t, cabin: ctx.cabin, mates: ctx.mates, ctx, packet: packetFor({ group, cabin: ctx.cabin, traveler: t }), signed: new Map(sigs.map((s) => [s.doc_key as string, s])) };
  }
  const group = await deps.store.groupByOrganizerCopiesHash(hash);
  if (!group || group.status === "cancelled") return null;
  const [cabins, travelers] = await Promise.all([deps.store.cabins(group.id), deps.store.travelers(group.id)]);
  const ctx = buildCtx({ business: BUSINESS, group, cabins, travelers, traveler: null, now });
  const sigs = await deps.store.signaturesFor({ groupId: group.id, travelerId: null });
  return { kind: "organizer", group, traveler: null, cabin: null, mates: [], ctx, packet: packetFor({ group, organizer: true }), signed: new Map(sigs.map((s) => [s.doc_key as string, s])) };
}

/** GET /api/forms/copies/:token — the signer's signed documents, each with its download link. */
export async function getCopies(deps: FormsDeps, token: unknown): Promise<Reply> {
  const loaded = await loadByCopiesToken(deps, token);
  if (!loaded) return NOT_FOUND;
  const tok = String(token);
  const docs = loaded.packet.map((key) => ({ key, sig: loaded.signed.get(key) })).filter((d): d is { key: string; sig: Row } => !!d.sig)
    .map((d) => ({ id: String(d.sig.id), title: renderDocument(d.key, loaded.ctx).title, signed_at: d.sig.signed_at ?? null, sealed: !!d.sig.sealed, url: copiesUrl(deps.publicSite, tok, String(d.sig.id)) }));
  return reply(200, { success: true, group: { name: guestGroupName(loaded.group) || null }, docs });
}

// ── Mark's own PDF of a document, filled in (Mark 2026-10-27: "show the client the actual populated document") ──

/** What the page sends to be shown: known names only, plain values only, nothing long. Nothing here is kept. */
function previewInput(raw: unknown): Answers {
  const out: Answers = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 1000);
    else if (typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 100));
  }
  return out;
}

/** The clean printed form of one document (lib/group-form-pdf.ts) with these answers, this date and, once typed, this name. */
async function formPdf(deps: FormsDeps, key: string, ctx: DocCtx, answers: Answers, today: string, signer: string): Promise<Uint8Array> {
  const { spec, blocks } = blocksFor(key, ctx, { paper: true });
  return renderFormPdf({ title: spec.title, businessName: BUSINESS.legalName, blocks, answers, today, ...(signer ? { signer } : {}), logo: deps.logo });
}

/** POST /api/forms/:token/preview — one document of this link's packet as its clean printed form, filled in with what the client
 *  has typed so far. The answers to the documents before it are read as they will be on the file once those are signed (the
 *  traveler form's address and birth date fill the waiver's), so the form shows what will be signed. Nothing is saved. */
export async function previewDocument(deps: FormsDeps, token: unknown, body: { doc_key?: unknown; answers?: unknown; signer_name?: unknown }): Promise<{ status: 200; bytes: Uint8Array; key: string } | Reply> {
  const loaded = await loadByToken(deps, token);
  if (!loaded) return NOT_FOUND;
  const key = typeof body.doc_key === "string" ? body.doc_key : "";
  if (!loaded.packet.includes(key)) return reply(404, { success: false, error: "That document is not part of this paperwork." });
  const typed = previewInput(body.answers);
  const now = deps.now();

  let ctx: DocCtx = loaded.ctx;
  for (const earlier of loaded.packet.slice(0, loaded.packet.indexOf(key))) {
    if (loaded.signed.has(earlier) || !ctx.traveler) continue;
    const applied = applyAnswers(renderDocument(earlier, ctx), typed, ctx);
    if (!applied.ok) continue;
    const t = ctx.traveler;
    ctx = { ...ctx, traveler: { ...t, ...applied.travelerPatch, form_data: mergeDeep((t["form_data"] as Row) ?? {}, applied.formData) } };
  }
  const doc = renderDocument(key, ctx);
  const own: Answers = {};
  for (const f of doc.fields) if (typed[f.name] !== undefined) own[f.name] = typed[f.name]!;
  // shown as it will be kept: a passport or licence number never in full
  const applied = applyAnswers(doc, own, ctx);
  const answers: Answers = applied.ok ? applied.answers : { ...own, ...(typeof own["passport_number"] === "string" ? { passport_number: "" } : {}), ...(typeof own["dl_number"] === "string" ? { dl_number: "" } : {}) };
  // the name typed to sign goes on the client's signature line (only a first and last name, as the signing itself asks)
  const name = typeof body.signer_name === "string" ? body.signer_name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const signer = SIGNER_NAME.test(name) && name.split(" ").length >= 2 ? name : "";
  return { status: 200, bytes: await formPdf(deps, key, ctx, answers, fmtLong(now.toISOString()), signer), key };
}

/** GET /api/forms/:token/document/:key — one document of this link's packet as its clean printed form: signed, as it was signed
 *  (the answers kept with the signature, the name and the day); not yet signed, with what the file already holds. */
export async function documentPdf(deps: FormsDeps, token: unknown, docKey: unknown): Promise<{ status: 200; bytes: Uint8Array; key: string } | Reply> {
  const loaded = await loadByToken(deps, token);
  if (!loaded) return NOT_FOUND;
  const key = typeof docKey === "string" ? docKey.replace(/\.pdf$/i, "") : "";
  if (!loaded.packet.includes(key)) return reply(404, { success: false, error: "That document is not part of this paperwork." });
  const sig = loaded.signed.get(key);
  if (sig) {
    const answers = (sig["answers"] && typeof sig["answers"] === "object" ? sig["answers"] : {}) as Answers;
    return { status: 200, bytes: await formPdf(deps, key, loaded.ctx, answers, fmtLong(String(sig["signed_at"] ?? "")), String(sig["signer_name"] ?? "")), key };
  }
  const answers: Answers = {};
  for (const f of renderDocument(key, loaded.ctx).fields) {
    const v = prefillValue(f, loaded.ctx);
    if (v !== undefined) answers[f.name] = v;
  }
  return { status: 200, bytes: await formPdf(deps, key, loaded.ctx, answers, fmtLong(deps.now().toISOString()), ""), key };
}

function mergeDeep(a: Row, b: Row): Row {
  const out: Row = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) ? mergeDeep(out[k] as Row, v as Row) : v;
  }
  return out;
}

/** GET /api/forms/copies/:token/:sid.pdf — one signed copy, only when it belongs to this link's owner. */
export async function getCopyPdf(deps: FormsDeps, token: unknown, signatureId: unknown): Promise<{ status: 200; bytes: Buffer; filename: string } | Reply> {
  const loaded = await loadByCopiesToken(deps, token);
  if (!loaded) return NOT_FOUND;
  const sid = typeof signatureId === "string" ? signatureId.replace(/\.pdf$/i, "") : "";
  const sig = [...loaded.signed.values()].find((s) => String(s.id) === sid);
  if (!sig || typeof sig.pdf_path !== "string" || !sig.pdf_path) return NOT_FOUND;
  const bytes = await deps.store.downloadPdf(sig.pdf_path);
  if (!bytes) return reply(503, { success: false, error: "That copy is not available right now. Please try again in a minute." });
  return { status: 200, bytes, filename: `${String(sig.doc_key)}-signed.pdf` };
}

// ── Dashboard side: links ─────────────────────────────────────────────────────

export function formUrl(publicSite: string, token: string): string {
  return `${publicSite.replace(/\/$/, "")}/forms.html?t=${token}`;
}

/** A new token for a traveler. The old link stops working the moment this is stored. */
export function issueToken(): { token: string; hash: string } {
  const token = newLinkToken();
  return { token, hash: hashLinkToken(token) };
}

/** The plain, short email that carries a traveler's link. The business signature is the legal name. */
export function linkEmail(input: { firstName: string; groupName: string; ship: string | null; sailDate: string | null; url: string }): { subject: string; text: string; html: string } {
  const when = fmtLong(input.sailDate);
  const trip = [input.groupName, [displayName(input.ship), when ? `sailing ${when}` : ""].filter(Boolean).join(", ")].filter(Boolean).join(" — ");
  const hello = input.firstName ? `Hello ${input.firstName},` : "Hello,";
  const lines = [
    hello,
    `Please complete your travel paperwork for ${trip} using your private link:`,
    input.url,
    "It takes about ten minutes, and it helps to have your passport handy. The link is only for you, so please do not forward it.",
    `Questions? Reply to this email or call ${BUSINESS.phone}.`,
  ];
  const sign = [BUSINESS.agentName, BUSINESS.tradeName, BUSINESS.contactLine.split(" · ").slice(1).join(" · ")]; // Mark 2026-10-30: the signature reads "Still Afloat Cruising"
  const text = `${lines.join("\n\n")}\n\n${sign.join("\n")}\n`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#07183f">${lines
    .map((l) => (l === input.url ? `<p><a href="${esc(l)}">${esc(l)}</a></p>` : `<p>${esc(l)}</p>`)).join("")}<p>${sign.map(esc).join("<br>")}</p></div>`;
  return { subject: `Your travel paperwork for ${input.groupName}`, text, html };
}

/** The dev box emails only the addresses it is told are test addresses (Mark 2026-10-08). */
export function mailAllowed(to: string, allow: string | undefined): boolean {
  if (!allow || !allow.trim()) return true; // prod: any traveler's own address on the file
  const list = allow.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const addr = to.trim().toLowerCase();
  return list.some((x) => (x.startsWith("@") ? addr.endsWith(x) : addr === x));
}

// ── Dashboard side: who has signed what ───────────────────────────────────────

export interface PacketStatus { required: string[]; signed: string[]; complete: boolean }

/** For each traveler (and the organizer), the documents asked for and the ones signed. */
export function packetStatuses(input: { group: Row; cabins: Row[]; travelers: Row[]; signatures: Row[] }): { travelers: Record<string, PacketStatus>; organizer: PacketStatus } {
  const out: Record<string, PacketStatus> = {};
  for (const t of input.travelers) {
    const cabin = input.cabins.find((c) => c.id === t.cabin_id) ?? null;
    const required = packetFor({ group: input.group, cabin, traveler: t });
    const signed = required.filter((k) => input.signatures.some((s) => s.traveler_id === t.id && s.doc_key === k));
    out[t.id] = { required, signed, complete: required.length > 0 && signed.length === required.length };
  }
  const required = packetFor({ group: input.group, organizer: true });
  const signed = required.filter((k) => input.signatures.some((s) => !s.traveler_id && s.signer_role === "organizer" && s.doc_key === k));
  return { travelers: out, organizer: { required, signed, complete: signed.length === required.length } };
}

/** The blanks in the organizer's contract the file cannot fill (what Mark should know before he sends the link). */
export function organizerBlanks(group: Row, cabins: Row[], travelers: Row[], now: Date): string[] {
  const ctx = buildCtx({ business: BUSINESS, group, cabins, travelers, traveler: null, now });
  return renderDocument("09-group-travel-contract", ctx).unfilled;
}



// ── The insurance step (Mark 2026-10-30): the video, the Allianz quote fetched in the background, the line's own plan ──

const quoteOf = (traveler: Row | null): QuoteRecord | null => {
  const q = traveler?.form_data?.insurance?.quote;
  return q && typeof q === "object" && typeof q.status === "string" ? (q as QuoteRecord) : null;
};

/** What the page sees of the insurance step: never the sign-in, never the reason a quote failed (that is Mark's row). */
export function insurancePublic(loaded: Loaded, deps: Pick<FormsDeps, "insurance">): Record<string, unknown> {
  const q = quoteOf(loaded.traveler);
  // Mark 2026-10-30: "they should be able to select the policy/price here" — the box's own quote for this traveler first; until it
  // has one, the plans Mark quoted for the sailing on the group file, so the client always has prices to pick from on the page.
  const file = plansFromText(loaded.group.insurance_plans);
  const quote = q?.status === "ready"
    ? { status: "ready", source: "portal", plans: q.plans, quoted_at: q.quoted_at, note: QUOTE_NOTE, trip_cost: q.input?.trip_cost ?? null }
    : file.length
      ? { status: "ready", source: "file", plans: file, quoted_at: null, note: QUOTE_NOTE, trip_cost: null }
      : q
        ? { status: q.status, source: null, plans: [], quoted_at: q.quoted_at, note: QUOTE_NOTE, trip_cost: q.input?.trip_cost ?? null }
        : { status: "none", source: null, plans: [], quoted_at: null, note: QUOTE_NOTE, trip_cost: null };
  return {
    video_url: deps.insurance?.videoUrl ?? null,
    line_protection: typeof loaded.group.line_protection === "string" && loaded.group.line_protection.trim() ? loaded.group.line_protection.trim() : null,
    quote,
  };
}

async function saveQuote(deps: Pick<FormsDeps, "store">, traveler: Row, q: QuoteRecord): Promise<void> {
  const fd = traveler.form_data && typeof traveler.form_data === "object" ? traveler.form_data : {};
  const ins = fd.insurance && typeof fd.insurance === "object" ? fd.insurance : {};
  const form_data = { ...fd, insurance: { ...ins, quote: q } };
  traveler.form_data = form_data;
  await deps.store.updateTraveler(traveler.id, { form_data });
}

const TEN_MINUTES = 10 * 60_000;

/** POST …/insurance/quote: start the background quote for this traveler (once; again when the last one failed or stalled). */
export async function requestInsuranceQuote(deps: FormsDeps, token: unknown): Promise<{ status: number; json: Row }> {
  const loaded = await loadByToken(deps, token);
  if (!loaded || !loaded.traveler) return { status: 404, json: { success: false, error: "This link is not valid." } };
  const t = loaded.traveler;
  const now = deps.now();
  const have = quoteOf(t);
  if (have?.status === "ready") return { status: 200, json: { success: true, status: "ready" } };
  if (have?.status === "pending" && now.getTime() - Date.parse(have.requested_at) < TEN_MINUTES) return { status: 200, json: { success: true, status: "pending" } };
  const input = quoteInputFor(loaded);
  const base: QuoteRecord = { status: "pending", requested_at: now.toISOString(), quoted_at: null, plans: [], note: QUOTE_NOTE, reason: null, input: "missing" in input ? null : input, action_at: have?.action_at ?? null };
  if ("missing" in input) {
    await finishQuote(deps, loaded, { ...base, status: "unavailable", reason: `the file is missing: ${input.missing.join(", ")}` });
    return { status: 200, json: { success: true, status: "unavailable" } };
  }
  await saveQuote(deps, t, base);
  // In the background: the client reads on while the portal is driven; the page polls GET …/insurance.
  void fetchAllianzQuote(input, deps.insurance ?? { chromePath: undefined, user: undefined, password: undefined })
    .then((out) => finishQuote(deps, loaded, out.status === "ready"
      ? { ...base, status: "ready", quoted_at: deps.now().toISOString(), plans: out.plans }
      : { ...base, status: "unavailable", reason: out.reason }))
    .catch((err) => deps.warn({ err, traveler: t.id }, "insurance quote: the background job failed"));
  return { status: 202, json: { success: true, status: "pending" } };
}

async function finishQuote(deps: FormsDeps, loaded: Loaded, q: QuoteRecord): Promise<void> {
  const t = loaded.traveler!;
  // no row for Mark when the group file already carries the sailing's plans: the client has prices to pick from
  if (q.status === "unavailable" && !q.action_at && deps.insurance && !plansFromText(loaded.group.insurance_plans).length) {
    const who = personName(t) || "a traveler";
    const i = q.input;
    const facts = i ? `${i.destination}, ${fmtLong(i.depart_date)} to ${fmtLong(i.return_date)}, $${i.trip_cost} per person, home state ${i.state}, birth date${i.birth_dates.length > 1 ? "s" : ""} ${i.birth_dates.map((d) => fmtLong(d)).join(", ")}.` : "";
    await deps.insurance.quoteNeeded({
      title: `Allianz quote to send: ${who}`,
      body: `${guestGroupName(loaded.group)} — the background quote could not run (${q.reason ?? "unknown"}). ${facts} Send the quote by email; the client's paperwork page says it is coming from you.`.trim(),
      groupId: loaded.group.id, travelerId: t.id,
    }).then(() => { q.action_at = deps.now().toISOString(); }).catch((err) => deps.warn({ err }, "insurance quote: could not make Mark's row"));
  }
  await saveQuote(deps, t, q);
}

/** GET …/insurance: where the quote stands, for the page to poll. */
export async function insuranceStatus(deps: FormsDeps, token: unknown): Promise<{ status: number; json: Row }> {
  const loaded = await loadByToken(deps, token);
  if (!loaded || !loaded.traveler) return { status: 404, json: { success: false, error: "This link is not valid." } };
  return { status: 200, json: { success: true, ...insurancePublic(loaded, deps) } };
}
