// cabin-facts-sentence.ts — the never-empty fallback for a cabin card's
// description.
//
// Root cause of Mark's 2026-09-08 report ("no description for these rooms"):
// POST /api/cabins/recommend writes each pick's `reason` live, per search
// (reasonLive() in cabins.ts, a 25s-timeout Haiku call — 4 timeouts logged
// since 9/5). On any failure it falls back to the STORED per-archetype text
// (cabin_advice.recommendations[].reason) — but since 2026-08-18 the
// candidate pool is every room on the hull, not the ~45 the archetypes ever
// wrote about, so a pick can have no stored reason either. Two ships
// (Carnival Adventure, Carnival Encounter) have zero research leads at all;
// on any ship, any individual pick can simply be one the archetype corpus
// never covered. reason=undefined + no live text = a card with nothing on it.
//
// This module is the third rung, under stored text: a PURE, deterministic
// sentence built only from the facts the reveal already carries per pick
// (deck, section, side, view, real_ocean, obstructed/obstruction, above_kind,
// below_kind, noise_nearby/noise_kind, sleeps, category). No model call, so
// it cannot time out, cannot invent a cabin number, and cannot fail — the
// worst case is the honest one-liner at the bottom of this file, never a
// blank card.
//
// Voice: Mark's register (see [[stillafloat-cabin-concierge-build]]) —
// plain, first person is fine, no hype, no brochure words. "less expensive"
// never "cheaper"; never "actually". This module does not attempt the humor
// requirement that live-reasoned copy carries — a deterministic fallback
// that fakes personality is worse than one that is plainly a fallback.

export type Lang = "en" | "es";

/**
 * The subset of a cabin's stored facts this sentence is built from. Deliberately
 * independent of routes/cabins.ts's `CabinRow` (importing the other way would be
 * circular) — any object carrying these fields, including a CabinRow, is
 * structurally assignable here.
 */
export interface CabinFacts {
  deck?: number | string | null;
  section?: string | null;
  side?: string | null;
  view?: string | null;
  real_ocean?: boolean | null;
  obstructed?: boolean | null;
  obstruction?: string | null;
  above_kind?: "cabins" | "open" | "unknown" | null;
  below_kind?: "cabins" | "open" | "unknown" | null;
  noise_nearby?: string | null;
  noise_kind?: "lift" | "stairs" | "venue" | null;
  sleeps?: number | null;
  category?: string | null;
}

const HONEST_NOTHING: Record<Lang, string> = {
  en: "I have this cabin on the plan but not enough detail to describe it — ask me and I'll check.",
  es: "Tengo este camarote en el plano, pero no el detalle suficiente para describirlo — pregúntame y lo reviso.",
};

const SECTION_KEY: Record<string, "forward" | "midship" | "aft"> = {
  forward: "forward", fwd: "forward", bow: "forward",
  mid: "midship", midship: "midship", middle: "midship", center: "midship", centre: "midship",
  aft: "aft", stern: "aft",
};
const SECTION_EN: Record<"forward" | "midship" | "aft", string> = {
  forward: "forward", midship: "midship", aft: "aft",
};
// Standalone ES phrase for the section, already carrying its own preposition
// ("a proa" / "a mitad del barco" / "a popa") — matches how Mark's site already
// speaks these (see ES_SECTION in routes/cabins.ts) but as a full locative
// phrase rather than a bare noun, so it reads naturally next to the side.
const SECTION_ES: Record<"forward" | "midship" | "aft", string> = {
  forward: "a proa", midship: "a mitad del barco", aft: "a popa",
};

const SIDE_KEY: Record<string, "port" | "starboard" | "both" | "center"> = {
  port: "port", starboard: "starboard", both: "both", center: "center", centre: "center",
};
const SIDE_ES: Record<"port" | "starboard" | "both" | "center", string> = {
  port: "babor", starboard: "estribor", both: "ambos lados", center: "el centro",
};

