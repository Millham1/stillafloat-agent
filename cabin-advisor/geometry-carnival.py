#!/usr/bin/env python3
"""Cabin Advisor — Carnival cabin GEOMETRY from Mark's own booking-site deck-plan PDFs.

Proven 2026-08-12 (Breeze Deck 1: 249/~250 cabins with positions): each Carnival PDF embeds
separate per-deck JPEG strips (~330x2400) that are fully legible once split + upscaled. This
script scales that proof across every PDF in the Drive folder, producing per-ship geometry
JSON (cabin number + normalized x/y + category color) that joins onto the cabin grid already
in Supabase — closing the x/y gap for the vision-read lines so Carnival ships can draw the
same schematic deck map as the DeckMaps-sourced lines.

Runs OFF-PLAN by design (Mark, 2026-08-12): everything goes through the Anthropic **Message
Batches API** on the saf API key — 50% off token pricing, processed server-side in the
background, zero Claude Code usage credits. Checkpointed at every stage; safe to re-run.

Stages (state in geometry/state.json, images in geometry/work/, output in geometry/out/):
  carve    - extract per-deck JPEG strips from every PDF (SOI/EOI magic bytes, pure Python)
  prep     - split strips >2200px along the long axis into 2 halves (6% overlap), upscale 2x
  submit   - build one vision request per half, POST as a message batch (prints cost estimate)
  poll     - check batch status; fetch + store results when ended
  assemble - parse reads, remap half-coords to full-strip coords, dedupe overlap, write
             geometry/out/<slug>.json
  status   - where everything stands
  direct   - smoke test: read ONE strip synchronously (no batch) and print the count

Usage:
  python3 geometry-carnival.py carve [--pdf-dir DIR] [--only breeze]
  python3 geometry-carnival.py prep
  python3 geometry-carnival.py submit [--only breeze] [--dry-run]
  python3 geometry-carnival.py poll
  python3 geometry-carnival.py assemble
  python3 geometry-carnival.py direct --slug carnival-breeze --img 1

Key: ANTHROPIC_API_KEY env, else parsed from ~/.config/saf-secrets/env.txt.
Background: nohup caffeinate -i python3 geometry-carnival.py <stage> >> geometry/run.log 2>&1 &
"""
import argparse, base64, hashlib, io, json, os, re, sys, time, urllib.request
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
GEO = HERE / "geometry"
WORK, OUT = GEO / "work", GEO / "out"
STATE_F = GEO / "state.json"
DEFAULT_PDF_DIR = Path.home() / "Library/CloudStorage/GoogleDrive-mmillham1@gmail.com/My Drive/Carnival"
MODEL = os.environ.get("GEOMETRY_MODEL", "claude-sonnet-5")
API = "https://api.anthropic.com/v1"
# The API downscales any image to a 1568px long edge — tighter than the Read tool's 2000px
# the original proof relied on. Tiling each strip into ~800px segments keeps every tile's
# effective magnification (1568/~800 ≈ 2x) ABOVE what the proof showed was legible (1.57x).
TILE_LEN = 800       # target segment length along the strip's long axis, original pixels
OVERLAP_PX = 50      # overlap between adjacent tiles (a cabin block is ~25px)
UPSCALE = 2
API_MAX_EDGE = 1568  # cap after upscale so the server doesn't resample a second time

READ_PROMPT = """This image is one deck strip from a Carnival cruise ship deck plan (possibly one half of a taller strip). Transcribe EVERY cabin visible.

Return ONLY JSON, MINIFIED on one line (no spaces or newlines — there can be 100+ cabins and output length is capped):
{"deck_label": <deck number printed on the strip, or null>, "cabins": [{"num": "1210", "x": 0.155, "y": 0.12, "color": "yellow"}]}

Rules:
- x,y are the cabin block's center, normalized 0..1 relative to THIS image (x across its width, y down its height).
- color = the block's fill-color family in one word (yellow/mauve/red/salmon/gold/pink/brown/teal/orange/blue/green/gray...).
- Read digits carefully; if a number is not fully legible, OMIT the cabin rather than guess a digit.
- Exclude non-cabin numbers (deck labels, category legend, public venues).
- If the image contains no cabins (legend page, artwork, blank frame), return {"deck_label": null, "cabins": []}."""


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


