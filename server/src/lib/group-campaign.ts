// group-campaign.ts — the words of a group's email campaign and Facebook campaign, written from
// Mark's interview + the file's facts (never the other way round), validated the same way as the
// group page copy: every number must exist in the group file or in Mark's own answers.
import type { GroupFacts, Lang } from "./group-marketing";
import { HOUSE_BANNED, HOUSE_VOICE_RULES, LEAD_WITH_RULES, QR_PROBLEM, ctaForFacebook, ctaLine, ctaRule, mentionsQr, missingPitchSentences, numbersIn, pitchIsHis, pitchNumberProblems, pitchRules, tooLong, userPrompt, withoutPitch } from "./group-marketing";
import { MARK_PHONE } from "./group-package-spec";

export type Row = Record<string, unknown>;
export interface CampaignEmail { slot: "announcement" | "reminder" | "last_call"; subject: string; preheader: string; body: string }
export interface Campaign {
  emails: CampaignEmail[];
  facebook: { announcement: string; reminder: string; event_title: string; event_description: string; boosted: string };
}
export interface CampaignProblem { field: string; problem: string }

const text = (max: number) => ({ type: "string", maxLength: max });
export const CAMPAIGN_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false,
  properties: {
    emails: {
      type: "array", minItems: 3, maxItems: 3,
      items: { type: "object", additionalProperties: false,
        properties: { slot: { type: "string", enum: ["announcement", "reminder", "last_call"] }, subject: text(80), preheader: text(120), body: text(1800) },
        required: ["slot", "subject", "preheader", "body"] },
    },
    facebook: { type: "object", additionalProperties: false,
      properties: { announcement: text(900), reminder: text(600), event_title: text(70), event_description: text(900), boosted: text(300) },
      required: ["announcement", "reminder", "event_title", "event_description", "boosted"] },
  },
  required: ["emails", "facebook"],
};

export function campaignSystemPrompt(lang: Lang, answers: Record<string, string | boolean> = {}): string {
  const base = lang === "es"
    ? `Escribes, en el registro propio de Mark (Still Afloat Cruising, "Cruise smarter, laugh more": experto conversacional, cálido, entusiasta, honesto, sin presión de venta), una campaña de correo de tres mensajes y una campaña de Facebook que invita a un grupo a un crucero.`
    : `You write, in Mark's own register (Still Afloat Cruising, "Cruise smarter, laugh more": a conversational expert, warm, enthusiastic, honest, never pushy), a three-email campaign and a Facebook campaign inviting a group to a cruise.`;
  return [base,
    "Rules that are never broken:",
    "- The pieces sell the EXPERIENCE (the moments in <lead_with>) and the company. No person is named and nobody speaks in the first person singular; the brand says 'we' or nothing. Never 'join Mark', never 'I'll be sailing'.",
    "- Use ONLY the facts in the group file and the interview answers. Never invent prices, dates, perks or promises; never promise an entitlement.",
    "- Perks are what the fare includes for the guest ('Included for every guest'). Never mention amenity points or what the organizer receives.",
    "- Every piece says that cabin upgrades are available (balcony and up, by request).",
    ctaRule(answers, lang, "in EVERY piece (every email and every Facebook text: the link is the info sheet, tapped on a phone or a computer; no piece carries a QR code, which is printed on the poster only)"),
    "Mark's register (every email and every Facebook text):",
    ...HOUSE_VOICE_RULES,
    ...LEAD_WITH_RULES,
    ...pitchRules("the body of email 1 (the announcement)", "The other emails and the Facebook texts are written in the same register around the same pitch; they may quote its sentences but do not have to.", lang),
    "- Layout of email 1: the 'Imagine…' sentence and its payoff as the opening (built from <lead_with>: the headline activity first, the event and the sunset-to-sunrise arc named in it), then Mark's pitch verbatim, then the facts (the ship, the sailing, the ports, what the fare includes, the from-price and deposit, the reserve-by date), the upgrades line, the occasion line exactly as he wrote it (when he gave one), then the call to action, then the phone.",
    "- The three emails: announcement (the invitation), reminder (a few weeks before the reserve-by date; what is still open), last call (the final days before the reserve-by date). Emails 2 and 3 keep his register too: full flowing sentences, never fragments; their reminders stay fact-based (what is still open, the price, the deposit, the reserve-by date), with no urgency words and nothing new about the experience.",
    "- Facebook: the announcement is the 'Imagine…' sentence and its payoff, then the facts, then the call to action; the reminder is shorter, one flowing sentence and the facts, then the call to action; the event title is a short line (70 characters at most) that names the headline activity as an event; the event description is the sentence, its payoff and the facts; the boosted-post text (300 characters at most) is the sentence trimmed to the moments that fit, its payoff and the call to action.",
    `- No emojis. Exclamation marks and the capitalised payoff are part of the register. No urgency words, no promises. Never 'cheaper' (say 'less expensive'), never 'actually'. Plain text; the rising sentence stays ONE sentence, the paragraphs around it short. Emails end with 'Still Afloat Cruising' on its own line.${pitchIsHis(lang)}`,
  ].join("\n");
}

