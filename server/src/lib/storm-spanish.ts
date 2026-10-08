// storm-spanish.ts — the Spanish twin of every storm text (release gate 2026-10-08).
//
// Mark works in English only; whatever he approves in English must reach the Spanish site and
// Spanish subscribers in Spanish ([[mark-en-approval-implies-es-translation]]). Until 2026-10-08
// storm emails and /es/storm-watch.html showed English to everyone — 8 of 11 alert subscribers
// had chosen Spanish. The English columns stay the source of truth Mark reviews; each has a
// Spanish column the agent fills:
//   • model-written text (the scan's draft, Mark's edits)  → a faithful translation (storm.translate),
//     never a re-draft: same facts, same hedges, same "nothing to do right now";
//   • template text (declared-by-hand alerts, the all-clear) → a Spanish template, no model call.
// A translation that fails leaves the Spanish column null and the pages/emails fall back to English
// (visible, and the release gate's flows.storm-spanish-reader names it) — never a half-translated mix.

import { anthropicConfigured, llmJson } from "./llm";
import { logger } from "./logger";
import { labelGrounds } from "./storm-grounds";

export interface StormTextEn { headline: string; body_md: string }
export interface StormTextEs { headline_es: string; body_md_es: string }

const TRANSLATE_PROMPT = `You translate short cruise-weather alerts from English into Latin American Spanish (es-419) for
"Still Afloat", a cruise-travel brand. The English text was written from checked facts and reviewed by a person.
Translate it faithfully: the same facts, the same distances, directions and names, the same hedges and the same
tone (a calm, experienced friend). Do not add, drop, soften or sharpen anything. Do not forecast. Keep the markdown
(**bold**, paragraphs) exactly as structured. Translate the bolded lead-in "What this means for you" as
"Qué significa esto para usted". Keep storm names, ship names, port names and cruise-line names unchanged.
Use "usted". Return JSON: {"headline_es": string, "body_md_es": string}; headline_es stays under 90 characters.`;

const TRANSLATE_SCHEMA = {
  type: "object",
  properties: {
    headline_es: { type: "string", description: "the headline in Spanish, under 90 characters" },
    body_md_es: { type: "string", description: "the body in Spanish, same markdown structure" },
  },
  required: ["headline_es", "body_md_es"],
} as const;

/** Rough sanity: Spanish words/accents present, English lead-in gone, length in proportion. */
export function looksLikeSpanishTwin(en: StormTextEn, es: Partial<StormTextEs> | null | undefined): es is StormTextEs {
  if (!es || typeof es.headline_es !== "string" || typeof es.body_md_es !== "string") return false;
  const h = es.headline_es.trim(); const b = es.body_md_es.trim();
  if (!h || !b) return false;
  if (b.length < en.body_md.trim().length * 0.5 || b.length > en.body_md.trim().length * 2.2) return false;
  if (/what this means for you/i.test(b)) return false;
  if (!/[áéíóúñ¿¡]|\b(el|la|los|las|que|para|con|una?|del)\b/i.test(b)) return false;
  return true;
}

/**
 * The Spanish twin of model-written alert text, or null when there is no AI key or the
 * translation does not pass the sanity read. Never throws: a failed translation is logged
 * and the caller stores null (English shows, and the gate says so).
 */
export async function translateStormText(en: StormTextEn, ctx: { nhcId?: string } = {}): Promise<StormTextEs | null> {
  const headline = en.headline.trim(); const body_md = en.body_md.trim();
  if (!headline || !body_md) return null;
  if (!anthropicConfigured()) return null;
  try {
    const parsed = await llmJson<Partial<StormTextEs>>({
      job: "storm.translate",
      cheap: true,
      system: TRANSLATE_PROMPT,
      user: `Headline:\n${headline}\n\nBody (markdown):\n${body_md}`,
      schema: TRANSLATE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 1800,
      timeoutMs: 60_000,
    });
    if (!looksLikeSpanishTwin({ headline, body_md }, parsed)) {
      logger.warn({ nhcId: ctx.nhcId, got: String(parsed?.headline_es ?? "").slice(0, 80) }, "storm-spanish: translation failed its sanity read — Spanish left empty");
      return null;
    }
    return { headline_es: parsed.headline_es.trim().slice(0, 120), body_md_es: parsed.body_md_es.trim() };
  } catch (err) {
    logger.warn({ err, nhcId: ctx.nhcId }, "storm-spanish: translation call failed — Spanish left empty");
    return null;
  }
}

/** Spanish twin of the no-AI / declared-by-hand alert template (routes/storm.ts declare, storm-agent fallback). */
export function declaredAlertEs(a: { name: string; classification: string; grounds: string[]; windowStart?: string; windowEnd?: string; note?: string; declared?: boolean }): StormTextEs {
  const grounds = labelGrounds(a.grounds) || "las zonas de crucero afectadas";
  const when = a.windowStart && a.windowEnd ? ` entre el ${a.windowStart} y el ${a.windowEnd}` : " en los próximos días";
  return {
    headline_es: `${a.name}: vigilando ${grounds}`.slice(0, 120),
    body_md_es:
      `**${a.name}** (${a.classification}) — ${a.declared ? "declarado en el panel de Still Afloat" : "bajo seguimiento"}.\n\n` +
      `**Qué significa esto para usted:** si navega por ${grounds}${when}, los itinerarios podrían ajustarse o desviarse ` +
      `a criterio de la línea de cruceros. No hay nada que hacer por ahora — le mantendremos informado.` +
      (a.note ? `\n\n${a.note}` : ""),
  };
}

/** Spanish twin of the deterministic all-clear (storm-lifecycle.draftAllClear). */
export function allClearEs(a: { name: string | null; classification: string | null; affected_grounds: string[] }): { all_clear_headline_es: string; all_clear_body_md_es: string } {
  const name = a.name || "La tormenta";
  const grounds = labelGrounds(a.affected_grounds) || "las zonas de crucero afectadas";
  return {
    all_clear_headline_es: `Todo despejado: ${name} ya no es una amenaza`.slice(0, 120),
    all_clear_body_md_es:
      `**${name}** (${a.classification ?? "sistema tropical"}) se ha disipado y los meteorólogos de la NOAA ya no le dan seguimiento.\n\n` +
      `**Qué significa esto para usted:** la amenaza para ${grounds} ha pasado. Los itinerarios que se ajustaron deberían volver a la normalidad — ` +
      `su línea de cruceros tiene la última palabra sobre cualquier cambio pendiente, así que revise su app para su salida en particular.\n\n` +
      `Gracias por capear el temporal con nosotros. Vigilamos los trópicos todo el año y, si algo nuevo se forma, se lo haremos saber. Hasta entonces — buen viaje.`,
  };
}

/** The headline/body a reader in `lang` should see: Spanish when both Spanish fields exist, else English. */
export function textFor<T extends { headline: string | null; body_md: string | null; headline_es?: string | null; body_md_es?: string | null }>(
  a: T, lang: "en" | "es",
): { headline: string | null; body_md: string | null; lang: "en" | "es" } {
  if (lang === "es" && a.headline_es && a.body_md_es) return { headline: a.headline_es, body_md: a.body_md_es, lang: "es" };
  return { headline: a.headline, body_md: a.body_md, lang: "en" };
}
