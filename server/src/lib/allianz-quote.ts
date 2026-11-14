// allianz-quote.ts — the Allianz price for a traveler's trip, fetched in the background after they submit their information
// (Mark 2026-10-30: "build a routing that opens Allianz to get the pricing (pricing subject to change until finalized)"; 10/29:
// "we will have to open the allianz site with my credentials and move through the quote process. it can be done in the
// background after they submit their quote information"). The agent portal is driven in a headless browser on the box with
// Mark's own sign-in from shared.env (ALLIANZ_AGENT_USER / ALLIANZ_AGENT_PASSWORD); the page shows the plans and prices it read,
// never a number of its own. When the portal cannot be quoted (no sign-in on the box, no browser, the portal's screens not yet
// mapped, or an error), the status says so and Mark gets a "Waiting on you" row to send the quote himself.
import type { Row } from "./group-document-kit";

export const QUOTE_NOTE = "Pricing subject to change until finalized.";
// 2026-11-10: the agents' sign-in (Email + Password, "Log In") is here. agentmax.allianztravelinsurance.com answers with a bare welcome page and no way in.
export const AGENTMAX_URL = "https://www.agentmaxonline.com/agentmaxweb/agentportal/index.html#/login";

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

// ── The whole TRIP quoted for a booking (Mark 2026-11-10) ─────────────────────
// "once I complete adding the travel costs (cruise, air, hotel, transfers) the agent goes out to Allianz and enters the information to get the quotes."
// The agents' site was walked in Mark's own signed-in session on 2026-11-10: the Get Quote form on the home screen takes the home state, the TOTAL
// trip cost for everyone, each traveler's age (a pop-up, one box a traveler), the departure, return and first-deposit dates; the next screen lists
// every plan with ONE price for the whole party. That price is kept as printed: it is never divided per person. "Select product" starts a sale and
// is never pressed.

export interface TripQuoteInput { state: string; total_trip_cost: number; ages: number[]; depart_date: string; return_date: string; deposit_date: string }
/** One line of a plan's benefit table as Allianz's site prints it: the benefit, its coverage, and the limits listed under it. */
export interface PlanBenefit { name: string; coverage: string; limits: Array<{ name: string; value: string }> }
/** benefits and about (Mark 2026-11-13: "in the insurance popup on the quote page there also should be a choice to view the coverages"): read off
 *  Allianz's own results screen with the price, word for word; absent on a quote fetched before that date. */
export interface TripPlan { name: string; total: number; benefits?: PlanBenefit[]; about?: string }
export type TripQuoteOutcome = { status: "ready"; plans: TripPlan[] } | { status: "unavailable"; reason: string };

export const ALLIANZ_SITE = {
  email: 'input[type="email"]', password: 'input[type="password"]', logIn: 'button[type="submit"]',
  state: "#StateOfResidence", tripCost: "#tripCost", ages: "#TravelerAges", age: (i: number) => `#age-traveler-${i}`,
  addTraveler: "popover-container button.btn-link:not(.done-button)", agesDone: "popover-container .done-button",
  depart: "#DepartureDate", back: "#ReturnDate", deposit: "#InitialDepositDate", getQuote: "Get Quote",
  planRow: ".panel-heading", planName: ".col-xs-9", planPrice: ".product-price", plan: "accordion-group.product",
} as const;

/** 2027-05-09 → 05/09/2027, the way the site's date boxes take it. */
export const usDate = (ymd: string): string => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;
/** Whole years between a birth date and a day (the age the site asks for). */
export function ageOnDay(dob: string, day: string): number {
  const [y, m, d] = dob.slice(0, 10).split("-").map(Number) as [number, number, number], [Y, M, D] = day.slice(0, 10).split("-").map(Number) as [number, number, number];
  return Y - y - (M < m || (M === m && D < d) ? 1 : 0);
}
/** A plan row's text as the site prints it → the plan: "Classic Plan  ✓ Recommended" + "$265.00" → { name: "Classic Plan", total: 265 }. */
export function tripPlanFrom(nameText: string, priceText: string): TripPlan | null {
  const name = nameText.replace(/\bRecommended\b/gi, "").replace(/\s+/g, " ").trim();
  const m = /\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(priceText);
  const total = m ? Number(m[1]!.replace(/,/g, "")) : NaN;
  return name && Number.isFinite(total) && total > 0 ? { name, total } : null;
}

