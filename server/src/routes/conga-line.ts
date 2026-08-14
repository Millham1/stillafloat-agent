// conga-line.ts — "Conga Line" ship rating API (Room Engine / cabin concierge).
//
// A crowd-sourced 1-5 "audience score" built from Cruiseline.com + CruiseCritic
// aggregates (read manually by a human — both sites' ToS bar bot access;
// Tripadvisor is deliberately excluded, Mark doesn't trust it as a source).
// Quarterly refresh, human-checked, never live/automated.
//
// Two independent editorial voices live on every rating:
//   comment      — warm paraphrase of real review themes, Mark's advisor voice
//                  (cabin-advisor/voice-guide.md). NEVER a lifted quote.
//   salty_grump_take  — a SEPARATE, always-present dry/skeptical aside (the
//                  Rotten-Tomatoes-critics-vs-audience split). Not a rating
//                  value, not on the 1-5 scale — sits alongside the crowd
//                  score regardless of what that score says. Humor targets the
//                  ship's actual tradeoffs, never the traveler, never mean.
//
// Draft -> approved is a separate, explicit action from draft -> published —
// nothing reaches the public endpoint until BOTH gates are crossed (Mark's
// standing rule for all AI-touched content in this project).
//
// conga_line_sources / conga_line_ratings are service-role-only by RLS, so the
// public page can never read them directly; everything goes through here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";
import { requireToken } from "../lib/http-auth";

const router: IRouter = Router();

// ── Voice (same locked asset the cabin concierge's live reasoning uses) ─────
const VOICE_FALLBACK = `You are Mark, a cruise advisor and the voice of Still Afloat. You are an ADVISOR who has earned trust by being straight with people — including telling them what is wrong with a room or a ship. Never sound like a pitch.

How Mark talks — match this closely:
- Plain, warm, flowing sentences, second person where natural. No clipped spec fragments, no coined cleverness, no dramatic flourishes, no dashes used for effect.
- Be honest about downsides, plainly and kindly — steering someone away from a poor fit is central to your value.
- Use plain, everyday words only — the kind you'd use talking to a friend, not writing a brochure. Say "a little" not "fractionally," "basically" not "essentially," "real" not "genuine," "extras" not "amenities." Simple always beats fancy.
- BANNED brochure-speak: "your best match", "perfect for", "boasts", "offers", "features", "nestled", "ideally positioned", "exactly what you're after", "look no further".`;

function loadVoice(): string {
  for (const p of [
    join(process.cwd(), "..", "cabin-advisor", "voice-guide.md"),
    join(process.cwd(), "cabin-advisor", "voice-guide.md"),
  ]) {
    try {
      const raw = readFileSync(p, "utf8");
      return raw.includes("\n---\n") ? raw.split("\n---\n").slice(1).join("\n---\n").trim() : raw.trim();
    } catch { /* try next */ }
  }
  return VOICE_FALLBACK;
}
const VOICE = loadVoice();

