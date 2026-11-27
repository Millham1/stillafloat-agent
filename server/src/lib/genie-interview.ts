// genie-interview.ts — the Vacation Genie interview: the questions, and what the answers mean.
//
// The Genie is the single-booking front door (Mark, 2026-11-24): interview the traveler, derive the ship,
// then the room, then price the sailing, then hand the whole file to Mark to call them, finalize and book.
//
// THE QUESTIONS ABOUT THEM ARE THE GENIE'S OWN. The first build borrowed the Room Concierge's six and Mark
// refused it the same day: "you have assumed that the interview from the room concierge is sufficient. I
// dont believe it is. we need to enhance it to really drive the experience they want, not coffee at
// sunrise, which works well for the room. the enhancement should rely heavily on the psychology disguised
// as a cruise question." So:
//
//   - Every question is a scene aboard a ship. None asks "what kind of traveler are you"; each is a known
//     way of getting at a disposition without naming it — remembered behaviour, a forced tradeoff, what
//     irritates you in others (projection), what you would envy, what you would regret, what you do when
//     the plan breaks.
//   - Every answer READS DIRECTLY onto what makes one ship different from another: the eight virtues of
//     cabin-advisor/matrix.json, in the matrix's own 0-to-2 space. The concierge's route goes answers ->
//     traits -> five coarse labels -> virtues, which is plenty for a room and too blunt for a ship. Here
//     an answer says "this person sits at 2 on scale and 1.5 on activity" and nothing is lost on the way.
//   - How much a virtue counts for THIS person comes from how they answered: the same way every time it
//     came up (it matters to them) or all over the place (it does not). See genieProfile().
//
// The room comes from the Room Concierge's own questions, which for the room work (how they picture using
// it, what matters aboard, budget, seasick). The first two are asked inside the interview, after the scenes
// about them; the Genie never asks for a room type by name.
//
// vacation-genie.html carries its own copy of the questions inline (it renders them) and
// genie-interview.test.ts parses the page and asserts the two are identical.

/** What makes ships differ: the columns of cabin-advisor/matrix.json, each 0 to 2. */
export const VIRTUES = ["energy", "price", "family", "dining", "activity", "structure", "scale", "warmth"] as const;
export type Virtue = (typeof VIRTUES)[number];

export type GenieQuestion = {
  key: string;
  /** A few words naming the scene, for Mark's file. */
  title: string;
  /** The question as the visitor reads it. */
  ask: string;
  /** Each answer, and where it puts the person on the virtues it touches (0 to 2). */
  options: readonly { label: string; reads: Partial<Record<Virtue, number>> }[];
};