function normKey(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

/** "midship on the starboard side" / "a mitad del barco por estribor" — and every degraded case (side only, section only, neither). */
function sectionSidePhrase(section: string | null | undefined, side: string | null | undefined, lang: Lang): string | null {
  const sectionKey = SECTION_KEY[normKey(section)];
  const sideKey = SIDE_KEY[normKey(side)];

  if (lang === "es") {
    const sectionWord = sectionKey ? SECTION_ES[sectionKey] : null;
    const sideWord = sideKey ? SIDE_ES[sideKey] : null;
    if (sectionWord && sideWord) return `${sectionWord} por ${sideWord}`;
    if (sectionWord) return sectionWord;
    if (sideWord) return `por ${sideWord}`;
    return null;
  }

  const sectionWord = sectionKey ? SECTION_EN[sectionKey] : null;
  const sideWord = sideKey
    ? sideKey === "both" ? "on both sides" : sideKey === "center" ? "in the center" : `on the ${sideKey} side`
    : null;
  if (sectionWord && sideWord) return `${sectionWord} ${sideWord}`;
  if (sectionWord) return sectionWord;
  if (sideWord) return sideWord;
  return null;
}

/** "Deck 8, midship on the starboard side" and every degraded case, including neither present. */
function locationClause(facts: CabinFacts, lang: Lang): string | null {
  const parts: string[] = [];
  const deckNum = facts.deck !== null && facts.deck !== undefined ? Number(facts.deck) : NaN;
  if (Number.isFinite(deckNum)) parts.push(lang === "es" ? `Cubierta ${deckNum}` : `Deck ${deckNum}`);
  const ss = sectionSidePhrase(facts.section, facts.side, lang);
  if (ss) parts.push(ss);
  return parts.length ? parts.join(", ") : null;
}

const VIEW_WORD: Record<string, { en: string; es: string }> = {
  ocean: { en: "a sea view", es: "vista al mar" },
  inward: { en: "a view onto the ship", es: "vista interior del barco" },
  garden: { en: "a garden view", es: "vista al jardín" },
  boardwalk: { en: "a Boardwalk view", es: "vista al Boardwalk" },
  promenade: { en: "a Promenade view", es: "vista al Promenade" },
};

/**
 * What the window tells them, in priority order: no window beats everything
 * (interior); a disclosed obstruction is told before a plain "real ocean"
 * claim, because it is the more actionable fact (same ordering as
 * cabins/check's headline logic); then the real-ocean flag; then whatever the
 * line's own `view` field names; then an explicit "no view" for `view: none`.
 * Returns null only when nothing at all is known.
 */
function viewPhrase(facts: CabinFacts, lang: Lang): string | null {
  const category = normKey(facts.category);
  if (/interior|inside/.test(category)) {
    return lang === "es" ? "sin ventana, ya que es un camarote interior" : "no window, since it's an interior cabin";
  }
  if (facts.obstructed === true) {
    return lang === "es" ? "una vista con algo frente a la ventana" : "a view with something outside the window";
  }
  if (facts.real_ocean === true) {
    return lang === "es" ? "vista abierta al mar" : "an open sea view";
  }
  const viewKey = normKey(facts.view);
  if (viewKey && viewKey !== "none" && VIEW_WORD[viewKey]) {
    return lang === "es" ? VIEW_WORD[viewKey]!.es : VIEW_WORD[viewKey]!.en;
  }
  if (viewKey === "none") {
    return lang === "es" ? "sin vista al exterior" : "no outside view";
  }
  return null;
}

/**
 * What's above and below. A known noisy neighbour (a lift lobby, a stairwell,
 * a venue) is more specific and more useful than the generic cabins/open-deck
 * read, so it wins when present. `noise_nearby`'s raw text is deliberately
 * NOT quoted here — it is freeform English written by a research pass and
 * cannot be trusted to read naturally in Spanish or to clear the banned-word
 * gate, so only the controlled `noise_kind` vocabulary is spoken.
 */
function aboveBelowPhrase(facts: CabinFacts, lang: Lang): string | null {
  if (facts.noise_kind === "lift") {
    return lang === "es" ? "cerca de una zona de ascensores" : "close to a lift lobby";
  }
  if (facts.noise_kind === "stairs") {
    return lang === "es" ? "cerca de una escalera" : "close to a stairwell";
  }
  if (facts.noise_kind === "venue") {
    return lang === "es" ? "cerca de una zona con actividad" : "close to a busy venue";
  }

  const above = facts.above_kind === "cabins" || facts.above_kind === "open" ? facts.above_kind : null;
  const below = facts.below_kind === "cabins" || facts.below_kind === "open" ? facts.below_kind : null;
  if (!above && !below) return null;

  if (above && above === below) {
    if (above === "cabins") return lang === "es" ? "camarotes tranquilos arriba y abajo" : "a quiet cabin above and below";
    return lang === "es" ? "cubierta abierta arriba y abajo" : "open deck above and below";
  }

  const half = (kind: "cabins" | "open" | null, where: "arriba" | "abajo" | "above" | "below"): string | null => {
    if (!kind) return null;
    if (lang === "es") return kind === "cabins" ? `un camarote ${where}` : `cubierta abierta ${where}`;
    return kind === "cabins" ? `a cabin ${where}` : `open deck ${where}`;
  };
  const parts = lang === "es"
    ? [half(above, "arriba"), half(below, "abajo")].filter((p): p is string => Boolean(p))
    : [half(above, "above"), half(below, "below")].filter((p): p is string => Boolean(p));
  if (!parts.length) return null;
  return parts.join(lang === "es" ? " y " : " and ");
}

/** "It's a {category} and sleeps up to {n}." — the line's own product name, never translated (same rule as everywhere else this field is shown). */
function extrasSentence(facts: CabinFacts, lang: Lang): string | null {
  const category = facts.category ? String(facts.category).trim() : "";
  const sleeps = facts.sleeps !== null && facts.sleeps !== undefined && Number.isFinite(Number(facts.sleeps))
    ? Number(facts.sleeps) : null;
  if (category && sleeps) {
    return lang === "es" ? `Es un camarote ${category} y duerme hasta ${sleeps}.` : `It's a ${category} and sleeps up to ${sleeps}.`;
  }
  if (category) {
    return lang === "es" ? `Es un camarote ${category}.` : `It's a ${category}.`;
  }
  if (sleeps) {
    return lang === "es" ? `Duerme hasta ${sleeps}.` : `It sleeps up to ${sleeps}.`;
  }
  return null;
}

/**
 * A pure, deterministic, never-empty description built only from a pick's own
 * stored facts. Degrades gracefully: full facts read as two flowing sentences
 * (location + what's around it, then category/capacity); partial facts still
 * read as one honest sentence; no facts at all returns a plain admission
 * instead of inventing anything.
 */
export function factsSentence(facts: CabinFacts | null | undefined, lang: Lang = "en"): string {
  const f = facts ?? {};
  const location = locationClause(f, lang);
  const qualifiers = [viewPhrase(f, lang), aboveBelowPhrase(f, lang)].filter((p): p is string => Boolean(p));
  const qualifierText = qualifiers.length ? qualifiers.join(lang === "es" ? " y " : " and ") : null;

  let mainSentence: string | null;
  if (location && qualifierText) {
    mainSentence = lang === "es" ? `${location}, con ${qualifierText}.` : `${location}, with ${qualifierText}.`;
  } else if (location) {
    mainSentence = `${location}.`;
  } else if (qualifierText) {
    mainSentence = lang === "es" ? `Este camarote tiene ${qualifierText}.` : `This cabin has ${qualifierText}.`;
  } else {
    mainSentence = null;
  }

  const extras = extrasSentence(f, lang);

  if (mainSentence && extras) return `${mainSentence} ${extras}`;
  if (mainSentence) return mainSentence;
  if (extras) return extras;
  return HONEST_NOTHING[lang];
}
