// form-pdf.ts — Mark's own PDF of a client document, filled in (Mark 2026-10-27: "We collect the data to populate only that
// document, then show the client the actual populated document").
//
// HOW: the PDF is the Cornerstone template exactly as Mark printed it from Google Docs, with its blank lines, empty boxes and
// "[AGENT NAME]" placeholders. The document's own wording, as the client signs it (lib/group-documents.ts paperText: answers
// merged, the business named, the parts Mark cut taken out), is lined up word by word with the words on the PDF
// (data/client-forms/<key>.chars.json, from scripts/extract-form-chars.py). Where the two differ the PDF is marked:
//   · a blank line that now holds an answer  → the answer is written on the line
//   · an empty box that is now ticked         → an X in the box
//   · words the document no longer has        → covered in white (a band from margin to margin when they run over lines)
//   · words that replaced them                → written where they were, narrowed to fit
//   · the "[INSERT LOGO HERE]" line            → the Still Afloat logo
// A page left with nothing on it is taken out. So what the client sees on the PDF is what they sign, word for word.
//
// Pure apart from the loader at the bottom: fillFormPdf gets the bytes and the letters passed in.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import DiffMatchPatch from "diff-match-patch";
import { resolvePublicDir } from "./public-dir";

export interface FormChars {
  sha256: string;
  /** width, height in points, per page */
  pages: [number, number][];
  /** the PDF's letters in drawing order, no spaces */
  text: string;
  /** per letter: 0 regular, 1 bold, 2 italic, 3 bold italic */
  style?: string;
  /** per letter: page, left, top, right, bottom (points, from the top-left corner) */
  box: [number, number, number, number, number][];
}
type Box = FormChars["box"][number];

/** The documents Mark has given as PDFs (the traveler's packet and the lead's booking agreement). */
export const FORM_PDF_KEYS = [
  "15-emergency-contact-form", "01-terms-and-conditions", "05-liability-waiver", "07-travel-insurance-declination",
  "16-passport-document-checklist", "12-cruise-booking-agreement",
] as const;

const INK = rgb(0.03, 0.09, 0.25);      // the client's answers: navy, like a pen
const PRINT = rgb(0.07, 0.07, 0.07);    // words the document itself now says
const WHITE = rgb(1, 1, 1);
const BULLETS = /[●•◦▪■○◆◇►▸]/;
const BOXES = /[☐☒☑]/;

/** Letters compared alike: curly and straight quotes, dashes, a ticked box however it is drawn. */
function same(s: string): string {
  return s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, "\"").replace(/[–—−]/g, "-")
    .replace(/…/g, "...").replace(/☑/g, "☒");
}

interface PdfWord { w: string; at: number[] }
/** The PDF's words: letters on one line with no gap between them; a run of underscores and a box are words of their own. */
export function pdfWords(chars: FormChars): PdfWord[] {
  const out: PdfWord[] = [];
  let cur: PdfWord | null = null, prev: Box | null = null, prevCh = "", prevStyle = "";
  for (let i = 0; i < chars.text.length; i++) {
    const ch = chars.text[i]!, b = chars.box[i]!;
    if (BULLETS.test(ch) || ch === "|") { prev = null; continue; }
    const kind = (c: string) => (c === "_" ? 1 : BOXES.test(c) ? 2 : 0);
    const newLine = !prev || prev[0] !== b[0] || b[2] >= prev[4] - 1 || b[4] <= prev[2] + 1;
    const gap = prev ? b[1] - prev[3] : 0;
    const style = chars.style?.[i] ?? "";
    const split = !cur || newLine || gap > Math.max(1.2, (b[4] - b[2]) * 0.16) || kind(ch) !== kind(prevCh) || kind(ch) === 2 || style !== prevStyle;
    if (split) { cur = { w: "", at: [] }; out.push(cur); }
    cur!.w += ch;
    cur!.at.push(i);
    prev = b; prevCh = ch; prevStyle = style;
  }
  return out;
}

