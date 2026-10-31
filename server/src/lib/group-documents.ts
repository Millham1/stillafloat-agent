// group-documents.ts — client paperwork: Cornerstone Collective's templates, filled from the group
// file and shown / signed on the traveler's private page (migration 0044).
//
// PURE: no I/O. The templates arrive as the generated module content/client-documents.ts; the
// per-document data (which blank is which field) is group-document-specs.ts; shared types and
// file lookups are group-document-kit.ts. This file is the engine:
//
//   unescapeConnectorMarkdown → apply the spec's rules (fill blanks from the file, turn blanks and
//   ☐ boxes into inputs) → parse to blocks → drop the template's own signature lines → names,
//   logo, payment text → fees (none unless Mark entered some) → the cruise line's own cancellation
//   schedule → the spec's structural edits → html + text.
//
// THE SIGNED THING. `text` is the document as the signer saw it BEFORE they typed anything: inputs
// are "________", boxes "☐", the signing date "[date of signing]". Its sha256 is what a signature
// records (group_signatures.content_sha256) and what the server re-computes on POST, so a file that
// changed between "page loaded" and "I agree" is refused (409) instead of signed. What the signer
// entered is stored beside it as `answers`; fillBlocks() merges the two for the signed PDF.
//
// MARK'S RULINGS ENCODED HERE (2026-10-02/03):
//   * the business is written as BUSINESS.legalName everywhere ("Still Afloat LLC dba Still Afloat Cruising");
//   * NO FEES unless groups.fees has entries: documents 02 and 03 are then not in any packet, and the
//     fee sections / lines inside the others are removed (the rest of the template stays intact);
//   * where the file holds the cruise line's own cancellation schedule it replaces the template's
//     "typical" table, with the calendar dates; the template sentence that the booking confirmation
//     governs stays;
//   * the card-authorization form (06) still renders but is in no packet;
//   * every number and date comes from the group file — a blank the file cannot fill stays a blank
//     and is reported in `unfilled`.

import { CLIENT_DOCUMENTS } from "../content/client-documents";
import { BUSINESS, last4, normalizePassport, passportLooksValid, sha256Hex } from "./group-secure";
import { looksLikeCardNumber } from "./group-file";
import {
  TEMPLATE_VERSION_DATE, buildCtx, cancellationNote, cancellationRows, cleanValue, fmtLong, fmtMoney, normalizeFees,
  type Answers, type Block, type DocCtx, type DocSpec, type FeeLine, type FieldSpec, type Lang, type Row, type SignerRole,
} from "./group-document-kit";
import { DOC_SPECS } from "./group-document-specs";

export { DOC_SPECS, TEMPLATE_VERSION_DATE, buildCtx, normalizeFees };
export type { Answers, Block, DocCtx, DocSpec, FeeLine, FieldSpec, Lang, Row, SignerRole };

// ── 1. The connector's escaping ───────────────────────────────────────────────

/** Undo the markdown escaping the Google Docs connector added (\_ \[ \] \# \. \* \! \\ …), drop its
 * "end list" comments, and normalise every run of blanks to plain underscores. */
export function unescapeConnectorMarkdown(src: string): string {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/<!--\s*end list\s*-->/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~"'&$])/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~"'&$])/g, "$1") // table cells were escaped twice ("\\\#")
    // inside tables the connector escaped twice: "\\\_" is "\_" after one pass; a blank is a blank either way
    .replace(/(?:\\?_){3,}/g, (m) => "_".repeat(m.replace(/\\/g, "").length))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** The connector glued a bold heading to the sentence after it ("**3.1 Deposits**A non-refundable…"). */
export function separateGluedHeadings(md: string): string {
  // Pairs are consumed left to right, so a bold span that is NOT glued can never be mis-paired with the next one.
  return md.replace(/\*\*[^*\n]{2,120}\*\*/g, (m, at: number, whole: string) => (/[A-Za-z([☐]/.test(whole[at + m.length] ?? "") ? `${m} ` : m));
}

// ── 2. Markdown → blocks ──────────────────────────────────────────────────────

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** The templates use a small markdown dialect: # headings, ----- rules, paragraphs, - and 1. lists, pipe tables. */
export function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) { flush(); continue; }
    if (/^-{5,}$/.test(trimmed)) { flush(); blocks.push({ t: "hr" }); continue; }
    const h = /^(#{1,6})\s+(.*?)\s*$/.exec(trimmed);
    if (h) { flush(); blocks.push({ t: "h", level: h[1]!.length, text: h[2]! }); continue; }
    if (trimmed.startsWith("|")) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const cells = splitRow(lines[i]!);
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells); // skip the | :-: | rule
        i++;
      }
      i--;
      // Google's tables arrive with an empty header row and the real header as the first body row.
      let header = rows.shift() ?? [];
      if (header.every((c) => c === "") && rows.length) header = rows.shift()!;
      blocks.push({ t: "table", header, rows });
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(trimmed);
    if (ul) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.t === "ul") last.items.push(ul[1]!); else blocks.push({ t: "ul", items: [ul[1]!] });
      continue;
    }
    const ol = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (ol) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.t === "ol") last.items.push(ol[1]!); else blocks.push({ t: "ol", items: [ol[1]!] });
      continue;
    }
    para.push(trimmed);
  }
  flush();
  return blocks;
}

