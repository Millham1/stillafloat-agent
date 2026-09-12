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
// PRIVATE ISLANDS ARE NOT A LINE SIGNAL (Mark, 2026-09-11): a parent company
// shares its islands across its brands, and is actively moving itineraries
// between them — Princess is being redirected off Princess Cays onto Half Moon
// Cay and Carnival's Celebration Key. So a story about Celebration Key may be
// Princess news, and a CocoCay story may be Celebrity news. Only the LINE and
// its own ships decide; the island never does. The agent settles the rest.
//
// Ship names collide across lines too (Carnival Magic and Disney Magic;
// Carnival Adventure and Adventure of the Seas), so a line matches its own name
// plus only those hulls whose names no other line uses. Everything ambiguous is
// the classifier's job, not the pattern's.

/** A line, compactly. The page copy is generated from this; see `hubCopy`. */
export interface LineDef {
  slug: string;
  /** Full name, used in the intro, the breadcrumb and the structured data. */
  line: string;
  /** How searchers name it: "Carnival Cruise", "Royal Caribbean", "MSC Cruises". */
  search: string;
  match: RegExp;
  /** Sister brands under the same parent that must not be dragged in. */
  exclude?: RegExp;
  /** The specific angle for this line, if the generic one undersells it. */
  angle?: { en: string; es: string };
  /** The one-sentence promise under the H1, if the generic one undersells it. */
  intro?: { en: string; es: string };
}

const GENERIC_ANGLE = {
  en: "Ship Updates, Fees and Itinerary Changes",
  es: "barcos, tarifas y cambios de itinerario",
};
const GENERIC_INTRO = {
  en: "New ships, new fees, and the itinerary changes that quietly rewrite a week you already paid for.",
  es: "Barcos nuevos, tarifas nuevas y los cambios de itinerario que reescriben en silencio una semana que ya pagaste.",
};

