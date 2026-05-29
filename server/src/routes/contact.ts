import { Router, type Request, type Response } from "express";
import { getSupabase } from "../lib/persistence";
import { logger } from "../lib/logger";

const router = Router();

// ── Rate limiter: max 5 submissions per IP per hour ──────────────
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

// ── Verify Cloudflare Turnstile token ────────────────────────────
async function verifyTurnstile(token: string | null): Promise<boolean> {
  const secret = process.env["TURNSTILE_SECRET_KEY"];
  if (!secret) {
    logger.warn("TURNSTILE_SECRET_KEY not set — skipping Turnstile verification");
    return true;
  }
  if (!token) return false;
  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, response: token }),
      },
    );
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    logger.error({ err }, "Turnstile verification request failed");
    return false;
  }
}

// ── Send confirmation email via Resend ───────────────────────────
async function sendConfirmationEmail(
  firstName: string,
  email: string,
): Promise<void> {
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) {
    logger.warn("RESEND_API_KEY not set — skipping confirmation email");
    return;
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;padding:0;margin:0;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
    <div style="background:linear-gradient(135deg,#07183f,#0077b6);padding:32px 32px 28px;text-align:center;">
      <p style="margin:0 0 10px;color:rgba(255,255,255,.7);font-size:13px;letter-spacing:.08em;text-transform:uppercase;">Still Afloat Cruising</p>
      <h1 style="margin:0;color:#5dff9a;font-size:24px;font-weight:900;line-height:1.2;">Got it — you're on the radar.</h1>
    </div>
    <div style="padding:32px;">
      <p style="color:#1e3a5f;font-size:16px;line-height:1.6;margin:0 0 16px;">Hey ${firstName},</p>
      <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px;">
        Thanks for reaching out. Mark received your details and will be in touch within 24 hours.
      </p>
      <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 28px;">
        In the meantime, if you have questions you didn't include in the form,
        just reply to this email and it'll go straight to him.
      </p>
      <div style="text-align:center;margin:0 0 32px;">
        <a href="https://www.youtube.com/@StillAfloatcruising2026"
           style="display:inline-block;background:linear-gradient(135deg,#0077b6,#07183f);color:#5dff9a;font-weight:800;font-size:15px;padding:14px 28px;border-radius:12px;text-decoration:none;letter-spacing:.02em;">
          Watch Still Afloat on YouTube →
        </a>
      </div>
      <p style="color:#9ca3af;font-size:13px;line-height:1.6;margin:0;border-top:1px solid #e5e7eb;padding-top:20px;">
        Cruise smarter. Laugh more. Stay Afloat. &mdash; <strong>Still Afloat Cruising</strong>
      </p>
    </div>
  </div>
</body>
</html>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Mark at Still Afloat <mark@stillafloatcruising.com>",
        to: email,
        subject: "Got it — I'll be in touch within 24 hours ⚓",
        html,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      logger.error({ status: res.status, err }, "Prospect confirmation email failed");
    }
  } catch (err) {
    logger.error({ err }, "Prospect confirmation email exception");
  }
}

// ── Send internal alert to Mark ───────────────────────────────────
async function sendInternalAlert(
  prospect: Record<string, unknown>,
): Promise<void> {
  const apiKey      = process.env["RESEND_API_KEY"];
  const alertEmail  = process.env["APPROVAL_EMAIL"];
  if (!apiKey || !alertEmail) return;

  const rows = Object.entries(prospect)
    .filter(([k]) => k !== "id" && k !== "created_at")
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px;color:#555;font-size:13px;white-space:nowrap;border-bottom:1px solid #eee;">${k}</td>` +
        `<td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #eee;">${v ?? "—"}</td></tr>`,
    )
    .join("");

  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f0f4f8;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.1)">
  <div style="background:#07183f;padding:20px 28px;">
    <h2 style="margin:0;color:#5dff9a;font-size:18px;">New Work With Mark Inquiry</h2>
  </div>
  <div style="padding:24px 28px;">
    <p style="margin:0 0 16px;color:#1e3a5f;font-size:14px;">
      A new prospect just submitted the contact form on stillafloatcruising.com.
    </p>
    <table style="border-collapse:collapse;width:100%">${rows}</table>
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #eee;text-align:center;">
      <a href="https://stillafloatcruising.com" style="color:#0077b6;font-size:13px;">Visit Still Afloat</a>
    </div>
  </div>
