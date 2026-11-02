// group-signature-pdf.ts — the signed copy of a client document (migration 0044).
//
// What the signer saw (the document text with their answers merged in) followed by a signature
// block: the typed name, the date and time in UTC, "signed electronically", the document version
// and the sha256 of the text they agreed to. Stored in the PRIVATE `group-docs` bucket at
// signatures/<group_id>/<signature_id>.pdf; Mark opens it through a 10-minute signed link.
//
// Pure apart from pdfkit (no file or network access): the logo, when there is one, is passed in
// as bytes. pdfkit's built-in fonts cover Latin-1 only, so text is folded to that range first
// (an accented letter stays; a character outside it becomes the nearest plain letter or "?").
// The exact typed name is also kept in group_signatures.signer_name, so nothing is lost.

import PDFDocument from "pdfkit";
import { stripInline } from "./group-documents";
import type { Block } from "./group-document-kit";

export interface SignedCopyInput {
  businessName: string;
  title: string;
  /** The document with the signer's answers merged in (fillBlocks). */
  blocks: Block[];
  signerName: string;
  /** "traveler" | "lead" | "organizer" */
  signerRole: string;
  signedAt: Date;
  docVersion: string;
  contentSha256: string;
  signatureId?: string;
  /** The template has an agent signature that is recorded later (the group contract). */
  agentCountersignPending?: boolean;
  logo?: Buffer | null;
  compress?: boolean;
}

const WIN_ANSI_EXTRAS = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Fold text to what the PDF's standard fonts can print. */
export function pdfSafe(input: string): string {
  const swapped = input.replace(/☒/g, "[x]").replace(/☐/g, "[ ]").replace(/[ -​  ]/g, " ").replace(/→/g, "->");
  let out = "";
  for (const ch of swapped.normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    if (code === 9 || code === 10 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || WIN_ANSI_EXTRAS.has(ch)) { out += ch; continue; }
    const folded = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += /^[\x20-\x7e]+$/.test(folded) ? folded : "?";
  }
  return out;
}

const INK = "#07183f";
const MARGIN = 54;

type Run = { text: string; bold: boolean; italic: boolean };

/** **bold** and *italic* spans → runs. */
function runs(text: string): Run[] {
  const out: Run[] = [];
  const re = /\*\*(.+?)\*\*|(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false, italic: false });
    out.push({ text: m[1] ?? m[2] ?? "", bold: m[1] !== undefined, italic: m[2] !== undefined });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false, italic: false });
  return out.length ? out : [{ text: "", bold: false, italic: false }];
}