// ── 3. Inline text: bold / italic / tokens ────────────────────────────────────
//
// Tokens live inside the template text while it is being edited:
//   {{in:name}} a one-line input   {{ta:name}} a text box   {{ck:name}} a single box
//   {{ch:name:value}} one option of a choice/multi field   {{today}} the signing date
//   {{logo}} the logo   {{bl:Label}} a blank the file could not fill

const TOKEN = /\{\{(in|ta|ck|ch|today|logo|bl)(?::([^:}]+))?(?::([^}]+))?\}\}/g;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const BOLD = /\*\*(.+?)\*\*/g;
const ITALIC = /(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g;

/** Drop **bold** / *italic* markers: what the text says, without how it is styled. */
export function stripInline(s: string): string {
  return s.replace(BOLD, "$1").replace(ITALIC, "$1");
}

interface Env {
  fields: Map<string, FieldSpec>;
  ctx: DocCtx;
}

function inputHtml(kind: string, name: string, env: Env): string {
  const f = env.fields.get(name);
  const label = esc(f?.label ?? name);
  const max = f?.maxLength ?? 200;
  if (kind === "ta") return `<textarea class="doc-ta" name="${name}" data-field="${name}" maxlength="${f?.maxLength ?? 1000}" rows="3" aria-label="${label}"></textarea>`;
  if (kind === "ck") return `<input class="doc-box" type="checkbox" name="${name}" data-field="${name}" data-kind="check" aria-label="${label}">`;
  const type = f?.kind === "date" ? "date" : f?.kind === "email" ? "email" : f?.kind === "tel" ? "tel" : "text";
  const extra = f?.kind === "passport" || f?.kind === "license" ? ' autocomplete="off" autocapitalize="characters" spellcheck="false"' : "";
  return `<input class="doc-in" type="${type}" name="${name}" data-field="${name}" data-kind="${f?.kind ?? "text"}" maxlength="${max}" aria-label="${label}"${extra}>`;
}

function inlineHtml(text: string, env: Env): string {
  let out = esc(text);
  out = out.replace(TOKEN, (_m, kind: string, a?: string, b?: string) => {
    switch (kind) {
      case "in": case "ta": case "ck": return inputHtml(kind, a!, env);
      case "ch": {
        const f = env.fields.get(a!);
        const type = f?.kind === "multi" ? "checkbox" : "radio";
        return `<input class="doc-box" type="${type}" name="${a}" value="${esc(b ?? "")}" data-field="${a}" data-kind="${f?.kind ?? "choice"}" aria-label="${esc(f?.options?.find((o) => o.value === b)?.label ?? b ?? "")}">`;
      }
      case "today": return `<span class="doc-today">${esc(fmtLong(env.ctx.now.toISOString()))}</span>`;
      case "logo": return `<img class="doc-logo" src="${BUSINESS.logoPath}" alt="${esc(BUSINESS.tradeName)} logo" width="220">`;
      default: return '<span class="blank"></span>';
    }
  });
  out = out.replace(/_{3,}/g, '<span class="blank"></span>').replace(/☐/g, '<span class="box">☐</span>');
  out = out.replace(BOLD, "<strong>$1</strong>").replace(ITALIC, "<em>$1</em>");
  return out.replace(/\n/g, "<br>");
}

function tokensToText(text: string, mode: { answers?: Answers; today?: string }): string {
  const a = mode.answers;
  return text.replace(TOKEN, (_m, kind: string, name?: string, value?: string) => {
    switch (kind) {
      case "in": case "ta": {
        const v = a?.[name!];
        // Mark 2026-10-30: a line the signer left empty says so on the signed copy, never a bare blank.
        if (typeof v !== "string" || !v.trim()) return a ? "N/A — left intentionally blank" : "________";
        // A date answer is stored as YYYY-MM-DD; the printed copy reads it as a date.
        return (/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && fmtLong(v.trim())) || cleanValue(v);
      }
      case "ck": return a?.[name!] === true ? "☒" : "☐";
      case "ch": {
        const v = a?.[name!];
        const on = Array.isArray(v) ? v.includes(value!) : v === value;
        return on ? "☒" : "☐";
      }
      case "today": return mode.today ?? "[date of signing]";
      case "logo": return "";
      default: return "________";
    }
  });
}

// ── 4. Block operations ───────────────────────────────────────────────────────

function drift(key: string, what: string): Error {
  return new Error(`client document ${key} no longer matches its spec: ${what}`);
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Apply a spec's rules to the unescaped markdown, in document order (a moving cursor keeps repeated labels apart). */
export function applyRules(md: string, spec: DocSpec, ctx: DocCtx): string {
  let s = md;
  let cursor = 0;
  const fields = new Map(spec.fields.map((f) => [f.name, f]));
  for (const rule of spec.rules) {
    if ("sub" in rule) {
      if (typeof rule.sub === "string") {
        const i = s.indexOf(rule.sub, cursor);
        if (i < 0) throw drift(spec.key, `text "${rule.sub.slice(0, 50)}" not found`);
        s = s.slice(0, i) + rule.with(ctx) + s.slice(i + rule.sub.length);
        cursor = i;
      } else {
        const re = new RegExp(rule.sub.source, rule.sub.flags.replace("g", "") + "g");
        re.lastIndex = cursor;
        const m = re.exec(s);
        if (!m) throw drift(spec.key, `pattern ${rule.sub} not found`);
        s = s.slice(0, m.index) + rule.with(ctx) + s.slice(m.index + m[0].length);
        cursor = m.index;
      }
      continue;
    }
    const a = s.indexOf(rule.after, cursor);
    if (a < 0) throw drift(spec.key, `anchor "${rule.after}" not found`);
    cursor = a;
    const from = a + rule.after.length;
    if ("choice" in rule) {
      const f = fields.get(rule.choice);
      if (f?.kind === "check") {
        // one box that is an acknowledgement, not a choice between options
        const m = /☐\s*/.exec(s.slice(from));
        if (!m || m.index > 700) throw drift(spec.key, `no ☐ after "${rule.after}" for ${rule.choice}`);
        const at = from + m.index;
        s = s.slice(0, at) + `{{ck:${f.name}}} ` + s.slice(at + m[0].length);
        continue;
      }
      if (!f?.options?.length) throw drift(spec.key, `choice field ${rule.choice} has no options`);
      let pos = from;
      for (const o of f.options) {
        const re = new RegExp(`☐\\s*(?=${escRe(o.match ?? o.label)}(?![A-Za-z-]))`, "g");
        re.lastIndex = pos;
        const m = re.exec(s);
        if (!m || m.index - from > 700) throw drift(spec.key, `option "${o.label}" of ${rule.choice} not found after "${rule.after}"`);
        const token = `{{ch:${f.name}:${o.value}}} `;
        s = s.slice(0, m.index) + token + s.slice(m.index + m[0].length);
        pos = m.index + token.length;
      }
      continue;
    }
    if ("area" in rule) {
      const end = s.indexOf("\n\n", from);
      const at = end < 0 ? s.length : end;
      s = `${s.slice(0, at)}\n\n{{ta:${rule.area}}}${s.slice(at)}`;
      continue;
    }
    const re = /_{3,}/g;
    re.lastIndex = from;
    const m = re.exec(s);
    if (!m || m.index - from > 90) throw drift(spec.key, `no blank after "${rule.after}"`);
    let rep: string;
    if ("slot" in rule) rep = `{{in:${rule.slot}}}`;
    else if ("today" in rule) rep = "{{today}}";
    else {
      const v = rule.fill(ctx);
      rep = v ? cleanValue(v) : "{{bl:" + rule.label.replace(/[:}]/g, " ") + "}}";
    }
    s = s.slice(0, m.index) + rep + s.slice(m.index + m[0].length);
  }
  return s;
}

/** Names, contact line, logo, payment text and arbitration venue (Mark 2026-10-03). */
export function replacePlaceholders(md: string, ctx: DocCtx): string {
  const b = ctx.business;
  return md
    .replace(/\*\*\[INSERT LOGO HERE\]\*\*|\[INSERT LOGO HERE\]/g, "{{logo}}")
    .replace(/\[AGENT NAME \/ BUSINESS NAME\]/g, b.legalName)
    .replace(/\[AGENT CONTACT INFORMATION\]/g, b.contactLine)
    .replace(/We accept \[list accepted payment methods\]\./g, b.paymentMethods)
    .replace(/\[list accepted payment methods\]/g, b.paymentMethods)
    .replace(/\[City, State\]/g, b.arbitrationCity);
}

const KEEP_AFTER_SIGNATURE = /^\*(Note:|We look forward|Smooth sailing|Please notify|Questions\?|Powered by|Seller of Travel)/;

/** The template's own Signature / Date / Print Name lines are replaced by the typed signature: drop them. */
function dropSignature(key: string, blocks: Block[], start: RegExp | undefined): Block[] {
  if (!start) return blocks;
  const i = blocks.findIndex((b) => b.t === "p" && start.test(b.text));
  if (i < 0) throw drift(key, `signature lines ${start} not found`);
  let j = i;
  while (j < blocks.length && !(blocks[j]!.t === "p" && KEEP_AFTER_SIGNATURE.test((blocks[j] as { text: string }).text))) j++;
  const head = blocks.slice(0, i);
  while (head.length && head[head.length - 1]!.t === "hr") head.pop();
  return [...head, { t: "hr" }, ...blocks.slice(j)];
}

function dropTitle(blocks: Block[]): Block[] {
  // "# TERMS AND CONDITIONS" + rule is the Google Doc's file title; the page and the PDF carry the title themselves.
  if (blocks[0]?.t === "h" && blocks[0].level === 1) return blocks[1]?.t === "hr" ? blocks.slice(2) : blocks.slice(1);
  return blocks;
}

function collapseRules(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.t === "hr" && (!out.length || out[out.length - 1]!.t === "hr")) continue;
    out.push(b);
  }
  while (out.length && out[out.length - 1]!.t === "hr") out.pop();
  return out;
}

