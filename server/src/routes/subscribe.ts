import { Router } from "express";
import crypto from "node:crypto";
import { getSupabase, readJson, PATHS } from "../lib/persistence";
import { logger } from "../lib/logger";
import { sendMail } from "../lib/mailer";
import { tokenOk } from "../lib/http-auth";

const router = Router();

// ── Simple in-memory rate limiter: max 5 attempts per IP per hour ──
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return false;
  }
  if (entry.count >= 5) return true;
  entry.count++;
  return false;
}

// ── Deterministic unsubscribe sig (no extra DB column needed) ──
function makeUnsubscribeSig(email: string): string {
  const secret = process.env["UNSUBSCRIBE_SECRET"] || "still-afloat-unsub-v1";
  return crypto.createHmac("sha256", secret).update(email.toLowerCase()).digest("hex").slice(0, 24);
}

export function unsubscribeUrl(email: string, baseUrl: string): string {
  const sig = makeUnsubscribeSig(email);
  return `${baseUrl}/api/unsubscribe?email=${encodeURIComponent(email)}&sig=${sig}`;
}

// ── Send verification email via Resend ──
async function sendVerificationEmail(
  name: string,
  email: string,
  token: string,
  baseUrl: string,
  lang: "en" | "es" = "en",
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
router.post("/subscribe", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket?.remoteAddress || "unknown";

    if (isRateLimited(ip)) {
      return res.status(429).json({ error: "Too many attempts. Please try again later." });
    }

    const { name, email, website, lang } = req.body as Record<string, string>;
    const subLang = lang === "es" ? "es" : "en"; // tag the subscriber's language

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

    const cleanEmail = email.trim().toLowerCase();
    const cleanName  = name.trim();
    const supabase   = getSupabase();

    const { data: existing } = await supabase
      .from("subscribers")
      .select("status")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (existing) {
      if (existing.status === "confirmed") return res.json({ ok: true, already: "confirmed" });
      if (existing.status === "pending")   return res.json({ ok: true, already: "pending" });
    }

    const token = crypto.randomUUID();

    const { error: insertErr } = await supabase.from("subscribers").insert({
      email: cleanEmail, name: cleanName, status: "pending", token, lang: subLang,
    });

    if (insertErr) {
      logger.error({ err: insertErr }, "Subscriber insert failed");
      return res.status(500).json({ error: "Could not save subscription. Please try again." });
    }

    const proto   = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host    = req.headers["host"] || "stillafloatcruising.com";
    const baseUrl = `${proto}://${host}`;

    const emailResult = await sendVerificationEmail(cleanName, cleanEmail, token, baseUrl, subLang);
    logger.info({ email: cleanEmail, emailResult }, "Subscriber added — verification email sent");
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Subscribe route error");
    return res.status(500).json({ error: "An unexpected error occurred." });
  }
});

// ── GET /api/verify-email?token= ────────────────────────────────
router.get("/verify-email", async (req, res) => {
  const token = req.query["token"] as string;
  if (!token) return res.redirect("/subscribe.html?error=missing_token");

  try {
    const supabase = getSupabase();
    const { data: subscriber, error: fetchErr } = await supabase
      .from("subscribers").select("id, status, email, name").eq("token", token).maybeSingle();

    if (fetchErr || !subscriber) {
      logger.warn({ token }, "Verify: token not found");
      return res.redirect("/subscribe-verified.html?result=invalid");
    }
    if (subscriber.status === "confirmed") {
      return res.redirect("/subscribe-verified.html?result=already");
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
    return res.redirect(
      "/subscribe-verified.html?result=success&name=" + encodeURIComponent(subscriber.name),
    );
  } catch (err) {
    logger.error({ err }, "Verify email route error");
    return res.redirect("/subscribe-verified.html?result=error");
  }
});

// ── POST /api/resend-verification ────────────────────────────────
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email) return res.status(400).json({ error: "Email is required." });

    const cleanEmail = email.trim().toLowerCase();
    const supabase   = getSupabase();

    const { data: subscriber, error: fetchErr } = await supabase
      .from("subscribers")
      .select("id, name, status, lang")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (fetchErr || !subscriber) {
      return res.status(404).json({ error: "No subscription found for that email." });
    }
    if (subscriber.status === "confirmed") {
      return res.json({ ok: true, already: "confirmed" });
    }
    if (subscriber.status === "unsubscribed") {
      return res.status(400).json({ error: "This email has been unsubscribed." });
    }

    const newToken = crypto.randomUUID();
    const { error: updateErr } = await supabase
      .from("subscribers")
      .update({ token: newToken })
      .eq("id", subscriber.id);

    if (updateErr) {
      logger.error({ err: updateErr }, "Resend: token update failed");
      return res.status(500).json({ error: "Could not regenerate your confirmation link." });
    }

    const proto   = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host    = req.headers["host"] || "stillafloatcruising.com";
    const baseUrl = `${proto}://${host}`;

    const emailResult = await sendVerificationEmail(
      subscriber.name, cleanEmail, newToken, baseUrl,
      (subscriber as { lang?: string }).lang === "es" ? "es" : "en",
    );
    logger.info({ email: cleanEmail, emailResult }, "Verification email resent");
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Resend verification route error");
    return res.status(500).json({ error: "An unexpected error occurred." });
  }
});

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
      .select("id, email, name, status, created_at, confirmed_at", { count: "exact" })
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

// ── GET /api/unsubscribe?email=&sig= ─────────────────────────────
router.get("/unsubscribe", async (req, res) => {
  const { email, sig } = req.query as Record<string, string>;

  if (!email || !sig) return res.redirect("/unsubscribe-confirmed.html?result=invalid");

  const expected = makeUnsubscribeSig(email);
  if (expected !== sig) {
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

    const proto   = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host    = req.headers["host"] || "stillafloatcruising.com";
    const baseUrl = `${proto}://${host}`;

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
