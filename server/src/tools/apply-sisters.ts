// apply-sisters.ts — the last derivation tier: what a room's SISTERS know about it.
//
// Mark, 2026-08-20: "we should be able to at least derive them from the sister ships."
// Class layouts are byte-identical across derived_from families (verified 8/19), so a room
// number resolved on one sister answers for the same number on another. Two tiers:
//   unanimous  -> the sisters agree on the NAME: write category (handled by SQL upstream)
//   attributes -> the sisters split on the operator's experience-tier name (Bella/Fantastica…)
//                 but agree on what the room IS: write view/real_ocean/tier, name stays open —
//                 the same rule apply-widgety uses, through the same shared derivation.
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error ws ships no types
import ws from "ws";
import { viewOf, tierOf } from "../lib/cabin-derive.js";

const WRITE = process.argv.includes("--write");
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("env missing"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") {
  console.error("PROD detected and ALLOW_PROD!=1 — aborting."); process.exit(1);
}
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });

async function main() {
  const { data: fleet } = await sb.from("cabin_ships").select("slug,derived_from").eq("in_fleet", true);
  const fam = new Map<string, string[]>();
  for (const s of fleet!) {
    const rep = s.derived_from || s.slug;
    fam.set(rep, [...(fam.get(rep) ?? []), s.slug]);
  }
  const repOf = new Map<string, string>();
  for (const [rep, slugs] of fam) for (const s of slugs) repOf.set(s, rep);

  // paginate — .select() without .range() caps at 1000 rows and SILENTLY drops the rest,
  // the exact bug this project has now hit twice
  const open: { id: number; ship_slug: string; deck: number; cabin_num: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("cabins")
      .select("id,ship_slug,deck,cabin_num").is("view", null)
      .order("id").range(from, from + 999);
    if (error) { console.error("select failed:", error.message); process.exit(1); }
    open.push(...(data as never[] ?? []));
    if (!data || data.length < 1000) break;
  }
  console.log(`${open.length} unresolved rooms`);

  let wrote = 0, declined = 0;
  for (const r of open) {
    const sisters = (fam.get(repOf.get(r.ship_slug) ?? "") ?? []).filter((s) => s !== r.ship_slug);
    if (!sisters.length) continue;
    const { data: hits } = await sb.from("cabins").select("category")
      .in("ship_slug", sisters).eq("deck", r.deck).eq("cabin_num", r.cabin_num)
      .not("category", "is", null).not("view", "is", null);
    if (!hits?.length) continue;
    const names = [...new Set(hits.map((h) => h.category as string))];
    if (names.length < 2) continue;   // unanimous tier is SQL's job
    const attrs = names.map((n) => ({ ...viewOf(n), tier: tierOf(n) }));
    const views = new Set(attrs.map((a) => JSON.stringify([a.view, a.real_ocean])));
    if (views.size !== 1 || attrs[0]!.view === null) { declined++; continue; }
    const tiers = new Set(attrs.map((a) => a.tier));
    const patch: Record<string, unknown> = {
      view: attrs[0]!.view, real_ocean: attrs[0]!.real_ocean,
      category_source: `sister ships split on the name (${names.join(" / ")}) but agree the room is ${attrs[0]!.view === "ocean" ? "sea-facing" : attrs[0]!.view} — name left open`,
    };
    if (tiers.size === 1 && attrs[0]!.tier !== null) patch.tier = attrs[0]!.tier;
    if (WRITE) {
      const { error } = await sb.from("cabins").update(patch).eq("id", r.id);
      if (error) { console.error(`${r.ship_slug} ${r.cabin_num}: ${error.message}`); continue; }
    }
    wrote++;
  }
  console.log(`${WRITE ? "wrote" : "would write"} ${wrote} by sister attributes, declined ${declined} (attributes disagree)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
