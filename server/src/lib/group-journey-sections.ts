// group-journey-sections.ts — the sections an email or the cruise page is made of.
//
// Each builder takes the traveler's context and returns a Section, or null when the file does not hold what the
// section needs. "Omit it" is the rule (Mark 2026-10-16): a section is never printed with a blank in it and never
// filled with a guess. The builders are PURE; the words come from group-journey-strings.ts (English and Spanish twins).

import { looksLikeCardNumber } from "./group-file";
import {
  addDays, cabinPayments, checklistDone, checklistEntry, clientChecklist, displayName, firstName, fmtDate, fmtMoney, fmtTime, journeyAnswers,
  missingItems, paperworkState, videosFor, plain, portDisplayName, termsDeadlines, travelState, weatherTable, ymd,
  type Ctx, type Row, type Section, type SectionItem, type VideoTopic,
} from "./group-journey-facts";
import { strings, stormKind, type MilestoneKind } from "./group-journey-strings";
import { BUSINESS } from "./group-secure";

/** Days before sailing at which the milestone emails go. */
export const DAY_MILESTONES = [120, 90, 45, 20, 10, 5, 2] as const;
export const dayKind = (n: number): MilestoneKind => `t-${n}` as MilestoneKind;
export const kindDays = (k: string): number | null => { const m = /^t-(\d+)$/.exec(k); return m ? Number(m[1]) : null; };

/** The pages of our own site the journey links to; both languages exist for each (a test checks the files). */
export const SITE_PAGES = {
  clothing: { en: "/affiliate/clothing.html", es: "/es/affiliate/clothing.html" },
  cabinEssentials: { en: "/affiliate/cabin-essentials.html", es: "/es/affiliate/cabin-essentials.html" },
  tracker: { en: "/wheres-my-ship.html", es: "/es/wheres-my-ship.html" },
  stormWatch: { en: "/storm-watch.html", es: "/es/storm-watch.html" },
} as const;

const page = (ctx: Ctx, p: keyof typeof SITE_PAGES) => `${ctx.site}${SITE_PAGES[p][ctx.lang]}`;
const clean = (lines: Array<string | null | undefined | false>): string[] => lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0);

/** The date a milestone email goes out, or null when the sail date is unknown. */
export const milestoneDate = (group: Row, days: number): string | null => { const s = ymd(group.sail_date); return s ? addDays(s, -days) : null; };

// ── Your sailing ──────────────────────────────────────────────────────────────

/** The ship, the dates and the port, as sentences. [] when the file has neither a ship nor a sail date. */
function sailingLines(ctx: Ctx): string[] {
  const S = strings(ctx.lang).s;
  const g = ctx.group;
  const ship = displayName(g.ship_name);
  const date = fmtDate(g.sail_date, ctx.lang);
  if (!ship && !date) return [];
  const nights = Number.isInteger(g.nights) && g.nights > 0 ? (g.nights as number) : null;
  return clean([
    S.shipLine({ ship, line: displayName(g.cruise_line), date, port: portDisplayName(g.embark_port) ?? "" }),
    S.nightsLine({ nights, back: fmtDate(g.return_date, ctx.lang) }),
  ]);
}

export function sailing(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const lines = sailingLines(ctx);
  if (!lines.length) return null;
  return { key: "sailing", title: S.sailing, lines: clean([...lines, ctx.daysToSail !== null ? S.daysToGo(ctx.daysToSail) : null]) };
}

// ── Payments ──────────────────────────────────────────────────────────────────

/** The part of a payment note meant for the client: a line beginning "Client:" (Mark's own notes stay his). */
export function clientNote(notes: unknown): string {
  for (const raw of String(notes ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:client|cliente|to client)\s*:\s*(.+)$/i.exec(raw);
    if (m) { const t = plain(m[1], 300); if (t && !looksLikeCardNumber(t)) return t; }
  }
  return "";
}

