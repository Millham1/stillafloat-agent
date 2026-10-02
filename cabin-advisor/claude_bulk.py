"""claude_bulk.py — the rules every Claude call from the cabin-advisor Python scripts obeys.

The Python twin of server/src/lib/claude-core.mjs (same rules, same job registry,
same price table, same audit log). Decided by Mark on 2026-10-02 ("do both"):

1. MODEL. The workhorse is Claude Sonnet 5.5 ("claude-sonnet-5-5"); same per-token price as
   Sonnet 5 on the pricing page the same day ($2 in / $10 out per million, $1 / $5 batched).
2. JOB TAG. Every request carries metadata.user_id = "site:<job>"; the tag must be listed in
   server/src/lib/llm-jobs.json. api() refuses to POST an untagged Messages request.
3. BULK RUNS. A run of more than BULK_MIN_CALLS calls (retries counted) or with an unbatched
   ceiling over BULK_MIN_DOLLARS must print a cost estimate first, go through the Message
   Batches API (or carry --no-batch "<reason>", printed and audited), keep any content of
   1,024+ tokens that repeats across calls inside a cache_control-marked prefix, and carry
   --approved-cost <dollars> at or above the ceiling — Mark's quoted yes.

The stage-based scripts (geometry-carnival.py, noise-features.py) call gate() in their submit
stage and submit_batches() for the POST; the in-process ones call run_bulk(). One-off calls go
through sync_call(), which refuses the 21st in a process.
"""
import base64, hashlib, io, json, math, os, sys, time, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
JOBS = json.loads((HERE.parent / "server" / "src" / "lib" / "llm-jobs.json").read_text())

API = "https://api.anthropic.com/v1"
API_VERSION = "2023-06-01"
MODELS = {"DEFAULT": "claude-sonnet-5-5", "CHEAP": "claude-haiku-4-5"}

BULK_MIN_CALLS = 20
BULK_MIN_DOLLARS = 2.0
CACHE_MIN_SHARED_TOKENS = 1024
ASSUME = {"batch_cache_hit_rate": 0.3, "sync_cache_hit_rate": 0.9, "retry_rate": 0.25}

# $ per million tokens, first-party API, pricing page 2026-10-02. Batch = 50% of every line.
PRICES = {
    "claude-sonnet-5-5": {"input": 2, "output": 10, "write5m": 2.5, "write1h": 4, "read": 0.2},
    "claude-sonnet-5": {"input": 2, "output": 10, "write5m": 2.5, "write1h": 4, "read": 0.2},
    "claude-haiku-4-5": {"input": 1, "output": 5, "write5m": 1.25, "write1h": 2, "read": 0.1},
    "claude-opus-5-5": {"input": 4, "output": 20, "write5m": 5, "write1h": 8, "read": 0.2},
    "claude-opus-5": {"input": 5, "output": 25, "write5m": 6.25, "write1h": 10, "read": 0.5},
    "claude-sonnet-4-6": {"input": 3, "output": 15, "write5m": 3.75, "write1h": 6, "read": 0.3},
}
BATCH_FACTOR = 0.5
WEB_SEARCH_DOLLARS = 0.01
CACHE_MIN_PREFIX_TOKENS = {"claude-sonnet-5-5": 512, "claude-opus-5-5": 512, "claude-opus-5": 512,
                           "claude-sonnet-5": 1024, "claude-sonnet-4-6": 1024, "claude-haiku-4-5": 4096}
IMAGE_TOKENS = 3000
TOOL_OVERHEAD_TOKENS = 600
UNIT_CHARS = 2000


class BulkRuleError(Exception):
    """rule: 'cache' | 'batch' | 'approval' | 'budget'"""

    def __init__(self, rule, message):
        super().__init__(message)
        self.rule = rule


class JobTagError(Exception):
    pass


# ── models ───────────────────────────────────────────────────────────────────

def canonical_model(model):
    m = str(model or "")
    if m.startswith("anthropic."):
        m = m[len("anthropic."):]
    parts = m.rsplit("-", 1)
    if len(parts) == 2 and len(parts[1]) == 8 and parts[1].isdigit():
        m = parts[0]
    return m


def price_for(model):
    p = PRICES.get(canonical_model(model))
    if not p:
        raise ValueError(f'No price on file for model "{model}" — add it to PRICES in claude_bulk.py and claude-core.mjs')
    return p