interface TextWord { w: string; line: number; raw: string; mark?: string }
/** The document's words: no rules, list dashes or table bars. A marked blank ("⟦in:dob⟧") is the word "_", like the PDF's
 *  own run of underscores, and a marked box the word "☐", so blanks and boxes line up one to one. */
export function textWords(text: string): TextWord[] {
  const out: TextWord[] = [];
  text.split("\n").forEach((line, n) => {
    if (/^-{3,}\s*$/.test(line)) return;
    const body = line.replace(/^\s*-\s+/, "");
    for (const seg of body.split(/(⟦[^⟧]*⟧)/)) {
      const m = /^⟦([^⟧]*)⟧$/.exec(seg);
      if (m) { const kind = m[1]!.split(":")[0]; out.push({ w: kind === "ch" || kind === "ck" ? "☐" : "_", line: n, raw: "", mark: m[1]! }); continue; }
      for (const tok of seg.split(/\s+/)) {
        for (const part of tok.split(/([☐☒☑])/)) {
          const raw = part.replace(/[|*]/g, "").replace(/_{2,}/g, "");
          if (raw) out.push({ w: same(raw), line: n, raw });
        }
      }
    }
  });
  return out;
}

export interface Hunk {
  /** the PDF letters (indexes into chars.text) the document no longer has here */
  del: number[];
  /** the words that belong here instead, a new line where the document starts one */
  ins: string;
  /** how many words that is */
  words: number;
}
export interface Lined {
  hunks: Hunk[];
  /** each of the document's blanks and boxes and the PDF letters it sits on */
  marks: Array<{ at: number[]; mark: string }>;
}
/** What a marked blank or box holds: the words to write, or whether the box is ticked. */
export type MarkValue = (mark: string) => string | boolean;

/** Where the PDF and the document part ways, word by word, and where each blank and box of the document is on the PDF. */
export function lineUp(chars: FormChars, text: string, value: MarkValue = () => ""): Lined {
  const pw = pdfWords(chars).map((x) => (/^_+$/.test(x.w) ? { ...x, w: "_" } : x)), tw = textWords(text);
  const code = new Map<string, string>();
  const enc = (w: string) => { let c = code.get(w); if (!c) { c = String.fromCharCode(0x4e00 + code.size); code.set(w, c); } return c; };
  const ps = pw.map((x) => enc(same(x.w))).join(""), ts = tw.map((x) => enc(x.w)).join("");
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 4;
  const diffs = slideLate(dmp.diff_main(ps, ts, false));
  const marks: Lined["marks"] = [];
  const said = (x: TextWord): string => {
    if (!x.mark) return x.raw;
    const v = value(x.mark);
    return typeof v === "boolean" ? (v ? "☒" : "☐") : v;
  };
  const raws: Array<{ del: PdfWord[]; ins: TextWord[] }> = [];
  let ip = 0, it = 0, cur: { del: PdfWord[]; ins: TextWord[] } | null = null;
  for (const [op, str] of diffs) {
    if (op === 0) {
      cur = null;
      for (let k = 0; k < str.length; k++) if (tw[it + k]!.mark) marks.push({ at: pw[ip + k]!.at, mark: tw[it + k]!.mark! });
      ip += str.length; it += str.length;
      continue;
    }
    if (!cur) { cur = { del: [], ins: [] }; raws.push(cur); }
    if (op === -1) { for (let k = 0; k < str.length; k++) cur.del.push(pw[ip + k]!); ip += str.length; }
    else { for (let k = 0; k < str.length; k++) cur.ins.push(tw[it + k]!); it += str.length; }
  }
  // words that only moved (a table the PDF reads in another order) stay where the PDF has them: a deleted word and the same
  // word inserted close by cancel out, in small edits only (a section Mark cut is never thinned out this way)
  const small = (r: { del: PdfWord[]; ins: TextWord[] }) => r.del.length <= 12 && r.ins.length <= 12;
  raws.forEach((r, i) => {
    if (!small(r)) return;
    for (let d = r.del.length - 1; d >= 0; d--) {
      const w = same(r.del[d]!.w);
      if (w === "_") continue;
      for (let j = Math.max(0, i - 4); j <= Math.min(raws.length - 1, i + 4); j++) {
        const o = raws[j]!;
        if (!small(o)) continue;
        const k = o.ins.findIndex((t) => !t.mark && t.w === w);
        if (k >= 0) { o.ins.splice(k, 1); r.del.splice(d, 1); break; }
      }
    }
  });
  const out: Hunk[] = raws.filter((r) => r.del.length || r.ins.length).map((r) => {
    let ins = "";
    r.ins.forEach((t, k) => {
      const w = said(t);
      if (w) ins += (ins ? (k > 0 && t.line !== r.ins[k - 1]!.line ? "\n" : " ") : "") + w;
    });
    return { del: r.del.flatMap((x) => x.at), ins, words: r.ins.length };
  });
  return { hunks: out, marks };
}