export function payments(ctx: Ctx, o: { mode: "schedule" | "open"; howTo?: boolean }): Section | null {
  const S = strings(ctx.lang).s;
  const rows = cabinPayments(ctx.input, ctx.cabin);
  const lines: string[] = [];
  let paidRows = 0, openRows = 0;
  for (const p of rows) {
    const kind = S.payKind[p.kind] ?? S.payKind["other"]!;
    const amount = fmtMoney(p.amount);
    const due = ymd(p.due_date);
    if (p.paid_at) {
      paidRows++;
      if (o.mode === "schedule") lines.push(S.payPaid({ kind, amount, date: fmtDate(p.paid_at, ctx.lang) }));
      continue;
    }
    if (!amount && !due) continue;                       // nothing we can say about it
    openRows++;
    lines.push(!due ? (p.kind === "deposit" ? S.payAtBooking({ kind, amount }) : S.payNoDate({ kind, amount })) : due < ctx.today ? S.payOverdue({ kind, amount, date: fmtDate(due, ctx.lang) }) : S.payDue({ kind, amount, date: fmtDate(due, ctx.lang) }));
  }
  const hasKind = (k: string) => rows.some((p) => p.kind === k);
  const finalDue = ymd(ctx.group.final_payment_due);
  if (!hasKind("final") && finalDue && finalDue >= ctx.today) lines.push(S.payGroupFinal(fmtDate(finalDue, ctx.lang)));
  const depositDue = ymd(ctx.group.deposit_due);
  if (o.mode === "schedule" && !hasKind("deposit") && depositDue && depositDue >= ctx.today) lines.push(S.payGroupDeposit(fmtDate(depositDue, ctx.lang)));
  if (o.mode === "open" && !openRows && paidRows) lines.push(S.payAllPaid);
  if (!lines.length) return null;
  const head = rows.length ? [S.payForCabin(plain(ctx.cabin?.cabin_num, 20))] : [];
  return { key: "payments", title: S.payments, lines: clean([...head, ...lines, o.howTo ? S.howToPay : null]) };
}

export function paymentOne(ctx: Ctx, p: Row): Section | null {
  const S = strings(ctx.lang).s;
  const due = ymd(p.due_date);
  const amount = fmtMoney(p.amount);
  if (!due || !amount) return null;
  const num = plain(ctx.cabin?.cabin_num, 20);
  return {
    key: "payment", title: S.payment,
    lines: [S.paymentOne({ amount, date: fmtDate(due, ctx.lang), kind: S.payKind[p.kind] ?? S.payKind["other"]!, cabin: num ? S.cabinRef(num) : "" })],
  };
}

export function howToPay(ctx: Ctx, p: Row): Section {
  const S = strings(ctx.lang).s;
  const note = clientNote(p.notes);
  return { key: "how-to-pay", title: S.howToPayTitle, lines: clean([S.howToPay, note ? `${S.paymentNote} ${note}` : null]) };
}

// ── Paperwork, passports, insurance ──────────────────────────────────────────

export function paperwork(ctx: Ctx, o: { showDone?: boolean } = {}): Section | null {
  const S = strings(ctx.lang).s;
  const pw = paperworkState(ctx.input, ctx.traveler, ctx.cabin);
  if (!pw.required.length) return null;
  if (!pw.pending.length) return o.showDone ? { key: "paperwork", title: S.paperwork, lines: [S.paperworkDone] } : null;
  return {
    key: "paperwork", title: S.paperwork,
    lines: clean([S.paperworkCount({ signed: pw.signed.length, total: pw.required.length }), ctx.lang === "es" ? S.paperworkEnglishOnly : null, S.paperworkToSign]),
    items: pw.pending.map((k) => ({ text: pw.title(k) })),
    links: [{ label: S.paperworkLink, url: ctx.formsUrl }],
  };
}

export function passport(ctx: Ctx): Section {
  const S = strings(ctx.lang).s;
  const exp = ymd(ctx.traveler.passport_expiry);
  const end = ymd(ctx.group.return_date) ?? ymd(ctx.group.sail_date);
  let specific: string | null = null;
  if (exp) {
    const when = fmtDate(exp, ctx.lang);
    specific = end && exp < end ? S.passportBefore(when) : end && exp < addDays(end, 183) ? S.passportSoon(when) : S.passportFine(when);
  }
  return { key: "passport", title: S.passport, lines: clean([S.passportGeneral, specific]) };
}