def rejects_forced_tool_choice(model):
    m = canonical_model(model)
    for fam, lo in (("sonnet", 5), ("opus", 5)):
        if m.startswith(f"claude-{fam}-5-") and m.split("-")[3].isdigit() and int(m.split("-")[3]) >= lo:
            return True
    for fam in ("fable", "mythos"):
        if m.startswith(f"claude-{fam}-5-") and m.split("-")[3].isdigit() and int(m.split("-")[3]) >= 1:
            return True
    return False


def rejects_sampling(model):
    m = canonical_model(model)
    return any(m == f"claude-{f}-5" or m.startswith(f"claude-{f}-5-") for f in ("sonnet", "opus", "fable", "mythos")) \
        or m in ("claude-opus-4-7", "claude-opus-4-8")


def supports_between_tools(model):
    return canonical_model(model) == "claude-sonnet-5-5"


# ── job tags ─────────────────────────────────────────────────────────────────

def job_user_id(job, service="site"):
    if not isinstance(job, str) or not job.strip():
        raise JobTagError('Every Claude request needs a job tag (e.g. "cabin.geometry") so the Console can attribute it')
    table = JOBS.get(service)
    if table is None:
        raise JobTagError(f'Unknown service "{service}" for a job tag')
    if job not in table:
        raise JobTagError(f'Job tag "{job}" is not registered — add it to server/src/lib/llm-jobs.json')
    return f"{service}:{job}"


def with_job_tag(body, job, service="site"):
    out = dict(body)
    out["metadata"] = {**(body.get("metadata") or {}), "user_id": job_user_id(job, service)}
    return out


def assert_request_allowed(body):
    model = body.get("model")
    if not model:
        raise ValueError("Claude request has no model")
    if not (body.get("metadata") or {}).get("user_id"):
        raise JobTagError("Claude request has no job tag (metadata.user_id) — use with_job_tag()")
    if rejects_sampling(model):
        for k in ("temperature", "top_p", "top_k"):
            if k in body:
                raise ValueError(f"{k} is rejected by {model} (a hard 400) — remove it")
    tc = (body.get("tool_choice") or {}).get("type")
    if rejects_forced_tool_choice(model) and tc in ("any", "tool"):
        raise ValueError(f'{model} rejects a forced tool_choice ("{tc}")')
    if supports_between_tools(model) and (body.get("thinking") or {}).get("type") == "disabled":
        raise ValueError(f'{model} rejects thinking "disabled" — use {{"type": "between_tools"}}')


# ── estimates ────────────────────────────────────────────────────────────────

def estimate_tokens(text):
    return math.ceil(len(str(text or "")) / 3)


