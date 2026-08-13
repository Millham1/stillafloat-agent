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
# Optional: enables the live presentation-reasoning pass (mirrors cabins.ts).
# Without it the preview serves the stored archetype text (the fallback path).
AKEY = os.environ.get("ANTHROPIC_API_KEY", "")

# Live reasoning uses the SAME locked voice guide as everything else.
_vg = (Path(__file__).resolve().parent / "voice-guide.md").read_text()
VOICE = _vg.split("\n---\n", 1)[1].strip() if "\n---\n" in _vg else _vg.strip()


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
    "first-couple-ocean-steady":  ["couple", "middle", "ocean", "steady", "oceanview", "balcony"],
    "couple-ocean-balcony-treat": ["couple", "treat", "ocean", "balcony"],
    "anniversary-suite-splurge":  ["couple", "sky", "treat", "space", "suite"],
    "family-action-boardwalk":    ["family", "middle", "action", "balcony"],
    "family-value-space":         ["family", "lean", "space", "inside", "oceanview"],
    "quiet-retirees-calm":        ["couple", "quiet", "middle", "balcony"],
    "value-hunter-ocean":         ["lean", "ocean", "oceanview", "inside"],
    "solo-first-value":           ["solo", "lean", "inside", "oceanview"],
    "solo-with-group":            ["solo-group"],
    "big-group-together":         ["group", "space"],
    "experienced-ocean-midship":  ["couple", "ocean", "middle", "steady", "balcony"],
    "seasick-priority-steady":    ["steady", "quiet"],
}


