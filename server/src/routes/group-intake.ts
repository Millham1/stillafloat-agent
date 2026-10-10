import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { requireToken } from "../lib/http-auth";
import { logger } from "../lib/logger";
import { CHILDREN, GROUP_COLUMNS, missingSchedule, pickWritable, slugify } from "../lib/group-file";
import {
  MAX_PDF_BYTES, cabinRowsFromExtraction, travelRowsFromExtraction, describeProviders, extractBooking, extractPdfText, foundFields, normalizeExtraction,
  type BookingExtraction, type ReaderProvider,
} from "../lib/booking-extract";

// "Enter a booking" (Mark, 2026-10-02): drop the cruise line's contract or
// quote, the server reads it, Mark reviews what it read, the group file opens
// pre-filled. The PDF goes to the private `group-docs` bucket and is filed on
// the group as its contract document on accept.
//
//   POST /api/groups/intake            { booking_kind, lang, filename, data (base64 PDF) } → { intake }
//   GET  /api/groups/intake/:id        → { intake } (poll until status ready | failed)
//   POST /api/groups/intake/:id/retry  → re-run the reader
//   POST /api/groups/intake/:id/accept { group: {...}, cabins?: [...] } → { group }
//   GET  /api/groups/intake/:id/file   → short-lived signed URL to the PDF

const router: IRouter = Router();
const BUCKET = "group-docs";

// A document is read inside this one server process. If the process restarts
// mid-read (a deploy does exactly that) the row would say "reading" forever and
// the page would spin (2026-10-05, Mark's first real quote). At boot nothing can
// still be in flight, so any unfinished row was interrupted: say so plainly.
export async function recoverInterruptedIntakes(): Promise<number> {
  const { data, error } = await db().from("group_intakes")
    .update({ status: "failed", error: "Interrupted: the server restarted while this document was being read. Press Try again.", updated_at: new Date().toISOString() })
    .in("status", ["queued", "reading", "extracting"])
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}
setTimeout(() => {
  recoverInterruptedIntakes()
    .then((n) => { if (n) logger.warn({ count: n }, "booking intakes interrupted by a restart were marked failed"); })
    .catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "booking intake recovery skipped"));
}, 5_000).unref();
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (): any => getSupabase();

function fail(req: Request, res: Response, err: unknown, what: string) {
  req.log.error({ err }, what);
  return res.status(500).json({ success: false, error: (err as Error).message });
}

async function setStatus(id: string, patch: Row): Promise<void> {
  const { error } = await db().from("group_intakes").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`group_intakes: ${error.message}`);
}

/** Download → text → model → extracted. Runs after the upload request returns. */
async function processIntake(id: string): Promise<void> {
  try {
    const { data: intake, error } = await db().from("group_intakes").select("*").eq("id", id).maybeSingle();
    if (error || !intake) throw new Error(error?.message ?? "intake not found");
    await setStatus(id, { status: "reading", error: null });

    const { data: file, error: dl } = await db().storage.from(BUCKET).download(intake.storage_path);
    if (dl || !file) throw new Error(`download failed: ${dl?.message ?? "no data"}`);
    const text = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
    if (text.length < 40) {
      await setStatus(id, {
        status: "failed", text_chars: text.length,
        error: "The PDF has no readable text (it is probably a scan or a photo). Ask the line for the original PDF, or type the details in by hand.",
      });
      return;
    }
    await setStatus(id, { status: "extracting", text_chars: text.length });

    let providers: ReaderProvider[] = [];
    const extracted = await extractBooking(text, intake.booking_kind, (ps) => { providers = ps; });
    const reader = describeProviders(providers);
    await setStatus(id, { status: "ready", extracted, model: reader });
    logger.info({ intake: id, found: foundFields(extracted).length, warnings: extracted.warnings.length, chars: text.length, reader }, "booking intake read");
  } catch (err) {
    logger.error({ intake: id, err: err instanceof Error ? err.message : String(err) }, "booking intake failed");
    await setStatus(id, { status: "failed", error: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
  }
}

router.post("/groups/intake", requireToken, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Row;
    const kind = body["booking_kind"] === "individual" ? "individual" : "group";
    const lang = ["en", "es", "both"].includes(body["lang"]) ? body["lang"] : "en";
    const filename = String(body["filename"] ?? "document.pdf").replace(/[^\w.() -]+/g, "_").slice(0, 120) || "document.pdf";
    const data = typeof body["data"] === "string" ? body["data"] : "";
    const bytes = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
    if (bytes.length < 100) return res.status(400).json({ success: false, error: "No file received" });
    if (bytes.length > MAX_PDF_BYTES) return res.status(413).json({ success: false, error: "That PDF is over 20 MB" });
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return res.status(400).json({ success: false, error: "Only PDF files can be read" });

    const { data: intake, error } = await db()
      .from("group_intakes")
      .insert({ booking_kind: kind, lang, filename, storage_path: "pending", bytes: bytes.length })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    const storagePath = `${intake.id}/${filename.toLowerCase().endsWith(".pdf") ? filename : filename + ".pdf"}`;
    const { error: up } = await db().storage.from(BUCKET).upload(storagePath, bytes, { contentType: "application/pdf", upsert: false });
    if (up) {
      await setStatus(intake.id, { status: "failed", error: `upload failed: ${up.message}` });
      throw new Error(`upload failed: ${up.message}`);
    }
    await setStatus(intake.id, { storage_path: storagePath });
    setImmediate(() => { void processIntake(intake.id); });
    return res.status(202).json({ success: true, intake: { ...intake, storage_path: storagePath } });
  } catch (err) {
    return fail(req, res, err, "booking intake upload failed");
  }
});

