import { getSupabase } from "./persistence";
import { setMedia } from "./social-publish";
import { logger } from "./logger";

// Reel clip hosting — OUR Supabase Storage, public bucket `social-clips`
// (migration 0030). Instagram's publishing API only fetches media from a public
// URL, so every Reel needs a host; Mark (2026-09-06) chose to own it rather than
// add Cloudinary: "as much as possible should be built and reside on the server."
//
// Flow (publish_youtube.py / publish_all.py → register_clip.py on the Mac):
//   1. POST /api/social/clip/sign {videoId, lang}  → one-time signed upload URL
//   2. PUT the .mp4 straight to that URL (bytes never pass through nginx/express)
//   3. POST /api/social/clip/register {videoId, lang, sha256, bytes}
//      → we confirm the object exists, compute its public URL, and register it in
//        the media map; the social poster then hands that URL to Instagram.
// The clip itself has already passed qc_short.py (dims, provenance, opaque
// panels, H.264/AAC) before the publisher lets it get here.

export const CLIP_BUCKET = "social-clips";
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
const LANGS = new Set(["en", "es"]);

export function isValidVideoId(id: unknown): id is string {
  return typeof id === "string" && VIDEO_ID.test(id);
}
export function isClipLang(lang: unknown): lang is "en" | "es" {
  return typeof lang === "string" && LANGS.has(lang);
}
export function clipObjectPath(videoId: string, lang: string): string {
  if (!isValidVideoId(videoId)) throw new Error("invalid videoId");
  if (!isClipLang(lang)) throw new Error("lang must be en|es");
  return `${lang}/${videoId}.mp4`;
}

export interface SignedClipUpload {
  bucket: string;
  path: string;
  signedUrl: string;
  token: string;
}

export async function signClipUpload(videoId: string, lang: string): Promise<SignedClipUpload> {
  const path = clipObjectPath(videoId, lang);
  const { data, error } = await getSupabase().storage.from(CLIP_BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error || !data) throw new Error(`sign failed: ${error?.message ?? "no data"}`);
  return { bucket: CLIP_BUCKET, path, signedUrl: data.signedUrl, token: data.token };
}

export interface RegisteredClip {
  videoId: string;
  lang: string;
  path: string;
  videoUrl: string;
  bytes: number | null;
}

export async function registerClip(
  videoId: string,
  lang: string,
  meta: { sha256?: string; bytes?: number } = {},
): Promise<RegisteredClip> {
  const path = clipObjectPath(videoId, lang);
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  const store = getSupabase().storage.from(CLIP_BUCKET);
  const { data: listed, error } = await store.list(dir, { search: name, limit: 10 });
  if (error) throw new Error(`storage list failed: ${error.message}`);
  const obj = (listed ?? []).find((o) => o.name === name);
  if (!obj) throw new Error(`object ${path} is not in ${CLIP_BUCKET} — upload it first (sign → PUT)`);
  const size = (obj.metadata as { size?: number } | null | undefined)?.size;
  const bytes = typeof size === "number" ? size : (meta.bytes ?? null);
  if (typeof meta.bytes === "number" && typeof size === "number" && meta.bytes !== size) {
    throw new Error(`size mismatch: publisher sent ${meta.bytes} bytes, bucket holds ${size}`);
  }
  const { data: pub } = store.getPublicUrl(path);
  const videoUrl = pub.publicUrl;
  await setMedia(videoId, videoUrl, { lang, path, sha256: meta.sha256, bytes: bytes ?? undefined, source: "supabase" });
  logger.info({ videoId, lang, path, bytes }, "social clip registered");
  return { videoId, lang, path, videoUrl, bytes };
}
