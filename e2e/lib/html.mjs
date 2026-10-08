// e2e/lib/html.mjs — small, dependency-free readers for the static pages.
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
};
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) || [];
const stripScripts = (html) => html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ");

export const title = (html) => (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim();
export const h1s = (html) => [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
export const htmlLang = (html) => attr(tags(html, "html")[0] || "", "lang") || "";
export const canonical = (html) => tags(html, "link").filter((t) => /rel\s*=\s*["']?canonical/i.test(t)).map((t) => attr(t, "href"))[0] || "";
export const hreflangs = (html) => Object.fromEntries(tags(html, "link").filter((t) => /hreflang/i.test(t)).map((t) => [attr(t, "hreflang"), attr(t, "href")]));
export const metaContent = (html, name) => tags(html, "meta").filter((t) => new RegExp(`(name|property)\\s*=\\s*["']${name}["']`, "i").test(t)).map((t) => attr(t, "content"))[0] || "";
export const scripts = (html) => tags(html, "script").map((t) => attr(t, "src")).filter(Boolean);
export const stylesheets = (html) => tags(html, "link").filter((t) => /rel\s*=\s*["']?stylesheet/i.test(t)).map((t) => attr(t, "href")).filter(Boolean);
export const images = (html) => tags(stripScripts(html), "img").map((t) => attr(t, "src")).filter(Boolean);
export const links = (html) => tags(stripScripts(html), "a").map((t) => attr(t, "href")).filter(Boolean);
/** Visible text, scripts and styles removed. */
export const visibleText = (html) => stripScripts(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
/** "/api/…" paths a page's own inline scripts and markup mention. */
export const apiMentions = (text) => [...new Set([...text.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/.]+)/g)].map((m) => m[1]))];
/** Absolute URL for a reference found on `pageUrl`; null for mailto:, tel:, #, javascript:, data:. */
export function resolve(ref, pageUrl) {
  if (!ref || /^(mailto:|tel:|javascript:|data:|#)/i.test(ref)) return null;
  try { return new URL(ref, pageUrl).toString(); } catch { return null; }
}
/** Same-site test: is `url` on the host being tested, or on the production host name? */
export const sameSite = (url, base) => {
  try { const h = new URL(url).host; return h === new URL(base).host || h === "stillafloatcruising.com" || h === "www.stillafloatcruising.com"; } catch { return false; }
};
/** Rewrite a production-host URL onto the box being tested, so dev checks follow dev pages. */
export const onBase = (url, base) => {
  try { const u = new URL(url); const b = new URL(base); if (u.host === "stillafloatcruising.com" || u.host === "www.stillafloatcruising.com") { u.protocol = b.protocol; u.host = b.host; } return u.toString(); } catch { return url; }
};