export const LINE_DEFS: LineDef[] = [
  {
    slug: "carnival", line: "Carnival Cruise Line", search: "Carnival Cruise",
    match: /\b(carnival|mardi gras|vifp)\b/i,
    // Carnival Corporation also owns Princess, Holland America, Cunard, Costa,
    // AIDA, P&O and Seabourn: those brands are not Carnival Cruise Line.
    exclude: /\b(princess cruises|holland america|cunard|costa cruises|aida\w*|seabourn|p&o cruises)\b/i,
    angle: { en: "What Changed This Week, and What It Costs You", es: "qué cambió y cuánto te cuesta" },
    intro: {
      en: "Each story says what changed and, more to the point, what it does to your sailing and your wallet. No press releases repeated back at you.",
      es: "Cada nota dice qué cambió y, sobre todo, cómo afecta tu crucero y tu bolsillo. Nada de comunicados repetidos.",
    },
  },
  {
    slug: "royal-caribbean", line: "Royal Caribbean International", search: "Royal Caribbean",
    // Every Royal hull is "<name> of the Seas" and no other line names ships that
    // way, so one pattern covers the fleet, undelivered hulls included.
    match: /\b(royal caribbean|rccl|[a-z]+ of the seas)\b/i,
    exclude: /\b(celebrity cruises|celebrity \w+|silversea|silver \w+)\b/i,
    angle: { en: "Ship Updates, Fees and Itinerary Changes", es: "barcos, tarifas y cambios de itinerario" },
    intro: {
      en: "New ships, new fees, Perfect Day changes and the itinerary swaps that quietly rewrite a week you already paid for.",
      es: "Barcos nuevos, tarifas nuevas, cambios en Perfect Day y los ajustes de itinerario que reescriben una semana que ya pagaste.",
    },
  },
  {
    slug: "norwegian", line: "Norwegian Cruise Line", search: "Norwegian Cruise Line",
    match: /\b(norwegian cruise line|ncl|norwegian (prima|viva|aqua|luna|encore|bliss|joy|escape|getaway|breakaway|epic|jade|jewel|pearl|star|sun|sky|dawn|gem|spirit)|pride of america)\b/i,
    exclude: /\b(oceania|regent seven seas|seven seas \w+)\b/i,
    angle: { en: "Free at Sea, Fees and Fleet Changes", es: "Free at Sea, tarifas y cambios de flota" },
  },
  {
    slug: "msc", line: "MSC Cruises", search: "MSC Cruises",
    match: /\bmsc\b/i,
    exclude: /\b(explora journeys|explora [ivx]+)\b/i,
    angle: { en: "Ships, Fares and Ocean Cay", es: "barcos, tarifas y Ocean Cay" },
  },
  {
    slug: "princess", line: "Princess Cruises", search: "Princess Cruises",
    match: /\b(princess cruises|(sun|sky|enchanted|discovery|majestic|regal|royal|caribbean|crown|emerald|ruby|diamond|sapphire|grand|coral|island|star) princess)\b/i,
    exclude: /\b(carnival cruise|holland america|cunard|seabourn)\b/i,
    angle: { en: "Itineraries, Princess Plus and Ship News", es: "itinerarios, Princess Plus y noticias de barcos" },
  },
  {
    slug: "celebrity", line: "Celebrity Cruises", search: "Celebrity Cruises",
    match: /\bcelebrity (cruises|apex|edge|beyond|ascent|xcel|reflection|silhouette|equinox|solstice|eclipse|summit|millennium|infinity|constellation|flora|xpedition|xploration)\b/i,
    exclude: /\b(royal caribbean|[a-z]+ of the seas|silversea)\b/i,
  },
  {
    slug: "holland-america", line: "Holland America Line", search: "Holland America",
    match: /\b(holland america|zuiderdam|koningsdam|nieuw statendam|nieuw amsterdam|eurodam|oosterdam|westerdam|noordam|volendam|zaandam|rotterdam vii)\b/i,
    exclude: /\b(carnival cruise|princess cruises|cunard|seabourn)\b/i,
  },
  {
    slug: "disney", line: "Disney Cruise Line", search: "Disney Cruise Line",
    match: /\bdisney (cruise|magic|wonder|dream|fantasy|wish|treasure|destiny|adventure|expedition)\b/i,
    angle: { en: "Ships, Sailings and Castaway Cay", es: "barcos, salidas y Castaway Cay" },
  },
  {
    slug: "virgin-voyages", line: "Virgin Voyages", search: "Virgin Voyages",
    match: /\b(virgin voyages|(scarlet|valiant|resilient|brilliant) lady)\b/i,
    angle: { en: "Adults-Only Sailings, Fares and Ships", es: "cruceros solo para adultos, tarifas y barcos" },
  },
  {
    slug: "margaritaville", line: "Margaritaville at Sea", search: "Margaritaville at Sea",
    match: /\bmargaritaville at sea\b/i,
  },
  { slug: "aida", line: "AIDA Cruises", search: "AIDA Cruises", match: /\b(aida cruises|aida[a-z]+)\b/i },
  { slug: "cunard", line: "Cunard Line", search: "Cunard", match: /\b(cunard|queen (mary 2|elizabeth|victoria|anne))\b/i, exclude: /\b(carnival cruise|princess cruises|holland america)\b/i },
  { slug: "costa", line: "Costa Cruises", search: "Costa Cruises", match: /\b(costa cruises|costa (smeralda|toscana|firenze|diadema|favolosa|fascinosa|deliziosa|pacifica|fortuna|serena|venezia|luminosa|magica|mediterranea))\b/i },
  { slug: "viking", line: "Viking", search: "Viking Cruises", match: /\bviking (ocean|cruises|expeditions|star|sky|sea|sun|orion|jupiter|venus|mars|neptune|saturn|octantis|polaris|vela|vesta|mira|idun)\b/i },
  { slug: "oceania", line: "Oceania Cruises", search: "Oceania Cruises", match: /\b(oceania|allura|insignia|nautica|sirena|regatta)\b/i, exclude: /\b(norwegian cruise line|regent seven seas)\b/i },
  { slug: "regent", line: "Regent Seven Seas Cruises", search: "Regent Seven Seas", match: /\b(regent seven seas|seven seas (splendor|explorer|grandeur|mariner|voyager|navigator|prestige))\b/i },
  { slug: "silversea", line: "Silversea Cruises", search: "Silversea", match: /\b(silversea|silver (dawn|moon|muse|nova|ray|shadow|whisper|wind|cloud|endeavour|origin|spirit))\b/i, exclude: /\b(royal caribbean|celebrity cruises)\b/i },
  { slug: "seabourn", line: "Seabourn", search: "Seabourn", match: /\bseabourn\b/i },
  { slug: "explora-journeys", line: "Explora Journeys", search: "Explora Journeys", match: /\b(explora journeys|explora [ivx]+)\b/i, exclude: /\bmsc cruises\b/i },
  { slug: "po-cruises", line: "P&O Cruises", search: "P&O Cruises", match: /\b(p&o cruises|iona|arvia|britannia|azura|ventura|arcadia)\b/i },
  { slug: "tui-cruises", line: "TUI Cruises", search: "TUI Cruises", match: /\b(tui cruises|mein schiff)\b/i },
  { slug: "marella", line: "Marella Cruises", search: "Marella Cruises", match: /\bmarella\b/i },
  { slug: "hurtigruten", line: "Hurtigruten and HX", search: "Hurtigruten", match: /\b(hurtigruten|hx expeditions)\b/i },
  { slug: "ponant", line: "Ponant", search: "Ponant", match: /\b(ponant|le (commandant charcot|boreal|lyrial|soleal|champlain|dumont|bougainville|jacques cartier))\b/i },
  { slug: "lindblad", line: "Lindblad Expeditions", search: "Lindblad Expeditions", match: /\b(lindblad|national geographic (endurance|resolution|explorer|orion|venture|islander|quest|sea bird|sea lion))\b/i },
  { slug: "windstar", line: "Windstar Cruises", search: "Windstar", match: /\b(windstar|wind (surf|star|spirit)|star (breeze|legend|pride|seeker))\b/i },
  { slug: "azamara", line: "Azamara", search: "Azamara", match: /\bazamara\b/i },
  { slug: "ritz-carlton", line: "The Ritz-Carlton Yacht Collection", search: "Ritz-Carlton Yacht Collection", match: /\b(ritz-?carlton yacht|evrima|ilma|luminara)\b/i },
  { slug: "emerald", line: "Emerald Cruises", search: "Emerald Cruises", match: /\bemerald (cruises|azzurra|sakara|kaia)\b/i },
  { slug: "atlas", line: "Atlas Ocean Voyages", search: "Atlas Ocean Voyages", match: /\b(atlas ocean|world (navigator|traveller|voyager|seeker))\b/i },
  { slug: "ambassador", line: "Ambassador Cruise Line", search: "Ambassador Cruise Line", match: /\b(ambassador cruise line|ambience|ambition)\b/i },
  { slug: "fred-olsen", line: "Fred. Olsen Cruise Lines", search: "Fred. Olsen", match: /\b(fred\.? olsen|balmoral|borealis|bolette|braemar)\b/i },
  { slug: "celestyal", line: "Celestyal Cruises", search: "Celestyal", match: /\bcelestyal\b/i },
  { slug: "scenic", line: "Scenic", search: "Scenic Cruises", match: /\bscenic (cruises|eclipse)\b/i },
  { slug: "saga", line: "Saga Cruises", search: "Saga Cruises", match: /\b(saga cruises|spirit of (discovery|adventure))\b/i },
];

