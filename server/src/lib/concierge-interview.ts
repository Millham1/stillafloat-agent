// concierge-interview.ts — the question pools, and what the answers mean.
//
// These constants are the CANONICAL definition of the Room Concierge interview.
// room-concierge.html carries its own copy inline (it has to — it renders the
// questions), and cabin-match.test.ts parses the page and asserts the two are
// identical. That drift guard exists because the page and the server have
// already disagreed about an answer once, in the worst possible way: the page
// sends `motion` as a boolean, the server compared it to the string "yes", and
// for a day nobody who said "yes, keep us steady" was treated as seasick.
//
// The interview model is Mark's (2026-08-14): behavioural, never
// self-description — remembered behaviour, forced tradeoffs, and projection
// ("what annoys you about other travellers" is a fingerprint of yourself).
// Options carry hidden trait weights and the type is INFERRED from the pattern.
// The visitor never sees a label. Do not revert to "which of these are you".

export type Traits = Record<string, number>;

export type Question = {
  key: string;
  /** [label, value] for the expectations tree; [label, traitWeights] for personality. */
  options: readonly { label: string; value?: string; traits?: Traits }[];
};

export const PERSONALITY_QS: readonly Question[] = [
  {
    key: "retell",
    options: [
      { label: "The meal I'm still chasing", traits: { food: 2, splurgeConsume: 1 } },
      { label: "The people we met — we still talk", traits: { social: 2, energy: 1 } },
      { label: "The thing we did that nobody back home believes", traits: { active: 2, energy: 1 } },
      { label: "That for one week, nobody could reach me", traits: { quiet: 2, introvert: 1 } },
    ],
  },
  {
    key: "photos",
    options: [
      { label: "Scenery. Not a human in frame", traits: { quiet: 2, introvert: 1 } },
      { label: "Us with people we'd just met", traits: { social: 2, extrovert: 2 } },
      { label: "Food and drinks, honestly", traits: { food: 2, splurgeConsume: 1 } },
      { label: "The kids having the time of their lives", traits: { family: 2 } },
    ],
  },
  {
    key: "wedding",
    options: [
      { label: "On the dance floor", traits: { energy: 2, extrovert: 1 } },
      { label: "Deep in a conversation that started at dinner", traits: { social: 1, introvert: 1 } },
      { label: "Gone. We said our goodbyes at 9:30", traits: { quiet: 2, introvert: 1 } },
      { label: "At the bar, making the bartender laugh", traits: { social: 2, energy: 1 } },
    ],
  },
  {
    key: "annoy",
    options: [
      { label: "They're loud everywhere they go", traits: { quiet: 2, crowdsAvoid: 2 } },
      { label: "They wing everything and it shows", traits: { planner: 2 } },
      { label: "They wait in lines they didn't have to", traits: { planner: 1, active: 1 } },
      { label: "They never leave the pool", traits: { active: 2 } },
    ],
  },
  {
    key: "overpay",
    options: [
      { label: "The view from the room", traits: { splurgeCabin: 2 } },
      { label: "One unforgettable dinner", traits: { splurgeConsume: 2, food: 1 } },
      { label: "The excursion everyone said was too expensive", traits: { active: 2, splurgeConsume: 1 } },
      { label: "Nothing. Getting the deal WAS the trip", traits: { value: 2, planner: 1 } },
    ],
  },
  {
    key: "tradeoff",
    options: [
      { label: "The quiet corner nobody else has found", traits: { quiet: 2, introvert: 2, crowdsAvoid: 1 } },
      { label: "The table where everybody knows your name", traits: { social: 2, extrovert: 2, crowdsLove: 1 } },
    ],
  },
];

