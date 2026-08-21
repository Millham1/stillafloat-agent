#!/usr/bin/env python3
"""Cabin Advisor — per-cabin NOISE NEIGHBOURHOOD from the deck plans.

Mark's rule (2026-08-17): "the idea is to have an area around each room that identifies
noise. that would work with 4 rooms fore and aft of the room and across the corridor" and
"visualize the deck plan, find the elevator lobbies and identify room numbers within 4 rooms
fore aft and inside then notate the table."

This is the fleet-scale version of the deck-by-deck read: instead of asking a model to
transcribe cabin numbers (which it can get wrong), it asks only WHERE the noise sources are
— elevator lobbies, stairwells, named public rooms — and then does the neighbourhood arithmetic
in code against the cabin positions already in Supabase (cabins.pos_along / pos_across).
So every room number written to cabins.noise_nearby comes from the database, never from a
model's reading of a number.

Reuses the deck-strip tiles the geometry pass already carved and prepped
(geometry/state.json + geometry/work/<slug>/img_NN_tN.jpg) and, like that pass, runs OFF-PLAN
through the Anthropic Message Batches API — 50% off, no Claude Code credits.

Stages (state in noise/state.json, output in noise/out/<slug>.json):
  submit   - one vision read per prepped tile: "where are the noise sources?"
  poll     - check batches; store results
  assemble - remap tile coords to strip coords, resolve strip -> deck, write noise/out/*.json
  apply    - write cabins.noise_nearby / noise_source in Supabase + tick deck_read_log
  status   - where everything stands

Usage:
  python3 noise-features.py submit [--only carnival] [--dry-run]
  python3 noise-features.py poll
  python3 noise-features.py assemble
  python3 noise-features.py apply [--only carnival] [--write]
"""
import argparse, base64, json, os, re, sys, time, urllib.request
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
GEO = HERE / "geometry"
WORK = GEO / "work"
NOISE = HERE / "noise"
OUT = NOISE / "out"
STATE_F = NOISE / "state.json"
MODEL = os.environ.get("NOISE_MODEL", "claude-sonnet-5")
API = "https://api.anthropic.com/v1"

# geometry-file slug -> Supabase cabin_ships.slug (the class rep that owns the grid)
SHIP_MAP = {
    "carnival-conquest-4": "carnival-conquest",
    "carnival-dream": "carnival-dream",
    "carnival-elation": "carnival-elation",
    "carnival-spirit-master-combo": "carnival-spirit",
    "carnival-splendor-master": "carnival-splendor",
    "carnival-sunshine-1": "carnival-sunshine",
    "carnival-vista": "carnival-vista",
    "mardi-gras": "mardi-gras",
    "norwegian-aqua": "norwegian-aqua",
    "norwegian-breakaway": "norwegian-breakaway",
    "norwegian-dawn": "norwegian-dawn",
    "norwegian-epic": "norwegian-epic",
    "norwegian-escape": "norwegian-escape",
    "norwegian-jewel": "norwegian-jewel",
    "norwegian-luna-ship": "norwegian-luna",
    "norwegian-prima": "norwegian-prima",
    "norwegian-sky": "norwegian-sky",
    "norwegian-spirit": "norwegian-spirit",
    "pride-of-america": "pride-of-america",
    "msc-world-america": "msc-world-america",
    "msc-world-asia": "msc-world-asia",
    "msc-world-atlantic": "msc-world-atlantic",
}

ANCHOR_BLOCK = """

ALSO return up to 14 stateroom numbers spread evenly across this segment, as anchors:
"anchors":[{"num":"7248","x":0.31,"y":0.09}]
Anchors are ordinary cabin numbers printed on the plan, with the centre of the cabin block.
Read their digits carefully; omit any number that is not fully legible rather than guessing."""

READ_PROMPT = """This image is one segment of a cruise-ship deck plan. Find every NOISE SOURCE on it — anything a guest asleep in a nearby stateroom would hear.

Return ONLY JSON, MINIFIED on one line:
{"features":[{"kind":"lift","label":"elevator lobby","x":0.51,"y":0.32}]}

kind is one of: lift, stairs, lifeboat, laundry, crew, galley, bar, club, theatre, restaurant, pool, kids, gym, spa, atrium, shop, medical, machinery, other
label = the words printed on the plan for it, or a short plain description if it is unlabelled ("elevator bank", "stairwell").
x,y = the CENTRE of the feature, normalized 0..1 relative to THIS image (x across its width, y down its height).

Rules:
- Lifts/elevators are drawn as a square or rectangle with an X through it, or a hatched box, usually in banks of 2-6 near the middle of the deck. Report EACH bank, even when unlabelled.
- Stairwells are drawn as a run of short parallel lines (the treads). Report EACH one, even when unlabelled.
- Also report any named public space printed on this segment: bars, lounges, clubs, discos, theatres, restaurants, buffets, galleys, pools, hot tubs, kids clubs, gyms, spas, laundries, shops, atriums, medical centres, and any machinery/engine space.
- ALSO report every LIFEBOAT and TENDER: they are drawn as rounded capsule shapes in a row
  along the outside edge of the deck, outboard of the rooms. Use kind "lifeboat", one entry per
  boat, at the centre of each. These block the view rather than making noise, but they are on
  the same plan and are worth the same read.
- Do NOT report staterooms, cabin numbers, deck numbers, category legends, or corridors.
- Be precise about x,y — the position is the whole point of this read.
- If the segment has no noise source at all, return {"features":[]}."""


def api_key():
    k = os.environ.get("ANTHROPIC_API_KEY")
    if not k:
        f = Path.home() / ".config/saf-secrets/env.txt"
        if f.exists():
            for line in f.read_text().splitlines():
                if line.startswith("ANTHROPIC_API_KEY="):
                    k = line.split("=", 1)[1].strip()
    if not k:
        sys.exit("ANTHROPIC_API_KEY not found (env or ~/.config/saf-secrets/env.txt)")
    return k


def api(method, path, body=None, raw_url=None, timeout=300):
    req = urllib.request.Request(raw_url or (API + path), method=method)
    req.add_header("x-api-key", api_key())
    req.add_header("anthropic-version", "2023-06-01")
    if body is not None:
        req.add_header("content-type", "application/json")
        req.data = json.dumps(body).encode()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# db_slug -> the directory of deck-plan images whose frame is NOT the frame the grid was
# built from (grid = deckmaps SVGs; plans = the Widgety capture). Deck number comes from the
# filename when it is in there, otherwise from the cabin anchors the read returns.
PLAN_SRC = {
    "freedom-of-the-seas": "_rcl/freedom-of-the-seas/deckplans",
    "grandeur-of-the-seas": "_rcl/grandeur-of-the-seas/deckplans",
    "icon-of-the-seas": "_rcl/icon-of-the-seas/deckplans",
    "quantum-of-the-seas": "_rcl/quantum-of-the-seas/deckplans",
    "radiance-of-the-seas": "_rcl/radiance-of-the-seas/deckplans",
    "voyager-of-the-seas": "_rcl/voyager-of-the-seas/deckplans",
    "wonder-of-the-seas": "_rcl/wonder-of-the-seas/deckplans",
    "msc-fantasia": "msc-fantasia-ship/deckplans",
    "msc-meraviglia": "msc-meraviglia/deckplans",
    "msc-poesia": "msc-poesia-ship/deckplans",
    "msc-seascape": "msc-seascape/deckplans",
    "msc-sinfonia": "msc-sinfonia-ship/deckplans",
    "msc-world-europa": "msc-world-europa/deckplans",
    "coral-princess": "_pri/coral-princess/deckplans",
    "grand-princess": "_pri/grand-princess/deckplans",
    "royal-princess": "_pri/royal-princess/deckplans",
    "sun-princess": "_pri/sun-princess/deckplans",
    # Cut from the official one-page Margaritaville plan, one strip per deck. The cabin
    # positions in the grid were written from the SAME crops, so the fit here is an identity
    # and says so — a self-check rather than a real registration.
    "margaritaville-at-sea-islander": "_mas/margaritaville-at-sea-islander/deckplans",
}
# Princess plans carry the venue names but no cabin numbers, so the anchors that register the
# plan onto the grid are parsed from the deckmaps SVG that shares the plan's exact viewBox —
# no model reads a room number for these ships either.
ANCHOR_JSON = {  # db_slug -> per-deck [cabin_num, along, across] already in the plan's frame
    "margaritaville-at-sea-islander": "_mas/islander_geom.json",
}
ANCHOR_SVG = {slug: rel.replace("/deckplans", "/svg")
              for slug, rel in [("coral-princess", "_pri/coral-princess/deckplans"),
                                ("grand-princess", "_pri/grand-princess/deckplans"),
                                ("royal-princess", "_pri/royal-princess/deckplans"),
                                ("sun-princess", "_pri/sun-princess/deckplans")]}