// The system prompt for the ONE Haiku call covers BOTH registers at once —
// Mark deliberately wanted a single pass so the two voices stay in the same
// head, not generated independently and stitched together.
const CONGA_SYSTEM = `${VOICE}

You are now writing copy for a ship-level "Conga Line" audience rating — a crowd-sourced score from 1 to 5 built by aggregating real Cruiseline.com and CruiseCritic review scores. You will write TWO distinct pieces of copy, in two different registers.

TWO FAILURES FROM EARLIER PASSES — do not repeat either: (1) a multi-sentence amenity list ("delivers on activity and variety... something for every age...") — brochure copy, too long. (2) "saltyGrumpTake" pointed out that the underlying sources disagree with each other (e.g. "the gap between the 4.6 and 3.4 tells you...") — THIS IS BANNED. The Conga Line score is presented as Still Afloat's OWN independent composite verdict. A customer must never be able to tell it was assembled from other sites' numbers, and saltyGrumpTake must NEVER reference sources, review counts, score gaps, "the data," or anything about where the number came from — that undermines the score's authority, which is the opposite of the point. Both fields must read as pure Mark's-own-opinion, full stop, with the compositing invisible.

1. "comment" — your MAIN, warm advisor voice (above). EXACTLY ONE sentence, hard cap ~25 words. Pick the ONE real theme that matters most (not a list of three or four) and state it plainly — one honest upside and, in the same breath, what it costs you, cause then effect, the way you'd size up a cabin. Never stack adjectives or list amenities. NEVER quote or closely lift review text — paraphrase the theme, not the sentence.

2. "saltyGrumpTake" — a SEPARATE one-liner, ONE sentence, in a DRYER, more skeptical register — the wry, well-traveled friend who's seen a hundred ships. This is NOT a rating and NOT part of the 1-5 scale; it sits ALONGSIDE the score as Mark's own independent aside. HARD RULES: (a) saltyGrumpTake must NOT repeat, rephrase, or reference the same specific fact used in "comment" — pick a genuinely different real theme from what you were given. (b) saltyGrumpTake must NEVER mention sources, review counts, ratings disagreeing, "the data," or anything that exposes how the score was built — it is Mark's own opinion, not a commentary on the composite. Good angles: a second real theme the comment didn't use, or WHO this ship actually suits vs. doesn't ("great if you like big and busy, skip it if you don't"). Humor always targets the ship's tradeoffs, never the traveler, never actually mean.

Target register (tone and length only — do not copy, write fresh from this ship's real themes):
comment: "Wonder's got real variety and a crew that means it, but book your shows early or you'll miss the good ones."
saltyGrumpTake: "Great if you like big and busy — if you're after quiet, this isn't your ship."

Ground both in the actual themes you're given. Do not invent a specific complaint or compliment that isn't implied by the supplied themes/scores. BANNED words/phrases in either field: "delivers", "boasts", "offers", "features", "something for everyone", "something for every age", "a real draw", "genuinely", "the crew is warm", any sentence that just lists three or more amenities in a row. Respond with ONLY a JSON object, no other text:
{"comment":"...","saltyGrumpTake":"..."}`;

// ── Blending sources into a 1-5 crowd score ──────────────────────────────────
// Deliberately never below 1 or above 5 — a real ship is never branded with an
// official worst-possible verdict (Mark works under a host agency and doesn't
// want supplier relationships soured by an official negative number). Honesty
// about a weak ship lives in salty_grump_take, never in this number.
type SourceInput = { score?: number | string; scale?: number | string; count?: number | string };

function normalizeSource(s: SourceInput | undefined): { norm: number; weight: number } | null {
  if (!s || s.score === undefined || s.score === null || s.score === "") return null;
  const score = Number(s.score);
  const scale = Number(s.scale) || 5;
  if (!Number.isFinite(score) || !Number.isFinite(scale) || scale <= 0) return null;
  const norm = Math.max(0, Math.min(5, (score / scale) * 5));
  const count = Number(s.count);
  const weight = Number.isFinite(count) && count > 0 ? count : 1;
  return { norm, weight };
}

function blendRating(cruiseline?: SourceInput, cruisecritic?: SourceInput): { rating: number; display: string; sourceCount: number } | null {
  const parts = [normalizeSource(cruiseline), normalizeSource(cruisecritic)].filter((p): p is { norm: number; weight: number } => p !== null);
  if (!parts.length) return null;
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  let rating = parts.reduce((a, p) => a + p.norm * p.weight, 0) / totalWeight;
  rating = Math.max(1, Math.min(5, rating));       // clamp — 1 to 5 ONLY, never lower
  rating = Math.round(rating * 2) / 2;              // nearest half point for a clean display
  const display = `${Number.isInteger(rating) ? rating : rating.toFixed(1)}/5 Conga Line`;
  return { rating, display, sourceCount: parts.length };
}

