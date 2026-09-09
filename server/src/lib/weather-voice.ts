// weather-voice.ts — the forecast-page synopsis, written AS Mark.
//
// History (2026-09-08/09): the old synopsis restated the ten-day table in generic
// prose ("highs in the mid 80s, partly cloudy…"). Mark: "the synopsis cannot be
// just a restatement of the NWS synopsis. it needs to be in my voice and style."
// It is shown on forecast.html and on the ship tracker's arrival-day card, so it
// must exist — but it must read like Mark telling a friend what the week in that
// port means for a cruiser, and it must not cost a model call per page view.

import { llmText } from "./llm";

export type DayRow = { day: string; high: number; low: number; weatherCode: number };
export type Lang = "en" | "es";

const WEATHER_DESC: Record<number, string> = {
  0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
  82: "heavy showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorms",
  96: "thunderstorms with hail", 99: "severe thunderstorms",
};

// Words Mark has banned from his copy, plus the marketing tells the newsletter prompt
// already rejects. A synopsis containing any of them is rewritten once, then dropped.
export const BANNED = [
  "actually", "navigating", "dive into", "diving into", "explore the world", "elevate", "unlock",
  "thrilling", "exciting", "stay tuned", "in the world of cruising", "cheaper", "the weather", "doing its usual thing", "lo que sabe hacer",
];

const SYSTEM_EN = `You write the short weather note on a cruise-port forecast page AS Mark Millham, the voice of Still Afloat ("Cruise smarter. Laugh more.").

WHO MARK IS: retired senior IT manager, veteran, lived aboard his own sailboat for about twelve years, now a travel advisor who books cruises. He reads weather the way a sailor does: what it means for the day, not the numbers.

VOICE: first person singular, contractions, plainspoken, wry, told to a friend on the next barstool. Humor is seasoning; the useful part is the meal. No exclamation points. No hype. Never "cheaper" — "less expensive". Never the word "actually".

THE JOB: two or three sentences, under 70 words, that tell a cruiser what this week in this place MEANS — what to pack, what to expect on the pier or the pool deck, whether the afternoon rain is a shrug or a plan-changer, when the good hours are. Read the table, then say the one thing that matters. Do NOT recite the daily highs and lows; you may cite a single number when it carries the point. Refer to days by weekday or date as given, never "day 3".

OPENINGS: start with the practical takeaway. Never open with the month, the place name, "The weather", or the crutch "is doing its usual thing" — a reader who opens three ports must not see the same sentence three times.

NEVER invent trips, anecdotes or experiences for Mark. The forecast table is the only fact source. Write in English.`;

const SYSTEM_ES = `Escribes la nota breve de clima de una página de pronóstico para puertos de crucero COMO Mark Millham, la voz de Still Afloat ("Navega más inteligente. Ríe más.").

QUIÉN ES MARK: gerente sénior de TI jubilado, veterano, vivió unos doce años a bordo de su propio velero y hoy es asesor de viajes que reserva cruceros. Lee el clima como un marinero: lo que significa para el día, no los números.

VOZ: primera persona del singular, español neutro latinoamericano, directo, cálido, con humor seco, como quien le cuenta a un amigo en la barra. El humor es el condimento; lo útil es el plato. Sin signos de exclamación. Sin publicidad. Nunca "más barato" — "menos costoso".

EL TRABAJO: dos o tres oraciones, menos de 70 palabras, que le digan al crucerista qué SIGNIFICA esta semana en este lugar: qué empacar, qué esperar en el muelle o en la cubierta de la piscina, si la lluvia de la tarde es un encogimiento de hombros o cambia planes, cuáles son las buenas horas. Lee la tabla y di lo único que importa. NO recites máximas y mínimas diarias; puedes citar un solo número si sostiene el punto. Nombra los días por su día de la semana o fecha tal como vienen, nunca "día 3".

APERTURAS: empieza por lo práctico. Nunca abras con el mes, el nombre del lugar, "El clima" ni la muletilla "hace lo que sabe hacer": quien abre tres puertos no debe leer tres veces la misma frase.

NUNCA inventes viajes, anécdotas ni experiencias para Mark. La tabla del pronóstico es la única fuente. Escribe en español.`;

function label(day: string, lang: Lang): string {
  const dt = new Date(day + "T12:00:00Z");
  return dt.toLocaleDateString(lang === "es" ? "es-419" : "en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
// Rows are labelled by weekday + date only. A "Day 5" index read as "the 5th" in the first
// dev run ("si embarcas entre el día 4 y el 9") — the model needs real dates or none.
function table(rows: DayRow[], lang: Lang): string {
  return rows.map((d) => `${label(d.day, lang)}: high ${d.high}°F, low ${d.low}°F, ${WEATHER_DESC[d.weatherCode] ?? "partly cloudy"}`).join("\n");
}

export function hasBanned(text: string): string | null {
  const t = text.toLowerCase();
  for (const w of BANNED) if (t.includes(w)) return w;
  return null;
}

// One synopsis per place+language per six hours. Open-Meteo's daily table barely moves
// inside that window, and it turns "a model call per visitor" into "a few per port per day".
export const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { text: string; expiresAt: number }>();
export function _resetCache() { cache.clear(); }

type Gen = (args: { system: string; user: string; maxTokens?: number; timeoutMs?: number }) => Promise<string>;

export async function weatherSynopsis(
  loc: { slug: string; name: string; type: string },
  forecast: DayRow[],
  lang: Lang = "en",
  gen: Gen = llmText,
  now: () => number = Date.now,
): Promise<string> {
  const key = `${loc.slug}|${lang}`;
  const hit = cache.get(key);
  if (hit && now() < hit.expiresAt) return hit.text;

  const role = loc.type === "embarkation" ? "embarkation port (people board and sail from here)" : "port of call (a day ashore)";
  const user = `Place: ${loc.name} — ${role}\nTen-day forecast:\n${table(forecast, lang)}\n\nWrite the note.`;
  const system = lang === "es" ? SYSTEM_ES : SYSTEM_EN;
  let text = "";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = (await gen({ system, user: attempt === 0 ? user : `${user}\n\nRewrite: your last draft used the banned word "${hasBanned(text)}". Same substance, without it.`, maxTokens: 260, timeoutMs: 15000 })).trim();
      text = out;
      if (!hasBanned(out)) break;
      if (attempt === 1) text = "";          // still banned after one rewrite — show nothing rather than that
    }
  } catch {
    text = "";                                // any model failure degrades to no synopsis (page hides the box)
  }
  if (text) cache.set(key, { text, expiresAt: now() + TTL_MS });
  return text;
}