export const EXPECT_QS: readonly Question[] = [
  {
    key: "destination",
    options: [
      { label: "Eastern Caribbean", value: "e_caribbean" },
      { label: "Western Caribbean", value: "w_caribbean" },
      { label: "Southern Caribbean", value: "s_caribbean" },
      { label: "The Bahamas", value: "bahamas" },
      { label: "Alaska", value: "alaska" },
      { label: "The Mediterranean", value: "mediterranean" },
      { label: "Mexican Riviera", value: "mexican_riviera" },
      { label: "Surprise me — anywhere the ship fits", value: "surprise" },
    ],
  },
  {
    key: "party",
    options: [
      { label: "Just the two of us", value: "couple" },
      { label: "Family with kids", value: "family" },
      { label: "Just me", value: "solo" },
      { label: "Solo, but traveling with a group", value: "solo-group" },
      { label: "A group of us", value: "group" },
    ],
  },
  {
    key: "room",
    options: [
      { label: "Crash and recharge", value: "inside" },
      { label: "Wake up to daylight and water", value: "oceanview" },
      { label: "Coffee outside in my pajamas", value: "balcony" },
      { label: "The room is part of the vacation", value: "suite" },
      // "no idea" resolves to balcony — the safe default, and the one most
      // first-timers turn out to want. It is still a REAL request downstream:
      // whatever this maps to, that is what the visitor must be served.
      { label: "Honestly, no idea — pick for me", value: "balcony" },
    ],
  },
  {
    key: "priority",
    options: [
      { label: "Waking up to the ocean", value: "ocean" },
      { label: "Peace and quiet", value: "quiet" },
      { label: "Being near the action", value: "action" },
      { label: "Room to spread out", value: "space" },
    ],
  },
  {
    key: "budget",
    options: [
      { label: "There's a number, and we respect it", value: "lean" },
      { label: "Comfortable, but every dollar should earn its spot", value: "middle" },
      { label: "For the right room, the budget moves", value: "treat" },
      { label: "The budget is whatever makes it perfect", value: "sky" },
    ],
  },
  {
    key: "motion",
    options: [
      { label: "Yes — keep us steady", value: "yes" },
      { label: "No, we're fine", value: "no" },
      { label: "I can grin and bear it", value: "no" },
    ],
  },
];

export type Axes = {
  energy: "party" | "quiet" | "social";
  social: "extrovert" | "introvert" | "mixed";
  structure: "planner" | "loose";
  splurge: "cabin" | "value" | "consumables";
  crowds: "avoids" | "loves-it" | "tolerates";
};

/** Deterministic and inspectable — a wrong ship suggestion must be traceable. */
export function inferAxes(traits: Traits): Axes {
  const t = (k: string) => traits[k] ?? 0;
  return {
    energy: t("energy") >= 3 ? "party" : t("quiet") >= 3 ? "quiet" : "social",
    social:
      t("extrovert") > t("introvert") + 1 ? "extrovert"
      : t("introvert") > t("extrovert") + 1 ? "introvert"
      : "mixed",
    structure: t("planner") >= 2 ? "planner" : "loose",
    splurge: t("splurgeCabin") >= 2 ? "cabin" : t("value") >= 2 ? "value" : "consumables",
    crowds:
      t("crowdsAvoid") >= 2 || t("quiet") >= 4 ? "avoids"
      : t("crowdsLove") >= 1 || t("energy") >= 3 ? "loves-it"
      : "tolerates",
  };
}

/** Sum the trait weights of one answer per personality question. */
export function traitsFor(choices: readonly number[]): Traits {
  const out: Traits = {};
  PERSONALITY_QS.forEach((q, i) => {
    const opt = q.options[choices[i] ?? 0];
    for (const [k, v] of Object.entries(opt?.traits ?? {})) out[k] = (out[k] ?? 0) + v;
  });
  return out;
}

/** Every combination of one answer per question. Used to sweep, not to sample. */
export function everyCombination(qs: readonly Question[]): number[][] {
  let acc: number[][] = [[]];
  for (const q of qs) {
    const next: number[][] = [];
    for (const prefix of acc) for (let i = 0; i < q.options.length; i++) next.push([...prefix, i]);
    acc = next;
  }
  return acc;
}