/** The tel: link that dials a phone number written 919-346-6127. */
export const telLink = (phone: string): string => `tel:+1${phone.replace(/\D/g, "")}`;

/**
 * `page: true` is the cruise page, where there is no email to reply to: the offer points at the phone, with a link that dials.
 * The emails keep "reply to this email or call".
 */
export function insurance(ctx: Ctx, o: { video?: boolean; page?: boolean } = {}): Section | null {
  const S = strings(ctx.lang).s;
  const status = ctx.cabin?.insurance;
  if (status === "declined") return null;
  const offer = o.page ? S.insuranceOfferPage : S.insuranceOffer;
  const lines = [status === "accepted" ? S.insuranceHave : offer];
  const v = o.video && status !== "accepted" ? videosFor(ctx, "insurance", 1)[0] : undefined;
  const call = o.page && status !== "accepted" ? { links: [{ label: S.callMark, url: telLink(BUSINESS.phone) }] } : {};
  return {
    key: "insurance", title: S.insurance, lines,
    ...(v ? { lines: [...lines, S.insuranceVideo], items: [{ text: v.inEnglish ? `${v.title} ${strings(ctx.lang).inEnglishNote}` : v.title, url: v.url }] } : {}),
    ...call,
  };
}

// ── The checklist ─────────────────────────────────────────────────────────────

export function checklist(ctx: Ctx, o: { kinds: string[]; to: string | null; includeUndated: boolean; max?: number; key?: string; title?: string; lead?: string }): Section | null {
  const S = strings(ctx.lang).s;
  const rows = clientChecklist(ctx.input, ctx.traveler, ctx.cabin)
    .filter((r) => o.kinds.includes(r.kind) && !checklistDone(r, ctx.traveler))
    .filter((r) => { const d = ymd(r.due_date); return d ? o.to === null || d <= o.to : o.includeUndated; })
    .slice(0, o.max ?? 6);
  if (!rows.length) return null;
  const items: SectionItem[] = rows.map((r) => {
    const e = checklistEntry(r, ctx.traveler);
    const text = `${e.title}${e.due ? ` (${S.checklistBy(fmtDate(e.due, ctx.lang))})` : ""}${e.detail ? ` — ${e.detail}` : ""}`;
    return e.url ? { text, url: e.url } : { text };
  });
  return { key: o.key ?? "checklist", title: o.title ?? S.checklist, lines: clean([o.lead]), items };
}

// ── Getting there: flights, hotel, transfer ──────────────────────────────────

function whatOf(r: Row, lang: Ctx["lang"]): string {
  const bits = [plain(r.provider, 80), plain(r.reference, 60)].filter(Boolean).join(" ");
  const route = plain(r.from_place, 60) && plain(r.to_place, 60) ? `${plain(r.from_place, 60)} → ${plain(r.to_place, 60)}` : "";
  const start = fmtDate(r.starts_at, lang);
  const end = r.kind === "hotel" ? fmtDate(r.ends_at, lang) : "";
  const when = start && end && end !== start ? `${start} – ${end}` : start;
  const conf = plain(r.confirmation, 60);
  return [bits, route, when, conf ? `${lang === "es" ? "confirmación" : "confirmation"} ${conf}` : ""].filter(Boolean).join(", ");
}