/** Remove the heading at `i` and everything under it up to the next rule or a heading of the same or higher rank. */
function removeSection(blocks: Block[], i: number): Block[] {
  const head = blocks[i] as Extract<Block, { t: "h" }>;
  let j = i + 1;
  while (j < blocks.length) {
    const b = blocks[j]!;
    if (b.t === "hr" || (b.t === "h" && b.level <= head.level)) break;
    j++;
  }
  return [...blocks.slice(0, i), ...blocks.slice(j)];
}

const FEE_WORD = /\bfees?\b/i;
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9*"“(])/;

/** No fees on the file: take the agent-fee sections and lines out; leave the rest of the template as it is. */
export function stripFees(blocks: Block[], spec: DocSpec): Block[] {
  let out = [...blocks];
  // 1. a section whose heading says FEE(S)
  for (let i = 0; i < out.length; ) {
    const b = out[i]!;
    if (b.t === "h" && b.level >= 2 && FEE_WORD.test(b.text)) out = removeSection(out, i);
    else i++;
  }
  // 2. a paragraph that opens with a bold FEE heading: "**3.4 Service Fees**…"
  out = out.filter((b) => !(b.t === "p" && /^\*\*[^*]*\bfees?\b[^*]*\*\*/i.test(b.text)));
  // 3. the spec's agent-fee lines: table rows, sentences, list items
  const lines = spec.feeLines ?? [];
  if (lines.length) {
    const hit = (s: string) => lines.some((re) => re.test(s));
    out = out.flatMap((b): Block[] => {
      if (b.t === "table") return [{ ...b, rows: b.rows.filter((r) => !hit(r.join(" | "))) }];
      if (b.t === "ul" || b.t === "ol") {
        const items = b.items.filter((x) => !hit(x));
        return items.length ? [{ ...b, items }] : [];
      }
      if (b.t === "p") {
        const kept = b.text.split("\n").map((line) => line.split(SENTENCE_SPLIT).filter((sn) => !hit(sn)).join(" ")).filter(Boolean);
        return kept.length ? [{ t: "p", text: kept.join("\n") }] : [];
      }
      return [b];
    });
  }
  // 4. headings left with nothing under them
  out = out.filter((b, i) => !(b.t === "h" && b.level >= 2 && (out[i + 1] === undefined || out[i + 1]!.t === "hr" || (out[i + 1]!.t === "h" && (out[i + 1] as { level: number }).level <= b.level))));
  return out;
}