export const GENIE_PERSONALITY_QS: readonly GenieQuestion[] = [
  {
    key: "seaDay", title: "A sea day with forty things to do",
    ask: "It's a sea day and the ship has posted forty things to do. By dinner you have…",
    options: [
      { label: "Done six of them, and I'm annoyed about the seventh", reads: { activity: 2, energy: 1.5, scale: 2 } },
      { label: "Done one, and it was a good one", reads: { activity: 1, energy: 1 } },
      { label: "Read the list, laughed, and gone back to my chair", reads: { activity: 0, energy: 0, scale: 0.5 } },
      { label: "Never saw the list. I was busy making my own day", reads: { structure: 2, activity: 1.5 } },
    ],
  },
  {
    key: "elevator", title: "Stuck in the elevator with six strangers",
    ask: "The elevator stops between decks for ten minutes. There are six strangers in it. When the doors open…",
    options: [
      { label: "We have dinner plans together", reads: { warmth: 2, energy: 1.5 } },
      { label: "I know where every one of them is from", reads: { warmth: 1.5, energy: 1 } },
      { label: "I was polite, and I'm taking the stairs from now on", reads: { warmth: 0.5, scale: 0.5 } },
      { label: "I never looked up from my phone", reads: { warmth: 0, energy: 0.5 } },
    ],
  },
  {
    key: "wrongTurn", title: "Day four, a part of the ship never seen",
    ask: "Day four. You take a wrong turn and find a part of the ship you have never seen. That is…",
    options: [
      { label: "The best part. I want a ship I can't finish in a week", reads: { scale: 2, activity: 1.5 } },
      { label: "Fine, as long as I can find my way back", reads: { scale: 1.5 } },
      { label: "A sign the ship is too big", reads: { scale: 0.5 } },
      { label: "Impossible. I had her memorized by day two, and I like it that way", reads: { scale: 0, structure: 0.5 } },
    ],
  },
  {
    key: "steakhouse", title: "The $60 steakhouse upstairs",
    ask: "The dining room is included. The steakhouse upstairs is $60 a head. You…",
    options: [
      { label: "Book it for the first night, and ask what else they've got", reads: { dining: 2, price: 1.5 } },
      { label: "Go once, for the occasion", reads: { dining: 1.5 } },
      { label: "Skip it. The included dinner is already more than I eat at home", reads: { dining: 0.5, price: 0.5 } },
      { label: "Couldn't tell you where either one is. I eat by the pool", reads: { dining: 0, structure: 2 } },
    ],
  },
  {
    key: "bartender", title: "The bartender by the third night",
    ask: "By the third night, the bartender…",
    options: [
      { label: "Has my drink started when he sees me coming", reads: { warmth: 2, price: 1.5 } },
      { label: "Has told me his life story, and I've told him mine", reads: { warmth: 2, energy: 1 } },
      { label: "Is fast and leaves me alone, which is all I ask", reads: { warmth: 0.5 } },
      { label: "Couldn't pick me out. I'm at a different bar every night", reads: { scale: 2, energy: 1.5, structure: 2 } },
    ],
  },
  {
    key: "table42", title: "Dinner at 6:15, table 42, every night",
    ask: "Dinner is at 6:15, table 42, every night. Same waiter, same tablemates. Your first feeling is…",
    options: [
      { label: "Relief. One less thing to decide", reads: { structure: 0 } },
      { label: "Fine, if the tablemates are any good", reads: { structure: 0.5, warmth: 1.5 } },
      { label: "Trapped", reads: { structure: 2 } },
      { label: "I'll show up twice. The rest of the week I eat when I'm hungry", reads: { structure: 1.5 } },
    ],
  },
  {
    key: "threeHundred", title: "$300 that can only be spent aboard",
    ask: "Someone hands you $300 that can only be spent aboard. It goes on…",
    options: [
      { label: "One dinner I'll still be talking about in a year", reads: { dining: 2, price: 1.5 } },
      { label: "The thing with a harness and a waiver", reads: { activity: 2, energy: 1.5 } },
      { label: "A day somewhere quiet, behind a door the crowd can't open", reads: { price: 2, scale: 0.5, energy: 0 } },
      { label: "Nothing yet. First I find out what's already included", reads: { price: 0 } },
    ],
  },
  {
    key: "nextLoungers", title: "The people at the next loungers",
    ask: "The people at the next loungers. What finally makes you get up and move?",
    options: [
      { label: "They're running a party at ten in the morning", reads: { energy: 0, scale: 0.5 } },
      { label: "They've complained about three things since breakfast", reads: { warmth: 1.5, energy: 1.5 } },
      { label: "They've been asleep since nine. It's a vacation, do something", reads: { activity: 2, energy: 1.5 } },
      { label: "Nothing. I've joined them", reads: { energy: 2, warmth: 2 } },
    ],
  },
  {
    key: "midnightHungry", title: "Midnight and hungry",
    ask: "It's midnight and you're hungry. The right answer is…",
    options: [
      { label: "Pizza, standing up, no regrets", reads: { dining: 0, energy: 1.5 } },
      { label: "Whatever the cooks are eating. I asked", reads: { dining: 2, warmth: 1.5 } },
      { label: "A proper sit-down place that's still open", reads: { dining: 1.5, price: 1.5 } },
      { label: "I'm asleep at midnight", reads: { energy: 0 } },
    ],
  },
  {
    key: "buffetPlate", title: "The buffet has two hundred things",
    ask: "The buffet has two hundred things on it. Your plate is…",
    options: [
      { label: "Whatever was closest. I'm due at the pool", reads: { dining: 0, activity: 1.5 } },
      { label: "One thing from every country. I'm doing research", reads: { dining: 1.5, scale: 1.5 } },
      { label: "Empty. I booked a real restaurant instead", reads: { dining: 2, price: 1.5 } },
      { label: "The same breakfast I eat at home, and I'm happy", reads: { dining: 0.5, structure: 0 } },
    ],
  },
  {
    key: "portCancelled", title: "The port they came for is cancelled",
    ask: "The port you came for is cancelled for weather. An hour later you are…",
    options: [
      { label: "Over it. A free sea day is a gift", reads: { structure: 2, energy: 1 } },
      { label: "At the desk, asking what they're going to do about it", reads: { structure: 0, price: 1.5 } },
      { label: "Rebuilding the day from the ship's schedule", reads: { structure: 0.5, activity: 1.5 } },
      { label: "In the hot tub with everybody else who's over it", reads: { warmth: 2, energy: 1.5, structure: 1.5 } },
    ],
  },
  {
    key: "cannonball", title: "A cannonball contest, average age nine",
    ask: "A cannonball contest breaks out at the pool. Average age: nine. You think…",
    options: [
      { label: "That's the sound of a vacation", reads: { family: 2, energy: 1.5 } },
      { label: "Cute, from over here", reads: { family: 1 } },
      { label: "Is there a pool where that can't happen?", reads: { family: 0, energy: 0.5, price: 1.5 } },
      { label: "Those are mine, and they're winning", reads: { family: 2, activity: 1.5 } },
    ],
  },
  {
    key: "oneSentence", title: "One sentence of advice from a friend who sailed her",
    ask: "A friend who has sailed this ship gets one sentence of advice. You want it to be…",
    options: [
      { label: "Where to eat, and what to order", reads: { dining: 2 } },
      { label: "What not to miss", reads: { activity: 2, scale: 1.5 } },
      { label: "Where nobody goes", reads: { energy: 0, scale: 0.5 } },
      { label: "How not to overpay", reads: { price: 0 } },
    ],
  },
  {
    key: "elegantNight", title: "The invitation says elegant night",
    ask: "The invitation says \"elegant night.\" You…",
    options: [
      { label: "Packed for it months ago", reads: { price: 2, structure: 0 } },
      { label: "Put on the one nice shirt and enjoy it", reads: { price: 1, structure: 1 } },
      { label: "Go find the place that doesn't care what I'm wearing", reads: { price: 0.5, structure: 2 } },
      { label: "Did not come on vacation to wear shoes", reads: { price: 0, structure: 2, energy: 1 } },
    ],
  },
  {
    key: "oneAm", title: "Still up at 1 a.m.",
    ask: "It's 1 a.m. and you're still up. Where?",
    options: [
      { label: "Where the music is. I requested the last song", reads: { energy: 2, scale: 1.5 } },
      { label: "At a piano bar, singing badly with strangers", reads: { energy: 1.5, warmth: 2 } },
      { label: "On an open deck with nobody around", reads: { energy: 0, scale: 0.5 } },
      { label: "I'm not. I haven't seen 1 a.m. in years and I don't miss it", reads: { energy: 0.5 } },
    ],
  },
  {
    key: "airportStory", title: "The cruise story that makes them jealous",
    ask: "At the airport, somebody is telling their cruise story. Which line makes you jealous?",
    options: [
      { label: "The crew knew our names by the second day", reads: { warmth: 2, price: 1.5 } },
      { label: "We never did the same thing twice", reads: { scale: 2, activity: 1.5 } },
      { label: "It was so quiet we forgot what day it was", reads: { energy: 0, scale: 0 } },
      { label: "We paid half what you'd think", reads: { price: 0 } },
    ],
  },
  {
    key: "lastNight", title: "The regret on the last night",
    ask: "Last night aboard. Which regret would bother you most?",
    options: [
      { label: "There was something on this ship I never tried", reads: { activity: 2, scale: 2 } },
      { label: "I never got one full day of doing nothing", reads: { energy: 0, activity: 0 } },
      { label: "We ate fine, but nothing I'll remember", reads: { dining: 2 } },
      { label: "I never really met anybody", reads: { warmth: 2, energy: 1.5 } },
    ],
  },
];

