// group-assets.ts — photographs for a group's marketing package, fetched by the system.
//
// Mark, 2026-10-10: "i am trying to automate this process so I don't have to go in and download
// anything." MSC's own sites (msccruisesusa.com, msccruises.com) answer 401 to anything that is
// not a signed-in browser, so the line's kit cannot be fetched by code; it arrives through the
// rep (Jordan Gradel) and is filed with source 'line-kit'. Until then the package uses OPENLY
// LICENSED photographs from Wikimedia Commons: CC0 / public domain / CC BY (credit printed on
// the poster). CC BY-SA photos are taken only when nothing else exists, and flagged, because a
// poster made from one must carry the same license.
import { getSupabase } from "./persistence";
import { logger } from "./logger";

export const ASSET_BUCKET = "group-marketing";
const UA = "StillAfloatBot/1.0 (https://stillafloatcruising.com; mark@stillafloatcruising.com)";

export interface CommonsCandidate {
  title: string;
  pageUrl: string;
  fileUrl: string;      // 1600-px rendition
  width: number;
  height: number;
  license: string;
  shareAlike: boolean;
  attribution: string;  // "Photo: <artist> · <license>"
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/** Licenses a commercial flyer may use. SA is allowed as a last resort and flagged. */
export function licenseClass(name: string | null | undefined): "free" | "sa" | "no" {
  const l = (name ?? "").toLowerCase();
  if (!l) return "no";
  if (/cc0|public domain|pd-/.test(l)) return "free";
  if (/cc by-sa|cc-by-sa/.test(l)) return "sa";
  if (/cc by(\s|$|\d)/.test(l) || /^cc-by(\s|-\d)/.test(l) || /attribution(?!.*share)/.test(l)) return "free";
  return "no";
}

/** Rank candidates: usable license first, then landscape and large; SA last. Pure. */
const INTERIOR = /atrium|interior|lobby|restaurant|buffet|cabin|stateroom|theat|casino|corridor|elevator|bar\b|lounge|gym|spa\b/i;
/** Words that mean "not the place we are selling" when a port shares its name with somewhere else. */
const OFF_TOPIC = /new york|county|long island|germany|bahamas district|river\b/i;
export function rankCandidates(list: readonly CommonsCandidate[], want = 4, subject: "ship" | "destination" = "ship"): CommonsCandidate[] {
  const score = (c: CommonsCandidate) => {
    const cls = licenseClass(c.license);
    if (cls === "no") return -1;
    if (subject === "destination" && OFF_TOPIC.test(c.title) && !/bahamas/i.test(c.title)) return -1;
    const ratio = c.width / Math.max(1, c.height);
    const landscape = ratio >= 1.2 && ratio <= 2.2 ? 2 : ratio > 1 ? 1 : 0;
    const big = c.width >= 2400 ? 2 : c.width >= 1600 ? 1 : 0;
    const exterior = subject === "ship" && INTERIOR.test(c.title) ? -4 : 0;   // a poster wants the hull, not the atrium
    return (cls === "free" ? 10 : 0) + landscape + big + exterior;
  };
  return [...list].filter((c) => score(c) >= 0).sort((a, b) => score(b) - score(a)).slice(0, want);
}

export async function searchCommons(query: string, fetchImpl: typeof fetch = fetch): Promise<CommonsCandidate[]> {
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  u.search = new URLSearchParams({
    action: "query", generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: "12",
    prop: "imageinfo", iiprop: "url|extmetadata|size", iiurlwidth: "1600", format: "json",
  }).toString();
  const res = await fetchImpl(u.toString(), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Wikimedia Commons search failed (${res.status})`);
  const body = (await res.json()) as { query?: { pages?: Record<string, { title: string; imageinfo?: Array<Record<string, unknown>> }> } };
  const out: CommonsCandidate[] = [];
  for (const p of Object.values(body.query?.pages ?? {})) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    const em = (ii["extmetadata"] ?? {}) as Record<string, { value?: string }>;
    const license = em["LicenseShortName"]?.value ?? "";
    const artist = stripTags(em["Artist"]?.value ?? "") || "Wikimedia Commons contributor";
    const mime = String(ii["mime"] ?? "");
    if (mime && !/^image\/(jpeg|png|webp)$/.test(mime)) continue;
    const width = Number(ii["width"] ?? 0), height = Number(ii["height"] ?? 0);
    if (!width || !height) continue;
    out.push({
      title: p.title.replace(/^File:/, ""),
      pageUrl: String(ii["descriptionurl"] ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`),
      fileUrl: String(ii["thumburl"] ?? ii["url"] ?? ""),
      width, height, license, shareAlike: licenseClass(license) === "sa",
      attribution: `Photo: ${artist} · ${license || "license unknown"} · Wikimedia Commons`,
    });
  }
  return out.filter((c) => c.fileUrl);
}