export function campaignUserPrompt(facts: GroupFacts, answers: Record<string, string | boolean>, pageUrl: string): string {
  return `${userPrompt(facts, answers, "")}\n\nInfo-sheet link (the call to action: the reader taps it; only the printed poster carries a QR code to this page): ${pageUrl}\nPhone (second contact): ${MARK_PHONE}\n\nWrite the campaign now, in Mark's register: email 1 and the Facebook announcement open with ONE rising sentence through the <lead_with> moments in that order and its capitalised payoff, and never a chain of two-word sentences.`;
}

const BANNED: Record<Lang, RegExp[]> = { en: [/\bactually\b/i, /\bguarantee[ds]?\b/i, /\bfree\b(?! berths)/i], es: [/\bgarantiza/i] };   // exclamation marks are Mark's register (2026-10-19): not banned

/** Every number in the campaign must come from the file, Mark's answers, the phone or the link. */
export function validateCampaign(c: unknown, facts: GroupFacts, answers: Record<string, string | boolean>, pageUrl: string): CampaignProblem[] {
  const problems: CampaignProblem[] = [];
  const x = (c && typeof c === "object" ? c : {}) as Row;
  const pitch = typeof answers["pitch"] === "string" ? answers["pitch"].trim() : "";
  const allowed = new Set([...facts.allowedNumbers, ...numbersIn(Object.values(answers).filter((v) => typeof v === "string").join(" ")), ...numbersIn(MARK_PHONE), ...numbersIn(pageUrl)]);
  const check = (field: string, v: unknown, max: number) => {
    if (typeof v !== "string" || !v.trim()) { problems.push({ field, problem: "missing" }); return; }
    if (v.length > max) problems.push({ field, problem: tooLong(v.length, max) });
    // The bans are for our words: Mark's pitch sentences (his "!" and his word choices) are taken out first.
    const ours = withoutPitch(pitch, v);
    for (const re of BANNED[facts.lang]) { const m = ours.match(re); if (m) problems.push({ field, problem: `uses "${m[0]}"` }); }
    for (const h of HOUSE_BANNED[facts.lang]) if (h.re.test(ours)) problems.push({ field, problem: h.problem });
    if (mentionsQr(v, answers, facts.lang)) problems.push({ field, problem: QR_PROBLEM });
    for (const n of numbersIn(v)) if (!allowed.has(n)) problems.push({ field, problem: `states a number that is not in the group file: ${n}` });
    if (/[<>]/.test(v)) problems.push({ field, problem: "contains markup" });
  };
  const emails = Array.isArray(x["emails"]) ? (x["emails"] as Row[]) : [];
  if (emails.length !== 3) problems.push({ field: "emails", problem: `expected 3 emails, got ${emails.length}` });
  emails.forEach((e, i) => { check(`emails[${i}].subject`, e["subject"], 80); check(`emails[${i}].preheader`, e["preheader"], 120); check(`emails[${i}].body`, e["body"], 1800); });
  // Built around Mark's pitch: every sentence of it is in the announcement email, word for word. Mark writes in
  // English, so only an English campaign can be matched by sentence; a Spanish one carries a translation.
  if (pitch) {
    if (facts.lang === "en") {
      const at = Math.max(0, emails.findIndex((e) => e["slot"] === "announcement"));
      const first = typeof emails[at]?.["body"] === "string" ? (emails[at]!["body"] as string) : "";
      for (const sent of missingPitchSentences(pitch, first)) problems.push({ field: `emails[${at}].body`, problem: `Pitch sentence not kept: '${sent}'` });
    }
    problems.push(...pitchNumberProblems(answers, facts, [...numbersIn(MARK_PHONE), ...numbersIn(pageUrl)]));
  }
  const fb = (x["facebook"] && typeof x["facebook"] === "object" ? x["facebook"] : {}) as Row;
  check("facebook.announcement", fb["announcement"], 900); check("facebook.reminder", fb["reminder"], 600);
  check("facebook.event_title", fb["event_title"], 70); check("facebook.event_description", fb["event_description"], 900); check("facebook.boosted", fb["boosted"], 300);
  return problems;
}

export function tidyCampaign(raw: unknown): Campaign {
  const x = (raw && typeof raw === "object" ? raw : {}) as Row;
  const s = (v: unknown) => (typeof v === "string" ? v.trim().replace(/[ \t]+\n/g, "\n") : "");
  const slots: CampaignEmail["slot"][] = ["announcement", "reminder", "last_call"];
  const emails = (Array.isArray(x["emails"]) ? (x["emails"] as Row[]) : []).slice(0, 3).map((e, i) => ({
    slot: slots.includes(e["slot"] as CampaignEmail["slot"]) ? (e["slot"] as CampaignEmail["slot"]) : slots[i]!,
    subject: s(e["subject"]), preheader: s(e["preheader"]), body: s(e["body"]),
  }));
  const fb = (x["facebook"] && typeof x["facebook"] === "object" ? x["facebook"] : {}) as Row;
  return { emails, facebook: { announcement: s(fb["announcement"]), reminder: s(fb["reminder"]), event_title: s(fb["event_title"]), event_description: s(fb["event_description"]), boosted: s(fb["boosted"]) } };
}