export function travel(ctx: Ctx): Section[] {
  const S = strings(ctx.lang).s;
  const tv = travelState(ctx.input, ctx.traveler, ctx.cabin);
  const kindLabel: Record<string, string> = { flight: S.travelFlightIn, hotel: S.travelHotel, transfer: S.travelTransfer };
  const onFile: SectionItem[] = [];
  for (const r of tv.rows) {
    const what = whatOf(r, ctx.lang);
    if (!what) continue;
    const label = r.kind === "flight" ? (r.direction === "post" ? S.travelFlightOut : S.travelFlightIn) : kindLabel[r.kind] ?? r.kind;
    onFile.push({ text: S.travelRow({ kind: label, what }) });
  }
  const told = tv.told;
  const toldFlight = (dir: "in" | "out") => {
    const f = plain(told[`flight_${dir}_flight`], 80);
    if (!f) return;
    const date = fmtDate(told[`flight_${dir}_date`], ctx.lang);
    const time = fmtTime(told[`flight_${dir}_time`], ctx.lang);
    onFile.push({ text: S.travelRow({ kind: dir === "in" ? S.travelFlightIn : S.travelFlightOut, what: [f, date, time].filter(Boolean).join(", ") }) });
  };
  toldFlight("in"); toldFlight("out");
  if (plain(told["hotel_name"])) onFile.push({ text: S.travelRow({ kind: S.travelHotel, what: [plain(told["hotel_name"], 100), plain(told["hotel_confirmation"], 60)].filter(Boolean).join(", ") }) });
  if (plain(told["transfer_note"])) onFile.push({ text: S.travelRow({ kind: S.travelTransfer, what: [plain(told["transfer_note"], 120), plain(told["transfer_confirmation"], 60)].filter(Boolean).join(", ") }) });
  if (["driving", "other"].includes(String(told["getting_there"]))) onFile.push({ text: strings(ctx.lang).hub.fields[`getting_there_${told["getting_there"]}`] ?? "" });

  const needed: SectionItem[] = [];
  if (!tv.flightIn) needed.push({ text: S.travelFlightInNeed });
  if (!tv.flightOut) needed.push({ text: S.travelFlightOutNeed });
  const hasHotelOrTransfer = tv.rows.some((r) => r.kind === "hotel" || r.kind === "transfer") || plain(told["hotel_name"]) || plain(told["transfer_note"]);
  const optional = needed.length || !hasHotelOrTransfer ? S.travelOptional : null;
  const link = [{ label: S.travelAdd, url: `${ctx.hubUrl}#details` }];
  if (!onFile.length && !needed.length && !optional) return [];
  // what is on file and what is still needed are two lists, each under its own words
  if (onFile.length && needed.length) {
    return [
      { key: "travel", title: S.travel, lines: [S.travelOnFile], items: onFile },
      { key: "travel-needed", title: S.travelNeeded.replace(/:$/, ""), lines: [], items: needed, after: clean([optional]), links: link },
    ];
  }
  return [{
    key: "travel", title: S.travel,
    lines: clean([onFile.length ? S.travelOnFile : needed.length ? S.travelNeeded : null]),
    items: [...onFile, ...needed],
    after: clean([optional]),
    links: link,
  }];
}

export function missing(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const miss = missingItems(ctx.input, ctx.traveler, ctx.cabin);
  if (!miss.length) return null;
  const text = (m: typeof miss[number]) => m.key === "paperwork" ? S.missingPaperwork(m.n ?? 1) : m.key === "travel-in" ? S.missingTravelIn : m.key === "travel-out" ? S.missingTravelOut : S.missingEmergency;
  const links = [{ label: S.missingLink, url: `${ctx.hubUrl}#details` }];
  if (miss.some((m) => m.key === "paperwork")) links.unshift({ label: S.paperworkLink, url: ctx.formsUrl });
  return { key: "missing", title: S.missing, lines: [], items: miss.map((m) => ({ text: text(m) })), links };
}

// ── The cruise line's dates ───────────────────────────────────────────────────

export function deadlines(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const sail = ymd(ctx.group.sail_date);
  if (!sail) return null;
  const until = addDays(sail, -45);
  const within = (d: string) => d >= ctx.today && d < until;
  const items = termsDeadlines(ctx.group).filter((d) => within(d.date)).slice(0, 8).map((d) => ({ text: `${fmtDate(d.date, ctx.lang)}: ${d.text}` }));
  const names = ymd(ctx.group.names_due);
  const namesLine = names && within(names) ? S.namesDue(fmtDate(names, ctx.lang)) : null;
  if (!items.length && !namesLine) return null;
  return { key: "deadlines", title: S.deadlines, lines: clean([namesLine, items.length ? S.deadlinesNote : null]), items };
}