function feeText(f: FeeLine): string {
  return `${f.label}: ${fmtMoney(f.amount)}${f.per ? ` ${f.per}` : ""}${f.note ? ` — ${f.note}` : ""}`;
}

/** Fees ARE on the file: list them after the paragraph the spec names. */
function listFees(blocks: Block[], spec: DocSpec, ctx: DocCtx): Block[] {
  if (!spec.feesAfter || !ctx.fees.length) return blocks;
  const i = blocks.findIndex((b) => b.t === "p" && spec.feesAfter!.test(b.text));
  if (i < 0) throw drift(spec.key, `fee paragraph ${spec.feesAfter} not found`);
  return [
    ...blocks.slice(0, i + 1),
    { t: "p", text: "The fees that apply to this booking, as entered by your agent:" },
    { t: "ul", items: ctx.fees.map(feeText) },
    ...blocks.slice(i + 1),
  ];
}

/** Put the cruise line's own schedule, with calendar dates, where the template prints "typical" penalties. */
function applyCancellation(blocks: Block[], spec: DocSpec, ctx: DocCtx): Block[] {
  if (!spec.cancellationHeading) return blocks;
  const rows = cancellationRows(ctx.group);
  if (!rows.length) return blocks; // no schedule on the file: the template text stays unchanged
  const h = blocks.findIndex((b) => b.t === "h" && spec.cancellationHeading!.test(b.text));
  if (h < 0) throw drift(spec.key, `heading ${spec.cancellationHeading} not found`);
  const t = blocks.findIndex((b, i) => i > h && b.t === "table");
  if (t < 0) throw drift(spec.key, "no cancellation table under the heading");
  const table: Block = {
    t: "table",
    header: ["Days before sailing", "Dates", "Penalty"],
    rows: rows.map((r) => [r.days, r.dates || "—", r.penalty]),
  };
  const note = cancellationNote(ctx.group);
  const noteBlock: Block[] = note ? [{ t: "p", text: `*${note}*` }] : [];
  return [...blocks.slice(0, t), table, ...noteBlock, ...blocks.slice(t + 1)];
}