/**
 * How they picture using the room: the Room Concierge's own scene, word for word, asked inside the interview
 * after the scenes about them. The Genie never asks "what kind of room do you want" (Mark, 2026-11-26: "which
 * shouldn't be asked. That's what the interview is supposed to help determine. the ship and the room.").
 * "Crash and recharge" is the interior room.
 */
export const ROOM_CHOICES = [
  { label: "Crash and recharge", value: "inside" },
  { label: "Wake up to daylight and water", value: "oceanview" },
  { label: "Coffee outside in my pajamas", value: "balcony" },
  { label: "The room is part of the vacation", value: "suite" },
  { label: "Honestly, no idea — pick for me", value: "balcony" },
] as const;

export const PRIORITY_CHOICES = [
  { label: "Waking up to the ocean", value: "ocean" },
  { label: "Peace and quiet", value: "quiet" },
  { label: "Being near the action", value: "action" },
  { label: "Room to spread out", value: "space" },
] as const;

export const BUDGET_CHOICES = [
  { label: "There's a number, and we respect it", value: "lean" },
  { label: "Comfortable, but every dollar should earn its spot", value: "middle" },
  { label: "For the right trip, the budget moves", value: "treat" },
  { label: "The budget is whatever makes it perfect", value: "sky" },
] as const;