const DINING = /dining|restaurant|specialty|reservation|name[- ]?(?:change|correction)|special (?:event|occasion|request)|celebration|birthday|anniversary|beverage package|drink package/i;
const CHECKIN = /check[- ]?in|boarding pass/i;
const CHECKIN_OPENS = /open|begin|available|start/i;
const CHECKIN_CLOSES = /clos|deadline|cut[- ]?off|no later|must be completed|before/i;
const EMBARK = /arriv|terminal|embark|boarding/i;

export function excursions(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const rows = clientChecklist(ctx.input, ctx.traveler, ctx.cabin).filter((r) => r.kind === "excursion" && !checklistDone(r, ctx.traveler)).slice(0, 8);
  if (!rows.length) return null;
  const items = rows.map((r) => {
    const e = checklistEntry(r, ctx.traveler);
    const text = `${e.title}${e.detail ? ` — ${e.detail}` : ""}`;
    return e.url ? { text, url: e.url } : { text };
  });
  return { key: "excursions", title: S.excursions, lines: [S.excursionsLead], items };
}

export function dining(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const d = plain(ctx.cabin?.dining, 60);
  const items = termsDeadlines(ctx.group).filter((x) => x.date >= ctx.today && DINING.test(x.text)).slice(0, 6).map((x) => ({ text: `${fmtDate(x.date, ctx.lang)}: ${x.text}` }));
  if (!d && !items.length) return null;
  return { key: "dining", title: S.dining, lines: clean([d ? S.diningOnFile(d) : null, items.length ? S.diningLead : null]), items };
}

export function checkin(ctx: Ctx, phase: "opens" | "closes"): Section | null {
  const S = strings(ctx.lang).s;
  const all = termsDeadlines(ctx.group).filter((d) => CHECKIN.test(d.text) && d.date >= ctx.today);
  const wanted = all.filter((d) => (phase === "opens" ? CHECKIN_OPENS : CHECKIN_CLOSES).test(d.text));
  const hit = wanted.length ? wanted : phase === "opens" ? all : [];
  if (!hit.length) return phase === "opens" ? { key: "checkin", title: S.checkin, lines: [S.checkinGeneral] } : null;
  const first = hit[0]!;
  return {
    key: "checkin", title: S.checkin,
    lines: [phase === "opens" ? S.checkinOpens(fmtDate(first.date, ctx.lang)) : S.checkinCloses(fmtDate(first.date, ctx.lang)), S.checkinLine],
    items: hit.slice(0, 3).map((d) => ({ text: `${fmtDate(d.date, ctx.lang)}: ${d.text}` })),
  };
}

// ── What to bring ─────────────────────────────────────────────────────────────

export function documents(ctx: Ctx): Section {
  const S = strings(ctx.lang).s;
  const items: SectionItem[] = [{ text: S.docPassport }];
  const booking = plain(ctx.cabin?.booking_number, 60);
  if (booking) items.push({ text: S.docBooking(booking) });
  items.push({ text: S.docBoarding });
  const kinds: Record<string, string> = { flight: S.travelFlightIn, hotel: S.travelHotel, transfer: S.travelTransfer };
  for (const r of travelState(ctx.input, ctx.traveler, ctx.cabin).rows) {
    if (!plain(r.confirmation)) continue;
    const label = r.kind === "flight" && r.direction === "post" ? S.travelFlightOut : kinds[r.kind] ?? plain(r.kind, 20);
    items.push({ text: S.docTravelRow({ kind: label, what: whatOf(r, ctx.lang) }) });
  }
  if (ctx.cabin?.insurance !== "declined") items.push({ text: S.docInsurance });
  return { key: "documents", title: S.documents, lines: [S.docVisa], items };
}

