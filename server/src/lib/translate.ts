import { logger } from "./logger";

interface StorySlice {
  idx: number;
  title: string;
  summary: string;
  travelerImpact: string;
  editorialReasoning: string;
}

interface TranslatedSlice {
  idx: number;
  title_es: string;
  summary_es: string;
  travelerImpact_es: string;
  editorialReasoning_es: string;
}

const BATCH_SIZE = 10;

const SYSTEM_PROMPT = `You are a professional translator specializing in Latin American Spanish (es-419) for a cruise travel news website called Still Afloat.

Respond with a JSON object containing a "translations" array. Each element must have exactly these fields: idx (integer, copy from input), title_es, summary_es, travelerImpact_es, editorialReasoning_es.

Translation guidelines:
- Tone: warm, practical, tropical — brand voice is "Navega más inteligente. Ríe más. Mantente a flote."
- Port names, ship names, cruise line names: keep in original language (e.g. "Royal Caribbean", "Cozumel", "MSC Seashore", "Norwegian Bliss")
- If a field is empty string, return empty string for that field
- Translate meaning-for-meaning, not word-for-word — natural fluent Spanish
- The audience is experienced Latin American cruisers aged 45–70`;

async function translateBatch(
  slices: StorySlice[],
  apiKey: string,
): Promise<TranslatedSlice[]> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Translate these ${slices.length} cruise news stories to Latin American Spanish. Return JSON with a "translations" array where each item has idx, title_es, summary_es, travelerImpact_es, editorialReasoning_es.\n\n${JSON.stringify(slices, null, 2)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI translation HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (await response.json()) as any;
  const content: string = payload?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("Empty translation response from OpenAI");

  const parsed = JSON.parse(content) as { translations?: TranslatedSlice[] };
  if (!Array.isArray(parsed.translations)) {
    throw new Error("Translation response missing 'translations' array");
  }
  return parsed.translations;
}

/**
 * Translate a list of story objects to Spanish (adds *_es fields).
 * Uses positional index matching so long/unusual story IDs never break the merge.
 * Never throws — on batch failure stories are returned untouched and the English
 * fallback in applyEsOverlay() takes over automatically.
 */
export async function translateStoriesToSpanish(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stories: Record<string, any>[],
  apiKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>[]> {
  if (!stories.length || !apiKey) return stories;

  // Build slices with a simple numeric idx — never rely on story.id for matching
  const slices: StorySlice[] = stories.map((s, idx) => ({
    idx,
    title: String(s.title ?? ""),
    summary: String(s.summary ?? s.synopsis ?? ""),
    travelerImpact: String(s.travelerImpact ?? ""),
    editorialReasoning: String(s.reasoning ?? s.editorialReasoning ?? ""),
  }));

  // Map from idx → translated fields
  const resultMap = new Map<number, TranslatedSlice>();

  for (let i = 0; i < slices.length; i += BATCH_SIZE) {
    const batch = slices.slice(i, i + BATCH_SIZE);
    try {
      const results = await translateBatch(batch, apiKey);
      for (const t of results) {
        if (typeof t.idx === "number") resultMap.set(t.idx, t);
      }
      logger.info({ count: results.length, batchStart: i }, "Spanish translation batch completed");
    } catch (err) {
      logger.warn({ err, batchStart: i }, "Spanish translation batch failed — English fallback will be used");
    }
  }

  return stories.map((story, idx) => {
    const t = resultMap.get(idx);
    if (!t) return story;
    return {
      ...story,
      title_es: t.title_es ?? "",
      summary_es: t.summary_es ?? "",
      travelerImpact_es: t.travelerImpact_es ?? "",
      editorialReasoning_es: t.editorialReasoning_es ?? "",
    };
  });
}