/** An edit followed by words equal to its own first words is moved past them ("_ Home Phone: _" deleted before the second
 *  "_" becomes "Home Phone: _" deleted after the first), so a blank lines up with the place right after its own label. */
function slideLate(diffs: Array<[number, string]>): Array<[number, string]> {
  const d = diffs.map(([op, t]) => [op, t] as [number, string]);
  for (let pass = 0, moved = true; moved && pass < 50; pass++) {
    moved = false;
    for (let i = 0; i < d.length - 1; i++) {
      const e = d[i]!, next = d[i + 1]!;
      if (e[0] === 0 || next[0] !== 0 || !e[1] || !next[1] || e[1][0] !== next[1][0]) continue;
      const ch = e[1][0]!;
      const prev = d[i - 1];
      if (prev && prev[0] === 0) prev[1] += ch; else { d.splice(i, 0, [0, ch]); i++; }
      d[i]![1] = d[i]![1].slice(1) + ch;
      d[i + 1]![1] = d[i + 1]![1].slice(1);
      if (!d[i + 1]![1]) d.splice(i + 1, 1);
      moved = true;
    }
  }
  return d.filter(([, t]) => t);
}

/** What the standard font can print (WinAnsi): boxes become brackets, anything else outside it a question mark. */
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export function printable(s: string): string {
  return s.replace(/☐/g, "[ ]").replace(/[☒☑✓✔]/g, "[X]").replace(/[   ]/g, " ")
    .replace(/[^\x20-\x7e¡-ÿ]/g, (c) => (WIN_ANSI_EXTRA.includes(c) ? c : "?"));
}

interface Line { page: number; x0: number; x1: number; top: number; bottom: number; idx: number[] }
/** Letters grouped by the line they sit on (same page, overlapping heights). */
function byLine(chars: FormChars, idx: number[]): Line[] {
  const lines: Line[] = [];
  for (const i of idx) {
    const b = chars.box[i]!, last = lines[lines.length - 1];
    if (last && last.page === b[0] && b[2] < last.bottom - 1 && b[4] > last.top + 1) {
      last.x0 = Math.min(last.x0, b[1]); last.x1 = Math.max(last.x1, b[3]);
      last.top = Math.min(last.top, b[2]); last.bottom = Math.max(last.bottom, b[4]); last.idx.push(i);
    } else lines.push({ page: b[0], x0: b[1], x1: b[3], top: b[2], bottom: b[4], idx: [i] });
  }
  return lines;
}

export interface FillInput {
  pdf: Uint8Array;
  chars: FormChars;
  /** the document's wording with its blanks and boxes marked (group-documents paperText) */
  text: string;
  /** what each marked blank or box holds (group-documents markValue with the answers and the date) */
  value: MarkValue;
  logo?: Uint8Array | null;
  /** told each line of words written on the PDF (for the tests) */
  onWrite?: (words: string, page: number) => void;
}