def image_tokens(block):
    """(width x height) / 750 when the image can be measured, else a generous default."""
    try:
        from PIL import Image
        data = base64.b64decode(block["source"]["data"])
        with Image.open(io.BytesIO(data)) as im:
            return max(1, (im.width * im.height) // 750)
    except Exception:
        return IMAGE_TOKENS


def _digest(s):
    return hashlib.sha1(s.encode() if isinstance(s, str) else s).hexdigest()


def _stable(v):
    if isinstance(v, dict):
        return "{" + ",".join(f"{json.dumps(k)}:{_stable(v[k])}" for k in sorted(v) if k != "cache_control") + "}"
    if isinstance(v, list):
        return "[" + ",".join(_stable(x) for x in v) + "]"
    return json.dumps(v)


def _block_text(b):
    if isinstance(b, str):
        return b
    if isinstance(b, dict) and b.get("type") == "text":
        return str(b.get("text") or "")
    return None


def _units(text):
    out = []
    for line in text.split("\n"):
        if not line.strip():
            continue
        for i in range(0, len(line), UNIT_CHARS):
            piece = line[i:i + UNIT_CHARS]
            out.append({"key": _digest(piece), "tokens": estimate_tokens(piece), "sample": piece})
    return out


def render_blocks(params):
    blocks = []

    def push(where, b, cached):
        t = _block_text(b)
        if t is not None:
            blocks.append({"key": _digest(f"{where}|{t}"), "tokens": estimate_tokens(t), "cached": cached, "units": _units(t)})
        else:
            raw = _stable(b)
            tok = image_tokens(b) if isinstance(b, dict) and b.get("type") == "image" else estimate_tokens(raw)
            key = _digest(f"{where}|{raw}")
            blocks.append({"key": key, "tokens": tok, "cached": cached,
                           "units": [{"key": key, "tokens": tok, "sample": f"[{(b or {}).get('type', 'block')}]"}]})

    for tool in params.get("tools") or []:
        raw = _stable(tool)
        key = _digest(f"tool|{raw}")
        blocks.append({"key": key, "tokens": estimate_tokens(raw), "cached": bool(tool.get("cache_control")),
                       "units": [{"key": key, "tokens": estimate_tokens(raw), "sample": f"[tool {tool.get('name')}]"}]})
    sys_ = params.get("system")
    if isinstance(sys_, str) and sys_:
        push("system", {"type": "text", "text": sys_}, False)
    elif isinstance(sys_, list):
        for b in sys_:
            push("system", b, bool(b.get("cache_control")))
    for m in params.get("messages") or []:
        content = m.get("content")
        content = [{"type": "text", "text": content}] if isinstance(content, str) else (content or [])
        for b in content:
            push(m.get("role"), b, bool(isinstance(b, dict) and b.get("cache_control")))
    return blocks


def analyse_requests(params_list):
    """Same reading as claude-core.mjs: what repeats across calls outside a cached prefix."""
    rendered = [render_blocks(p) for p in params_list]
    n = len(rendered)
    common = min((len(r) for r in rendered), default=0)
    for i in range(common):
        if any(r[i]["key"] != rendered[0][i]["key"] for r in rendered):
            common = i
            break
    problems, cached_upto = [], []
    for ri, blocks in enumerate(rendered):
        last = max((i for i, b in enumerate(blocks) if b["cached"]), default=-1)
        if params_list[ri].get("cache_control") and last < 0:
            last = common - 1
        if last >= 0 and last >= common and n > 1:
            problems.append(f"request {ri}: a cache_control marker sits after content that differs between calls")
            last = -1
        cached_upto.append(last)
    seen_in = {}
    for blocks in rendered:
        for k in {u["key"] for b in blocks for u in b["units"]}:
            seen_in[k] = seen_in.get(k, 0) + 1
    per, max_shared, worst = [], 0, None
    for ri, blocks in enumerate(rendered):
        inp = cached = shared = 0
        biggest = None
        for i, b in enumerate(blocks):
            inp += b["tokens"]
            if i <= cached_upto[ri]:
                cached += b["tokens"]
                continue
            for u in b["units"]:
                if seen_in.get(u["key"], 0) >= 2:
                    shared += u["tokens"]
                    if not biggest or u["tokens"] > biggest["tokens"]:
                        biggest = u
        if params_list[ri].get("tools"):
            inp += TOOL_OVERHEAD_TOKENS
        if shared > max_shared:
            max_shared, worst = shared, biggest
        per.append({"input": inp, "cached": cached, "shared_uncached": shared})
    return {"per_request": per, "max_shared_uncached": max_shared,
            "shared_sample": (worst or {}).get("sample", "")[:80], "problems": sorted(set(problems))[:5]}


def _web_search_uses(params):
    return sum(int(t.get("max_uses", 10)) for t in params.get("tools") or [] if str(t.get("type", "")).startswith("web_search"))


def estimate_run(params_list, analysis=None, attempts=1, batch=False, cache_ttl="5m", expected_output_tokens=None):
    a = analysis or analyse_requests(params_list)
    factor = BATCH_FACTOR if batch else 1.0
    hit = ASSUME["batch_cache_hit_rate"] if batch else ASSUME["sync_cache_hit_rate"]
    ceiling = expected = 0.0
    tin = tcached = tout = 0
    notes = set()
    for i, params in enumerate(params_list):
        p = price_for(params["model"])
        r = a["per_request"][i]
        min_cache = CACHE_MIN_PREFIX_TOKENS.get(canonical_model(params["model"]), 1024)
        cached = r["cached"] if r["cached"] >= min_cache else 0
        if r["cached"] and not cached:
            notes.add(f"{canonical_model(params['model'])} caches nothing under {min_cache} tokens")
        uncached = r["input"] - cached
        write = p["write1h"] if cache_ttl == "1h" else p["write5m"]
        out_ceil = int(params.get("max_tokens", 4096))
        out_exp = min(out_ceil, int(expected_output_tokens or out_ceil))
        searches = _web_search_uses(params) * WEB_SEARCH_DOLLARS
        rw = write if i == 0 else hit * p["read"] + (1 - hit) * write
        ceiling += (uncached * p["input"] + cached * write + out_ceil * p["output"]) / 1e6 * factor + searches
        expected += (uncached * p["input"] + cached * rw + out_exp * p["output"]) / 1e6 * factor + searches
        tin += r["input"]; tcached += cached; tout += out_ceil
    r2 = lambda x: math.ceil(x * 100) / 100
    return {"batch": batch, "calls": len(params_list), "max_calls": len(params_list) * attempts, "attempts": attempts,
            "input_tokens": tin, "cached_tokens": tcached, "output_ceiling_tokens": tout,
            "ceiling": r2(ceiling * attempts), "expected": r2(expected * (1 + ASSUME["retry_rate"] * (attempts - 1))),
            "notes": sorted(notes)}


# ── flags, audit, gate ───────────────────────────────────────────────────────

def add_bulk_args(parser):
    parser.add_argument("--approved-cost", type=float, default=None,
                        help="Mark's quoted yes, in dollars — required for a bulk run (>20 calls or >$2)")
    parser.add_argument("--no-batch", dest="no_batch", default=None, metavar="REASON",
                        help="run a bulk job one call at a time instead of the Batch API; the reason is logged")
    return parser


def flags_from(args):
    approved = getattr(args, "approved_cost", None)
    reason = getattr(args, "no_batch", None)
    if approved is not None and not approved > 0:
        raise BulkRuleError("approval", f"--approved-cost must be a dollar amount, got {approved}")
    if reason is not None and not str(reason).strip():
        raise BulkRuleError("batch", '--no-batch needs a reason in quotes, e.g. --no-batch "re-reading 3 tiles"')
    return {"approved_cost": approved, "no_batch_reason": reason}


def audit_path():
    return Path(os.environ.get("LLM_BULK_AUDIT_LOG") or (Path.home() / ".config" / "saf" / "llm-bulk-audit.jsonl"))


def file_audit(entry):
    try:
        p = audit_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def _money(x):
    return f"${x:.2f}"


def gate(job, params_list, *, attempts=1, expected_output_tokens=None, batch=None, no_batch_reason=None,
         approved_cost=None, cache_ttl=None, service="site", log=print, audit=file_audit):
    """Print the estimate, then return the plan or raise BulkRuleError naming the broken rule.

    batch: True = always batch, False = one call at a time (a bulk run then needs no_batch_reason),
    None = batch when the run is bulk.
    """
    user_id = job_user_id(job, service)
    if not params_list:
        raise ValueError(f"{user_id}: nothing to run")
    a = analyse_requests(params_list)
    sync = estimate_run(params_list, a, attempts, batch=False, cache_ttl="5m", expected_output_tokens=expected_output_tokens)
    bat = estimate_run(params_list, a, attempts, batch=True, cache_ttl=cache_ttl or "1h", expected_output_tokens=expected_output_tokens)
    max_calls = len(params_list) * attempts
    bulk = max_calls > BULK_MIN_CALLS or sync["ceiling"] > BULK_MIN_DOLLARS
    models = ", ".join(sorted({canonical_model(p["model"]) for p in params_list}))
    log(f"[{user_id}] cost estimate — {len(params_list)} calls x {attempts} attempt(s) max = {max_calls} calls on {models}")
    log(f"  input ~{round(sync['input_tokens'] / 1000)}K tokens ({round(bat['cached_tokens'] / 1000)}K of it in a cached prefix), "
        f"output ceiling {round(sync['output_ceiling_tokens'] / 1000)}K tokens per pass")
    log(f"  one call at a time: expected {_money(sync['expected'])}, ceiling {_money(sync['ceiling'])}")
    log(f"  Message Batches API: expected {_money(bat['expected'])}, ceiling {_money(bat['ceiling'])}")
    log(f"  (ceiling = every call uses all its max_tokens, no cache hit, every retry; expected assumes "
        f"{round(ASSUME['batch_cache_hit_rate'] * 100)}% batch cache hits and {round(ASSUME['retry_rate'] * 100)}% of retries)")
    for note in sync["notes"] + a["problems"]:
        log(f"  note: {note}")
    if not bulk:
        mode = "batch" if batch is True else "sync"
        log(f"  small run (≤{BULK_MIN_CALLS} calls and ≤{_money(BULK_MIN_DOLLARS)}): no approval needed")
        return {"bulk": False, "mode": mode, "estimate": bat if mode == "batch" else sync, "analysis": a, "user_id": user_id}
    if a["max_shared_uncached"] >= CACHE_MIN_SHARED_TOKENS:
        raise BulkRuleError("cache",
            f'[{user_id}] REFUSED: ~{a["max_shared_uncached"]:,} tokens repeat across calls outside a cached prefix '
            f'(e.g. "{a["shared_sample"]}…"). Move the shared content to the front of the prompt (system or the first '
            f'user block), identical in every call, and mark its last block with cache_control: {{"type": "ephemeral"}}.')
    if batch is False and not (no_batch_reason and str(no_batch_reason).strip()):
        raise BulkRuleError("batch",
            f"[{user_id}] REFUSED: a run of {max_calls} calls / {_money(sync['ceiling'])} ceiling must use the Message "
            f'Batches API (half price). Run it in batch mode, or pass --no-batch "<reason>" to say why it cannot wait.')
    use_batch = batch is not False
    est = bat if use_batch else sync
    if approved_cost is None:
        raise BulkRuleError("approval",
            f"[{user_id}] REFUSED: no --approved-cost. Quote Mark the ceiling ({_money(est['ceiling'])}; expected "
            f"{_money(est['expected'])}) and re-run with --approved-cost {est['ceiling']:.2f} once he says yes.")
    if not float(approved_cost) >= est["ceiling"]:
        raise BulkRuleError("approval",
            f"[{user_id}] REFUSED: --approved-cost {_money(float(approved_cost))} is below this run's ceiling "
            f"{_money(est['ceiling'])}. Shrink the run (--only, fewer tiles) or get a new quote approved.")
    if not use_batch:
        log(f"  --no-batch: {no_batch_reason}")
    log(f"  approved up to {_money(float(approved_cost))} — running "
        f"{'through the Message Batches API' if use_batch else 'one call at a time'}")
    entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": "approved", "userId": user_id,
             "mode": "batch" if use_batch else "sync", "calls": len(params_list), "maxCalls": max_calls,
             "ceiling": est["ceiling"], "expected": est["expected"], "approvedCost": float(approved_cost)}
    if not use_batch:
        entry["noBatchReason"] = no_batch_reason
    audit(entry)
    return {"bulk": True, "mode": "batch" if use_batch else "sync", "estimate": est, "analysis": a,
            "user_id": user_id, "approved_cost": float(approved_cost)}


