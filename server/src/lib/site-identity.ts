// site-identity.ts — ONE entity graph for who publishes the site and who Mark is.
//
// AI assistants (ChatGPT, Claude, Perplexity, Gemini) decide whom to cite and
// recommend partly from structured data. Until 2026-09-29 the site described
// itself three different ways: index.html's Organization was "Still Afloat LLC",
// every guide and news page credited an anonymous Organization "Still Afloat
// Cruising" as the AUTHOR, and the one page that is about Mark — work-with-mark —
// carried no markup at all. Nothing anywhere said that a person named Mark
// Millham writes this site and advises cruisers for a living.
//
// Every generated page now references the same two nodes by @id: the
// Organization (publisher) and the Person (author). The static pages
// (index.html, es/index.html, work-with-mark.html, es/work-with-mark.html)
// carry the full nodes by hand; site-identity.test.ts parses them and fails if
// they drift from the values here.
//
// sameAs lists ONLY confirmed profiles (2026-09-29): add one here — and in the four
// static pages — once it is confirmed, never a guess.

export const SITE = "https://stillafloatcruising.com";
export const LOGO = `${SITE}/assets/images/still_afloat_logo.png`;
export const WORK_WITH_MARK = `${SITE}/work-with-mark.html`;
export const WORK_WITH_MARK_ES = `${SITE}/es/work-with-mark.html`;

export const ORG_ID = `${SITE}/#organization`;
export const PERSON_ID = `${WORK_WITH_MARK}#mark`;

export const ORG_NAME = "Still Afloat Cruising";
export const ORG_LEGAL_NAME = "Still Afloat LLC";
export const PERSON_NAME = "Mark Millham";

/** The business's own confirmed pages only: its YouTube channel, Facebook page
 *  (page id from the Make Facebook connection) and Instagram.
 *
 *  Mark's person node links NO profiles, by his decision (2026-09-29): "i dont want
 *  my personal pages linked to the business. the LLC needs to remain separate." Never
 *  add a personal LinkedIn, personal YouTube channel or email to the markup. */
export const SAME_AS: readonly string[] = [
  "https://www.youtube.com/@StillAfloatcruising2026",
  "https://www.facebook.com/1089040447632520",
  "https://www.instagram.com/stillafloatcruising2026/",
];

/** The full Organization node, as index.html carries it. */
export function organizationNode(): Record<string, unknown> {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: ORG_NAME,
    legalName: ORG_LEGAL_NAME,
    url: `${SITE}/`,
    logo: { "@type": "ImageObject", url: LOGO },
    sameAs: [...SAME_AS],
  };
}

/** Author reference for generated pages — points at the full node on work-with-mark. */
export function authorRef(): Record<string, unknown> {
  return { "@type": "Person", "@id": PERSON_ID, name: PERSON_NAME, url: WORK_WITH_MARK };
}

/** Publisher reference for generated pages. Google's Article guidelines want the
 *  name and logo inline, so the reference carries them alongside the @id. */
export function publisherRef(): Record<string, unknown> {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: ORG_NAME,
    url: `${SITE}/`,
    logo: { "@type": "ImageObject", url: LOGO },
  };
}