router.get("/groups/intake/:id", requireToken, async (req: Request, res: Response) => {
  try {
    const { data, error } = await db().from("group_intakes").select("*").eq("id", String(req.params["id"])).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ success: false, error: "Intake not found" });
    const found = data.extracted ? foundFields(normalizeExtraction(data.extracted)) : [];
    return res.json({ success: true, intake: data, found });
  } catch (err) {
    return fail(req, res, err, "booking intake read failed");
  }
});

router.post("/groups/intake/:id/retry", requireToken, async (req: Request, res: Response) => {
  try {
    const id = String(req.params["id"]);
    const { data, error } = await db().from("group_intakes").select("id, status").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ success: false, error: "Intake not found" });
    if (data.status === "accepted") return res.status(409).json({ success: false, error: "Already accepted into a group" });
    await setStatus(id, { status: "queued", error: null });
    setImmediate(() => { void processIntake(id); });
    return res.status(202).json({ success: true });
  } catch (err) {
    return fail(req, res, err, "booking intake retry failed");
  }
});

router.get("/groups/intake/:id/file", requireToken, async (req: Request, res: Response) => {
  try {
    const { data, error } = await db().from("group_intakes").select("storage_path").eq("id", String(req.params["id"])).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ success: false, error: "Intake not found" });
    const { data: signed, error: se } = await db().storage.from(BUCKET).createSignedUrl(data.storage_path, 600);
    if (se || !signed) throw new Error(se?.message ?? "could not sign");
    return res.json({ success: true, url: signed.signedUrl, expiresIn: 600 });
  } catch (err) {
    return fail(req, res, err, "booking intake file link failed");
  }
});

