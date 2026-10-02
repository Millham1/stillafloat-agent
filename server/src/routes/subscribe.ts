import { Router, type Request, type Response, type RequestHandler } from "express";
import crypto from "node:crypto";
import { getSupabase, readJson, PATHS } from "../lib/persistence";
import { logger } from "../lib/logger";
import { sendMail } from "../lib/mailer";
import { tokenOk } from "../lib/http-auth";
import { verifyTurnstile } from "../lib/turnstile";
import { verificationSendCap, logCapHit, type SendCap } from "../lib/verification-send-cap";
import { activatePendingWatches } from "../lib/pending-watches";
import { WATCH_WINDOW_DAYS } from "../lib/ship-watch";
import { signLink, verifyLink } from "../lib/link-signing";

const router = Router();

// ── Simple in-memory rate limiter: max 5 attempts per IP per hour ──
// One limiter per route: the sign-up keeps the count it always had, and resend-verification
// (which had none at all until 2026-10-02) gets its own.
function ipLimiter(max = 5, windowMs = 60 * 60 * 1000): (ip: string) => boolean {
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
      return false;
    }
    if (entry.count >= max) return true;
    entry.count++;
    return false;
  };
}

function clientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || "unknown";
}

// Links in a subscriber's inbox must always be the public site. Deriving them from
// the request host was correct behind nginx on prod but wrong anywhere else
// (dev sends carried the box address). Pinned 2026-09-09 alongside the storm-alert fix.
function publicBaseUrl(): string {
  return process.env["PUBLIC_URL"]?.replace(/\/$/, "") || "https://stillafloatcruising.com";
}

// ── Deterministic unsubscribe sig (no extra DB column needed; lib/link-signing.ts) ──
export function unsubscribeUrl(email: string, baseUrl: string): string {
  const sig = signLink("unsubscribe", email);
  return `${baseUrl}/api/unsubscribe?email=${encodeURIComponent(email)}&sig=${sig}`;
}