def preview(job, params_list, **kw):
    """--dry-run: print the estimate and what the gate would say, send nothing, audit nothing."""
    try:
        return gate(job, params_list, audit=lambda e: None, **kw)
    except BulkRuleError as e:
        print(str(e))
        return None


def gate_or_exit(job, params_list, args, **kw):
    """gate() for a CLI: the refusal is printed and the script exits 2."""
    try:
        f = flags_from(args)
        asked = kw.pop("batch", None)
        return gate(job, params_list, approved_cost=f["approved_cost"], no_batch_reason=f["no_batch_reason"],
                    batch=(False if f["no_batch_reason"] else asked), **kw)
    except BulkRuleError as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)


# ── HTTP: the one door ───────────────────────────────────────────────────────

_transport = None  # tests replace this: fn(method, url, headers, data, timeout) -> bytes


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
    """Raw API request. A POST to /messages must already carry a registered job tag, and so must
    every request inside a POST to /messages/batches — nothing leaves this module untagged."""
    if method == "POST" and path == "/messages":
        assert_request_allowed(body)
    if method == "POST" and path == "/messages/batches":
        for r in body["requests"]:
            assert_request_allowed(r["params"])
    url = raw_url or (API + path)
    headers = {"x-api-key": api_key(), "anthropic-version": API_VERSION}
    data = None
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body).encode()
    if _transport:
        return _transport(method, url, headers, data, timeout)
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


