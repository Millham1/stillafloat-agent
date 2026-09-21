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
  [/atrium/i, "atrium"],
];

/** view + real_ocean, from the operator's own category name. */
export function viewOf(category: string | null): { view: string | null; real_ocean: boolean | null } {
  const attrs = cabinAttributes(category);
  // What the room LOOKS AT is decided before what it is: "Promenade View Interior" is an
  // interior category with a real window onto the promenade.
  for (const [re, v] of INWARD) if (re.test(category ?? "")) return { view: v, real_ocean: false };
  // "MSC Yacht Club Interior" carries BOTH suite and inside, and names no inward view.
  if (attrs.has("inside")) return { view: "none", real_ocean: false };
  if (attrs.has("balcony") || attrs.has("oceanview") || attrs.has("suite")) {
    return { view: "ocean", real_ocean: true };
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