let bucketReady = false;
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const s = getSupabase().storage;
  const { data } = await s.listBuckets();
  if (!(data ?? []).some((b) => b.name === ASSET_BUCKET)) {
    const { error } = await s.createBucket(ASSET_BUCKET, { public: true, fileSizeLimit: 25 * 1024 * 1024 });
    if (error && !/already exists/i.test(error.message)) throw new Error(`bucket ${ASSET_BUCKET}: ${error.message}`);
  }
  bucketReady = true;
}

/** Upload bytes to the public bucket; returns the path and public URL. */
export async function putPublic(path: string, bytes: Buffer, contentType: string): Promise<{ path: string; url: string }> {
  await ensureBucket();
  const store = getSupabase().storage.from(ASSET_BUCKET);
  const { error } = await store.upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`upload ${path}: ${error.message}`);
  return { path, url: store.getPublicUrl(path).data.publicUrl };
}

export interface AssetRow { id: string; subject: string; ship_name: string | null; source: string; source_url: string; page_url: string | null; title: string | null; license: string | null; share_alike: boolean; attribution: string | null; width: number | null; height: number | null; storage_path: string; public_url: string }

/** Photos already on file for this ship + subjects (shared across groups). */
export async function assetsFor(shipName: string, subjects: string[]): Promise<AssetRow[]> {
  const { data, error } = await getSupabase().from("group_assets").select("*").eq("ship_name", shipName).in("subject", subjects).order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as AssetRow[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * Fetch photos for the ship and each destination that has none yet. Returns everything on file
 * afterwards. Each subject: search Commons, keep the best few, download the 1600-px rendition into
 * the public bucket, record license + credit.
 */
export async function fetchAssets(args: { cruiseLine: string | null; shipName: string; destinations: string[]; fetchImpl?: typeof fetch; perSubject?: number }): Promise<{ assets: AssetRow[]; fetched: number; notes: string[] }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const subjects = ["ship", ...args.destinations.map((d) => `destination:${d}`)];
  const have = await assetsFor(args.shipName, subjects);
  const notes: string[] = [];
  let fetched = 0;
  for (const subject of subjects) {
    if (have.some((a) => a.subject === subject)) continue;
    // The port's full name as the itinerary prints it ("Nassau, Bahamas"), plus the word that tells
    // Commons which Nassau we mean. A bare "Nassau" returned Nassau, New York (2026-10-10).
    const name = subject === "ship" ? args.shipName : subject.slice("destination:".length);
    // The contextual wording first ("Ocean Cay … cruise port" finds nothing on Commons; "Ocean Cay" does), then the bare name.
    const queries = subject === "ship" ? [`${name} cruise ship`, name] : [`${name} cruise port`, name];
    let candidates: CommonsCandidate[] = [];
    let query = queries[0]!;
    try {
      for (query of queries) {
        candidates = rankCandidates(await searchCommons(query, fetchImpl), args.perSubject ?? 3, subject === "ship" ? "ship" : "destination");
        if (candidates.length) break;
      }
    } catch (err) { notes.push(`${subject}: ${err instanceof Error ? err.message : String(err)}`); continue; }
    if (!candidates.length) { notes.push(`${subject}: no openly licensed photo found on Wikimedia Commons for "${queries.join('" or "')}"`); continue; }
    for (const c of candidates) {
      try {
        const res = await fetchImpl(c.fileUrl, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`download ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        const ext = /\.png$/i.test(c.fileUrl) ? "png" : "jpg";
        const path = `assets/${slug(args.shipName)}/${slug(subject)}/${slug(c.title)}.${ext}`;
        const up = await putPublic(path, bytes, ext === "png" ? "image/png" : "image/jpeg");
        const row = {
          cruise_line: args.cruiseLine, ship_name: args.shipName, subject, source: "wikimedia", source_url: c.fileUrl, page_url: c.pageUrl,
          title: c.title, license: c.license, share_alike: c.shareAlike, attribution: c.attribution, width: c.width, height: c.height,
          storage_path: up.path, public_url: up.url,
        };
        const { error } = await getSupabase().from("group_assets").insert(row as never);
        if (error) throw new Error(error.message);
        fetched++;
        if (c.shareAlike) notes.push(`${subject}: "${c.title}" is CC BY-SA — a poster made with it must carry the same license; prefer another photo when the rep's kit arrives`);
      } catch (err) {
        notes.push(`${subject}: could not file "${c.title}" (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
  logger.info({ ship: args.shipName, fetched, notes: notes.length }, "group assets fetched");
  return { assets: await assetsFor(args.shipName, subjects), fetched, notes };
}
