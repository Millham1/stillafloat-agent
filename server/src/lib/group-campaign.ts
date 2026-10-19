// group-campaign.ts — the words of a group's email campaign and Facebook campaign, written from
// Mark's interview + the file's facts (never the other way round), validated the same way as the
// group page copy: every number must exist in the group file or in Mark's own answers.
import type { GroupFacts, Lang } from "./group-marketing";
import { HOUSE_BANNED, HOUSE_VOICE_RULES, missingPitchSentences, numbersIn, pitchIsHis, pitchNumberProblems, pitchRules, tooLong, userPrompt, withoutPitch } from "./group-marketing";
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
  const base = lang === "es"
    ? `Escribes, en la voz de Still Afloat Cruising ("Cruise smarter, laugh more": experto conversacional, humor seco y contenido, honesto, sin hype), una campaña de correo de tres mensajes y una campaña de Facebook que invita a un grupo a un crucero.`
    : `You write, in the voice of Still Afloat Cruising ("Cruise smarter, laugh more": conversational expert, dry understated humor aimed at situations, honest, never hype), a three-email campaign and a Facebook campaign inviting a group to a cruise.`;
  return [base,
    "Rules that are never broken:",
    "- The pieces sell the EXPERIENCE: the overnight, the beach at night, the short escape, the company. No person is named and nobody speaks in the first person singular; the brand says 'we' or nothing. Never 'join Mark', never 'I'll be sailing'.",
    "- Use ONLY the facts in the group file and the interview answers. Never invent prices, dates, perks or promises; never promise an entitlement.",
    "- Perks are what the fare includes for the guest ('Included for every guest'). Never mention amenity points or what the organizer receives.",
    "- Every piece says that cabin upgrades are available (balcony and up, by request).",
    "- The primary call to action in EVERY piece is the QR code: write 'Scan the QR to join the fun' (every email and every Facebook text carries the QR image beside it), followed by the info-sheet link for people reading on a phone. The phone number is third, for people who would rather call or text.",
    "House voice (every email and every Facebook text):",
    ...HOUSE_VOICE_RULES,
    ...pitchRules("the body of email 1 (the announcement)", "The other emails and the Facebook texts are written in the house voice around the same pitch; they may quote its sentences but do not have to.", lang),
    "- Layout of email 1: the hook as the opening line, the walk-through sentence ending on a dry beat, then Mark's pitch verbatim, then the occasion line with its wink, then what the fare includes, then the call to action.",
    "- The three emails: announcement (the invitation), reminder (a few weeks before the reserve-by date; what is still open), last call (the final days before the reserve-by date). Facebook: an announcement post, a shorter reminder post, an event title and description, and a 300-character boosted-post text.",
    `- No emojis, no exclamation marks, no all-caps, no superlatives, no urgency words in the words we write. Never 'cheaper' (say 'less expensive'), never 'actually'. Plain text, short paragraphs. Emails end with 'Still Afloat Cruising' on its own line.${pitchIsHis(lang)}`,
  ].join("\n");
}

export function campaignUserPrompt(facts: GroupFacts, answers: Record<string, string | boolean>, pageUrl: string): string {
  return `${userPrompt(facts, answers)}\n\nInfo-sheet link (the primary call to action; on print it is a QR code to this page): ${pageUrl}\nPhone (second contact): ${MARK_PHONE}\n\nWrite the campaign now.`;
}

const BANNED: Record<Lang, RegExp[]> = { en: [/\bactually\b/i, /\bguarantee[ds]?\b/i, /\bfree\b(?! berths)/i], es: [/\bgarantiza/i] };   // exclamation marks: HOUSE_BANNED

/** Every number in the campaign must come from the file, Mark's answers, the phone or the link. */
export function validateCampaign(c: unknown, facts: GroupFacts, answers: Record<string, string | boolean>, pageUrl: string): CampaignProblem[] {
  const problems: CampaignProblem[] = [];
  const x = (c && typeof c === "object" ? c : {}) as Row;
  const pitch = typeof answers["pitch"] === "string" ? answers["pitch"].trim() : "";
  const allowed = new Set([...facts.allowedNumbers, ...numbersIn(Object.values(answers).filter((v) => typeof v === "string").join(" ")), ...numbersIn(MARK_PHONE), ...numbersIn(pageUrl)]);
  const check = (field: string, v: unknown, max: number) => {
    if (typeof v !== "string" || !v.trim()) { problems.push({ field, problem: "missing" }); return; }
    if (v.length > max) problems.push({ field, problem: tooLong(v.length, max) });
    // The house-voice bans are for our words: Mark's pitch sentences (his "!" and his word choices) are taken out first.
    const ours = withoutPitch(pitch, v);
    for (const re of BANNED[facts.lang]) { const m = ours.match(re); if (m) problems.push({ field, problem: `uses "${m[0]}"` }); }
    for (const h of HOUSE_BANNED[facts.lang]) if (h.re.test(ours)) problems.push({ field, problem: h.problem });
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