// ── GET /api/ships/:slug/rating — public, only published+approved ───────────
router.get("/ships/:slug/rating", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  try {
    const slug = String(req.params["slug"] || "").trim();
    if (!slug) return res.status(400).json({ ok: false, error: "ship slug required" });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("conga_line_ratings")
      .select("ship_slug, rating, rating_display, comment, salty_grump_take, source_count, computed_at, status, comment_status")
      .eq("ship_slug", slug)
      .eq("status", "published")
      .eq("comment_status", "approved")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: "No published rating for this ship" });

    const row = data as {
      ship_slug: string; rating: number; rating_display: string | null; comment: string | null;
      salty_grump_take: string | null; source_count: number | null; computed_at: string | null;
    };
    return res.json({
      ok: true,
      shipSlug: row.ship_slug,
      rating: row.rating,
      ratingDisplay: row.rating_display,
      comment: row.comment,
      saltyGrumpTake: row.salty_grump_take,
      sourceCount: row.source_count,
      computedAt: row.computed_at,
    });
  } catch (err) {
    logger.error({ err }, "conga-line: rating lookup failed");
    return res.status(500).json({ ok: false, error: "Could not load rating" });
  }
});

// ── GET /api/ships/ratings — all published+approved ─────────────────────────
router.get("/ships/ratings", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("conga_line_ratings")
      .select("ship_slug, rating, rating_display, comment, salty_grump_take, source_count, computed_at")
      .eq("status", "published")
      .eq("comment_status", "approved")
      .order("ship_slug");
    if (error) throw new Error(error.message);
    return res.json({ ok: true, ratings: data ?? [] });
  } catch (err) {
    logger.error({ err }, "conga-line: ratings list failed");
    return res.status(500).json({ ok: false, error: "Could not load ratings" });
  }
});

// ── Admin: everything below is token-gated ───────────────────────────────────

