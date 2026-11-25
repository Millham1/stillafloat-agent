// genie.ts — the Vacation Genie API: the single-booking front door (Mark, 2026-11-24).
//
// The road, one call per step, every step after the first carrying the row's id and access key:
//   POST /genie/start     their name and email (the gate) -> a genie_sessions row
//   POST /genie/ships     the trip facts + the answers about them -> the ships. The Genie's own questions
//                         set where they sit on each ship virtue (lib/genie-interview genieProfile); the
//                         scoring is routes/cabins.ts suggestShips, Conga ratings included
//   POST /genie/sailings  the ship they went with -> her sailings inside their dates (our own table)
//   POST /genie/price     the sailing they picked -> the fare by room type (Cruise API, lib/genie-pricing)
//   (rooms)               the page calls the Room Concierge's own POST /cabins/recommend
//   POST /genie/finish    the cabins they picked + when to call -> the file goes to Mark
// And for Mark, behind his token: GET /genie/leads, POST /genie/leads/:id.
//
// This is lead-gen, not a booking engine: nothing here holds a room or takes money. The fare shown is the
// line's advertised figure and the page says Mark confirms it.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";
import { sendMail } from "../lib/mailer";
import { verifyTurnstile } from "../lib/turnstile";
import { clientIp } from "../lib/client-ip";
import { hourlyLimiter } from "../lib/hourly-limit";
import { requireToken } from "../lib/http-auth";
import { trailEvent, trailEmail } from "../lib/contact-trail";
import { keepOnTrail, pullMailboxFor } from "./contact-trail";
import { suggestShips } from "./cabins";
import { searchCruiseRows, shipCodes, shipNameKeys } from "../lib/cruise-api";
import {
  parseTrip, partyOf, guestsPerRoom, genieProfile, profileAxes, profileInWords, answersInWords,
  type TripFacts, type GenieProfile,
} from "../lib/genie-interview";
import {
  fareSearchBody, faresFromRows, guestsToAsk, sailingChoices, fareLine,
  type SailingFares, type SailingRow, type SailingChoice,
} from "../lib/genie-pricing";

const router: IRouter = Router();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (): any => getSupabase();

const startLimited = hourlyLimiter(8);      // new interviews per address per hour
const stepLimited = hourlyLimiter(120);     // every other step
/** Fare lookups one interview may make: each is a paid search against a monthly allowance. */
const PRICE_LOOKUPS_MAX = 6;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const CABIN_RE = /^[A-Za-z0-9]{1,8}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

interface Row {
  id: string; access_key: string; email: string; first_name: string; last_name: string; phone: string | null; lang: "en" | "es";
  trip: TripFacts | null; choices: number[] | null; answers_words: { key: string; title?: string; answer: string }[] | null;
  suggested_ships: string[] | null; ship_slug: string | null; ship_name: string | null; ship_line: string | null;
  sailing: SailingChoice | null; fares: SailingFares | null; price_lookups: number; cabins: string[] | null;
  call_when: string | null; status: string; created_at: string; finished_at: string | null; mark_note: string | null;
  axes: Record<string, string> | null; traits: GenieProfile | null;
}