export const DESTINATION_CHOICES = [
  { label: "Eastern Caribbean", value: "e_caribbean" },
  { label: "Western Caribbean", value: "w_caribbean" },
  { label: "Southern Caribbean", value: "s_caribbean" },
  { label: "The Bahamas", value: "bahamas" },
  { label: "Alaska", value: "alaska" },
  { label: "The Mediterranean", value: "mediterranean" },
  { label: "Mexican Riviera", value: "mexican_riviera" },
  { label: "Surprise me — anywhere the ship fits", value: "surprise" },
] as const;

export const OCCASION_CHOICES = [
  { label: "No reason needed", value: "none" },
  { label: "Anniversary or honeymoon", value: "anniversary" },
  { label: "Birthday", value: "birthday" },
  { label: "Family get-together", value: "family" },
  { label: "Retirement", value: "retirement" },
  { label: "Something else", value: "other" },
] as const;

const oneOf = <T extends string>(list: readonly { value: T }[], v: unknown): T | null =>
  list.some((o) => o.value === v) ? (v as T) : null;

/** The trip facts, as the server keeps them. Every field is checked here and nowhere else. */
export interface TripFacts {
  adults: number;
  /** One age per child (0 to 17), at the time of sailing. */
  childAges: number[];
  rooms: number;
  /** First and last day they could sail, YYYY-MM-DD. */
  earliest: string;
  latest: string;
  /** Shortest and longest trip they want, in nights. */
  nightsMin: number;
  nightsMax: number;
  destination: string;
  room: "inside" | "oceanview" | "balcony" | "suite";
  priority: "ocean" | "quiet" | "action" | "space";
  budget: "lean" | "middle" | "treat" | "sky";
  seasick: boolean;
  firstCruise: boolean;
  occasion: string;
  /** Anyone who needs an accessible room or has trouble with stairs and distance. */
  mobility: boolean;
  /** Free text, capped: anything they want Mark to know. */
  notes: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};

/**
 * Check the trip answers. Returns the clean facts, or the one sentence that says what to fix
 * (Mark's rule: a blocked button says what to fix).
 */
export function parseTrip(raw: unknown, today: string): { trip: TripFacts } | { error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const adults = int(r["adults"]);
  if (adults === null || adults < 1 || adults > 12) return { error: "Tell me how many adults are going (1 to 12)." };
  const agesRaw = Array.isArray(r["childAges"]) ? r["childAges"] : [];
  if (agesRaw.length > 10) return { error: "That is more children than one booking holds here. Put the number in the note and I will work it by hand." };
  const childAges: number[] = [];
  for (const a of agesRaw) {
    const n = int(a);
    if (n === null || n < 0 || n > 17) return { error: "Each child needs an age from 0 to 17, as of the sailing date." };
    childAges.push(n);
  }
  const people = adults + childAges.length;
  const rooms = int(r["rooms"]);
  if (rooms === null || rooms < 1 || rooms > 8) return { error: "Tell me how many rooms you need (1 to 8)." };
  if (rooms > people) return { error: "You asked for more rooms than there are travelers. Lower the rooms or add the travelers." };
  if (rooms > adults) return { error: "Every room needs at least one adult in it. Lower the rooms or add an adult." };
  if (people > rooms * 5) return { error: "That is more than five people to a room. Add a room." };

  const earliest = typeof r["earliest"] === "string" ? r["earliest"] : "";
  const latest = typeof r["latest"] === "string" ? r["latest"] : "";
  if (!ISO_DAY.test(earliest) || !ISO_DAY.test(latest)) return { error: "Pick the first and last day you could sail." };
  if (earliest < today) return { error: "The first day you could sail has already passed. Pick a later one." };
  if (latest < earliest) return { error: "The last day you could sail is before the first. Swap them." };

  const nightsMin = int(r["nightsMin"]);
  const nightsMax = int(r["nightsMax"]);
  if (nightsMin === null || nightsMax === null || nightsMin < 2 || nightsMax > 30 || nightsMax < nightsMin) {
    return { error: "Tell me how long a trip you want, in nights (2 to 30)." };
  }

  const destination = oneOf(DESTINATION_CHOICES, r["destination"]);
  if (!destination) return { error: "Pick where you want to go, or pick Surprise me." };
  const room = oneOf(ROOM_CHOICES, r["room"]);
  if (!room) return { error: "Tell me how you picture using your room, or pick No idea." };
  const priority = oneOf(PRIORITY_CHOICES, r["priority"]);
  if (!priority) return { error: "Pick what matters most once you are aboard." };
  const budget = oneOf(BUDGET_CHOICES, r["budget"]);
  if (!budget) return { error: "Pick how the trip budget works." };
  const occasion = oneOf(OCCASION_CHOICES, r["occasion"]) ?? "none";
  const notes = typeof r["notes"] === "string" && r["notes"].trim() ? r["notes"].trim().slice(0, 1000) : null;

  return {
    trip: {
      adults, childAges, rooms, earliest, latest, nightsMin, nightsMax, destination, room, priority, budget,
      seasick: r["seasick"] === true, firstCruise: r["firstCruise"] === true, occasion,
      mobility: r["mobility"] === true, notes,
    },
  };
}