/** The PDF with the answers written in and everything the document no longer says covered. */
export async function fillFormPdf(input: FillInput): Promise<Uint8Array> {
  const { chars } = input;
  const doc = await PDFDocument.load(input.pdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fonts = [font, await doc.embedFont(StandardFonts.HelveticaBold), await doc.embedFont(StandardFonts.HelveticaOblique), await doc.embedFont(StandardFonts.HelveticaBoldOblique)];
  const fontAt = (i: number): PDFFont => fonts[Number(chars.style?.[i] ?? 0)] ?? font;
  const pages = doc.getPages();
  const logo = input.logo ? await doc.embedPng(input.logo).catch(() => null) : null;
  const covered = new Set<number>();
  const H = (n: number) => chars.pages[n]?.[1] ?? 792;
  const W = (n: number) => chars.pages[n]?.[0] ?? 612;
  const MARGIN = 40;

  const tick = (b: Box) => {
    const pg = pages[b[0]]!, y0 = H(b[0]) - b[4], y1 = H(b[0]) - b[2], pad = (b[3] - b[1]) * 0.2;
    pg.drawLine({ start: { x: b[1] + pad, y: y0 + pad }, end: { x: b[3] - pad, y: y1 - pad }, thickness: 1.4, color: INK });
    pg.drawLine({ start: { x: b[1] + pad, y: y1 - pad }, end: { x: b[3] - pad, y: y0 + pad }, thickness: 1.4, color: INK });
  };
  const cover = (n: number, x0: number, top: number, x1: number, bottom: number) =>
    pages[n]!.drawRectangle({ x: x0 - 1, y: H(n) - bottom - 1.5, width: x1 - x0 + 2, height: bottom - top + 3, color: WHITE });
  /** words on one line from x, on the baseline of [top, bottom], narrowed (to 55% at most) to end by maxX; an answer is a
   *  touch smaller than the print, words standing in for print are its size */
  const write = (page: PDFPage, n: number, words: string, x: number, top: number, bottom: number, maxX: number, color: RGB, f: PDFFont = font) => {
    const txt = printable(words).trim();
    if (!txt) return;
    let size = Math.max(7, Math.min(14, (bottom - top) * (color === INK ? 0.9 : 1)));
    const room = Math.max(24, maxX - x), w = f.widthOfTextAtSize(txt, size);
    if (w > room) size = Math.max(size * 0.55, (size * room) / w);
    page.drawText(txt, { x, y: H(n) - bottom + (bottom - top) * 0.2, size, font: f, color });
    input.onWrite?.(txt, n);
  };
  /** words over the lines they replace: the document's own line breaks first, then as many words as fit on each line */
  const flow = (lines: Line[], words: string, color: RGB, f: PDFFont = font) => {
    const paras = words.split("\n").map((p) => p.trim()).filter(Boolean);
    let li = 0;
    for (let pi = 0; pi < paras.length && li < lines.length; pi++) {
      let rest = paras[pi]!;
      while (rest && li < lines.length) {
        const ln = lines[li]!, size = Math.max(7, Math.min(12, (ln.bottom - ln.top) * 0.9)), room = W(ln.page) - MARGIN - ln.x0;
        const lastLine = li === lines.length - 1 || (pi === paras.length - 1 && li >= lines.length - 1);
        let take = rest;
        if (!lastLine && f.widthOfTextAtSize(printable(rest), size) > room) {
          const ws = rest.split(" ");
          let k = ws.length;
          while (k > 1 && f.widthOfTextAtSize(printable(ws.slice(0, k).join(" ")), size) > room) k--;
          take = ws.slice(0, k).join(" ");
        }
        write(pages[ln.page]!, ln.page, take, ln.x0, ln.top, ln.bottom, W(ln.page) - MARGIN, color, f);
        rest = rest.slice(take.length).trim();
        li++;
      }
      if (rest && li >= lines.length) break;
    }
  };

  /** the PDF's words after a line's covered words up to its end, spaces put back where the letters leave a gap */
  const restOfLine = (ln: Line): { text: string; x1: number; idx: number[] } | null => {
    const last = ln.idx[ln.idx.length - 1]!;
    let text = "", x1 = ln.x1, prev = chars.box[last]!;
    const idx: number[] = [];
    for (let i = last + 1; i < chars.text.length; i++) {
      const b = chars.box[i]!;
      if (b[0] !== ln.page || b[2] >= ln.bottom - 1 || b[4] <= ln.top + 1) break;
      if (b[1] - prev[3] > Math.max(1.2, (b[4] - b[2]) * 0.16) || !text) text += " ";
      text += chars.text[i];
      idx.push(i); x1 = b[3]; prev = b;
    }
    return idx.length ? { text: text.trim(), x1, idx } : null;
  };

  const lined = lineUp(chars, input.text, input.value);
  // the document's blanks and boxes where the PDF has them: answers on the lines, X in the ticked boxes
  for (const m of lined.marks) {
    const v = input.value(m.mark), b = chars.box[m.at[0]!]!;
    if (v === true) for (const i of m.at) tick(chars.box[i]!);
    else if (typeof v === "string" && v) write(pages[b[0]]!, b[0], v, b[1] + 2, b[2] - 2, b[4], W(b[0]) - MARGIN, INK);
  }
  const extra: string[] = [];
  for (const h of lined.hunks) {
    if (!h.del.length) {
      // words with no place on the PDF: a whole passage (Mark's own additions, like the insurance choice) goes on a page at
      // the end; a stray word or table cell is left to the document's text
      if (h.words >= 12) extra.push(h.ins);
      continue;
    }
    const delText = h.del.map((i) => chars.text[i]).join("");
    if (same(delText) === same(h.ins.replace(/\s/g, ""))) continue;                  // the same words, only read in another order
    if (!h.ins && /^(?:(?:[a-z]|[ivx]{1,4}|\d{1,2})[.)])+$/i.test(delText)) continue;   // a list's own letters or numbers
    const first = chars.box[h.del[0]!]!;
    if (/^_+$/.test(delText)) {
      // a blank line that now holds an answer: write on the line and leave the line
      if (h.ins) write(pages[first[0]]!, first[0], h.ins.replace(/\n/g, " "), first[1] + 2, first[2] - 2, first[4], W(first[0]) - MARGIN, INK);
      continue;
    }
    if (/^[☐]+$/.test(delText) && /^[☒☑]+$/.test(h.ins.replace(/\s/g, ""))) { for (const i of h.del) tick(chars.box[i]!); continue; }
    // words the document no longer has: covered; several lines go as a band from margin to margin
    let lines = byLine(chars, h.del);
    if (lines.length > 2 && !h.ins) {
      const band = new Map<number, { top: number; bottom: number }>();
      for (const ln of lines) {
        const e = band.get(ln.page);
        if (!e) band.set(ln.page, { top: ln.top, bottom: ln.bottom });
        else { e.top = Math.min(e.top, ln.top); e.bottom = Math.max(e.bottom, ln.bottom); }
      }
      for (const [n, e] of band) cover(n, MARGIN - 10, e.top - 2, W(n) - MARGIN + 10, e.bottom + 2);
    } else {
      for (const ln of lines) cover(ln.page, ln.x0, ln.top, ln.x1, ln.bottom);
    }
    for (const i of h.del) covered.add(i);
    // the logo line
    const logoLine = lines.find((ln) => ln.idx.map((i) => chars.text[i]).join("") === "[INSERTLOGOHERE]");
    if (logoLine && logo) {
      const hgt = 62, wdt = (logo.width / logo.height) * hgt;
      pages[logoLine.page]!.drawImage(logo, { x: W(logoLine.page) - MARGIN - wdt, y: H(logoLine.page) - logoLine.top - hgt + 8, width: wdt, height: hgt });
      lines = lines.filter((ln) => ln !== logoLine);
    }
    if (!h.ins || !lines.length) continue;
    const look = fontAt(lines[0]!.idx[0]!);
    if (lines.length === 1 && !h.ins.includes("\n")) {
      const ln = lines[0]!, tail = restOfLine(ln);
      if (tail && !/[_☐☒]/.test(tail.text)) {
        cover(ln.page, ln.x0, ln.top, tail.x1, ln.bottom);
        for (const i of tail.idx) covered.add(i);
        write(pages[ln.page]!, ln.page, `${h.ins} ${tail.text}`, ln.x0, ln.top, ln.bottom, W(ln.page) - MARGIN, PRINT, look);
        continue;
      }
    }
    flow(lines, h.ins, /_{3,}/.test(delText) ? INK : PRINT, look);
  }

  if (extra.length) {
    // the passages the PDF has no place for, on pages of their own at the end, in print
    const [pw0, ph0] = chars.pages[chars.pages.length - 1] ?? [612, 792];
    let page = doc.addPage([pw0, ph0]), y = ph0 - 72;
    const size = 11, lead = 15, room = pw0 - 2 * 72;
    for (const passage of extra) {
      for (const para of passage.split("\n")) {
        const words = printable(para).split(" ").filter(Boolean);
        let line = "";
        const flush = () => {
          if (!line) return;
          if (y < 72) { page = doc.addPage([pw0, ph0]); y = ph0 - 72; }
          page.drawText(line, { x: 72, y, size, font, color: PRINT });
          input.onWrite?.(line, doc.getPageCount() - 1);
          y -= lead; line = "";
        };
        for (const w of words) {
          const next = line ? `${line} ${w}` : w;
          if (font.widthOfTextAtSize(next, size) > room) { flush(); line = w; } else line = next;
        }
        flush();
        y -= 4;
      }
      y -= 10;
    }
  }

  // a page with nothing left on it is taken out (the medical and insurance pages Mark cut from the traveler form)
  const visible = new Array<number>(pages.length).fill(0);
  chars.box.forEach((b, i) => { if (!covered.has(i) && !BULLETS.test(chars.text[i]!)) visible[b[0]]!++; });
  for (let n = pages.length - 1; n >= 0; n--) if (visible[n] === 0 && doc.getPageCount() > 1) doc.removePage(n);
  return doc.save();
}