/** Mark reviewed the form; open the group file from what he confirmed. */
router.post("/groups/intake/:id/accept", requireToken, async (req: Request, res: Response) => {
  try {
    const id = String(req.params["id"]);
    const { data: intake, error } = await db().from("group_intakes").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!intake) return res.status(404).json({ success: false, error: "Intake not found" });
    if (intake.status === "accepted") return res.status(409).json({ success: false, error: "Already accepted", group_id: intake.group_id });

    const body = (req.body ?? {}) as Row;
    const picked = pickWritable(GROUP_COLUMNS, body["group"]);
    if (!picked.ok) return res.status(400).json({ success: false, error: picked.error });
    const name = typeof picked.row["name"] === "string" ? picked.row["name"] : "";
    if (!name) return res.status(400).json({ success: false, error: "The group needs a name" });

    const extracted: BookingExtraction = normalizeExtraction(intake.extracted ?? {});
    const groupRow: Row = {
      ...picked.row,
      slug: slugify(name),
      booking_kind: intake.booking_kind,
      source_intake_id: id,
      lang: picked.row["lang"] ?? intake.lang,
      itinerary: picked.row["itinerary"] ?? extracted.itinerary,
      amenities: picked.row["amenities"] ?? extracted.amenities,
      inclusions: picked.row["inclusions"] ?? extracted.guest_inclusions,
      terms: {
        cabin_categories: extracted.cabin_categories,
        deposit_timing: extracted.deposit_timing,
        final_payment_days_before: extracted.final_payment_days_before,
        allotment_reviews: extracted.allotment_reviews,
        cancellation_schedule: extracted.cancellation_schedule,
        cancellation_note: extracted.cancellation_note,
        deadlines: extracted.deadlines,
      },
    };
    // Anything the confirmation form left out but the document said still goes on the file.
    for (const k of ["cruise_line", "ship_name", "sail_date", "return_date", "nights", "embark_port", "group_number", "cabins_held",
      "deposit_per_person", "deposit_due", "names_due", "final_payment_due", "recall_date", "organizer_name"] as const) {
      const v = (extracted as unknown as Row)[k];
      if ((groupRow[k] === undefined || groupRow[k] === null || groupRow[k] === "") && v !== null && v !== undefined) groupRow[k] = v;
    }
    const { data: group, error: ge } = await db().from("groups").insert(groupRow).select("*").single();
    if (ge) {
      return res.status(ge.code === "23505" ? 409 : 400).json({ success: false, error: ge.code === "23505" ? "A group with that name already exists" : ge.message });
    }

    // Cabins: what the form sent back, else what the document said.
    let cabins: Row[] = Array.isArray(body["cabins"]) ? (body["cabins"] as unknown[]).map((c) => {
      const p = pickWritable(CHILDREN["cabins"]!.columns, c);
      return p.ok ? p.row : null;
    }).filter((x): x is Row => !!x) : cabinRowsFromExtraction(extracted, intake.booking_kind);
    cabins = cabins.map((c) => ({ ...c, group_id: group.id }));
    let cabinRows: Row[] = [];
    if (cabins.length) {
      const { data: inserted, error: ce } = await db().from("group_cabins").insert(cabins).select("*");
      if (ce) throw new Error(`group_cabins: ${ce.message}`);
      cabinRows = inserted ?? [];
    }

    // Travelers named on an individual confirmation go straight onto the file.
    if (intake.booking_kind === "individual" && extracted.travelers.length) {
      const rows = extracted.travelers.map((t, i) => ({
        group_id: group.id, cabin_id: cabinRows[0]?.id ?? null, is_lead: i === 0,
        first_name: t.first_name, last_name: t.last_name, lang: intake.lang === "es" ? "es" : "en",
      }));
      const { error: te } = await db().from("group_travelers").insert(rows);
      if (te) throw new Error(`group_travelers: ${te.message}`);
    }

    // Air, hotel before and transfers: what the confirmation form sent back, else what the quote printed.
    const travel: Row[] = (Array.isArray(body["travel"]) ? (body["travel"] as unknown[]).map((t) => {
      const p = pickWritable(CHILDREN["travel"]!.columns, t);
      return p.ok ? p.row : null;
    }).filter((x): x is Row => !!x) : travelRowsFromExtraction(extracted)).map((t) => ({ ...t, group_id: group.id }));
    if (travel.length) {
      const { error: tre } = await db().from("group_travel").insert(travel);
      if (tre) throw new Error(`group_travel: ${tre.message}`);
    }

    // Payment schedule from the dates we now have.
    const schedule = missingSchedule({ group, cabins: cabinRows, payments: [] });
    if (schedule.length) {
      const { error: pe } = await db().from("group_payments").insert(schedule);
      if (pe) throw new Error(`group_payments: ${pe.message}`);
    }

    // File the PDF on the group.
    const { error: de } = await db().from("group_documents").insert({
      group_id: group.id,
      kind: intake.booking_kind === "group" ? "group-contract" : "confirmation",
      title: intake.filename,
      status: "filed",
      owner: "mark",
      completed_at: new Date().toISOString(),
      storage_path: intake.storage_path,
      notes: "Read by Enter a booking",
    });
    if (de) throw new Error(`group_documents: ${de.message}`);

    await setStatus(id, { status: "accepted", group_id: group.id });
    return res.status(201).json({ success: true, group, cabins: cabinRows.length, payments: schedule.length, travel: travel.length });
  } catch (err) {
    return fail(req, res, err, "booking intake accept failed");
  }
});

export default router;
