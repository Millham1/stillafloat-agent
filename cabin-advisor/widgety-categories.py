#!/usr/bin/env python3
"""Read room numbers + plan colours off the OPERATOR deck-plan images already sitting in our
Widgety harvest (widgety.ships raw->deckplans), for the ships whose categories the grid lacks.

Mark, 2026-08-20: "we already harvested widgety, so if we have the data it should be sitting
somewhere." He was right. The harvest holds MSC's and NCL's own deck-plan PNGs per deck —
the source I was about to ask him to go fetch.

NO LEGEND NEEDED — THE IMAGE CALIBRATES ITSELF. These PNGs carry no printed legend, but most
rooms on every deck already have a category in our grid. So: read every room number + its block
colour, join numbers against the labeled rooms, learn colour->category from the overlap, and let
the box-side apply step (apply-widgety.mjs) write only through the same >=95%-purity gate the
empirical fill used. This script touches PIXELS only; the DATA join happens on the box, where
the service key lives.

RESOLUTION: the PNGs are ~1661px wide with ~6px digits. Same failure mode as the 4x Carnival
render (found 102 of 289 rooms and reported the misses as data findings) — so upscale 6x before
tiling, and treat a low found-count as a failed read, never as missing rooms.

Usage:  python3 widgety-categories.py [--only msc-world-america] [--jobs widgety-jobs.json]
Output: widgety-reads.json  {"<ship>|<deck>": [{"num": "12345", "hex": "F4A7B9"}, ...]}
"""
import argparse, base64, collections, importlib.util, io, json, re, sys, urllib.request
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nf", HERE / "noise-features.py")
nf = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(nf)

SCALE = 6
READ_PROMPT = """This image is part of a cruise-ship deck plan. Every stateroom is a small
coloured block with its number printed inside it — the numbers may be ROTATED 90 degrees.

Return ONLY JSON, MINIFIED on one line:
{"cabins":[{"num":"12345","x":0.31,"y":0.09}]}

x,y = the CENTRE of that stateroom's coloured block, normalized 0..1 relative to THIS image.
Transcribe EVERY stateroom number you can read, rotated or not. Digits only — ignore letters
and symbols beside a number. Omit any number that is not fully legible."""


def fetch(href, cache):
    cache.mkdir(exist_ok=True)
    p = cache / re.sub(r"[^A-Za-z0-9.]+", "_", href.split("/")[-1])
    if not p.exists():
        req = urllib.request.Request(href.replace(" ", "%20"), headers={"User-Agent": "saf-cabin-advisor"})
        p.write_bytes(urllib.request.urlopen(req, timeout=120).read())
    return Image.open(p).convert("RGB")


def read_image(im):
    """Tile the upscaled strip, vision-read numbers, return [{num, x, y}] in ORIGINAL pixels."""
    W, H = im.size
    big = im.resize((W * SCALE, H * SCALE), Image.LANCZOS)
    BW, BH = big.size
    n = max(1, round(BW / (BH * 1.15)))
    step = BW / n
    rooms = []
    for i in range(n):
        a = max(0, int(i * step) - 90); b = min(BW, int((i + 1) * step) + 90)
        t = big.crop((a, 0, b, BH))
        sc = min(1.0, 1568 / max(t.size))
        t2 = t.resize((int(t.width * sc), int(t.height * sc)), Image.LANCZOS) if sc < 1 else t
        buf = io.BytesIO(); t2.convert("RGB").save(buf, "JPEG", quality=92)
        try:
            r = json.loads(nf.api("POST", "/messages", {
                "model": "claude-sonnet-5", "max_tokens": 8000,
                "messages": [{"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                     "data": base64.standard_b64encode(buf.getvalue()).decode()}},
                    {"type": "text", "text": READ_PROMPT}]}]}, timeout=300))
        except Exception as e:
            print(f"    tile {i}: request failed — {e}", flush=True); continue
        txt = "".join(x["text"] for x in r["content"] if x["type"] == "text")
        got = []
        m = re.search(r"\{[\s\S]*\}", txt)
        if m:
            try: got = json.loads(m.group(0)).get("cabins", [])
            except json.JSONDecodeError: got = []
        if not got:      # a truncated reply still holds complete records — keep them
            got = [{"num": g[0], "x": float(g[1]), "y": float(g[2])} for g in re.findall(
                r'"num":\s*"(\d+)"\s*,\s*"x":\s*([\d.]+)\s*,\s*"y":\s*([\d.]+)', txt)]
        for c in got:
            try: num, ux, uy = str(c["num"]), float(c["x"]), float(c["y"])
            except (KeyError, TypeError, ValueError): continue
            if num.isdigit():
                rooms.append({"num": num,
                              "px": (a + ux * (b - a)) / SCALE,
                              "py": (uy * BH) / SCALE})
    return rooms