_sync_calls = 0


def _reset_sync_counter():
    global _sync_calls
    _sync_calls = 0


def sync_call(body, job, timeout=300, retries=1, service="site"):
    """One tagged Messages call for a script that makes a few. The 21st in a process is refused:
    a loop that big is a bulk run and goes through run_bulk()/submit_batches()."""
    global _sync_calls
    tagged = with_job_tag(body, job, service)
    assert_request_allowed(tagged)
    if _sync_calls + 1 > BULK_MIN_CALLS:
        raise BulkRuleError("batch",
            f"[{service}:{job}] REFUSED: this process has already made {_sync_calls} one-off Claude calls. "
            f"A run past {BULK_MIN_CALLS} calls is a bulk run — build the requests up front and use run_bulk().")
    _sync_calls += 1
    return _post_message(tagged, timeout, retries)


def interactive_call(body, job, timeout=300, service="site"):
    """One tagged call from a long-running interactive process (preview-server.py: one call per
    search a person makes). Not counted toward the script tripwire — never use it in a loop."""
    tagged = with_job_tag(body, job, service)
    assert_request_allowed(tagged)
    return _post_message(tagged, timeout, retries=0)


def _post_message(tagged, timeout=300, retries=1):
    for attempt in range(retries + 1):
        try:
            return json.loads(api("POST", "/messages", tagged, timeout=timeout))
        except urllib.error.HTTPError as e:
            if attempt < retries and (e.code == 429 or e.code >= 500):
                time.sleep(1 + attempt)
                continue
            raise