// ── 5. Rendering ──────────────────────────────────────────────────────────────

export interface RenderedDoc {
  key: string;
  title: string;
  /** "<key>@<capture date>": what a signature records as doc_version. */
  version: string;
  html: string;
  /** What the signer saw before typing anything. Hashed. */
  text: string;
  sha256: string;
  /** The inputs actually on this document, in page order. */
  fields: FieldSpec[];
  /** Blanks the group file could not fill (shown to Mark; never invented). */
  unfilled: string[];
  /** The edited blocks with tokens still in them (for fillBlocks / the signed PDF). */
  blocks: Block[];
}

export function docSource(key: string, lang: Lang): string {
  const src = CLIENT_DOCUMENTS[`${key}.${lang}`] ?? CLIENT_DOCUMENTS[key];
  if (!src) throw new Error(`unknown client document "${key}"`);
  return src;
}

export function blocksFor(key: string, ctx: DocCtx, opts: { paper?: boolean } = {}): { spec: DocSpec; blocks: Block[] } {
  const spec = DOC_SPECS[key];
  if (!spec) throw new Error(`unknown client document "${key}"`);
  // "No fees unless Mark hand-enters one": the fee agreements do not exist for a file with none.
  if (spec.requiresFees && !ctx.fees.length) throw new Error(`client document ${key} is only issued when the group file carries a fee`);
  let md = separateGluedHeadings(unescapeConnectorMarkdown(docSource(key, ctx.lang)));
  md = applyRules(md, spec, ctx);
  md = replacePlaceholders(md, ctx);
  let blocks = parseBlocks(md);
  // on the printed form (paper) the title and the template's signature lines stay
  if (!opts.paper) {
    blocks = dropTitle(blocks);
    blocks = dropSignature(key, blocks, spec.sigStart);
  }
  if (!ctx.fees.length) blocks = stripFees(blocks, spec);
  else blocks = listFees(blocks, spec, ctx);
  blocks = applyCancellation(blocks, spec, ctx);
  for (const edit of spec.edits ?? []) blocks = edit(blocks, ctx);
  blocks = collapseRules(blocks);
  return { spec, blocks };
}

function blockText(b: Block, mode: { answers?: Answers; today?: string }): string {
  const inline = (s: string) => tokensToText(stripInline(s), mode);
  switch (b.t) {
    case "h": return inline(b.text);
    case "hr": return "-----";
    case "p": return inline(b.text);
    case "ul": return b.items.map((x) => `- ${inline(x)}`).join("\n");
    case "ol": return b.items.map((x, i) => `${i + 1}. ${inline(x)}`).join("\n");
    case "table": return [b.header, ...b.rows].map((r) => r.map(inline).join(" | ")).join("\n");
  }
}

export function blocksToText(blocks: Block[], mode: { answers?: Answers; today?: string } = {}): string {
  return blocks.map((b) => blockText(b, mode)).filter((t) => t.trim() !== "").join("\n\n");
}

