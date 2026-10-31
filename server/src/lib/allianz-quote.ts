// allianz-quote.ts — the Allianz price for a traveler's trip, fetched in the background after they submit their information
// (Mark 2026-10-30: "build a routing that opens Allianz to get the pricing (pricing subject to change until finalized)"; 10/29:
// "we will have to open the allianz site with my credentials and move through the quote process. it can be done in the
// background after they submit their quote information"). The agent portal is driven in a headless browser on the box with
// Mark's own sign-in from shared.env (ALLIANZ_AGENT_USER / ALLIANZ_AGENT_PASSWORD); the page shows the plans and prices it read,
// never a number of its own. When the portal cannot be quoted (no sign-in on the box, no browser, the portal's screens not yet
// mapped, or an error), the status says so and Mark gets a "Waiting on you" row to send the quote himself.
import type { Row } from "./group-document-kit";

export const QUOTE_NOTE = "Pricing subject to change until finalized.";
export const AGENTMAX_URL = "https://agentmax.allianztravelinsurance.com/";

export interface QuoteInput {
  /** The traveler's home state, two letters (the premium depends on it). */
  state: string;
  depart_date: string;
  return_date: string;
  /** Per person, what the cruise line charges (the fare on the file). */
  trip_cost: number;
  /** The signer's birth date; their cabin-mates' when on the file. */
  birth_dates: string[];
  /** The date the deposit was paid (the time-sensitive benefits count from it); null when the file does not say. */
  deposit_date: string | null;
  destination: string;
}
export interface QuotePlan { name: string; price_per_person: number }

/** A plan as the page offers it and the file keeps it: "OneTrip Prime: $129 per person" (the page's own wording, so the server
 *  can check that what came back is one of the plans it offered). */
export function planLabel(p: { name?: unknown; price_per_person?: unknown }): string {
  const v = Number(p.price_per_person);
  const money = Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }) : String(p.price_per_person ?? "");
  return `${String(p.name ?? "").trim()}: $${money} per person`;
}

/** The Allianz plans Mark typed on the group file, one per line ("OneTrip Prime: $129 per person"; "OneTrip Basic — $89"):
 *  the price a line names is per person; a line with no dollar figure is not a plan. */
export function plansFromText(text: unknown): QuotePlan[] {
  if (typeof text !== "string") return [];
  const out: QuotePlan[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s*[:—–-]*\s*\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(line);
    if (!m) continue;
    const price = Number(m[2]!.replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({ name: m[1]!.replace(/[\s:—–-]+$/, ""), price_per_person: price });
  }
  return out;
}
export interface QuoteRecord {
  status: "pending" | "ready" | "unavailable";
  requested_at: string;
  quoted_at: string | null;
  plans: QuotePlan[];
  note: string;
  /** Why no price could be read, in words for Mark's row; never shown to the client as is. */
  reason: string | null;
  input: QuoteInput | null;
  /** When Mark's "send the quote" row was made, so it is made once. */
  action_at: string | null;
}

/** What the portal needs, from the file; the missing pieces named when it cannot be built. */
export function quoteInputFor(loaded: { group: Row; traveler: Row | null; cabin: Row | null; mates: Row[] }): QuoteInput | { missing: string[] } {
  const { group, traveler, cabin, mates } = loaded;
  const missing: string[] = [];
  const csz = typeof traveler?.form_data?.city_state_zip === "string" ? traveler.form_data.city_state_zip : "";
  const state = (/,\s*([A-Z]{2})\s+\d{5}/.exec(csz)?.[1] ?? "").toUpperCase();
  if (!state) missing.push("home state");
  const depart = typeof group.sail_date === "string" ? group.sail_date.slice(0, 10) : "";
  const back = typeof group.return_date === "string" ? group.return_date.slice(0, 10) : "";
  if (!depart || !back) missing.push("sailing dates");
  const cats = Array.isArray(group.terms?.cabin_categories) ? (group.terms.cabin_categories as Row[]) : [];
  const cat = cats.find((c) => c.code && cabin?.category_code && String(c.code).toUpperCase() === String(cabin.category_code).toUpperCase()) ?? cats.find((c) => c.category && cabin?.category && c.category === cabin.category);
  const perPerson = Number(cat?.price_per_person);
  const fromTotal = Number(cabin?.price_total) > 0 && mates.length + 1 > 0 ? Number(cabin?.price_total) / (mates.length + 1) : NaN;
  const tripCost = perPerson > 0 ? perPerson : fromTotal > 0 ? Math.round(fromTotal * 100) / 100 : NaN;
  if (!(tripCost > 0)) missing.push("cruise fare per person");
  const dobs = [traveler?.dob, ...mates.map((m) => m.dob)].filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)).map((d) => d.slice(0, 10));
  if (!dobs.length) missing.push("birth date");
  if (missing.length) return { missing };
  const deposit = typeof cabin?.deposit_paid_at === "string" ? cabin.deposit_paid_at.slice(0, 10) : typeof cabin?.booked_at === "string" ? cabin.booked_at.slice(0, 10) : null;
  const itinerary: Row[] = Array.isArray(group.itinerary) ? group.itinerary : [];
  const home = String(group.embark_port ?? "").trim().toLowerCase();
  const ports = itinerary.map((s) => (typeof s?.port === "string" ? s.port.trim() : "")).filter((p) => p && !/^(at sea|cruising|sea day)/i.test(p) && p.toLowerCase() !== home);
  return { state, depart_date: depart, return_date: back, trip_cost: tripCost, birth_dates: dobs, deposit_date: deposit, destination: ports.join(", ") || String(group.embark_port ?? "") };
}