// ── The email as it is sent or previewed ──────────────────────────────────────

export interface CampaignEmailOut { slot: CampaignEmail["slot"]; subject: string; preheader: string; html: string; text: string }

const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const bare = (t: string) => t.trim().replace(/[\s!.:¡]+$/u, "").replace(/^[¡\s]+/u, "").toLowerCase();

/**
 * The words of one campaign email as an HTML email (headline-first body, then the button, then the plain link, the phone and the signature).
 * There is NO QR code in it: the reader is already on a phone or a computer, so the call to action is a button to tap, with the plain link under
 * it for a reader whose mail app hides buttons (Mark 2026-10-19). The button carries the group's call to action (his own `cta_line`, else
 * "Tap here to book your spot!" / "¡Toque aquí para reservar su lugar!"); where the writer already put that line and the link in the body they are
 * lifted out of it, so neither is said twice. Text-only mail clients get the same email as `text`.
 */
export function renderCampaignEmail(email: CampaignEmail, o: { url: string; lang: Lang; answers?: Record<string, string | boolean>; phone?: string }): CampaignEmailOut {
  const es = o.lang === "es";
  const cta = ctaLine(o.answers ?? {}, o.lang, "digital").text;
  const phone = o.phone ?? MARK_PHONE;
  const urlBare = o.url.replace(/^https?:\/\//, "");
  const isUrl = (l: string) => l.replace(/^https?:\/\//, "").replace(/[\s.]+$/, "") === urlBare;
  const isSignoff = (l: string) => bare(l) === "still afloat cruising";
  const ctaBare = bare(cta);
  const kept: string[] = [];
  let ctaAt = -1;                                                         // where the writer put the call to action, so the button takes its place
  for (const raw of email.body.split(/\r?\n/)) {
    let l = raw.split(o.url).join("").trimEnd();
    if (raw.trim() && !l.trim()) continue;                                // a line that was only the link: it is drawn below
    if (isUrl(l.trim()) || isSignoff(l)) continue;                        // the link without its scheme, and the signature, likewise
    if (ctaBare && bare(l).endsWith(ctaBare)) {
      const at = l.toLowerCase().lastIndexOf(ctaBare);
      l = at > 0 ? l.slice(0, at).replace(/[¡\s]+$/u, "") : "";
      if (ctaAt < 0) ctaAt = kept.length;
      if (!l) continue;
    }
    kept.push(l);
  }
  const flow = (arr: string[]) => arr.join("\n").split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const cutAt = ctaAt < 0 ? kept.length : ctaAt;
  const before = flow(kept.slice(0, cutAt)), after = flow(kept.slice(cutAt));
  const digits = (t: string) => t.replace(/\D/g, "");
  const hasPhone = [...before, ...after].some((t) => digits(t).includes(digits(phone)));
  const phoneLine = hasPhone ? [] : [`${es ? "¿Prefiere llamar o escribir? Llame o envíe un mensaje al" : "Prefer to call or text? Reach us at"} ${phone}.`];
  const p = (t: string) => `<p style="margin:0 0 14px">${escHtml(t).replace(/\n/g, "<br>")}</p>`;
  const NAVY = "#07183f", GOLD = "#f5c33b";
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.55;color:${NAVY};max-width:600px;margin:0 auto;padding:8px 4px">` +
    (email.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escHtml(email.preheader)}</div>` : "") +
    before.map(p).join("") +
    `<p style="margin:26px 0 8px"><a data-cta="1" href="${escHtml(o.url)}" style="display:inline-block;background:${GOLD};color:${NAVY};font-weight:bold;font-size:20px;padding:14px 26px;border:2px solid ${NAVY};border-radius:12px;text-decoration:none">${escHtml(cta)}</a></p>` +
    `<p style="margin:0 0 14px;font-size:16px"><a href="${escHtml(o.url)}" style="color:${NAVY}">${escHtml(o.url)}</a></p>` +
    [...after, ...phoneLine].map(p).join("") +
    `<p style="margin:0">Still Afloat Cruising</p></div>`;
  const text = [...before, `${cta}\n${o.url}`, ...after, ...phoneLine, "Still Afloat Cruising"].join("\n\n") + "\n";
  return { slot: email.slot, subject: email.subject, preheader: email.preheader, html, text };
}

/** All three emails, rendered. */
export function renderCampaignEmails(c: Campaign, o: { url: string; lang: Lang; answers?: Record<string, string | boolean>; phone?: string }): CampaignEmailOut[] {
  return c.emails.map((e) => renderCampaignEmail(e, o));
}

/** The Facebook texts as they are posted: the call to action in its Facebook form ("Tap here to book your spot:") and the link under it, where the writer has not already put them. */
export function facebookPostText(text: string, o: { url: string; lang: Lang; answers?: Record<string, string | boolean> }): string {
  const line = ctaForFacebook(o.answers ?? {}, o.lang);
  const t = text.trim();
  return t.includes(o.url) ? t : `${t}\n\n${line}\n${o.url}`;
}