def colour_at(im, x, y):
    """The block colour around a point — the mode of quantized pixels, digits excluded.

    WHITE IS A COLOUR. NCL's plans paint most standard rooms white and reserve colour for a
    handful of categories; the first version excluded white as "page background", so the
    majority category never sampled and the stored hexes were outline noise (found 2026-08-20:
    aqua deck 10 calibrated 1 colour from 117 anchors). A number's printed position is inside
    its block by construction, so white AT a room number IS the block's colour.
    """
    px = im.load(); W, H = im.size
    v = collections.Counter()
    for dx in range(-6, 7, 1):
        for dy in range(-6, 7, 1):
            a, b = int(x + dx), int(y + dy)
            if not (0 <= a < W and 0 <= b < H): continue
            c = px[a, b]
            # Only near-BLACK is lettering. The first threshold (max<110) also swallowed the
            # dark category blocks — MSC's navy, NCL's charcoal interiors — whose digits are
            # WHITE anyway, so the mode over the block stays correct with white included.
            if max(c) < 70: continue
            v[(c[0] // 8, c[1] // 8, c[2] // 8)] += 1
    if not v: return None
    q = v.most_common(1)[0][0]
    return f"{q[0]*8+4:02X}{q[1]*8+4:02X}{q[2]*8+4:02X}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", default=str(HERE / "widgety-jobs.json"))
    ap.add_argument("--only", default=None)
    a = ap.parse_args()
    jobs = json.load(open(a.jobs))
    if a.only: jobs = [j for j in jobs if j["ship"] == a.only]
    out_path = HERE / "widgety-reads.json"
    out = json.load(open(out_path)) if out_path.exists() else {}
    for j in jobs:
        key = f"{j['ship']}|{j['deck']}"
        if key in out:
            print(f"{key}: already read ({len(out[key])} rooms), skipping"); continue
        print(f"=== {key} ===", flush=True)
        try:
            im = fetch(j["href"], HERE / "widgety-cache")
        except Exception as e:
            print(f"  fetch failed: {e}"); continue
        rooms = read_image(im)
        uniq = {}
        for r in rooms: uniq.setdefault(r["num"], (r["px"], r["py"]))
        rows = []
        W, H = im.size
        for num, (x, y) in uniq.items():
            hexc = colour_at(im, x, y)
            # x,y kept: on NCL plans Balcony and Inside share one colour and differ only by
            # POSITION on the strip (outboard rows vs mid-corridor). The grid's pos_across is
            # degenerate on centreline-registered hulls (aqua: every room at 0.4995), so the
            # image's own axes are the only geometry that can split the white tie.
            if hexc: rows.append({"num": num, "hex": hexc,
                                  "x": round(x / W, 4), "y": round(y / H, 4)})
        print(f"  {len(rooms)} reads, {len(uniq)} unique, {len(rows)} with a colour", flush=True)
        out[key] = rows
        json.dump(out, open(out_path, "w"))   # checkpoint after every deck
    print(f"\ndone -> {out_path}")


if __name__ == "__main__":
    main()