/** The seven page strings, generated from a line definition. */
export function hubCopy(def: LineDef, lang: "en" | "es"): HubCopy {
  const angle = (def.angle ?? GENERIC_ANGLE)[lang];
  const intro = (def.intro ?? GENERIC_INTRO)[lang];
  if (lang === "es") {
    return {
      title: `Noticias de ${def.search}: ${angle} | Still Afloat`,
      desc: `Noticias de ${def.line} para quien navega: ${angle}. Qué cambió y cómo afecta tu crucero, seleccionadas por Still Afloat.`,
      h1: `Noticias de ${def.search}`,
      intro: `Todo lo que hemos publicado sobre ${def.line}, lo más reciente primero. ${intro}`,
      latest: `Lo más reciente de ${def.search}`,
      earlier: `Cobertura anterior de ${def.search}`,
      back: "Todas las noticias de cruceros",
    };
  }
  return {
    title: `${def.search} News: ${angle} | Still Afloat`,
    desc: `${def.line} news read the way a cruiser needs it: ${angle.toLowerCase()}. What changed, and what it does to your sailing, curated by Still Afloat.`,
    h1: `${def.search} News`,
    intro: `Everything we have run about ${def.line}, newest first. ${intro}`,
    latest: `Latest ${def.search} news`,
    earlier: `Earlier ${def.search} coverage`,
    back: "All cruise news",
  };
}

export const NEWS_HUBS: NewsHub[] = LINE_DEFS.map((def) => ({
  slug: def.slug,
  line: def.line,
  match: def.match,
  ...(def.exclude ? { exclude: def.exclude } : {}),
  en: hubCopy(def, "en"),
  es: hubCopy(def, "es"),
}));

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
