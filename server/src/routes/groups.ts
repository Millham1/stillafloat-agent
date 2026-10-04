import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { requireToken } from "../lib/http-auth";
import {
  CHILDREN,
  GROUP_COLUMNS,
  missingSchedule,
  pickWritable,
  slugify,
  summarize,
  type GroupFile,
} from "../lib/group-file";

// Group bookings — the one place a group's file lives (migration 0041).
// Every route is dashboard-token gated: these tables hold traveler PII, so there
// is no public read or write path here. The traveler-facing form (signed link)
// is a separate route added with the paperwork step.
const router: IRouter = Router();

type Row = Record<string, any>;

// The generated client has no schema types (drizzle is unused), so table writes
// infer `never`; the column whitelist in lib/group-file.ts is the real contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (): any => getSupabase();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadFile(groupId: string): Promise<GroupFile & { travel: Row[]; messages: Row[] } | null> {
  const supabase = db();
  const { data: group, error } = await supabase.from("groups").select("*").eq("id", groupId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!group) return null;

  const child = async (key: string): Promise<Row[]> => {
    const spec = CHILDREN[key]!;
    const { data, error: e } = await supabase
      .from(spec.table)
      .select(spec.select)
      .eq("group_id", groupId)
      .order(spec.order, { ascending: true, nullsFirst: false })
      .order("id", { ascending: true });
    if (e) throw new Error(`${spec.table}: ${e.message}`);
    return (data ?? []) as unknown as Row[];
  };
  const [cabins, travelers, documents, payments, travel, checklist] = await Promise.all([
    child("cabins"), child("travelers"), child("documents"), child("payments"), child("travel"), child("checklist"),
  ]);
  const { data: messages, error: me } = await supabase
    .from("group_messages")
    .select("id, cabin_id, traveler_id, audience, template, to_email, subject, status, scheduled_for, sent_at, error, created_at")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(500);
  if (me) throw new Error(`group_messages: ${me.message}`);

  return { group, cabins, travelers, documents, payments, travel, checklist, messages: (messages ?? []) as Row[] };
}

function fail(req: Request, res: Response, err: unknown, what: string) {
  req.log.error({ err }, what);
  return res.status(500).json({ success: false, error: (err as Error).message });
}

/** GET /api/groups — every group with its roll-up. */
router.get("/groups", requireToken, async (req: Request, res: Response) => {
  try {
    const supabase = db();
    const { data: groups, error } = await supabase
      .from("groups")
      .select("*")
      .order("sail_date", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true });
    if (error) throw new Error(error.message);
    const out = [];
    for (const g of groups ?? []) {
      const file = await loadFile(g.id);
      if (file) out.push({ ...g, summary: summarize(file, today()) });
    }
    return res.json({ success: true, groups: out });
  } catch (err) {
    return fail(req, res, err, "groups list failed");
  }
});

/** POST /api/groups — open a new group file. */
router.post("/groups", requireToken, async (req: Request, res: Response) => {
  try {
    const picked = pickWritable(GROUP_COLUMNS, req.body);
    if (!picked.ok) return res.status(400).json({ success: false, error: picked.error });
    const name = typeof picked.row["name"] === "string" ? picked.row["name"] : "";
    if (!name) return res.status(400).json({ success: false, error: "A group needs a name" });
    const slug = slugify(typeof picked.row["slug"] === "string" ? picked.row["slug"] : name);
    if (!slug) return res.status(400).json({ success: false, error: "Could not make a web address from that name" });

    const supabase = db();
    const { data, error } = await supabase.from("groups").insert({ ...picked.row, slug }).select("*").single();
    if (error) {
      const dup = error.code === "23505";
      return res.status(dup ? 409 : 400).json({ success: false, error: dup ? "A group with that name already exists" : error.message });
    }

    // Convenience: open the block with N empty held cabins.
    const count = Number((req.body as Row)?.["cabins_held"] ?? 0);
    if (Number.isInteger(count) && count > 0 && count <= 200) {
      const rows = Array.from({ length: count }, () => ({ group_id: data.id }));
      const { error: ce } = await supabase.from("group_cabins").insert(rows);
      if (ce) throw new Error(`group_cabins: ${ce.message}`);
    }
    return res.status(201).json({ success: true, group: data });
  } catch (err) {
    return fail(req, res, err, "group create failed");
  }
});

/** GET /api/groups/:id — the whole file plus the roll-up. */
router.get("/groups/:id", requireToken, async (req: Request, res: Response) => {
  try {
    const file = await loadFile(String(req.params["id"]));
    if (!file) return res.status(404).json({ success: false, error: "Group not found" });
    const horizon = Number(req.query["horizon"] ?? 30);
    return res.json({ success: true, ...file, summary: summarize(file, today(), Number.isFinite(horizon) ? horizon : 30) });
  } catch (err) {
    return fail(req, res, err, "group read failed");
  }
});

