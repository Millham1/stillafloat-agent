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

/** The channel id for a handle ("@StillAfloatcruising2026"), read from the API — no page scraping. */
export async function channelIdForHandle(handle: string, apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string | null> {
  const h = handle.replace(/^@/, "");
  const body = (await apiGet(`${API}/channels?part=id&forHandle=${encodeURIComponent(h)}&key=${apiKey}`, "channels.list", fetchImpl)) as { items?: { id?: string }[] };
  const id = body.items?.[0]?.id ?? "";
  return CHANNEL_ID.test(id) ? id : null;
}
