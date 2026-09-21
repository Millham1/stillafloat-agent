// cabin-derive.ts — what a category NAME tells us about a room, in one place.
//
// Extracted 2026-08-20 from fill-research.ts the moment a second consumer appeared
// (apply-widgety), because two copies of this logic is exactly how the hump bug happened:
// a drifted duplicate of VIEW_FACTORS told 13,644 rooms their view was blocked.
import { cabinAttributes } from "./cabin-match.js";

// A category that names what the room looks AT. These beat the type word: a "Boardwalk
// Balcony" is a balcony, but it does not face the sea, and telling a guest it does is the
// single most damaging thing this tool can get wrong.
const INWARD: readonly (readonly [RegExp, string])[] = [
  [/central park/i, "garden"],
  [/boardwalk/i, "boardwalk"],
  [/promenade/i, "promenade"],
  [/inward.?facing/i, "inward"],
  // Carnival's word for the outdoor wraparound deck. "Cloud 9 Spa Ocean View (Walkway View)"
  // and "Interior with Picture Window (Walkway View)" have a real window — onto the walkway,
  // with people passing it — which is the promenade case this list already models (2026-09-20).
  [/walkway/i, "promenade"],
  // The Havana cabanas. Their patio is real private outdoor space (ATTR_ALIASES gives them the
  // balcony attribute, so a balcony request reaches them), but it opens onto the shared Havana
  // deck — "direct exit to outside public deck", "view is obstructed by steel railing", 82-97 sq ft
  // of semi-private balcony per the published category detail for sister Carnival Celebration,
  // same Excel class. Water is visible past the walkway; a clean sea view it is not, and claiming
  // one is the failure this whole list exists to prevent. The 2026-09-19 Tropicale pass left these
  // 58 rooms deliberately NULL with exactly this question open — this answers it from the
  // operator-published detail rather than by guessing, and errs to the modest reading.
  [/havana[\s-]*(extended[\s-]+)?cabana/i, "promenade"],
  [/atrium/i, "atrium"],
];

// The NAME can disown its own view: Carnival sells "Ocean View (obstructed views)" and
// Margaritaville a "Partial View Balcony". The room still faces the sea, so `view` is unchanged —
// but `real_ocean` is the "is this a genuine sea view" flag, and the line has just said it is not.
// Found 2026-09-20: 84 such rooms across six ships were stored as clean ocean views.
const DISOWNED = /\(\s*obstructed views?\s*\)|\bpartial[- ]view\b|\bobstructed\b/i;

/** view + real_ocean, from the operator's own category name. */
export function viewOf(category: string | null): { view: string | null; real_ocean: boolean | null } {
  const attrs = cabinAttributes(category);
  // What the room LOOKS AT is decided before what it is: "Promenade View Interior" is an
  // interior category with a real window onto the promenade.
  for (const [re, v] of INWARD) if (re.test(category ?? "")) return { view: v, real_ocean: false };
  // "MSC Yacht Club Interior" carries BOTH suite and inside, and names no inward view.
  if (attrs.has("inside")) return { view: "none", real_ocean: false };
  if (attrs.has("balcony") || attrs.has("oceanview") || attrs.has("suite")) {
    return { view: "ocean", real_ocean: !DISOWNED.test(category ?? "") };
  }
  return { view: null, real_ocean: null };
}

/** The budget band, from the category alone. Deck nuance is deliberately NOT modelled. */
export function tierOf(category: string | null): number | null {
  const attrs = cabinAttributes(category);
  if (/\b(owner'?s|royal|presidential|villa)\b/i.test(category ?? "")) return 5;
  if (attrs.has("suite")) return 4;
  if (attrs.has("balcony")) return 3;
  if (attrs.has("oceanview")) return 2;
  if (attrs.has("inside")) return 1;
  return null;
}