</div>
</body></html>`;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Still Afloat Agent <noreply@stillafloatcruising.com>",
        to: alertEmail,
        subject: `New inquiry from ${prospect.first_name} ${prospect.last_name} — ${prospect.destination || "destination TBD"}`,
        html,
      }),
    });
  } catch (err) {
    logger.error({ err }, "Internal prospect alert email failed");
  }
}

// ── GET /api/public-config ───────────────────────────────────────
router.get("/public-config", (_req: Request, res: Response) => {
  res.json({
    turnstileSiteKey: process.env["TURNSTILE_SITE_KEY"] || "",
  });
});

// ── POST /api/contact ────────────────────────────────────────────
router.post("/contact", async (req: Request, res: Response) => {
  try {
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    if (isRateLimited(ip)) {
      return res
        .status(429)
        .json({ error: "Too many submissions. Please try again later." });
    }

    const body = req.body as Record<string, unknown>;

    // ── Validate required fields ─────────────────────────────────
    const firstName = String(body.first_name || "").trim();
    const lastName  = String(body.last_name  || "").trim();
    const email     = String(body.email      || "").trim().toLowerCase();
    const numTrav   = Number(body.num_travelers);
    const dates     = String(body.travel_dates || "").trim();

    if (!firstName || firstName.length < 1) {
      return res.status(400).json({ error: "First name is required." });
    }
    if (!lastName || lastName.length < 1) {
      return res.status(400).json({ error: "Last name is required." });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    if (!numTrav || numTrav < 1 || numTrav > 20) {
      return res.status(400).json({ error: "Please tell us how many travelers (1–20)." });
    }
    if (!dates) {
      return res.status(400).json({ error: "Please enter your approximate travel dates." });
    }

    // ── Turnstile verification ────────────────────────────────────
    const turnstileToken = (body["cf-turnstile-response"] as string) || null;
    const turnstileOk    = await verifyTurnstile(turnstileToken);
    if (!turnstileOk) {
      logger.warn({ ip }, "Turnstile verification failed — prospect blocked");
      return res.status(400).json({
        error:
          "Verification failed. Please refresh the page and try again.",
      });
    }

    // ── Build prospect object ─────────────────────────────────────
    const prospect = {
      first_name:       firstName,
      last_name:        lastName,
      email,
      phone:            body.phone       ? String(body.phone).trim()  : null,
      preferred_lang:   body.preferred_lang === "es" ? "es" : "en",
      num_travelers:    numTrav,
      travel_dates:     dates,
      destination:      body.destination       ? String(body.destination)       : null,
      cruise_line_pref: body.cruise_line_pref  ? String(body.cruise_line_pref)  : null,
      budget_range:     body.budget_range      ? String(body.budget_range)      : null,
      first_time:       body.first_time === true || body.first_time === "true",
      referral_source:  body.referral_source   ? String(body.referral_source)   : null,
      notes:            body.notes             ? String(body.notes).slice(0, 1000) : null,
      status:           "new",
    };

    // ── Insert into Supabase ──────────────────────────────────────
    const supabase = getSupabase();
    const { error: insertErr } = await supabase
      .from("prospects")
      .insert(prospect);

    if (insertErr) {
      logger.error({ err: insertErr }, "Prospect insert failed");
      return res.status(500).json({
        error:
          "Something went wrong on our end. Please email Mark directly at mark@stillafloatcruising.com and he'll get back to you.",
      });
    }

    logger.info(
      { email, destination: prospect.destination },
      "New prospect saved",
    );

    // ── Fire-and-forget emails ────────────────────────────────────
    void sendConfirmationEmail(firstName, email);
    void sendInternalAlert({ ...prospect });

    return res.json({
      ok: true,
      message: "Thank you — Mark will be in touch within 24 hours.",
    });
  } catch (err) {
    logger.error({ err }, "Contact route error");
    return res
      .status(500)
      .json({ error: "An unexpected error occurred. Please try again." });
  }
});

export default router;