export function packing(ctx: Ctx): Section {
  const S = strings(ctx.lang).s;
  const rows = clientChecklist(ctx.input, ctx.traveler, ctx.cabin).filter((r) => r.kind === "product" && !checklistDone(r, ctx.traveler)).slice(0, 8);
  const items: SectionItem[] = rows.map((r) => {
    const e = checklistEntry(r, ctx.traveler);
    const text = `${e.title}${e.detail ? ` — ${e.detail}` : ""}`;
    return e.url ? { text, url: e.url } : { text };
  });
  return {
    key: "packing", title: S.packing,
    lines: clean([S.packingLead, S.packingBag, items.length ? S.packingItems : null]),
    items,
    links: [{ label: S.packingWear, url: page(ctx, "clothing") }, { label: S.packingCabin, url: page(ctx, "cabinEssentials") }],
  };
}

export function videos(ctx: Ctx, topics: VideoTopic[]): Section | null {
  const S = strings(ctx.lang);
  const seen = new Set<string>();
  const items: SectionItem[] = [];
  for (const t of topics) for (const v of videosFor(ctx, t, 2)) {
    if (seen.has(v.id) || items.length >= 3) continue;
    seen.add(v.id);
    items.push({ text: v.inEnglish ? `${v.title} ${S.inEnglishNote}` : v.title, url: v.url });
  }
  return items.length ? { key: "videos", title: S.s.videos, lines: [S.s.videosLead], items } : null;
}

// ── The ship and the cabin ────────────────────────────────────────────────────

export function ship(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const name = displayName(ctx.group.ship_name);
  const cab = ctx.cabin;
  const lines: string[] = [];
  const items: SectionItem[] = [];
  const cls = plain(ctx.extras.shipInfo?.class, 40);
  if (name && cls) lines.push(S.shipClass({ ship: name, cls }));
  const r = ctx.extras.rating;
  if (name && r && r.status === "published" && typeof r.rating === "number") {
    lines.push(S.shipScore({ ship: name, score: (r.rating as number).toFixed(1) }));
    const approved = r.comment_status === undefined || r.comment_status === "approved";
    const comment = plain(ctx.lang === "es" ? r.comment_es : r.comment, 400);
    const salty = plain(ctx.lang === "es" ? r.salty_mark_take_es : r.salty_mark_take, 300);
    if (approved && comment) lines.push(comment);
    if (approved && salty) lines.push(salty);
  }
  if (cab && (plain(cab.category) || plain(cab.cabin_num))) {
    lines.push(S.cabinLine({ category: displayName(cab.category), num: plain(cab.cabin_num, 20), deck: plain(cab.deck, 10) }));
    if (plain(cab.bed_config)) lines.push(S.shipBed(plain(cab.bed_config, 60)));
  }
  for (const v of videosFor(ctx, "cabin", 1)) items.push({ text: v.inEnglish ? `${v.title} ${strings(ctx.lang).inEnglishNote}` : v.title, url: v.url });
  if (!lines.length && !items.length) return null;
  const links = name ? [{ label: S.shipTracker(name), url: `${page(ctx, "tracker")}?ship=${encodeURIComponent(name)}` }] : [];
  return { key: "ship", title: S.ship, lines, items, links };
}

// ── Boarding day ──────────────────────────────────────────────────────────────

function sailTime(ctx: Ctx): string {
  const sail = ymd(ctx.group.sail_date);
  const stops: Row[] = Array.isArray(ctx.group.itinerary) ? ctx.group.itinerary : [];
  const first = stops.find((s) => ymd(s?.date) === sail || s?.day === 1) ?? stops[0];
  return fmtTime(first?.depart, ctx.lang);
}

