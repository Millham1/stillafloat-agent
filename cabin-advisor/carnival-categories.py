#!/usr/bin/env python3
"""Read stateroom CATEGORIES off Carnival's own deck-plan PDF, by measuring colour.

Mark, 2026-08-19: the operator's own deck plan wins. These PDFs are the operator's plan, and
unlike the fleet-geometry pulls they carry a printed CATEGORIES legend — every category code
with its own colour chip. So a category is a pixel match against that legend, not a guess.

WHY THIS EXISTS RATHER THAN THE EMPIRICAL COLOUR TABLE
    load-geometry.mjs derives colour->category backwards, from rooms whose category we already
    hold. On Carnival Dream that table was 53-75% confident — a coin flip — because several
    codes share one CATEGORY but not one COLOUR (4A..4H are all "Interior", in eight different
    colours). Reading forwards off the legend is unambiguous.

THE LEGEND IS PER SHIP, NOT PER LINE
    Checked 2026-08-19: Conquest, Splendor and Sunshine share only 21-23 of Dream's 29 chip
    colours and each carries 16-18 of its own. Conquest has "6A 6B 6C Ocean View" where Dream
    has "6A Ocean View" plus "6L 6M 6N Deluxe Ocean View", and a "9B Premium Balcony" Dream
    does not. So the legend is parsed from each ship's own page. Never reuse another hull's.

RENDER SCALE MATTERS AND FAILS SILENTLY
    At 4x the room numbers are ~8px tall: the read found 102 of 289 rooms on Dream deck 6 and
    reported every wanted room as "not on the plan" — which reads as a data finding when it is
    a resolution problem. At 8x it found 289, matching the plan's own count. That match is the
    check that the read is COMPLETE; treat a shortfall as a failed read, not as missing rooms.

Usage:
    python3 carnival-categories.py legend  --pdf ~/Downloads/carnival-conquest-deck-plan-pdf.pdf
    python3 carnival-categories.py rooms   --pdf <pdf> --slug carnival-conquest --decks 6,8
"""
import argparse, base64, collections, importlib.util, json, os, re, sys
from pathlib import Path

import fitz
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / "carnival"
_spec = importlib.util.spec_from_file_location("nf", HERE / "noise-features.py")
nf = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(nf)

RENDER = int(os.environ.get("RENDER_SCALE", "8"))   # 4 is not enough (see above); 12 is the
                                                    # residual pass for digits 8x still misses
CODE_RE = re.compile(r"^((?:[0-9A-Z]{2}\s+)+)(.*)$")


def page_image(pdf, scale=RENDER, page=0):
    d = fitz.open(pdf)
    pix = d[page].get_pixmap(matrix=fitz.Matrix(scale, scale))
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples), d[page].rect.width


def legend_lines(pdf):
    """The printed CATEGORIES block. Each code is its own text span, so its chip can be sampled
    exactly where the code is printed — no pixel hunting, no guessing at chip pitch."""
    d = fitz.open(pdf); p = d[0]
    out = []
    for b in p.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            t = re.sub(r"\s+", " ", " ".join(s["text"] for s in l["spans"]).strip())
            x0, y0, x1, y1 = l["bbox"]
            if y1 > p.rect.height * 0.35:
                continue                      # the legend band tops the page; Vista-class
                                              # runs it FULL-WIDTH in rows, so no x filter
            m = CODE_RE.match(t)
            if not m:
                continue
            label = m.group(2).strip()
            if not label:
                continue
            codes = []
            for sp in l["spans"]:
                txt = sp["text"].strip()
                if re.fullmatch(r"[0-9A-Z]{2}", txt):
                    sx0, sy0, sx1, sy1 = sp["bbox"]
                    codes.append({"code": txt, "x": (sx0 + sx1) / 2, "y": (sy0 + sy1) / 2})
            if not codes or len(codes) > 10:
                continue
            out.append({"codes": codes, "category": label})
    return out


