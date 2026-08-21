#!/usr/bin/env python3
"""strip_tools.py — in-session portal-PDF reading (zero API).
render: cut one deck strip out of a poster, rotated for reading.
sample: given normalized (x,y) points on that render, snap block colours to the
        ship's repaired legend and print code/category per point."""
import fitz, json, sys, collections
from PIL import Image

def render(pdf, x0, y0, x1, y1, out, scale=6, rotate=90, page=0):
    p = fitz.open(pdf)[page]
    pix = p.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=fitz.Rect(x0, y0, x1, y1))
    im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    if rotate: im = im.rotate(rotate, expand=True)
    im.save(out)
    print(out, im.size)

def sample(img, legend_json, pts):
    im = Image.open(img); px = im.load()
    lj = json.load(open(legend_json))
    sw = {k: tuple(int(k[i:i+2], 16) for i in (0, 2, 4)) for k in lj}
    for label, nx, ny in pts:
        cnt = collections.Counter()
        cx, cy = nx * im.width, ny * im.height
        for dx in range(-14, 15, 2):
            for dy in range(-14, 15, 2):
                x, y = int(cx+dx), int(cy+dy)
                if not (0 <= x < im.width and 0 <= y < im.height): continue
                c = px[x, y][:3]
                if sum(c) > 740: continue   # NCL H5 is near-white (717); only true white is background
                best, bd = None, 999
                for k, s in sw.items():
                    d = sum(abs(a-b) for a, b in zip(c, s))
                    if d < bd: best, bd = k, d
                if bd <= 42: cnt[best] += 1
        if cnt:
            k, n = cnt.most_common(1)[0]
            print(f"{label}: {lj[k][0]} {lj[k][1]}  (votes {n}, hex {k})")
        else:
            print(f"{label}: NO MATCH — colour off-legend")

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "render":
        pdf, x0, y0, x1, y1, out = sys.argv[2:8]
        kw = dict(a.split("=") for a in sys.argv[8:])
        render(pdf, float(x0), float(y0), float(x1), float(y1), out,
               scale=int(kw.get("scale", 6)), rotate=int(kw.get("rotate", 90)), page=int(kw.get("page", 0)))
    elif cmd == "sample":
        img, legend = sys.argv[2:4]
        pts = [(a.split(":")[0], float(a.split(":")[1]), float(a.split(":")[2])) for a in sys.argv[4:]]
        sample(img, legend, pts)
