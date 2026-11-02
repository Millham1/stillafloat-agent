import { Router, type IRouter, type Request, type Response } from "express";
import { clientIp } from "../lib/client-ip";
import { addressLookupWhy, lookupAddress } from "../lib/address-lookup";
import { suggestAddresses } from "../lib/address-suggest";

// The address lookup behind the details page's "Your home address" (Mark 2026-10-24, Road B): the post office's own address service, asked as the guest types.
//
//   POST /api/address/lookup   { q, city?, state?, zip?, website? } →
//        { success: true, available: false }                                       no service, or it could not be used: the page takes the address as typed
//        { success: true, available: true, suggestions: [], incomplete: true }     not enough typed yet to ask
//        { success: true, available: true, suggestions: [] }                       the post office has no such address
//        { success: true, available: true, suggestions: [{ street, city, state, zip, formatted }] }   up to five, in the post office's spelling
//
// It is a POST, not a GET, so that a home address is never in a URL (the request log drops every query string already; the web server's own log would not).
// Public, because the guest's page has no login; so it is limited per address, carries the bot trap `website` (a person never fills it), and the service
// behind it has its own hourly allowance (lib/address-lookup.ts). Nothing here logs what was typed.

const router: IRouter = Router();

/** The test box: it has a public address of its own and it is not the production site. */
const testBox = () => { const url = process.env["PUBLIC_URL"] ?? ""; return url.length > 0 && !/(^|[/.])stillafloatcruising\.com(?=[/:]|$)/i.test(url); };

const hits = new Map<string, { count: number; resetAt: number }>();
const MAX_PER_HOUR = 400;   // the type-ahead asks as the street is typed (a few times per address)   // a person typing an address asks a handful of times; this is generous for them and useless for a scraper
function limited(ip: string): boolean {
  const now = Date.now();
  if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  const e = hits.get(ip);
  if (!e || e.resetAt < now) { hits.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 }); return false; }
  e.count++;
  return e.count > MAX_PER_HOUR;
}

router.post("/address/lookup", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (limited(clientIp(req))) return res.status(429).json({ success: false, error: "Too many lookups. Please type the address in full, or try again later." });
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body["website"] === "string" && body["website"]) return res.json({ success: true, available: false }); // honeypot: a person never fills it
  const q = typeof body["q"] === "string" ? body["q"].trim() : "";
  if (q.length < 5) return res.status(400).json({ success: false, error: "Type at least five characters of the street." });
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const result = await lookupAddress({ q, city: text(body["city"]), state: text(body["state"]), zip: text(body["zip"]) });
  // Mark 2026-10-27: on the test box only, a lookup that could not be made says why (never the address), so a missing or refused key shows on the page.
  const why = !result.available && testBox() ? addressLookupWhy() : null;
  return res.json({ success: true, ...result, ...(why ? { why } : {}) });
});

// Mark 2026-10-26: the type-ahead. POST /api/address/suggest { q, website? } → { success, available, suggestions: up to five whole addresses }.
// Same limits, same bot trap, same privacy as the lookup above (lib/address-suggest.ts).
router.post("/address/suggest", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (limited(clientIp(req))) return res.status(429).json({ success: false, error: "Too many lookups. Please type the address in full, or try again later." });
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body["website"] === "string" && body["website"]) return res.json({ success: true, available: false }); // honeypot: a person never fills it
  return res.json({ success: true, ...(await suggestAddresses(body["q"])) });
});

export default router;
