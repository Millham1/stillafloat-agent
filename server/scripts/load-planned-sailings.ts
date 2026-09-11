// load-planned-sailings.ts — operator itineraries from the Widgety archive into the DB.
//
//   node load-planned-sailings.mjs <dir-with-ship.json-files> [--dry-run] [--no-routes]
//
// Reads every *.json under <dir>, parses the operator's sailings
// (lib/planned-sailings.ts), matches ship titles to the registry, upserts
// planned_sailings by ref, then computes and stores one water route per
// distinct consecutive port pair (port_routes) with lib/sea-route.ts. Pure
// REST against Supabase using SUPABASE_URL + service key from the env
// (shared.env on the boxes); nothing else is touched.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseWidgetyShip, withEndDates, type PlannedSailing } from "../src/lib/planned-sailings";
import { seaRoute, setSeaRouteLogger } from "../src/lib/sea-route";

const [, , dirArg, ...flags] = process.argv;
if (!dirArg) { console.error("usage: load-planned-sailings <dir> [--dry-run] [--no-routes]"); process.exit(2); }
const DRY = flags.includes("--dry-run");
const ROUTES = !flags.includes("--no-routes");
const URL = (process.env["SUPABASE_URL"] ?? "").replace(/^["']|["']$/g, "");
const KEY = (process.env["SUPABASE_SERVICE_KEY"] ?? process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "").replace(/^["']|["']$/g, "");
if (!DRY && (!URL || !KEY)) { console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY missing"); process.exit(2); }
setSeaRouteLogger(() => {});

async function rest(pathq: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${URL}/rest/v1/${pathq}`, { ...init, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${pathq} -> ${res.status} ${await res.text()}`);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}
function norm(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

async function main() {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && e.name.endsWith(".json")) files.push(p); } };
  walk(dirArg);
  let all: PlannedSailing[] = [];
  for (const f of files) {
    try { all.push(...parseWidgetyShip(JSON.parse(fs.readFileSync(f, "utf8")))); } catch (e) { console.warn("skip", f, (e as Error).message); }
  }
  all = withEndDates(all);
  const registry = DRY ? [] : (await rest("ships?select=name,mmsi&active=eq.true&limit=1000")) as { name: string; mmsi: string | null }[];
  const byName = new Map(registry.map((r) => [norm(r.name), r]));
  let matched = 0;
  const rows = all.map((s) => {
    const reg = byName.get(norm(s.shipName)) ?? null;
    if (reg) matched += 1;
    return {
      source: s.source, ref: s.ref, ship_name: reg?.name ?? s.shipName, mmsi: reg?.mmsi ?? null, operator: s.operator,
      start_date: s.startDate, end_date: s.endDate, from_code: s.fromCode, to_code: s.toCode,
      ports: s.ports.map((p) => ({ ...p, ordered: s.ordered })), updated_at: new Date().toISOString(),
    };
  });
  const ships = new Set(all.map((s) => s.shipName));
  const resolvedMentions = all.reduce((n, s) => n + s.ports.filter((p) => p.slug).length, 0);
  const mentions = all.reduce((n, s) => n + s.ports.length, 0);
  console.log(`files ${files.length} | ships ${ships.size} | sailings ${all.length} (${matched} on registry ships) | ports resolved ${resolvedMentions}/${mentions}`);
  const pairs = new Map<string, { a: { lat: number; lon: number }; b: { lat: number; lon: number } }>();
  for (const s of all) {
    const rp = s.ports.filter((p) => p.slug && p.lat !== null && p.lon !== null);
    for (let i = 0; i + 1 < rp.length; i++) {
      const a = rp[i]!, b = rp[i + 1]!;
      if (a.slug === b.slug) continue;
      pairs.set(`${a.slug}>${b.slug}`, { a: { lat: a.lat!, lon: a.lon! }, b: { lat: b.lat!, lon: b.lon! } });
    }
  }
  console.log(`distinct port-pair legs: ${pairs.size}`);
  if (DRY) { console.log("dry run: nothing written"); return; }
  for (let i = 0; i < rows.length; i += 500) {
    await rest("planned_sailings?on_conflict=ref", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)) });
    process.stdout.write(`sailings upserted ${Math.min(i + 500, rows.length)}/${rows.length}\r`);
  }
  console.log("");
  if (!ROUTES) return;
  const existing = new Set(((await rest("port_routes?select=from_slug,to_slug&limit=10000")) as { from_slug: string; to_slug: string }[]).map((r) => `${r.from_slug}>${r.to_slug}`));
  let done = 0, failed = 0, skipped = 0; const batch: unknown[] = [];
  const flush = async () => { if (!batch.length) return; await rest("port_routes?on_conflict=from_slug,to_slug", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(batch.splice(0)) }); };
  for (const [key, { a, b }] of pairs) {
    if (existing.has(key)) { skipped += 1; continue; }
    const [from, to] = key.split(">");
    const r = await seaRoute(a, b).catch(() => null);
    if (!r || !r.points || r.points.length < 2) { failed += 1; continue; }
    batch.push({ from_slug: from, to_slug: to, points: r.points, nm: Math.round(r.nm * 10) / 10, source: "searoute-js", computed_at: new Date().toISOString() });
    done += 1;
    if (batch.length >= 100) { await flush(); process.stdout.write(`routes ${done} computed, ${failed} no path, ${skipped} existing\r`); }
  }
  await flush();
  console.log(`\nroutes: ${done} computed, ${failed} no water path, ${skipped} already stored`);
}
main().catch((e) => { console.error(e); process.exit(1); });