def read_legend(pdf):
    """colour -> (code, category), measured off this ship's own legend chips."""
    im, page_w = page_image(pdf)
    px = im.load(); W, H = im.size
    S = W / page_w
    mapping, report = {}, []
    for line in legend_lines(pdf):
        pairs = []
        for c in line["codes"]:
            cx, cy = int(c["x"] * S), int(c["y"] * S)
            # sample the chip AROUND the printed code, skipping the lettering itself
            v = collections.Counter()
            for dy in range(-26, 27, 3):
                for dx in range(-30, 31, 3):
                    x, y = cx + dx, cy + dy
                    if not (0 <= x < W and 0 <= y < H):
                        continue
                    q = px[x, y]
                    if q[0] > 244 and q[1] > 244 and q[2] > 244:
                        continue                       # page white
                    if max(q) - min(q) < 16 and q[0] < 120:
                        continue                       # the code's own dark lettering
                    v[q] += 1
            if not v:
                continue
            best, n = v.most_common(1)[0]
            if n < 12:
                continue
            pairs.append((f"{best[0]:02X}{best[1]:02X}{best[2]:02X}", c["code"]))
        for hexc, code in pairs:
            mapping[hexc] = (code, line["category"])
        report.append((line["category"], len(line["codes"]), len(pairs),
                       " ".join(f"{c}={h}" for h, c in pairs)))
    return mapping, report


def cmd_legend(a):
    mapping, report = read_legend(a.pdf)
    OUT.mkdir(exist_ok=True)
    slug = a.slug or Path(a.pdf).stem.replace("-deck-plan-pdf", "")
    (OUT / f"{slug}.legend.json").write_text(json.dumps(mapping, indent=1))
    bad = 0
    for cat, ncodes, nchips, pairs in report:
        flag = "" if ncodes == nchips else f"   <- {ncodes} codes but {nchips} chips"
        if ncodes != nchips:
            bad += 1
        print(f"  {cat[:44]:46s} {pairs}{flag}")
    print(f"\n{len(mapping)} colours mapped for {slug}"
          + (f"; {bad} lines did not pair cleanly" if bad else "; every line paired cleanly"))


def deck_strips(pdf, page=0):
    """deck number -> centre x, in page points, from the printed labels."""
    d = fitz.open(pdf); p = d[page]
    out = {}
    for b in p.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            t = " ".join(s["text"] for s in l["spans"]).strip()
            # Venezia-class posters label split strips "Deck 14 Forward"/"Deck 14 Aft" —
            # a bare end-anchor missed the whole deck (Mark caught it, 2026-08-20)
            m = re.search(r"Deck\s*(\d+)(?:\s+(?:Forward|Fwd|Aft|Mid|Midship))?\s*$", t, re.I)
            if m and len(t) < 40:
                # EVERY strip, not the first: Vista-class splits one deck into forward and
                # aft mini-strips with their own labels. Reads merge across them.
                out.setdefault(int(m.group(1)), []).append((l["bbox"][0] + l["bbox"][2]) / 2)
    return out


READ_PROMPT = """This image is one deck strip from a Carnival deck plan. Every stateroom is a
small coloured block with its number printed inside it.

Return ONLY JSON, MINIFIED on one line:
{"cabins":[{"num":"6360","x":0.31,"y":0.09}]}

x,y = the CENTRE of that stateroom's coloured block, normalized 0..1 relative to THIS image.
Transcribe EVERY stateroom number you can read. Ignore the small symbols printed beside a
number (stars, squares, dots) — digits only. Omit any number that is not fully legible."""


def read_deck(im, S, cx, half=46, page_ctx=None):
    W, H = im.size
    x0, x1 = int((cx - half) * S), int((cx + half) * S)
    y0, y1 = int(0.18 * H), int(0.95 * H)
    strip = im.crop((x0, y0, x1, y1)); w, h = strip.size
    n = max(1, round(h / (w * 1.1))); step = h / n
    rooms = []
    for i in range(n):
        ov = int(os.environ.get("TILE_OVERLAP", "70"))
        a = max(0, int(i * step) - ov); b = min(h, int((i + 1) * step) + ov)
        t = strip.crop((0, a, w, b)); sc = 1568 / max(t.size)
        t = t.resize((int(t.width * sc), int(t.height * sc)), Image.LANCZOS)
        t.save("/tmp/cc_tile.jpg", quality=92)
        try:
            r = json.loads(nf.api("POST", "/messages", {
                "model": "claude-sonnet-5", "max_tokens": 8000,
                "messages": [{"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                     "data": base64.standard_b64encode(open("/tmp/cc_tile.jpg", "rb").read()).decode()}},
                    {"type": "text", "text": READ_PROMPT}]}]}, timeout=300))
        except Exception as e:
            print(f"    tile {i}: request failed — {e}", flush=True); continue
        txt = "".join(x["text"] for x in r["content"] if x["type"] == "text")
        got = []
        m = re.search(r"\{[\s\S]*\}", txt)
        if m:
            try:
                got = json.loads(m.group(0)).get("cabins", [])
            except json.JSONDecodeError:
                got = []
        if not got:      # a truncated reply still holds complete records — keep them
            got = [{"num": g[0], "x": float(g[1]), "y": float(g[2])} for g in re.findall(
                r'"num":\s*"(\d+)"\s*,\s*"x":\s*([\d.]+)\s*,\s*"y":\s*([\d.]+)', txt)]
            if got:
                print(f"    tile {i}: salvaged {len(got)} from a truncated reply", flush=True)
        for c in got:
            try:
                num, ux, uy = str(c["num"]), float(c["x"]), float(c["y"])
            except (KeyError, TypeError, ValueError):
                continue
            if num.isdigit():
                rooms.append({"num": num, "px_x": x0 + ux * (x1 - x0), "px_y": y0 + a + uy * (b - a),
                              "img": page_ctx[0] if page_ctx else im})
    return rooms


