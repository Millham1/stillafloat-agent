import { logger } from "./logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderEditorialDigest({
  stories = [],
  dashboardUrl = "",
  approvalToken = "",
}: {
  stories: Record<string, any>[];
  dashboardUrl?: string;
  approvalToken?: string;
}): string {
  const token = approvalToken ? `&token=${encodeURIComponent(approvalToken)}` : "";
  const base = dashboardUrl.replace(/\/+$/, "");

  const storyRows = stories.length === 0
    ? `<div style="padding:24px;text-align:center;color:#6b7280;font-size:15px;">
        <p style="margin:0;">The agent ran but did not return any new cruise news this cycle.</p>
        <p style="margin:8px 0 0;font-size:13px;">This is normal — the editorial filter is working. Check back next scan.</p>
      </div>`
    : stories.map((story, index) => {

   const actionButtons = base
        ? `<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
            <a href="${approveUrl}" style="background:#16a34a;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block;">✅ Approve</a>
            <a href="${holdUrl}"    style="background:#d97706;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block;">⏸ Hold</a>
            <a href="${featureUrl}" style="background:#7c3aed;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block;">⭐ Feature</a>
          </div>`
        : "";

      const impactBadge = story.impactLevel
        ? `<span style="display:inline-block;background:#f3f4f6;border:1px solid #d1d5db;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600;color:#374151;margin-right:4px;">${story.impactLevel} Impact</span>`
        : "";

      const categoryBadge = story.category
        ? `<span style="display:inline-block;background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:2px 8px;font-size:12px;color:#1d4ed8;">${story.category}</span>`
        : "";

      const reasoning = story.reasoning
        ? `<p style="margin:8px 0 0;font-size:13px;color:#6b7280;font-style:italic;">AI: ${story.reasoning}</p>`
        : "";

      return `
        <div style="border:1px solid #e5e7eb;border-radius:8px;padding:18px 20px;margin-bottom:14px;background:#fff;">
          <div style="margin-bottom:8px;">${impactBadge}${categoryBadge}</div>
          <h2 style="margin:0 0 8px;font-size:17px;color:#111827;line-height:1.4;">${index + 1}. ${story.title}</h2>
          <p style="margin:0;color:#374151;font-size:14px;line-height:1.6;">${story.summary || ""}</p>
          ${reasoning}
          ${actionButtons}
        </div>`;
    })
    .join("");

  const dashboardLink = base
    ? `<div style="text-align:center;margin:0 0 24px;">
        <a href="${base}/" style="background:#0f766e;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;display:inline-block;">Open Editorial Dashboard →</a>
      </div>`
    : "";

  return `
    <html>
      <body style="font-family:Arial,sans-serif;padding:24px;max-width:680px;margin:auto;background:#f9fafb;">
        <div style="background:#0f766e;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
          <h1 style="margin:0;font-size:22px;font-weight:700;">Still Afloat AI Editorial Digest</h1>
          <p style="margin:4px 0 0;opacity:.85;font-size:14px;">${stories.length} candidate ${stories.length === 1 ? "story" : "stories"} ready for review</p>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:24px;">
          ${dashboardLink}
          ${storyRows}
          <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;text-align:center;">Still Afloat · AI-assisted cruise &amp; travel editorial</p>
        </div>
      </body>
    </html>`;
}

export async function sendEditorialDigest({
  html,
  subject,
}: {
  html: string;
  subject: string;
}) {
  try {
    const apiKey = process.env["RESEND_API_KEY"];
    const to = process.env["APPROVAL_EMAIL"];
    const from = process.env["RESEND_FROM_EMAIL"] || "Still Afloat AI <noreply@stillafloatcruising.com>";

    const diagnostics = {
      configured: Boolean(apiKey && to),
      keyPrefix: apiKey ? apiKey.slice(0, 8) : null,
      recipient: to,
      sender: from,
    };

    if (!apiKey || !to) {
      return {
        success: false,
        provider: "resend",
        errorType: "configuration",
        message: "Missing RESEND_API_KEY or APPROVAL_EMAIL",
        diagnostics,
      };
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
    });

    const payload = await response.json();

    if (!response.ok) {
      logger.error({ status: response.status, payload, diagnostics }, "Resend delivery failure");
      return {
        success: false,
        provider: "resend",
        errorType: "delivery_failure",
        status: response.status,
        payload,
        diagnostics,
      };
    }

    return { success: true, provider: "resend", payload, diagnostics };
  } catch (error) {
    logger.error({ err: error }, "Editorial digest delivery exception");
    return {
      success: false,
      provider: "resend",
      errorType: "runtime_exception",
      message: (error as Error).message,
    };
  }
}
