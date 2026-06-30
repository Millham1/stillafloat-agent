import crypto from "node:crypto";
import { logger } from "./logger";
import { readJson, writeJson, PATHS } from "./persistence";

// Amazon → gear ingestion. Products come from Mark's "Still Afloat Gear" wishlist
// (read via Chrome by the skill, POSTed as raw items). Here we build the AFFILIATE
// link (his tag — required for payment), dedupe against what's already published,
// synthesize a brand-voice description, assign a category, and queue for review.
// Approval publishes to the same affiliate-items store the gear pages render.

const TAG = "stillafloatcr-20";
const PENDING_KEY = "affiliate-pending";
export const CATEGORIES = ["air-travel", "cabin-essentials", "clothing", "cruise-fun", "great-ideas"] as const;
export type Category = (typeof CATEGORIES)[number];

export function buildAffiliateLink(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}?tag=${TAG}`;
}

// Guarantee the payable tag is present (the safeguard — nothing publishes without it).
export function hasTag(url: string): boolean {
  return new RegExp(`[?&]tag=${TAG}(?:&|$)`).test(url);
}

export interface RawProduct {
  asin: string;
  title: string;
  imageUrl?: string;
}

export interface PendingItem {
  id: string;
  asin: string;
  title: string;
  description: string;
  category: Category;
  imageUrl: string;
  affiliateLink: string;
  status: "pending";
  createdAt: string;
}

interface PendingStore {
  items: PendingItem[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface AffiliateItem extends Record<string, any> {
  id: string;
  title: string;
  description: string;
  category: string;
  smartStrip: string;
  affiliateLink: string;
  imageUrl: string;
  featured: boolean;
  createdAt: string;
  sortOrder: number;
}

export async function loadPending(): Promise<PendingStore> {
  return readJson<PendingStore>(PENDING_KEY, { items: [] });
}

async function loadAffiliateStore(): Promise<{ items: AffiliateItem[] }> {
  return readJson<{ items: AffiliateItem[] }>(PATHS.affiliateItems, { items: [] });
}

function asinOf(url: string): string {
  const m = String(url || "").match(/\/dp\/([A-Z0-9]{10})/) || String(url || "").match(/[?&]asin=([A-Z0-9]{10})/i);
  return m ? m[1]! : "";
}

const SYSTEM_PROMPT = `You are Mark, the cruiser behind "Still Afloat." Write each blurb the way you'd recommend the thing to a friend at a bar — warm, plain-spoken, specific, a little wry. First person is welcome ("the one I actually pack", "saved me on embarkation day"). Lead with the honest, concrete reason a cruiser wants it — the real use on the ship or on a travel day — and you can land a small laugh. "Cruise smarter, laugh more."

HARD RULES — do NOT write like a product listing or an ad:
- BANNED words/phrases (and anything like them): "perfect for", "must-have", "game changer", "elevate", "effortless", "make a splash", "stay charged/fresh/protected", "for your adventures", "wherever you roam", "across the globe", "featuring", "ultimate", "amazing", "sleek", "level up", "say goodbye to", any empty superlative, and any fake urgency.
- Do NOT echo the Amazon title or spec-sheet phrasing. Rewrite it as a real human recommendation.
- No "40 years" or invented backstory. Be specific instead of salesy.
- Honest: if it's a cheap-and-cheerful pick, say so plainly.

For each product, return: a 1–2 sentence description (specific + useful, ~20–40 words) and a category from EXACTLY this list:
- "clothing" = anything you wear: swimwear, rash guards, cover-ups, linen shirts/pants, dresses, footwear, hats, sunglasses
- "air-travel" = flight/airport/travel-day gear (packing organizers, toiletry kits, neck pillows, adapters, comfort)
- "cabin-essentials" = stateroom comfort/organization items
- "cruise-fun" = poolside fun, games, drinkware, and excursion extras that are NOT clothing
- "great-ideas" = genuinely cool/fun things, not necessarily cruise-specific

Pick "clothing" for ANY wearable item (especially swimwear) — do not put apparel in "cruise-fun".