def api(method, path, body=None, key=None, raw_url=None, timeout=300):
    req = urllib.request.Request(raw_url or (API + path), method=method)
    req.add_header("x-api-key", key or api_key())
    req.add_header("anthropic-version", "2023-06-01")
    if body is not None:
        req.add_header("content-type", "application/json")
        req.data = json.dumps(body).encode()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def load_state():
    return json.loads(STATE_F.read_text()) if STATE_F.exists() else {"ships": {}, "batches": []}


def save_state(s):
    GEO.mkdir(exist_ok=True)
    STATE_F.write_text(json.dumps(s, indent=1))


def slugify(pdf_name):
    n = re.sub(r"(?i)\s*deck\s*plans?\s*(pdf)?\s*", " ", pdf_name.replace(".pdf", "")).strip()
    n = re.sub(r"[^A-Za-z0-9]+", "-", n).strip("-").lower()
    return n if n.startswith("carnival") or n in ("mardi-gras",) else f"carnival-{n}"


def carve(args):
    pdf_dir = Path(args.pdf_dir).expanduser()
    pdfs = sorted(pdf_dir.glob("*.pdf"))
    if args.only:
        pdfs = [p for p in pdfs if args.only.lower() in p.name.lower()]
    if not pdfs:
        sys.exit(f"no PDFs matched in {pdf_dir}")
    state = load_state()
    # First pass: hash every embedded JPEG so shared assets (the blank frame/legend that is
    # byte-identical across PDFs) can be skipped instead of wasting vision calls.
    seen_hashes = {}
    carved = {}
    for pdf in pdfs:
        data = pdf.read_bytes()
        imgs, pos = [], 0
        while True:
            s = data.find(b"\xff\xd8\xff", pos)
            if s < 0:
                break
            e = data.find(b"\xff\xd9", s + 3)
            if e < 0:
                break
            imgs.append(data[s:e + 2])
            pos = e + 2
        carved[pdf.name] = imgs
        for b in imgs:
            h = hashlib.md5(b).hexdigest()
            seen_hashes.setdefault(h, set()).add(pdf.name)
    shared = {h for h, names in seen_hashes.items() if len(names) >= 3}
    for pdf in pdfs:
        slug = slugify(pdf.name)
        d = WORK / slug
        d.mkdir(parents=True, exist_ok=True)
        kept = 0
        strips = []
        for b in carved[pdf.name]:
            if hashlib.md5(b).hexdigest() in shared:
                continue
            try:
                im = Image.open(io.BytesIO(b))
                w, h = im.size
            except Exception:
                continue
            if min(w, h) < 140 or max(w, h) < 450:  # logos, icons
                continue
            f = d / f"img_{kept:02d}.jpg"
            f.write_bytes(b)
            strips.append({"file": f.name, "px": [w, h]})
            kept += 1
        state["ships"][slug] = {"pdf": pdf.name, "strips": strips}
        print(f"{slug}: {kept} deck strips carved ({pdf.name})")
    save_state(state)


def ingest(args):
    """Register a directory of per-ship deck images (e.g. Widgety NCL pulls) into state.
    Layout: <dir>/<slug>/<deck>.png|jpg — everything downstream (prep/submit/assemble)
    then works exactly as for carved Carnival strips."""
    state = load_state()
    src = Path(args.dir).expanduser()
    for shipdir in sorted(d for d in src.iterdir() if d.is_dir()):
        slug = shipdir.name
        d = WORK / slug
        d.mkdir(parents=True, exist_ok=True)
        strips = []
        for i, f in enumerate(sorted(shipdir.glob("*"))):
            if f.suffix.lower() not in (".png", ".jpg", ".jpeg"):
                continue
            im = Image.open(f)
            out = d / f"img_{i:02d}.jpg"
            im.convert("RGB").save(out, quality=92)
            strips.append({"file": out.name, "px": list(im.size), "source": f.name})
        state["ships"][slug] = {"pdf": f"ingested:{src.name}", "strips": strips}
        print(f"{slug}: {len(strips)} deck images ingested")
    save_state(state)