// POST /api/admin/conga-line/:slug/sources — add/update one source's score.
// One row per (ship, source) is upserted app-side (no DB unique constraint —
// conga_line_sources is kept as a plain append-friendly table so a future pass
// can retain full capture history without a migration).
router.post("/admin/conga-line/:slug/sources", requireToken, async (req: Request, res: Response) => {
  try {
    const slug = String(req.params["slug"] || "").trim();
    if (!slug) return res.status(400).json({ ok: false, error: "ship slug required" });
    const body = (req.body ?? {}) as {
      source?: string; sourceScore?: number | string; sourceScale?: number | string;
      reviewCount?: number | string; sourceUrl?: string; notes?: string; capturedBy?: string;
    };
    const source = String(body.source || "").trim();
    if (source !== "cruiseline" && source !== "cruisecritic") {
      return res.status(400).json({ ok: false, error: "source must be 'cruiseline' or 'cruisecritic'" });
    }

    const supabase = getSupabase();
    const { data: existing } = await supabase
      .from("conga_line_sources")
      .select("id")
      .eq("ship_slug", slug)
      .eq("source", source)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const row = {
      ship_slug: slug,
      source,
      source_score: body.sourceScore === undefined || body.sourceScore === "" ? null : Number(body.sourceScore),
      source_scale: body.sourceScale === undefined || body.sourceScale === "" ? 5 : Number(body.sourceScale),
      review_count: body.reviewCount === undefined || body.reviewCount === "" ? null : Number(body.reviewCount),
      source_url: body.sourceUrl || null,
      notes: body.notes || null,
      captured_by: body.capturedBy || "mark",
      captured_at: new Date().toISOString(),
    };

    if (existing) {
      const { error } = await (supabase.from("conga_line_sources") as ReturnType<typeof supabase.from>)
        .update(row).eq("id", (existing as { id: string }).id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await (supabase.from("conga_line_sources") as ReturnType<typeof supabase.from>).insert(row);
      if (error) throw new Error(error.message);
    }

    // Return the current source set for this ship so the dashboard can refresh in place.
    const { data: sources } = await supabase
      .from("conga_line_sources")
      .select("source, source_score, source_scale, review_count, source_url, notes, captured_at, captured_by")
      .eq("ship_slug", slug);
    return res.json({ ok: true, sources: sources ?? [] });
  } catch (err) {
    logger.error({ err }, "conga-line: save source failed");
    return res.status(500).json({ ok: false, error: "Could not save source" });
  }
});

// POST /api/admin/conga-line/:slug/draft-comment — ONE Haiku call, both
// registers, returns a candidate rating + comment + saltyGrumpTake. Does NOT save.
router.post("/admin/conga-line/:slug/draft-comment", requireToken, async (req: Request, res: Response) => {
  try {
    const slug = String(req.params["slug"] || "").trim();
    if (!slug) return res.status(400).json({ ok: false, error: "ship slug required" });
    const body = (req.body ?? {}) as {
      ship?: string;
      cruiseline?: SourceInput; cruisecritic?: SourceInput;
      themes?: string;
    };

    const blended = blendRating(body.cruiseline, body.cruisecritic);
    if (!blended) return res.status(400).json({ ok: false, error: "At least one source score is required" });

    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) return res.status(503).json({ ok: false, error: "AI drafting is not configured (ANTHROPIC_API_KEY missing)" });

    const shipName = body.ship || slug.replace(/-/g, " ");
    const sourceLines: string[] = [];
    if (body.cruiseline?.score) {
      sourceLines.push(`Cruiseline.com: ${body.cruiseline.score}/${body.cruiseline.scale || 5}${body.cruiseline.count ? ` (${body.cruiseline.count} reviews)` : ""}`);
    }
    if (body.cruisecritic?.score) {
      sourceLines.push(`CruiseCritic: ${body.cruisecritic.score}/${body.cruisecritic.scale || 5}${body.cruisecritic.count ? ` (${body.cruisecritic.count} reviews)` : ""}`);
    }
    const themes = String(body.themes || "").trim();

    const prompt = `Ship: ${shipName}.

Computed crowd score (already blended from the raw source scores below — do not restate the arithmetic, just use it as your grounding): ${blended.display}.

Source scores read manually off the public review pages:
${sourceLines.join("\n") || "(none entered)"}

Recurring themes noticed while reading the reviews (free notes, not verbatim quotes — paraphrase further, do not lift phrasing even from these notes):
${themes || "(no themes entered — write from the source scores alone, keep it general)"}

Write the "comment" and "saltyGrumpTake" as specified.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5", max_tokens: 700, system: CONGA_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(25000),
    });
    const j = (await r.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };
    if (!r.ok || j.stop_reason === "refusal") throw new Error(`anthropic ${r.status} ${j.stop_reason ?? ""}`);
    const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in draft response");
    const out = JSON.parse(m[0]) as { comment?: string; saltyGrumpTake?: string };
    if (!out.comment || !out.saltyGrumpTake) throw new Error("incomplete draft (missing comment or saltyGrumpTake)");

    const cost = (j.usage?.input_tokens ?? 0) * 1e-6 + (j.usage?.output_tokens ?? 0) * 5e-6;
    logger.info({ ship: slug, cost: cost.toFixed(4) }, "conga-line: draft generated");

    return res.json({
      ok: true,
      rating: blended.rating,
      ratingDisplay: blended.display,
      sourceCount: blended.sourceCount,
      comment: out.comment,
      saltyGrumpTake: out.saltyGrumpTake,
    });
  } catch (err) {
    logger.error({ err }, "conga-line: draft-comment failed");
    return res.status(500).json({ ok: false, error: "Could not draft copy" });
  }
});

// POST /api/admin/conga-line/:slug/save — persist as DRAFT (never publishes).
router.post("/admin/conga-line/:slug/save", requireToken, async (req: Request, res: Response) => {
  try {
    const slug = String(req.params["slug"] || "").trim();
    if (!slug) return res.status(400).json({ ok: false, error: "ship slug required" });
    const body = (req.body ?? {}) as {
      rating?: number | string; ratingDisplay?: string; comment?: string; saltyGrumpTake?: string; sourceCount?: number | string;
    };
    const rating = Number(body.rating);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ ok: false, error: "rating must be between 1 and 5" });
    }
    if (!body.comment || !body.saltyGrumpTake) {
      return res.status(400).json({ ok: false, error: "comment and saltyGrumpTake are both required" });
    }

    const supabase = getSupabase();
    const now = new Date();
    const refreshDue = new Date(now); refreshDue.setMonth(refreshDue.getMonth() + 3); // quarterly cadence

    const row = {
      ship_slug: slug,
      rating,
      rating_display: body.ratingDisplay || `${Number.isInteger(rating) ? rating : rating.toFixed(1)}/5 Conga Line`,
      comment: body.comment,
      salty_grump_take: body.saltyGrumpTake,
      comment_status: "draft",
      source_count: body.sourceCount === undefined ? null : Number(body.sourceCount),
      computed_at: now.toISOString(),
      refresh_due_at: refreshDue.toISOString(),
      status: "draft",
      updated_at: now.toISOString(),
    };

    const { error } = await (supabase.from("conga_line_ratings") as ReturnType<typeof supabase.from>)
      .upsert(row, { onConflict: "ship_slug" });
    if (error) throw new Error(error.message);

    logger.info({ ship: slug }, "conga-line: saved as draft");
    return res.json({ ok: true, saved: row });
  } catch (err) {
    logger.error({ err }, "conga-line: save failed");
    return res.status(500).json({ ok: false, error: "Could not save draft" });
  }
});

// POST /api/admin/conga-line/:slug/publish — the explicit, separate go-live
// action. Flips BOTH gates. A row must already exist (save first).
router.post("/admin/conga-line/:slug/publish", requireToken, async (req: Request, res: Response) => {
  try {
    const slug = String(req.params["slug"] || "").trim();
    if (!slug) return res.status(400).json({ ok: false, error: "ship slug required" });

    const supabase = getSupabase();
    const { data: existing } = await supabase
      .from("conga_line_ratings").select("ship_slug, comment, salty_grump_take").eq("ship_slug", slug).maybeSingle();
    if (!existing) return res.status(404).json({ ok: false, error: "No draft saved for this ship yet" });
    const row = existing as { comment: string | null; salty_grump_take: string | null };
    if (!row.comment || !row.salty_grump_take) {
      return res.status(400).json({ ok: false, error: "Draft is missing comment or saltyGrumpTake — cannot publish" });
    }

    const { error } = await (supabase.from("conga_line_ratings") as ReturnType<typeof supabase.from>)
      .update({ comment_status: "approved", status: "published", updated_at: new Date().toISOString() })
      .eq("ship_slug", slug);
    if (error) throw new Error(error.message);

    logger.info({ ship: slug }, "conga-line: published");
    return res.json({ ok: true, published: true });
  } catch (err) {
    logger.error({ err }, "conga-line: publish failed");
    return res.status(500).json({ ok: false, error: "Could not publish" });
  }
});

// POST /api/admin/conga-line/:slug/unpublish — revert to draft (used for
// test/verification passes and for pulling a rating back for revision).
router.post("/admin/conga-line/:slug/unpublish", requireToken, async (req: Request, res: Response) => {
  try {
    const slug = String(req.params["slug"] || "").trim();
    if (!slug) return res.status(400).json({ ok: false, error: "ship slug required" });
    const supabase = getSupabase();
    const { error } = await (supabase.from("conga_line_ratings") as ReturnType<typeof supabase.from>)
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("ship_slug", slug);
    if (error) throw new Error(error.message);
    return res.json({ ok: true, unpublished: true });
  } catch (err) {
    logger.error({ err }, "conga-line: unpublish failed");
    return res.status(500).json({ ok: false, error: "Could not unpublish" });
  }
});

// GET /api/admin/conga-line — list every rating (draft + published) for the
// dashboard's admin list, plus each ship's saved source rows.
router.get("/admin/conga-line", requireToken, async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: ratings, error } = await supabase
      .from("conga_line_ratings")
      .select("*")
      .order("ship_slug");
    if (error) throw new Error(error.message);
    const { data: sources } = await supabase
      .from("conga_line_sources")
      .select("ship_slug, source, source_score, source_scale, review_count, source_url, notes, captured_at, captured_by");
    return res.json({ ok: true, ratings: ratings ?? [], sources: sources ?? [] });
  } catch (err) {
    logger.error({ err }, "conga-line: admin list failed");
    return res.status(500).json({ ok: false, error: "Could not load ratings" });
  }
});

export default router;
