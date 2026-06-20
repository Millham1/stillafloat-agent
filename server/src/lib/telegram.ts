import { logger } from "./logger";

// Telegram nudge for the marketing approval loop. Reuses the same bot/env as the
// news agent (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID in shared env). No-ops if
// either is missing — a missing token must never break generation.

const SITE = "https://stillafloatcruising.com";

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Build a token-bearing review URL (token only in the private Telegram message).
export function reviewUrl(path: string): string {
  const tok = process.env["AGENT_APPROVAL_TOKEN"];
  return `${SITE}${path}${tok ? `?token=${encodeURIComponent(tok)}` : ""}`;
}

export async function notifyTelegram(opts: {
  heading: string; // may contain HTML (e.g. <b>…</b>)
  lines?: string[]; // escaped automatically
  url?: string;
  buttonLabel?: string;
}): Promise<{ success: boolean; reason?: string }> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chatId) {
    logger.warn("Telegram skipped — missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    return { success: false, reason: "missing token/chat" };
  }

  const api = `https://api.telegram.org/bot${token}/sendMessage`;
  const text = opts.heading + (opts.lines?.length ? `\n\n${opts.lines.map(esc).join("\n")}` : "");
  const base = { chat_id: chatId, parse_mode: "HTML", disable_web_page_preview: true };

  // Attempt 1: inline-keyboard URL button.
  if (opts.url) {
    try {
      const r = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...base,
          text,
          reply_markup: { inline_keyboard: [[{ text: opts.buttonLabel ?? "Review →", url: opts.url }]] },
        }),
      });
      const j = (await r.json()) as { ok?: boolean };
      if (r.ok && j.ok) return { success: true };
    } catch (err) {
      logger.warn({ err }, "Telegram button send threw — falling back");
    }
  }

  // Attempt 2: plain link in body (always tappable).
  try {
    const body = opts.url ? `${text}\n\n${opts.url}` : text;
    const r = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, text: body }),
    });
    const j = (await r.json()) as { ok?: boolean; description?: string };
    return r.ok && j.ok ? { success: true } : { success: false, reason: j.description ?? `HTTP ${r.status}` };
  } catch (err) {
    return { success: false, reason: (err as Error).message };
  }
}
