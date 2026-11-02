// group-page-photos.ts — which of the trip's own photos each private page opens on (paperwork, cruise page, details page).
// PURE. Mark 2026-10-26: "every page gets its own set of images", never the website's banner and never a picture another page uses.

type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

export type PhotoPage = "paperwork" | "cruise" | "details";
export interface PagePhoto { url: string; alt: string }

/**
 * Mark 2026-10-26: a private page opens on the trip's own photos (left, middle, right), never the website's banner, and each page shows a
 * different selling point. The group file names them: groups.journey.photos.<page> = up to three { url, alt }. Only our own /assets/ files
 * and https addresses are passed on; anything else is left out.
 */
export function pagePhotos(journey: unknown, page: PhotoPage): PagePhoto[] {
  const j = journey && typeof journey === "object" ? (journey as Row) : {};
  const list: unknown = j["photos"] && typeof j["photos"] === "object" ? (j["photos"] as Row)[page] : null;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 3)
    .map((p: Row | null) => ({ url: typeof p?.url === "string" ? p.url.trim() : "", alt: typeof p?.alt === "string" ? p.alt.trim().slice(0, 160) : "" }))
    .filter((p) => p.url.length <= 500 && !p.url.includes("..") && (/^\/assets\/[\w\-./]+$/.test(p.url) || /^https:\/\/[^\s"'<>()\\]+$/.test(p.url)));
}

