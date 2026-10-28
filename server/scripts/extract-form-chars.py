#!/usr/bin/env python3
# extract-form-chars.py — where every letter sits on Mark's own PDFs of the client documents (Mark 2026-10-27: the client is shown
# "the actual populated document"). For each server/data/client-forms/<key>.pdf it writes <key>.chars.json: the page sizes, the
# letters in the order the PDF draws them (spaces left out) and each letter's box. lib/form-pdf.ts lines that up with the document's
# own wording to know where each answer, tick and cover goes.
#
# Run after replacing a PDF:   python3 -I server/scripts/extract-form-chars.py
# (needs pdfplumber; the server itself only reads the JSON). lib/form-pdf.test.ts fails when a JSON no longer matches its PDF.
import hashlib, json, pathlib, sys

import pdfplumber

DIR = pathlib.Path(__file__).resolve().parent.parent / "data" / "client-forms"


def extract(pdf_path: pathlib.Path) -> dict:
    out = {"sha256": hashlib.sha256(pdf_path.read_bytes()).hexdigest(), "pages": [], "text": "", "style": "", "box": []}
    text, style, box = [], [], []
    with pdfplumber.open(pdf_path) as pdf:
        for n, page in enumerate(pdf.pages):
            out["pages"].append([round(float(page.width), 2), round(float(page.height), 2)])
            for c in page.chars:
                ch = c["text"]
                if not ch or ch.isspace():
                    continue
                text.append(ch)
                # 0 regular, 1 bold, 2 italic, 3 both: words written over the PDF take the look of the words they replace
                f = str(c.get("fontname", "")).lower()
                style.append(str((1 if "bold" in f else 0) + (2 if ("italic" in f or "oblique" in f) else 0)))
                # page, left, top, right, bottom (points from the top-left corner), to a tenth of a point
                box.append([n, round(c["x0"], 1), round(c["top"], 1), round(c["x1"], 1), round(c["bottom"], 1)])
    out["text"] = "".join(text)
    out["style"] = "".join(style)
    out["box"] = box
    return out


def main() -> int:
    pdfs = sorted(DIR.glob("*.pdf"))
    if not pdfs:
        print(f"no PDFs in {DIR}", file=sys.stderr)
        return 1
    for p in pdfs:
        data = extract(p)
        p.with_suffix(".chars.json").write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n")
        print(f"{p.name}: {len(data['pages'])} pages, {len(data['text'])} letters")
    return 0


if __name__ == "__main__":
    sys.exit(main())
