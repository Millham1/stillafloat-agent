// guides.ts — force a guides re-render, and report whether the site matches the data.
//
// Guides live in platform_state and are served as STATIC pages written by
// runGuidesPrerender() on an hourly tick. There is no guides admin route, so a
// guide is published by writing the data directly — and nothing then republishes
// the pages until the next tick fires.
//
// Found 2026-08-27 publishing the Benadryl/Dramamine guide: the row was stored
// correctly and the page returned 404 for the best part of an hour, with nothing
// anywhere reporting which of those two states the site was in. Approving a NEWS
// proposal already calls runNewsPrerender() immediately (routes/proposals.ts) for
// exactly this reason; guides never got the same treatment.
//
// So: a trigger to publish now, and a status endpoint that answers "is the site
// actually showing what the database says?" — the question that had no answer.

import { Router, type IRouter } from "express";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { requireToken } from "../lib/http-auth";
import { runGuidesPrerender } from "../lib/prerender-guides";
import { readJson, PATHS } from "../lib/persistence";
import { logger } from "../lib/logger";

const router: IRouter = Router();

interface Guide {
  slug?: string;
  published?: boolean;
  title?: string;
}

function publicDir(): string {
  return path.resolve(process.cwd(), "public");
}

/** Slugs the data says should be live. */
async function expectedSlugs(): Promise<string[]> {
  const data = await readJson<{ guides?: Guide[] }>(PATHS.guides, { guides: [] });
  return (data.guides ?? [])
    .filter((g) => g && g.published !== false && g.slug)
    .map((g) => String(g.slug));
}

/** Slugs that actually have a rendered page on disk. */
async function renderedSlugs(): Promise<string[]> {
  try {
    const files = await readdir(path.join(publicDir(), "guides"));
    return files.filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""));
  } catch {
    return [];
  }
}

/**
 * Is the published site in step with the data?
 *
 * Deliberately unauthenticated-safe in what it returns: slugs only, no bodies.
 * `missing` is the number that matters — anything in it is a guide Mark believes
 * he published which is currently a 404.
 */
router.get("/guides/status", async (_req, res) => {
  try {
    const [expected, rendered] = await Promise.all([expectedSlugs(), renderedSlugs()]);
    const missing = expected.filter((s) => !rendered.includes(s));
    const orphaned = rendered.filter((s) => !expected.includes(s));
    res.json({
      ok: missing.length === 0,
      expected: expected.length,
      rendered: rendered.length,
      missing,
      orphaned,
    });
  } catch (err) {
    logger.error({ err }, "guides status check failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * Re-render the guide pages now instead of waiting up to an hour for the tick.
 *
 * Gated: it writes files into the public directory. Returns the counts AND the
 * post-run status, so the caller learns whether the publish actually took rather
 * than just that a job was started.
 */
router.post("/guides/prerender", requireToken, async (_req, res) => {
  try {
    const result = await runGuidesPrerender();
    const [expected, rendered] = await Promise.all([expectedSlugs(), renderedSlugs()]);
    const missing = expected.filter((s) => !rendered.includes(s));
    logger.info({ ...result, missing }, "Guides prerender forced");
    res.json({ ok: missing.length === 0, ...result, missing });
  } catch (err) {
    logger.error({ err }, "forced guides prerender failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