/** The interview a step belongs to, or null (and the reply already sent). The key is compared in constant time. */
async function sessionFor(req: Request, res: Response): Promise<Row | null> {
  if (stepLimited(clientIp(req))) { res.status(429).json({ error: "Too many requests. Give it a few minutes and try again." }); return null; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const id = typeof b["session"] === "string" ? b["session"] : "";
  const key = typeof b["key"] === "string" ? b["key"] : "";
  if (!UUID_RE.test(id) || key.length !== 48) { res.status(401).json({ error: "This interview has expired. Start again from the top." }); return null; }
  const { data, error } = await db().from("genie_sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as Row | null;
  const ok = !!row && row.access_key.length === key.length && timingSafeEqual(Buffer.from(row.access_key), Buffer.from(key));
  if (!ok) { res.status(401).json({ error: "This interview has expired. Start again from the top." }); return null; }
  return row;
}

async function patch(id: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("genie_sessions").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

// ── 1. The gate: name and email ──────────────────────────────────────────────
router.post("/genie/start", async (req: Request, res: Response) => {
  try {
    if (startLimited(clientIp(req))) return res.status(429).json({ error: "Too many tries from this connection. Give it an hour, or email mark@stillafloatcruising.com." });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const first = String(b["firstName"] ?? "").trim().slice(0, 60);
    const last = String(b["lastName"] ?? "").trim().slice(0, 60);
    const email = trailEmail(b["email"]);
    const phone = String(b["phone"] ?? "").trim().slice(0, 30) || null;
    if (!first) return res.status(400).json({ error: "Add your first name." });
    if (!last) return res.status(400).json({ error: "Add your last name." });
    if (!email) return res.status(400).json({ error: "That email address does not look right. Check it and try again." });
    const turnstileOk = await verifyTurnstile((b["cf-turnstile-response"] as string) || null);
    if (!turnstileOk) return res.status(400).json({ error: "The spam check did not pass. Refresh the page and try again." });

    const key = randomBytes(24).toString("hex");
    const { data, error } = await db().from("genie_sessions")
      .insert({ access_key: key, email, first_name: first, last_name: last, phone, lang: b["lang"] === "es" ? "es" : "en" })
      .select("id").single();
    if (error) throw new Error(error.message);
    const id = (data as { id: string }).id;
    void keepOnTrail([trailEvent({ email, name: `${first} ${last}`, what: "Started the Vacation Genie", key: `genie-start:${id}` })]);
    logger.info({ id }, "genie: interview started");
    return res.json({ session: id, key });
  } catch (err) {
    logger.error({ err }, "genie/start failed");
    return res.status(500).json({ error: "Something broke on my end. Email mark@stillafloatcruising.com and I will take it from there." });
  }
});

// ── 2. Trip facts + personality answers -> the ships ────────────────────────
router.post("/genie/ships", async (req: Request, res: Response) => {
  try {
    const row = await sessionFor(req, res);
    if (!row) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseTrip(b["trip"], today());
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const choices = Array.isArray(b["choices"]) ? (b["choices"] as unknown[]).map((n) => Number(n)) : [];
    const { trip } = parsed;
    const profile = genieProfile(choices, trip.childAges.length > 0);
    if (!profile) return res.status(400).json({ error: "One of the questions about you has no answer. Go back and pick one." });
    // The labels only word the "I picked them because" line and gate the quiet-enclave offer; food and
    // active are the two that line reads as numbers. The ship itself is chosen from `profile`.
    const axes = profileAxes(profile);

    const out = await suggestShips({
      personality: axes, party: partyOf(trip), budget: trip.budget, destination: trip.destination,
      traits: { food: profile.target.dining, active: profile.target.activity }, profile,
    }, row.lang);
    if (!out) throw new Error("virtue matrix unavailable");

    await patch(row.id, {
      trip, choices, answers_words: answersInWords(choices), traits: profile, axes,
      suggested_ships: [...out.picks.map((p) => p.slug), ...(out.worthALook ? [out.worthALook.slug] : [])],
    });
    return res.json({ ...out, party: partyOf(trip) });
  } catch (err) {
    logger.error({ err }, "genie/ships failed");
    return res.status(500).json({ error: "I could not match a ship just now. Try again in a minute." });
  }
});

// ── 3. The ship they went with -> her sailings inside their dates ────────────
router.post("/genie/sailings", async (req: Request, res: Response) => {
  try {
    const row = await sessionFor(req, res);
    if (!row) return;
    if (!row.trip) return res.status(400).json({ error: "Answer the trip questions first." });
    const slug = String((req.body as Record<string, unknown>)["ship"] ?? "");
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "Pick a ship first." });
    const { data: shipData } = await db().from("cabin_ships").select("slug,ship,line").eq("slug", slug).eq("in_fleet", true).maybeSingle();
    const ship = shipData as { slug: string; ship: string; line: string } | null;
    if (!ship) return res.status(404).json({ error: "I do not know that ship." });

    // planned_sailings names a ship as the registry does; the fleet list sometimes carries the line in
    // front ("Carnival Mardi Gras"). Ask for both spellings.
    const names = [...new Set([ship.ship, ...shipNameKeys(ship.ship)])];
    const rows: SailingRow[] = [];
    for (const n of names) {
      const { data, error } = await db().from("planned_sailings")
        .select("ship_name,operator,start_date,end_date,ports,source")
        .ilike("ship_name", n).gte("start_date", row.trip.earliest).lte("start_date", row.trip.latest)
        .order("start_date").limit(400);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as SailingRow[]));
    }
    const sailings = sailingChoices(rows, row.trip);
    await patch(row.id, { ship_slug: ship.slug, ship_name: ship.ship, ship_line: ship.line, sailing: null, fares: null, cabins: null });
    return res.json({ ship: { slug: ship.slug, ship: ship.ship, line: ship.line }, sailings });
  } catch (err) {
    logger.error({ err }, "genie/sailings failed");
    return res.status(500).json({ error: "I could not read the sailing list just now. Try again in a minute." });
  }
});

