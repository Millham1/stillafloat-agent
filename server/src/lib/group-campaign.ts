// group-campaign.ts — the words of a group's email campaign and Facebook campaign, written from
// Mark's interview + the file's facts (never the other way round), validated the same way as the
// group page copy: every number must exist in the group file or in Mark's own answers.
import type { GroupFacts, Lang } from "./group-marketing";
import { numbersIn, userPrompt } from "./group-marketing";
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

export function campaignSystemPrompt(lang: Lang): string {
  return lang === "es"
    ? `Escribes, en primera persona como Mark Millham (asesor de cruceros independiente), una campaña de correo de tres mensajes y una campaña de Facebook para invitar a un grupo a un crucero. Usa SOLO los hechos del archivo del grupo y las palabras de Mark. Nunca inventes precios, fechas, beneficios ni promesas. Cada pieza termina con una llamada a la acción clara: llamar o escribir a Mark al ${MARK_PHONE}, o el enlace de la página del grupo. Sin emojis, sin signos de exclamación en cadena, sin mayúsculas sostenidas. Texto plano.`
    : `You write, in the first person as Mark Millham (independent cruise advisor), a three-email campaign and a Facebook campaign inviting a group to a cruise. Use ONLY the facts in the group file and Mark's own words. Never invent prices, dates, perks or promises; never promise an entitlement. Each piece ends with one clear call to action: call or text Mark at ${MARK_PHONE}, or the group page link. No emojis, no stacked exclamation marks, no all-caps. Plain text, short paragraphs. The three emails are: announcement (the invitation), reminder (a few weeks before the reserve-by date; what is still open), last call (the final days before the reserve-by date). The Facebook pieces: a post announcing the trip, a shorter reminder post, an event title and description, and a 300-character boosted-post text.`;
}

export function campaignUserPrompt(facts: GroupFacts, answers: Record<string, string | boolean>, pageUrl: string): string {
  return `${userPrompt(facts, answers)}\n\nGroup page link (the call-to-action link): ${pageUrl}\nMark's phone (the call-to-action number): ${MARK_PHONE}\n\nWrite the campaign now.`;
}

const BANNED: Record<Lang, RegExp[]> = { en: [/\bactually\b/i, /\bguarantee[ds]?\b/i, /\bfree\b(?! berths)/i, /!{2,}/], es: [/\bgarantiza/i, /!{2,}/] };

/** Every number in the campaign must come from the file, Mark's answers, the phone or the link. */
export function validateCampaign(c: unknown, facts: GroupFacts, answers: Record<string, string | boolean>, pageUrl: string): CampaignProblem[] {
  const problems: CampaignProblem[] = [];
  const x = (c && typeof c === "object" ? c : {}) as Row;
  const allowed = new Set([...facts.allowedNumbers, ...numbersIn(Object.values(answers).filter((v) => typeof v === "string").join(" ")), ...numbersIn(MARK_PHONE), ...numbersIn(pageUrl)]);
  const check = (field: string, v: unknown, max: number) => {
    if (typeof v !== "string" || !v.trim()) { problems.push({ field, problem: "missing" }); return; }
    if (v.length > max) problems.push({ field, problem: `too long (${v.length} of ${max} characters)` });
    for (const re of BANNED[facts.lang]) { const m = v.match(re); if (m) problems.push({ field, problem: `uses "${m[0]}"` }); }
    for (const n of numbersIn(v)) if (!allowed.has(n)) problems.push({ field, problem: `states a number that is not in the group file: ${n}` });
    if (/[<>]/.test(v)) problems.push({ field, problem: "contains markup" });
  };
  const emails = Array.isArray(x["emails"]) ? (x["emails"] as Row[]) : [];
  if (emails.length !== 3) problems.push({ field: "emails", problem: `expected 3 emails, got ${emails.length}` });
  emails.forEach((e, i) => { check(`emails[${i}].subject`, e["subject"], 80); check(`emails[${i}].preheader`, e["preheader"], 120); check(`emails[${i}].body`, e["body"], 1800); });
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
