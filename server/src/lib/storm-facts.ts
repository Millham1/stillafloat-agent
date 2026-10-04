// storm-facts.ts — the geometry a storm alert needs, worked out in CODE.
//
// Why (2026-10-03): the draft prompt used to hand the model a raw heading in degrees
// ("100 at 17 kt"), a bare lat/lon, and the name of a cruising ground — and left it to
// work out the compass direction, how far away the storm is, and whether it is coming
// or going. Claude managed; the local model did not: on six real storms it called a
// 100° heading "northeast", described storms 900+ miles out and moving away as
// "approaching", and filled the gaps with forecasts nobody gave it. A model should
// never be doing arithmetic on a subscriber alert. Everything here is a pure function;
// the prompt repeats the result.

import { CRUISE_LOCATIONS } from "./ports";
import { REGION_LABELS, type RegionKey } from "./storm-grounds";

const COMPASS_16 = [
  "north", "north-northeast", "northeast", "east-northeast",
  "east", "east-southeast", "southeast", "south-southeast",
  "south", "south-southwest", "southwest", "west-southwest",
  "west", "west-northwest", "northwest", "north-northwest",
] as const;
const ABBREV_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"] as const;

/** 0–360° heading → the 16-point compass word NHC itself uses ("west-northwest"). */
export function compassWord(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  return COMPASS_16[Math.round(d / 22.5) % 16]!;
}

/** "WNW" → 292.5. Null for anything that is not a 16-point abbreviation. */
export function abbrevToDeg(abbrev: string): number | null {
  const i = ABBREV_16.indexOf(abbrev.toUpperCase() as (typeof ABBREV_16)[number]);
  return i < 0 ? null : i * 22.5;
}

/** Knots → mph, to the nearest 5 — the way NHC prints wind speeds (80 kt → 90 mph). */
export function ktToMph(kt: number): number {
  return Math.round((kt * 1.15078) / 5) * 5;
}

const R_MILES = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in statute miles. */
export function milesBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.sqrt(h));
}

/** Initial great-circle bearing from A to B, 0–360°. */
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const y = Math.sin(rad(bLon - aLon)) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLon - aLon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** A round figure a person would say: nearest 10 under 100 miles, nearest 50 above. */
export function roundMiles(mi: number): number {
  return mi < 100 ? Math.max(10, Math.round(mi / 10) * 10) : Math.round(mi / 50) * 50;
}

export interface Anchor { name: string; lat: number; lon: number; }

// The ports a reader thinks of when they hear the region's name. Distances are measured to
// these, not to the region's bounding box: the boxes in storm-grounds.ts are deliberately
// generous (they decide who gets an alert), so "300 miles from the Canada & New England box"
// can be 900 miles from Halifax. Slugs resolve through the site's own gazetteer (ports.ts);
// the few ports it lacks carry coordinates from Open-Meteo's geocoder (looked up 2026-10-03).
const REGION_ANCHOR_SLUGS: Record<RegionKey, string[]> = {
  e_caribbean: ["san-juan", "st-thomas", "tortola", "st-maarten", "st-kitts", "antigua", "st-lucia", "barbados"],
  w_caribbean: ["cozumel", "costa-maya", "belize-city", "roatan", "grand-cayman", "montego-bay", "falmouth-jamaica", "ocho-rios"],
  bahamas: ["nassau", "cococay", "great-stirrup", "halfmoon-cay", "princess-cays", "grand-turk"],
  gulf: ["galveston", "new-orleans", "tampa", "key-west"],
  bermuda: ["bermuda"],
  us_east_coast: ["miami", "fort-lauderdale", "port-canaveral", "jacksonville", "charleston-sc", "norfolk", "baltimore", "new-york"],
  mexican_riviera: ["cabo-san-lucas", "puerto-vallarta", "ensenada"],
  hawaii: ["honolulu"],
  canada_new_england: ["boston"],
  alaska: ["seattle", "vancouver", "victoria-bc", "ketchikan", "juneau", "skagway", "sitka"],
};
const EXTRA_ANCHORS: Partial<Record<RegionKey, Anchor[]>> = {
  bahamas: [{ name: "Freeport, Bahamas", lat: 26.53, lon: -78.7 }],
  gulf: [{ name: "Progreso, Mexico", lat: 21.28, lon: -89.66 }],
  mexican_riviera: [{ name: "Mazatlán, Mexico", lat: 23.22, lon: -106.42 }],
  hawaii: [
    { name: "Hilo, Hawaii", lat: 19.73, lon: -155.09 },
    { name: "Kona, Hawaii", lat: 19.64, lon: -156.0 },
    { name: "Kahului, Maui", lat: 20.89, lon: -156.47 },
    { name: "Nawiliwili, Kauai", lat: 21.98, lon: -159.37 },
  ],
  canada_new_england: [
    { name: "Portland, Maine", lat: 43.66, lon: -70.26 },
    { name: "Bar Harbor, Maine", lat: 44.39, lon: -68.2 },
    { name: "Saint John, New Brunswick", lat: 45.27, lon: -66.06 },
    { name: "Halifax, Nova Scotia", lat: 44.64, lon: -63.58 },
    { name: "Sydney, Nova Scotia", lat: 46.14, lon: -60.18 },
    { name: "Quebec City", lat: 46.81, lon: -71.21 },
  ],
  alaska: [{ name: "Seward, Alaska", lat: 60.1, lon: -149.44 }],
};