/** PATCH /api/groups/:id */
router.patch("/groups/:id", requireToken, async (req: Request, res: Response) => {
  try {
    const picked = pickWritable(GROUP_COLUMNS, req.body);
    if (!picked.ok) return res.status(400).json({ success: false, error: picked.error });
    if ("slug" in picked.row) picked.row["slug"] = slugify(String(picked.row["slug"] ?? ""));
    if (picked.row["slug"] === "" || picked.row["name"] === null) {
      return res.status(400).json({ success: false, error: "Name and web address cannot be empty" });
    }
    if (!Object.keys(picked.row).length) return res.status(400).json({ success: false, error: "Nothing to update" });
    const supabase = db();
    const { data, error } = await supabase
      .from("groups")
      .update({ ...picked.row, updated_at: new Date().toISOString() })
      .eq("id", String(req.params["id"]))
      .select("*")
      .maybeSingle();
    if (error) return res.status(400).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: "Group not found" });
    return res.json({ success: true, group: data });
  } catch (err) {
    return fail(req, res, err, "group update failed");
  }
});

/** POST /api/groups/:id/payment-schedule — add the missing deposit + final rows
 * for every live cabin from the group's dates. Safe to repeat. */
router.post("/groups/:id/payment-schedule", requireToken, async (req: Request, res: Response) => {
  try {
    const file = await loadFile(String(req.params["id"]));
    if (!file) return res.status(404).json({ success: false, error: "Group not found" });
    if (!file.group.deposit_due && !file.group.final_payment_due) {
      return res.status(400).json({ success: false, error: "Set the group's deposit and final payment dates first" });
    }
    const rows = missingSchedule(file);
    if (rows.length) {
      const { error } = await db().from("group_payments").insert(rows);
      if (error) throw new Error(error.message);
    }
    return res.json({ success: true, added: rows.length });
  } catch (err) {
    return fail(req, res, err, "payment schedule failed");
  }
});

// ── Child rows: cabins / travelers / documents / payments / travel / checklist ──

router.post("/groups/:id/:child", requireToken, async (req: Request, res: Response) => {
  try {
    const spec = CHILDREN[String(req.params["child"])];
    if (!spec) return res.status(404).json({ success: false, error: "Unknown section" });
    const picked = pickWritable(spec.columns, req.body);
    if (!picked.ok) return res.status(400).json({ success: false, error: picked.error });
    const supabase = db();
    const groupId = String(req.params["id"]);
    const { data: group } = await supabase.from("groups").select("id").eq("id", groupId).maybeSingle();
    if (!group) return res.status(404).json({ success: false, error: "Group not found" });
    const { data, error } = await supabase
      .from(spec.table)
      .insert({ ...picked.row, group_id: groupId })
      .select(spec.select)
      .single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    return res.status(201).json({ success: true, row: data });
  } catch (err) {
    return fail(req, res, err, "group child create failed");
  }
});

router.patch("/groups/:id/:child/:rowId", requireToken, async (req: Request, res: Response) => {
  try {
    const spec = CHILDREN[String(req.params["child"])];
    if (!spec) return res.status(404).json({ success: false, error: "Unknown section" });
    const picked = pickWritable(spec.columns, req.body);
    if (!picked.ok) return res.status(400).json({ success: false, error: picked.error });
    if (!Object.keys(picked.row).length) return res.status(400).json({ success: false, error: "Nothing to update" });
    const { data, error } = await db()
      .from(spec.table)
      .update({ ...picked.row, updated_at: new Date().toISOString() })
      .eq("id", String(req.params["rowId"]))
      .eq("group_id", String(req.params["id"]))
      .select(spec.select)
      .maybeSingle();
    if (error) return res.status(400).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: "Row not found" });
    return res.json({ success: true, row: data });
  } catch (err) {
    return fail(req, res, err, "group child update failed");
  }
});

router.delete("/groups/:id/:child/:rowId", requireToken, async (req: Request, res: Response) => {
  try {
    const spec = CHILDREN[String(req.params["child"])];
    if (!spec) return res.status(404).json({ success: false, error: "Unknown section" });
    const { data, error } = await db()
      .from(spec.table)
      .delete()
      .eq("id", String(req.params["rowId"]))
      .eq("group_id", String(req.params["id"]))
      .select("id");
    if (error) return res.status(400).json({ success: false, error: error.message });
    if (!data?.length) return res.status(404).json({ success: false, error: "Row not found" });
    return res.json({ success: true });
  } catch (err) {
    return fail(req, res, err, "group child delete failed");
  }
});

export default router;
