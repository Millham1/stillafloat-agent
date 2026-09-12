// news-hubs.ts — per-line news hubs (/news/carnival, /news/royal-caribbean).
//
// Semrush US, 2026-09: "carnival cruise news" 22,200 searches a month (KD 49),
// "royal caribbean news" 18,100 (KD 47). We publish these stories every day but
// they only ever appear mixed together on /news.html, so nothing on the site
// answers either query. A hub is a real page for a real search: everything we
// have run about one line, newest first, with the line's own framing.
//
// Selection is deterministic and testable here; the rendering lives in
// prerender-news.ts with the rest of the page furniture.

export interface HubCopy { title: string; desc: string; h1: string; intro: string; latest: string; earlier: string; back: string }
export interface NewsHub {
  slug: string;
  /** Canonical line name, used in JSON-LD and the breadcrumb. */
  line: string;
  /** Line names, brands and that line's ships, as they appear in a headline. */
  match: RegExp;
  /** Matches that are really about another brand under the same parent. */
  exclude?: RegExp;
  en: HubCopy;
  es: HubCopy;
}

// Matching is precision-first: a wrong story on a hub is worse for search than a
// shorter hub, and bare ship words collide badly across lines. Carnival has a
// Magic, a Dream, an Adventure, a Radiance and a Legend; so do Disney and Royal
// Caribbean. Running the first draft over the 345 stories we have published put
// 35 of them on BOTH hubs, filed a Princess story about Half Moon Cay and a
// Disney Magic itinerary as Carnival news, and put a Royal Caribbean story on
// the Carnival page. So only markers that cannot belong to another line count.
//
// Carnival: the brand name itself (every Carnival ship story says "Carnival"),
// plus the two things that are Carnival's alone — the ship named Mardi Gras and
// the private island Celebration Key. NOT Half Moon Cay, which Holland America
// owns and Princess visits.
const CARNIVAL_MATCH = /\b(carnival|mardi gras|celebration key|vifp)\b/i;
// Royal: the brand, and the fleet's own naming convention. Every Royal ship is
// "<something> of the Seas" and no other line names ships that way, so one
// pattern covers the whole fleet — including hulls not yet delivered — with no
// collisions. CocoCay is Royal's island alone.
const ROYAL_MATCH = /\b(royal caribbean|rccl|[a-z]+ of the seas|cococay)\b/i;

export const NEWS_HUBS: NewsHub[] = [
  {
    slug: "carnival",
    line: "Carnival Cruise Line",
    match: CARNIVAL_MATCH,
    // Carnival Corporation owns Princess, Holland America, Cunard, Costa, AIDA and
    // Seabourn: a story about one of those brands is not Carnival Cruise Line news.
    exclude: /\b(princess cruises|holland america|cunard|costa cruises|aida|seabourn|p&o cruises)\b/i,
    en: {
      title: "Carnival Cruise News: What Changed This Week, and What It Costs You",
      desc: "Carnival Cruise Line news read the way a cruiser needs it — every fee change, itinerary swap, ship update and loyalty tweak, and what each one does to your sailing.",
      h1: "Carnival Cruise News",
      intro: "Everything we have run about Carnival, newest first. Each story says what changed and, more to the point, what it does to your sailing and your wallet. No press releases repeated back at you.",
      latest: "Latest Carnival news",
      earlier: "Earlier Carnival coverage",
      back: "All cruise news",
    },
    es: {
      title: "Noticias de Carnival Cruise Line: qué cambió y cuánto te cuesta",
      desc: "Noticias de Carnival Cruise Line explicadas para quien navega: cada cambio de tarifa, itinerario, barco y programa de lealtad, con lo que significa de verdad para tu crucero.",
      h1: "Noticias de Carnival",
      intro: "Todo lo que hemos publicado sobre Carnival, lo más reciente primero. Cada nota dice qué cambió y, sobre todo, cómo afecta tu crucero y tu bolsillo. Nada de comunicados repetidos.",
      latest: "Lo más reciente de Carnival",
      earlier: "Cobertura anterior de Carnival",
      back: "Todas las noticias de cruceros",
    },
  },
  {
    slug: "royal-caribbean",
    line: "Royal Caribbean International",
    match: ROYAL_MATCH,
    // Royal Caribbean Group also owns Celebrity and Silversea.
    exclude: /\b(celebrity cruises|celebrity (apex|edge|beyond|ascent|xcel|reflection|silhouette|equinox|solstice|eclipse|summit|millennium|infinity|constellation)|silversea)\b/i,
    en: {
      title: "Royal Caribbean News: Ship Updates, Fees and Itinerary Changes",
      desc: "Royal Caribbean news with the part that matters to you — new ships and venues, drink and Wi-Fi pricing, Perfect Day changes, itinerary swaps, and what each one means before you book.",
      h1: "Royal Caribbean News",
      intro: "Everything we have run about Royal Caribbean, newest first. New ships, new fees, CocoCay changes and the itinerary swaps that quietly rewrite a week you already paid for.",
      latest: "Latest Royal Caribbean news",
      earlier: "Earlier Royal Caribbean coverage",
      back: "All cruise news",
    },
    es: {
      title: "Noticias de Royal Caribbean: barcos, tarifas y cambios de itinerario",
      desc: "Noticias de Royal Caribbean con lo que de verdad te importa: barcos y lugares nuevos, precios de bebidas y wifi, cambios en Perfect Day e itinerarios, y qué significa cada uno antes de reservar.",
      h1: "Noticias de Royal Caribbean",
      intro: "Todo lo que hemos publicado sobre Royal Caribbean, lo más reciente primero. Barcos nuevos, tarifas nuevas, cambios en CocoCay y los ajustes de itinerario que reescriben en silencio una semana que ya pagaste.",
      latest: "Lo más reciente de Royal Caribbean",
      earlier: "Cobertura anterior de Royal Caribbean",
      back: "Todas las noticias de cruceros",
    },
  },
];

