// ship-watch.ts — what a ship watch needs wherever one is started: the 15-day window, the
// signed stop and restart links, the emails, and which way a sign-up goes for a subscriber.
//
// Watches were only ever started from the tracker page's form, for one sailing's dates, by
// a confirmed subscriber. The storm pages' "Track this ship" buttons start a different kind.
// Mark, 2026-09-15: "the CTA is still too deep ... it should be a direct link to sign up to
// the tracker with subscription", then: "A storm tracker is only good for the duration of
// the storm. I think we can remove the start and end dates, but need to give the user an
// option in the email to stop tracking, maybe set a 15 day cap then restart. that should
// help keep down the API calls as well". So a storm-page watch has no dates to enter: it runs
// for 15 days from the day it starts, every email about it carries a stop link, and when it
// ends the subscriber is asked whether to keep tracking for another 15. Someone who is not a
// subscriber yet can start one: it waits as 'pending' and starts when they confirm their email.

import { signLink, verifyLink } from "./link-signing";

/** How long a watch from the storm pages runs before it asks to be restarted. */
export const WATCH_WINDOW_DAYS = 15;
const DAY_MS = 86_400_000;

export interface WatchWindow {
  start: string; // YYYY-MM-DD, the first day watched
  end: string; // YYYY-MM-DD, the last day watched
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** `days` calendar days counting today: a 15-day watch started 2026-09-15 runs through 2026-09-29. */
export function rollingWindow(today: string, days: number = WATCH_WINDOW_DAYS): WatchWindow {
  return { start: today, end: addDays(today, days - 1) };
}

/** "September 29" in English, "29 de septiembre" in Spanish. */
export function formatWatchDate(isoDate: string, lang: string | null | undefined): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(lang === "es" ? "es-ES" : "en-US", {
    month: "long", day: "numeric", timeZone: "UTC",
  });
}

export type SubscriberStatus = "pending" | "confirmed" | "bounced" | "unsubscribed" | "archived";

/**
 * watch_now: a confirmed subscriber, so the watch starts at once.
 * confirm_first: new, not yet confirmed, or coming back after unsubscribing; the watch
 *   waits and the confirmation email switches it on.
 * unreachable: the address bounced, so no email could ever reach them.
 */
export type SignupPath = "watch_now" | "confirm_first" | "unreachable";

export function signupPath(status: string | null | undefined): SignupPath {
  if (status === "confirmed") return "watch_now";
  if (status === "bounced") return "unreachable";
  return "confirm_first";
}

/**
 * Signed links in watch emails (lib/link-signing.ts). A restart link signs a different message,
 * so a stop link can never be turned into a restart.
 */
export function makeWatchSig(watchId: string, action: "stop" | "restart" = "stop"): string {
  return signLink(action === "stop" ? "watch-stop" : "watch-restart", watchId);
}

export function verifyWatchSig(watchId: string, action: "stop" | "restart", sig: unknown): boolean {
  return verifyLink(action === "stop" ? "watch-stop" : "watch-restart", watchId, sig);
}

/** One click stops the watch (GET /api/wms/watch/stop). */
export function watchStopUrl(watchId: string): string {
  return `https://stillafloatcruising.com/api/wms/watch/stop?id=${watchId}&sig=${makeWatchSig(watchId)}`;
}

/**
 * "Keep tracking" opens the sign-up page with a button, instead of restarting on a plain
 * visit: some mail systems open every link in an email to scan it, and a restart that ran on
 * its own would keep a watch going for good. A stop that runs on its own only ends one early.
 */
export function watchRestartUrl(watchId: string, shipName: string, lang: string | null | undefined): string {
  return `https://stillafloatcruising.com/${lang === "es" ? "es/" : ""}track-ship.html?ship=${encodeURIComponent(shipName)}` +
    `&restart=${watchId}&sig=${makeWatchSig(watchId, "restart")}`;
}

/**
 * The email that says a watch is on. Sailing watches from the tracker page get the email
 * they always have, byte for byte. A 15-day watch (windowDays set, sailingEnd = its last day)
 * says how long it runs, that we'll ask before it ends, and how to stop it sooner.
 */
