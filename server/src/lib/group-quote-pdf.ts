// group-quote-pdf.ts — the guest's quote as a PDF they can download and keep (Mark 2026-11-12: "the email I get is just that, an email without a
// downloadable PDF for the client. keep the email format with the book it and changes buttons but we need to build it into a PDF for download").
//
// The PDF prints the SAME document the email and the quote page print (QuoteDoc, built in routes/group-details.ts): the cruise guest by guest or line by
// line, the travel, the trip total, the travel protection plans. Nothing is worked out here. It carries no Book It button (a PDF agrees to nothing): it
// says where to answer. Brand rules: navy text, no white type, Mark alone, the Seller of Travel line.

import PDFDocument from "pdfkit";
import type { QuoteDoc } from "./group-details";

export interface QuoteSheet {
  bookingNumber: string | null; optionUntil: { day: string; text: string } | null;
  trip: { line: string | null; ship: string | null; from: string | null; nights: number | null; departs: string | null; returns: string | null; stops: Array<{ weekday: string; date: string; port: string; arrive: string | null; depart: string | null }> };
  cabin: { number: string | null; deck: string | null; type: string | null };
  travelers: Array<{ name: string; lead: boolean; items: string[] }>;
}
export interface QuotePdfInput {
  lang: "en" | "es";
  doc: QuoteDoc;
  guestName: string;
  groupLabel: string;
  /** the day the quote was made, already in words */
  dateText: string;
  agentName: string; businessName: string; phone: string; email: string; sellerOfTravel: string;
  /** the guest's own quote page, where Book It and I need changes are */
  answerUrl: string | null;
  logo?: Buffer | null;
  /** the booking's facts as the cruise line's confirmation lays them out (Mark 2026-11-12): number, hold date, trip, cabin, each traveler's items */
  sheet?: QuoteSheet | null;
  /** the travel protection the guest chose on their page: printed alone, with the trip total it makes */
  picked?: { name: string; price: string; withTotal: { label: string; value: string } | null } | null;
}

const NAVY = "#07183f", MUTED = "#4a5a7a", RULE = "#c5cfdf", BAND = "#eef2f8";
const M = 56;

const WORDS = {
  en: {
    title: "Your quote", for: "Prepared for", group: "Trip", date: "Quoted on", from: "From",
    booking: "Booking number", none: "Not assigned yet", held: "Cabin held until", hTrip: "Trip details", hBooking: "Booking details", hPay: "Payment details",
    ship: "Ship", departure: "Departure", ret: "Return", duration: "Duration", nights: (n: number) => `${n} nights`, room: "Stateroom", deck: "deck", items: "Additional items",
    cols: ["Day", "Date", "Port", "Arrival", "Departure"],
    note: "These are the prices quoted on the date above; they can change until the booking is made. This document charges nothing and books nothing.",
    answer: "To choose your travel protection, book it or ask for changes:", open: "Open my quote page",
    call: (phone: string) => `Questions? Call or text Mark at ${phone}.`,
    with: "with",
  },
  es: {
    title: "Su cotización", for: "Preparada para", group: "Viaje", date: "Cotizada el", from: "De",
    booking: "Número de reserva", none: "Aún sin asignar", held: "Cabina apartada hasta el", hTrip: "Detalles del viaje", hBooking: "Detalles de la reserva", hPay: "Detalles de pago",
    ship: "Barco", departure: "Salida", ret: "Regreso", duration: "Duración", nights: (n: number) => `${n} noches`, room: "Cabina", deck: "cubierta", items: "Adicionales",
    cols: ["Día", "Fecha", "Puerto", "Llegada", "Salida"],
    note: "Estos son los precios cotizados en la fecha indicada; pueden cambiar hasta que se haga la reserva. Este documento no cobra ni reserva nada.",
    answer: "Para elegir su protección de viaje, reservar o pedir cambios:", open: "Abrir la página de mi cotización",
    call: (phone: string) => `¿Preguntas? Llame o escriba a Mark al ${phone}.`,
    with: "con",
  },
} as const;