Respond ONLY with JSON: { "items": [ { "idx": <int>, "description": "<string>", "category": "<one of the categories above>" } ] }.`;

interface LlmItem {
  idx: number;
  description?: string;
  category?: string;
}

async function describeAndCategorize(products: RawProduct[], apiKey: string): Promise<Map<number, { description: string; category: Category }>> {
  const out = new Map<number, { description: string; category: Category }>();
  if (!products.length || !apiKey) return out;

  const userContent = JSON.stringify(products.map((p, idx) => ({ idx, title: p.title })), null, 2);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Write a blurb + category for each product:\n\n${userContent}` },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (await response.json()) as any;
  const parsed = JSON.parse(payload?.choices?.[0]?.message?.content ?? "{}") as { items?: LlmItem[] };
  for (const it of parsed.items ?? []) {
    if (typeof it.idx !== "number") continue;
    const category = (CATEGORIES as readonly string[]).includes(it.category ?? "")
      ? (it.category as Category)
      : "great-ideas";
    out.set(it.idx, { description: (it.description ?? "").trim(), category });
  }
  return out;
}

// Ingest raw wishlist products → dedupe vs published + already-pending → describe →
// queue. Returns { added, skipped }.
export async function ingestProducts(
  raw: RawProduct[],
): Promise<{ added: PendingItem[]; skipped: { asin: string; reason: string }[] }> {
  const apiKey = process.env["OPENAI_API_KEY"] || "";
  const [published, pending] = await Promise.all([loadAffiliateStore(), loadPending()]);

  // Existing items may store the ASIN in either field (older items put the
  // category page in affiliateLink and the Amazon link only in smartStrip).
  const publishedAsins = new Set(
    published.items.map((i) => asinOf(i.smartStrip) || asinOf(i.affiliateLink)).filter(Boolean),
  );
  const pendingAsins = new Set(pending.items.map((i) => i.asin));

  const fresh: RawProduct[] = [];
  const skipped: { asin: string; reason: string }[] = [];
  for (const p of raw) {
    if (!p.asin || !/^[A-Z0-9]{10}$/.test(p.asin)) { skipped.push({ asin: p.asin || "?", reason: "no valid ASIN" }); continue; }
    if (publishedAsins.has(p.asin)) { skipped.push({ asin: p.asin, reason: "already on gear page" }); continue; }
    if (pendingAsins.has(p.asin)) { skipped.push({ asin: p.asin, reason: "already in review queue" }); continue; }
    fresh.push(p);
  }

  const meta = await describeAndCategorize(fresh, apiKey);
  const added: PendingItem[] = fresh.map((p, idx) => {
    const m = meta.get(idx);
    return {
      id: crypto.randomUUID(),
      asin: p.asin,
      title: p.title,
      description: m?.description ?? "",
      category: m?.category ?? "great-ideas",
      imageUrl: p.imageUrl ?? "",
      affiliateLink: buildAffiliateLink(p.asin),
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    };
  });

  pending.items.unshift(...added);
  await writeJson(PENDING_KEY, pending);
  logger.info({ added: added.length, skipped: skipped.length }, "affiliate ingest");
  return { added, skipped };
}

// Approve a pending item → publish to the affiliate-items store the gear pages read.
// feature=true sets it as THE featured item (clears featured on all others).
export async function approvePending(id: string, feature: boolean): Promise<AffiliateItem | null> {
  const pending = await loadPending();
  const item = pending.items.find((i) => i.id === id);
  if (!item) return null;
  if (!hasTag(item.affiliateLink)) return null; // safeguard: never publish an untagged (non-earning) link

  const store = await loadAffiliateStore();
  if (feature) store.items.forEach((i) => { i.featured = false; });

  const published: AffiliateItem = {
    id: crypto.randomUUID(),
    title: item.title,
    description: item.description,
    category: item.category,
    smartStrip: item.affiliateLink, // plain affiliate URL → renders the "Buy on Amazon" button
    affiliateLink: item.affiliateLink,
    imageUrl: item.imageUrl,
    featured: feature,
    createdAt: new Date().toISOString(),
    sortOrder: store.items.length,
  };
  store.items.push(published);
  await writeJson(PATHS.affiliateItems, store);

  pending.items = pending.items.filter((i) => i.id !== id);
  await writeJson(PENDING_KEY, pending);
  logger.info({ id, asin: item.asin, category: item.category, feature }, "affiliate approved → published");
  return published;
}

export async function rejectPending(id: string): Promise<boolean> {
  const pending = await loadPending();
  const before = pending.items.length;
  pending.items = pending.items.filter((i) => i.id !== id);
  if (pending.items.length === before) return false;
  await writeJson(PENDING_KEY, pending);
  return true;
}