export function hubBySlug(slug: string): NewsHub | undefined {
  return NEWS_HUBS.find((h) => h.slug === slug);
}

// Deliberately loose: NewsStory carries optional fields typed as `string |
// undefined` plus booleans and arrays, so an index signature of `unknown` would
// reject it. The hub only reads the headline, the cliffnote and the date.
export interface HubStory {
  id?: string;
  title?: string;
  summary?: string;
  travelerImpact?: string;
  approvedAt?: string;
  generatedAt?: string;
}

/** The text a hub matches against: the English headline and cliffnote. */
function haystack(story: HubStory): string {
  return `${String(story.title ?? "")} ${String(story.summary ?? "")} ${String(story.travelerImpact ?? "")}`;
}

/**
 * Does this story belong on this hub?
 *
 * The headline decides first. If it names the line, the story is the line's —
 * unless the headline is really about a sister brand under the same parent.
 *
 * If the headline names a DIFFERENT hub's line, the story is that line's and a
 * passing mention of this one in the cliffnote does not drag it here ("Royal
 * Caribbean Trims Revenue Outlook" is not Carnival news because the body
 * compares the two).
 *
 * Only when the headline names no hub's line at all does the cliffnote decide —
 * which is how a genuine industry story ("Port Canaveral Tops Off Its Parking
 * Garage") correctly appears on every line it substantively covers.
 */
export function matchesHub(story: HubStory, hub: NewsHub, allHubs: readonly NewsHub[] = NEWS_HUBS): boolean {
  const title = String(story.title ?? "");
  const text = haystack(story);
  const excluded = (where: string) => Boolean(hub.exclude?.test(where));

  if (hub.match.test(title)) return !excluded(title);
  const titleNamesAnotherLine = allHubs.some((h) => h.slug !== hub.slug && h.match.test(title));
  if (titleNamesAnotherLine) return false;
  return hub.match.test(text) && !excluded(text);
}

function time(story: HubStory): number {
  const t = Date.parse(String(story.approvedAt || story.generatedAt || ""));
  return Number.isNaN(t) ? 0 : t;
}

/** Every story on this line, newest first, de-duplicated by id. */
export function storiesForHub<T extends HubStory>(stories: readonly T[], hub: NewsHub, allHubs: readonly NewsHub[] = NEWS_HUBS): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of stories) {
    const id = String(s.id ?? "");
    if (id && seen.has(id)) continue;
    if (!matchesHub(s, hub, allHubs)) continue;
    if (id) seen.add(id);
    out.push(s);
  }
  return out.sort((a, b) => time(b) - time(a));
}

/** A hub is only worth a page (and a sitemap entry) once it has something to show. */
export const MIN_HUB_STORIES = 3;

export function hubPath(slug: string, lang: "en" | "es"): string {
  return lang === "es" ? `/es/news/${slug}.html` : `/news/${slug}.html`;
}
