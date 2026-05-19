import { createClient } from "@supabase/supabase-js";
import { logger } from "./logger";

const VERIFIED_SUPABASE_URL = "https://gbjfrnrkkjnutmogdzln.supabase.co";
const configuredSupabaseUrl = process.env["SUPABASE_URL"];
const supabaseUrl =
  configuredSupabaseUrl && !configuredSupabaseUrl.includes("aBcDe")
    ? configuredSupabaseUrl
    : VERIFIED_SUPABASE_URL;

const supabaseKey =
  process.env["SUPABASE_ANON_KEY"] || process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

let supabase: ReturnType<typeof createClient> | null = null;

function getSupabase() {
  if (!supabase) {
    if (!supabaseKey) {
      throw new Error("SUPABASE_ANON_KEY environment variable is missing");
    }
    supabase = createClient(supabaseUrl, supabaseKey);
  }
  return supabase;
}

export const PATHS = {
  candidates: "candidate-stories",
  approved: "approved-stories",
  archive: "archive-stories",
  homepage: "homepage-feed",
  newsIndex: "news-index",
  storyDetails: "story-details",
  // Spanish (es-419) streams — stored separately, never overwrite English
  candidatesEs: "candidate-stories-es",
  homepageEs: "homepage-feed-es",
  newsIndexEs: "news-index-es",
  storyDetailsEs: "story-details-es",
};

export async function writeJson(key: string, payload: unknown): Promise<boolean> {
  const client = getSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (client.from("platform_state") as any)
    .upsert({ id: key, payload, updated_at: new Date().toISOString() });

  if (error) {
    logger.error({ err: error, key }, "Supabase write error");
    throw error;
  }
  return true;
}

export async function readJson<T = Record<string, unknown>>(
  key: string,
  fallback: T
): Promise<T> {
  try {
    const client = getSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client.from("platform_state") as any)
      .select("payload")
      .eq("id", key)
      .single();

    if (error || !data) return fallback;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((data as any).payload as T) || fallback;
  } catch {
    return fallback;
  }
}
