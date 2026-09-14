// storm-email-content.ts — the subscriber-facing storm emails, as pure HTML.
//
// Mark, 2026-09-14: "add the list of potential affected ships to the storm
// emails and a CTA to go to the ship tracker and a CTA to the storm warnings."
// The alert email and the all-clear both carry: the ships pinned to the storm
// (grouped by line, each linked to her tracker page), a button to Where's My
// Ship and a button to the storm-watch page. Spanish subscribers get the
// Spanish pages and labels. Nothing here does I/O; storm-send.ts loads and sends.

export type EmailLang = "en" | "es";
export interface AffectedShip { ship_name: string; cruise_line: string | null }

/** Anything that starts with "es" is a Spanish subscriber; everything else reads English. */
export function emailLang(raw: string | null | undefined): EmailLang {
  return String(raw ?? "").trim().toLowerCase().startsWith("es") ? "es" : "en";
}

const T = {
  en: {
    ships: "Ships that may be affected",
    shipsNote: "Sailings whose route and dates overlap this storm's forecast. A listed ship is one to watch, not one that has changed course.",
    more: (n: number) => `and ${n} more`,
    track: "Track your ship",
    warnings: "See all storm warnings",
    trackerPath: "/wheres-my-ship.html",
    warningsPath: "/storm-watch.html",
  },
  es: {
    ships: "Barcos que podrían verse afectados",
    shipsNote: "Salidas cuya ruta y fechas coinciden con el pronóstico de esta tormenta. Un barco en la lista es uno a vigilar, no uno que ya cambió de rumbo.",
    more: (n: number) => `y ${n} más`,
    track: "Rastrea tu barco",
    warnings: "Ver todas las alertas de tormenta",
    trackerPath: "/es/wheres-my-ship.html",
    warningsPath: "/es/storm-watch.html",
  },
} as const;

/** More than this and the list is a wall; the tracker has the rest. */
export const SHIP_LIST_MAX = 40;

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function trackerUrl(base: string, lang: EmailLang, shipName?: string): string {
  const path = `${base}${T[lang].trackerPath}`;
  return shipName ? `${path}?ship=${encodeURIComponent(shipName)}` : path;
}
export function warningsUrl(base: string, lang: EmailLang): string {
  return `${base}${T[lang].warningsPath}`;
}

/** The pinned ships, grouped by line, each linked to her own tracker page. Empty list → "". */
export function affectedShipsHtml(ships: readonly AffectedShip[], lang: EmailLang, base: string): string {
  const seen = new Set<string>();
  const clean = ships.filter((s) => {
    const k = s.ship_name.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!clean.length) return "";
  const t = T[lang];
  const shown = clean.slice(0, SHIP_LIST_MAX);
  const byLine = new Map<string, AffectedShip[]>();
  for (const s of shown) {
    const line = (s.cruise_line || "").trim() || (lang === "es" ? "Otras navieras" : "Other lines");
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line)!.push(s);
  }
  const rows = [...byLine.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([line, list]) => {
      const names = list
        .sort((a, b) => a.ship_name.localeCompare(b.ship_name))
        .map((s) => `<a href="${esc(trackerUrl(base, lang, s.ship_name))}" style="color:#0d5c8f;text-decoration:none">${esc(s.ship_name)}</a>`)
        .join(", ");
      return `<li style="margin:0 0 6px"><strong>${esc(line)}</strong>: ${names}</li>`;
    })
    .join("\n");
  const more = clean.length > shown.length
    ? `<p style="margin:6px 0 0;color:#5a6b7a;font-size:13px">${esc(t.more(clean.length - shown.length))}</p>`
    : "";
  return `
        <div style="margin:18px 0 6px;padding:14px 16px;background:#f2f7fb;border-radius:10px">
          <h3 style="margin:0 0 4px;color:#0d2a4a;font-size:16px">${esc(t.ships)}</h3>
          <p style="margin:0 0 10px;color:#5a6b7a;font-size:13px;line-height:1.5">${esc(t.shipsNote)}</p>
          <ul style="margin:0;padding-left:18px;line-height:1.6">
${rows}
          </ul>${more}
        </div>`;
}

/** Two buttons: the tracker and the storm-watch page, in the subscriber's language. */
export function ctaRowHtml(lang: EmailLang, base: string): string {
  const t = T[lang];
  const btn = (href: string, label: string, bg: string) =>
    `<a href="${esc(href)}" style="display:inline-block;margin:0 10px 10px 0;padding:12px 20px;border-radius:10px;background:${bg};color:#ffffff;font-weight:700;text-decoration:none;font-size:15px">${esc(label)}</a>`;
  return `
        <div style="margin:18px 0 4px">
          ${btn(trackerUrl(base, lang), t.track, "#0d5c8f")}
          ${btn(warningsUrl(base, lang), t.warnings, "#1f4e79")}
        </div>`;
}

export interface StormEmailInput {
  headline: string;
  name: string;
  groundsLabel: string;
  bodyHtml: string;      // already rendered from markdown
  ships: readonly AffectedShip[];
  unsubscribeUrl: string;
  base: string;
  lang: EmailLang;
}

const FOOT = {
  en: (unsub: string) => `You're getting this because you opted into Still Afloat cruise alerts. <a href="${esc(unsub)}" style="color:#98a4b0">Unsubscribe</a>.`,
  es: (unsub: string) => `Recibes esto porque te suscribiste a las alertas de cruceros de Still Afloat. <a href="${esc(unsub)}" style="color:#98a4b0">Cancelar suscripción</a>.`,
};
const KICKER = {
  en: { alert: "Still Afloat · Cruise Weather Alert", clear: "Still Afloat · Cruise Weather All-Clear" },
  es: { alert: "Still Afloat · Alerta meteorológica de cruceros", clear: "Still Afloat · Fin de alerta meteorológica" },
};

export function stormAlertEmailHtml(i: StormEmailInput): string {
  return `
      <div style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2330">
        <h2 style="color:#0d2a4a;margin:0 0 6px">${esc(i.headline || i.name)}</h2>
        <p style="color:#5a6b7a;margin:0 0 16px;font-size:13px">${KICKER[i.lang].alert} · ${esc(i.groundsLabel)}</p>
        ${i.bodyHtml}${affectedShipsHtml(i.ships, i.lang, i.base)}${ctaRowHtml(i.lang, i.base)}
        <hr style="border:none;border-top:1px solid #e3e8ee;margin:20px 0">
        <p style="color:#98a4b0;font-size:12px">${FOOT[i.lang](i.unsubscribeUrl)}</p>
      </div>`;
}

export function allClearEmailHtml(i: StormEmailInput): string {
  return `
      <div style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2330">
        <h2 style="color:#166534;margin:0 0 6px">🟢 ${esc(i.headline || i.name)}</h2>
        <p style="color:#5a6b7a;margin:0 0 16px;font-size:13px">${KICKER[i.lang].clear} · ${esc(i.groundsLabel)}</p>
        ${i.bodyHtml}${affectedShipsHtml(i.ships, i.lang, i.base)}${ctaRowHtml(i.lang, i.base)}
        <hr style="border:none;border-top:1px solid #e3e8ee;margin:20px 0">
        <p style="color:#98a4b0;font-size:12px">${FOOT[i.lang](i.unsubscribeUrl)}</p>
      </div>`;
}