IMG_EXT = (".png", ".jpg", ".jpeg")
ARCHIVE = Path.home() / "Desktop/Claude Local/widgety-archive"
PLAN_WORK = NOISE / "work"
TILE_MAX = 1568       # the API's long-edge cap; tile so nothing is resampled twice
PLAN_OVERLAP = 150    # original px of overlap between adjacent tiles


def load_state():
    return json.loads(STATE_F.read_text()) if STATE_F.exists() else {"ships": {}, "batches": []}


def save_state(s):
    NOISE.mkdir(exist_ok=True)
    STATE_F.write_text(json.dumps(s, indent=1))


def geo_state():
    return json.loads((GEO / "state.json").read_text())


def targets(only):
    g = geo_state()
    for slug in SHIP_MAP:
        if slug not in g["ships"]:
            continue
        if only and only.lower() not in slug and only.lower() not in SHIP_MAP[slug]:
            continue
        yield slug, g["ships"][slug]


def submit(args):
    state = load_state()
    reqs, est_tokens, ships_in = [], 0, []
    for slug, ship in targets(args.only):
        if state["ships"].get(slug, {}).get("submitted_at"):
            continue
        ships_in.append(slug)
        for si, strip in enumerate(ship["strips"]):
            for hi, tile in enumerate(strip.get("halves", [])):
                p = WORK / slug / tile["file"]
                im = Image.open(p)
                est_tokens += (im.width * im.height) // 750 + 400
                b64 = base64.standard_b64encode(p.read_bytes()).decode()
                reqs.append({"custom_id": f"{slug}--{si:02d}--{hi}", "params": {
                    "model": MODEL, "max_tokens": 4000,
                    "messages": [{"role": "user", "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
                        {"type": "text", "text": READ_PROMPT}]}]}})
    if not reqs:
        sys.exit("nothing to submit")
    est = est_tokens * 3e-6 * 0.5 + len(reqs) * 900 * 15e-6 * 0.5
    print(f"{len(reqs)} noise reads across {len(ships_in)} ships, ~{est_tokens/1000:.0f}K input tokens, est ~${est:.2f} (Batch API, {MODEL})")
    if args.dry_run:
        return
    CHUNK = 150
    for ci in range(0, len(reqs), CHUNK):
        chunk = reqs[ci:ci + CHUNK]
        out = json.loads(api("POST", "/messages/batches", {"requests": chunk}, timeout=900))
        state["batches"].append({"id": out["id"], "n": len(chunk), "submitted": time.strftime("%F %T"),
                                 "status": out.get("processing_status")})
        save_state(state)
        print(f"submitted batch {out['id']} ({len(chunk)} requests)")
    for slug in ships_in:
        state["ships"].setdefault(slug, {})["submitted_at"] = time.strftime("%F %T")
    save_state(state)


def poll(args):
    state = load_state()
    open_b = [b for b in state["batches"] if b.get("status") != "ended"]
    if not open_b:
        print("no open batches")
        return
    for b in open_b:
        j = json.loads(api("GET", f"/messages/batches/{b['id']}"))
        b["status"] = j["processing_status"]
        print(f"{b['id']}: {b['status']}  {j.get('request_counts', {})}")
        if b["status"] == "ended":
            res = api("GET", None, raw_url=j["results_url"], timeout=600).decode()
            (NOISE / f"results_{b['id']}.jsonl").write_text(res)
            print(f"  -> noise/results_{b['id']}.jsonl")
    save_state(state)


def _parse(text):
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    feats = []
    for fm in re.finditer(r'\{"kind":\s*"([^"]*)",\s*"label":\s*"([^"]*)",\s*"x":\s*([\d.]+),\s*"y":\s*([\d.]+)\}', text):
        feats.append({"kind": fm.group(1), "label": fm.group(2), "x": float(fm.group(3)), "y": float(fm.group(4))})
    return {"features": feats} if feats else None


def _strip_to_deck(slug, ship):
    """Map strip index -> the deck entry in geometry/out/<slug>.json (greedy, by pixel size,
    in strip order — the two are written in the same order)."""
    f = GEO / "out" / f"{slug}.json"
    if not f.exists():
        return {}
    decks = json.loads(f.read_text())["decks"]
    used, out = set(), {}
    for si, strip in enumerate(ship["strips"]):
        px = list(strip["px"])
        for di, d in enumerate(decks):
            if di in used or d["source_image_px"] != px:
                continue
            used.add(di)
            out[si] = d
            break
    return out