export function embark1(ctx: Ctx): Section {
  const S = strings(ctx.lang).s;
  const port = portDisplayName(ctx.group.embark_port) ?? "";
  const lines: string[] = [];
  if (port) lines.push(S.embarkPort({ port, date: fmtDate(ctx.group.sail_date, ctx.lang) }));
  lines.push(S.embarkTerminal);
  const leaves = sailTime(ctx);
  if (leaves) lines.push(S.embarkSails(leaves));
  const told = fmtTime(journeyAnswers(ctx.traveler)["port_arrival_time"], ctx.lang);
  if (told) lines.push(S.embarkTold(told));
  const transfer = travelState(ctx.input, ctx.traveler, ctx.cabin).rows.find((r) => r.kind === "transfer" && r.direction !== "post");
  if (transfer && whatOf(transfer, ctx.lang)) lines.push(S.embarkTransfer({ what: whatOf(transfer, ctx.lang) }));
  lines.push(S.embarkTags, S.embarkCarry, S.embarkMuster);
  const terms = termsDeadlines(ctx.group).filter((d) => d.date >= ctx.today && EMBARK.test(d.text)).slice(0, 3);
  const items = terms.map((d) => ({ text: `${fmtDate(d.date, ctx.lang)}: ${d.text}` }));
  if (items.length) lines.push(S.embarkTermsLine);
  return { key: "embark", title: S.embark1, lines, items };
}

export function embark2(ctx: Ctx): Section {
  const S = strings(ctx.lang).s;
  const lines: string[] = [S.embark2Window];
  const leaves = sailTime(ctx);
  if (leaves) lines.push(S.embarkSails(leaves));
  const told = fmtTime(journeyAnswers(ctx.traveler)["port_arrival_time"], ctx.lang);
  if (told) lines.push(S.embark2Arrive(told));
  lines.push(S.embarkCarry);
  return { key: "boarding", title: S.embark2, lines };
}

export function emergency(ctx: Ctx): Section {
  const S = strings(ctx.lang).s;
  const name = plain(ctx.traveler.emergency_name, 100);
  const phone = plain(ctx.traveler.emergency_phone, 40);
  return {
    key: "emergency", title: S.emergency,
    lines: [name || phone ? S.emergencyOnFile({ name, phone }) : S.emergencyNone],
    links: [{ label: S.emergencyChange, url: `${ctx.hubUrl}#details` }],
  };
}

// ── The five-day report ───────────────────────────────────────────────────────

export function storm(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const st = ctx.extras.storm;
  const name = displayName(ctx.group.ship_name);
  if (!st || !name) return null;
  return {
    key: "storm", title: S.storm,
    lines: [S.stormLine({ ship: name, kind: stormKind(st.classification, st.name, ctx.lang) })],
    links: [{ label: S.stormLink, url: page(ctx, "stormWatch") }],
  };
}

export function weather(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const table = weatherTable(ctx);
  if (!table) return null;
  return {
    key: "weather", title: S.weather,
    lines: clean([S.weatherNote(fmtDate(ctx.today, ctx.lang)), table.sample ? S.weatherSample : null, S.weatherCredit]),
    table: { head: [...S.weatherHead], rows: table.rows },
  };
}

export function packTweaks(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const t = weatherTable(ctx);
  if (!t) return null;
  const items: SectionItem[] = [];
  if (t.rain) items.push({ text: S.tweakRain });
  if (t.hot) items.push({ text: S.tweakWarm });
  if (t.cool) items.push({ text: S.tweakCool });
  return items.length ? { key: "pack-tweaks", title: S.packTweaks, lines: [], items } : null;
}

// ── Confirmation ──────────────────────────────────────────────────────────────

export function booked(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const cab = ctx.cabin;
  const lines = sailingLines(ctx);
  if (cab && (plain(cab.category) || plain(cab.cabin_num))) lines.push(S.cabinLine({ category: displayName(cab.category), num: plain(cab.cabin_num, 20), deck: plain(cab.deck, 10) }));
  if (plain(cab?.booking_number)) lines.push(S.bookingNumber(plain(cab!.booking_number, 60)));
  const mates = ctx.mates.map(firstName).filter(Boolean);
  if (mates.length) lines.push(S.sharing(mates.join(", ")));
  return lines.length ? { key: "booked", title: S.booked, lines } : null;
}