export function renderQuotePdf(i: QuotePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const W = WORDS[i.lang], d = i.doc;
    const pdf = new PDFDocument({ size: "LETTER", margins: { top: M, bottom: M, left: M, right: M }, info: { Title: `${W.title}: ${i.groupLabel}`, Author: i.businessName } });
    const chunks: Buffer[] = [];
    pdf.on("data", (c: Buffer) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    const width = pdf.page.width - M * 2, right = pdf.page.width - M;
    const room = (h: number) => { if (pdf.y + h > pdf.page.height - M) pdf.addPage(); };
    const rule = () => { pdf.moveTo(M, pdf.y).lineTo(right, pdf.y).strokeColor(RULE).lineWidth(0.7).stroke(); pdf.moveDown(0.5); };
    /** a line with its amount at the right edge; the label wraps, the amount never does */
    const line = (label: string, value: string, o: { bold?: boolean; size?: number; band?: boolean } = {}) => {
      const size = o.size ?? 11.5, valueW = 150, labelW = width - valueW - 12;
      pdf.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
      const h = Math.max(pdf.heightOfString(label, { width: labelW }), pdf.heightOfString(value, { width: valueW }));
      room(h + 10);
      const y = pdf.y;
      if (o.band) pdf.rect(M - 6, y - 4, width + 12, h + 9).fill(BAND);
      pdf.fillColor(NAVY).font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
      pdf.text(label, M, y, { width: labelW });
      pdf.text(value, right - valueW, y, { width: valueW, align: "right" });
      pdf.x = M; pdf.y = y + h + 7;
    };
    const small = (t: string) => { pdf.font("Helvetica").fontSize(10).fillColor(MUTED); room(pdf.heightOfString(t, { width: width - 14 }) + 4); pdf.text(t, M + 14, pdf.y, { width: width - 14 }); pdf.x = M; pdf.moveDown(0.25); };
    const head = (t: string, aside?: string | null) => {
      room(60);
      pdf.moveDown(0.7);
      pdf.font("Helvetica-Bold").fontSize(14).fillColor(NAVY).text(t, M, pdf.y, { continued: !!aside });
      if (aside) pdf.font("Helvetica").fontSize(11.5).fillColor(MUTED).text(`   ${aside}`);
      pdf.moveDown(0.3); rule();
    };

    // ── the top: who it is from, who it is for ──
    if (i.logo) { try { pdf.image(i.logo, right - 120, M - 14, { width: 120 }); } catch { /* a logo that will not load never blocks the quote */ } }
    pdf.font("Helvetica-Bold").fontSize(24).fillColor(NAVY).text(W.title, M, M);
    pdf.moveDown(0.4);
    pdf.font("Helvetica").fontSize(11.5).fillColor(NAVY);
    for (const [k, v] of [[W.for, i.guestName], [W.group, i.groupLabel], [W.date, i.dateText], [W.from, `${i.agentName}, ${i.businessName}`]] as const) {
      pdf.font("Helvetica-Bold").text(`${k}: `, { continued: true }).font("Helvetica").text(v);
    }

    const sh = i.sheet ?? null;
    const kv = (k: string, v: string | null | undefined) => {
      if (!v) return;
      room(18);
      pdf.font("Helvetica").fontSize(11.5).fillColor(MUTED).text(`${k}: `, M, pdf.y, { continued: true }).font("Helvetica-Bold").fillColor(NAVY).text(v);
      pdf.moveDown(0.15);
    };
    /** a block with a bold name on the left and lines on the right (a traveler and their items, a piece of travel and its details) */
    const block = (name: string, lines: readonly string[], o: { lead?: string } = {}) => {
      const leftW = width * 0.42, rightX = M + leftW + 12, rightW = width - leftW - 12;
      pdf.font("Helvetica-Bold").fontSize(11.5);
      const hl = pdf.heightOfString(name, { width: leftW });
      pdf.font("Helvetica").fontSize(10.5);
      const hr = (o.lead ? 14 : 0) + lines.reduce((n, x) => n + pdf.heightOfString(x, { width: rightW }) + 2, 0);
      room(Math.max(hl, hr) + 14);
      const y = pdf.y;
      pdf.font("Helvetica-Bold").fontSize(11.5).fillColor(NAVY).text(name, M, y, { width: leftW });
      let ry = y;
      if (o.lead) { pdf.font("Helvetica").fontSize(10.5).fillColor(MUTED).text(o.lead, rightX, ry, { width: rightW }); ry = pdf.y + 1; }
      for (const x of lines) { pdf.font(o.lead ? "Helvetica-Bold" : "Helvetica").fontSize(10.5).fillColor(o.lead ? NAVY : MUTED).text(x, rightX, ry, { width: rightW }); ry = pdf.y + 2; }
      pdf.x = M; pdf.y = Math.max(y + hl, ry) + 6;
      pdf.moveTo(M, pdf.y).lineTo(right, pdf.y).strokeColor("#dde5f1").lineWidth(0.5).stroke();
      pdf.moveDown(0.5);
    };

    // ── the two facts on top: the booking number, and how long the cabin is held ──
    if (sh) {
      pdf.moveDown(0.8);
      const y = pdf.y, half = (width - 24) / 2;
      pdf.moveTo(M, y).lineTo(M + half, y).strokeColor(NAVY).lineWidth(2).stroke();
      pdf.font("Helvetica").fontSize(10.5).fillColor(MUTED).text(W.booking, M, y + 6, { width: half });
      pdf.font("Helvetica-Bold").fontSize(20).fillColor(NAVY).text(sh.bookingNumber ?? W.none, M, y + 20, { width: half });
      const bottom = pdf.y;
      if (sh.optionUntil && sh.optionUntil.day >= new Date().toISOString().slice(0, 10)) {
        pdf.moveTo(M + half + 24, y).lineTo(right, y).strokeColor(NAVY).lineWidth(2).stroke();
        pdf.font("Helvetica").fontSize(10.5).fillColor(MUTED).text(W.held, M + half + 24, y + 6, { width: half });
        pdf.font("Helvetica-Bold").fontSize(14).fillColor(NAVY).text(sh.optionUntil.text, M + half + 24, y + 22, { width: half });
      }
      pdf.x = M; pdf.y = Math.max(bottom, pdf.y) + 4;

      // ── the trip ──
      head(W.hTrip);
      kv(W.ship, [sh.trip.ship, sh.trip.line].filter(Boolean).join(" · "));
      kv(W.departure, [sh.trip.from, sh.trip.departs].filter(Boolean).join(", "));
      kv(W.ret, sh.trip.returns);
      kv(W.duration, sh.trip.nights ? W.nights(sh.trip.nights) : null);
      if (sh.trip.stops.length) {
        const cols = [0, 42, 100, width - 150, width - 72], colW = [40, 56, width - 256, 76, 72];
        const tr = (cells: readonly string[], bold: boolean) => {
          pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10.5);
          const h = Math.max(...cells.map((c, n) => pdf.heightOfString(c, { width: colW[n]! })));
          room(h + 10);
          const y = pdf.y;
          pdf.fillColor(NAVY);
          cells.forEach((c, n) => pdf.text(c, M + cols[n]!, y, { width: colW[n]! }));
          pdf.x = M; pdf.y = y + h + 4;
          pdf.moveTo(M, pdf.y).lineTo(right, pdf.y).strokeColor(bold ? RULE : "#dde5f1").lineWidth(bold ? 1 : 0.5).stroke();
          pdf.y += 4;
        };
        pdf.moveDown(0.4);
        tr(W.cols, true);
        for (const x of sh.trip.stops) tr([x.weekday, x.date, x.port, x.arrive ?? "-", x.depart ?? "-"], false);
      }

      // ── the booking: the cabin, then each traveler with what they have ──
      head(W.hBooking);
      kv(W.room, [sh.cabin.number, sh.cabin.type ?? d.cabin, sh.cabin.deck ? `${W.deck} ${sh.cabin.deck}` : null].filter(Boolean).join(" · "));
      pdf.moveDown(0.3);
      for (const t of sh.travelers) block(t.name, t.items, t.items.length ? { lead: `${W.items}:` } : {});
    }

    // ── getting there: what and when (its price is with the rest of the money) ──
    if (d.travel.length) {
      head(d.heads.travel);
      for (const t of d.travel) block(t.title, t.details);
    }

    // ── travel protection ──
    if (d.protection && i.picked) {
      head(d.protection.head);
      line(i.picked.name, i.picked.price);
    } else if (d.protection) {
      head(d.protection.head);
      small(d.protection.lede);
      for (const p of d.protection.plans) {
        line(p.name, p.price);
        if (p.note) small(p.note);
        if (p.withTotal) small(`${p.withTotal.label}: ${p.withTotal.value}`);
      }
      small(`${d.protection.own}  ·  ${d.protection.none}`);
    }

    // ── all the money, in one column ending in one total ──
    head(W.hPay, sh ? null : d.cabin);
    const ruled = (label: string, value: string, big = false) => {
      room(big ? 44 : 34);
      pdf.moveTo(M, pdf.y).lineTo(right, pdf.y).strokeColor(NAVY).lineWidth(big ? 2 : 1.2).stroke();
      pdf.y += 7;
      line(label, value, { bold: true, size: big ? 15 : 11.5 });
      if (!big) { pdf.moveTo(M, pdf.y - 2).lineTo(right, pdf.y - 2).strokeColor(NAVY).lineWidth(1.2).stroke(); pdf.y += 6; }
    };
    if (d.matrix) {
      d.matrix.names.forEach((name, n) => {
        const rows = d.matrix!.rows.filter((r) => !r.strong);
        room(rows.length * 20 + 44);
        const y = pdf.y, leftW = width * 0.42;
        pdf.font("Helvetica-Bold").fontSize(11.5).fillColor(NAVY).text(name, M, y, { width: leftW });
        let ry = y;
        for (const r of rows) {
          pdf.font("Helvetica").fontSize(11.5).fillColor(NAVY).text(r.label, M + leftW + 12, ry, { width: width - leftW - 12 - 110 });
          pdf.text(r.values[n] ?? "", right - 110, ry, { width: 110, align: "right" });
          ry += 19;
        }
        pdf.x = M; pdf.y = ry + 4;
        for (const r of d.matrix!.rows.filter((x) => x.strong)) ruled(`${r.label} · ${name}`, r.values[n] ?? "");
      });
    }
    for (const c of d.cruise) line(c.label, c.value);
    if (d.cruiseTotal) ruled(d.cruiseTotal.label, d.cruiseTotal.value);
    for (const t of d.travel) line(t.title, t.value);
    if (d.tripTotal) ruled(d.tripTotal.label, d.tripTotal.value, !(i.picked?.withTotal));
    if (i.picked) {
      if (i.picked.price) line(i.picked.name, i.picked.price);
      if (i.picked.withTotal) ruled(i.picked.withTotal.label, i.picked.withTotal.value, true);
    }

    // ── how to answer, and the fine print ──
    pdf.moveDown(1);
    room(118);
    rule();
    pdf.font("Helvetica").fontSize(11).fillColor(NAVY).text(W.note, M, pdf.y, { width });
    pdf.moveDown(0.5);
    if (i.answerUrl) {
      pdf.text(W.answer, { width });
      pdf.font("Helvetica-Bold").fillColor("#0b4fa8").text(W.open, { width, link: i.answerUrl, underline: true }).font("Helvetica");
      pdf.fillColor(NAVY).moveDown(0.5);
    }
    pdf.text(W.call(i.phone), { width });
    pdf.moveDown(0.8);
    pdf.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(`${i.businessName} · ${i.email}\n${i.sellerOfTravel}`, { width });
    pdf.end();
  });
}