/** The party word the ship and room matchers already understand, read off the head count. */
export function partyOf(trip: Pick<TripFacts, "adults" | "childAges" | "rooms">): "couple" | "family" | "solo" | "group" {
  if (trip.childAges.length > 0) return "family";
  if (trip.adults === 1) return "solo";
  if (trip.adults === 2 && trip.rooms === 1) return "couple";
  return "group";
}

/** How many people sleep in the fullest room: what a fare has to be asked for. */
export function guestsPerRoom(trip: Pick<TripFacts, "adults" | "childAges" | "rooms">): number {
  return Math.ceil((trip.adults + trip.childAges.length) / trip.rooms);
}

/** What the answers add up to: where the person sits on each virtue, and how much each one counts. */
export interface GenieProfile {
  /** 0 to 2 per virtue, the matrix's own space. 1 = middle, or never came up. */
  target: Record<Virtue, number>;
  /** How hard a miss on this virtue costs a ship. */
  weight: Record<Virtue, number>;
  /** How many answers touched the virtue, and how far apart they were (0 = same every time, 1 = opposite ends). */
  answers: Record<Virtue, number>;
  spread: Record<Virtue, number>;
}

/** What a miss costs before the person's own answers move it. Energy leads, as it does for the concierge.
 * Food is second (Mark, 2026-11-24: "it seems to be a big seller lately") and is asked in six scenes. */
const BASE_WEIGHT: Record<Virtue, number> = {
  energy: 1.6, price: 1.2, family: 0.75, dining: 1.4, activity: 1.0, structure: 1.0, scale: 1.2, warmth: 0.8,
};

/**
 * One answer per question -> the profile. Deterministic and inspectable: a wrong ship must be traceable.
 *
 *   target  = the average of where the answers put them on that virtue
 *   weight  = base x (0.5 + conviction), conviction 0..1 = answered it the same way each time AND it came
 *             up at least three times. Someone who lands on "big ship" five times out of five is costed
 *             hard for a small ship; someone who went both ways is not.
 *
 * Children in the party settle the family virtue outright (a ship built for kids). Without children the
 * cannonball answer decides how adult the ship should be, and never asks for a kids' ship.
 */
export function genieProfile(choices: readonly number[], hasChildren: boolean): GenieProfile | null {
  if (choices.length !== GENIE_PERSONALITY_QS.length) return null;
  const seen = Object.fromEntries(VIRTUES.map((v) => [v, [] as number[]])) as Record<Virtue, number[]>;
  for (let i = 0; i < GENIE_PERSONALITY_QS.length; i++) {
    const opt = GENIE_PERSONALITY_QS[i]!.options[choices[i]!];
    if (!opt) return null;
    for (const [k, v] of Object.entries(opt.reads)) seen[k as Virtue].push(v as number);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const target = {} as Record<Virtue, number>, weight = {} as Record<Virtue, number>;
  const answers = {} as Record<Virtue, number>, spread = {} as Record<Virtue, number>;
  for (const v of VIRTUES) {
    const xs = seen[v];
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1;
    const sd = xs.length ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) : 0;
    const conviction = xs.length ? (1 - Math.min(1, sd)) * Math.min(1, xs.length / 3) : 0;
    target[v] = r2(mean); spread[v] = r2(Math.min(1, sd)); answers[v] = xs.length;
    weight[v] = r2(BASE_WEIGHT[v] * (0.5 + conviction));
  }
  if (hasChildren) { target.family = 2; weight.family = 1.5; }
  else {
    const said = seen.family[0] ?? 1;
    target.family = r2(said / 2);                 // 0 adult-only ... 1 kids are fine; never a kids' ship
    weight.family = said === 0 ? 1.25 : 0.5;      // "is there a pool where that can't happen" is a real ask
  }
  return { target, weight, answers, spread };
}

