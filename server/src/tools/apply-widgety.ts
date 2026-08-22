// apply-widgety.ts — operator plan colours -> the per-room bible columns, self-calibrated.
//
// Successor to apply-widgety.mjs, rebuilt 2026-08-20 after the category-level purity gate
// stalled on MSC: their plan colours encode EXPERIENCE tiers, so one colour legitimately
// maps to "Balcony Bella" AND "Balcony Fantastica" AND "Balcony Aurea" — three names, one
// physical room type. The gate now tests what the bible actually stores:
//
//   * If a colour's anchors agree >=95% on the full CATEGORY NAME, write the name (plus
//     category_source), and the fill derives the rest.
//   * Else, if they still agree >=95% on the derived ATTRIBUTES (view, real_ocean, tier),
//     write those three columns directly, leave category NULL, and record in category_source
//     why the name stayed open. A guest is told the truth about the room; the tier label
//     MSC would print on the invoice is not ours to guess.
//   * Else the colour says nothing and the room is left alone.
//
// The derivation is IMPORTED from cabin-derive.ts — never copied (the hump lesson).
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error — `ws` ships no types; passed straight through to supabase-js.
import ws from "ws";
import fs from "fs";
import { viewOf, tierOf } from "../lib/cabin-derive.js";

const WRITE = process.argv.includes("--write");
// --explain <ship>: for every DECLINED colour on that ship, print what the nearby anchors
// vote — the tool for "why won't aqua resolve" instead of guessing at palettes.
const EXPLAIN = (() => { const i = process.argv.indexOf("--explain"); return i > 0 ? process.argv[i + 1] : null; })();
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error("env missing"); process.exit(1); }
if (url.includes("gbjfrnrkkjnutmogdzln") && process.env.ALLOW_PROD !== "1") {
  console.error("PROD detected and ALLOW_PROD!=1 — aborting."); process.exit(1);
}
const sb = createClient(url, key, { realtime: { transport: ws }, auth: { persistSession: false } });
const reads: Record<string, { num: string; hex: string; x?: number; y?: number }[]> =
  JSON.parse(fs.readFileSync("widgety-reads.json", "utf8"));

type Row = { id: number; cabin_num: string; category: string | null; view: string | null; pos_across: number | null };
const rgb = (hex: string) => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] as const;
const dist = (a: readonly number[], b: readonly number[]) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);
const chroma = (c: readonly number[]) => Math.max(c[0]!, c[1]!, c[2]!) - Math.min(c[0]!, c[1]!, c[2]!);
// white and light-grey are DIFFERENT NCL categories ~10 apart; saturated colours spray ~36
const tol = (c: readonly number[]) => (chroma(c) < 24 ? 12 : 36);

