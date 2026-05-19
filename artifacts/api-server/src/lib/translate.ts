import { logger } from "./logger";

interface StoryForTranslation {
  id: string;
  title: string;
  summary: string;
  travelerImpact: string;
  editorialReasoning: string;
}

interface TranslatedStory {
  id: string;
  title_es: string;
  summary_es: string;
  travelerImpact_es: string;
  editorialReasoning_es: string;
}

const BATCH_SIZE = 10;

const SYSTEM_PROMPT = `You are a professional translator specializing in Latin American Spanish (es-419) for a cruise travel news website called Still Afloat.

Respond with a JSON object containing a "translations" array. Each element must have exactly these fields: id, title_es, summary_es, travelerImpact_es, editorialReasoning_es.

Translation guidelines:
- Tone: warm, practical, tropical — brand voice is "Navega más inteligente. Ríe más. Mantente a flote."
- Port names, ship names, cruise line names: keep in original language (e.g. "Royal Caribbean", "Cozumel", "MSC Seashore", "Norwegian Bliss")
- If a field is empty, return an empty string for that field
- Translate meaning-for-meaning, not word-for-word — natural fluent Spanish
- The audience is experienced Latin American cruisers aged 45–70`;

async function translateBatch(
  stories: StoryForTranslation[],
  apiKey: string,
): Promise<TranslatedStory[]> {
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
          content: `Translate these ${stories.length} cruise news stories to Latin American Spanish. Return JSON with a "translations" array.\n\n${JSON.stringify(stories, null, 2)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI translation HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (await response.json()) as any;
  const content: string = payload?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("Empty translation response from OpenAI");

  const parsed = JSON.parse(content) as { translations?: TranslatedStory[] };
  if (!Array.isArray(parsed.translations)) {
    throw new Error("Translation response missing 'translations' array");
  }
  return parsed.translations;
}

/**
 * Translate a list of story objects to Spanish in-place (adds *_es fields).
 * Never throws — on batch failure the stories are returned untouched so the
 * English fallback in applyEsOverlay() takes over.
 */
export async function translateStoriesToSpanish(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stories: Record<string, any>[],
  apiKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>[]> {
  if (!stories.length || !apiKey) return stories;

  const toTranslate: StoryForTranslation[] = stories.map((s) => ({
    id: String(s.id ?? ""),
    title: String(s.title ?? ""),
    summary: String(s.summary ?? s.synopsis ?? ""),
    travelerImpact: String(s.travelerImpact ?? ""),
    editorialReasoning: String(s.reasoning ?? s.editorialReasoning ?? ""),
  }));

  const batches: StoryForTranslation[][] = [];
  for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
    batches.push(toTranslate.slice(i, i + BATCH_SIZE));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const translationMap = new Map<string, TranslatedStory>();

  for (const batch of batches) {
    try {
      const results = await translateBatch(batch, apiKey);
      for (const t of results) {
        if (t.id) translationMap.set(t.id, t);
      }
      logger.info({ count: results.length }, "Spanish translation batch completed");
    } catch (err) {
      logger.warn({ err }, "Spanish translation batch failed — English fallback will be used");
    }
  }

  return stories.map((story) => {
    const id = String(story.id ?? "");
    const t = translationMap.get(id);
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
