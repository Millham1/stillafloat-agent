// affiliate-blurb-rules.ts — pure checks for gear-page blurbs written in Mark's name.
// Kept free of I/O so the test suite can import it (affiliate-agent pulls in the logger).

// Mark's bans for anything written in his name. "actually" (2026-08-14, absolute 2026-09-10),
// "cheaper" → "less expensive" (2026-06-21), and no invented first-person habits (2026-10-15:
// "I keep one in my day pack, always." reached the review queue).
const FIRST_PERSON_EN = /\b(?:I|I'm|I've|I'd|I'll)\b|\b(?:[Mm]y|[Mm]e|[Mm]ine)\b/;
const FIRST_PERSON_ES = /(?:^|[\s¡¿("])(?:[Yy]o|[Mm]is?)\b/;
const BLURB_RULES: { lang: "en" | "es"; re: RegExp; problem: string }[] = [
  { lang: "en", re: /\bactually\b/i, problem: 'uses the banned word "actually"' },
  { lang: "en", re: /\bgenuinely\b/i, problem: 'uses the banned word "genuinely"' },
  { lang: "en", re: /\bcheap(?:er|est)?\b/i, problem: 'says "cheap/cheaper" — say "less expensive"' },
  { lang: "en", re: FIRST_PERSON_EN, problem: "speaks in first person as Mark" },
  { lang: "es", re: /\brealmente\b/i, problem: 'uses "realmente" (the Spanish of the banned "actually")' },
  { lang: "es", re: /\bbarat[oa]s?\b/i, problem: 'says "barato" — say "económico"' },
  { lang: "es", re: FIRST_PERSON_ES, problem: "speaks in first person as Mark (Spanish)" },
];

/** Every rule a blurb pair breaks, as plain-English problems ([] = clean). */
export function blurbProblems(en: string, es: string): string[] {
  const out: string[] = [];
  for (const r of BLURB_RULES) if (r.re.test(r.lang === "en" ? en : es)) out.push(`${r.lang.toUpperCase()}: ${r.problem}`);
  return out;
}

/** Last resort after a failed rewrite: swap or remove banned words, drop first-person sentences. */
export function scrubBlurb(text: string, lang: "en" | "es"): string {
  let t = text;
  if (lang === "en") {
    t = t.replace(/\s*\bactually\b,?/gi, "").replace(/\s*\bgenuinely\b,?/gi, "");
    t = t.replace(/\bcheaper\b/gi, "less expensive").replace(/\bcheapest\b/gi, "least expensive").replace(/\bcheap\b/gi, "low-cost");
  } else {
    t = t.replace(/\s*\brealmente\b,?/gi, "").replace(/\bbarat(o|a)(s?)\b/gi, (_m, _g, pl: string) => `económico${pl}`);
  }
  const fp = lang === "en" ? FIRST_PERSON_EN : FIRST_PERSON_ES;
  const sentences = t.match(/[^.!?]+[.!?]*/g) ?? [t];
  const kept = sentences.filter((x) => !fp.test(x));
  t = (kept.length > 0 ? kept : []).join("").trim();
  return t.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1");
}