def assemble(args):
    reads = {}
    for f in sorted(NOISE.glob("results_*.jsonl")):
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            res = row.get("result", {})
            if res.get("type") != "succeeded":
                print(f"  ! {row['custom_id']}: {res.get('type')}")
                continue
            text = "".join(b.get("text", "") for b in res["message"]["content"] if b["type"] == "text")
            p = _parse(text)
            if p is not None:
                reads[row["custom_id"]] = p
    g = geo_state()
    OUT.mkdir(parents=True, exist_ok=True)
    grand = 0
    for slug in SHIP_MAP:
        ship = g["ships"].get(slug)
        if not ship:
            continue
        s2d = _strip_to_deck(slug, ship)
        strips_out, n = [], 0
        for si, strip in enumerate(ship["strips"]):
            w, h = strip["px"]
            axis, L = strip.get("long_axis", "y"), max(strip["px"])
            feats = []
            for hi, tile in enumerate(strip.get("halves", [])):
                r = reads.get(f"{slug}--{si:02d}--{hi}")
                if not r:
                    continue
                for ft in r.get("features", []):
                    try:
                        tx, ty = float(ft["x"]), float(ft["y"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    if not (0 <= tx <= 1 and 0 <= ty <= 1):
                        continue
                    if axis == "y":
                        along = (tile["offset"] + ty * tile["len"]) / L
                        across = tx
                    else:
                        along = (tile["offset"] + tx * tile["len"]) / L
                        across = ty
                    feats.append({"kind": str(ft.get("kind") or "other").lower().strip(),
                                  "label": str(ft.get("label") or "").strip()[:60],
                                  "along": round(along, 4), "across": round(across, 4)})
            # de-dup features seen twice in the tile overlap
            keep = []
            for ft in sorted(feats, key=lambda f: (f["kind"], f["along"])):
                if any(k["kind"] == ft["kind"] and abs(k["along"] - ft["along"]) < 0.012
                       and abs(k["across"] - ft["across"]) < 0.12 for k in keep):
                    continue
                keep.append(ft)
            d = s2d.get(si)
            anchors = [{"num": str(c["num"]),
                        "along": c["y"] if axis == "y" else c["x"],
                        "across": c["x"] if axis == "y" else c["y"]}
                       for c in (d or {}).get("cabins", [])
                       if isinstance(c.get("x"), (int, float)) and isinstance(c.get("y"), (int, float))]
            strips_out.append({"strip": si, "px": strip["px"], "long_axis": axis,
                               "deck_hint": (d or {}).get("deck"),
                               "deck_cabins": [c["num"] for c in (d or {}).get("cabins", [])][:400],
                               "anchors": anchors,
                               "features": keep})
            n += len(keep)
        (OUT / f"{slug}.json").write_text(json.dumps(
            {"slug": slug, "db_slug": SHIP_MAP[slug], "model": MODEL, "strips": strips_out}, indent=1))
        print(f"{slug:32s} strips={len(strips_out):3d} features={n}")
        grand += n
    print(f"total features: {grand}")



# ---------------------------------------------------------------- plan-source path
# Lines whose deck-plan images are NOT the images the cabin grid was built from (Royal
# Caribbean: grid from deckmaps SVGs, plans from the Widgety capture). The deck number is
# known from the filename, but the image frame is not the DB frame — so each read also
# returns cabin-number ANCHORS, and `apply` fits image coords onto cabins.pos_along /
# pos_across before doing any neighbourhood arithmetic. A deck whose fit is poor is left
# alone and reported, never guessed at.

def plan_prep(args):
    """Tile every plan image so each tile lands at the API's 1568px cap without a second resample."""
    state = load_state()
    n = 0
    for db_slug, rel in PLAN_SRC.items():
        if args.only and args.only.lower() not in db_slug:
            continue
        src = ARCHIVE / rel
        if not src.exists():
            print(f"  ! {db_slug}: {src} missing")
            continue
        d = PLAN_WORK / db_slug
        d.mkdir(parents=True, exist_ok=True)
        files = sorted(f for f in src.iterdir() if f.suffix.lower() in IMG_EXT)
        decks = []
        for idx, f in enumerate(files):
            m = re.match(r"deck[_ ]?(\d+)", f.stem, re.I)
            deck = int(m.group(1)) if m else None      # else: resolved from the cabin anchors
            im = Image.open(f).convert("RGB")
            w, h = im.size
            axis = "x" if w >= h else "y"
            L, short = (w, h) if axis == "x" else (h, w)
            step = max(1, int(TILE_MAX * short / TILE_MAX)) if False else short  # square tiles
            k = max(1, round(L / step))
            step = L / k
            tiles = []
            for ti in range(k):
                a = max(0, int(ti * step) - (PLAN_OVERLAP if ti else 0))
                b = min(L, int((ti + 1) * step) + (PLAN_OVERLAP if ti < k - 1 else 0))
                part = im.crop((a, 0, b, h) if axis == "x" else (0, a, w, b))
                # scale every tile to the API's long-edge cap: shrinking a huge plan avoids a
                # second server-side resample, and enlarging a small one is what makes a
                # 410px-wide Princess strip legible at all
                k2 = TILE_MAX / max(part.size)
                if abs(k2 - 1) > 0.02:
                    part = part.resize((max(1, int(part.width * k2)), max(1, int(part.height * k2))),
                                       Image.LANCZOS)
                fn = f"p{idx:02d}_t{ti}.jpg"
                part.save(d / fn, quality=88)
                tiles.append({"file": fn, "offset": a, "len": b - a})
            decks.append({"idx": idx, "deck": deck, "file": f.name, "px": [w, h],
                          "long_axis": axis, "tiles": tiles})
            n += k
        state["ships"].setdefault(db_slug, {})["plan_decks"] = decks
        print(f"{db_slug:26s} decks={len(decks):3d} tiles={sum(len(x['tiles']) for x in decks)}")
    save_state(state)
    print(f"plan prep: {n} tiles")


def plan_submit(args):
    state = load_state()
    reqs, est_tokens, ships_in = [], 0, []
    prompt = READ_PROMPT.replace('If the segment has no noise source at all, return {"features":[]}.',
                                 'If the segment has no noise source at all, return {"features":[],"anchors":[...]}.') + ANCHOR_BLOCK
    for db_slug in PLAN_SRC:
        sh = state["ships"].get(db_slug, {})
        if args.only and args.only.lower() not in db_slug:
            continue
        if not sh.get("plan_decks") or sh.get("plan_submitted_at"):
            continue
        ships_in.append(db_slug)
        for dk in sh["plan_decks"]:
            for ti, tile in enumerate(dk["tiles"]):
                pth = PLAN_WORK / db_slug / tile["file"]
                im = Image.open(pth)
                est_tokens += (im.width * im.height) // 750 + 500
                b64 = base64.standard_b64encode(pth.read_bytes()).decode()
                key = dk.get("idx", dk.get("deck"))
                reqs.append({"custom_id": f"PLAN--{db_slug}--{key:02d}--{ti}", "params": {
                    "model": MODEL, "max_tokens": 4000,
                    "messages": [{"role": "user", "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
                        {"type": "text", "text": prompt}]}]}})
    if not reqs:
        sys.exit("nothing to submit — run plan-prep first")
    est = est_tokens * 3e-6 * 0.5 + len(reqs) * 1200 * 15e-6 * 0.5
    print(f"{len(reqs)} plan reads across {len(ships_in)} ships, ~{est_tokens/1000:.0f}K input tokens, est ~${est:.2f}")
    if args.dry_run:
        return
    CHUNK = 120
    for ci in range(0, len(reqs), CHUNK):
        chunk = reqs[ci:ci + CHUNK]
        out = json.loads(api("POST", "/messages/batches", {"requests": chunk}, timeout=900))
        state["batches"].append({"id": out["id"], "n": len(chunk), "submitted": time.strftime("%F %T"),
                                 "status": out.get("processing_status"), "kind": "plan"})
        save_state(state)
        print(f"submitted batch {out['id']} ({len(chunk)} requests)")
    for slug in ships_in:
        state["ships"][slug]["plan_submitted_at"] = time.strftime("%F %T")
    save_state(state)


def _json_anchors(db_slug, deck):
    """Exact anchors extracted from the plan document itself (Margaritaville's PDF carries
    every room number as text)."""
    rel = ANCHOR_JSON.get(db_slug)
    if not rel:
        return None
    f = ARCHIVE / rel
    if not f.exists():
        return None
    rows = json.loads(f.read_text()).get(str(deck))
    if not rows:
        return None
    return [{"num": n, "along": a, "across": c} for n, a, c in rows]


def _svg_anchors(db_slug, deck, px):
    """Exact cabin anchors from the deckmaps SVG that shares this plan's viewBox."""
    rel = ANCHOR_SVG.get(db_slug)
    if not rel:
        return None
    f = ARCHIVE / rel / f"deck_{deck}.svg"
    if not f.exists():
        return None
    svg = f.read_text(encoding="utf-8", errors="replace")
    vb = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    if not vb:
        return None
    vw, vh = float(vb.group(1)), float(vb.group(2))
    if abs(vw - px[0]) > 2 or abs(vh - px[1]) > 2:
        print(f"  ! {db_slug} deck {deck}: SVG viewBox {vw}x{vh} != plan {px} — anchors skipped")
        return None
    out = []
    for m in re.finditer(r'<text[^>]*?\bx="([-\d.]+)"[^>]*?\by="([-\d.]+)"[^>]*?data-cabin="([^"]+)"', svg):
        x, y, num = float(m.group(1)), float(m.group(2)), m.group(3)
        along, across = (y / vh, x / vw) if vh >= vw else (x / vw, y / vh)
        out.append({"num": num, "along": round(along, 4), "across": round(across, 4)})
    return out or None


_GRID_CACHE = {}


def plan_assemble(args):
    """Merge PLAN--* reads into noise/out/<db_slug>.plan.json (features + anchors, image frame)."""
    gf = NOISE / "grid.json"
    if gf.exists():
        _GRID_CACHE.update(json.loads(gf.read_text()))
    reads = {}
    for f in sorted(NOISE.glob("results_*.jsonl")):
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if not row["custom_id"].startswith("PLAN--"):
                continue
            res = row.get("result", {})
            if res.get("type") != "succeeded":
                print(f"  ! {row['custom_id']}: {res.get('type')}")
                continue
            text = "".join(b.get("text", "") for b in res["message"]["content"] if b["type"] == "text")
            pr = _parse(text)
            if pr is not None:
                reads[row["custom_id"]] = pr
    state = load_state()
    OUT.mkdir(parents=True, exist_ok=True)
    for db_slug in PLAN_SRC:
        sh = state["ships"].get(db_slug, {})
        if not sh.get("plan_decks"):
            continue
        decks_out, nf, na = [], 0, 0
        for dk in sh["plan_decks"]:
            axis, L = dk["long_axis"], max(dk["px"])
            feats, anchors = [], []
            for ti, tile in enumerate(dk["tiles"]):
                key = dk.get("idx", dk.get("deck"))
                r = reads.get(f"PLAN--{db_slug}--{key:02d}--{ti}")
                if not r:
                    continue
                def remap(px, py):
                    if axis == "x":
                        return (tile["offset"] + px * tile["len"]) / L, py
                    return (tile["offset"] + py * tile["len"]) / L, px
                for ft in r.get("features", []):
                    try:
                        along, across = remap(float(ft["x"]), float(ft["y"]))
                    except (KeyError, TypeError, ValueError):
                        continue
                    feats.append({"kind": str(ft.get("kind") or "other").lower().strip(),
                                  "label": str(ft.get("label") or "").strip()[:60],
                                  "along": round(along, 4), "across": round(across, 4)})
                for an in r.get("anchors", []):
                    try:
                        along, across = remap(float(an["x"]), float(an["y"]))
                        num = str(an["num"]).strip()
                    except (KeyError, TypeError, ValueError):
                        continue
                    if num.isdigit():
                        anchors.append({"num": num, "along": round(along, 4), "across": round(across, 4)})
            keep = []
            for ft in sorted(feats, key=lambda f: (f["kind"], f["along"])):
                if any(k["kind"] == ft["kind"] and abs(k["along"] - ft["along"]) < 0.008
                       and abs(k["across"] - ft["across"]) < 0.12 for k in keep):
                    continue
                keep.append(ft)
            seen, uniq = set(), []
            for a in anchors:
                if a["num"] in seen:
                    continue
                seen.add(a["num"]); uniq.append(a)
            deck_no = dk.get("deck")
            if deck_no is None and uniq and db_slug in _GRID_CACHE:
                # the filename gave no deck; the room numbers do
                nums = {a["num"] for a in uniq}
                best, hits = None, 0
                for d, cab in _GRID_CACHE[db_slug].items():
                    n = len(nums & {c["cabin_num"] for c in cab})
                    if n > hits:
                        best, hits = int(d), n
                if hits >= 8:
                    deck_no = best
            exact = None
            if deck_no:
                exact = _json_anchors(db_slug, deck_no) or _svg_anchors(db_slug, deck_no, dk["px"])
            decks_out.append({"deck": deck_no, "file": dk.get("file"), "px": dk["px"],
                              "long_axis": axis, "features": keep,
                              "anchors": exact or uniq,
                              "anchor_source": "parsed from the plan document (exact)" if exact else "vision read"})
            nf += len(keep); na += len(decks_out[-1]["anchors"])
        (OUT / f"{db_slug}.plan.json").write_text(json.dumps(
            {"db_slug": db_slug, "frame": "image", "model": MODEL, "decks": decks_out}, indent=1))
        print(f"{db_slug:26s} decks={len(decks_out):3d} features={nf} anchors={na}")


# ---------------------------------------------------------------- neighbourhood + write
# Mark's rule: an area around each room identifies the noise — "4 rooms fore and aft of the
# room and across the corridor". Everything below is arithmetic on the cabin positions the
# database already holds; the vision read only ever supplied WHERE the noise source is.

ROOMS_EITHER_SIDE = 4     # Mark's rule, literally: the 4 nearest fore AND the 4 nearest aft,
                          # so a full moat is 8 rooms per corridor row, not 4 across the middle
INBOARD = (0.25, 0.75)    # a feature this far from the shell serves the whole corridor width
ACROSS_REACH = 0.35       # otherwise a row counts as "across the corridor" within this much
ALONG_GAP_MAX = 0.06      # a row is not next to the feature at all beyond this
# "4 rooms" is a rank, and on a row whose rooms are unusually far apart the 4th one can sit a
# third of the ship away. Guard against THAT — a gap in the row — rather than against ordinary
# spacing: the limit scales to the row's own typical gap, so it never quietly shrinks the moat
# on a normal deck. (A fixed fraction of the hull did exactly that: it cut 8 rooms down to 4.)
SPREAD_GAPS = 2.5         # how many typical room-gaps beyond the 4th room is still "nearby"
SPREAD_CEILING = 0.25     # and never more than a quarter of the ship, whatever the row
BAND_GAP = 0.055          # 1-D gap that separates one corridor row from the next
# The along axis decides which rooms are neighbours, so it has to be near-exact. The across
# axis only picks which corridor rows a feature reaches — it takes a handful of discrete
# values per deck, so a jogged row costs it far more r2 than the error actually matters.
MIN_ANCHORS, MIN_R2_ALONG, MIN_R2_ACROSS = 8, 0.99, 0.90

WORDS = {"lift": "elevator lobby", "stairs": "stairwell", "laundry": "guest laundry",
         "crew": "crew access door", "machinery": "machinery space", "galley": "galley",
         "pool": "pool deck", "kids": "kids club", "gym": "fitness center", "spa": "spa",
         "atrium": "atrium", "theatre": "theater", "medical": "medical center"}
RANK = {"lift": 0, "stairs": 1, "club": 2, "bar": 2, "theatre": 2, "atrium": 3, "pool": 3,
        "galley": 3, "kids": 3, "restaurant": 4, "gym": 4, "machinery": 4}


# Some reads come back as "other" carrying a label that plainly says what it is — "Elevator
# Bank (Unlabelled Hatched Box)", "Up/Down Arrow (Stairwell)". Left alone, a guest would be
# told the thing near their cabin is an "Elevator/Hatch Box" instead of the elevator lobby, and
# it would be ranked as a venue rather than a lift. Correct the kind from the words.
RECLASSIFY = ((("elevator", "lift"), "lift"), (("stair",), "stairs"),
              (("laundr",), "laundry"), (("galley",), "galley"))
# Plan furniture and abbreviations that are not worth a sentence to anybody.
DROP_LABELS = ("lamp post", "deck chair", "planter", "bench", "hatch", "arrow")
# Abbreviations the plan uses that mean nothing off the page.
RENAME = {"rr": "public restrooms", "wc": "public restrooms", "rr.": "public restrooms"}


def _retype(ft):
    """Fix the kind and the wording from the label before anything is written."""
    lab = (ft.get("label") or "").strip()
    low = lab.lower()
    if low in RENAME:
        ft = {**ft, "label": RENAME[low]}
        low = ft["label"].lower()
    if ft.get("kind") in (None, "", "other"):
        for words, kind in RECLASSIFY:
            if any(w in low for w in words):
                return {**ft, "kind": kind}
    return ft


def _phrase(ft):
    """The words a guest reads. Returns None when we cannot name the thing: an unlabelled
    "other" would reach a customer as "on the same deck: other.", which is worse than silence."""
    lab = (ft.get("label") or "").strip()
    kind = ft.get("kind") or "other"
    if kind in ("lift", "stairs", "laundry", "crew", "machinery"):
        return WORDS[kind]
    if any(d in lab.lower() for d in DROP_LABELS) and kind not in ("lift", "stairs"):
        return None
    if lab and not lab.lower().startswith(("unlabel", "unnamed", "n/a", "unknown")):
        return lab if lab.isupper() is False else lab.title()
    return WORDS.get(kind)


def _reaches(row_centre, ft_across):
    """Lift lobbies and public rooms sit inboard and open onto the corridor that serves the
    whole beam, so they reach every cabin row. Something pinned to one side of the ship
    (a gym against the shell) only reaches that side."""
    if INBOARD[0] <= ft_across <= INBOARD[1]:
        return True
    if abs(row_centre - ft_across) <= ACROSS_REACH:
        return True
    return (row_centre - 0.5) * (ft_across - 0.5) > 0


def _bands(rows):
    """Split cabins on a deck into corridor rows by clustering pos_across."""
    out, cur, prev = [], [], None
    for c in sorted(rows, key=lambda r: r["pos_across"]):
        if prev is not None and c["pos_across"] - prev > BAND_GAP:
            out.append(cur); cur = []
        cur.append(c); prev = c["pos_across"]
    if cur:
        out.append(cur)
    return out


def neighbourhood(cabins, features):
    """-> {cabin_num: ([phrase, ...], kind)} for one deck. Pure function; unit-testable.

    Lifeboats are excluded here on purpose: a boat outside the window blocks the VIEW, it does
    not travel down the corridor, so it is answered by view_blocked() instead. Mixing the two
    would tell a guest their room is noisy because of something that only makes it darker."""
    features = [f for f in features if f.get("kind") != "lifeboat"]
    hits = {}
    rows = [c for c in cabins if c.get("pos_along") is not None and c.get("pos_across") is not None]
    if not rows:
        return hits
    for band in _bands(rows):
        centre = sum(c["pos_across"] for c in band) / len(band)
        band = sorted(band, key=lambda c: c["pos_along"])
        gaps = sorted(b["pos_along"] - a["pos_along"] for a, b in zip(band, band[1:]))
        typical = gaps[len(gaps) // 2] if gaps else 0.0
        limit = min(SPREAD_CEILING, max(ALONG_GAP_MAX, SPREAD_GAPS * ROOMS_EITHER_SIDE * typical))
        for ft in features:
            if not _reaches(centre, ft["across"]):
                continue
            nearest = min(band, key=lambda c: abs(c["pos_along"] - ft["along"]))
            if abs(nearest["pos_along"] - ft["along"]) > ALONG_GAP_MAX:
                continue          # the feature is not beside this row at all
            # The 4 nearest on each side of it, counted separately, so the moat is symmetrical
            # even where the rooms are not evenly spaced.
            fore = [c for c in band if c["pos_along"] <= ft["along"]][-ROOMS_EITHER_SIDE:]
            aft = [c for c in band if c["pos_along"] > ft["along"]][:ROOMS_EITHER_SIDE]
            for c in fore + aft:
                if abs(c["pos_along"] - ft["along"]) > limit:
                    continue
                hits.setdefault(c["cabin_num"], []).append(ft)
    out = {}
    for num, fts in hits.items():
        seen, ordered, kinds = set(), [], []
        for ft in sorted((_retype(f) for f in fts), key=lambda f: (RANK.get(f["kind"], 5), f["label"])):
            ph = _phrase(ft)
            if not ph or ph.lower() in seen:
                continue
            seen.add(ph.lower()); ordered.append(ph); kinds.append(ft["kind"])
        # the loudest kind, as a code Spanish can be written from rather than translated
        if not ordered:
            continue
        top = kinds[0]
        out[num] = (ordered[:3], "lift" if top == "lift" else "stairs" if top == "stairs" else "venue")
    return out


# ── What is in front of the window ──────────────────────────────────────────
# A boat blocks a room when it sits at the same point ALONG the hull and outboard of it on the
# same side. That is a different test from the corridor moat: nothing about fore and aft, and
# the side matters absolutely — a boat to port cannot shade a starboard room.
BOAT_ALONG = 0.012        # how far along the hull a boat still shades a room
BOAT_DECKS_UP = 1         # boats are slung on one deck and hang in front of the deck above too


def view_blocked(cabins, boats, deck_offset=0):
    """-> {cabin_num: "lifeboat"} for the rooms a boat sits in front of.

    deck_offset says how many decks above the boats these rooms are: 0 for the boat deck
    itself, 1 for the deck above, where a slung boat still fills the lower half of the glass.
    """
    out = {}
    rows = [c for c in cabins if c.get("pos_along") is not None and c.get("pos_across") is not None]
    if not rows or not boats:
        return out
    # only rooms against the shell can see a boat at all; anything inboard has no window on it
    port = [c for c in rows if c["pos_across"] < 0.5]
    stbd = [c for c in rows if c["pos_across"] >= 0.5]
    for side in (port, stbd):
        if not side:
            continue
        shell = min(side, key=lambda c: c["pos_across"]) if side is port else \
                max(side, key=lambda c: c["pos_across"])
        outer = [c for c in side if abs(c["pos_across"] - shell["pos_across"]) < 0.10]
        for b in boats:
            same_side = (b["across"] < 0.5) == (side is port)
            if not same_side:
                continue
            for c in outer:
                if abs(c["pos_along"] - b["along"]) <= BOAT_ALONG:
                    out[c["cabin_num"]] = "lifeboat"
    return out


def _fit(xs, ys):
    """Least-squares y = a*x + b; returns (a, b, r2)."""
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    a = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    b = my - a * mx
    sst = sum((y - my) ** 2 for y in ys)
    ssr = sum((y - (a * x + b)) ** 2 for x, y in zip(xs, ys))
    return a, b, (1 - ssr / sst if sst else 0.0)


def register(anchors, db_by_num):
    """Fit image-frame anchor coords onto the DB frame. Returns (map_fn, report) or (None, report)."""
    pts = [(a, db_by_num[a["num"]]) for a in anchors if a["num"] in db_by_num]
    rep = {"anchors_read": len(anchors), "anchors_matched": len(pts)}
    if len(pts) < MIN_ANCHORS:
        rep["reason"] = "too few anchors matched the grid"
        return None, rep
    fa = _fit([p[0]["along"] for p in pts], [p[1]["pos_along"] for p in pts])
    if not fa:
        rep["reason"] = "degenerate fit"
        return None, rep
    acr = [p[0]["across"] for p in pts]
    if max(acr) - min(acr) < 0.05:
        # every anchor sits in one corridor row, so there is no across axis to fit and
        # nothing to be "across the corridor" from: put features on that row's centreline.
        mid = sum(p[1]["pos_across"] for p in pts) / len(pts)
        rep["r2_along"], rep["r2_across"] = round(fa[2], 4), "single-row deck"
        if fa[2] < MIN_R2_ALONG:
            rep["reason"] = "fit too loose — plan and grid may not be the same ship"
            return None, rep
        return (lambda al, ac: (fa[0] * al + fa[1], mid)), rep
    fc = _fit(acr, [p[1]["pos_across"] for p in pts])
    if not fc:
        rep["reason"] = "degenerate fit"
        return None, rep
    rep["r2_along"], rep["r2_across"] = round(fa[2], 4), round(fc[2], 4)
    if fa[2] >= MIN_R2_ALONG and fc[2] < MIN_R2_ACROSS and rep["anchors_matched"] >= 20:
        # certain about WHERE along the hull, unsure which side: centreline features only
        rep["degraded"] = "across axis unreliable — centreline features only"
        mid = sum(p[1]["pos_across"] for p in pts) / len(pts)
        return (lambda al, ac: (fa[0] * al + fa[1], mid if 0.3 <= ac <= 0.7 else None)), rep
    rep["r2_along"], rep["r2_across"] = round(fa[2], 4), round(fc[2], 4)
    if fa[2] < MIN_R2_ALONG or fc[2] < MIN_R2_ACROSS:
        rep["reason"] = "fit too loose — plan and grid may not be the same ship"
        return None, rep
    return (lambda al, ac: (fa[0] * al + fa[1], fc[0] * ac + fc[1])), rep


def _q(v):
    return "'" + str(v).replace("'", "''") + "'"


def apply_(args):
    """Turn the assembled reads into SQL. Room numbers come from grid.json (exported from the
    database), never from the vision read — the read only positions the noise source."""
    grid_f = NOISE / "grid.json"
    if not grid_f.exists():
        sys.exit("noise/grid.json missing — export it from Supabase first (see NOISE.md)")
    grid = json.loads(grid_f.read_text())   # {db_slug: {deck: [{cabin_num,pos_along,pos_across}]}}
    SQLD = NOISE / "sql"; SQLD.mkdir(parents=True, exist_ok=True)
    report = []
    payload = {"rooms": [], "decks": []}   # what load-noise.mjs writes

    def emit(db_slug, deck_hits, source_note, decks_meta):
        rows = []
        for deck, hits in sorted(deck_hits.items()):
            for num, (phrases, kind) in sorted(hits.items()):
                rows.append((deck, num, " and ".join(phrases), kind))
        if not rows:
            return 0
        lines = [f"-- {db_slug}: {len(rows)} rooms flagged from {source_note}",
                 "with r(deck, cabin_num, what, kind) as (values"]
        lines.append(",\n".join(f"  ({d}, {_q(n)}, {_q(w)}, {_q(k)})" for d, n, w, k in rows))
        lines.append(f""")
update cabins c set noise_nearby = r.what, noise_kind = r.kind,
       noise_source = {_q(source_note)} || ' — ' || c.ship_slug || ' deck ' || r.deck
from r
where c.cabin_num = r.cabin_num and c.deck = r.deck
  and c.ship_slug in (select slug from cabin_ships
                      where in_fleet and (slug = {_q(db_slug)} or derived_from = {_q(db_slug)}));

update deck_read_log set status='read', read_at=now(), source={_q(source_note)},
       lifts_found = v.lifts, rooms_flagged = v.rooms, notes = v.note
from (values
""" + ",\n".join(
            f"  ({d}, {m['lifts']}, {m['rooms']}, {_q(m['note'])})" for d, m in sorted(decks_meta.items())
        ) + f"""
) as v(deck, lifts, rooms, note)
where deck_read_log.rep_slug = {_q(db_slug)} and deck_read_log.deck = v.deck;""")
        (SQLD / f"{db_slug}.sql").write_text("\n".join(lines) + "\n")
        for d, n, w, k in rows:
            payload["rooms"].append([db_slug, d, n, w, k])
        for d, m in sorted(decks_meta.items()):
            payload["decks"].append([db_slug, d, source_note, m["lifts"], m["rooms"], m["note"]])
        return len(rows)

    # ---- same-frame ships: the grid was built from these very images
    for geo_slug, db_slug in SHIP_MAP.items():
        f = OUT / f"{geo_slug}.json"
        if not f.exists() or db_slug not in grid:
            continue
        if args.only and args.only.lower() not in db_slug:
            continue
        doc = json.loads(f.read_text())
        deck_hits, decks_meta, skipped_same = {}, {}, []
        for strip in doc["strips"]:
            nums = set(strip.get("deck_cabins") or [])
            if not nums or not strip["features"]:
                continue
            best, best_n = None, 0
            for deck, cabins in grid[db_slug].items():
                hit = len(nums & {c["cabin_num"] for c in cabins})
                if hit > best_n:
                    best, best_n = int(deck), hit
            if best is None or best_n < 10:
                continue
            cabins = grid[db_slug][str(best)]
            fn, rep = register(strip.get("anchors") or [], {c["cabin_num"]: c for c in cabins})
            if fn is None:
                skipped_same.append((best, rep))
                continue
            feats = [{**ft, **dict(zip(("along", "across"), fn(ft["along"], ft["across"])))}
                     for ft in strip["features"]]
            hits = neighbourhood(cabins, feats)
            if not hits:
                continue
            deck_hits.setdefault(best, {}).update(hits)
            lifts = sum(1 for ft in strip["features"] if ft["kind"] == "lift")
            decks_meta[best] = {"lifts": lifts, "rooms": len(hits),
                                "note": f"{len(strip['features'])} noise sources located; strip registered "
                                        f"onto the grid (r2 {rep['r2_along']}/{rep['r2_across']}, "
                                        f"{rep['anchors_matched']} anchors)"}
        n = emit(db_slug, deck_hits, "deck plan (vision read, registered onto the grid)", decks_meta)
        note = "; ".join(f"deck {d}: {r.get('reason')}" for d, r in skipped_same) if skipped_same else ""
        report.append((db_slug, len(deck_hits), n, note))

    # ---- plan-frame ships: register the plan onto the grid before trusting a single position
    for db_slug in list(PLAN_SRC) + list(SVG_SRC):
        f = OUT / f"{db_slug}.plan.json"
        if not f.exists() or db_slug not in grid:
            continue
        if args.only and args.only.lower() not in db_slug:
            continue
        doc = json.loads(f.read_text())
        deck_hits, decks_meta, skipped = {}, {}, []
        for dk in doc["decks"]:
            deck = dk["deck"]
            cabins = grid[db_slug].get(str(deck))
            if not cabins or not dk["features"]:
                continue
            by_num = {c["cabin_num"]: c for c in cabins}
            fn, rep = register(dk["anchors"], by_num)
            if fn is None:
                skipped.append((deck, rep))
                continue
            feats = []
            for ft in dk["features"]:
                al, ac = fn(ft["along"], ft["across"])
                if ac is None:
                    continue        # side unknown on this deck; better silent than wrong side
                feats.append({**ft, "along": al, "across": ac})
            hits = neighbourhood(cabins, feats)
            if not hits:
                continue
            deck_hits[deck] = hits
            decks_meta[deck] = {"lifts": sum(1 for ft in feats if ft["kind"] == "lift"),
                                "rooms": len(hits),
                                "note": f"{len(feats)} noise sources located; plan registered onto the grid "
                                        f"(r2 {rep['r2_along']}/{rep['r2_across']}, {rep['anchors_matched']} anchors)"}
        note_by_frame = {
            "published-svg": "the line's own published deck-plan SVG (labels read from the file)",
            "image": "deck plan (vision read, registered onto the grid)",
        }
        n = emit(db_slug, deck_hits, note_by_frame.get(doc.get("frame"), "deck plan"), decks_meta)
        note = "; ".join(f"deck {d}: {r.get('reason')}" for d, r in skipped) if skipped else ""
        report.append((db_slug, len(deck_hits), n, note))

    print(f"{'ship':28s} {'decks':>5s} {'rooms':>6s}  skipped")
    for slug, d, n, note in sorted(report):
        print(f"{slug:28s} {d:5d} {n:6d}  {note}")
    (NOISE / "apply.json").write_text(json.dumps(payload))
    print(f"\nSQL written to {SQLD}")
    print(f"loader payload: noise/apply.json — {len(payload['rooms'])} rooms, {len(payload['decks'])} decks")


def selftest(args):
    """The neighbourhood rule must reproduce the deck I read by hand before it is trusted on
    190 decks I will not read by hand. Norwegian Breakaway deck 5 — Medical Centre amidships
    with the elevator bank and stairwell just aft of it — was transcribed manually on 2026-08-18;
    those 12 rooms are the fixture."""
    grid = json.loads((NOISE / "grid.json").read_text())
    cabins = grid["norwegian-breakaway"]["5"]
    features = [  # positions from a synchronous vision read of the same deck strip
        {"kind": "lift", "label": "elevator bank", "along": 0.575, "across": 0.42},
        {"kind": "stairs", "label": "stairwell", "along": 0.622, "across": 0.42},
        {"kind": "medical", "label": "MEDICAL CENTER", "along": 0.524, "across": 0.42},
    ]
    hand_read = {"5146", "5148", "5150", "5152", "5153", "5155", "5157", "5159",
                 "5746", "5748", "5750", "5752"}
    hits = neighbourhood(cabins, features)
    missed = sorted(hand_read - set(hits))
    print(f"deck 5: {len(hits)} rooms flagged; hand-read rooms reproduced "
          f"{len(hand_read & set(hits))}/{len(hand_read)}")
    assert not missed, f"FAIL — the rule lost rooms the hand read found: {missed}"
    for num in ("5150", "5752"):
        phrases, kind = hits[num]
        assert "elevator lobby" in phrases, f"FAIL — {num} should hear the elevator lobby"
        assert kind == "lift", f"FAIL — {num} should be coded as a lift, got {kind}"
    assert "5601" not in hits, "FAIL — 5601 is a third of the deck away and must not be flagged"
    assert len(hits) < 110, "FAIL — the rule is flagging most of the deck, not a neighbourhood"

    # THE MOAT IS 8 ROOMS PER ROW, NOT 4. Mark, 2026-08-19: "four rooms fore and aft would be a
    # total of 8 rooms. 4 fore and 4 aft, otherwise you dont build the moat around the room."
    # A distance cap set as a fixed fraction of the hull had been quietly cutting it to 4 or 5
    # wherever rooms sat further apart than average — the rule was right and the guard was
    # overriding it. One elevator bank on a two-row deck must reach 16 rooms.
    row_a = [{"cabin_num": str(7200 + 2 * i), "pos_along": i / 24, "pos_across": 0.18} for i in range(25)]
    row_b = [{"cabin_num": str(7601 + 2 * i), "pos_along": i / 24, "pos_across": 0.82} for i in range(25)]
    moat = neighbourhood(row_a + row_b, [{"kind": "lift", "label": "ELEV", "along": 0.5, "across": 0.5}])
    per_row = sorted(n for n in moat if n.startswith("72"))
    assert len(per_row) == 8, f"FAIL — {len(per_row)} rooms fore-and-aft, should be 8: {per_row}"
    assert len(moat) == 16, f"FAIL — one elevator bank should reach 16 rooms across both rows, got {len(moat)}"
    print(f"  moat: {len(per_row)} rooms per row (4 fore + 4 aft), {len(moat)} for one elevator bank")

    # THE FRAME MUST NEVER BE ASSUMED. The strip coordinates in geometry/out/*.json and the
    # database's pos_along agree closely enough to look identical and are not: the database
    # re-normalised each deck to 0..1, while a strip fraction never reaches the ends of the
    # hull. Measured on Carnival Conquest on 2026-08-19, trusting the frame put features 2 to
    # 13 rooms out of place — and the rule only reaches 4 rooms either side, so that is a
    # different set of rooms entirely. Every path registers; this asserts the correction is
    # real and is being applied.
    geo, out = geo_state(), GEO / "out" / "carnival-conquest-4.json"
    assert out.exists(), "FAIL — the Carnival geometry the frame guard measures against is missing"
    ship = geo["ships"]["carnival-conquest-4"]
    cc, checked, worst_overall = grid["carnival-conquest"], 0, 0
    for si, dk in sorted(_strip_to_deck("carnival-conquest-4", ship).items()):
        axis = ship["strips"][si].get("long_axis", "y")
        nums = {str(c["num"]): c for c in dk["cabins"] if isinstance(c.get("x"), (int, float))}
        best = max(cc, key=lambda d: len(nums.keys() & {c["cabin_num"] for c in cc[d]}), default=None)
        if not best or len(nums.keys() & {c["cabin_num"] for c in cc[best]}) < 20:
            continue
        anchors = [{"num": n, "along": c["y"] if axis == "y" else c["x"],
                    "across": c["x"] if axis == "y" else c["y"]} for n, c in nums.items()]
        fn, rep = register(anchors, {c["cabin_num"]: c for c in cc[best]})
        assert fn, f"FAIL — a same-frame strip would not register onto deck {best}: {rep}"
        assert rep["r2_along"] >= 0.99, f"FAIL — deck {best} fit is only {rep['r2_along']}"
        band = sorted(cc[best], key=lambda c: c["pos_along"])
        near = lambda v: min(range(len(band)), key=lambda i: abs(band[i]["pos_along"] - v))
        worst = max(abs(near(fn(v, 0.5)[0]) - near(v)) for v in (0.06, 0.25, 0.5, 0.75, 0.94))
        worst_overall = max(worst_overall, worst)
        checked += 1
    assert checked >= 5, f"FAIL — only {checked} Carnival strips checked; the frame guard is not running"
    assert worst_overall >= 2, ("FAIL — registration is now a no-op, so either the frames really "
                                "did become identical or apply() has stopped correcting them")
    print(f"  frame guard: {checked} Carnival strips registered, "
          f"up to {worst_overall} rooms of drift corrected")
    print("PASS")


# ---------------------------------------------------------------- exact SVG path
# Celebrity publishes its deck plans as SVG with the venue names and elevator lobbies as REAL
# text at real coordinates, and every cabin number likewise. Nothing here is read by a model:
# the labels and the anchors are both parsed straight out of the file.

SVG_SRC = {"celebrity-edge": "_cel/celebrity-edge/deckplans",
           "celebrity-millennium": "_cel/celebrity-millennium/deckplans",
           "celebrity-solstice": "_cel/celebrity-solstice/deckplans"}

SVG_SKIP = ("GENTS", "LADIES", "RESTROOM", "ATM", "FORWARD", "MIDSHIP", "AFT",
            "PORT SIDE", "STARBOARD")
# fragments that survive as a label of their own when a name is split across text nodes
SVG_ORPHANS = {"the", "a", "and", "of", "ada", "grand", "changing", "new", "area", "room",
               "rooms", "lounge", "bar", "deck", "club", "center", "centre"}
SVG_KIND = [
    (("ELEVATOR", "LIFT"), "lift"), (("STAIR",), "stairs"), (("LAUNDR",), "laundry"),
    (("THEATRE", "THEATER"), "theatre"), (("GALLEY",), "galley"),
    (("MEDICAL", "INFIRMARY"), "medical"),
    (("CASINO", "CLUB", "DISCO", "NIGHT"), "club"),
    (("BAR", "LOUNGE", "PUB", "MARTINI", "CELLAR"), "bar"),
    (("KIDS", "CAMP AT SEA", "TEEN", "NURSERY", "PLAY"), "kids"),
    (("POOL", "WHIRLPOOL", "SOLARIUM"), "pool"),
    (("SPA", "SAUNA", "THERMAL", "SALON"), "spa"),
    (("FITNESS", "GYM"), "gym"), (("ATRIUM", "PLAZA", "PROMENADE"), "atrium"),
    (("RESTAURANT", "GRILL", "CAFÉ", "CAFE", "DINING", "BUFFET", "KITCHEN", "EATERY",
      "PIZZA", "SUSHI", "LUMINAE", "BLU", "TUSCAN", "NORMANDIE", "COSMOPOLITAN"), "restaurant"),
    (("SHOP", "RETAIL", "BOUTIQUE", "MARKET"), "shop"),
]
def _title(s):
    """Title-case without turning "CAPTAIN'S CLUB" into "Captain'S Club"."""
    return re.sub(r"([A-Za-z])([\u2019'])([A-Za-z])\b",
                  lambda m: m.group(1) + m.group(2) + m.group(3).lower(), s.title())


def _svg_kind(label):
    up = label.upper()
    for words, kind in SVG_KIND:
        if any(w in up for w in words):
            return kind
    return "other"


def _svg_text(svg):
    """Every drawn string with its position. Celebrity sets a venue name as one <text> per
    letter-group, all sharing the line's transform and offset by the tspan's own x/y — so the
    fragments have to be reassembled by those offsets or the name comes back as anagram soup
    ("ELE","V","A","TOR","S")."""
    out = []
    for tm in re.finditer(r"<text\b([^>]*)>(.*?)</text>", svg, re.S):
        attrs, inner = tm.group(1), tm.group(2)
        mm = re.search(r"transform=\"matrix\(\s*[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)\)\"", attrs)
        if not mm:
            continue
        tx, ty = float(mm.group(1)), float(mm.group(2))
        spans = list(re.finditer(r"<tspan\b([^>]*)>(.*?)</tspan>", inner, re.S))
        if spans:
            for sm in spans:
                a = sm.group(1)
                dx = float((re.search(r'\bx="([-\d.]+)"', a) or [0, "0"])[1])
                dy = float((re.search(r'\by="([-\d.]+)"', a) or [0, "0"])[1])
                t = re.sub(r"<[^>]*>", "", sm.group(2)).strip()
                if t:
                    out.append((tx, ty, dx, dy, t))
        else:
            t = re.sub(r"<[^>]*>", "", inner).strip()
            if t:
                out.append((tx, ty, 0.0, 0.0, t))
    return out


def svg_assemble(args):
    """Parse the published deck SVGs into the same shape the vision path produces. Nothing
    here is read by a model: labels, elevator lobbies and cabin anchors are all file contents."""
    OUT.mkdir(parents=True, exist_ok=True)
    for db_slug, rel in SVG_SRC.items():
        if args.only and args.only.lower() not in db_slug:
            continue
        src = ARCHIVE / rel
        if not src.exists():
            print(f"  ! {db_slug}: {src} missing")
            continue
        decks_out = []
        for f in sorted(src.glob("deck_*.svg"), key=lambda f: int(f.stem.split("_")[1])):
            deck = int(f.stem.split("_")[1])
            nodes = _svg_text(f.read_text(encoding="utf-8", errors="replace"))
            if not nodes:
                print(f"  ! {db_slug} deck {deck}: no text nodes")
                continue
            xs = [n[0] + n[2] for n in nodes]; ys = [n[1] + n[3] for n in nodes]
            x0, y0 = min(xs), min(ys)
            span_x, span_y = max(max(xs) - x0, 1e-6), max(max(ys) - y0, 1e-6)
            along_is_y = span_y >= span_x

            def norm(x, y):
                a = (y - y0) / span_y if along_is_y else (x - x0) / span_x
                c = (x - x0) / span_x if along_is_y else (y - y0) / span_y
                return round(a, 4), round(c, 4)

            anchors, lines = [], {}
            for tx, ty, dx, dy, t in nodes:
                if t.isdigit():
                    a, c = norm(tx + dx, ty + dy)
                    anchors.append({"num": t, "along": a, "across": c})
                else:
                    lines.setdefault((round(tx, 1), round(ty, 1)), []).append((dy, dx, t))
            feats = []
            for (tx, ty), frags in lines.items():
                rows = {}
                for dy, dx, t in frags:
                    rows.setdefault(round(dy, 1), []).append((dx, t))
                label = " ".join("".join(t for _, t in sorted(rows[k])) for k in sorted(rows)).strip()
                if not label or any(sk in label.upper() for sk in SVG_SKIP):
                    continue
                # a few decorative titles are set as individual glyphs with their own
                # transforms, so they cannot be reassembled — better to drop the label than
                # to print "K C E D O T P M Ra" to a customer
                toks = label.split()
                if len(toks) >= 3 and sum(len(t) == 1 for t in toks) / len(toks) > 0.4:
                    continue
                if label.lower() in SVG_ORPHANS:      # a stray article or half a name
                    continue
                a, c = norm(tx, ty)
                feats.append({"kind": _svg_kind(label),
                              "label": _title(label) if label.isupper() else label,
                              "along": a, "across": c})
            decks_out.append({"deck": deck, "file": f.name,
                              "px": [round(span_x, 1), round(span_y, 1)],
                              "long_axis": "y" if along_is_y else "x",
                              "features": feats, "anchors": anchors})
        (OUT / f"{db_slug}.plan.json").write_text(json.dumps(
            {"db_slug": db_slug, "frame": "published-svg", "model": "none — parsed from the SVG",
             "decks": decks_out}, indent=1))
        print(f"{db_slug:24s} decks={len(decks_out):3d} "
              f"features={sum(len(d['features']) for d in decks_out)} "
              f"anchors={sum(len(d['anchors']) for d in decks_out)}")


# ---------------------------------------------------------------- the boats
# What is actually in front of the window.
#
# Mark, 2026-08-19: "it is not only lifeboats. the derived obstruction may need to look at
# humps, superstructure, anything that obstructs and is not already flagged by the cruise
# lines. this was the directive when we started the process."
#
# So the read asks for everything drawn between the rooms and the sea — boats, superstructure,
# overhangs, deck equipment — not just the boats. The whole point is what the LINE does not
# disclose: the operator's own obstruction flag is set on 1,538 of 225,960 rooms.
#
# The research zones say which decks carry boats; those are the decks most likely to carry the
# rest of it too, since it is all slung off the same promenade. Class reps only, reusing the
# tiles the noise pass already cut.

BOAT_DECKS = {
    "grand-princess": [8], "wonder-of-the-seas": [6], "royal-princess": [8],
    "carnival-conquest": [6], "carnival-spirit": [4, 5], "carnival-vista": [2, 3],
    "celebrity-edge": [6], "celebrity-solstice": [6, 7, 8, 9], "msc-meraviglia": [8, 9, 10, 11],
    "quantum-of-the-seas": [6, 7], "voyager-of-the-seas": [6], "grandeur-of-the-seas": [7],
    "msc-poesia": [8], "msc-sinfonia": [7], "norwegian-escape": [8], "norwegian-jewel": [4, 8],
    "celebrity-millennium": [6, 7], "radiance-of-the-seas": [7, 8, 9],
    "msc-fantasia": [8, 9, 15, 16], "icon-of-the-seas": [8, 9, 10],
    "carnival-sunshine": [1, 2, 3], "carnival-dream": [2], "mardi-gras": [5],
    "norwegian-prima": [9], "carnival-elation": [11], "sun-princess": [5, 6],
    "norwegian-breakaway": [8], "norwegian-dawn": [8], "coral-princess": [8],
    "norwegian-sky": [8], "norwegian-aqua": [5, 9], "margaritaville-at-sea-islander": [4, 5, 6],
    "margaritaville-at-sea-paradise": [10], "msc-world-europa": [15, 16],
    "carnival-splendor": [6], "norwegian-epic": [8], "norwegian-spirit": [8],
    "pride-of-america": [7, 8],
}

BOAT_PROMPT = """This image is part of one deck of a cruise-ship deck plan, seen from above.

Find everything drawn BETWEEN THE STATEROOMS AND THE SEA — anything a guest would look at
instead of the water.

Return ONLY JSON, MINIFIED on one line:
{"blockers":[{"kind":"lifeboat","what":"lifeboat","x":0.88,"y":0.31}]}

kind is one of:
  lifeboat     a lifeboat or tender: a rounded capsule or oval, usually in a row along the
               outside edge, often overhanging the hull line
  structure    superstructure standing outboard of the rooms: a funnel base, a machinery or
               stair tower, a bulkhead, a service platform, a whale-back
  overhang     a deck, terrace, canopy or walkway drawn extending outboard PAST the stateroom
               line, so it hangs over the windows below
  equipment    winches, davits, tender cranes, mooring gear, exhaust trunking

x,y = the CENTRE of the thing, normalized 0..1 relative to THIS image. One entry per object.
what = a short plain name for it, in the plan's own words if it is labelled.

- Only report things OUTBOARD of the staterooms, on the outside edges of the deck. Anything in
  the middle of the deck is not blocking anyone's sea view and must not be reported.
- Do not report staterooms, corridors, stairwells inside the ship, lettering, or the hull
  outline itself.
- If this segment has nothing outboard of the rooms, return {"blockers":[]}.
- Be precise about position — which rooms sit behind these is the whole point."""


def _boat_units(only=None):
    """Every already-cut tile that covers a deck the research says carries boats."""
    state, geo = load_state(), geo_state()
    for db_slug, decks in BOAT_DECKS.items():
        if only and only.lower() not in db_slug:
            continue
        sh = state["ships"].get(db_slug, {})
        for dk in sh.get("plan_decks", []):
            if dk.get("deck") in decks:
                key = dk.get("idx", dk.get("deck"))
                for ti, tile in enumerate(dk["tiles"]):
                    yield (db_slug, dk["deck"], PLAN_WORK / db_slug / tile["file"],
                           f"BOAT--{db_slug}--{key:02d}--{ti}", tile, dk["long_axis"], max(dk["px"]))
        geo_slug = next((g for g, d in SHIP_MAP.items() if d == db_slug), None)
        ship = geo["ships"].get(geo_slug) if geo_slug else None
        if not ship:
            continue
        for si, d in _strip_to_deck(geo_slug, ship).items():
            if d.get("deck") not in decks:
                continue
            strip = ship["strips"][si]
            for ti, tile in enumerate(strip.get("halves", [])):
                yield (db_slug, d["deck"], WORK / geo_slug / tile["file"],
                       f"BOAT--{db_slug}--{si:02d}--{ti}", tile,
                       strip.get("long_axis", "y"), max(strip["px"]))


def boats_submit(args):
    state = load_state()
    reqs, est = [], 0
    for db_slug, deck, path, cid, *_ in _boat_units(args.only):
        if not path.exists():
            print(f"  ! {cid}: {path} missing")
            continue
        im = Image.open(path)
        est += (im.width * im.height) // 750 + 300
        reqs.append({"custom_id": cid, "params": {
            "model": MODEL, "max_tokens": 2000,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                             "data": base64.standard_b64encode(path.read_bytes()).decode()}},
                {"type": "text", "text": BOAT_PROMPT}]}]}})
    if not reqs:
        sys.exit("nothing to submit")
    print(f"{len(reqs)} boat reads, ~{est/1000:.0f}K input tokens, "
          f"est ~${est*3e-6*0.5 + len(reqs)*700*15e-6*0.5:.2f}")
    if args.dry_run:
        return
    for ci in range(0, len(reqs), 120):
        chunk = reqs[ci:ci + 120]
        out = json.loads(api("POST", "/messages/batches", {"requests": chunk}, timeout=900))
        state["batches"].append({"id": out["id"], "n": len(chunk), "kind": "boats",
                                 "submitted": time.strftime("%F %T"),
                                 "status": out.get("processing_status")})
        save_state(state)
        print(f"submitted batch {out['id']} ({len(chunk)} requests)")


