// GENERATED FILE - esbuild bundle of server/src/lib/cabin-match.ts. Regenerate, NEVER hand-edit.
// src/lib/cabin-match.ts
function normalizeAnswers(raw) {
  const r = raw ?? {};
  return {
    party: clean(r.party),
    room: asCabinType(r.room),
    budget: clean(r.budget),
    priority: clean(r.priority),
    seasick: r.motion === true || r.motion === "yes"
  };
}
function clean(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}
function asCabinType(v) {
  const s = clean(v);
  return s === "inside" || s === "oceanview" || s === "balcony" || s === "suite" ? s : null;
}
var ATTR_PATTERNS = [
  ["suite", /\b(suite|haven|yacht club|retreat|villa|penthouse|owner'?s)\b/i],
  ["balcony", /(balcon|veranda|terrace|infinite)/i],
  ["inside", /(interior|inside)/i],
  ["oceanview", /(ocean ?view|sea ?view|outside|window|porthole)/i]
];
var ATTR_ALIASES = {
  studio: ["inside"],
  // NCL solo cabin — interior, no window
  aquaclass: ["balcony"],
  // Celebrity — always a veranda category
  "grand terrace suite": ["suite", "balcony"],
  // Margaritaville — the Paradise ten
  // Celebrity's Concierge Class is a veranda tier, never sold windowless. Verified against the
  // grid 2026-08-19: all 3,250 rooms carrying the name sit on 14 ships, every one Celebrity.
  "concierge class": ["balcony"]
};
function cabinAttributes(category) {
  const c = clean(category);
  const out = /* @__PURE__ */ new Set();
  if (!c) return out;
  const alias = ATTR_ALIASES[c.toLowerCase()];
  if (alias) {
    for (const a of alias) out.add(a);
    return out;
  }
  for (const [type, re] of ATTR_PATTERNS) if (re.test(c)) out.add(type);
  return out;
}
function satisfies(category, want) {
  return cabinAttributes(category).has(want);
}
function classifyCategory(category) {
  const a = cabinAttributes(category);
  if (!a.size) return null;
  for (const t of ["suite", "balcony", "oceanview", "inside"]) if (a.has(t)) return t;
  return null;
}
function shipTypeInventory(categoryCounts) {
  const out = { inside: 0, oceanview: 0, balcony: 0, suite: 0, unknown: 0 };
  for (const [name, n] of Object.entries(categoryCounts ?? {})) {
    const attrs = cabinAttributes(name);
    const count = Number(n) || 0;
    if (!attrs.size) {
      out.unknown += count;
      continue;
    }
    for (const t of attrs) out[t] += count;
  }
  return out;
}
var ARCHETYPE_TAGS = {
  // Deliberately NOT tagged "balcony": it recommends Ocean View cabins, and
  // carrying the balcony tag let it beat the real balcony archetype on a tie —
  // Mark asked for coffee on the balcony and was handed ocean-view rooms (8/16).
  "first-couple-ocean-steady": ["couple", "middle", "ocean", "steady", "oceanview"],
  "couple-ocean-balcony-treat": ["couple", "treat", "ocean", "balcony"],
  "anniversary-suite-splurge": ["couple", "sky", "treat", "space", "suite"],
  "family-action-boardwalk": ["family", "middle", "action", "balcony"],
  "family-value-space": ["family", "lean", "space", "inside", "oceanview"],
  "quiet-retirees-calm": ["couple", "quiet", "middle", "balcony"],
  "value-hunter-ocean": ["lean", "ocean", "oceanview", "inside"],
  "solo-first-value": ["solo", "lean", "inside", "oceanview"],
  "solo-with-group": ["solo-group"],
  "big-group-together": ["group", "space"],
  "experienced-ocean-midship": ["couple", "ocean", "middle", "steady", "balcony"],
  "seasick-priority-steady": ["steady", "quiet"]
};
function pickArchetype(rows, a) {
  if (!rows.length) return null;
  const want = new Set(
    [a.party ?? "", a.room ?? "", a.budget ?? "", a.priority ?? "", a.seasick ? "steady" : ""].filter(Boolean)
  );
  let best = rows[0].archetype_id;
  let bestScore = -1;
  for (const r of rows) {
    const tags = ARCHETYPE_TAGS[r.archetype_id] ?? r.archetype_id.split("-");
    let score = 0;
    for (const t of tags) if (want.has(t)) score += 1;
    if (a.party && tags.includes(a.party)) score += 2;
    if (a.room && tags.includes(a.room)) score += 2;
    if (a.seasick && tags.includes("steady")) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = r.archetype_id;
    }
  }
  return best;
}
function selectCabins(opts) {
  const { chosenArchetypeId, answers, inventory, knownCabins } = opts;
  const limit = opts.limit ?? 5;
  const asked = answers.room;
  const zones = opts.zones ?? [];
  const dropped = [];
  const pool = knownCabins ? opts.pool.filter((c) => knownCabins.has(c.cabin) || (dropped.push(c.cabin), false)) : opts.pool;
  const decks = pool.map((c) => c.deck).filter((d) => typeof d === "number");
  const lowDeck = decks.length ? Math.min(...decks) : 0;
  const highDeck = decks.length ? Math.max(...decks) : 0;
  const deckSpan = Math.max(highDeck - lowDeck, 1);
  const movesFor = (c) => {
    if (!answers.seasick) return 0;
    let m = 0;
    const section = String(c.section ?? "").toLowerCase();
    if (section === "forward" || section === "aft") m += 2;
    else if (section === "midship" || section === "mid") m -= 1;
    if (typeof c.deck === "number") m += 2 * ((c.deck - lowDeck) / deckSpan);
    if (zones.length) {
      const hit = zonesForCabin(
        { deck: c.deck ?? null, section: c.section ?? null, side: c.side ?? null, category: c.category },
        zones
      ).filter((z) => z.factor === "motion");
      for (const z of hit) {
        const sign = zoneSign(z);
        if (sign === "neutral") continue;
        const w = z.severity === "significant" ? 3 : z.severity === "moderate" ? 2 : 1;
        m += sign === "benefit" ? -w : w;
      }
    }
    return Math.round(m * 100) / 100;
  };
  const NOISE_FACTORS = /* @__PURE__ */ new Set(["above", "below", "engine", "elevator", "i95", "crew"]);
  const penaltyCache = /* @__PURE__ */ new Map();
  const placementPenalty = (c) => {
    const hit = penaltyCache.get(c.cabin);
    if (hit !== void 0) return hit;
    let score = 0;
    if (zones.length) {
      const applicable = zonesForCabin(
        { deck: c.deck ?? null, section: c.section ?? null, side: c.side ?? null, category: c.category },
        zones
      );
      for (const z of applicable) {
        const sign = zoneSign(z);
        if (sign === "neutral") continue;
        const base = z.severity === "significant" ? 6 : z.severity === "moderate" ? 3 : 1;
        const trust = z.confidence === "high" ? 1 : z.confidence === "medium" ? 0.7 : 0.4;
        if (sign === "benefit") {
          const matters = answers.priority === "ocean" && VIEW_FACTORS.has(z.factor) || answers.priority === "quiet" && NOISE_FACTORS.has(z.factor);
          score -= 4 * trust * (matters ? 2 : 1);
          continue;
        }
        let weight = 1;
        if (answers.priority === "ocean" && VIEW_FACTORS.has(z.factor)) weight = 2;
        if (answers.priority === "quiet" && NOISE_FACTORS.has(z.factor)) weight = 2;
        score += base * trust * weight;
      }
    }
    if (c.aboveKind === "open") score += answers.priority === "quiet" ? 6 : 2.5;
    if (c.belowKind === "open") score += answers.priority === "quiet" ? 4 : 1.5;
    if (c.noiseNearby) score += answers.priority === "quiet" ? 7 : 3;
    if (c.realOcean === false) score += answers.priority === "ocean" ? 8 : 2;
    if (c.obstruction) {
      const base = /^heavy/i.test(c.obstruction) ? 6 : 3;
      score += base * (answers.priority === "ocean" ? 2 : 1);
    }
    const rounded = Math.round(score * 10) / 10;
    penaltyCache.set(c.cabin, rounded);
    return rounded;
  };
  const rank = (list) => {
    const scored = list.map((c) => ({
      c,
      // Steadiness outranks everything: someone who said they get seasick should
      // not be led with a bow cabin on deck 17 because some other signal liked it.
      moves: movesFor(c),
      // Then the ship's own facts — what the research says sits around the room.
      // This is what lets EVERY cabin compete, not just pre-picked ones.
      pen: placementPenalty(c),
      // Only then the pre-written reasoning, as a tie-break among equals: a room
      // an advisor already thought about is a slightly safer lead. It orders
      // candidates; it never decides which ones are allowed.
      arch: c.archetypeId && c.archetypeId === chosenArchetypeId ? 0 : c.archetypeId ? 1 : 2,
      rk: c.rank ?? 99
    }));
    scored.sort((a, b) => a.moves - b.moves || a.pen - b.pen || a.arch - b.arch || a.rk - b.rk || a.c.cabin.localeCompare(b.c.cabin));
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const s of scored) {
      if (seen.has(s.c.cabin)) continue;
      seen.add(s.c.cabin);
      out.push(s.c);
      if (out.length === limit) break;
    }
    return out;
  };
  if (!pool.length) return { picks: [], asked, outcome: "no-data", dropped };
  if (!asked) return { picks: rank(pool), asked: null, outcome: "no-request", dropped };
  const survivors = pool.filter((c) => satisfies(c.category, asked));
  if (survivors.length) return { picks: rank(survivors), asked, outcome: "exact", dropped };
  const knowsItsCabins = inventory.inside + inventory.oceanview + inventory.balcony + inventory.suite > 0;
  const outcome = !knowsItsCabins ? "type-unknown" : inventory[asked] > 0 ? "none-researched" : !opts.lineTypes ? "type-not-mapped" : opts.lineTypes.includes(asked) ? "none-researched" : "ship-has-none";
  return { picks: rank(pool), asked, outcome, dropped };
}
function zoneSign(z) {
  return z.sign ?? "penalty";
}
function normSection(s) {
  const v = String(s ?? "").trim().toLowerCase();
  if (v === "fwd" || v === "forward") return "forward";
  if (v === "mid" || v === "midship" || v === "middle") return "mid";
  if (v === "aft") return "aft";
  return null;
}
var VIEW_FACTORS = /* @__PURE__ */ new Set(["lifeboat", "taper", "obstruction"]);
function zonesForCabin(cabin, zones) {
  const deck = cabin.deck;
  const section = normSection(cabin.section);
  const side = String(cabin.side ?? "").trim().toLowerCase() || null;
  const type = classifyCategory(cabin.category);
  if (deck == null) return [];
  const rank = { significant: 0, moderate: 1, minor: 2 };
  return zones.filter((z) => {
    if (!z.decks.includes(deck)) return false;
    if (z.sections.length && (!section || !z.sections.includes(section))) return false;
    if (z.sides.length && (!side || !z.sides.includes(side))) return false;
    if (VIEW_FACTORS.has(z.factor) && (type === null || type === "inside")) return false;
    return true;
  }).sort((a, b) => rank[a.severity] - rank[b.severity]);
}
var CONF = { high: 0.9, medium: 0.6, low: 0.3 };
function viewVerdict(cabin, zones, lang = "en") {
  const applicable = zonesForCabin(cabin, zones).filter((z) => zoneSign(z) === "penalty");
  const es = lang === "es";
  if (!applicable.length) {
    return { headline: null, detail: [], zones: [], confidence: 0 };
  }
  const worst = applicable[0];
  const confidence = CONF[worst.confidence];
  const viewish = applicable.filter((z) => VIEW_FACTORS.has(z.factor));
  const noise = applicable.filter((z) => ["above", "below", "engine", "elevator", "i95"].includes(z.factor));
  const motion = applicable.filter((z) => z.factor === "motion");
  const detail = [];
  let headline = null;
  if (viewish.length) {
    headline = es ? "Algo puede aparecer en tu vista" : "Something may sit in your view";
    detail.push(es ? "Por lo que hay afuera de esa ventana, tu vista puede verse afectada. Esto es lo que hay:" : "Based on what sits outside that window, your view may be affected. Here's what's there:");
    for (const z of viewish.slice(0, 2)) {
      const t = es ? z.whatEs ?? z.what : z.what;
      if (t) detail.push(t);
    }
  }
  if (noise.length) {
    headline ??= es ? "Vale saber qu\xE9 tienes cerca" : "Worth knowing what's near you";
    for (const z of noise.slice(0, 2)) {
      const t = es ? z.effectEs ?? z.effect : z.effect;
      if (t) detail.push(t);
    }
  }
  if (motion.length && !viewish.length && !noise.length) {
    headline = es ? "Notar\xE1s m\xE1s movimiento aqu\xED" : "You'll feel more movement here";
    for (const z of motion.slice(0, 1)) {
      const t = es ? z.effectEs ?? z.effect : z.effect;
      if (t) detail.push(t);
    }
  }
  if (confidence < 0.5) {
    detail.push(es ? "T\xF3malo como una orientaci\xF3n: en este barco la informaci\xF3n es parcial." : "Treat that as a steer rather than the last word \u2014 what we have on this ship is partial.");
  }
  return { headline, detail, zones: applicable, confidence };
}
var TYPE_WORDS = {
  inside: { en: "interior cabins", es: "camarotes interiores" },
  oceanview: { en: "ocean-view cabins", es: "camarotes con vista al mar" },
  balcony: { en: "balcony cabins", es: "camarotes con balc\xF3n" },
  suite: { en: "suites", es: "suites" }
};
function selectionNote(sel, shipName, lang = "en") {
  if (sel.outcome === "exact" || sel.outcome === "no-request") return null;
  const es = lang === "es";
  if (sel.outcome === "no-data") {
    return es ? `Todav\xEDa no tengo los camarotes de ${shipName} cargados, y no voy a mandarte los de otro barco. Dime qu\xE9 salida te interesa y lo reviso a mano.` : `I don't have ${shipName}'s cabins loaded yet, and I'm not going to show you another ship's. Tell me the sailing you're looking at and I'll go through it by hand.`;
  }
  if (!sel.asked) return null;
  const w = TYPE_WORDS[sel.asked][lang];
  switch (sel.outcome) {
    case "ship-has-none":
      return es ? `Antes que nada: ${shipName} no tiene ${w}. No es un detalle que se nos escap\xF3 \u2014 ese barco se construy\xF3 as\xED. Esto es lo que s\xED elegir\xEDa a bordo.` : `First things first \u2014 ${shipName} doesn't have ${w}. That's not something we missed, it's how the ship was built. Here's what I'd pick on it instead.`;
    case "none-researched":
      return es ? `${shipName} s\xED tiene ${w}, pero todav\xEDa no he estudiado cu\xE1les valen la pena en ese barco, y no voy a inventarlo. Mientras tanto, estos son los que s\xED conozco \u2014 o dime y lo reviso a mano.` : `${shipName} does have ${w} \u2014 I just haven't done the room-by-room work on them for this ship yet, and I'm not going to guess. These are the ones I do know. Or say the word and I'll go through them by hand.`;
    case "type-not-mapped":
      return es ? `Todav\xEDa no tengo ${w} mapeados en ${shipName}, y no te voy a decir que el barco no los tiene cuando no he revisado cubierta por cubierta. Estos son los que s\xED puedo respaldar \u2014 o dime y lo reviso a mano.` : `I haven't got any ${w} mapped on ${shipName} yet \u2014 and I'm not going to tell you the ship hasn't got them when I haven't been through it deck by deck. These are the ones I can vouch for. Or say the word and I'll go through it by hand.`;
    case "type-unknown":
      return es ? `Todav\xEDa no tengo el detalle de categor\xEDas de ${shipName}, as\xED que no puedo confirmar cu\xE1les son ${w}. Prefiero dec\xEDrtelo a mandarte al camarote equivocado.` : `I don't have the category detail for ${shipName} yet, so I can't confirm which of these are ${w}. I'd rather tell you that than send you to the wrong room.`;
    default:
      return null;
  }
}
var SEVERITY_RANK = { significant: 0, moderate: 1, minor: 2 };
function buildSteerClear(opts) {
  const { candidates, picked, answers, zones } = opts;
  const lang = opts.lang ?? "en";
  const limit = opts.limit ?? 3;
  const asked = opts.servedType ?? answers.room;
  const already = new Set(picked);
  const out = [];
  for (const c of candidates) {
    if (already.has(c.cabin)) continue;
    if (asked && !satisfies(c.category, asked)) continue;
    const hits = zonesForCabin(
      { deck: c.deck ?? null, section: c.section ?? null, side: c.side ?? null, category: c.category },
      zones
    );
    if (!hits.length) continue;
    const relevant = answers.seasick ? hits.find((z) => z.factor === "motion") ?? hits[0] : hits[0];
    const where = [
      c.deck != null ? lang === "es" ? `Cubierta ${c.deck}` : `Deck ${c.deck}` : null,
      normSection(c.section)
    ].filter(Boolean).join(" ");
    const body = relevant.effect || relevant.what || "";
    out.push({
      cabin: c.cabin,
      deck: c.deck ?? null,
      section: normSection(c.section),
      category: c.category,
      reason: where ? `${where}. ${body}` : body,
      factor: relevant.factor,
      severity: relevant.severity,
      source: relevant.source
    });
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.cabin.localeCompare(b.cabin)).filter((e, i, arr) => arr.findIndex((o) => o.cabin === e.cabin) === i).slice(0, limit);
}
function zoneDecks(zones) {
  return [...new Set(zones.flatMap((z) => z.decks))].sort((a, b) => a - b);
}
var CITES_A_SOURCE = /(tripadvisor|cruise ?critic|reddit|a reviewer|reviewers|forum|poster|thread|blog|(cruisers|guests|passengers|travell?ers|people)\s+(consistently\s+|often\s+|frequently\s+)?(report|complain|say|mention))/i;
var BLAMES_THE_LINE = /(undisclosed|did ?n['’]?t tell|do ?n['’]?t tell|mislabel|misclassif|hid |hiding|they wo ?n['’]?t tell|fails? to disclose)/i;
var BROCHURE = /(best match|perfect for|boasts|nestled|ideally (positioned|situated)|look no further|exactly what you['’]re after)/i;
function validateSteerProse(text, f, alsoAllowed = []) {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  if (t.length > 220) return null;
  if (CITES_A_SOURCE.test(t)) return null;
  if (BLAMES_THE_LINE.test(t)) return null;
  if (BROCHURE.test(t)) return null;
  if (/\d+\s*%|confidence/i.test(t)) return null;
  for (const m of t.matchAll(/\bdeck\s+(\d{1,2})\b/gi)) {
    if (f.deck == null || Number(m[1]) !== f.deck) return null;
  }
  const allowed = /* @__PURE__ */ new Set([f.cabin.toUpperCase(), ...alsoAllowed.map((c) => c.toUpperCase())]);
  const withoutDecks = t.replace(/\bdeck\s+\d{1,2}\b/gi, " ");
  for (const m of withoutDecks.matchAll(/\b[A-Z]{0,2}\d{2,5}[A-Z]?\b/gi)) {
    if (!allowed.has(m[0].toUpperCase())) return null;
  }
  return t;
}
var FACTOR_LINE = {
  lifeboat: {
    en: "A lifeboat sits in the sightline below this one, so the view down is blocked even though the horizon isn't.",
    es: "Un bote salvavidas queda en la l\xEDnea de visi\xF3n, as\xED que pierdes la vista hacia abajo aunque el horizonte siga ah\xED."
  },
  above: {
    en: "There's an activity deck directly overhead, and that noise carries down more than people expect.",
    es: "Justo arriba hay una cubierta de actividades, y ese ruido baja m\xE1s de lo que la gente espera."
  },
  below: {
    en: "There's a lounge or public room directly underneath, which tends to run later than you'd like.",
    es: "Justo debajo hay un sal\xF3n o \xE1rea p\xFAblica, y suele terminar m\xE1s tarde de lo que te gustar\xEDa."
  },
  engine: {
    en: "You're near the engine spaces here, so expect a low hum and some vibration at night.",
    es: "Est\xE1s cerca de la sala de m\xE1quinas, as\xED que espera un zumbido bajo y algo de vibraci\xF3n de noche."
  },
  elevator: {
    en: "This one sits close to the lifts, which means foot traffic and conversation at odd hours.",
    es: "Queda cerca de los ascensores: paso de gente y conversaci\xF3n a horas raras."
  },
  i95: {
    en: "The crew corridor runs behind this stretch, and it's busiest when you're trying to sleep.",
    es: "El pasillo de la tripulaci\xF3n corre por detr\xE1s, y es m\xE1s activo justo cuando quieres dormir."
  },
  // Placement, not stomachs — true for every traveller, phrased for the one who
  // never mentioned seasickness.
  motion: {
    en: "This is one of the ends of the ship, so you feel the sea working more here than you would midship.",
    es: "Est\xE1s en una punta del barco, as\xED que sientes m\xE1s el trabajo del mar que en el centro."
  },
  taper: {
    en: "The hull narrows here, so the balcony is a shallower slice than the same category elsewhere.",
    es: "El casco se angosta aqu\xED, as\xED que el balc\xF3n es m\xE1s estrecho que en la misma categor\xEDa en otra zona."
  },
  // Said as the good news it is. This line used to hedge — "changes what you can actually
  // see" — while sitting under a headline that called it an obstruction.
  hump: {
    en: "The hull steps out along this stretch, so the balcony is deeper than the same category elsewhere and you can see past the lifeboat line straight down to the water.",
    es: "El casco sobresale en este tramo, as\xED que el balc\xF3n es m\xE1s profundo que en la misma categor\xEDa en otra zona y puedes ver m\xE1s all\xE1 de los botes, directo al agua."
  },
  other: {
    en: "There's something about this stretch of the ship worth knowing before you commit to it.",
    es: "Hay algo en este tramo del barco que conviene saber antes de decidirte."
  }
};
function plainSteerLine(f, lang = "en") {
  const where = [f.deck != null ? lang === "es" ? `Cubierta ${f.deck}` : `Deck ${f.deck}` : null, f.section].filter(Boolean).join(" ");
  const raw = (f.what ?? "").trim();
  const rawOk = raw && raw.length <= 180 && !CITES_A_SOURCE.test(raw) && !BLAMES_THE_LINE.test(raw) && ![...raw.matchAll(/\bdeck\s+(\d{1,2})\b/gi)].some((m) => f.deck == null || Number(m[1]) !== f.deck) && ![...raw.matchAll(/\b\d{3,5}[A-Z]?\b/g)].some((m) => m[0] !== f.cabin);
  const body = rawOk ? raw : (FACTOR_LINE[f.factor] ?? FACTOR_LINE["other"])[lang];
  return where ? `${where}. ${body}` : body;
}
function steerPromptFacts(entries) {
  return JSON.stringify(entries.map((f) => ({
    cabin: f.cabin,
    deck: f.deck,
    section: f.section,
    category: f.category,
    whatIsThere: f.what,
    howBad: f.severity
  })));
}
export {
  ARCHETYPE_TAGS,
  buildSteerClear,
  cabinAttributes,
  classifyCategory,
  normSection,
  normalizeAnswers,
  pickArchetype,
  plainSteerLine,
  satisfies,
  selectCabins,
  selectionNote,
  shipTypeInventory,
  steerPromptFacts,
  validateSteerProse,
  viewVerdict,
  zoneDecks,
  zoneSign,
  zonesForCabin
};