// ── 4. The sailing they picked -> the fare by room type ──────────────────────
const fareCache = new Map<string, { at: number; out: SailingFares }>();
const FARE_TTL_MS = 6 * 60 * 60 * 1000;

router.post("/genie/price", async (req: Request, res: Response) => {
  try {
    const row = await sessionFor(req, res);
    if (!row) return;
    if (!row.trip || !row.ship_name) return res.status(400).json({ error: "Pick a ship first." });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const start = String(b["start"] ?? "");
    if (!ISO_DAY.test(start) || start < row.trip.earliest || start > row.trip.latest) return res.status(400).json({ error: "Pick one of the sailing dates on the list." });
    const nights = Number.isInteger(b["nights"]) ? (b["nights"] as number) : null;
    const end = typeof b["end"] === "string" && ISO_DAY.test(b["end"]) ? b["end"] : null;
    const ports = Array.isArray(b["ports"]) ? (b["ports"] as unknown[]).filter((p): p is string => typeof p === "string").slice(0, 30).map((p) => p.slice(0, 80)) : [];
    const sailing: SailingChoice = { start, end, nights, ports, from: ports[0] ?? null };

    // No fare is a normal answer (the API does not carry every line): the page then says Mark will price it.
    let fares: SailingFares | null = null;
    let why: "ok" | "not-listed" | "limit" | "unavailable" = "unavailable";
    const codes = await shipCodes();
    const code = shipNameKeys(row.ship_name).map((k) => codes.get(k)).find(Boolean) ?? null;
    if (!code) why = "not-listed";
    else {
      const guests = guestsToAsk(guestsPerRoom(row.trip), code.line);
      const cacheKey = `${code.line}:${code.code}:${start}:${nights ?? "?"}:${guests}`;
      const hit = fareCache.get(cacheKey);
      if (hit && Date.now() - hit.at < FARE_TTL_MS) { fares = hit.out; why = "ok"; }
      else if (row.price_lookups >= PRICE_LOOKUPS_MAX) why = "limit";
      else {
        await patch(row.id, { price_lookups: row.price_lookups + 1 });
        const r = await searchCruiseRows(fareSearchBody({ lineCode: code.line, shipCode: code.code, start, guests }));
        if (r) {
          const out = faresFromRows(r.rows, { shipName: row.ship_name, lineCode: code.line, start, nights, guests });
          if (out.fares.length) {
            fares = out; why = "ok";
            if (fareCache.size > 300) fareCache.clear();
            fareCache.set(cacheKey, { at: Date.now(), out });
          } else why = "not-listed";
        }
      }
    }
    await patch(row.id, { sailing, fares, cabins: null });
    return res.json({ sailing, fares, why });
  } catch (err) {
    logger.error({ err }, "genie/price failed");
    return res.status(500).json({ error: "I could not get the fare just now. Try again in a minute." });
  }
});

// ── 5. Hand the file to Mark ─────────────────────────────────────────────────
const ROOM_WORD: Record<string, string> = { inside: "Interior", oceanview: "Ocean view", balcony: "Balcony", suite: "Suite" };