export function trackingEmail(args: {
  shipName: string;
  sailingStart: string;
  sailingEnd: string;
  subscriberName: string;
  lang: string;
  stopUrl: string;
  windowDays?: number | null;
}): { subject: string; html: string } {
  const { shipName, sailingStart, sailingEnd, stopUrl } = args;
  const es = args.lang === "es";
  const firstName = args.subscriberName.split(" ")[0] || args.subscriberName;
  const days = args.windowDays ?? null;
  const until = days ? formatWatchDate(sailingEnd, args.lang) : "";
  const allSet = days
    ? (es
        ? `Listo — estamos vigilando a <strong>${shipName}</strong> por ti durante los próximos ${days} días, hasta el ${until}. Te avisaremos por correo si cambia el itinerario, si hay clima severo en la ruta, o si tu línea de cruceros publica noticias que te afecten.`
        : `You're all set — we're watching <strong>${shipName}</strong> for you for the next ${days} days, through ${until}. We'll email you if the itinerary changes, if severe weather threatens the route, or if your cruise line makes news that matters to your sailing.`)
    : (es
        ? `Listo — estás siguiendo a <strong>${shipName}</strong> del ${sailingStart} al ${sailingEnd}. Te avisaremos por correo si cambia el itinerario, si hay clima severo en la ruta, o si tu línea de cruceros publica noticias que te afecten.`
        : `You're all set — we're watching <strong>${shipName}</strong> for you from ${sailingStart} to ${sailingEnd}. We'll email you if the itinerary changes, if severe weather threatens the route, or if your cruise line makes news that matters to your sailing.`);
  const howLong = days
    ? `
      <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">
        ${es
          ? `Cuando pasen los ${days} días te escribiremos, y podrás seguirlo otros ${days} días. ¿Terminaste antes? <a href="${stopUrl}" style="color:#0077b6;font-weight:700;">Deja de seguir a ${shipName}</a>. Cada correo de vigilancia trae este enlace.`
          : `When the ${days} days are up, we'll email you, and you can keep tracking for another ${days} days. Done sooner? <a href="${stopUrl}" style="color:#0077b6;font-weight:700;">Stop tracking ${shipName}</a>. Every ship watch email has this link.`}
      </p>`
    : "";
  const stopLabel = days
    ? (es ? "Dejar de seguir este barco" : "Stop tracking this ship")
    : (es ? "Dejar de seguir este crucero" : "Stop tracking this sailing");
  return {
    subject: es
      ? `Estás siguiendo a ${shipName} — Still Afloat`
      : `You're tracking ${shipName} — Still Afloat`,
    html: `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;padding:0;margin:0;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
    <div style="background:linear-gradient(135deg,#07183f,#0077b6);padding:28px 32px;text-align:center;">
      <p style="margin:0 0 8px;color:rgba(255,255,255,.7);font-size:13px;letter-spacing:.08em;text-transform:uppercase;">${es ? "Vigilancia de barco" : "Ship Watch"}</p>
      <h1 style="margin:0;color:#5dff9a;font-size:24px;font-weight:900;">${shipName}</h1>
    </div>
    <div style="padding:28px 32px;">
      <p style="color:#1e3a5f;font-size:16px;margin:0 0 16px;">${es ? `Hola ${firstName},` : `Hey ${firstName},`}</p>
      <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">
        ${allSet}
      </p>${howLong}
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 24px;">
        ${es
          ? "Este servicio es gratuito para suscriptores durante nuestro periodo de lanzamiento."
          : "This service is free for subscribers during our launch period."}
      </p>
      <div style="text-align:center;">
        <a href="https://stillafloatcruising.com/${es ? "es/" : ""}wheres-my-ship.html" style="display:inline-block;background:linear-gradient(135deg,#0077b6,#07183f);color:#5dff9a;font-weight:800;font-size:15px;padding:14px 30px;border-radius:12px;text-decoration:none;">${es ? "Ver el barco en vivo →" : "See the ship live →"}</a>
      </div>
    </div>
    <div style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
      <p style="margin:0;color:#9ca3af;font-size:12px;">Still Afloat · <em>${es ? "Navega más inteligente. Ríe más." : "Cruise smarter. Laugh more. Stay Afloat."}</em><br>
      <a href="${stopUrl}" style="color:#9ca3af;font-size:11px;">${stopLabel}</a></p>
    </div>
  </div>
</body></html>`,
  };
}

