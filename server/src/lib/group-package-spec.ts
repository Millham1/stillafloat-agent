// group-package-spec.ts — the WORDS and choices of a group's poster, with no image library
// involved: pure and unit-tested. group-package.ts draws what this decides.
import type { GroupFacts, GroupCopy } from "./group-marketing";
import type { AssetRow } from "./group-assets";
import { BUSINESS } from "./group-secure";

export const MARK_PHONE = BUSINESS.phone;

export interface Line { text: string; size: number; weight?: 400 | 700; color?: string }
export interface PosterSpec {
  headline: string[];      // wrapped lines
  dates: string;           // "May 10–14, 2027 · 4 nights from Miami"
  facts: string[];         // the short facts column
  travel: string[];        // air / hotel / transfers lines, if any
  cta: string;             // "Call or text Mark"
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The poster's words, from the file. Pure. */
export function posterSpec(facts: GroupFacts, copy: GroupCopy, args: { url: string; credits: string[]; lang?: "en" | "es" }): PosterSpec {
  const es = args.lang === "es";
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
    headline: wrap(copy.headline, 26),
    dates,
    facts: f,
    travel: facts.travel.map((t) => t.text),
    cta: es ? "Escanee el código para unirse a la diversión" : "Scan the QR to join the fun",
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