function blocksToHtml(blocks: Block[], env: Env): string {
  const inl = (s: string) => inlineHtml(s, env);
  return blocks.map((b) => {
    switch (b.t) {
      case "h": return `<h${Math.min(b.level + 1, 4)} class="doc-h">${inl(b.text)}</h${Math.min(b.level + 1, 4)}>`;
      case "hr": return "<hr>";
      case "p": return `<p>${inl(b.text)}</p>`;
      case "ul": return `<ul>${b.items.map((x) => `<li>${inl(x)}</li>`).join("")}</ul>`;
      case "ol": return `<ol>${b.items.map((x) => `<li>${inl(x)}</li>`).join("")}</ol>`;
      case "table": {
        const head = b.header.some((c) => c !== "") ? `<thead><tr>${b.header.map((c) => `<th>${inl(c)}</th>`).join("")}</tr></thead>` : "";
        return `<div class="doc-table"><table>${head}<tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inl(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      }
    }
  }).join("\n");
}

/** Markdown (as the connector wrote it, or already clean) → the page html. Tokens like {{in:name}} become the
 * inputs of the fields named in `fields`; a plain ____ stays a printed blank. */
export function markdownToHtml(md: string, opts: { fields?: FieldSpec[]; now?: Date } = {}): string {
  const env: Env = { fields: new Map((opts.fields ?? []).map((f) => [f.name, f])), ctx: { now: opts.now ?? new Date() } as DocCtx };
  return blocksToHtml(parseBlocks(separateGluedHeadings(unescapeConnectorMarkdown(md))), env);
}

const TOKEN_NAMES = /\{\{(?:in|ta|ck|ch):([a-z0-9_]+)/g;

function tokenFields(blocks: Block[], spec: DocSpec): FieldSpec[] {
  const raw = JSON.stringify(blocks);
  const seen = new Set<string>();
  for (const m of raw.matchAll(TOKEN_NAMES)) seen.add(m[1]!);
  return spec.fields.filter((f) => seen.has(f.name));
}

export function renderDocument(key: string, ctx: DocCtx): RenderedDoc {
  const { spec, blocks } = blocksFor(key, ctx);
  const fields = tokenFields(blocks, spec);
  const html = blocksToHtml(blocks, { fields: new Map(spec.fields.map((f) => [f.name, f])), ctx });
  const text = blocksToText(blocks);
  const unfilled = [...new Set([...JSON.stringify(blocks).matchAll(/\{\{bl:([^}]+)\}\}/g)].map((m) => m[1]!))];
  return { key, title: spec.title, version: `${key}@${TEMPLATE_VERSION_DATE}`, html, text, sha256: sha256Hex(text), fields, unfilled, blocks };
}

/** The document with what the signer entered merged in (for the signed PDF and the stored copy). */
export function fillBlocks(doc: Pick<RenderedDoc, "blocks">, answers: Answers, signedOn: Date): Block[] {
  const mode = { answers, today: fmtLong(signedOn.toISOString()) };
  const fill = (s: string) => tokensToText(s, mode).replace(/\{\{[^}]*\}\}/g, "");
  return doc.blocks.flatMap((b): Block[] => {
    switch (b.t) {
      case "h": return [{ ...b, text: fill(b.text) }];
      case "hr": return [b];
      case "p": { const text = fill(b.text); return text.trim() ? [{ t: "p", text }] : []; }
      case "ul": case "ol": return [{ ...b, items: b.items.map(fill) }];
      case "table": return [{ t: "table", header: b.header.map(fill), rows: b.rows.map((r) => r.map(fill)) }];
    }
  });
}

// ── 6. Who signs what ─────────────────────────────────────────────────────────

export const TRAVELER_PACKET = [
  "15-emergency-contact-form", // first: the information page's answers (address, phone, passport) fill the documents after it
  "01-terms-and-conditions",
  "07-travel-insurance-declination", // after the insurance video and the quote (Mark 2026-10-30); the waiver's insurance line follows it
  "05-liability-waiver",
  "16-passport-document-checklist",
] as const;
export const FEE_DOCUMENTS = ["02-travel-planning-agreement", "03-service-fee-planning-fee-agreement"] as const;
/** The cabin's lead, who pays, also signs the booking agreement and the card authorization (Mark 2026-10-29: "a credit card
 *  authorization … every time"). */
export const LEAD_DOCUMENTS = ["12-cruise-booking-agreement", "22-card-authorization"] as const;
export const LEAD_DOCUMENT = LEAD_DOCUMENTS[1];
export const ORGANIZER_DOCUMENT = "09-group-travel-contract";

/** The ordered document keys one signer is asked for. Mark 2026-10-30: the package is the six Cornerstone documents that
 *  are live today plus the card authorization, every one filled from the one information page, shown for confirmation and
 *  signature, and listed in the copies email. Not in any packet: 04 (cancellation policy), 06 (Cornerstone's own card form:
 *  22 is that form with the last four, the expiry and the licence), 13 and 14 (questionnaires), 20 and 21 (the two-document
 *  packet of 10/29, kept so copies signed under it still render). */
export function packetFor(input: { group: Row; cabin?: Row | null; traveler?: Row | null; organizer?: boolean }): string[] {
  if (input.organizer) return [ORGANIZER_DOCUMENT];
  const hasFees = normalizeFees(input.group?.fees).length > 0;
  const keys: string[] = [...TRAVELER_PACKET];
  if (hasFees) keys.splice(2, 0, ...FEE_DOCUMENTS); // after the terms
  if (input.traveler?.is_lead && input.cabin) keys.push(...LEAD_DOCUMENTS);
  return keys;
}

// ── 7. Answers ────────────────────────────────────────────────────────────────

export interface AppliedAnswers {
  ok: true;
  /** What is stored on the signature: exactly what was entered, with the passport number masked. */
  answers: Answers;
  travelerPatch: Row;
  formData: Row;
  /** The number is returned ONLY so the caller can encrypt it; it is never part of `answers`. */
  passport?: { number: string; last4: string };
  /** The driver's licence number (the card authorization, Mark 2026-10-30): returned only to be encrypted, never in `answers`. */
  license?: { number: string; last4: string };
}
export interface RejectedAnswers { ok: false; errors: Record<string, string> }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "Fuquay Varina, NC 27526" → its three parts; null when it is not in that shape. */
export function splitCityStateZip(s: string): { city: string; state: string; zip: string } | null {
  const m = /^(.+?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(s.replace(/\s+/g, " ").trim());
  return m ? { city: m[1]!.trim(), state: m[2]!, zip: m[3]! } : null;
}

function setPath(target: Row, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (const p of parts.slice(0, -1)) {
    if (typeof node[p] !== "object" || node[p] === null) node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]!] = value;
}

export function getPath(source: Row | null | undefined, path: string): unknown {
  let node: unknown = source;
  for (const p of path.split(".")) {
    if (node && typeof node === "object") node = (node as Row)[p]; else return undefined;
  }
  return node;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || v === false;

/** Check what the signer entered against the document's fields and work out where each answer is kept.
 *  Unknown answer names are dropped. Card numbers are refused in every text answer. */
export function applyAnswers(doc: { key: string; fields: FieldSpec[] }, raw: unknown, ctx: DocCtx): AppliedAnswers | RejectedAnswers {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const spec = DOC_SPECS[doc.key];
  const errors: Record<string, string> = {};
  let clean: Answers = {};
  const today = ctx.now.toISOString().slice(0, 10);

  for (const f of doc.fields) {
    const v = input[f.name];
    const max = f.maxLength ?? (f.kind === "textarea" ? 1000 : 200);
    switch (f.kind) {
      case "text": case "textarea": case "tel": case "email": case "date": case "passport": case "license": {
        if (v === undefined || v === null) break;
        if (typeof v !== "string") { errors[f.name] = "Please check this answer."; break; }
        const s = f.kind === "textarea" ? v.replace(/\r/g, "").trim() : v.replace(/\s+/g, " ").trim();
        if (!s) break;
        if (s.length > max) { errors[f.name] = `Please keep this under ${max} characters.`; break; }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) { errors[f.name] = "Please check this answer."; break; }
        if (f.kind !== "passport" && looksLikeCardNumber(s)) { errors[f.name] = "Card numbers are never collected here. Please remove it."; break; }
        if (f.kind === "email" && !EMAIL.test(s)) { errors[f.name] = "Please check the email address."; break; }
        if (f.kind === "tel" && !(s.replace(/\D/g, "").length >= 7 && s.replace(/\D/g, "").length <= 15 && /^[0-9+()\-.\s xX#]+$/.test(s))) { errors[f.name] = "Please check the phone number."; break; }
        if (f.kind === "passport" && !passportLooksValid(s)) { errors[f.name] = "A passport number is 6 to 9 letters and digits."; break; }
        if (f.kind === "license" && !/^[A-Z0-9-]{4,20}$/.test(normalizePassport(s))) { errors[f.name] = "A driver's licence number is 4 to 20 letters and digits."; break; }
        if (f.kind === "date") {
          if (!validDate(s)) { errors[f.name] = "Please enter a real date."; break; }
          const year = Number(s.slice(0, 4));
          if (f.date === "dob" && (s > today || year < Number(today.slice(0, 4)) - 125)) { errors[f.name] = "Please check the date of birth."; break; }
          if (f.date === "past" && s > today) { errors[f.name] = "That date should be in the past."; break; }
          if (f.date === "future" && s <= today) { errors[f.name] = "That date has already passed."; break; }
        }
        clean[f.name] = f.kind === "passport" || f.kind === "license" ? normalizePassport(s) : s;
        break;
      }
      case "choice": {
        if (v === undefined || v === null || v === "") break;
        if (typeof v !== "string" || !f.options?.some((o) => o.value === v)) { errors[f.name] = "Please choose one of the options."; break; }
        clean[f.name] = v;
        break;
      }
      case "multi": {
        if (v === undefined || v === null) break;
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !f.options?.some((o) => o.value === x))) { errors[f.name] = "Please choose from the options."; break; }
        if (v.length) clean[f.name] = [...new Set(v as string[])];
        break;
      }
      case "check": {
        if (v === undefined || v === null) break;
        if (typeof v !== "boolean") { errors[f.name] = "Please check this answer."; break; }
        if (v) clean[f.name] = true;
        break;
      }
    }
  }
  if (spec?.complete) clean = spec.complete(clean, ctx);
  for (const f of doc.fields) {
    const required = typeof f.required === "function" ? f.required(clean) : f.required === true;
    if (required && isEmpty(clean[f.name]) && !errors[f.name]) errors[f.name] = f.kind === "check" ? "Please tick this box." : "Please fill this in.";
  }
  if (spec?.validate) Object.assign(errors, Object.fromEntries(Object.entries(spec.validate(clean)).filter(([k]) => !errors[k])));
  if (Object.keys(errors).length) return { ok: false, errors };

  const travelerPatch: Row = {};
  const formData: Row = {};
  let passport: AppliedAnswers["passport"];
  let license: AppliedAnswers["license"];
  const stored: Answers = { ...clean };
  for (const f of doc.fields) {
    const v = clean[f.name];
    if (isEmpty(v)) continue;
    if (f.kind === "passport") {
      const number = String(v);
      passport = { number, last4: last4(number) };
      stored[f.name] = `ending ${passport.last4}`; // the number itself is never stored in answers
      travelerPatch["passport_last4"] = passport.last4;
      continue;
    }
    if (f.kind === "license") {
      const number = String(v);
      license = { number, last4: last4(number) };
      stored[f.name] = `ending ${license.last4}`; // the number itself is never stored in answers
      travelerPatch["dl_last4"] = license.last4;
      continue;
    }
    const shown = f.kind === "choice" ? f.options?.find((o) => o.value === v)?.label ?? v : v; // a column holds the words ("Female"), not the code
    if (f.col) travelerPatch[f.col] = shown;
    if (f.form) setPath(formData, f.form, v);
    // Mark 2026-10-27: city, state and ZIP are typed in three boxes and kept apart too, so the file can sort and search by each
    if (f.form && /city_state_zip$/.test(f.name) && typeof v === "string") { const parts = splitCityStateZip(v); if (parts) setPath(formData, `${f.form}_parts`, parts); }
  }
  if (spec?.derive) Object.assign(travelerPatch, spec.derive(clean, ctx));
  return { ok: true, answers: stored, travelerPatch, formData, ...(passport ? { passport } : {}), ...(license ? { license } : {}) };
}

/** What the page puts in each input before the signer types: the file's own value (never a passport number). */
export function prefillValue(f: FieldSpec, ctx: DocCtx): string | string[] | boolean | undefined {
  if (f.kind === "passport" || f.kind === "license") return undefined;
  const fromCol = f.col ? ctx.traveler?.[f.col] : undefined;
  const fromForm = f.form ? getPath(ctx.traveler?.form_data, f.form) : undefined;
  const v = !isEmpty(fromForm) ? fromForm : fromCol;
  if (!isEmpty(v)) {
    if (f.kind === "date" || f.kind === "text" || f.kind === "tel" || f.kind === "email" || f.kind === "textarea") return String(v).slice(0, f.kind === "date" ? 10 : 400);
    if (f.kind === "choice" && typeof v === "string") return v;
    if (f.kind === "multi" && Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    if (f.kind === "check" && typeof v === "boolean") return v;
  }
  return f.prefill?.(ctx);
}

/** The field as the page needs it: no functions, nothing secret. */
export function publicField(f: FieldSpec, ctx: DocCtx): Record<string, unknown> {
  return {
    // "shown": required once the page shows it (a follow-up line under the choice that calls for it)
    name: f.name, label: f.label, kind: f.kind, required: f.required === true ? true : typeof f.required === "function" ? "shown" : false,
    ...(f.options ? { options: f.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
    ...(f.maxLength ? { maxLength: f.maxLength } : {}),
    ...(f.onDocument ? { on_document: f.onDocument } : {}),
    value: prefillValue(f, ctx) ?? null,
  };
}