def prep(args):
    state = load_state()
    n_tiles = 0
    for slug, ship in state["ships"].items():
        if ship.get("submitted_at"):
            continue
        d = WORK / slug
        for strip in ship["strips"]:
            w, h = strip["px"]
            long_axis = "y" if h >= w else "x"
            L = max(w, h)
            im = Image.open(d / strip["file"])
            n = max(1, round(L / TILE_LEN))
            step = L / n
            tiles = []
            for ti in range(n):
                a = max(0, int(ti * step) - (OVERLAP_PX if ti else 0))
                b = min(L, int((ti + 1) * step) + (OVERLAP_PX if ti < n - 1 else 0))
                box = (0, a, w, b) if long_axis == "y" else (a, 0, b, h)
                part = im.crop(box)
                part = part.resize((part.width * UPSCALE, part.height * UPSCALE), Image.LANCZOS)
                if max(part.size) > API_MAX_EDGE:
                    part.thumbnail((API_MAX_EDGE, API_MAX_EDGE), Image.LANCZOS)
                fn = strip["file"].replace(".jpg", f"_t{ti}.jpg")
                part.convert("RGB").save(d / fn, quality=88)
                tiles.append({"file": fn, "offset": a, "len": b - a})
            strip["long_axis"], strip["halves"] = long_axis, tiles
            n_tiles += n
    save_state(state)
    print(f"prep done: {n_tiles} read-units across {len(state['ships'])} ships")


def _vision_request(img_path):
    b64 = base64.standard_b64encode(img_path.read_bytes()).decode()
    return {"model": MODEL, "max_tokens": 16000,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
                {"type": "text", "text": READ_PROMPT}]}]}


def submit(args):
    state = load_state()
    reqs, est_tokens, ships_in = [], 0, []
    for slug, ship in state["ships"].items():
        if args.only and args.only.lower() not in slug:
            continue
        if ship.get("submitted_at"):
            continue
        ships_in.append(slug)
        for si, strip in enumerate(ship["strips"]):
            for hi, half in enumerate(strip.get("halves", [])):
                p = WORK / slug / half["file"]
                im = Image.open(p)
                est_tokens += (im.width * im.height) // 750 + 400
                reqs.append({"custom_id": f"{slug}--{si:02d}--{hi}", "params": _vision_request(p)})
    if not reqs:
        sys.exit("nothing to submit — run carve + prep first")
    est_cost = est_tokens * 3e-6 * 0.5 + len(reqs) * 4000 * 15e-6 * 0.5  # batch = 50% off
    print(f"{len(reqs)} vision reads, est ~{est_tokens/1000:.0f}K input tokens, est cost ~${est_cost:.2f} (Batch API, {MODEL})")
    if args.dry_run:
        return
    # Chunk: base64 images make one giant POST brush the API's 256MB request cap.
    CHUNK = 150
    for ci in range(0, len(reqs), CHUNK):
        chunk = reqs[ci:ci + CHUNK]
        out = json.loads(api("POST", "/messages/batches", {"requests": chunk}, timeout=900))
        state["batches"].append({"id": out["id"], "n": len(chunk), "submitted": time.strftime("%F %T"),
                                 "status": out.get("processing_status")})
        save_state(state)
        print(f"submitted batch {out['id']} ({len(chunk)} requests)")
    for slug in ships_in:
        state["ships"][slug]["submitted_at"] = time.strftime("%F %T")
    save_state(state)
    print(f"{len(state['batches'])} batches total. Poll with: python3 geometry-carnival.py poll")


def poll(args):
    state = load_state()
    open_batches = [b for b in state["batches"] if b.get("status") != "ended"]
    if not open_batches:
        print("no open batches")
        return
    for b in open_batches:
        j = json.loads(api("GET", f"/messages/batches/{b['id']}"))
        b["status"] = j["processing_status"]
        counts = j.get("request_counts", {})
        print(f"{b['id']}: {b['status']}  {counts}")
        if b["status"] == "ended":
            results = api("GET", None, raw_url=j["results_url"], timeout=600).decode()
            (GEO / f"results_{b['id']}.jsonl").write_text(results)
            print(f"  results saved -> geometry/results_{b['id']}.jsonl")
    save_state(state)


def _extract_json(text):
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    # Salvage a truncated (max_tokens) response: pull every complete cabin object
    # individually; the tile is then flagged for a re-read but keeps what it saw.
    cabins = []
    for cm in re.finditer(r'\{"num":\s*"([^"]+)",\s*"x":\s*([\d.]+),\s*"y":\s*([\d.]+)(?:,\s*"color":\s*"([^"]*)")?\}', text):
        cabins.append({"num": cm.group(1), "x": float(cm.group(2)), "y": float(cm.group(3)),
                       "color": cm.group(4)})
    if not cabins:
        return None
    dl = re.search(r'"deck_label":\s*(\d+)', text)
    return {"deck_label": int(dl.group(1)) if dl else None, "cabins": cabins, "_salvaged": True}