/** Anchor ports for one cruising ground. Unknown grounds → []. */
export function anchorsFor(region: string): Anchor[] {
  const slugs = REGION_ANCHOR_SLUGS[region as RegionKey] ?? [];
  const fromGazetteer = slugs.flatMap((slug) => {
    const loc = CRUISE_LOCATIONS.find((l) => l.slug === slug);
    return loc ? [{ name: loc.name, lat: loc.lat, lon: loc.lon }] : [];
  });
  return [...fromGazetteer, ...(EXTRA_ANCHORS[region as RegionKey] ?? [])];
}

export type Motion = "toward" | "away" | "across" | "unknown";

export interface GroundRelation {
  region: string;
  label: string;
  port: string;            // nearest anchor port
  miles: number;           // rounded, storm centre → that port
  stormIs: string;         // where the storm sits relative to the port: "southeast"
  motion: Motion;          // present motion relative to that port
}

/**
 * Present motion relative to a port. The angle between the heading and the bearing to the
 * port decides how fast the gap is closing (its cosine): within 60° the storm is closing at
 * better than half its speed — "toward"; beyond 120° it is opening at better than half its
 * speed — "away"; between the two it is sliding past — "across". This describes the motion
 * NOW — it is not a forecast, and the fact line says so.
 */
export function motionRelative(headingDeg: number | null, bearingToPort: number): Motion {
  if (headingDeg == null) return "unknown";
  const diff = Math.abs(((headingDeg - bearingToPort + 540) % 360) - 180);
  if (diff <= 60) return "toward";
  if (diff >= 120) return "away";
  return "across";
}

/** For each affected ground: the nearest anchor port, how far, which way, and the motion. */
export function relateToGrounds(
  lat: number, lon: number, headingDeg: number | null, grounds: string[],
): GroundRelation[] {
  const out: GroundRelation[] = [];
  for (const region of grounds) {
    const anchors = anchorsFor(region);
    if (!anchors.length) continue;
    let best = anchors[0]!, bestMi = Infinity;
    for (const a of anchors) {
      const mi = milesBetween(lat, lon, a.lat, a.lon);
      if (mi < bestMi) { best = a; bestMi = mi; }
    }
    out.push({
      region,
      label: REGION_LABELS[region as RegionKey] ?? region,
      port: best.name,
      miles: roundMiles(bestMi),
      stormIs: compassWord(bearingDeg(best.lat, best.lon, lat, lon)),
      motion: motionRelative(headingDeg, bearingDeg(lat, lon, best.lat, best.lon)),
    });
  }
  return out;
}

const MOTION_TEXT: Record<Motion, string> = {
  toward: "moving TOWARD it right now",
  away: "moving AWAY from it right now",
  across: "moving past it right now (neither straight toward it nor away)",
  unknown: "direction of travel not given",
};

/** One fact line per ground, written so the model can repeat it without doing any maths. */
export function relationLines(rels: GroundRelation[]): string[] {
  return rels.map((r) =>
    `Distance — ${r.label}: the centre is about ${r.miles.toLocaleString("en-US")} miles ${r.stormIs} of ${r.port} ` +
    `(nearest major cruise port there), ${MOTION_TEXT[r.motion]}.`);
}

/**
 * Heading in degrees from whatever the source gave: a number from the NHC feed, or the
 * leading compass abbreviation of an NWS marine movement string ("E at 5 kt").
 */
export function headingFrom(movementDeg: number | null | undefined, movementText: string | null | undefined): number | null {
  if (movementDeg != null && Number.isFinite(movementDeg)) return movementDeg;
  const m = /^\s*([NSEW]{1,3})\b/i.exec(movementText ?? "");
  return m ? abbrevToDeg(m[1]!) : null;
}

/** "80 kt" → "maximum sustained winds 80 kt (about 90 mph)". Anything else passes through. */
export function intensityLine(intensity: string): string {
  const m = /^(\d+)\s*kt$/i.exec(intensity.trim());
  return m ? `maximum sustained winds ${m[1]} kt (about ${ktToMph(Number(m[1]))} mph)` : intensity;
}

