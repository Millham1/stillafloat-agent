// group-package-spec.ts — the WORDS and choices of a group's poster, with no image library
// involved: pure and unit-tested. group-package.ts draws what this decides.
import { DEFAULT_CTA, type GroupFacts, type GroupCopy } from "./group-marketing";
import type { AssetRow } from "./group-assets";
import { BUSINESS } from "./group-secure";

export const MARK_PHONE = BUSINESS.phone;

export interface Line { text: string; size: number; weight?: 400 | 700; color?: string }
export interface PosterSpec {
  lang: "en" | "es";
  headline: string[];      // wrapped lines
  headlineSize: number;    // type size (px on the 2550-wide poster) the lines were fitted to
  dates: string;           // "May 10–14, 2027 · 4 nights from Miami"
  facts: string[];         // the short facts column
  travel: string[];        // air / hotel / transfers lines, if any
  cta: string;             // "Use the QR code to book your spot!" (the group's own line when its interview has one)
  linkCta: string;         // the same call for a picture with no QR code on it ("Use the link to book your spot!")
  phone: string;
  url: string;             // the group page
  credit: string;          // photo credit line(s)
  footer: string;
}

/** Word-wrap by an average glyph width; conservative so lines never overflow the SVG box. */
export function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * The biggest of `sizes` (largest first) at which `text` wraps to at most `maxLines` lines across `width` px, and the lines at that size;
 * the smallest size when none fits. Bold sans type runs about 0.66 em per character, so a line holds width / (size * 0.66) characters.
 * The headline is Mark's one rising sentence (up to 220 characters), no longer a four-word hook, so the type has to give way to it.
 */
export function fitHeadline(text: string, width: number, sizes: readonly number[], maxLines: number): { size: number; lines: string[] } {
  const at = (size: number) => wrap(text, Math.max(8, Math.floor(width / (size * 0.66))));
  for (const size of sizes) {
    const lines = at(size);
    if (lines.length <= maxLines) return { size, lines };
  }
  const size = sizes[sizes.length - 1]!;
  return { size, lines: at(size) };
}

/** The old "scan the QR" line and the new one each have a link twin for the Facebook pictures, which cannot be scanned. */
const LINK_CTA: Record<string, string> = {
  [DEFAULT_CTA.en]: "Use the link to book your spot!",
  [DEFAULT_CTA.es]: "¡Use el enlace para reservar su lugar!",
  "Scan the QR to join the fun": "Open the link to join the fun",
  "Escanee el código para unirse a la diversión": "Abra el enlace para unirse a la diversión",
};

/** The payoff line under the headline is part of the poster's headline when it is short ("ALL ON THE SAME CRUISE!"). */
const PAYOFF_MAX = 60;

/** The poster's words, from the file. Pure. */
export function posterSpec(facts: GroupFacts, copy: GroupCopy, args: { url: string; credits: string[]; lang?: "en" | "es"; cta?: string }): PosterSpec {
  const es = args.lang === "es";
  const cta = args.cta?.trim() || DEFAULT_CTA[es ? "es" : "en"];
  const payoff = (copy.subhead ?? "").trim();
  const sentence = [copy.headline, payoff.length > 0 && payoff.length <= PAYOFF_MAX ? payoff : ""].filter(Boolean).join(" ");
  const fit = fitHeadline(sentence, 2310, [136, 118, 104, 92, 80], 7);
  const when = [facts.sailDateText, facts.returnDateText].filter(Boolean).join(" – ");
  const dates = [when, facts.nights !== null ? `${facts.nights} ${es ? "noches" : "nights"}` : null, facts.embarkPort ? `${es ? "desde" : "from"} ${facts.embarkPort}` : null].filter(Boolean).join(" · ");
  const f: string[] = [];
  if (facts.ports.length) f.push(`${es ? "Puertos" : "Ports"}: ${facts.ports.join(", ")}`);
  if (facts.fromPerPersonText) f.push(`${es ? "Desde" : "From"} ${facts.fromPerPersonText} ${es ? "por persona" : "per person"}`);
  const dep = facts.cabins.find((c) => c.depositPerPersonText)?.depositPerPersonText;
  if (dep) f.push(`${es ? "Depósito" : "Deposit"} ${dep} ${es ? "por persona" : "per person"}`);
  if (facts.bookByText) f.push(`${es ? "Reserve antes del" : "Reserve by"} ${facts.bookByText}`);
  for (const a of facts.perks.slice(0, 3)) f.push(`${es ? "Incluido" : "Included"}: ${a}`);
  f.push(es ? "Mejoras de cabina disponibles" : "Cabin upgrades available");
  return {
    lang: es ? "es" : "en",
    headline: fit.lines,
    headlineSize: fit.size,
    dates,
    facts: f,
    travel: facts.travel.map((t) => t.text),
    cta,
    linkCta: LINK_CTA[cta] ?? (es ? "Abra el enlace" : "Open the link"),
    phone: MARK_PHONE,
    url: args.url.replace(/^https?:\/\//, ""),
    credit: args.credits.filter(Boolean).join("  ·  "),
    footer: `${BUSINESS.legalName} · ${es ? "Afiliado de" : "Affiliate of"} ${BUSINESS.host} · ${BUSINESS.email}`,
  };
}


/** Which photos the renders use: Mark's picks, else the first on file per subject; the ship first. */
export function pickPhotos(assets: readonly AssetRow[], chosenIds: readonly string[]): { hero: AssetRow | null; second: AssetRow | null; credits: string[] } {
  const chosen = chosenIds.map((id) => assets.find((a) => a.id === id)).filter((a): a is AssetRow => !!a);
  const ship = chosen.find((a) => a.subject === "ship") ?? assets.find((a) => a.subject === "ship") ?? null;
  const dest = chosen.find((a) => a.subject !== "ship") ?? assets.find((a) => a.subject !== "ship") ?? null;
  const hero = chosen[0] ?? ship ?? dest;
  const second = hero && hero.id !== dest?.id ? dest : (hero && hero.id !== ship?.id ? ship : null);
  const credits = [hero, second].filter((a): a is AssetRow => !!a).map((a) => a.attribution ?? "").filter(Boolean);
  return { hero, second, credits };
}
