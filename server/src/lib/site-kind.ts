// Is this box the PRODUCTION site? One answer, read from the box's own PUBLIC_URL.
//
// The dev-only tools (the dev storm fixture, the dev news feeder, the social poster's sink, the group journey dry run) each
// refuse to run on the production site, so a stray flag on prod cannot seed test data or pretend to post. Each had its own
// copy of one test: "PUBLIC_URL names stillafloatcruising.com or any name under it".
//
// 2026-11-14: the dev mirror got a name of its own, dev.stillafloatcruising.com (Mark: an outside tester types personal
// details on dev, so dev needs a certificate, and a certificate needs a name). Under the old test that name read as
// production: for seven minutes the dev box dropped its fixtures and would have sent a social post to the real webhook had
// one been set. So the dev mirror's name is named here, once, as NOT production. Every other name under the domain
// (www, dashboard, anything added later) still is, so a new production name is safe by default.

const DOMAIN = "stillafloatcruising.com";
const DEV_MIRROR = `dev.${DOMAIN}`;

function hostOf(url: string): string {
  const u = url.trim();
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `http://${u}`).hostname.toLowerCase(); } catch { return ""; }
}

/** true when the address is the production site (the domain itself or any name under it, except the dev mirror's own name). */
export function isProductionUrl(url: string | null | undefined): boolean {
  const host = hostOf(url ?? "");
  if (!host) return false;
  if (host === DEV_MIRROR) return false;
  return host === DOMAIN || host.endsWith(`.${DOMAIN}`);
}

/** true on a box that says where it is (PUBLIC_URL set) and is not the production site: the only place a dev-only tool may run. */
export function isTestBox(env: Record<string, string | undefined> = process.env): boolean {
  const url = env["PUBLIC_URL"] ?? "";
  return url.length > 0 && !isProductionUrl(url);
}