/** The whole file as rows of [label, value], for Mark's email and his dashboard. Plain words throughout. */
export function fileRows(row: Row): [string, string][] {
  const t = row.trip;
  const out: [string, string][] = [
    ["Name", `${row.first_name} ${row.last_name}`], ["Email", row.email], ["Phone", row.phone ?? "not given"],
  ];
  if (row.call_when) out.push(["Best time to call", row.call_when]);
  if (t) {
    const kids = t.childAges.length ? `, ${t.childAges.length} ${t.childAges.length === 1 ? "child" : "children"} (ages ${t.childAges.join(", ")})` : "";
    out.push(
      ["Travelers", `${t.adults} ${t.adults === 1 ? "adult" : "adults"}${kids}`],
      ["Rooms", String(t.rooms)],
      ["Can sail", `${t.earliest} to ${t.latest}`],
      ["Trip length", t.nightsMin === t.nightsMax ? `${t.nightsMin} nights` : `${t.nightsMin} to ${t.nightsMax} nights`],
      ["Where", t.destination === "surprise" ? "Open: wherever the ship fits" : t.destination.replace(/_/g, " ")],
      ["Room type asked for", ROOM_WORD[t.room] ?? t.room],
      ["Matters most aboard", t.priority], ["Budget", t.budget],
      ["Seasick", t.seasick ? "Yes" : "No"], ["First cruise", t.firstCruise ? "Yes" : "No"],
      ["Occasion", t.occasion === "none" ? "None given" : t.occasion],
      ["Needs an accessible room or short distances", t.mobility ? "Yes" : "No"],
    );
    if (t.notes) out.push(["Their note", t.notes]);
  }
  if (row.ship_name) out.push(["Ship they chose", `${row.ship_name} (${row.ship_line ?? ""})`]);
  if (row.suggested_ships?.length) out.push(["Ships shown", row.suggested_ships.join(", ")]);
  if (row.sailing) {
    out.push(["Sailing", `${row.sailing.start}${row.sailing.nights ? `, ${row.sailing.nights} nights` : ""}`]);
    if (row.sailing.ports.length) out.push(["Ports", row.sailing.ports.join(" · ")]);
  }
  if (row.fares?.fares.length) for (const f of row.fares.fares) out.push(["Fare shown", fareLine(f, row.fares.guests)]);
  else if (row.sailing) out.push(["Fare shown", "None: no fare came back for this sailing"]);
  if (row.cabins?.length) out.push(["Cabins they picked", row.cabins.join(", ")]);
  if (row.traits?.target) for (const [k, v] of profileInWords(row.traits)) out.push([`What the answers say: ${k}`, v]);
  for (const a of row.answers_words ?? []) out.push([`Asked: ${a.title ?? a.key}`, a.answer]);
  return out;
}

router.post("/genie/finish", async (req: Request, res: Response) => {
  try {
    const row = await sessionFor(req, res);
    if (!row) return;
    if (!row.trip) return res.status(400).json({ error: "Answer the trip questions first." });
    if (row.status !== "started") return res.json({ ok: true });   // sent already: one file, one email
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cabins = [...new Set((Array.isArray(b["cabins"]) ? b["cabins"] : []).map((c) => String(c).trim()).filter((c) => CABIN_RE.test(c)))].slice(0, 24);
    const callWhen = String(b["callWhen"] ?? "").trim().slice(0, 200) || null;
    const phone = String(b["phone"] ?? "").trim().slice(0, 30) || row.phone;
    const finishedAt = new Date().toISOString();
    await patch(row.id, { cabins, call_when: callWhen, phone, status: "finished", finished_at: finishedAt });
    const full: Row = { ...row, cabins, call_when: callWhen, phone, status: "finished", finished_at: finishedAt };

    const name = `${row.first_name} ${row.last_name}`;
    void keepOnTrail([trailEvent({
      email: row.email, name, what: "Finished the Vacation Genie",
      detail: [row.ship_name, row.sailing?.start, cabins.length ? `cabins ${cabins.join(", ")}` : null].filter(Boolean).join(" · ") || null,
      key: `genie-finish:${row.id}`,
    })]);

    const table = fileRows(full).map(([k, v]) =>
      `<tr><td style="padding:6px 12px 6px 0;color:#475569;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#07183f;font-weight:600">${esc(v)}</td></tr>`).join("");
    const alertTo = process.env["APPROVAL_EMAIL"];
    if (alertTo) {
      void sendMail({
        to: alertTo, fromName: "Still Afloat Vacation Genie", replyTo: row.email,
        subject: `Vacation Genie: ${name}${row.ship_name ? `, ${row.ship_name}` : ""}${row.sailing ? `, ${row.sailing.start}` : ""}`,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#07183f"><p>${esc(name)} finished the Vacation Genie and is waiting on your call.</p><table style="border-collapse:collapse">${table}</table><p>The full file is on the dashboard under Vacation Genie.</p></div>`,
      });
    }
    void sendMail({
      to: row.email, fromName: "Mark at Still Afloat",
      subject: "I have your trip. Here is what happens next",
      html: `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;color:#07183f;max-width:560px">
<p>Hi ${esc(row.first_name)},</p>
<p>Your answers came through${row.ship_name ? `, along with ${esc(row.ship_name)}${row.sailing ? ` on ${esc(row.sailing.start)}` : ""}` : ""}. I will go through all of it myself and then get in touch to walk it with you.</p>
<p>The fare you saw is the cruise line's advertised price today. Before I give you a final number I check it against the group rates and extras I can get you, so your quote may come back better than what the screen showed.</p>
<p>Nothing is booked and nothing is owed. If you think of something you forgot to tell me, reply to this email.</p>
<p>Mark Millham<br>Still Afloat Cruising</p></div>`,
    });
    logger.info({ id: row.id, ship: row.ship_slug }, "genie: file handed to Mark");
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "genie/finish failed");
    return res.status(500).json({ error: "Your answers did not send. Try the button again, or email mark@stillafloatcruising.com." });
  }
});

