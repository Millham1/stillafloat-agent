// group-quote-pdf.ts — the guest's quote as a PDF they can download and keep (Mark 2026-11-12: "the email I get is just that, an email without a
// downloadable PDF for the client. keep the email format with the book it and changes buttons but we need to build it into a PDF for download").
//
// The PDF prints the SAME document the email and the quote page print (QuoteDoc, built in routes/group-details.ts): the cruise guest by guest or line by
// line, the travel, the trip total, the travel protection plans. Nothing is worked out here. It carries no Book It button (a PDF agrees to nothing): it
// says where to answer. Brand rules: navy text, no white type, Mark alone, the Seller of Travel line.

import PDFDocument from "pdfkit";
import type { QuoteDoc } from "./group-details";

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
}

const NAVY = "#07183f", MUTED = "#4a5a7a", RULE = "#c5cfdf", BAND = "#eef2f8";
const M = 56;

const WORDS = {
  en: {
    title: "Your quote", for: "Prepared for", group: "Trip", date: "Quoted on", from: "From",
    note: "These are the prices quoted on the date above; they can change until the booking is made. This document charges nothing and books nothing.",
    answer: "To book it or ask for changes, use the buttons in the email this came with, or open your quote page:",
    call: (phone: string) => `Questions? Call or text Mark at ${phone}.`,
    with: "with",
  },
  es: {
    title: "Su cotización", for: "Preparada para", group: "Viaje", date: "Cotizada el", from: "De",
    note: "Estos son los precios cotizados en la fecha indicada; pueden cambiar hasta que se haga la reserva. Este documento no cobra ni reserva nada.",
    answer: "Para reservar o pedir cambios, use los botones del correo con el que llegó este documento, o abra la página de su cotización:",
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

    // ── the cruise ──
    head(d.heads.cruise, d.cabin);
    if (d.matrix) {
      const names = d.matrix.names, labelW = Math.min(190, width - names.length * 110), colW = (width - labelW) / names.length;
      const row = (label: string, values: readonly string[], bold = false) => {
        room(24);
        const y = pdf.y;
        pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(11).fillColor(NAVY).text(label, M, y, { width: labelW - 8 });
        const h = pdf.y - y;
        values.forEach((v, n) => pdf.text(v, M + labelW + n * colW, y, { width: colW, align: "right" }));
        pdf.x = M; pdf.y = y + Math.max(h, 14) + 5;
      };
      row("", names, true);
      for (const r of d.matrix.rows) row(r.label, r.values, !!r.strong);
      for (const a of d.matrix.addons) small(`${a.title}: ${a.items.join(", ")}`);
    }
    for (const c of d.cruise) line(c.label, c.value);
    if (d.cruiseTotal) line(d.cruiseTotal.label, d.cruiseTotal.value, { bold: true });

    // ── the travel ──
    if (d.travel.length) {
      head(d.heads.travel);
      for (const t of d.travel) { line(t.title, t.value); for (const x of t.details) small(x); pdf.moveDown(0.35); }
    }
    if (d.tripTotal) { pdf.moveDown(0.4); line(d.tripTotal.label, d.tripTotal.value, { bold: true, size: 13, band: true }); }

    // ── travel protection ──
    if (d.protection) {
      head(d.protection.head);
      small(d.protection.lede);
      for (const p of d.protection.plans) {
        line(p.name, p.price);
        if (p.note) small(p.note);
        if (p.withTotal) small(`${p.withTotal.label}: ${p.withTotal.value}`);
      }
      small(`${d.protection.own}  ·  ${d.protection.none}`);
    }

    // ── how to answer, and the fine print ──
    pdf.moveDown(1);
    room(150);
    rule();
    pdf.font("Helvetica").fontSize(11).fillColor(NAVY).text(W.note, M, pdf.y, { width });
    pdf.moveDown(0.5);
    if (i.answerUrl) {
      pdf.text(W.answer, { width });
      pdf.fillColor("#0b4fa8").text(i.answerUrl, { width, link: i.answerUrl, underline: true });
      pdf.fillColor(NAVY).moveDown(0.5);
    }
    pdf.text(W.call(i.phone), { width });
    pdf.moveDown(0.8);
    pdf.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(`${i.businessName} · ${i.email}\n${i.sellerOfTravel}`, { width });
    pdf.end();
  });
}
