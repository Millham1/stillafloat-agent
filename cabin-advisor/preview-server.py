#!/usr/bin/env python3
"""preview-server.py — run a FEATURE BRANCH locally so it can be tested.

Why this exists (Mark, 2026-08-09): the deploy model has exactly two
environments, each hard-wired to a branch — dev box <- `dev`, prod box <- `main`.
So a feature branch is stored code that nothing executes, and there was no way to
click through a feature before merging it. That defeats the point of branching.

This serves server/public/ plus a faithful stand-in for the /api/cabins/* routes,
querying the REAL dev Supabase. It is a local harness only: no deploy, no box, no
branch merge required.

Usage:
    set -a; . /tmp/.devenv; set +a        # SUPABASE_URL + SUPABASE_SERVICE_KEY
    python3 cabin-advisor/preview-server.py [port]
Then open http://localhost:<port>/cabin-finder.html
"""
import json, os, sys, urllib.parse, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
ROOT = Path(__file__).resolve().parent.parent / "server" / "public"
URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
if not URL or not KEY:
    sys.exit("SUPABASE_URL and SUPABASE_SERVICE_KEY are required")


def sb(path: str):
    req = urllib.request.Request(
        f"{URL}/rest/v1/{path}",
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


# Mirrors routes/cabins.ts — party is weighted highest so a family never gets a
# couple's advice. Keep this table IDENTICAL to the one in cabins.ts: a partial
# table caused quiet-seeking couples to be served the sensitive-stomach
# archetype's reasoning (fixed both places 2026-08-12).
ARCHETYPE_TAGS = {
    "first-couple-ocean-steady":  ["couple", "middle", "ocean", "steady"],
    "couple-ocean-balcony-treat": ["couple", "treat", "ocean"],
    "anniversary-suite-splurge":  ["couple", "sky", "treat", "space"],
    "family-action-boardwalk":    ["family", "middle", "action"],
    "family-value-space":         ["family", "lean", "space"],
    "quiet-retirees-calm":        ["couple", "quiet", "middle"],
    "value-hunter-ocean":         ["lean", "ocean"],
    "solo-first-value":           ["solo", "lean"],
    "solo-with-group":            ["solo-group"],
    "big-group-together":         ["group", "space"],
    "experienced-ocean-midship":  ["couple", "ocean", "middle", "steady"],
    "seasick-priority-steady":    ["steady", "quiet"],
}


def pick_archetype(rows, a):
    want = {v for v in [a.get("party"), a.get("budget"), a.get("priority"),
                        "steady" if a.get("motion") else ""] if v}
    best, best_score = rows[0]["archetype_id"], -1
    for r in rows:
        tags = ARCHETYPE_TAGS.get(r["archetype_id"], r["archetype_id"].split("-"))
        score = sum(1 for t in tags if t in want)
        if a.get("party") and a["party"] in tags:
            score += 2
        if score > best_score:
            best, best_score = r["archetype_id"], score
    return best


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/api/cabins/ships"):
            try:
                advice = sb("cabin_advice?select=ship_slug")
                slugs = sorted({r["ship_slug"] for r in advice})
                if not slugs:
                    return self._json({"ships": []})
                q = urllib.parse.quote(",".join(slugs))
                ships = sb(f"cabin_ships?select=slug,ship,line,class,total_cabins&slug=in.({q})")
                return self._json({"ships": ships})
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        return super().do_GET()

    def do_POST(self):
        if not self.path.startswith("/api/cabins/recommend"):
            return self._json({"error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            ship = body.get("ship")
            if not ship:
                return self._json({"error": "ship is required"}, 400)

            rows = sb(f"cabin_advice?select=archetype_id,label,recommendations,steer_clear"
                      f"&ship_slug=eq.{urllib.parse.quote(ship)}")
            if not rows:
                return self._json({"error": "No advice for that ship yet"}, 404)

            chosen = pick_archetype(rows, body)
            advice = next((r for r in rows if r["archetype_id"] == chosen), rows[0])
            recs = sorted(advice.get("recommendations") or [], key=lambda r: r.get("rank", 99))
            nums = ",".join(urllib.parse.quote(str(r["cabin"])) for r in recs)
            facts = sb(f"cabins?select=cabin_num,deck,category,section,side,view,sleeps,obstruction,tour"
                       f"&ship_slug=eq.{urllib.parse.quote(ship)}&cabin_num=in.({nums})") if nums else []
            by_num = {str(f["cabin_num"]): f for f in facts}
            picks = [{**r, "cabin": str(r["cabin"]), "facts": by_num.get(str(r["cabin"]))} for r in recs]

            srow = sb(f"cabin_ships?select=ship,line,class&slug=eq.{urllib.parse.quote(ship)}")
            return self._json({
                "ship": srow[0] if srow else {"ship": ship},
                "archetype": {"id": advice["archetype_id"], "label": advice.get("label")},
                "picks": picks,
                "steerClear": advice.get("steer_clear") or [],
            })
        except Exception as e:
            return self._json({"error": str(e)}, 500)

    def log_message(self, *a):
        pass


print(f"cabin concierge preview  →  http://localhost:{PORT}/cabin-finder.html")
print(f"serving {ROOT}  (branch: feature/cabin-concierge, data: dev Supabase)")
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
