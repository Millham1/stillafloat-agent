// The paper trail, for Mark only (Mark 2026-11-14: "there should be a 'paper trail' ... for retrieval if necessary").
//   GET  /api/trail                 everyone on the trail: name, address, how many interactions, the latest, their groups
//   GET  /api/trail?email=<addr>    one person's whole trail, oldest first (site emails, mailbox messages, record events)
//   POST /api/trail/refresh         { email }: ask the mailbox for that person's messages now and add the new ones to the trail
// The table is contact_trail (migration 0074); the rules are lib/contact-trail.ts. Nothing here deletes a row.
import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { requireToken } from "../lib/http-auth";
import { logger } from "../lib/logger";
import { opsMailTrail } from "../lib/ops-schedule";
import { trailEmail, trailFromMailbox, trailPeople, type TrailRow } from "../lib/contact-trail";

type Row = Record<string, any>;
const router: IRouter = Router();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (): any => getSupabase();
const COLS = "email, name, kind, direction, subject, snippet, status, at, group_id, group_name, source_id, meta";

/** Write rows to the trail; a row already there (same source_id) is left as it is. Never throws: the trail must not break the action it records. */
export async function keepOnTrail(rows: Array<TrailRow | null>): Promise<number> {
  const real = rows.filter((r): r is TrailRow => !!r);
  if (!real.length) return 0;
  try {
    const { error } = await db().from("contact_trail").upsert(real.map((r) => ({ ...r, meta: r.meta ?? {} })), { onConflict: "source_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return real.length;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), rows: real.length }, "paper trail: rows could not be kept");
    return 0;
  }
}

/** Ask the mailbox for one person's messages and add the new ones. Returns how many the mailbox held, or null when it could not be asked. */
export async function pullMailboxFor(email: string, name: string | null = null): Promise<number | null> {
  const messages = await opsMailTrail([email]);
  if (messages === null) return null;
  const { data, error } = await db().from("contact_trail").select("email, kind, subject, at").eq("email", email);
  if (error) throw new Error(error.message);
  await keepOnTrail(trailFromMailbox(messages, (data ?? []) as TrailRow[], name));
  return messages.length;
}

router.get("/trail", requireToken, async (req: Request, res: Response) => {
  try {
    const asked = req.query["email"];
    if (asked !== undefined) {
      const email = trailEmail(asked);
      if (!email) return res.status(400).json({ success: false, error: "That is not an email address." });
      const { data, error } = await db().from("contact_trail").select(COLS).eq("email", email);
      if (error) throw new Error(error.message);
      const rows = ((data ?? []) as Row[]).sort((a, b) => String(a["at"]).localeCompare(String(b["at"])));
      return res.json({ success: true, email, name: rows.find((r) => r["name"])?.["name"] ?? null, rows });
    }
    const { data, error } = await db().from("contact_trail").select("email, name, at, group_name");
    if (error) throw new Error(error.message);
    return res.json({ success: true, people: trailPeople((data ?? []) as TrailRow[]) });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "paper trail read failed");
    return res.status(500).json({ success: false, error: "The paper trail could not be read." });
  }
});

router.post("/trail/refresh", requireToken, async (req: Request, res: Response) => {
  try {
    const email = trailEmail((req.body as Row | undefined)?.["email"]);
    if (!email) return res.status(400).json({ success: false, error: "That is not an email address." });
    const found = await pullMailboxFor(email);
    if (found === null) return res.status(503).json({ success: false, error: "The mailbox could not be asked just now. The trail shows what was already kept." });
    return res.json({ success: true, email, mailbox: found });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "paper trail refresh failed");
    return res.status(500).json({ success: false, error: "The mailbox's messages could not be added." });
  }
});

export default router;
