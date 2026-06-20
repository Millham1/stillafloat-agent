import { logger } from "./logger";
import { readJson, writeJson, PATHS, getSupabase } from "./persistence";
import { buildUtm, fetchChannelVideos } from "./social-agent";
import { unsubscribeUrl } from "../routes/subscribe";

// ─────────────────────────────────────────────────────────────────────────────
// Newsletter agent — assembles the weekly "Still Afloat Weekly" email:
// curated approved stories + a featured video + one affiliate pick + a soft
// travel-agency P.S., in the brand voice ("Cruise smarter, laugh more"),
// value-never-hype. Produces a draft for approval; sending is a separate,
// explicit step (approve-first). English only for now (ES needs a subscriber
// lang column).
// ─────────────────────────────────────────────────────────────────────────────

const SITE = "https://stillafloatcruising.com";
const DRAFT_KEY = "newsletter-draft";

interface Story {
  id: string;
  title: string;
  summary: string;
  link: string;
  impact: string;
}

export interface NewsletterDraft {
  subject: string;
  intro: string;
  storyIds: string[];
  video?: { id: string; title: string; blurb: string; url: string; thumbnail: string };
  affiliate?: { id: string; title: string; blurb: string; imageUrl: string; link: string };
  agencyPs: string;
  generatedAt: string;
  status: "pending" | "sent";
  sentAt?: string;
}

function utm(base: string, content: string): string {
  return buildUtm(base, { source: "newsletter", medium: "email", campaign: "weekly", content });
}

async function gatherApprovedStories(): Promise<Story[]> {
  const data = await readJson<{ stories?: Record<string, unknown>[] }>(PATHS.approved, { stories: [] });
  return (data.stories ?? []).map((s) => ({
    id: String(s.id ?? ""),
    title: String(s.title ?? ""),
    summary: String(s.summary ?? s.synopsis ?? ""),
    link: String(s.link ?? s.originalLink ?? ""),
    impact: String(s.impactLevel ?? s.travelerImpact ?? ""),
  })).filter((s) => s.id && s.title);
}