def usage_cost(model, usage, batch=False):
    if not usage:
        return 0.0
    p = price_for(model)
    cc = usage.get("cache_creation")
    w1h = (cc or {}).get("ephemeral_1h_input_tokens", 0) or 0
    w5m = (cc or {}).get("ephemeral_5m_input_tokens", 0) if cc else (usage.get("cache_creation_input_tokens", 0) or 0)
    d = (usage.get("input_tokens", 0) * p["input"] + w5m * p["write5m"] + w1h * p["write1h"]
         + (usage.get("cache_read_input_tokens", 0) or 0) * p["read"] + usage.get("output_tokens", 0) * p["output"]) / 1e6
    searches = ((usage.get("server_tool_use") or {}).get("web_search_requests", 0) or 0) * WEB_SEARCH_DOLLARS
    return d * (BATCH_FACTOR if batch else 1.0) + searches


# ── batches ──────────────────────────────────────────────────────────────────

def _long_ttl(params):
    """Batches outlast 5 minutes; the docs advise the 1-hour cache there."""
    def mark(b):
        if isinstance(b, dict) and b.get("cache_control") and not b["cache_control"].get("ttl"):
            return {**b, "cache_control": {**b["cache_control"], "ttl": "1h"}}
        return b
    out = dict(params)
    if isinstance(out.get("system"), list):
        out["system"] = [mark(b) for b in out["system"]]
    if isinstance(out.get("tools"), list):
        out["tools"] = [mark(b) for b in out["tools"]]
    if isinstance(out.get("messages"), list):
        out["messages"] = [{**m, "content": [mark(b) for b in m["content"]]} if isinstance(m.get("content"), list) else m
                           for m in out["messages"]]
    return out


def submit_batches(job, requests, chunk=150, service="site", on_submitted=None):
    """Tag every request, upgrade cache markers to 1h, POST in chunks. Returns batch ids.
    `on_submitted(id, n)` lets a stage-based script persist each id as soon as it exists."""
    tagged = [{"custom_id": r["custom_id"], "params": with_job_tag(_long_ttl(r["params"]), job, service)} for r in requests]
    for t in tagged:
        assert_request_allowed(t["params"])
    ids = []
    for i in range(0, len(tagged), chunk):
        part = tagged[i:i + chunk]
        out = json.loads(api("POST", "/messages/batches", {"requests": part}, timeout=900))
        ids.append(out["id"])
        print(f"submitted batch {out['id']} ({len(part)} requests)", flush=True)
        if on_submitted:
            on_submitted(out["id"], len(part))
    return ids


def collect_batch(batch_id, poll_s=30, max_wait_s=24 * 3600, sleep=time.sleep):
    """Wait for one batch to end; return its JSONL results text."""
    started = time.time()
    while True:
        j = json.loads(api("GET", f"/messages/batches/{batch_id}"))
        if j["processing_status"] == "ended":
            return api("GET", None, raw_url=j["results_url"], timeout=600).decode()
        if time.time() - started > max_wait_s:
            raise TimeoutError(f"batch {batch_id} did not end in time — re-run to collect it")
        print(f"  {batch_id}: {j['processing_status']} {j.get('request_counts', {})}", flush=True)
        sleep(poll_s)