def pick_archetype(rows, a):
    want = {v for v in [a.get("party"), a.get("room"), a.get("budget"), a.get("priority"),
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


# ── Live presentation reasoning (mirrors cabins.ts reasonLive) ────────────────
_live_cache = {}


def _answers_sentences(a):
    bits = []
    party = a.get("party")
    if party == "couple": bits.append("They are a couple — one cabin, two people.")
    elif party == "family": bits.append("They are a family with kids and need room for everyone.")
    elif party == "solo": bits.append("They are travelling solo.")
    elif party == "solo-group": bits.append("They are travelling solo, alongside a group of friends in other cabins.")
    elif party == "group": bits.append("They are a group booking several cabins who want to stay near each other.")
    room = a.get("room")
    if room == "inside": bits.append("They're picturing an inside room — the ship is the destination.")
    elif room == "oceanview": bits.append("They want a window on the water, without a balcony.")
    elif room == "balcony": bits.append("They're picturing a balcony.")
    elif room == "suite": bits.append("They want a suite — space to properly settle in.")
    pri = a.get("priority")
    if pri == "ocean": bits.append("What matters most to them: waking up to a real ocean view.")
    elif pri == "quiet": bits.append("What matters most to them: peace and quiet.")
    elif pri == "action": bits.append("What matters most to them: being near the action.")
    elif pri == "space": bits.append("What matters most to them: room to spread out.")
    bits.append("Someone in the cabin gets seasick — steadiness genuinely matters to them."
                if a.get("motion") else
                "Nobody gets seasick. Do NOT mention motion, sway, steadiness, queasiness, stomachs or seasickness at all — not even to reassure them.")
    return " ".join(bits)


def reason_live(ship_name, answers, picks, steer_clear):
    if not AKEY or not picks:
        return None
    key = json.dumps([ship_name, answers.get("party"), answers.get("room"),
                      answers.get("priority"), bool(answers.get("motion"))])
    if key in _live_cache:
        return _live_cache[key]

    cabin_data = [{"cabin": p["cabin"], "facts": p.get("facts"),
                   "backgroundNotes": p.get("reason")} for p in picks]
    prompt = f"""The traveler in front of you: {_answers_sentences(answers)}

Ship: {ship_name}.

The cabins you've already shortlisted for them, with saved facts and your background notes on each (the notes are research — take the facts from them, but write fresh for THIS traveler; do not copy their wording):
{json.dumps(cabin_data)}

Cabins you'd steer them away from (same treatment):
{json.dumps(steer_clear)}

Write, for each shortlisted cabin, in rank order:
- "hook": a 5-10 word headline naming the room type and tying it to what THIS traveler told you they want. Like "Boardwalk balcony to watch the action from your own roost" or "An ocean balcony for your quiet morning coffee". Never a spec line like "Ocean View Balcony on Deck 8". Every hook different in wording AND structure — no template reuse.
- "reason": 2-4 sentences in your voice, reasoned for this traveler's answers specifically. Differentiate every cabin; where two are nearly the same, say so and give the honest tie-breaker. Vary your openings — don't start each one the same way.
And rewrite each steer-clear reason for this traveler (1-2 sentences).

Speak ONLY to concerns they actually told you. REQUIRED, not optional: at least one genuinely funny dry line across the set, in your register (situational — buffets, conga lines, pool-chair hogs, pajamas at sea — never at the traveler). Final check before answering: if any sentence contains "best match", "perfect for", "exactly what you're after", "boasts", "offers", "features", or could run in a cruise brochure unchanged, rewrite it first. Respond with ONLY a JSON object:
{{"recommendations":[{{"cabin":"<number>","hook":"...","reason":"..."}}],"steerClear":[{{"cabin":"<number or area>","reason":"..."}}]}}"""

    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps({
                "model": "claude-haiku-4-5", "max_tokens": 1800, "system": VOICE,
                "messages": [{"role": "user", "content": prompt}],
            }).encode(),
            headers={"x-api-key": AKEY, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.load(r)
        text = "".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text")
        start, end = text.find("{"), text.rfind("}")
        out = json.loads(text[start:end + 1])
        if not out.get("recommendations"):
            raise ValueError("empty recommendations")
        _live_cache[key] = out
        return out
    except Exception as e:
        print(f"live reasoning failed ({e}); serving stored text", file=sys.stderr)
        return None


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
        if self.path.startswith("/api/cabins/deckmap"):
            try:
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                ship = (qs.get("ship") or [""])[0]
                deck = (qs.get("deck") or [""])[0]
                if not ship or not deck:
                    return self._json({"error": "ship and deck are required"}, 400)
                cabs = sb(f"cabins?select=cabin_num,x,y,category&ship_slug=eq.{urllib.parse.quote(ship)}"
                          f"&deck=eq.{urllib.parse.quote(deck)}&x=not.is.null")
                return self._json({"deck": int(deck), "cabins": cabs})
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
            ship_name = (srow[0].get("ship") if srow else None) or ship
            steer = advice.get("steer_clear") or []
            geom = sb(f"cabins?select=id&ship_slug=eq.{urllib.parse.quote(ship)}&x=not.is.null&limit=1")

            # Live pass: rewrite hook + reason for THIS visitor. Stored text is
            # the grounding and the fallback — never blocks the response.
            live = reason_live(ship_name, body, picks, steer)
            if live:
                by_cabin = {str(r["cabin"]): r for r in live["recommendations"]}
                picks = [{**p, "hook": by_cabin.get(p["cabin"], {}).get("hook", p.get("hook")),
                          "reason": by_cabin.get(p["cabin"], {}).get("reason") or p.get("reason")}
                         for p in picks]
                if live.get("steerClear"):
                    steer = live["steerClear"]

            return self._json({
                "ship": {**(srow[0] if srow else {"ship": ship}), "slug": ship},
                "archetype": {"id": advice["archetype_id"], "label": advice.get("label")},
                "picks": picks,
                "steerClear": steer,
                "reasonedLive": bool(live),
                "hasDeckMap": bool(geom),
            })
        except Exception as e:
            return self._json({"error": str(e)}, 500)

    def log_message(self, *a):
        pass


print(f"cabin concierge preview  →  http://localhost:{PORT}/cabin-finder.html")
print(f"serving {ROOT}  (branch: feature/cabin-concierge, data: dev Supabase)")
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
