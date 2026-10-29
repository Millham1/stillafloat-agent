// group-form-pdf.ts — the clean printed form of a client document (Mark 2026-10-28: "yes make clean versions").
//
// The document as the client signs it, laid out as a proper form: the title, the Still Afloat logo top right, the business's name
// and contact lines, the sections with their headings, real blank lines, boxes and the signature lines. Answers given are written
// on their lines in navy; a chosen box is filled. Nothing is covered up: the wording is the document's own (lib/group-documents.ts
// blocksFor, paper mode, which keeps the title and the template's signature lines), so what the client reads, signs and receives
// is the same text, word for word.
//
// Pure apart from pdfkit: the logo is passed in as bytes. pdfkit's built-in fonts cover Latin-1 only (pdfSafe folds the rest); the
// boxes are ZapfDingbats.

import PDFDocument from "pdfkit";
import type { Answers, Block } from "./group-documents";
import { pdfSafe } from "./group-signature-pdf";

export interface FormPdfInput {
  /** the document's name, for the page footer */
  title: string;
  businessName: string;
  /** blocksFor(key, ctx, { paper: true }).blocks: the wording with its blanks and boxes as tokens */
  blocks: Block[];
  answers: Answers;
  /** the date written on "Date Completed" and beside the signature, e.g. "October 28, 2026" */
  today: string;
  /** the typed name: on the client's own signature line, its date and its printed name */
  signer?: string;
  logo?: Buffer | null;
  /** told each word written on the form (for the tests) */
  onText?: (word: string) => void;
}

const INK = "#111111";
const PEN = "#07183f";        // the client's answers: navy, like a pen
const HEAD = "#1d4f6b";       // the headings: the Cornerstone forms' blue
const RULE = "#9aa7bf";
const MARGIN = 64;
const SIZE = 10.5;

type Piece =
  | { k: "text"; text: string; bold: boolean; italic: boolean }
  | { k: "answer"; text: string }
  | { k: "blank" }
  | { k: "box"; on: boolean };

const TOKEN = /\{\{(in|ta|ck|ch|today|logo|bl|sig|sigdate|signame)(?::([^:}]+))?(?::([^}]+))?\}\}|_{3,}|[☐☒☑]/g;

/** **bold** and *italic* spans of plain text */
function styled(text: string): Array<Extract<Piece, { k: "text" }>> {
  const out: Array<Extract<Piece, { k: "text" }>> = [];
  const re = /\*\*(.+?)\*\*|(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ k: "text", text: text.slice(last, m.index), bold: false, italic: false });
    out.push({ k: "text", text: m[1] ?? m[2] ?? "", bold: m[1] !== undefined, italic: m[2] !== undefined });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ k: "text", text: text.slice(last), bold: false, italic: false });
  // a mark the template left unpaired ("*For Agent Use Only:*Date") is not printed
  return out.map((r) => ({ ...r, text: r.text.replace(/\*+/g, "") }));
}

/** a line of the document: its words, and its blanks and boxes with what the client gave */
export function pieces(text: string, input: Pick<FormPdfInput, "answers" | "today" | "signer">): Piece[] {
  return styled(text).flatMap((r) => (r.k === "text" ? inRun(r.text, r.bold, r.italic, input) : [r]));
}
function inRun(text: string, bold: boolean, italic: boolean, input: Pick<FormPdfInput, "answers" | "today" | "signer">): Piece[] {
  const out: Piece[] = [];
  const a = input.answers;
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    if (m.index > last) out.push({ k: "text", text: text.slice(last, m.index), bold, italic });
    last = m.index + m[0].length;
    const [all, kind, name, value] = m;
    if (!kind) {
      if (all.startsWith("_")) out.push({ k: "blank" });
      else out.push({ k: "box", on: all !== "☐" });
      continue;
    }
    const v = name ? a[name] : undefined;
    const say = (s: string | undefined) => out.push(s ? { k: "answer", text: s } : { k: "blank" });
    switch (kind) {
      case "in": case "ta": say(typeof v === "string" ? v.replace(/\s+/g, " ").trim() : undefined); break;
      case "today": say(input.today); break;
      case "sig": say(input.signer ? `/s/ ${input.signer}` : undefined); break;
      case "sigdate": say(input.signer ? input.today : undefined); break;
      case "signame": say(input.signer || undefined); break;
      case "ck": out.push({ k: "box", on: v === true }); break;
      case "ch": out.push({ k: "box", on: Array.isArray(v) ? v.includes(value!) : v === value }); break;
      case "logo": break;
      default: out.push({ k: "blank" });
    }
  }
  if (last < text.length) out.push({ k: "text", text: text.slice(last), bold, italic });
  return out;
}

