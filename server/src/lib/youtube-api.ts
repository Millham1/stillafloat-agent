// YouTube Data API reads for the channel scan (GET /api/youtube-scan).
//
// Until 2026-10-11 the scan read the channel's public RSS feed (youtube.com/feeds/videos.xml). That feed
// answered 404/500 for about a day on 2026-10-09/11 — from both boxes and from a laptop — so the scan
// failed on dev and prod and the homepage video rows would have gone stale. The Data API (the key is on
// both boxes and already refreshes views, titles and thumbnails) is the primary source now; the RSS feed
// stays as the fallback for a box with no key or a Data API failure (quota, key restriction).
//
// Cost: channels.list 1 unit (only when the id is not configured) + playlistItems.list 1 unit per page
// of 50 + the existing videos.list refresh — a handful of units per scan, every 6 hours.

const API = "https://www.googleapis.com/youtube/v3";
const CHANNEL_ID = /^UC[a-zA-Z0-9_-]{22}$/;

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface UploadedVideo {
  id: string;
  title: string;
  published: string;
  thumbnail: string;
}

/** A channel's uploads playlist id is its channel id with the "UC" prefix swapped for "UU". */
export function uploadsPlaylistId(channelId: string): string | null {
  return CHANNEL_ID.test(channelId) ? `UU${channelId.slice(2)}` : null;
}

interface PlaylistItem {
  snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string }; thumbnails?: Record<string, { url?: string }> };
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}

/** Public uploads only: the API labels a private or deleted upload "Private video" / "Deleted video". Pure. */
export function parsePlaylistItems(body: unknown): { videos: UploadedVideo[]; next: string | null } {
  const b = (body ?? {}) as { items?: PlaylistItem[]; nextPageToken?: string };
  const videos: UploadedVideo[] = [];
  for (const it of b.items ?? []) {
    const id = it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId ?? "";
    const title = it.snippet?.title ?? "";
    if (!id || /^(private|deleted) video$/i.test(title.trim())) continue;
    const th = it.snippet?.thumbnails;
    videos.push({
      id,
      title,
      published: it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt ?? "",
      thumbnail: th?.["high"]?.url || th?.["medium"]?.url || th?.["default"]?.url || `https://img.youtube.com/vi/${id}/mqdefault.jpg`,
    });
  }
  return { videos, next: b.nextPageToken ?? null };
}

async function apiGet(url: string, what: string, fetchImpl: FetchLike): Promise<unknown> {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`${what} answered HTTP ${r.status}`);
  return r.json();
}

/** The channel's newest public uploads (newest first), up to `pages` pages of 50. */
export async function fetchUploads(channelId: string, apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, pages = 2): Promise<UploadedVideo[]> {
  const playlist = uploadsPlaylistId(channelId);
  if (!playlist) throw new Error(`"${channelId}" is not a channel id`);
  const out: UploadedVideo[] = [];
  let token: string | null = null;
  for (let page = 0; page < pages; page++) {
    const url = `${API}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${playlist}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}&key=${apiKey}`;
    const parsed = parsePlaylistItems(await apiGet(url, "playlistItems.list", fetchImpl));
    out.push(...parsed.videos);
    token = parsed.next;
    if (!token) break;
  }
  return out;
}

// ── Video language ───────────────────────────────────────────────────────────
// Every video is filmed in English and its Spanish long-form is built from it; the Shorts match their
// long-forms. publish_youtube.py stamps each upload with that language (snippet.defaultLanguage and
// defaultAudioLanguage), so the language is a recorded fact — never inferred from the title. Until
// 2026-10-20 three places guessed from accents in the title; the Spanish cabin video was retitled
// "7 cosas que debes hacer apenas entras a tu cabina de crucero" (no accents) and landed on the English
// homepage and in an English social batch (Mark 2026-10-20: "there is no guessing").
//
// defaultLanguage (the title/description language) is read first: ten older Spanish uploads carry
// defaultAudioLanguage "en-US" with defaultLanguage "es" (checked across all 173 videos, 2026-10-20).

export type VideoLang = "en" | "es";

interface LangSnippet {
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
}

/** The language YouTube has on record for a video ("es-419" → "es"); null when it carries no en/es stamp. Pure. */
export function stampedLanguage(snippet: LangSnippet | undefined): VideoLang | null {
  for (const tag of [snippet?.defaultLanguage, snippet?.defaultAudioLanguage]) {
    const base = (tag ?? "").toLowerCase().split("-")[0];
    if (base === "en" || base === "es") return base;
  }
  return null;
}

/** id → recorded language for the given videos (videos.list, 1 unit per 50 ids). Ids with no stamp are absent. */
export async function fetchVideoLanguages(ids: string[], apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<Map<string, VideoLang>> {
  const out = new Map<string, VideoLang>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).map(encodeURIComponent).join(",");
    const body = (await apiGet(`${API}/videos?part=snippet&id=${batch}&key=${apiKey}`, "videos.list", fetchImpl)) as {
      items?: { id?: string; snippet?: LangSnippet }[];
    };
    for (const it of body.items ?? []) {
      const lang = stampedLanguage(it.snippet);
      if (it.id && lang) out.set(it.id, lang);
    }
  }
  return out;
}

/** The channel id for a handle ("@StillAfloatcruising2026"), read from the API — no page scraping. */
export async function channelIdForHandle(handle: string, apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string | null> {
  const h = handle.replace(/^@/, "");
  const body = (await apiGet(`${API}/channels?part=id&forHandle=${encodeURIComponent(h)}&key=${apiKey}`, "channels.list", fetchImpl)) as { items?: { id?: string }[] };
  const id = body.items?.[0]?.id ?? "";
  return CHANNEL_ID.test(id) ? id : null;
}
