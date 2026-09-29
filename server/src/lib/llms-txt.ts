// llms-txt.ts — /llms.txt, generated from what the site actually publishes.
//
// llms.txt is the plain-text map an AI assistant reads to learn what a site is
// and which pages answer which questions (llmstxt.org). Ours was a hand-written
// 29-line file that listed no guide, no cruise-line news hub, no tool, and put
// "Work with Mark" under a generic "About" — so an assistant reading it learned
// that a cruise site exists, not that a named advisor behind it can be hired, or
// which of our pages answer the questions cruisers ask. (AI-visibility program,
// Mark's OK 2026-09-29.)
//
// Now it is rebuilt from the data after every guides prerender tick and on boot
// (server/src/index.ts). Order matters — assistants weight what comes first:
//   H1 + the approved bio sentence → Work with Mark → Guides → news hubs →
//   Content → Tools → Gear → Spanish → Policies.
//
// buildLlmsTxt() is pure (unit-tested in llms-txt.test.ts); writeLlmsTxt() does
// the I/O.
//
// NOT TRACKED IN GIT (see .gitignore). The boxes' drift monitor alerts on any
// tracked file edited in place, and news.html was untracked for the same reason.
// The site is still never without one: writeLlmsTxt() runs the moment the
// server boots, and when the guides data cannot be read it writes the static
// sections (everything except the guide list) rather than nothing — but only if
// no file exists yet, so a Supabase blip never replaces a full file with a
// thinner one. Deploys run `git reset --hard` without `git clean`, so an
// untracked llms.txt survives every deploy.

import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";
import { PATHS, readJson } from "./persistence";
import { resolvePublicDir } from "./public-dir";
import { cleanSlug, hasLang, publishedGuides, toolHrefFor, GUIDE_COPY, type Guide } from "./prerender-guides";
import { NEWS_HUBS, hubPath } from "./news-hubs";
import { SITE, WORK_WITH_MARK, WORK_WITH_MARK_ES } from "./site-identity";

type Lang = "en" | "es";

/** A cruise-line hub with a page on disk, per language. */
export interface LlmsHub {
  slug: string;
  en?: { title: string; desc: string };
  es?: { title: string; desc: string };
}

export interface LlmsInput {
  /** Published guides in display order — publishedGuides() output. */
  guides: Guide[];
  hubs: LlmsHub[];
}

// The summary is the bio sentence from the hand-written llms.txt, VERBATIM —
// Mark approved that copy. Do not reword it here.
export const LLMS_SUMMARY =
  "> Still Afloat is a cruise travel-advisory and content brand run by Mark — a retired IT manager, U.S. veteran, and former liveaboard sailor with 20+ years of cruising experience. The mission: help everyday cruisers make smarter decisions. \"Cruise smarter. Laugh more. Stay Afloat.\" Content is the honest take of an experienced friend, not influencer hype or cruise-line marketing.";

// The offer, described from what the site already says: "free help planning
// your next cruise" (index.html), the "Real Cost & Value" breakdown on
// work-with-mark.html, and "no booking fees to you" (the guides CTA). No page
// names the offer "Free Real-Cost Check" yet (checked 2026-09-29); when one
// does, use that name here.
const WORK_WITH_MARK_LINES = [
  `- [Work with Mark — independent cruise advisor](${WORK_WITH_MARK}): Travel-advisory services and the contact form for booking a cruise or asking a question. Mark is a travel advisor hosted by the Cornerstone Collective agency.`,
  `- [Free cruise-planning help — ask Mark](${WORK_WITH_MARK}#contact): Mark breaks down the real cost of a cruise — drink packages, gratuities, specialty dining, excursions, Wi-Fi — and what is worth paying for, with no booking fees to you.`,
  `- [Trabaja con Mark (español)](${WORK_WITH_MARK_ES}): Planifica tu crucero con un asesor de cruceros independiente que hace la investigación, saca los números reales y te habla con honestidad — para que reserves el barco y el camarote correctos sin pagar de más.`,
];

const CONTENT_LINES = [
  `- [Cruise News](${SITE}/news.html): Curated, AI-assisted, human-approved cruise industry news for travelers.`,
  `- [Commentary](${SITE}/commentary.html): Mark's honest take on cruise decisions, reviews, and planning.`,
  `- [Mark's Favorites](${SITE}/favorites.html): YouTube channels and cruise websites worth following.`,
  `- [Subscribe](${SITE}/subscribe.html): Free weekly newsletter — curated cruise news, port weather, and travel intelligence.`,
];

// Descriptions are the pages' own meta descriptions or the old llms.txt lines.
const TOOL_LINES = [
  `- [Where's My Ship? — cruise ship tracker](${SITE}/wheres-my-ship.html): Free cruise ship tracker. Type a ship's name and see where your cruise ship is right now on a live satellite map: course, speed, next port, and arrival-day weather.`,
  `- [Room Concierge](${SITE}/room-concierge.html): Tell Mark how you cruise and he'll name the cabins he'd book himself — and the ones he'd walk his family past.`,
  `- [Cruise Port & Destination Weather](${SITE}/weather.html): Live conditions at major U.S. embarkation ports and Caribbean/Bahamas destinations.`,
  `- [Live Cruise Cams](${SITE}/webcams.html): Live webcams from popular cruise ports and beach destinations.`,
];