def cmd_rooms(a):
    slug = a.slug
    mapping = json.loads((OUT / f"{slug}.legend.json").read_text())
    sw = {k: tuple(int(k[i:i + 2], 16) for i in (0, 2, 4)) for k in mapping}
    n_pages = len(fitz.open(a.pdf))

    def category_at(cx, cy, img):
        px = img.load(); W, H = img.size
        v = collections.Counter()
        for dx in range(-12, 13, 2):
            for dy in range(-8, 9, 2):
                x, y = int(cx + dx), int(cy + dy)
                if not (0 <= x < W and 0 <= y < H):
                    continue
                c = px[x, y]; best, bd = None, 999
                for k, s in sw.items():
                    d = abs(c[0] - s[0]) + abs(c[1] - s[1]) + abs(c[2] - s[2])
                    if d < bd:
                        best, bd = k, d
                if bd <= 36:
                    v[best] += 1
        if not v:
            return None, None, 0
        k, n = v.most_common(1)[0]
        return mapping[k][0], mapping[k][1], n

    out = {}
    pages = []
    for pg in range(n_pages):
        im, page_w = page_image(a.pdf, page=pg)
        pages.append((im, im.size[0] / page_w, deck_strips(a.pdf, page=pg), im.load(), im.size))
    for deck in [int(d) for d in a.decks.split(",")]:
        if not any(deck in st for _, _, st, _, _ in pages):
            print(f"deck {deck}: no label on this plan"); continue
        rooms = []
        for im, S, strips, px_, sz in pages:
            for cx in strips.get(deck, []):
                rooms.extend(read_deck(im, S, cx, page_ctx=(im,)))
        uniq = {}
        for r in rooms:
            uniq.setdefault(r["num"], (r["px_x"], r["px_y"], r["img"]))
        print(f"deck {deck}: {len(rooms)} reads, {len(uniq)} unique rooms")
        for num, (x, y, img) in uniq.items():
            code, cat, votes = category_at(x, y, img)
            if code and votes >= 8:      # one stray pixel is a coincidence, not a measurement
                out.setdefault(str(deck), {})[num] = {"code": code, "category": cat, "px": votes}
            elif os.environ.get("DEBUG_DROPS"):
                px_ = img.load()
                c = px_[int(x), int(y)]
                near = sorted(((abs(c[0]-s2[0])+abs(c[1]-s2[1])+abs(c[2]-s2[2]), k2) for k2, s2 in sw.items()))[:2]
                print(f"  DROP {num}: rgb={c[:3]} votes={votes} nearest={near}")
    OUT.mkdir(exist_ok=True)
    # MERGE with any prior read: this file accumulates decks across runs, so a targeted
    # re-read of one weak deck must not erase the decks already read (added 2026-08-20,
    # before the Horizon re-read could destroy its own 9 good decks).
    path = OUT / f"{slug}.rooms.json"
    prior = json.loads(path.read_text()) if path.exists() else {}
    prior.update(out)
    out = prior
    path.write_text(json.dumps(out, indent=1))
    tot = sum(len(v) for v in out.values())
    print(f"\n{tot} rooms with a measured category -> carnival/{slug}.rooms.json")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("legend", "rooms"):
        p = sub.add_parser(name)
        p.add_argument("--pdf", required=True)
        p.add_argument("--slug")
        p.add_argument("--decks", default="")
    a = ap.parse_args()
    {"legend": cmd_legend, "rooms": cmd_rooms}[a.cmd](a)


if __name__ == "__main__":
    main()
