// group-package.ts — the rendered pieces of a group's marketing package: a poster (print PDF +
// screen PNG) and the two Facebook image sizes, drawn from the group file's facts, Mark's approved
// copy and the chosen photographs. Layout is decided by posterSpec() (pure, tested); sharp draws it.
import sharp, { type OverlayOptions } from "sharp";
const NAVY = "#07183f", GOLD = "#f5c33b", WHITE = "#ffffff", SAND = "#f6efe3";
const FONT = "DejaVu Sans, Helvetica Neue, Helvetica, Arial, sans-serif";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { wrap, type PosterSpec } from "./group-package-spec";
import { BUSINESS } from "./group-secure";
export { MARK_PHONE, posterSpec, wrap, pickPhotos, type PosterSpec, type Line } from "./group-package-spec";

async function cover(src: Buffer, w: number, h: number): Promise<Buffer> {
  return sharp(src).rotate().resize(w, h, { fit: "cover", position: "attention" }).jpeg({ quality: 88 }).toBuffer();
}

function tspans(lines: string[], x: number, y0: number, lh: number, size: number, weight: number, color: string, anchor = "start"): string {
  return lines.map((l, i) => `<text x="${x}" y="${y0 + i * lh}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(l)}</text>`).join("");
}

/** Letter at 300 dpi: 2550 × 3300. Photo on top, headline over it, facts below, CTA band with QR. */
export async function renderPoster(spec: PosterSpec, photo: Buffer, photo2: Buffer | null): Promise<Buffer> {
  const W = 2550, H = 3300, PH = 1750;
  const hero = await cover(photo, W, PH);
  const qr = await QRCode.toBuffer(`https://${spec.url}`, { width: 520, margin: 1, color: { dark: NAVY, light: WHITE } });
  const hlSize = spec.headline.length > 2 ? 118 : 136, hlLh = hlSize * 1.12;
  const hlTop = PH - 120 - (spec.headline.length - 1) * hlLh - 110;
  // The facts column sits left of the second photo (1000 px wide at the right edge), so it wraps narrow.
  const colChars = photo2 ? 34 : 54;
  const factsLines = spec.facts.flatMap((t) => wrap(t, colChars)).slice(0, 10);
  const travelLines = spec.travel.flatMap((t) => wrap(t, colChars)).slice(0, 4);
  const side = photo2 ? await cover(photo2, 1000, 700) : null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="${NAVY}" stop-opacity="0"/><stop offset="1" stop-color="${NAVY}" stop-opacity="0.92"/></linearGradient></defs>
    <rect x="0" y="0" width="${W}" height="${PH}" fill="url(#g)"/>
    <rect x="0" y="${PH}" width="${W}" height="${H - PH}" fill="${SAND}"/>
    <text x="120" y="${hlTop - 40}" font-family="${FONT}" font-size="54" font-weight="700" fill="${GOLD}" letter-spacing="6">${esc(spec.dates.toUpperCase())}</text>
    ${tspans(spec.headline, 120, hlTop + hlSize, hlLh, hlSize, 700, WHITE)}
    ${tspans(factsLines, 120, PH + 190, 92, 66, 400, NAVY)}
    ${travelLines.length ? `<text x="120" y="${PH + 190 + factsLines.length * 92 + 60}" font-family="${FONT}" font-size="48" font-weight="700" fill="${NAVY}">${esc(spec.travel.length && spec.cta.startsWith("Llame") ? "CÓMO LLEGAR" : "GETTING THERE")}</text>${tspans(travelLines, 120, PH + 190 + factsLines.length * 92 + 140, 70, 50, 400, NAVY)}` : ""}
    <rect x="0" y="${H - 560}" width="${W}" height="560" fill="${NAVY}"/>
    <text x="120" y="${H - 330}" font-family="${FONT}" font-size="78" font-weight="700" fill="${WHITE}">${esc(spec.cta)}</text>
    <text x="120" y="${H - 215}" font-family="${FONT}" font-size="64" font-weight="700" fill="${GOLD}">${esc(spec.cta.startsWith("Escanee") ? "o llame o escriba al" : "or call or text")} ${esc(spec.phone)}</text>
    <text x="120" y="${H - 120}" font-family="${FONT}" font-size="48" fill="${WHITE}">${esc(spec.url)}</text>
    <text x="120" y="${H - 62}" font-family="${FONT}" font-size="26" fill="${WHITE}" opacity="0.85">${esc(spec.footer)}</text>
    <text x="120" y="${H - 24}" font-family="${FONT}" font-size="22" fill="${WHITE}" opacity="0.7">${esc(spec.credit)}</text>
  </svg>`;
  // Order matters: the SVG paints the sand panel, so the second photo and the QR go on AFTER it.
  const layers: OverlayOptions[] = [{ input: hero, top: 0, left: 0 }, { input: Buffer.from(svg), top: 0, left: 0 }];
  if (side) layers.push({ input: side, top: PH + 150, left: W - 1000 - 120 });
  layers.push({ input: qr, top: H - 540, left: W - 520 - 120 });
  return sharp({ create: { width: W, height: H, channels: 3, background: SAND } }).composite(layers).png({ compressionLevel: 8 }).toBuffer();
}

/** The poster PNG on a Letter page. */
export async function posterPdf(png: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 0, info: { Title: "Group cruise poster", Author: BUSINESS.tradeName } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.image(png, 0, 0, { width: 612, height: 792 });
    doc.end();
  });
}

/** Facebook link image 1200×628 and square 1080×1080: photo, headline, dates, from-price, CTA strip. */
export async function renderSocial(spec: PosterSpec, photo: Buffer, size: "landscape" | "square"): Promise<Buffer> {
  const W = size === "landscape" ? 1200 : 1080, H = size === "landscape" ? 628 : 1080;
  const hero = await cover(photo, W, H);
  const hl = wrap(spec.headline.join(" "), size === "landscape" ? 30 : 24);
  const hlSize = size === "landscape" ? 58 : 66, lh = hlSize * 1.12;
  const band = size === "landscape" ? 110 : 150;
  const top = H - band - 40 - hl.length * lh - 70;
  const price = spec.facts.find((f) => /^(From|Desde) /.test(f)) ?? "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0.15" stop-color="${NAVY}" stop-opacity="0"/><stop offset="0.55" stop-color="${NAVY}" stop-opacity="0.75"/><stop offset="1" stop-color="${NAVY}" stop-opacity="0.97"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <text x="48" y="${top}" font-family="${FONT}" font-size="26" font-weight="700" fill="${GOLD}" letter-spacing="3">${esc(spec.dates.toUpperCase())}</text>
    ${tspans(hl, 48, top + hlSize + 10, lh, hlSize, 700, WHITE)}
    ${price ? `<text x="48" y="${H - band - 24}" font-family="${FONT}" font-size="34" fill="${WHITE}">${esc(price)}</text>` : ""}
    <rect x="0" y="${H - band}" width="${W}" height="${band}" fill="${NAVY}"/>
    <text x="48" y="${H - band / 2 + 14}" font-family="${FONT}" font-size="${size === "landscape" ? 34 : 40}" font-weight="700" fill="${WHITE}">${esc(spec.cta.startsWith("Escanee") ? "Abra el enlace para unirse a la diversión" : "Open the link to join the fun")} <tspan fill="${GOLD}" font-size="${size === "landscape" ? 26 : 30}">· ${esc(spec.phone)}</tspan></text>
    <text x="${W - 36}" y="${H - 14}" font-family="${FONT}" font-size="16" fill="${WHITE}" opacity="0.7" text-anchor="end">${esc(spec.credit)}</text>
  </svg>`;
  return sharp(hero).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 90 }).toBuffer();
}