async function gatherFeaturedVideo(): Promise<{ id: string; title: string; thumbnail: string } | null> {
  // Prefer the manually featured video; fall back to the latest channel upload.
  const ch = await readJson<{ featuredId?: string; videos?: Array<Record<string, unknown>> }>(
    "youtube-channel",
    {},
  );
  const vids = ch.videos ?? [];
  if (ch.featuredId) {
    const v = vids.find((x) => String(x["id"]) === ch.featuredId);
    if (v) return { id: ch.featuredId, title: String(v["title"] ?? ""), thumbnail: String(v["thumbnail"] ?? "") };
  }
  const first = vids[0];
  if (first) {
    return { id: String(first["id"] ?? ""), title: String(first["title"] ?? ""), thumbnail: String(first["thumbnail"] ?? "") };
  }
  try {
    const latest = await fetchChannelVideos(1);
    const v = latest[0];
    if (v) {
      return { id: v.id, title: v.title, thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` };
    }
  } catch (err) {
    logger.warn({ err }, "newsletter: channel video fetch failed");
  }
  return null;
}

async function gatherFeaturedAffiliate(): Promise<{ id: string; title: string; description: string; imageUrl: string; affiliateLink: string } | null> {
  const store = await readJson<{ items?: Array<Record<string, unknown>> }>(PATHS.affiliateItems, { items: [] });
  const items = store.items ?? [];
  if (items.length === 0) return null;
  const pick = items.find((i) => Boolean(i["featured"])) ?? items[0];
  if (!pick) return null;
  return {
    id: String(pick["id"] ?? ""),
    title: String(pick["title"] ?? ""),
    description: String(pick["description"] ?? ""),
    imageUrl: String(pick["imageUrl"] ?? ""),
    affiliateLink: String(pick["affiliateLink"] ?? `${SITE}/affiliate.html`),
  };
}

const SYSTEM_PROMPT = `You are the editor of "Still Afloat Weekly," a cruise & travel email newsletter.

Brand voice: "Cruise smarter, laugh more." Warm, smart, lightly funny — written by a host with 40 years of cruising. The audience is experienced, fairly affluent cruisers who value honest, useful insight.

CORE RULE — VALUE, NEVER HYPE: be specific and genuinely useful. No empty superlatives or clickbait ("you won't believe," "ultimate," "amazing," "must-see"). The subject line earns the open with real value, not shock.

You will receive this week's approved stories, a featured video, and one affiliate product. Produce:
- subject: a specific, value-led subject line (<= 60 chars), no hype, no ALL CAPS.
- intro: 1–2 warm sentences welcoming the reader and framing the week (brand voice).
- storyIds: the best 3–6 story ids, ordered most-valuable first (use ONLY ids provided).
- video_blurb: one inviting sentence about the featured video (honest, not hype).
- affiliate_blurb: one honest sentence on why the product is genuinely worth it (it's an affiliate pick — be candid, not salesy).
- agency_ps: one soft, personal P.S. offering travel-agency help (e.g., "Planning a cruise? I book them professionally now — just reply.").

Respond ONLY with JSON: { "subject", "intro", "storyIds":[], "video_blurb", "affiliate_blurb", "agency_ps" }.`;

export async function draftNewsletter(): Promise<NewsletterDraft> {
  const apiKey = process.env["OPENAI_API_KEY"] || process.env["REPLIT_OPENAI_API_KEY"] || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const [stories, video, affiliate] = await Promise.all([
    gatherApprovedStories(),
    gatherFeaturedVideo(),
    gatherFeaturedAffiliate(),
  ]);
  if (stories.length === 0) throw new Error("No approved stories to build a newsletter from");

  const userContent = JSON.stringify(
    {
      stories: stories.map((s) => ({ id: s.id, title: s.title, summary: s.summary, impact: s.impact })),
      featured_video: video ? { title: video.title } : null,
      affiliate_product: affiliate ? { title: affiliate.title, description: affiliate.description } : null,
    },
    null,
    2,
  );

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Build this week's newsletter from:\n\n${userContent}` },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (await response.json()) as any;
  const content: string = payload?.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(content) as {
    subject?: string;
    intro?: string;
    storyIds?: string[];
    video_blurb?: string;
    affiliate_blurb?: string;
    agency_ps?: string;
  };

  const validIds = new Set(stories.map((s) => s.id));
  const storyIds = (Array.isArray(parsed.storyIds) ? parsed.storyIds : [])
    .map(String)
    .filter((id) => validIds.has(id))
    .slice(0, 6);

  const draft: NewsletterDraft = {
    subject: (parsed.subject ?? "Still Afloat Weekly").trim(),
    intro: (parsed.intro ?? "").trim(),
    storyIds: storyIds.length ? storyIds : stories.slice(0, 5).map((s) => s.id),
    agencyPs: (parsed.agency_ps ?? "Planning a cruise? I book them professionally now — just reply to this email.").trim(),
    generatedAt: new Date().toISOString(),
    status: "pending",
  };
  if (video) {
    draft.video = {
      id: video.id,
      title: video.title,
      blurb: (parsed.video_blurb ?? "").trim(),
      url: utm(`https://www.youtube.com/watch?v=${video.id}`, "video"),
      thumbnail: video.thumbnail,
    };
  }
  if (affiliate) {
    draft.affiliate = {
      id: affiliate.id,
      title: affiliate.title,
      blurb: (parsed.affiliate_blurb ?? "").trim(),
      imageUrl: affiliate.imageUrl,
      link: utm(affiliate.affiliateLink, "affiliate"),
    };
  }

  logger.info({ stories: draft.storyIds.length, hasVideo: !!draft.video, hasAffiliate: !!draft.affiliate }, "Drafted newsletter");
  return draft;
}

export async function saveDraft(draft: NewsletterDraft): Promise<void> {
  await writeJson(DRAFT_KEY, draft);
}
export async function loadDraft(): Promise<NewsletterDraft | null> {
  const d = await readJson<NewsletterDraft | null>(DRAFT_KEY, null);
  return d && d.subject ? d : null;
}

// ── Enriched email renderer ──────────────────────────────────────────────────
export function renderEnrichedNewsletter(
  draft: NewsletterDraft,
  stories: Story[],
  recipientName: string,
  recipientEmail: string,
  baseUrl: string,
): string {
  const unsub = unsubscribeUrl(recipientEmail, baseUrl);
  const firstName = (recipientName || "there").split(" ")[0] || "there";
  const byId = new Map(stories.map((s) => [s.id, s]));

  const storyRows = draft.storyIds
    .map((id) => byId.get(id))
    .filter((s): s is Story => Boolean(s))
    .map((s) => {
      const storyUrl = s.link || `${baseUrl}/story.html?id=${s.id}`;
      return `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:20px 22px;margin-bottom:16px;background:#fff;">
      ${s.impact ? `<span style="display:inline-block;background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:2px 10px;font-size:12px;color:#1d4ed8;font-weight:700;margin-bottom:10px;">${s.impact}</span>` : ""}
      <h2 style="margin:0 0 10px;font-size:17px;color:#0c2035;line-height:1.4;font-weight:800;">${s.title}</h2>
      <p style="margin:0 0 14px;color:#374151;font-size:14px;line-height:1.7;">${s.summary}</p>
      <a href="${storyUrl}" style="display:inline-block;background:#0077b6;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">Read More →</a>
    </div>`;
    })
    .join("");

  const videoBlock = draft.video
    ? `
    <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin:24px 0 16px;background:#fff;">
      <a href="${draft.video.url}" style="text-decoration:none;">
        ${draft.video.thumbnail ? `<img src="${draft.video.thumbnail}" alt="" style="display:block;width:100%;max-width:600px;"/>` : ""}
        <div style="padding:16px 22px;">
          <p style="margin:0 0 4px;font-size:12px;color:#0077b6;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">▶ Watch this week</p>
          <h3 style="margin:0 0 6px;font-size:16px;color:#0c2035;font-weight:800;">${draft.video.title}</h3>
          ${draft.video.blurb ? `<p style="margin:0;color:#374151;font-size:14px;line-height:1.6;">${draft.video.blurb}</p>` : ""}
        </div>
      </a>
    </div>`
    : "";

  const affiliateBlock = draft.affiliate
    ? `
    <div style="border:1px dashed #cbd5e1;border-radius:12px;padding:18px 22px;margin:16px 0;background:#fbfdff;">
      <p style="margin:0 0 6px;font-size:12px;color:#0e7490;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">Gear worth packing</p>
      <h3 style="margin:0 0 6px;font-size:16px;color:#0c2035;font-weight:800;">${draft.affiliate.title}</h3>
      ${draft.affiliate.blurb ? `<p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.6;">${draft.affiliate.blurb}</p>` : ""}
      <a href="${draft.affiliate.link}" style="display:inline-block;background:#0e7490;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">Check it out →</a>
      <p style="margin:8px 0 0;color:#9ca3af;font-size:11px;">Affiliate link — supports Still Afloat at no cost to you.</p>
    </div>`
    : "";

  const agencyUrl = utm(`${baseUrl}/#contact`, "agency");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f0f4f8;padding:0;margin:0;">
  <div style="max-width:600px;margin:32px auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
    <div style="background:linear-gradient(135deg,#07183f,#0077b6);padding:28px 32px;text-align:center;">
      <p style="margin:0 0 6px;color:rgba(255,255,255,.6);font-size:12px;letter-spacing:.10em;text-transform:uppercase;">Still Afloat Weekly</p>
      <h1 style="margin:0 0 6px;color:#5dff9a;font-size:24px;font-weight:900;">${draft.subject}</h1>
      <p style="margin:0;color:rgba(255,255,255,.65);font-size:13px;">Your curated cruise &amp; travel intelligence</p>
    </div>
    <div style="background:#f9fafb;padding:28px 32px;">
      <p style="margin:0 0 18px;color:#1e3a5f;font-size:15px;line-height:1.6;">Hey ${firstName},${draft.intro ? ` ${draft.intro}` : ""}</p>
      ${storyRows}
      ${videoBlock}
      ${affiliateBlock}
      <div style="text-align:center;margin-top:24px;">
        <a href="${utm(`${baseUrl}/news.html`, "see-all")}" style="display:inline-block;background:linear-gradient(135deg,#0077b6,#07183f);color:#5dff9a;padding:14px 28px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;">See All Cruise News →</a>
      </div>
      ${draft.agencyPs ? `<p style="margin:24px 0 0;color:#475569;font-size:14px;line-height:1.6;border-top:1px solid #e5e7eb;padding-top:18px;"><strong>P.S.</strong> ${draft.agencyPs} <a href="${agencyUrl}" style="color:#0077b6;">Get in touch →</a></p>` : ""}
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

// ── Send (explicit, approve-first) ───────────────────────────────────────────
export async function sendNewsletterDraft(
  draft: NewsletterDraft,
  baseUrl: string,
): Promise<{ sent: number; failed: number; total: number }> {
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) throw new Error("RESEND_API_KEY missing");

  const stories = await gatherApprovedStories();
  const supabase = getSupabase();
  const { data: subscribers, error } = await supabase
    .from("subscribers")
    .select("email, name")
    .eq("status", "confirmed");
  if (error) throw new Error("Failed to load subscribers");
  const list = (subscribers ?? []) as Array<{ email: string; name: string }>;
  if (list.length === 0) return { sent: 0, failed: 0, total: 0 };

  let sent = 0;
  let failed = 0;
  for (const sub of list) {
    const html = renderEnrichedNewsletter(draft, stories, sub.name, sub.email, baseUrl);
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Still Afloat <noreply@stillafloatcruising.com>",
          to: sub.email,
          subject: draft.subject,
          html,
        }),
      });
      r.ok ? sent++ : failed++;
    } catch {
      failed++;
    }
  }
  logger.info({ subject: draft.subject, sent, failed }, "Newsletter (agent) send complete");
  return { sent, failed, total: list.length };
}

export function previewStories(draft: NewsletterDraft, stories: Story[]): Story[] {
  const byId = new Map(stories.map((s) => [s.id, s]));
  return draft.storyIds.map((id) => byId.get(id)).filter((s): s is Story => Boolean(s));
}

export { gatherApprovedStories };