const tidy = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().replace(/\s*[-:]\s*$/, "").slice(0, max) : "");
/** A plan's benefit rows as read off the screen → clean lines: blanks dropped, a trailing dash or colon off the labels, nothing reworded. */
export function planBenefits(raw: unknown): PlanBenefit[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanBenefit[] = [];
  for (const r of raw.slice(0, 40)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>, name = tidy(o["name"], 120);
    if (!name || /^benefit$/i.test(name)) continue;
    const limits = (Array.isArray(o["limits"]) ? o["limits"] : []).slice(0, 12)
      .map((l) => (l && typeof l === "object" ? { name: tidy((l as Record<string, unknown>)["name"], 120), value: tidy((l as Record<string, unknown>)["value"], 80) } : { name: "", value: "" }))
      .filter((l) => l.name && l.value);
    out.push({ name, coverage: tidy(o["coverage"], 80), limits });
  }
  return out;
}

/** Mark 2026-11-10: the list he picks from holds the plans for THIS trip only. Allianz's site also returns its annual plans, the rental car plan and
 *  the "Professional Travel Program"; they are kept on the record as read, and left off the list. */
export const offeredTripPlans = (plans: TripPlan[]): TripPlan[] => plans.filter((p) => !/^annual\b|rental car|professional travel program/i.test(p.name));