/**
 * The verdict, decided in code so the model never has to weigh distance against direction
 * (when the thresholds lived in the prompt, the local model quoted them to readers: "well
 * beyond the 500-mile threshold"). One line, in words a subscriber could be told directly.
 *   CLOSE  — within ~300 miles of a cruise port and not leaving, or marine warnings are in
 *            force over the grounds: itinerary changes are possible.
 *   WATCH  — heading toward, or sliding past, a ground from farther out: nothing to do yet.
 *   QUIET  — moving away from every listed ground: nothing to do.
 */
export type Verdict = "close" | "watch" | "quiet";
export function bottomLine(rels: GroundRelation[], warningsInForce = false): { verdict: Verdict; line: string } | null {
  if (!rels.length) return null;
  const nearest = rels.slice().sort((a, b) => a.miles - b.miles)[0]!;
  if (warningsInForce) {
    return { verdict: "close", line: `Bottom line: marine warnings are in force over ${nearest.label} waters now. Rough seas and changed or delayed port calls are possible; the cruise line decides.` };
  }
  const closeOnes = rels.filter((r) => r.miles <= 300 && r.motion !== "away");
  if (closeOnes.length) {
    const c = closeOnes.sort((a, b) => a.miles - b.miles)[0]!;
    return { verdict: "close", line: `Bottom line: the storm is within about ${c.miles.toLocaleString("en-US")} miles of ${c.port} and is not moving away. Itinerary changes in ${c.label} are possible; the cruise line decides.` };
  }
  if (rels.every((r) => r.motion === "away")) {
    return { verdict: "quiet", line: `Bottom line: the storm is moving away from ${rels.map((r) => r.label).join(" and ")}. Nothing for cruisers to do; do not tell readers to expect itinerary changes.` };
  }
  const w = rels.filter((r) => r.motion !== "away").sort((a, b) => a.miles - b.miles)[0]!;
  return { verdict: "watch", line: `Bottom line: the storm is still about ${w.miles.toLocaleString("en-US")} miles from ${w.port}. Worth watching, nothing to do yet; do not tell readers to expect itinerary changes.` };
}

const FORECAST_RE = /\b(?:is|are|was)?\s*(?:not\s+)?(?:expected|forecast|predicted|projected|likely|anticipated)\s+to\b|\bwill\s+(?:strengthen|weaken|intensify|dissipate|turn|make landfall|bring)\b|\bcould\s+(?:strengthen|intensify)\b|\blandfall\b|\bouter bands\b|\bin the coming days\b|\bover the next\b|\bthreshold\b|\b(?:will|won't|will not)\s+(?:not\s+)?(?:affect|impact|disrupt)\b/gi;

/**
 * Read a finished draft against the facts it was written from and list what does not match.
 * Two checks, both aimed at what the local model got wrong on 2026-10-03:
 *  1. a direction word describing the storm's MOTION that is not the Movement fact's word;
 *  2. forecast language when no forecast text was supplied.
 * An empty list means nothing was caught — not that the draft is right; Mark still reviews it.
 */
export function checkDraft(
  draft: { headline: string; body_md: string },
  facts: { motionWord: string | null; hasForecastText: boolean },
): string[] {
  const text = `${draft.headline}\n${draft.body_md}`;
  const problems: string[] = [];
  if (facts.motionWord) {
    const allowed = new Set([facts.motionWord, ...facts.motionWord.split("-")].map((w) => w.toLowerCase()));
    // Only motion phrases are checked: "moving X", "X track", "heading X", "tracking X".
    // A bearing ("850 miles southeast of Sydney") is a different fact and is left alone.
    const motionRe = /\b(?:moving|heading|tracking|travell?ing|drifting)\s+(?:to\s+the\s+)?([a-z-]+)|\b(?:on\s+an?|its)\s+([a-z-]+)\s+(?:track|path|course|heading)\b/gi;
    for (const m of text.matchAll(motionRe)) {
      const word = (m[1] ?? m[2] ?? "").toLowerCase().replace(/(?:ward|erly|ern)$/, "");
      if (!/^(?:north|south|east|west)/.test(word)) continue;
      if (!allowed.has(word) && word !== facts.motionWord.toLowerCase()) {
        problems.push(`says the storm is moving "${word}" but the Movement fact says "${facts.motionWord}"`);
      }
    }
  }
  if (!facts.hasForecastText) {
    const seen = new Set<string>();
    for (const m of text.matchAll(FORECAST_RE)) {
      const phrase = m[0].trim().toLowerCase();
      if (!seen.has(phrase)) { seen.add(phrase); problems.push(`forecast wording with no forecast given: "${m[0].trim()}"`); }
    }
  }
  return problems;
}