async function main() {
  const gridByKey = new Map<string, Map<string, Row>>();
  for (const key2 of Object.keys(reads)) {
    const [ship, deckS] = key2.split("|");
    const { data, error } = await sb.from("cabins")
      .select("id,cabin_num,category,view,pos_across").eq("ship_slug", ship!).eq("deck", Number(deckS));
    if (error) { console.error(`${key2}: ${error.message}`); continue; }
    gridByKey.set(key2, new Map((data as Row[]).map((r) => [r.cabin_num, r])));
  }

  // anchors pool per ship — the palette belongs to the operator's plan set, not the deck
  const anchorsByShip = new Map<string, { c: readonly number[]; cat: string }[]>();
  for (const [key2, rooms] of Object.entries(reads)) {
    const ship = key2.split("|")[0]!;
    const byNum = gridByKey.get(key2); if (!byNum) continue;
    for (const r of rooms) {
      const g = byNum.get(r.num);
      if (!g?.category) continue;
      if (!anchorsByShip.has(ship)) anchorsByShip.set(ship, []);
      anchorsByShip.get(ship)!.push({ c: rgb(r.hex), cat: g.category });
    }
  }

  const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? NaN;

  // ship-pooled y-bands as the fallback: a balcony-heavy deck can lack 12 labeled INSIDE
  // rooms on its own image, but the strips of one plan set share orientation and centring,
  // so the ship's other images can calibrate it.
  const shipBands = new Map<string, { inside: number[]; out: number[] }>();
  for (const [key2, rooms] of Object.entries(reads)) {
    const ship = key2.split("|")[0]!;
    const byNum = gridByKey.get(key2); if (!byNum) continue;
    if (!shipBands.has(ship)) shipBands.set(ship, { inside: [], out: [] });
    const b = shipBands.get(ship)!;
    for (const r of rooms) {
      if (r.y == null) continue;
      const g = byNum.get(r.num);
      if (!g?.category) continue;
      const e = Math.abs(r.y - 0.5);
      if (/inside|interior|studio/i.test(g.category)) b.inside.push(e);
      else if (/balcony|veranda/i.test(g.category)) b.out.push(e);
    }
  }
  const shipStats = new Map<string, { t: number }>();
  for (const [ship, b] of shipBands) {
    if (b.inside.length < 20 || b.out.length < 20) continue;
    const i = med([...b.inside]), o = med([...b.out]);
    if (o - i > 0.1) shipStats.set(ship, { t: (i + o) / 2 });
  }

  let wroteName = 0, wroteAttrs = 0, wroteEdge = 0;
  for (const [key2, rooms] of Object.entries(reads)) {
    const ship = key2.split("|")[0]!;
    const byNum = gridByKey.get(key2); if (!byNum) continue;
    const anchors = anchorsByShip.get(ship) ?? [];
    type Verdict = { kind: "name" | "attrs" | "edge"; cat?: string; view?: string; real_ocean?: boolean; tier?: number; top: number; tot: number } | null;
    const cache = new Map<string, Verdict>();

    const verdict = (hex: string): Verdict => {
      if (cache.has(hex)) return cache.get(hex)!;
      const c = rgb(hex);
      const votes = new Map<string, number>();
      for (const a of anchors) if (dist(a.c, c) <= Math.min(tol(c), tol(a.c))) {
        votes.set(a.cat, (votes.get(a.cat) ?? 0) + 1);
      }
      const tot = [...votes.values()].reduce((x, y) => x + y, 0);
      let out: Verdict = null;
      if (tot >= 5) {
        const sorted = [...votes.entries()].sort((x, y) => y[1] - x[1]);
        const [cat, top] = sorted[0]!;
        if (top / tot >= 0.95) {
          out = { kind: "name", cat, top, tot };
        } else {
          // names disagree — grade EACH attribute on its own evidence. MSC's Yacht Club colour
          // votes "Yacht Club Deluxe":31 / "Balcony":4 — every vote agrees the room faces the
          // sea, only the tier splits. Demanding the whole tuple be pure threw away the part
          // the votes are unanimous about.
          const pureOne = <T>(pick: (name: string) => T): { v: T; n: number } | null => {
            const m = new Map<string, { v: T; n: number }>();
            for (const [name, n] of votes) {
              const v = pick(name);
              const k = JSON.stringify(v);
              m.set(k, { v, n: (m.get(k)?.n ?? 0) + n });
            }
            const [best] = [...m.values()].sort((x, y) => y.n - x.n);
            return best && best.n / tot >= 0.95 && best.v !== null ? best : null;
          };
          const vw = pureOne((name) => {
            const { view, real_ocean } = viewOf(name);
            return view === null ? null : { view, real_ocean };
          });
          const tr = pureOne((name) => tierOf(name));
          if (vw) {
            out = { kind: "attrs", view: vw.v!.view!, real_ocean: vw.v!.real_ocean!,
                    tier: tr ? (tr.v as number) : undefined, top: vw.n, tot };
          }
        }
      }
      cache.set(hex, out);
      return out;
    };

    // this image's own inboard/outboard bands, from its labeled rooms
    let imgStats: { t: number } | null = null;
    {
      const inside: number[] = [], out: number[] = [];
      for (const r of rooms) {
        if (r.y == null) continue;
        const g = byNum.get(r.num);
        if (!g?.category) continue;
        const e = Math.abs(r.y - 0.5);
        if (/inside|interior|studio/i.test(g.category)) inside.push(e);
        else if (/balcony|veranda/i.test(g.category)) out.push(e);
      }
      if (inside.length >= 12 && out.length >= 12) {
        const i = med(inside), o = med(out);
        if (o - i > 0.1) imgStats = { t: (i + o) / 2 };
      }
      // the image couldn't calibrate itself — fall back to the ship's pooled bands
      imgStats ??= shipStats.get(ship) ?? null;
    }

    let byName = 0, byAttrs = 0, declined = 0, notInGrid = 0;
    for (const r of rooms) {
      const g = byNum.get(r.num);
      if (!g) { notInGrid++; continue; }
      if (g.category !== null || g.view !== null) continue;
      let v = verdict(r.hex);
      if (!v && r.y != null && imgStats) {
        // the Balcony-vs-Inside white tie, split by position ON THE IMAGE ITSELF. The grid's
        // pos_across is degenerate on centreline-registered hulls (aqua: every room 0.4995),
        // but the plan drew every room somewhere: outboard rows at the strip's edges are
        // balconies, mid-corridor rows are insides — calibrated from THIS image's own
        // labeled rooms, never assumed.
        const c = rgb(r.hex);
        const votes = new Map<string, number>();
        for (const a of anchors) if (dist(a.c, c) <= Math.min(tol(c), tol(a.c))) {
          votes.set(a.cat, (votes.get(a.cat) ?? 0) + 1);
        }
        const tot = [...votes.values()].reduce((x, y) => x + y, 0);
        const sorted = [...votes.entries()].sort((x, y) => y[1] - x[1]);
        if (tot >= 10 && sorted.length >= 2) {
          const inFam = sorted.filter(([k]) => /inside|interior|studio/i.test(k));
          const outFam = sorted.filter(([k]) => /balcony|veranda/i.test(k));
          const famTot = [...inFam, ...outFam].reduce((x, [, n]) => x + n, 0);
          if (famTot / tot >= 0.95 && inFam.length && outFam.length) {
            const e = Math.abs(r.y - 0.5);
            const cat = e > imgStats.t + 0.02 ? outFam[0]![0]
                      : e < imgStats.t - 0.02 ? inFam[0]![0] : null;
            if (cat) v = { kind: "edge", cat, top: famTot, tot };
          }
        }
      }
      if (!v) {
        declined++;
        if (EXPLAIN === ship && r.y != null) {
          const c2 = rgb(r.hex);
          const votes2 = new Map<string, number>();
          for (const a of anchors) if (dist(a.c, c2) <= Math.min(tol(c2), tol(a.c))) {
            votes2.set(a.cat, (votes2.get(a.cat) ?? 0) + 1);
          }
          const tot2 = [...votes2.values()].reduce((x, y) => x + y, 0);
          const fam2 = [...votes2.entries()].filter(([k]) => /inside|interior|studio|balcony|veranda/i.test(k)).reduce((x, [, n]) => x + n, 0);
          const why = !imgStats ? "no y-bands"
            : tot2 < 10 ? `few votes (${tot2})`
            : fam2 / tot2 < 0.95 ? `families ${Math.round(100 * fam2 / tot2)}%`
            : `dead zone (e=${Math.abs(r.y - 0.5).toFixed(3)} t=${imgStats.t.toFixed(3)})`;
          console.log(`  DECLINE-WHY ${r.num} #${r.hex}: ${why}`);
        }
        if (EXPLAIN === ship) {
          const c = rgb(r.hex);
          const votes = new Map<string, number>();
          for (const a of anchors) if (dist(a.c, c) <= Math.min(tol(c), tol(a.c))) {
            votes.set(a.cat, (votes.get(a.cat) ?? 0) + 1);
          }
          const top = [...votes.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4)
            .map(([k, n]) => `${k}:${n}`).join("  ");
          console.log(`  DECLINED ${r.num} #${r.hex} -> ${top || "(no anchors in range)"}`);
        }
        continue;
      }
      if (WRITE) {
        const patch = v.kind === "edge"
          ? { category: v.cat,
              category_source: `operator plan colour + plan position: the plan paints Balcony and Inside the same colour; this room sits in the ${/inside|interior|studio/i.test(v.cat!) ? "mid-corridor" : "outboard"} band calibrated from this very deck image's labeled rooms (${v.top}/${v.tot} colour votes in the two families)` }
          : v.kind === "name"
          ? { category: v.cat,
              category_source: `operator plan colour (Widgety asset), ${v.top}/${v.tot} anchors agree on this name` }
          : { view: v.view, real_ocean: v.real_ocean,
              ...(v.tier !== undefined ? { tier: v.tier } : {}),
              category_source: `operator plan colour (Widgety asset): ${v.top}/${v.tot} anchors agree the room is ${v.view === "ocean" ? "sea-facing" : v.view}${v.tier !== undefined ? `/tier ${v.tier}` : ""}, but split on the operator's name — name left open` };
        const { error } = await sb.from("cabins").update(patch).eq("id", g.id);
        if (error) { console.error(`  ${ship} ${r.num}: ${error.message}`); continue; }
      }
      if (v.kind === "edge") { wroteEdge++; }
      else if (v.kind === "name") { byName++; wroteName++; } else { byAttrs++; wroteAttrs++; }
    }
    console.log(`${key2}: ${rooms.length} read, ${anchors.length} anchors — name ${byName}, attrs ${byAttrs}, declined ${declined}${notInGrid ? `, not-in-grid ${notInGrid}` : ""}`);
  }
  console.log(`\n${WRITE ? "wrote" : "would write"}: ${wroteName} by name, ${wroteAttrs} by attributes, ${wroteEdge} by colour+position`);
}
main().catch((e) => { console.error(e); process.exit(1); });