def boats_assemble(args):
    reads = {}
    for f in sorted(NOISE.glob("results_*.jsonl")):
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if not row["custom_id"].startswith("BOAT--"):
                continue
            res = row.get("result", {})
            if res.get("type") != "succeeded":
                continue
            text = "".join(b.get("text", "") for b in res["message"]["content"] if b["type"] == "text")
            m = re.search(r"\{[\s\S]*\}", text)
            if not m:
                continue
            try:
                reads[row["custom_id"]] = json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    out = {}
    for db_slug, deck, path, cid, tile, axis, L in _boat_units(args.only):
        r = reads.get(cid)
        if not r:
            continue
        for b in r.get("blockers", []):
            try:
                bx, by = float(b["x"]), float(b["y"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (0 <= bx <= 1 and 0 <= by <= 1):
                continue
            kind = str(b.get("kind") or "structure").lower().strip()
            if kind not in ("lifeboat", "structure", "overhang", "equipment"):
                kind = "structure"
            along = (tile["offset"] + (bx if axis == "x" else by) * tile["len"]) / L
            across = by if axis == "x" else bx
            out.setdefault(db_slug, {}).setdefault(str(deck), []).append(
                {"kind": kind, "what": str(b.get("what") or kind)[:60],
                 "along": round(along, 4), "across": round(across, 4)})
    # a boat seen twice in the tile overlap is one boat
    for slug, decks in out.items():
        for deck, boats in decks.items():
            keep = []
            for b in sorted(boats, key=lambda b: (b["kind"], b["along"])):
                if any(k["kind"] == b["kind"] and abs(k["along"] - b["along"]) < 0.006
                       and (k["across"] < 0.5) == (b["across"] < 0.5) for k in keep):
                    continue
                keep.append(b)
            decks[deck] = keep
    (NOISE / "boats.json").write_text(json.dumps(out, indent=1))
    total = sum(len(v) for d in out.values() for v in d.values())
    kinds = {}
    for d in out.values():
        for v in d.values():
            for b in v:
                kinds[b["kind"]] = kinds.get(b["kind"], 0) + 1
    print(f"{total} view blockers located across {len(out)} hulls: {kinds}")
    for slug, decks in sorted(out.items()):
        print(f"  {slug:32s} " + ", ".join(f"deck {d}: {len(v)}" for d, v in sorted(decks.items())))


def status(args):
    st = load_state()
    print(f"batches: {len(st['batches'])}  ended: {sum(1 for b in st['batches'] if b.get('status') == 'ended')}")
    for b in st["batches"]:
        print(" ", b["id"], b.get("status"), b["n"])
    print(f"ships submitted: {len(st['ships'])}")
    print(f"out files: {len(list(OUT.glob('*.json'))) if OUT.exists() else 0}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("submit", "poll", "assemble", "status", "selftest", "boats-submit", "boats-assemble", "svg-assemble", "apply", "plan-prep", "plan-submit", "plan-assemble"):
        p = sub.add_parser(name)
        p.add_argument("--only")
        p.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    {"submit": submit, "poll": poll, "assemble": assemble, "status": status, "selftest": selftest, "boats-submit": boats_submit, "boats-assemble": boats_assemble, "svg-assemble": svg_assemble, "apply": apply_,
     "plan-prep": plan_prep, "plan-submit": plan_submit, "plan-assemble": plan_assemble}[a.cmd](a)


if __name__ == "__main__":
    main()