// ── Send verification email (also reused for pending-subscriber reminders,
// see lib/subscriber-hygiene.ts — same template, it's the same ask either way) ──
export async function sendVerificationEmail(
  name: string,
  email: string,
  token: string,
  baseUrl: string,
  lang: "en" | "es" = "en",
  /** Set when the sign-up came from a "Track this ship" button: the email says confirming starts the watch. */
  watchShip?: string,
) {
  // Verification email now goes via Gmail (ops-manager /send-email), not Resend.

  const verifyUrl = `${baseUrl}/api/verify-email?token=${encodeURIComponent(token)}`;
  const unsub    = unsubscribeUrl(email, baseUrl);
  const firstName = name.split(" ")[0] || name;
  const es = lang === "es";
  const T = es
    ? {
        subject: "Confirma tu suscripción a Still Afloat ⚓",
        heading: "¡Un clic para confirmar!",
        hi: `Hola ${firstName},`,
        body: "Gracias por suscribirte a <strong>Still Afloat</strong> — tu fuente semanal de noticias de cruceros, clima en los puertos e inteligencia de viaje. Haz clic en el botón para confirmar tu correo y listo.",
        button: "✅ Confirmar mi suscripción →",
        ignore: "Si no te suscribiste a Still Afloat, ignora este correo — no quedarás suscrito.",
        tag: "Navega más inteligente. Ríe más.",
        unsub: "Cancelar suscripción",
        ...(watchShip ? {
          subject: `Confirma tu suscripción para seguir a ${watchShip} ⚓`,
          heading: "¡Un clic para empezar a seguir tu barco!",
          body: `Confirma tu correo para suscribirte a <strong>Still Afloat</strong> y vigilaremos a <strong>${watchShip}</strong> por ti durante los próximos ${WATCH_WINDOW_DAYS} días: te avisaremos si cambia el itinerario, si hay clima severo en la ruta o si tu línea de cruceros publica noticias que afecten tu viaje. Tu suscripción también incluye nuestras noticias semanales de cruceros.`,
          button: "✅ Suscribirme y empezar a seguirlo →",
        } : {}),
      }
    : {
        subject: "Confirm your Still Afloat subscription ⚓",
        heading: "One click to confirm!",
        hi: `Hey ${firstName},`,
        body: "Thanks for subscribing to <strong>Still Afloat</strong> — your weekly source for smart cruise news, port weather, and travel intelligence. Just click the button below to confirm your email and you're all set.",
        button: "✅ Confirm My Subscription →",
        ignore: "If you didn't sign up for Still Afloat, you can safely ignore this email — you won't be subscribed.",
        tag: "Cruise smarter. Laugh more. Stay Afloat.",
        unsub: "Unsubscribe",
        ...(watchShip ? {
          subject: `Confirm your subscription to start tracking ${watchShip} ⚓`,
          heading: "One click to start tracking your ship!",
          body: `Confirm your email to subscribe to <strong>Still Afloat</strong>, and we'll watch <strong>${watchShip}</strong> for you for the next ${WATCH_WINDOW_DAYS} days: an email if the itinerary changes, severe weather threatens the route, or your cruise line makes news that matters to your sailing. Your subscription also brings our weekly cruise news.`,
          button: "✅ Subscribe and Start Tracking →",
        } : {}),
      };

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;padding:0;margin:0;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
    <div style="background:linear-gradient(135deg,#07183f,#0077b6);padding:32px 32px 28px;text-align:center;">
      <p style="margin:0 0 12px;color:rgba(255,255,255,.7);font-size:13px;letter-spacing:.08em;text-transform:uppercase;">Still Afloat Cruising</p>
      <h1 style="margin:0;color:#5dff9a;font-size:26px;font-weight:900;line-height:1.2;">${T.heading}</h1>
    </div>
    <div style="padding:32px;">
      <p style="color:#1e3a5f;font-size:16px;line-height:1.6;margin:0 0 20px;">${T.hi}</p>
      <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 28px;">
        ${T.body}
      </p>
      <div style="text-align:center;margin:0 0 32px;">
        <a href="${verifyUrl}"
           style="display:inline-block;background:linear-gradient(135deg,#0077b6,#07183f);color:#5dff9a;font-weight:800;font-size:16px;padding:16px 36px;border-radius:12px;text-decoration:none;letter-spacing:.02em;">
          ${T.button}
        </a>
      </div>
      <p style="color:#9ca3af;font-size:13px;line-height:1.6;margin:0;border-top:1px solid #e5e7eb;padding-top:20px;">
        ${T.ignore}
      </p>
    </div>
    <div style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
      <p style="margin:0;color:#9ca3af;font-size:12px;">Still Afloat · <em>${T.tag}</em><br>
      <a href="${unsub}" style="color:#9ca3af;font-size:11px;">${T.unsub}</a></p>
    </div>
  </div>
</body>
</html>`;

  const ok = await sendMail({
    to: email,
    subject: T.subject,
    html,
    fromName: "Still Afloat",
  });
  if (!ok) {
    logger.error("Verification email delivery failed");
    return { success: false, reason: "delivery_failed" };
  }
  return { success: true };
}

// ── Newsletter HTML builder ──────────────────────────────────────
function renderNewsletter(
  stories: Record<string, unknown>[],
  subject: string,
  recipientName: string,
  recipientEmail: string,
  baseUrl: string,
): string {
  const unsub = unsubscribeUrl(recipientEmail, baseUrl);
  const firstName = recipientName.split(" ")[0] || recipientName;

  const storyRows = stories.map((s) => {
    const title   = String(s.title   || "Untitled");
    const summary = String(s.summary || "");
    const link    = String(s.link || s.originalLink || "");
    const impact  = String(s.impactLevel || s.travelerImpact || "");
    const id      = String(s.id || "");

    const storyUrl = link || `${baseUrl}/story.html?id=${id}`;

    return `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:20px 22px;margin-bottom:16px;background:#fff;">
      ${impact ? `<span style="display:inline-block;background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:2px 10px;font-size:12px;color:#1d4ed8;font-weight:700;margin-bottom:10px;">${impact}</span>` : ""}
      <h2 style="margin:0 0 10px;font-size:17px;color:#0c2035;line-height:1.4;font-weight:800;">${title}</h2>
      <p style="margin:0 0 14px;color:#374151;font-size:14px;line-height:1.7;">${summary}</p>
      <a href="${storyUrl}" style="display:inline-block;background:#0077b6;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">Read More →</a>
    </div>`;
  }).join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;padding:0;margin:0;">
  <div style="max-width:600px;margin:32px auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
    <div style="background:linear-gradient(135deg,#07183f,#0077b6);padding:28px 32px;text-align:center;">
      <p style="margin:0 0 6px;color:rgba(255,255,255,.6);font-size:12px;letter-spacing:.10em;text-transform:uppercase;">Still Afloat Weekly</p>
      <h1 style="margin:0 0 6px;color:#5dff9a;font-size:24px;font-weight:900;">${subject}</h1>
      <p style="margin:0;color:rgba(255,255,255,.65);font-size:13px;">Your curated cruise &amp; travel intelligence</p>
    </div>
    <div style="background:#f9fafb;padding:28px 32px;">
      <p style="margin:0 0 22px;color:#1e3a5f;font-size:15px;">Hey ${firstName},</p>
      ${storyRows}
      <div style="text-align:center;margin-top:28px;">
        <a href="${baseUrl}/news.html" style="display:inline-block;background:linear-gradient(135deg,#0077b6,#07183f);color:#5dff9a;padding:14px 28px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;">See All Cruise News →</a>
      </div>
    </div>
    <div style="background:#fff;padding:16px 32px;border-top:1px solid #e5e7eb;text-align:center;">
      <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.7;">
        Still Afloat · <em>Cruise smarter. Laugh more. Stay Afloat.</em><br>
        <a href="${unsub}" style="color:#9ca3af;font-size:11px;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── POST /api/subscribe ──────────────────────────────────────────
// 2026-10-02: bots were signing strangers up (21 on Oct 1, 28 on Oct 2), and every sign-up
// sent a confirmation email from mark@stillafloatcruising.com through Zoho. Now, in order:
// IP limit → honeypot → field checks → Turnstile (required whenever TURNSTILE_SECRET_KEY is
// set) → already-subscribed → the site-wide confirmation-email cap → insert → send.
// Nothing is saved and nothing is sent unless every check before the insert passes.
// Dependencies are injected so the tests never touch Supabase or email.

/** Messages for the checks added 2026-10-02, in the language of the page that sent the form. */
export const SUBSCRIBE_MESSAGES = {
  en: {
    security: "Please complete the security check and try again.",
    busy: "We're getting a lot of signups right now — please try again in a little while.",
  },
  es: {
    security: "Por favor completa la verificación de seguridad e inténtalo de nuevo.",
    busy: "Estamos recibiendo muchas suscripciones en este momento — por favor inténtalo de nuevo en un rato.",
  },
} as const;

export interface NewSubscriberRow {
  email: string; name: string; status: "pending"; token: string; lang: "en" | "es";
}

export interface SubscribeDeps {
  rateLimited(ip: string): boolean;
  verifyTurnstile(token: string | null): Promise<boolean>;
  findSubscriber(email: string): Promise<{ status: string } | null>;
  insertSubscriber(row: NewSubscriberRow): Promise<{ error: unknown }>;
  sendVerification(args: { name: string; email: string; token: string; lang: "en" | "es" }): Promise<unknown>;
  sendCap: SendCap;
  newToken(): string;
}

export function createSubscribeHandler(deps: SubscribeDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      const ip = clientIp(req);

      if (deps.rateLimited(ip)) {
        return res.status(429).json({ error: "Too many attempts. Please try again later." });
      }

      const { name, email, website, lang } = (req.body ?? {}) as Record<string, string>;
      const subLang = lang === "es" ? "es" : "en"; // tag the subscriber's language
      const M = SUBSCRIBE_MESSAGES[subLang];

      if (website && website.length > 0) {
        logger.info({ ip }, "Honeypot triggered — bot blocked");
        return res.json({ ok: true });
      }

      if (!name || name.trim().length < 2) {
        return res.status(400).json({ error: "Please enter your full name." });
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return res.status(400).json({ error: "Please enter a valid email address." });
      }

      // ── Turnstile: a missing or rejected token stops here — no insert, no email ──
      const rawToken = (req.body as Record<string, unknown>)["cf-turnstile-response"];
      const turnstileToken = typeof rawToken === "string" && rawToken ? rawToken : null;
      if (!(await deps.verifyTurnstile(turnstileToken))) {
        logger.warn({ ip, hadToken: Boolean(turnstileToken) }, "Turnstile verification failed — newsletter sign-up blocked");
        return res.status(400).json({ error: M.security });
      }

      const cleanEmail = email.trim().toLowerCase();
      const cleanName  = name.trim();

      const existing = await deps.findSubscriber(cleanEmail);
      if (existing) {
        if (existing.status === "confirmed") return res.json({ ok: true, already: "confirmed" });
        if (existing.status === "pending")   return res.json({ ok: true, already: "pending" });
      }

      // ── Site-wide cap on confirmation emails (lib/verification-send-cap.ts) ──
      if (!deps.sendCap.tryReserve()) {
        logCapHit(deps.sendCap, "subscribe");
        return res.status(429).json({ error: M.busy });
      }

      const token = deps.newToken();
      const { error: insertErr } = await deps.insertSubscriber({
        email: cleanEmail, name: cleanName, status: "pending", token, lang: subLang,
      });

      if (insertErr) {
        deps.sendCap.release(); // nothing was sent, so the slot goes back
        logger.error({ err: insertErr }, "Subscriber insert failed");
        return res.status(500).json({ error: "Could not save subscription. Please try again." });
      }

      const emailResult = await deps.sendVerification({ name: cleanName, email: cleanEmail, token, lang: subLang });
      logger.info({ email: cleanEmail, emailResult }, "Subscriber added — verification email sent");
      return res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Subscribe route error");
      return res.status(500).json({ error: "An unexpected error occurred." });
    }
  };
}

export const defaultSubscribeDeps: SubscribeDeps = {
  rateLimited: ipLimiter(),
  verifyTurnstile: (token) => verifyTurnstile(token, { form: "subscribe" }),
  async findSubscriber(email) {
    const { data } = await getSupabase().from("subscribers").select("status").eq("email", email).maybeSingle();
    return data ? { status: String(data.status) } : null;
  },
  async insertSubscriber(row) {
    const { error } = await getSupabase().from("subscribers").insert(row);
    return { error };
  },
  sendVerification: ({ name, email, token, lang }) => sendVerificationEmail(name, email, token, publicBaseUrl(), lang),
  sendCap: verificationSendCap,
  newToken: () => crypto.randomUUID(),
};

router.post("/subscribe", createSubscribeHandler(defaultSubscribeDeps));

// ── GET /api/verify-email?token= ────────────────────────────────
router.get("/verify-email", async (req, res) => {
  const token = req.query["token"] as string;
  if (!token) return res.redirect("/subscribe.html?error=missing_token");

  try {
    const supabase = getSupabase();
    const { data: subscriber, error: fetchErr } = await supabase
      .from("subscribers").select("id, status, email, name, lang").eq("token", token).maybeSingle();

    if (fetchErr || !subscriber) {
      logger.warn({ token }, "Verify: token not found");
      return res.redirect("/subscribe-verified.html?result=invalid");
    }
    if (subscriber.status === "confirmed") {
      const already = (subscriber as unknown as { lang?: string | null }).lang === "es" ? "/es/subscribe-verified.html" : "/subscribe-verified.html";
      return res.redirect(already + "?result=already");
    }

    const { error: updateErr } = await supabase
      .from("subscribers")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString(), token: null })
      .eq("id", subscriber.id);

    if (updateErr) {
      logger.error({ err: updateErr }, "Verify: update failed");
      return res.redirect("/subscribe-verified.html?result=error");
    }

    logger.info({ email: subscriber.email }, "Subscriber confirmed");

    // A "Track this ship" sign-up waits for this click: switch its watches on now.
    const confirmed = subscriber as unknown as { id: string; email: string; name: string; lang?: string | null };
    let tracking: { ship: string; until: string }[] = [];
    try {
      tracking = await activatePendingWatches({
        id: String(confirmed.id), email: String(confirmed.email), name: String(confirmed.name), lang: confirmed.lang ?? null,
      });
    } catch (err) {
      logger.error({ err, email: confirmed.email }, "Verify: pending ship watches could not be switched on");
    }
    const page = confirmed.lang === "es" ? "/es/subscribe-verified.html" : "/subscribe-verified.html";
    return res.redirect(
      page + "?result=success&name=" + encodeURIComponent(confirmed.name)
        + (tracking[0] ? "&ship=" + encodeURIComponent(tracking[0].ship) + "&until=" + tracking[0].until : ""),
    );
  } catch (err) {
    logger.error({ err }, "Verify email route error");
    return res.redirect("/subscribe-verified.html?result=error");
  }
});

// ── POST /api/resend-verification ────────────────────────────────
// The "send a new confirmation email" button on subscribe-pending.html. Public, and until
// 2026-10-02 it had no limit of any kind: anyone could make us email any pending address
// again and again. Now it has its own IP limit and shares the site-wide confirmation cap.

export interface ResendDeps {
  rateLimited(ip: string): boolean;
  findSubscriber(email: string): Promise<{ id: string; name: string; status: string; lang?: string | null } | null>;
  setToken(id: string, token: string): Promise<{ error: unknown }>;
  sendVerification(args: { name: string; email: string; token: string; lang: "en" | "es" }): Promise<unknown>;
  sendCap: SendCap;
  newToken(): string;
}

export function createResendVerificationHandler(deps: ResendDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      if (deps.rateLimited(clientIp(req))) {
        return res.status(429).json({ error: "Too many attempts. Please try again later." });
      }

      const { email } = (req.body ?? {}) as { email?: string };
      if (!email) return res.status(400).json({ error: "Email is required." });

      const cleanEmail = email.trim().toLowerCase();
      const subscriber = await deps.findSubscriber(cleanEmail);

      if (!subscriber) {
        return res.status(404).json({ error: "No subscription found for that email." });
      }
      if (subscriber.status === "confirmed") {
        return res.json({ ok: true, already: "confirmed" });
      }
      if (subscriber.status === "unsubscribed") {
        return res.status(400).json({ error: "This email has been unsubscribed." });
      }

      const lang = subscriber.lang === "es" ? "es" : "en";
      if (!deps.sendCap.tryReserve()) {
        logCapHit(deps.sendCap, "resend-verification");
        return res.status(429).json({ error: SUBSCRIBE_MESSAGES[lang].busy });
      }

      const newToken = deps.newToken();
      const { error: updateErr } = await deps.setToken(subscriber.id, newToken);

      if (updateErr) {
        deps.sendCap.release();
        logger.error({ err: updateErr }, "Resend: token update failed");
        return res.status(500).json({ error: "Could not regenerate your confirmation link." });
      }

      const emailResult = await deps.sendVerification({ name: subscriber.name, email: cleanEmail, token: newToken, lang });
      logger.info({ email: cleanEmail, emailResult }, "Verification email resent");
      return res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Resend verification route error");
      return res.status(500).json({ error: "An unexpected error occurred." });
    }
  };
}

export const defaultResendDeps: ResendDeps = {
  rateLimited: ipLimiter(),
  async findSubscriber(email) {
    const { data, error } = await getSupabase()
      .from("subscribers")
      .select("id, name, status, lang")
      .eq("email", email)
      .maybeSingle();
    if (error || !data) return null;
    return { id: String(data.id), name: String(data.name ?? ""), status: String(data.status), lang: data.lang ?? null };
  },
  async setToken(id, token) {
    const { error } = await getSupabase().from("subscribers").update({ token }).eq("id", id);
    return { error };
  },
  sendVerification: ({ name, email, token, lang }) => sendVerificationEmail(name, email, token, publicBaseUrl(), lang),
  sendCap: verificationSendCap,
  newToken: () => crypto.randomUUID(),
};

router.post("/resend-verification", createResendVerificationHandler(defaultResendDeps));

// ── GET /api/subscribers ─────────────────────────────────────────
router.get("/subscribers", async (req, res) => {
  if (!tokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { status, search, page = "1", limit = "100" } = req.query as Record<string, string>;
    const supabase  = getSupabase();
    const pageNum   = Math.max(1, parseInt(page) || 1);
    const limitNum  = Math.min(200, parseInt(limit) || 100);
    const from      = (pageNum - 1) * limitNum;

    let query = supabase
      .from("subscribers")
      .select("id, email, name, status, lang, created_at, confirmed_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, from + limitNum - 1);

    if (status && status !== "all") query = query.eq("status", status);
    if (search) query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ subscribers: data ?? [], total: count ?? 0, page: pageNum, limit: limitNum });
  } catch (err) {
    logger.error({ err }, "Subscribers list error");
    return res.status(500).json({ error: "Failed to load subscribers" });
  }
});

// ── PATCH /api/subscribers/:id/lang ──────────────────────────────
// Admin fix for subscribers captured before language tagging (or tagged
// wrong): sets which newsletter edition (en|es) this person receives.
router.patch("/subscribers/:id/lang", async (req, res) => {
  if (!tokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const lang = String((req.body as { lang?: string })?.lang ?? "");
    if (lang !== "en" && lang !== "es") return res.status(400).json({ error: "lang must be 'en' or 'es'" });
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("subscribers")
      .update({ lang })
      .eq("id", String(req.params["id"]))
      .select("id, email, lang")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Subscriber not found" });
    logger.info({ id: data.id, lang }, "Subscriber language updated");
    return res.json({ success: true, subscriber: data });
  } catch (err) {
    logger.error({ err }, "Subscriber lang update error");
    return res.status(500).json({ error: "Failed to update language" });
  }
});

// ── POST /api/subscribers/mark-bounced ───────────────────────────
// Called by saf-ops-manager's Gmail bounce-scanner when it finds a confirmed
// bounce-back (DSN) for one of our subscriber addresses. Setting status to
// 'bounced' is enough on its own to stop future sends — both newsletter send
// paths filter on status='confirmed', so a bounced row is automatically
// excluded without needing a separate suppression list.
router.post("/subscribers/mark-bounced", async (req, res) => {
  if (!tokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { email } = req.body as { email?: string };
    if (!email) return res.status(400).json({ error: "Email is required." });

    const cleanEmail = email.trim().toLowerCase();
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("subscribers")
      .update({ status: "bounced", bounced_at: new Date().toISOString() })
      .eq("email", cleanEmail)
      .select("id")
      .maybeSingle();

    if (error) {
      logger.error({ err: error, email: cleanEmail }, "Mark-bounced update failed");
      return res.status(500).json({ error: "Could not update subscriber." });
    }
    if (!data) {
      return res.status(404).json({ error: "No subscriber found for that email." });
    }

    logger.info({ email: cleanEmail }, "Subscriber marked bounced");
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Mark-bounced route error");
    return res.status(500).json({ error: "An unexpected error occurred." });
  }
});

// ── GET /api/unsubscribe?email=&sig= ─────────────────────────────
router.get("/unsubscribe", async (req, res) => {
  const { email, sig } = req.query as Record<string, string>;

  if (!email || !sig) return res.redirect("/unsubscribe-confirmed.html?result=invalid");

  if (!verifyLink("unsubscribe", email, sig)) {
    logger.warn({ email }, "Unsubscribe: invalid sig");
    return res.redirect("/unsubscribe-confirmed.html?result=invalid");
  }

  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from("subscribers")
      .update({ status: "unsubscribed" })
      .eq("email", email.toLowerCase());

    if (error) {
      logger.error({ err: error }, "Unsubscribe update failed");
      return res.redirect("/unsubscribe-confirmed.html?result=error");
    }

    logger.info({ email }, "Subscriber unsubscribed");
    return res.redirect(
      "/unsubscribe-confirmed.html?result=success&email=" + encodeURIComponent(email),
    );
  } catch (err) {
    logger.error({ err }, "Unsubscribe route error");
    return res.redirect("/unsubscribe-confirmed.html?result=error");
  }
});

// ── GET /api/approved-stories-list (for newsletter composer) ─────
router.get("/approved-stories-list", async (req, res) => {
  if (!tokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const data = await readJson<{ stories?: Record<string, unknown>[] }>(PATHS.approved, { stories: [] });
    return res.json({ stories: data.stories ?? [] });
  } catch (err) {
    logger.error({ err }, "Approved stories list error");
    return res.status(500).json({ error: "Failed to load stories" });
  }
});

// ── POST /api/send-newsletter ─────────────────────────────────────
router.post("/send-newsletter", async (req, res) => {
  if (!tokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { storyIds, subject } = req.body as { storyIds: string[]; subject: string };

    if (!subject?.trim()) return res.status(400).json({ error: "Subject is required." });
    if (!Array.isArray(storyIds) || storyIds.length === 0) {
      return res.status(400).json({ error: "Select at least one story." });
    }

    // Fetch approved stories
    const approved = await readJson<{ stories?: Record<string, unknown>[] }>(PATHS.approved, { stories: [] });
    const allStories = approved.stories ?? [];
    const selected  = allStories.filter((s) => storyIds.includes(String(s.id)));

    if (selected.length === 0) {
      return res.status(400).json({ error: "No matching approved stories found for the selected IDs." });
    }

    // Fetch all confirmed subscribers
    const supabase = getSupabase();
    const { data: subscribers, error: subErr } = await supabase
      .from("subscribers")
      .select("email, name")
      .eq("status", "confirmed");

    if (subErr) return res.status(500).json({ error: "Failed to load subscribers." });
    if (!subscribers || subscribers.length === 0) {
      return res.status(400).json({ error: "No confirmed subscribers to send to." });
    }

    // Links in a subscriber's inbox must always be the public site. Deriving them from
    // the request host was correct behind nginx on prod but wrong anywhere else
    // (dev sends carried the box address). Pinned 2026-09-09 alongside the storm-alert fix.
    const baseUrl = process.env["PUBLIC_URL"]?.replace(/\/$/, "") || "https://stillafloatcruising.com";

    // Via the ops-manager Gmail sender (Resend was retired 2026-07-01). Fine at
    // this list size; past ~200 recipients, move to a real ESP.
    if (subscribers.length > 200) {
      return res.status(400).json({ error: `Subscriber list (${subscribers.length}) exceeds the Gmail send cap — migrate to a real ESP first.` });
    }

    let sent = 0, failed = 0;

    for (const sub of subscribers) {
      const html = renderNewsletter(selected, subject, sub.name, sub.email, baseUrl);
      const ok = await sendMail({ to: sub.email, subject, html, fromName: "Still Afloat" });
      ok ? sent++ : failed++;
      if (!ok) logger.error({ email: sub.email }, "Newsletter send failed");
      await new Promise((r) => setTimeout(r, 1200)); // pace the Gmail API
    }

    logger.info({ subject, sent, failed }, "Newsletter send complete");
    return res.json({ ok: true, sent, failed, total: subscribers.length });
  } catch (err) {
    logger.error({ err }, "Send newsletter error");
    return res.status(500).json({ error: "An unexpected error occurred." });
  }
});

export default router;