/** The cruise page's own cabin block: the cabin, the booking number and who shares it (first names only). */
export function cabinInfo(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const cab = ctx.cabin;
  if (!cab) return null;
  const lines: string[] = [];
  if (plain(cab.category) || plain(cab.cabin_num)) lines.push(S.cabinLine({ category: displayName(cab.category), num: plain(cab.cabin_num, 20), deck: plain(cab.deck, 10) }));
  if (plain(cab.booking_number)) lines.push(S.bookingNumber(plain(cab.booking_number, 60)));
  const mates = ctx.mates.map(firstName).filter(Boolean);
  if (mates.length) lines.push(S.sharing(mates.join(", ")));
  return lines.length ? { key: "cabin", title: S.cabin, lines } : null;
}

export function signed(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const pw = paperworkState(ctx.input, ctx.traveler, ctx.cabin);
  if (!pw.required.length) return null;
  if (!pw.signedRows.length) return { key: "signed", title: S.signed, lines: [S.signedNone], links: [{ label: S.paperworkLink, url: ctx.formsUrl }] };
  return { key: "signed", title: S.signed, lines: [], items: pw.signedRows.map((r) => ({ text: S.signedRow({ title: pw.title(r.doc_key), date: fmtDate(r.signed_at, ctx.lang) }) })) };
}

export function next(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const items: SectionItem[] = [];
  for (const n of DAY_MILESTONES) {
    const d = milestoneDate(ctx.group, n);
    if (d && d > ctx.today) items.push({ text: S.nextRow({ date: fmtDate(d, ctx.lang), what: S.nextTopics[`t-${n}`] ?? "" }) });
  }
  return items.length ? { key: "next", title: S.next, lines: [], items } : null;
}

// ── Change notice ─────────────────────────────────────────────────────────────

export interface ChangeNotice { text: string; text_es?: string | null; fields: Array<{ label: string; before: string; after: string }> }

export function changeNotice(ctx: Ctx, n: ChangeNotice): Section[] {
  const S = strings(ctx.lang).s;
  const body = (ctx.lang === "es" && plain(n.text_es, 4000) ? n.text_es! : n.text).split(/\r?\n+/).map((l) => plain(l, 1000)).filter(Boolean);
  const out: Section[] = [{ key: "notice", title: "", lines: [...body, ...(ctx.lang === "es" && !plain(n.text_es, 4000) ? [S.changeNoteEs] : [])] }];
  if (n.fields.length) out.push({ key: "change", title: S.change, lines: [], table: { head: [S.changeLabel, S.changeFrom, S.changeTo], rows: n.fields.map((f) => [f.label, f.before, f.after]) } });
  return out;
}

// ── The cruise page only ─────────────────────────────────────────────────────

export function noticeSections(ctx: Ctx): Section[] {
  const rows = (ctx.extras.notices ?? []).slice(0, 5);
  const out: Section[] = [];
  for (const r of rows) {
    const meta = r.meta ?? {};
    const notice: ChangeNotice = {
      text: plain(meta.text, 4000), text_es: plain(meta.text_es, 4000) || null,
      fields: (Array.isArray(meta.fields) ? meta.fields : []).map((f: Row) => ({ label: plain(f?.label, 80), before: plain(f?.before, 200), after: plain(f?.after, 200) })).filter((f: Row) => f.label),
    };
    if (!notice.text) continue;
    const secs = changeNotice(ctx, notice);
    const when = fmtDate(r.sent_at ?? r.created_at, ctx.lang);
    out.push({ ...secs[0]!, key: "notice", title: when, tone: "notice", ...(secs[1] ? { table: secs[1].table } : {}) });
  }
  return out;
}

export function detailsSection(ctx: Ctx): Section {
  const H = strings(ctx.lang).hub;
  return { key: "details", title: H.detailsTitle, lines: [H.detailsLead], form: "details" };
}

export function checklistAll(ctx: Ctx): Section | null {
  const S = strings(ctx.lang).s;
  const rows = clientChecklist(ctx.input, ctx.traveler, ctx.cabin);
  if (!rows.length) return null;
  return {
    key: "checklist", title: S.checklist, lines: [],
    checklist: rows.map((r) => { const e = checklistEntry(r, ctx.traveler); return { ...e, dueText: e.due ? S.checklistBy(fmtDate(e.due, ctx.lang)) : null }; }),
  };
}