const LOW = 0.6, HIGH = 1.4;

/**
 * The five labels the Room Concierge's matcher words its reason from, read off the profile, so the Genie's
 * "I picked them because…" line and the quiet-enclave offer come from the same answers that chose the ship.
 */
export function profileAxes(p: GenieProfile): {
  energy: "party" | "quiet" | "social"; social: "extrovert" | "introvert" | "mixed"; structure: "planner" | "loose";
  splurge: "cabin" | "value" | "consumables"; crowds: "avoids" | "loves-it" | "tolerates";
} {
  const t = p.target;
  return {
    energy: t.energy >= HIGH ? "party" : t.energy <= LOW ? "quiet" : "social",
    social: t.warmth >= HIGH ? "extrovert" : t.warmth <= LOW ? "introvert" : "mixed",
    structure: t.structure <= LOW ? "planner" : "loose",
    splurge: t.price >= HIGH ? "cabin" : t.price <= LOW ? "value" : "consumables",
    crowds: t.scale <= LOW ? "avoids" : t.scale >= HIGH ? "loves-it" : "tolerates",
  };
}

const READS: Record<Virtue, { name: string; low: string; mid: string; high: string }> = {
  energy:    { name: "Energy",          low: "wants it calm",                          mid: "lively, but not a party",                high: "wants the energy turned up" },
  scale:     { name: "Size of ship",    low: "wants a ship they can learn in a day",   mid: "size is not what decides it",            high: "wants a big ship with more than a week can finish" },
  structure: { name: "Schedule",        low: "likes a set time and a set table",       mid: "some plan, some room to change it",      high: "wants no schedule at all" },
  warmth:    { name: "Crew and people", low: "wants fast service and to be left alone", mid: "friendly is fine, not required",        high: "wants to be known by name and to meet people" },
  dining:    { name: "Food",            low: "food is fuel",                           mid: "good food, not the reason for the trip", high: "the meals are part of the reason for the trip" },
  activity:  { name: "Things to do",    low: "came to do nothing",                     mid: "one good thing a day",                   high: "wants to try everything aboard" },
  price:     { name: "Polish",          low: "wants the deal",                         mid: "will pay for what earns it",             high: "wants polish and will pay for it" },
  family:    { name: "Children aboard", low: "wants to be away from other people's children", mid: "children nearby are fine",        high: "wants a ship built for children" },
};

/** The profile as sentences Mark can read on the call. No scores: where they sit, and how sure the answers were. */
export function profileInWords(p: GenieProfile): [string, string][] {
  const order: Virtue[] = ["energy", "scale", "structure", "warmth", "dining", "activity", "price", "family"];
  return order.map((v) => {
    const r = READS[v], t = p.target[v];
    const where = t >= HIGH ? r.high : t <= LOW ? r.low : r.mid;
    const n = p.answers[v];
    const sure = v === "family" ? ""
      : n === 0 ? " (it never came up)"
      : n === 1 ? " (from one answer only)"
      : p.spread[v] <= 0.35 ? ` (the same way in all ${n} answers that touched it)`
      : p.spread[v] >= 0.75 ? ` (answers went both ways across ${n})`
      : ` (leaning that way across ${n} answers)`;
    return [r.name, where[0]!.toUpperCase() + where.slice(1) + sure] as [string, string];
  });
}

/** The answers as Mark reads them: the scene, and the visitor's own words back. */
export function answersInWords(choices: readonly number[]): { key: string; title: string; answer: string }[] {
  return GENIE_PERSONALITY_QS.map((q, i) => ({ key: q.key, title: q.title, answer: q.options[choices[i] ?? -1]?.label ?? "" }));
}