/** The email a 15-day watch sends on its way out, offering another 15 days. */
export function watchEndedEmail(args: {
  shipName: string;
  subscriberName: string;
  lang: string;
  windowDays: number;
  restartUrl: string;
}): { subject: string; html: string } {
  const { shipName, windowDays: days, restartUrl } = args;
  const es = args.lang === "es";
  const firstName = args.subscriberName.split(" ")[0] || args.subscriberName;
  const T = es
    ? {
        subject: `Terminó tu vigilancia de ${shipName} — Still Afloat`,
        hi: `Hola ${firstName},`,
        ended: `Vigilamos a <strong>${shipName}</strong> por ti durante ${days} días. Esa vigilancia ya terminó, así que no te enviaremos más novedades sobre este barco.`,
        offer: `¿Quieres seguir enterándote si una tormenta, un cambio de itinerario o una noticia de la línea de cruceros afecta a este barco? Renueva la vigilancia y lo seguiremos otros ${days} días.`,
        button: `Seguirlo ${days} días más →`,
        done: "Si ya terminaste, no tienes que hacer nada. Tu boletín semanal de Still Afloat sigue llegando.",
        tag: "Navega más inteligente. Ríe más.",
      }
    : {
        subject: `Your ship watch on ${shipName} has ended — Still Afloat`,
        hi: `Hey ${firstName},`,
        ended: `We watched <strong>${shipName}</strong> for you for ${days} days. That watch has now ended, so we won't send more updates about her.`,
        offer: `Still want to hear if a storm, an itinerary change or cruise-line news affects her? Keep tracking and we'll watch her for another ${days} days.`,
        button: `Keep Tracking for ${days} More Days →`,
        done: "Nothing to do if you're done. Your weekly Still Afloat newsletter keeps coming.",
        tag: "Cruise smarter. Laugh more. Stay Afloat.",
      };
  return {
    subject: T.subject,
    html: `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;padding:0;margin:0;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
    <div style="background:linear-gradient(135deg,#07183f,#0077b6);padding:28px 32px;text-align:center;">
      <p style="margin:0 0 8px;color:rgba(255,255,255,.7);font-size:13px;letter-spacing:.08em;text-transform:uppercase;">${es ? "Vigilancia de barco" : "Ship Watch"}</p>
      <h1 style="margin:0;color:#5dff9a;font-size:24px;font-weight:900;">${shipName}</h1>
    </div>
    <div style="padding:28px 32px;">
      <p style="color:#1e3a5f;font-size:16px;margin:0 0 16px;">${T.hi}</p>
      <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">${T.ended}</p>
      <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 24px;">${T.offer}</p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="${restartUrl}" style="display:inline-block;background:linear-gradient(135deg,#0077b6,#07183f);color:#5dff9a;font-weight:800;font-size:15px;padding:14px 30px;border-radius:12px;text-decoration:none;">${T.button}</a>
      </div>
      <p style="color:#6b7280;font-size:14px;line-height:1.7;margin:0;">${T.done}</p>
    </div>
    <div style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
      <p style="margin:0;color:#9ca3af;font-size:12px;">Still Afloat · <em>${T.tag}</em></p>
    </div>
  </div>
</body></html>`,
  };
}

export interface EndingWatch {
  id: string;
  ship_name: string;
  sailing_end: string;
  window_days: number | null;
  subscribers?: { email: string; name: string; lang: string | null; status: string } | null;
}

/** How long a failed "keep tracking?" email is retried before its watch closes without one. */
export const ENDED_EMAIL_RETRY_DAYS = 3;

/**
 * 15-day watches past their last day: `notify` get the "keep tracking?" email and then close;
 * `close` end quietly (no longer a confirmed subscriber, or the email kept failing for
 * ENDED_EMAIL_RETRY_DAYS). Pure: the sweep in wms-alerts.ts does the sending and updating.
 */
export function planWatchEndings<T extends EndingWatch>(rows: readonly T[], today: string): { notify: T[]; close: T[] } {
  const oldest = addDays(today, -ENDED_EMAIL_RETRY_DAYS);
  const notify: T[] = [];
  const close: T[] = [];
  for (const w of rows) {
    if (w.sailing_end >= today) continue; // still running
    if (w.window_days && w.subscribers?.status === "confirmed" && w.sailing_end >= oldest) notify.push(w);
    else close.push(w);
  }
  return { notify, close };
}
