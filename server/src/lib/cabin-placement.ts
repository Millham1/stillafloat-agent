// cabin-placement.ts — what a guest hears from THIS room, in their own language.
//
// Mark's architecture, 2026-08-18: the room database holds the facts and the advisor
// consumes them. These are the facts about a room's surroundings:
//   noise_nearby / noise_kind (migrations 0021, 0023) — the elevator lobby, stairwell or venue
//     within four rooms fore and aft, or across the corridor
//   above_kind / below_kind   (migration 0020)        — whether the deck above or below
//     carries cabins at this room's position, or is open public space
//
// Pure: no I/O, no database, no clock. Everything it says is traceable to one of those four
// columns, so it can be tested exhaustively — which matters, because this is the text a guest
// reads after typing their own room number in.
//
// SPANISH IS WRITTEN, NOT TRANSLATED. noise_kind carries a code precisely so each language
// renders its own words; an elevator lobby is "el vestíbulo de ascensores", not an English phrase
// sitting in a Spanish page. Venue names are proper nouns and stay as they are in both.

// The generic things a plan can put next to a room, in both languages. Anything not in here
// is a venue name — a proper noun, which stays exactly as printed in either language.
const GENERIC: Record<string, [string, string]> = {
  "elevator lobby": ["the elevator lobby", "el vestíbulo de ascensores"],
  "lift lobby": ["the elevator lobby", "el vestíbulo de ascensores"],   // rows written before 19 Aug
  "stairwell": ["the stairwell", "la escalera"],
  "guest laundry": ["the guest laundry", "la lavandería"],
  "crew access door": ["a crew access door", "una puerta de tripulación"],
  "machinery space": ["machinery", "maquinaria"],
  "galley": ["the galley", "la cocina"],
  "pool deck": ["the pool deck", "la cubierta de piscinas"],
  "kids club": ["the kids club", "el club infantil"],
  "fitness center": ["the fitness center", "el gimnasio"],
  "medical center": ["the medical center", "el centro médico"],
  "atrium": ["the atrium", "el atrio"],
  "theater": ["the theater", "el teatro"],
  "spa": ["the spa", "el spa"],
};

export type PlacementFacts = {
  noise_nearby?: string | null;
  noise_kind?: "lift" | "stairs" | "venue" | "venue-above" | "venue-below" | null;
  above_kind?: "cabins" | "open" | "unknown" | null;
  below_kind?: "cabins" | "open" | "unknown" | null;
};

export function placementLines(c: PlacementFacts, es = false): string[] {
  const out: string[] = [];

  const near = (c.noise_nearby ?? "").trim();
  if (near) {
    const k = c.noise_kind;
    // The prose lists everything that room hears, worst first — "lift lobby and stairwell and
    // guest laundry". Naming only the loudest throws away the most useful half (a guest
    // laundry next door is the thing you would want told), so every part is rendered: the
    // generic ones get their own Spanish words, venue names are proper nouns and stay put.
    const named = near.split(/\s+and\s+/).map((part) => GENERIC[part.toLowerCase()]?.[es ? 1 : 0] ?? part);
    const list = named.length > 1
      ? named.slice(0, -1).join(", ") + (es ? " y " : " and ") + named[named.length - 1]
      : named[0]!;
    out.push(
      k === "venue-above" ? (es
        ? `Justo encima de ti: ${list}.`
        : `Directly above you: ${list}.`)
      : k === "venue-below" ? (es
        ? `Justo debajo de ti: ${list}.`
        : `Directly below you: ${list}.`)
      : (es
        ? `A pocas puertas de la tuya, en la misma cubierta: ${list}.`
        : `A few doors from yours, on the same deck: ${list}.`));
    out.push(k === "lift" || k === "stairs"
      ? (es
        ? "Eso trae movimiento de pasillo temprano y tarde. A cambio, no cruzas medio barco cada vez que sales."
        : "That brings corridor traffic early and late. In exchange you aren't walking half the ship every time you leave.")
      : (es
        ? "Vale la pena saberlo si te acuestas temprano."
        : "Worth knowing if you turn in early."));
  }

  // Only "open" is spoken. "unknown" means we hold no grid for that deck, and a room with a
  // quiet neighbour above it must never be told otherwise on the strength of a gap in our data.
  if (c.above_kind === "open" && c.noise_kind !== "venue-above") out.push(es
    ? "Justo encima de ti no hay camarotes, sino espacio público. Suele significar sillas arrastrándose temprano por la mañana."
    : "Directly above you there are no cabins — that's public space. It usually means chairs scraping early in the morning.");
  if (c.below_kind === "open" && c.noise_kind !== "venue-below") out.push(es
    ? "Debajo tampoco hay camarotes. Ahí abajo suele haber cocina, salón o pasillo de tripulación."
    : "There are no cabins below you either. That's usually a galley, a lounge or a crew alleyway.");

  // Nothing to say is said by saying nothing. "Nothing is near you" would be a claim, and on a
  // deck whose plan has not been read yet it would be a false one.
  return out;
}

/**
 * What a guest is told about THIS room's own researched view finding — rendered from the
 * structured parts, never served raw.
 *
 * `cabins.obstruction` is research storage: a severity lead ("heavy:", "partial-low:",
 * "partial-side:") followed by prose that often cites its source ("CruiseMapper notes…",
 * "A first-person cabin review reports…"). Found in the 2026-08-19 audit: /check pushed that
 * string straight onto the page — 21,229 rooms would have been shown the literal text
 * "heavy: lifeboat", citations reached guests unedited, and the Spanish page got English.
 * The prose stays in the column for the reasoning model to draw on; the GUEST line is built
 * here, in the guest's language, from the parts we actually trust: the lead and the kind.
 */
export function obstructionLine(
  obstruction: string | null | undefined,
  viewBlocked: string | null | undefined,   // structured kind when known: "lifeboat" | "taper"
  es = false,
): string | null {
  const raw = (obstruction ?? "").trim();
  if (!raw) return null;
  const lead = raw.startsWith("heavy") ? "heavy"
             : raw.startsWith("partial-side") ? "partial-side"
             : raw.startsWith("partial-low") ? "partial-low" : "partial-low";
  const kind = (viewBlocked ?? "").trim().toLowerCase();

  if (kind === "lifeboat") {
    if (lead === "heavy") return es
      ? "Un bote salvavidas está justo afuera de esta ventana y tapa la mayor parte de la vista."
      : "A lifeboat sits right outside this window and takes up most of the view.";
    return es
      ? "Un bote salvavidas tapa la vista hacia abajo; el horizonte queda despejado."
      : "A lifeboat blocks the view straight down; the horizon stays open.";
  }
  if (kind === "taper") return es
    ? "El casco se estrecha en esta zona y recorta parte de la vista lateral."
    : "The hull narrows along this stretch and crops part of the side view.";

  // No structured kind — speak from the severity lead alone rather than serving the prose.
  if (lead === "heavy") return es
    ? "La estructura del barco tapa la mayor parte de la vista desde este camarote."
    : "The ship's structure blocks most of the view from this cabin.";
  if (lead === "partial-side") return es
    ? "Una estructura del barco recorta parte de la vista lateral."
    : "Part of the side view is cropped by the ship's structure.";
  return es
    ? "Algo (normalmente un bote salvavidas o parte del casco) tapa la vista hacia abajo; el horizonte queda libre."
    : "Something — usually a lifeboat or part of the hull — blocks the view straight down; the horizon stays clear.";
}