/** The client's own signature block (the first "Primary Traveler / Primary Guest / Client / Traveler / Cardholder Signature" one): its
 *  Signature, Date and Print Name lines become places for the typed name and the date. The co-traveler's, the parent's and the
 *  agent's blocks stay blank lines. */
export function markSignature(blocks: Block[]): Block[] {
  let mine = false, done = false;
  return blocks.map((b) => {
    if (b.t !== "p" || done) return b;
    const p = b.text;
    if (/^\**(Primary Traveler|Primary Guest)\b/i.test(p) || /\b(Client|Traveler|Cardholder) Signature/i.test(p)) mine = true;
    else if (/^\**(Co-Traveler|Parent|Travel Agent|Agent)\b/i.test(p) || /Agent Signature/i.test(p)) { if (mine) done = true; mine = false; }
    if (!mine) return b;
    const text = p.replace(/(Signature:\**\s*)_{3,}/i, "$1{{sig}}").replace(/(Date:\**\s*)_{3,}/, "$1{{sigdate}}").replace(/(Print Name:\**\s*)_{3,}/, "$1{{signame}}");
    if (/Print Name:/.test(p)) { mine = false; done = true; }
    return { ...b, text };
  });
}

export async function renderFormPdf(input: FormPdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER", margins: { top: MARGIN, bottom: 64, left: MARGIN, right: MARGIN }, bufferPages: true,
      info: { Title: pdfSafe(input.title), Author: pdfSafe(input.businessName) },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const width = doc.page.width - MARGIN * 2;
      const LOGO_W = 92;

      /** one paragraph of the document: its words, answers, blank lines and boxes laid out by hand, wrapping at the width;
       *  an answer is underlined in navy, a blank is a line, a box a square (filled when chosen) */
      const line = (text: string, o: { size?: number; color?: string; bold?: boolean; italic?: boolean; x?: number; y?: number; w?: number; gap?: number; indent?: number } = {}) => {
        const list = pieces(text, input);
        if (!list.some((p) => p.k !== "text" || p.text.trim())) return;
        const size = o.size ?? SIZE, lead = size * 1.42, x0 = (o.x ?? MARGIN) + (o.indent ?? 0), w = (o.w ?? width) - (o.indent ?? 0);
        type Atom = { kind: "word" | "answer" | "blank" | "box"; text: string; font: string; color: string; wd: number; space: number; on?: boolean };
        const atoms: Atom[] = [];
        const fontOf = (b: boolean, i: boolean) => (b ? (i ? "Helvetica-BoldOblique" : "Helvetica-Bold") : i ? "Helvetica-Oblique" : "Helvetica");
        const spaceW = doc.font("Helvetica").fontSize(size).widthOfString(" ");
        const words = (str: string, kind: "word" | "answer", font: string, color: string) => {
          const parts = pdfSafe(str).split(/(\s+)/);
          for (const part of parts) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { if (atoms.length) atoms[atoms.length - 1]!.space = spaceW; continue; }
            atoms.push({ kind, text: part, font, color, wd: doc.font(font).fontSize(size).widthOfString(part), space: 0 });
          }
        };
        for (const p of list) {
          if (p.k === "text") words(p.text, "word", fontOf(p.bold || !!o.bold, p.italic || !!o.italic), o.color ?? INK);
          else if (p.k === "answer") { words(p.text, "answer", "Helvetica", PEN); if (atoms.length) atoms[atoms.length - 1]!.space = spaceW; }
          else if (p.k === "blank") atoms.push({ kind: "blank", text: "", font: "Helvetica", color: INK, wd: Math.min(120, w * 0.5), space: spaceW });
          else atoms.push({ kind: "box", text: "", font: "Helvetica", color: INK, wd: size * 0.85, space: size * 0.45, on: p.on });
        }
        let x = x0, y = o.y ?? doc.y;
        const bottomLimit = doc.page.height - 72;
        if (y + lead > bottomLimit) { doc.addPage(); y = doc.page.margins.top; }
        for (const at of atoms) {
          if (x > x0 && x + at.wd > x0 + w) { x = x0; y += lead; if (y + lead > bottomLimit) { doc.addPage(); y = doc.page.margins.top; } }
          const base = y + size * 0.82;    // where the letters sit
          if (at.kind === "word" || at.kind === "answer") {
            doc.font(at.font).fontSize(size).fillColor(at.color).text(at.text, x, y, { lineBreak: false });
            input.onText?.(at.text);
            if (at.kind === "answer") doc.moveTo(x - 1, base + 2).lineTo(x + at.wd + (at.space ? at.space : 1), base + 2).strokeColor(PEN).lineWidth(0.6).stroke();
          } else if (at.kind === "blank") {
            doc.moveTo(x, base + 2).lineTo(x + at.wd, base + 2).strokeColor(INK).lineWidth(0.6).stroke();
          } else {
            const s0 = at.wd, top = base - s0 + 1;
            doc.rect(x, top, s0, s0).strokeColor(INK).lineWidth(0.8).stroke();
            if (at.on) doc.rect(x + 2, top + 2, s0 - 4, s0 - 4).fill(PEN);
          }
          x += at.wd + at.space;
        }
        doc.x = MARGIN;
        doc.y = y + lead;
        doc.moveDown(o.gap ?? 0.35);
      };

      if (input.logo) {
        try { doc.image(input.logo, doc.page.width - MARGIN - LOGO_W, MARGIN - 18, { width: LOGO_W }); } catch { /* a logo that will not load never blocks the form */ }
      }
      let titled = false;
      const blocks = markSignature(input.blocks);
      for (const b of blocks) {
        // keep the title and the business's lines clear of the logo on the first page
        const wFirst = doc.bufferedPageRange().count === 1 && doc.y < MARGIN + 70 ? width - LOGO_W - 12 : width;
        switch (b.t) {
          case "h": {
            if (!titled && b.level === 1) {
              titled = true;
              line(b.text.toUpperCase(), { size: 17, color: HEAD, w: wFirst, gap: 0.3 });
              doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + wFirst, doc.y).strokeColor(RULE).lineWidth(0.7).stroke();
              doc.moveDown(0.7);
              break;
            }
            if (doc.y > doc.page.height - 130) doc.addPage();
            doc.moveDown(0.3);
            line(b.text, { size: b.level <= 2 ? 13 : 11.5, color: HEAD, bold: b.level > 2, w: wFirst, gap: 0.35 });
            break;
          }
          case "hr":
            doc.moveDown(0.2);
            doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
            doc.moveDown(0.6);
            break;
          case "p": line(b.text, { w: wFirst }); break;
          case "ul": b.items.forEach((x) => line(`•  ${x}`, { indent: 12, gap: 0.2 })); doc.moveDown(0.3); break;
          case "ol": b.items.forEach((x, i) => line(`${i + 1}.  ${x}`, { indent: 12, gap: 0.2 })); doc.moveDown(0.3); break;
          case "table": {
            const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
            const cw = width / cols;
            const row = (cells: string[], bold: boolean) => {
              const plain = cells.map((c) => pieces(c, input).map((p) => (p.k === "text" ? p.text : p.k === "answer" ? ` ${p.text} ` : p.k === "box" ? "   " : "____________")).join(""));
              const tallest = Math.max(14, ...plain.map((c) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).heightOfString(pdfSafe(c) || " ", { width: cw - 10, lineGap: 4 })));
              if (doc.y + tallest + 12 > doc.page.height - 72) doc.addPage();
              const y = doc.y;
              let low = y + tallest + 8;
              cells.forEach((c, i) => { line(c, { size: 9.5, bold, x: MARGIN + i * cw + 5, y: y + 4, w: cw - 10, gap: 0 }); low = Math.max(low, doc.y + 2); });
              const bottom = low;
              doc.rect(MARGIN, y, width, bottom - y).strokeColor(RULE).lineWidth(0.5).stroke();
              for (let i = 1; i < cols; i++) doc.moveTo(MARGIN + i * cw, y).lineTo(MARGIN + i * cw, bottom).stroke();
              doc.y = bottom;
            };
            if (b.header.some((c) => c !== "")) row(b.header, true);
            b.rows.forEach((r) => row(r, false));
            doc.x = MARGIN;
            doc.moveDown(0.8);
            break;
          }
        }
      }

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font("Helvetica").fontSize(8).fillColor("#5b6b8c")
          .text(pdfSafe(`${input.businessName} · ${input.title} · page ${i - range.start + 1} of ${range.count}`), MARGIN, doc.page.height - 40, { width, align: "center", lineBreak: false });
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
