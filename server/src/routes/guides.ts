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
//
// The expected-page rules come from expectedGuidePages() in the renderer itself
// rather than being re-derived here. The first cut of this file assumed every
// published guide gets an English page, and immediately raised a false alarm on
// a Spanish-only guide. A drift check that drifts from the thing it checks is
// worse than no check, because the first false alarm teaches you to ignore it.

import { Router, type IRouter } from "express";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { requireToken } from "../lib/http-auth";
import { runGuidesPrerender, expectedGuidePages } from "../lib/prerender-guides";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function publicDir(): string {
  return path.resolve(process.cwd(), "public");
}

/** Slugs that actually have a rendered page on disk, per language. */
async function renderedSlugs(): Promise<{ en: string[]; es: string[] }> {
  const read = async (...seg: string[]) => {
    try {
      const files = await readdir(path.join(publicDir(), ...seg));
      return files.filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""));
    } catch {
      return [];
    }
  };
  return { en: await read("guides"), es: await read("es", "guides") };
}

async function drift() {
  const [expected, rendered] = await Promise.all([expectedGuidePages(), renderedSlugs()]);
  const missingEn = expected.en.filter((s) => !rendered.en.includes(s));
  const missingEs = expected.es.filter((s) => !rendered.es.includes(s));
  return {
    ok: missingEn.length === 0 && missingEs.length === 0,
    expected: { en: expected.en.length, es: expected.es.length },
    rendered: { en: rendered.en.length, es: rendered.es.length },
    missing: { en: missingEn, es: missingEs },
  };
}

/**
 * Is the published site in step with the data?
 *
 * Returns slugs only, never bodies. Anything under `missing` is a guide Mark
 * believes he published which is currently a 404.
 */
router.get("/guides/status", async (_req, res) => {
  try {
    res.json(await drift());
  } catch (err) {
    logger.error({ err }, "guides status check failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * Re-render the guide pages now instead of waiting up to an hour for the tick.
 *
 * Gated: it writes files into the public directory. Returns the render counts
 * AND the post-run drift, so the caller learns whether the publish actually took
 * rather than merely that a job was started.
 */
router.post("/guides/prerender", requireToken, async (_req, res) => {
  try {
    const result = await runGuidesPrerender();
    const after = await drift();
    logger.info({ ...result, ...after }, "Guides prerender forced");
    res.json({ ...after, ...result });
  } catch (err) {
    logger.error({ err }, "forced guides prerender failed");
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
