import { Router } from "express";
import crypto from "node:crypto";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";

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

// ── Send verification email via Resend ──
async function sendVerificationEmail(
  name: string,
  email: string,
  token: string,
  baseUrl: string,
) {
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) {
    logger.warn("RESEND_API_KEY not set — skipping verification email");
    return { success: false, reason: "no_api_key" };
  }

  const verifyUrl = `${baseUrl}/api/verify-email?token=${encodeURIComponent(token)}`;
  const firstName = name.split(" ")[0] || name;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;padding:0;margin:0;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
    <div style="background:linear-gradient(135deg,#07183f,#0077b6);padding:32px 32px 28px;text-align:center;">
      <p style="margin:0 0 12px;color:rgba(255,255,255,.7);font-size:13px;letter-spacing:.08em;text-transform:uppercase;">Still Afloat Cruising</p>
      <h1 style="margin:0;color:#5dff9a;font-size:26px;font-weight:900;line-height:1.2;">One click to confirm!</h1>
    </div>
    <div style="padding:32px;">
      <p style="color:#1e3a5f;font-size:16px;line-height:1.6;margin:0 0 20px;">Hey ${firstName},</p>
      <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 28px;">
        Thanks for subscribing to <strong>Still Afloat</strong> — your weekly source for smart cruise news, port weather, and travel intelligence. Just click the button below to confirm your email and you're all set.
      </p>
      <div style="text-align:center;margin:0 0 32px;">
        <a href="${verifyUrl}"
           style="display:inline-block;background:linear-gradient(135deg,#0077b6,#07183f);color:#5dff9a;font-weight:800;font-size:16px;padding:16px 36px;border-radius:12px;text-decoration:none;letter-spacing:.02em;">
          ✅ Confirm My Subscription →
        </a>
      </div>
      <p style="color:#9ca3af;font-size:13px;line-height:1.6;margin:0;border-top:1px solid #e5e7eb;padding-top:20px;">
        If you didn't sign up for Still Afloat, you can safely ignore this email — you won't be subscribed.<br><br>
        This link expires in 48 hours.
      </p>
    </div>
    <div style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
      <p style="margin:0;color:#9ca3af;font-size:12px;">Still Afloat · <em>Cruise smarter. Laugh more. Stay Afloat.</em></p>
    </div>
  </div>
</body>
</html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Still Afloat <noreply@stillafloatcruising.com>",
      to: email,
      subject: "Confirm your Still Afloat subscription ⚓",
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    logger.error({ status: res.status, err }, "Verification email delivery failed");
    return { success: false, reason: "delivery_failed", status: res.status };
  }
  return { success: true };
}

// ── POST /api/subscribe ──────────────────────────────────────────
router.post("/api/subscribe", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket?.remoteAddress
      || "unknown";

    if (isRateLimited(ip)) {
      return res.status(429).json({ error: "Too many attempts. Please try again later." });
    }

    const { name, email, website } = req.body as Record<string, string>;

    // Honeypot — bots fill this, humans don't see it
    if (website && website.length > 0) {
      logger.info({ ip }, "Honeypot triggered — bot blocked");
      // Return success so bots don't know they were blocked
      return res.json({ ok: true });
    }

    // Validate
    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: "Please enter your full name." });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName  = name.trim();

    const supabase = getSupabase();

    // Check existing
    const { data: existing } = await supabase
      .from("subscribers")
      .select("status")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (existing) {
      if (existing.status === "confirmed") {
        return res.json({ ok: true, already: "confirmed" });
      }
      if (existing.status === "pending") {
        return res.json({ ok: true, already: "pending" });
      }
    }

    // Generate token
    const token = crypto.randomUUID();

    // Insert subscriber (pending)
    const { error: insertErr } = await supabase.from("subscribers").insert({
      email: cleanEmail,
      name: cleanName,
      status: "pending",
      token,
    });

    if (insertErr) {
      logger.error({ err: insertErr }, "Subscriber insert failed");
      return res.status(500).json({ error: "Could not save subscription. Please try again." });
    }

    // Determine base URL
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host  = req.headers["host"] || "stillafloatcruising.com";
    const baseUrl = `${proto}://${host}`;

    const emailResult = await sendVerificationEmail(cleanName, cleanEmail, token, baseUrl);
    logger.info({ email: cleanEmail, emailResult }, "Subscriber added — verification email sent");

    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Subscribe route error");
    return res.status(500).json({ error: "An unexpected error occurred." });
  }
});

// ── GET /api/verify-email?token= ─────────────────────────────────
router.get("/api/verify-email", async (req, res) => {
  const token = req.query["token"] as string;

  if (!token) {
    return res.redirect("/subscribe.html?error=missing_token");
  }

  try {
    const supabase = getSupabase();

    const { data: subscriber, error: fetchErr } = await supabase
      .from("subscribers")
      .select("id, status, email, name")
      .eq("token", token)
      .maybeSingle();

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
    return res.redirect("/subscribe-verified.html?result=success&name=" + encodeURIComponent(subscriber.name));
  } catch (err) {
    logger.error({ err }, "Verify email route error");
    return res.redirect("/subscribe-verified.html?result=error");
  }
});

export default router;