// ── The portal's screens, as steps a headless browser follows ─────────────────
// A value of "$user" / "$password" is Mark's sign-in; any other "$name" is a field of the quote input (e.g. "$trip_cost").
export type PortalStep =
  | { do: "goto"; url: string }
  | { do: "wait"; selector: string }
  | { do: "click"; selector: string }
  | { do: "type"; selector: string; value: string }
  | { do: "select"; selector: string; value: string }
  | { do: "plans"; row: string; name: string; price: string };

/** The AgentMax quote screens. Mapped from Mark's own signed-in session; until then the job reports "portal-not-mapped". */
export const ALLIANZ_PORTAL: { loginUrl: string; steps: PortalStep[] } = { loginUrl: AGENTMAX_URL, steps: [] };

export interface QuoteEnv { chromePath: string | undefined; user: string | undefined; password: string | undefined }
export type QuoteOutcome = { status: "ready"; plans: QuotePlan[] } | { status: "unavailable"; reason: string };

/** Drive the portal and read the plans. Nothing is invented: no browser, no sign-in or no map → unavailable, with the reason. */
export async function fetchAllianzQuote(input: QuoteInput, env: QuoteEnv, portal = ALLIANZ_PORTAL): Promise<QuoteOutcome> {
  if (!env.chromePath) return { status: "unavailable", reason: "no browser on this box (CHROME_PATH)" };
  if (!env.user || !env.password) return { status: "unavailable", reason: "no Allianz agent sign-in on this box (ALLIANZ_AGENT_USER / ALLIANZ_AGENT_PASSWORD)" };
  if (!portal.steps.length) return { status: "unavailable", reason: "the Allianz portal's quote screens are not mapped yet" };
  const values: Record<string, string> = { user: env.user, password: env.password, ...Object.fromEntries(Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")])) };
  const fill = (v: string) => (v.startsWith("$") ? values[v.slice(1)] ?? "" : v);
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: env.chromePath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(portal.loginUrl, { waitUntil: "networkidle2" });
    let plans: QuotePlan[] = [];
    for (const step of portal.steps) {
      switch (step.do) {
        case "goto": await page.goto(fill(step.url), { waitUntil: "networkidle2" }); break;
        case "wait": await page.waitForSelector(step.selector, { visible: true }); break;
        case "click": await page.click(step.selector); break;
        case "type": await page.click(step.selector, { clickCount: 3 }); await page.type(step.selector, fill(step.value)); break;
        case "select": await page.select(step.selector, fill(step.value)); break;
        case "plans":
          await page.waitForSelector(step.row, { visible: true });
          plans = await page.$$eval(step.row, (rows, nameSel, priceSel) => rows.map((r) => ({
            name: (r.querySelector(nameSel as string)?.textContent ?? "").trim(),
            price_per_person: Number(((r.querySelector(priceSel as string)?.textContent ?? "").match(/[\d,]+(?:\.\d{2})?/) ?? ["0"])[0].replace(/,/g, "")),
          })), step.name, step.price);
          break;
      }
    }
    plans = plans.filter((p) => p.name && p.price_per_person > 0);
    return plans.length ? { status: "ready", plans } : { status: "unavailable", reason: "the portal showed no plan with a price" };
  } catch (err) {
    return { status: "unavailable", reason: `the portal could not be quoted: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