export async function renderSignedPdf(input: SignedCopyInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER", margins: { top: MARGIN, bottom: 60, left: MARGIN, right: MARGIN }, bufferPages: true, compress: input.compress !== false,
      info: { Title: pdfSafe(`${input.title} (signed copy)`), Author: pdfSafe(input.businessName), Subject: "Electronically signed client document" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const width = doc.page.width - MARGIN * 2;
      const para = (text: string, o: { size?: number; gap?: number; indent?: number; bold?: boolean } = {}) => {
        const size = o.size ?? 10;
        const list = runs(text);
        list.forEach((r, i) => {
          doc.font(r.bold || o.bold ? "Helvetica-Bold" : r.italic ? "Helvetica-Oblique" : "Helvetica").fontSize(size).fillColor(INK);
          doc.text(pdfSafe(r.text), i === 0 ? MARGIN + (o.indent ?? 0) : undefined, i === 0 ? undefined : undefined, { continued: i < list.length - 1, width: width - (o.indent ?? 0), lineGap: 1.5 });
        });
        doc.moveDown(o.gap ?? 0.5);
      };

      if (input.logo) {
        try { doc.image(input.logo, MARGIN, MARGIN - 10, { width: 110 }); doc.moveDown(0); doc.y = MARGIN + 70; } catch { /* a logo that will not load never blocks a signed copy */ }
      }
      para(`**${input.businessName}**`, { size: 11, gap: 0.2 });
      para(`**${input.title}**`, { size: 16, gap: 0.2 });
      para("*Signed copy: the document as it was shown, with the answers given, followed by the electronic signature.*", { size: 9, gap: 1 });
      doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).strokeColor("#9aa7bf").lineWidth(0.6).stroke();
      doc.moveDown(0.8);

      for (const b of input.blocks) {
        switch (b.t) {
          case "h": para(`**${stripInline(b.text)}**`, { size: b.level <= 2 ? 12 : 10.5, gap: 0.4 }); break;
          case "hr":
            doc.moveDown(0.2);
            doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).strokeColor("#c5cddd").lineWidth(0.5).stroke();
            doc.moveDown(0.6);
            break;
          case "p": para(b.text); break;
          case "ul": b.items.forEach((x) => para(`•  ${x}`, { indent: 10, gap: 0.2 })); doc.moveDown(0.3); break;
          case "ol": b.items.forEach((x, i) => para(`${i + 1}.  ${x}`, { indent: 10, gap: 0.2 })); doc.moveDown(0.3); break;
          case "table": {
            const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
            const cw = width / cols;
            const row = (cells: string[], bold: boolean) => {
              const y0 = doc.y;
              let tallest = 0;
              cells.forEach((c, i) => {
                const h = doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).heightOfString(pdfSafe(stripInline(c)), { width: cw - 6 });
                tallest = Math.max(tallest, h);
                void i;
              });
              if (y0 + tallest > doc.page.height - 70) { doc.addPage(); }
              const y = doc.y;
              cells.forEach((c, i) => {
                doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(INK).text(pdfSafe(stripInline(c)), MARGIN + i * cw + 3, y, { width: cw - 6 });
              });
              doc.y = y + tallest + 4;
              doc.moveTo(MARGIN, doc.y - 2).lineTo(MARGIN + width, doc.y - 2).strokeColor("#dfe5f0").lineWidth(0.4).stroke();
            };
            if (b.header.some((c) => c !== "")) row(b.header, true);
            b.rows.forEach((r) => row(r, false));
            doc.moveDown(0.6);
            break;
          }
        }
      }

      // The signature block: kept together on one page.
      if (doc.y > doc.page.height - 230) doc.addPage();
      doc.moveDown(0.6);
      doc.rect(MARGIN, doc.y, width, 1.4).fill(INK);
      doc.moveDown(0.8);
      para("**ELECTRONIC SIGNATURE**", { size: 12, gap: 0.4 });
      const iso = input.signedAt.toISOString();
      const when = `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
      const role = input.signerRole === "lead" ? "cabin lead" : input.signerRole === "organizer" ? "group organizer" : "traveler";
      para(`**Signed electronically by:** ${input.signerName}`, { gap: 0.2 });
      para(`**Signing as:** ${role}`, { gap: 0.2 });
      para(`**Date and time:** ${when}`, { gap: 0.2 });
      para("**Method:** typed full name and an explicit \"I agree\" confirmation on the signer's private link. The signer's network address and device are kept only as one-way hashes.", { gap: 0.2 });
      para(`**Document version:** ${input.docVersion}`, { gap: 0.2 });
      para(`**SHA-256 of the document text agreed to:** ${input.contentSha256}`, { gap: 0.2, size: 8.5 });
      if (input.signatureId) para(`**Signature record:** ${input.signatureId}`, { gap: 0.2, size: 8.5 });
      if (input.agentCountersignPending) para(`**Agent countersignature (${input.businessName}):** not yet recorded.`, { gap: 0.2 });

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // the footer sits inside the bottom margin; without this pdfkit would add a page to make room for it
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font("Helvetica").fontSize(8).fillColor("#5b6b8c")
          .text(pdfSafe(`${input.businessName} · ${input.title} · signed copy · page ${i - range.start + 1} of ${range.count}`), MARGIN, doc.page.height - 40, { width, align: "center", lineBreak: false });
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
