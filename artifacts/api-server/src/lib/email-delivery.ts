import { logger } from "./logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderEditorialDigest({ stories = [] }: { stories: Record<string, any>[] }): string {
  return `
    <html>
      <body style="font-family:Arial,sans-serif;padding:20px;max-width:700px;margin:auto;">
        <h1 style="color:#0f766e;">Still Afloat AI Editorial Digest</h1>
        ${stories
          .map(
            (story, index) => `
          <div style="border-bottom:1px solid #e5e7eb;padding:16px 0;">
            <h2 style="margin:0 0 8px;">${index + 1}. ${story.title}</h2>
            <p style="margin:0;color:#374151;">${story.summary || ""}</p>
          </div>
        `
          )
          .join("")}
      </body>
    </html>
  `;
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
    const from = process.env["RESEND_FROM_EMAIL"] || "Still Afloat AI <onboarding@resend.dev>";

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