const GEAR_LINES = [
  `- [Cruising Gear](${SITE}/affiliate.html): Cruise and travel gear recommendations, curated by category. Product links are affiliate links (Amazon Associates and cruise partners).`,
];

const SPANISH_LINES = [
  `- [Versión en Español](${SITE}/es/): Full Spanish-language site for Latin American cruisers.`,
  `- [Noticias de Cruceros](${SITE}/es/news.html): Cruise news in Spanish.`,
  `- [¿Dónde Está Mi Crucero?](${SITE}/es/wheres-my-ship.html): The ship tracker in Spanish.`,
  `- [Concierge de Camarotes](${SITE}/es/room-concierge.html): The Room Concierge in Spanish.`,
];

const POLICY_LINES = [
  `- [Privacy Policy](${SITE}/privacy.html)`,
  `- [Terms of Use](${SITE}/terms.html)`,
];

/** One line of link text: no brackets (they would end the link), no line breaks. */
function linkText(s: string): string {
  return s.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
}

function note(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function guideLines(guides: Guide[], lang: Lang): string[] {
  const out: string[] = [];
  for (const g of guides) {
    // Tool tiles link out to a page listed under Tools; they have no guide page.
    if (toolHrefFor(g, "en") || toolHrefFor(g, "es")) continue;
    if (!hasLang(g, lang)) continue;
    const slug = cleanSlug(g);
    const title = lang === "es" ? g.title_es : g.title;
    const hook = (lang === "es" ? g.hook_es || g.seoDesc_es : g.hook || g.seoDesc) ?? "";
    const url = lang === "es" ? `${SITE}/es/guides/${slug}.html` : `${SITE}/guides/${slug}.html`;
    out.push(`- [${linkText(title ?? "")}](${url})${note(hook) ? `: ${note(hook)}` : ""}`);
  }
  return out;
}

function hubLines(hubs: LlmsHub[], lang: Lang): string[] {
  return hubs
    .filter((h) => h[lang])
    .map((h) => {
      const c = h[lang]!;
      return `- [${linkText(c.title)}](${SITE}${hubPath(h.slug, lang)}): ${note(c.desc)}`;
    });
}

export function buildLlmsTxt(input: LlmsInput): string {
  const guidesEn = guideLines(input.guides, "en");
  const guidesEs = guideLines(input.guides, "es");
  const hubsEn = hubLines(input.hubs, "en");
  const hubsEs = hubLines(input.hubs, "es");

  const sections: string[] = [
    "# Still Afloat Cruising",
    LLMS_SUMMARY,
    ["## Work with Mark", "", ...WORK_WITH_MARK_LINES].join("\n"),
    [
      "## Guides",
      "",
      `- [${GUIDE_COPY.en.indexH1}](${SITE}${GUIDE_COPY.en.indexPath}): ${GUIDE_COPY.en.indexDesc}`,
      ...guidesEn,
      `- [${GUIDE_COPY.es.indexH1}](${SITE}${GUIDE_COPY.es.indexPath}): ${GUIDE_COPY.es.indexDesc}`,
      ...guidesEs,
    ].join("\n"),
  ];
  if (hubsEn.length || hubsEs.length) {
    sections.push(["## Cruise line news hubs", "", ...hubsEn, ...hubsEs].join("\n"));
  }
  sections.push(
    ["## Content", "", ...CONTENT_LINES].join("\n"),
    ["## Tools", "", ...TOOL_LINES].join("\n"),
    ["## Gear (affiliate)", "", ...GEAR_LINES].join("\n"),
    ["## Spanish (es-419)", "", ...SPANISH_LINES].join("\n"),
    ["## Policies", "", ...POLICY_LINES].join("\n"),
  );
  return sections.join("\n\n") + "\n";
}

/** Hubs whose page the news prerender has written — a hub below its story
 *  floor has no page, and llms.txt must not send an assistant to a 404. */
export function liveHubs(publicDir: string): LlmsHub[] {
  const out: LlmsHub[] = [];
  for (const hub of NEWS_HUBS) {
    const row: LlmsHub = { slug: hub.slug };
    for (const lang of ["en", "es"] as const) {
      if (existsSync(path.join(publicDir, hubPath(hub.slug, lang)))) {
        row[lang] = { title: hub[lang].h1, desc: hub[lang].desc };
      }
    }
    if (row.en || row.es) out.push(row);
  }
  return out;
}

export async function writeLlmsTxt(): Promise<{ guides: number; hubs: number; written: boolean }> {
  const publicDir = resolvePublicDir();
  const target = path.join(publicDir, "llms.txt");
  let guides: Guide[] = [];
  let guidesRead = true;
  try {
    const data = await readJson<{ guides?: Guide[] }>(PATHS.guides, { guides: [] });
    guides = publishedGuides(data.guides);
  } catch (err) {
    guidesRead = false;
    logger.warn({ err }, "llms.txt: could not read guides");
  }
  const hubs = liveHubs(publicDir);
  if (!guidesRead && existsSync(target)) {
    // Keep the last full file rather than dropping every guide from it.
    return { guides: 0, hubs: hubs.length, written: false };
  }
  const text = buildLlmsTxt({ guides, hubs });
  // Write-then-rename: nginx serves this file straight off disk, so a reader
  // must never catch it half-written.
  const tmp = `${target}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, target);
  return { guides: guides.length, hubs: hubs.length, written: true };
}