def assemble(args):
    state = load_state()
    reads = {}
    truncated = []
    for f in GEO.glob("results_*.jsonl"):
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            res = row.get("result", {})
            if res.get("type") != "succeeded":
                print(f"  ! {row['custom_id']}: {res.get('type')}")
                continue
            text = "".join(bk.get("text", "") for bk in res["message"]["content"] if bk["type"] == "text")
            parsed = _extract_json(text)
            if res["message"].get("stop_reason") == "max_tokens":
                n = len(parsed.get("cabins", [])) if parsed else 0
                print(f"  ! {row['custom_id']}: TRUNCATED at max_tokens — salvaged {n} cabins, needs re-read")
                truncated.append(row["custom_id"])
            if parsed is not None:
                reads[row["custom_id"]] = parsed
    if truncated:
        (GEO / "truncated_tiles.json").write_text(json.dumps(truncated, indent=1))
        print(f"{len(truncated)} truncated tiles listed in geometry/truncated_tiles.json")
    OUT.mkdir(parents=True, exist_ok=True)
    for slug, ship in state["ships"].items():
        decks, total = [], 0
        for si, strip in enumerate(ship["strips"]):
            w, h = strip["px"]
            axis, L = strip.get("long_axis", "y"), max(strip["px"])
            merged, labels = {}, []
            for hi, half in enumerate(strip.get("halves", [])):
                r = reads.get(f"{slug}--{si:02d}--{hi}")
                if not r:
                    continue
                if r.get("deck_label") is not None:
                    labels.append(r["deck_label"])
                for c in r.get("cabins", []):
                    try:
                        num = str(c["num"]); x, y = float(c["x"]), float(c["y"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    if axis == "y":
                        y = (half["offset"] + y * half["len"]) / L
                    else:
                        x = (half["offset"] + x * half["len"]) / L
                    if num in merged:  # overlap dedupe: average the two sightings
                        m = merged[num]
                        m["x"], m["y"] = round((m["x"] + x) / 2, 4), round((m["y"] + y) / 2, 4)
                    else:
                        merged[num] = {"num": num, "x": round(x, 4), "y": round(y, 4),
                                       "color": c.get("color")}
            if not merged:
                continue
            # Deck number: Carnival's own convention is deck = cabin-number prefix (1210 -> 1),
            # so the modal prefix wins; the printed label is only a fallback (models have
            # misread it — the Breeze deck-1 strip came back label "11").
            prefixes = [int(n[:-3]) for n in merged if n[:-3].isdigit() and len(n) >= 4]
            deck = (max(set(prefixes), key=prefixes.count) if prefixes else (labels[0] if labels else None))
            cabs = sorted(merged.values(), key=lambda c: (c["y"], c["x"]))
            decks.append({"deck": deck, "source_image_px": strip["px"], "cabins": cabs})
            total += len(cabs)
        if decks:
            out_f = OUT / f"{slug}.json"
            out_f.write_text(json.dumps({"ship": slug.replace("-", " ").title(), "slug": slug,
                                         "source_pdf": ship["pdf"], "method": "carve+vision (Batch API)",
                                         "decks": decks}, indent=1))
            print(f"{slug}: {total} cabins across {len(decks)} decks -> geometry/out/{slug}.json")


def reread(args):
    """Re-read tiles that truncated or errored in the batch: sub-split each into 2 overlapping
    halves, read synchronously, remap to tile-space coords, and write a supplemental results
    file (sorts after the batch files, so assemble's per-custom_id dict takes these versions)."""
    state = load_state()
    ids = set(json.loads((GEO / "truncated_tiles.json").read_text()) if (GEO / "truncated_tiles.json").exists() else [])
    for f in GEO.glob("results_msgbatch_*.jsonl"):
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("result", {}).get("type") not in (None, "succeeded"):
                ids.add(row["custom_id"])
    if not ids:
        print("nothing to re-read")
        return
    out_lines = []
    for cid in sorted(ids):
        slug, si, hi = cid.rsplit("--", 2)
        tile = state["ships"][slug]["strips"][int(si)]["halves"][int(hi)]
        im = Image.open(WORK / slug / tile["file"])
        w, h = im.size
        axis_long = max(w, h)
        vert = h >= w
        merged, labels = {}, []
        cut_a = int(axis_long * 0.53)
        cut_b = int(axis_long * 0.47)
        boxes = [(0, 0, w, cut_a), (0, cut_b, w, h)] if vert else [(0, 0, cut_a, h), (cut_b, 0, w, h)]
        for box in boxes:
            part = im.crop(box)
            part = part.resize((part.width * 2, part.height * 2), Image.LANCZOS)
            if max(part.size) > API_MAX_EDGE:
                part.thumbnail((API_MAX_EDGE, API_MAX_EDGE), Image.LANCZOS)
            buf = io.BytesIO(); part.convert("RGB").save(buf, "JPEG", quality=88)
            b64 = base64.standard_b64encode(buf.getvalue()).decode()
            body = {"model": MODEL, "max_tokens": 16000,
                    "messages": [{"role": "user", "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
                        {"type": "text", "text": READ_PROMPT}]}]}
            j = json.loads(api("POST", "/messages", body))
            text = "".join(b.get("text", "") for b in j["content"] if b["type"] == "text")
            r = _extract_json(text) or {}
            if r.get("deck_label") is not None:
                labels.append(r["deck_label"])
            off, ln = (box[1], box[3] - box[1]) if vert else (box[0], box[2] - box[0])
            for c in r.get("cabins", []):
                try:
                    num = str(c["num"]); x, y = float(c["x"]), float(c["y"])
                except (KeyError, TypeError, ValueError):
                    continue
                if vert:
                    y = (off + y * ln) / axis_long
                else:
                    x = (off + x * ln) / axis_long
                merged.setdefault(num, {"num": num, "x": round(x, 4), "y": round(y, 4),
                                        "color": c.get("color")})
        payload = {"deck_label": labels[0] if labels else None, "cabins": list(merged.values())}
        out_lines.append(json.dumps({"custom_id": cid, "result": {"type": "succeeded", "message": {
            "stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps(payload)}]}}}))
        print(f"  reread {cid}: {len(merged)} cabins")
    (GEO / "results_zz_reread.jsonl").write_text("\n".join(out_lines) + "\n")
    print(f"wrote geometry/results_zz_reread.jsonl ({len(out_lines)} tiles) — re-run assemble")


def direct(args):
    """Smoke test one strip synchronously through the exact same read prompt."""
    state = load_state()
    ship = state["ships"].get(args.slug) or sys.exit(f"unknown slug {args.slug} — run carve first")
    strip = ship["strips"][args.img]
    total, labels = {}, []
    for hi, half in enumerate(strip.get("halves", [])):
        body = _vision_request(WORK / args.slug / half["file"])
        j = json.loads(api("POST", "/messages", body))
        text = "".join(b.get("text", "") for b in j["content"] if b["type"] == "text")
        if j.get("stop_reason") == "max_tokens":
            print(f"  ! half {hi}: TRUNCATED at max_tokens — tile too dense")
        r = _extract_json(text) or {}
        if r.get("deck_label") is not None:
            labels.append(r["deck_label"])
        for c in r.get("cabins", []):
            total[str(c.get("num"))] = c
        u = j["usage"]
        print(f"  half {hi}: {len(r.get('cabins', []))} cabins  ({u['input_tokens']}in/{u['output_tokens']}out)")
    print(f"direct read {args.slug} img {args.img}: {len(total)} unique cabins, deck label {labels}")


def status(args):
    state = load_state()
    n_strips = sum(len(s["strips"]) for s in state["ships"].values())
    print(f"{len(state['ships'])} ships carved, {n_strips} strips; batches: "
          f"{[(b['id'], b.get('status')) for b in state['batches']] or 'none'}")
    for f in sorted(OUT.glob("*.json")):
        d = json.loads(f.read_text())
        print(f"  out/{f.name}: {sum(len(x['cabins']) for x in d['decks'])} cabins / {len(d['decks'])} decks")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="stage", required=True)
    c = sub.add_parser("carve"); c.add_argument("--pdf-dir", default=str(DEFAULT_PDF_DIR)); c.add_argument("--only")
    g = sub.add_parser("ingest"); g.add_argument("--dir", required=True)
    sub.add_parser("prep")
    s = sub.add_parser("submit"); s.add_argument("--only"); s.add_argument("--dry-run", action="store_true")
    sub.add_parser("poll")
    sub.add_parser("assemble")
    sub.add_parser("reread")
    d = sub.add_parser("direct"); d.add_argument("--slug", required=True); d.add_argument("--img", type=int, default=0)
    sub.add_parser("status")
    a = ap.parse_args()
    {"carve": carve, "ingest": ingest, "prep": prep, "submit": submit, "poll": poll,
     "assemble": assemble, "reread": reread, "direct": direct, "status": status}[a.stage](a)