/** Sign in, fill the Get Quote form, read every plan and its price. Nothing is invented: no browser or no sign-in → unavailable, with the reason. */
export async function fetchAllianzTripQuote(input: TripQuoteInput, env: QuoteEnv): Promise<TripQuoteOutcome> {
  if (!env.chromePath) return { status: "unavailable", reason: "no browser on this box (CHROME_PATH)" };
  if (!env.user || !env.password) return { status: "unavailable", reason: "the Allianz sign-in is not on this box yet (ALLIANZ_AGENT_USER / ALLIANZ_AGENT_PASSWORD in shared.env)" };
  const S = ALLIANZ_SITE;
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: env.chromePath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1280,1000"] });
  let at = "opening the sign-in page";
  let shot: (() => Promise<void>) | null = null;
  try {
    const page = await browser.newPage();
    // for running it down by hand: ALLIANZ_DEBUG_DIR=<folder> keeps a picture of the screen where it stopped (never set on a box)
    shot = async () => { const dir = process.env["ALLIANZ_DEBUG_DIR"]; if (dir) await page.screenshot({ path: `${dir}/allianz-stopped.png`, fullPage: true }).catch(() => undefined); };
    await page.setViewport({ width: 1280, height: 1000 });
    page.setDefaultTimeout(45_000);
    await page.goto(AGENTMAX_URL, { waitUntil: "networkidle2" });
    at = "signing in";
    await page.waitForSelector(S.email, { visible: true });
    await page.type(S.email, env.user);
    await page.type(S.password, env.password);
    await page.click(S.logIn);
    at = "waiting for the quote form after sign-in (a wrong password stops here)";
    await page.waitForSelector(S.state, { visible: true });
    at = "filling the quote form";
    await page.select(S.state, input.state);
    await page.click(S.tripCost, { clickCount: 3 });
    await page.type(S.tripCost, input.total_trip_cost.toFixed(2));
    // the ages box opens a pop-up with one box a traveler; a first click can land before the form is ready, so it is tried a few times
    at = "opening the traveler ages pop-up";
    let opened = false;
    for (let attempt = 0; attempt < 4 && !opened; attempt++) {
      if (attempt % 2 === 0) await page.click(S.ages); else await page.$eval(S.ages, (el) => { (el as unknown as { focus(): void; click(): void }).focus(); (el as unknown as { click(): void }).click(); });
      opened = await page.waitForSelector(S.age(0), { visible: true, timeout: 4_000 }).then(() => true, () => false);
    }
    if (!opened) throw new Error("the traveler ages pop-up did not open");
    at = "typing the traveler ages";
    for (const [i, age] of input.ages.entries()) {
      if (i > 0) await page.click(S.addTraveler);
      await page.waitForSelector(S.age(i), { visible: true, timeout: 8_000 });
      await page.type(S.age(i), String(age));
    }
    await page.click(S.agesDone);
    at = "typing the dates";
    for (const [sel, ymd] of [[S.depart, input.depart_date], [S.back, input.return_date], [S.deposit, input.deposit_date]] as const) {
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, usDate(ymd));
      await page.keyboard.press("Tab");
    }
    at = "pressing Get Quote";
    const pressed = await page.$$eval("button", (els, label) => {
      const b = els.find((x) => (x.textContent ?? "").trim() === label);
      if (b) (b as unknown as { click(): void }).click();
      return !!b;
    }, S.getQuote);
    if (!pressed) return { status: "unavailable", reason: "the Get Quote button was not found on Allianz's site (its screens may have changed)" };
    at = "waiting for the plans";
    await page.waitForSelector(S.planPrice, { visible: true });
    // for running it down by hand: ALLIANZ_DEBUG_DIR=<folder> also keeps the results screen as the site wrote it (never set on a box)
    if (process.env["ALLIANZ_DEBUG_DIR"]) { const { writeFileSync } = await import("node:fs"); writeFileSync(`${process.env["ALLIANZ_DEBUG_DIR"]}/allianz-results.html`, await page.content()); await page.screenshot({ path: `${process.env["ALLIANZ_DEBUG_DIR"]}/allianz-results.png`, fullPage: true }).catch(() => undefined); }
    // each plan is one block of the results list: its name and price in the heading, its Benefits table and its Description underneath (both are
    // on the screen already, folded away). A benefit's own limits sit in a small table inside its cell.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const rows = await page.$$eval(S.plan, (els, nameSel, priceSel) => els.map((el: any) => {
      const table = el.querySelector('[id^="benefits_collapse"] table.benefit-table');
      const lines = table && table.tBodies[0] ? Array.from(table.tBodies[0].rows as any[]).filter((row: any) => row.cells.length >= 2 && row.cells[0].tagName !== "TH").map((row: any) => {
        const first = row.cells[0], link = first.querySelector(":scope > a");
        const own = first.cloneNode(true); own.querySelectorAll("div, table").forEach((x: any) => x.remove());
        return {
          name: (link ? link.textContent : own.textContent) ?? "", coverage: row.cells[row.cells.length - 1].textContent ?? "",
          limits: Array.from(first.querySelectorAll("table tr") as any[]).filter((tr: any) => tr.cells.length >= 2).map((tr: any) => ({ name: tr.cells[0].textContent ?? "", value: tr.cells[1].textContent ?? "" })),
        };
      }) : [];
      return {
        name: el.querySelector(`.panel-heading ${nameSel as string}`)?.textContent ?? "", price: el.querySelector(`.panel-heading ${priceSel as string}`)?.textContent ?? "",
        benefits: lines, about: el.querySelector('[id^="description_collapse"]')?.textContent ?? "",
      };
    }), S.planName, S.planPrice);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const plans = rows.map((r) => {
      const plan = tripPlanFrom(r.name, r.price);
      if (!plan) return null;
      const benefits = planBenefits(r.benefits), about = typeof r.about === "string" ? r.about.replace(/\s+/g, " ").trim().slice(0, 1200) : "";
      return { ...plan, ...(benefits.length ? { benefits } : {}), ...(about ? { about } : {}) } as TripPlan;
    }).filter((p): p is TripPlan => !!p);
    return plans.length ? { status: "ready", plans } : { status: "unavailable", reason: "Allianz's site showed no plan with a price" };
  } catch (err) {
    if (shot) await shot();
    return { status: "unavailable", reason: `Allianz's site could not be quoted while ${at}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