def run_bulk(job, requests, args=None, *, attempts=1, expected_output_tokens=None, batch=None, approved_cost=None,
             no_batch_reason=None, poll_s=30, state_dir=None, service="site", log=print, audit=file_audit, sleep=time.sleep,
             chunk=150):
    """Gate, then run every request — through the Batch API when bulk. Returns
    {custom_id: {"ok": bool, "message"|"error": ..., "cost": $}}. A re-run with the same requests
    resumes the batches already submitted instead of paying twice."""
    if args is not None:
        f = flags_from(args)
        approved_cost = f["approved_cost"] if approved_cost is None else approved_cost
        no_batch_reason = f["no_batch_reason"] if no_batch_reason is None else no_batch_reason
        if no_batch_reason:
            batch = False
    params_list = [r["params"] for r in requests]
    plan = gate(job, params_list, attempts=attempts, expected_output_tokens=expected_output_tokens, batch=batch,
                no_batch_reason=no_batch_reason, approved_cost=approved_cost, service=service, log=log, audit=audit)
    results = {}
    if plan["mode"] == "sync":
        spent = 0.0
        for r in requests:
            if plan["bulk"] and spent >= plan["approved_cost"]:
                results[r["custom_id"]] = {"ok": False, "error": "stopped: the approved cost was reached"}
                continue
            tagged = with_job_tag(r["params"], job, service)
            try:
                msg = _post_message(tagged)
                c = usage_cost(tagged["model"], msg.get("usage"))
                spent += c
                results[r["custom_id"]] = {"ok": True, "message": msg, "cost": c}
            except Exception as e:  # noqa: BLE001 — one failed call is one failed result
                results[r["custom_id"]] = {"ok": False, "error": str(e)}
    else:
        tagged_preview = json.dumps([{"c": r["custom_id"], "p": with_job_tag(_long_ttl(r["params"]), job, service)} for r in requests],
                                    sort_keys=True)
        fp = _digest(tagged_preview)[:16]
        sd = Path(state_dir or os.environ.get("LLM_BULK_STATE_DIR") or (Path.home() / ".config" / "saf" / "llm-batches"))
        sf = sd / f"{plan['user_id'].replace(':', '_')}-{fp}.json"
        state = json.loads(sf.read_text()) if sf.exists() else None
        if state and state.get("batchIds"):
            log(f"[{plan['user_id']}] resuming {len(state['batchIds'])} batch(es) already submitted for these exact requests")
            ids = state["batchIds"]
        else:
            sd.mkdir(parents=True, exist_ok=True)
            ids = []

            def remember(bid, _n):
                ids.append(bid)
                sf.write_text(json.dumps({"userId": plan["user_id"], "fingerprint": fp, "batchIds": ids}, indent=1))
            submit_batches(job, requests, chunk=chunk, service=service, on_submitted=remember)
        model_of = {r["custom_id"]: r["params"]["model"] for r in requests}
        for bid in ids:
            for line in collect_batch(bid, poll_s=poll_s, sleep=sleep).splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                res = row.get("result") or {}
                if res.get("type") == "succeeded":
                    msg = res["message"]
                    results[row["custom_id"]] = {"ok": True, "message": msg,
                                                 "cost": usage_cost(model_of.get(row["custom_id"], MODELS["DEFAULT"]), msg.get("usage"), batch=True)}
                else:
                    err = ((res.get("error") or {}).get("error") or {}).get("message") or res.get("type") or "unknown"
                    results[row["custom_id"]] = {"ok": False, "error": err}
        for r in requests:
            results.setdefault(r["custom_id"], {"ok": False, "error": "missing from batch results"})
    total = sum(v.get("cost", 0) for v in results.values())
    log(f"[{plan['user_id']}] done: {sum(1 for v in results.values() if v['ok'])}/{len(requests)} ok, actual {_money(total)}")
    audit({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": "pass", "userId": plan["user_id"],
           "mode": plan["mode"], "requests": len(requests), "actual": round(total, 2)})
    return results


def message_text(message):
    return "".join(b.get("text", "") for b in (message or {}).get("content", []) if b.get("type") == "text")