// ── Mark's side ──────────────────────────────────────────────────────────────
router.get("/genie/leads", requireToken, async (_req: Request, res: Response) => {
  try {
    const { data, error } = await db().from("genie_sessions").select("*").order("created_at", { ascending: false }).limit(300);
    if (error) throw new Error(error.message);
    const leads = ((data ?? []) as Row[]).map((r) => ({
      id: r.id, status: r.status, created_at: r.created_at, finished_at: r.finished_at,
      name: `${r.first_name} ${r.last_name}`, email: r.email, phone: r.phone,
      ship: r.ship_name, sailing: r.sailing?.start ?? null, mark_note: r.mark_note, file: fileRows(r),
    }));
    return res.json({ success: true, leads });
  } catch (err) {
    logger.error({ err }, "genie/leads failed");
    return res.status(500).json({ success: false, error: "Could not read the Vacation Genie files" });
  }
});

const MARK_STATUSES = new Set(["finished", "contacted", "quoted", "booked", "closed"]);
router.post("/genie/leads/:id", requireToken, async (req: Request, res: Response) => {
  try {
    const id = String(req.params["id"] ?? "");
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: "Unknown file" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    if (typeof b["status"] === "string") {
      if (!MARK_STATUSES.has(b["status"])) return res.status(400).json({ success: false, error: "Unknown status" });
      fields["status"] = b["status"];
    }
    if (typeof b["mark_note"] === "string") fields["mark_note"] = b["mark_note"].slice(0, 2000) || null;
    if (!Object.keys(fields).length) return res.status(400).json({ success: false, error: "Nothing to change" });
    await patch(id, fields);
    return res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "genie/leads update failed");
    return res.status(500).json({ success: false, error: "Could not save that" });
  }
});

/**
 * Mark deletes a file he is done with (2026-11-25: "i dont want to keep dead files").
 *
 * The file goes; the person's paper trail stays (his ruling of 2026-11-14, confirmed for the Genie on
 * 2026-11-25: "Keep the trail"). A line saying the file was deleted is written to the trail FIRST, and
 * what his mailbox holds for them is pulled onto it, so the trail is whole before the row is gone. If the
 * line cannot be written the file is not deleted: a delete that loses the record is worse than a dead file.
 */
router.delete("/genie/leads/:id", requireToken, async (req: Request, res: Response) => {
  try {
    const id = String(req.params["id"] ?? "");
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: "Unknown file" });
    const { data, error } = await db().from("genie_sessions").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ success: false, error: "That file is not there any more. Reload the page." });
    const row = data as Row;
    const name = `${row.first_name} ${row.last_name}`.trim();
    const detail = [
      `Started ${String(row.created_at).slice(0, 10)}`,
      `status when deleted: ${row.status}`,
      row.ship_name ? `ship shown: ${row.ship_name}` : null,
      row.sailing?.start ? `sailing ${row.sailing.start}` : null,
    ].filter(Boolean).join(", ");
    const line = trailEvent({ email: row.email, name, what: "Vacation Genie file deleted", detail, key: `genie-deleted:${id}` });
    if (line && (await keepOnTrail([line])) === 0) {
      return res.status(500).json({ success: false, error: "The file was not deleted, because the line for their contact trail could not be written. Try again." });
    }
    void pullMailboxFor(row.email, name || null).catch((e: unknown) =>
      logger.warn({ err: e instanceof Error ? e.message : String(e) }, "paper trail: the mailbox could not be read for a deleted Vacation Genie file"));
    const { error: de } = await db().from("genie_sessions").delete().eq("id", id);
    if (de) throw new Error(de.message);
    return res.json({ success: true, deleted: { name: name || "This person" } });
  } catch (err) {
    logger.error({ err }, "genie/leads delete failed");
    return res.status(500).json({ success: false, error: "The file was not deleted. Try again." });
  }
});

export default router;