// ── The files ────────────────────────────────────────────────────────────────

const cache = new Map<string, { pdf: Uint8Array; chars: FormChars } | null>();
let logoBytes: Uint8Array | null | undefined;

function formsDir(): string {
  return path.join(path.dirname(resolvePublicDir()), "data", "client-forms");
}

/** Mark's PDF of a document and its letters; null when there is none for this document. */
export function formPdfFiles(key: string): { pdf: Uint8Array; chars: FormChars } | null {
  if (!(FORM_PDF_KEYS as readonly string[]).includes(key)) return null;
  if (cache.has(key)) return cache.get(key)!;
  const dir = formsDir();
  const pdfPath = path.join(dir, `${key}.pdf`), charsPath = path.join(dir, `${key}.chars.json`);
  const found = existsSync(pdfPath) && existsSync(charsPath)
    ? { pdf: new Uint8Array(readFileSync(pdfPath)), chars: JSON.parse(readFileSync(charsPath, "utf8")) as FormChars }
    : null;
  cache.set(key, found);
  return found;
}

export function stillAfloatLogo(): Uint8Array | null {
  if (logoBytes !== undefined) return logoBytes;
  try { logoBytes = new Uint8Array(readFileSync(path.join(resolvePublicDir(), "assets", "images", "still_afloat_logo.png"))); }
  catch { logoBytes = null; }
  return logoBytes;
}
