// group-analytics-store.ts — reads every group's rows for the Group Bookings Workspace (lib/group-analytics.ts builds the
// datasets from them). Read-only toward every table. Each table is read page by page (fetchAll), never cut off at 1,000 rows.

import { getSupabase, readJson } from "./persistence";
import { TRAVELER_COLS } from "./group-forms";
import { DEFAULTS_KEY, normalizeDefaults } from "./group-journey-store";
import { fetchAll, type AnalyticsRaw } from "./group-analytics";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (): any => getSupabase();

/** The columns read from group_messages: never body_html. */
const MESSAGE_COLS = "id, group_id, cabin_id, traveler_id, template, to_email, status, scheduled_for, sent_at, dedupe_key, created_at, updated_at, meta";
const INTEREST_COLS = "id, group_id, first_name, last_name, email, lang, cabin_type, guests, status, created_at";
const DOCUMENT_COLS = "id, group_id, cabin_id, traveler_id, kind, title, status, owner, due_date";
// id, pdf_path and sealed only become a signature id and two yes/no flags in the payload; the path never leaves (Mark 2026-10-25: open the signed copy from the workspace).
const SIGNATURE_COLS = "id, group_id, traveler_id, doc_key, signer_role, signed_at, pdf_path, sealed";

export async function loadAnalyticsRaw(): Promise<AnalyticsRaw> {
  const table = (name: string, cols: string, what = name) =>
    fetchAll((from, to) => db().from(name).select(cols).order("id", { ascending: true }).range(from, to), what);
  const [groups, cabins, travelers, payments, travel, checklist, documents, signatures, messages, interests, defaults] = await Promise.all([
    table("groups", "*"),
    table("group_cabins", "*"),
    table("group_travelers", TRAVELER_COLS),
    table("group_payments", "*"),
    table("group_travel", "*"),
    table("group_checklist", "*"),
    table("group_documents", DOCUMENT_COLS),
    table("group_signatures", SIGNATURE_COLS),
    table("group_messages", MESSAGE_COLS),
    table("group_interests", INTEREST_COLS),
    readJson<unknown>(DEFAULTS_KEY, { approved: {} }),
  ]);
  return { groups, cabins, travelers, payments, travel, checklist, documents, signatures, messages, interests, journeyDefaults: normalizeDefaults(defaults) };
}
