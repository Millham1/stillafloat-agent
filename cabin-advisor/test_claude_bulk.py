"""test_claude_bulk.py — the bulk-run rule for the Python scripts, proved with a fake transport.

    python3 -m unittest cabin-advisor/test_claude_bulk.py      (from the repo root)

No network, no key, no spend: claude_bulk._transport is replaced for every test, the audit
log goes to a list and batch state to a temp dir. The same G6 controls as the server's
claude-core.test.ts: a 25-call job without batch is refused and with batch passes, and the
cabin-advice grid trips the cache_control requirement.
"""
import json, os, re, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-test-not-real")
import claude_bulk as cb  # noqa: E402


class FakeApi:
    """Messages + Message Batches endpoints; a batch ends on its second poll."""

    def __init__(self):
        self.seen, self.batches, self.n = [], {}, 0

    def message(self, cid):
        return {"id": cid, "type": "message", "stop_reason": "end_turn", "model": "claude-sonnet-5-5",
                "content": [{"type": "text", "text": json.dumps({"cabins": [{"num": "6360", "x": 0.3, "y": 0.1}]})}],
                "usage": {"input_tokens": 1500, "output_tokens": 300}}

    def __call__(self, method, url, headers, data, timeout):
        body = json.loads(data) if data else None
        self.seen.append((method, url, body))
        if method == "POST" and url.endswith("/v1/messages"):
            self.n += 1
            return json.dumps(self.message(f"sync-{self.n}")).encode()
        if method == "POST" and url.endswith("/v1/messages/batches"):
            self.n += 1
            bid = f"msgbatch_py{self.n}"
            self.batches[bid] = {"requests": body["requests"], "polls": 0}
            return json.dumps({"id": bid, "processing_status": "in_progress"}).encode()
        m = re.search(r"/v1/messages/batches/([^/]+)$", url)
        if method == "GET" and m:
            b = self.batches[m.group(1)]
            b["polls"] += 1
            return json.dumps({"id": m.group(1), "processing_status": "ended" if b["polls"] >= 2 else "in_progress",
                               "request_counts": {}, "results_url": url + "/results"}).encode()
        m = re.search(r"/v1/messages/batches/([^/]+)/results$", url)
        if method == "GET" and m:
            b = self.batches[m.group(1)]
            return "\n".join(json.dumps({"custom_id": r["custom_id"], "result": {"type": "succeeded", "message": self.message(r["custom_id"])}})
                             for r in b["requests"]).encode()
        raise AssertionError(f"unexpected {method} {url}")


def fake_job(n=25):
    return [{"custom_id": f"tile-{i}", "params": {
        "model": cb.MODELS["DEFAULT"], "max_tokens": 8000,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": f"tile {i}: a deck-strip read, its own pixels {i * 7919}"},
            {"type": "text", "text": "Transcribe every stateroom number. Return ONLY JSON."}]}]}} for i in range(n)]


class Base(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()
        cb._transport = self.api
        cb._reset_sync_counter()
        self.audit, self.lines = [], []
        self.state = tempfile.mkdtemp(prefix="llm-bulk-py-")
        self.kw = dict(log=self.lines.append, audit=self.audit.append, state_dir=self.state, sleep=lambda s: None, poll_s=0)

    def tearDown(self):
        cb._transport = None


class G6Controls(Base):
    def test_25_calls_without_batch_are_refused_before_any_request(self):
        with self.assertRaises(cb.BulkRuleError) as e:
            cb.run_bulk("cabin.categories", fake_job(), batch=False, approved_cost=50, **self.kw)
        self.assertEqual(e.exception.rule, "batch")
        self.assertEqual(self.api.seen, [])
        self.assertTrue(any("cost estimate — 25 calls" in l for l in self.lines), "the estimate prints even when refused")

    def test_the_same_job_with_batch_passes_one_batch_every_request_tagged(self):
        res = cb.run_bulk("cabin.categories", fake_job(), approved_cost=5, **self.kw)
        self.assertEqual(len(res), 25)
        self.assertTrue(all(r["ok"] for r in res.values()))
        posts = [s for s in self.api.seen if s[0] == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0][1].endswith("/v1/messages/batches"))
        self.assertTrue(all(r["params"]["metadata"]["user_id"] == "site:cabin.categories" for r in posts[0][2]["requests"]))
        self.assertEqual(self.audit[0]["event"], "approved")

    def test_no_batch_with_a_reason_runs_one_at_a_time_and_logs_it(self):
        res = cb.run_bulk("cabin.categories", fake_job(), batch=False, no_batch_reason="three tiles, Mark watching",
                          approved_cost=10, **self.kw)
        self.assertEqual(len(res), 25)
        self.assertEqual(self.audit[0]["noBatchReason"], "three tiles, Mark watching")
        self.assertTrue(any("--no-batch: three tiles, Mark watching" in l for l in self.lines))

    def test_no_approved_cost_is_refused_with_the_figure_to_quote(self):
        with self.assertRaises(cb.BulkRuleError) as e:
            cb.run_bulk("cabin.categories", fake_job(), **self.kw)
        self.assertEqual(e.exception.rule, "approval")
        self.assertRegex(str(e.exception), r"re-run with --approved-cost \d+\.\d\d")
        self.assertEqual(self.api.seen, [])

    def test_a_small_run_needs_nothing(self):
        res = cb.run_bulk("cabin.categories", fake_job(4), **self.kw)
        self.assertEqual(len(res), 4)


class CacheRule(Base):
    GRID = json.dumps([{"id": 4000 + i, "deck": 4 + i % 12, "kind": "Balcony" if i % 3 else "Interior",
                        "position": ["forward", "mid", "aft"][i % 3], "side": "port" if i % 2 else "starboard"}
                       for i in range(3000)])

    def test_cabin_advice_grid_inline_in_every_prompt_is_refused(self):
        old = [{"model": cb.MODELS["CHEAP"], "max_tokens": 1600, "system": "You are Mark.",
                "messages": [{"role": "user", "content": f"Traveler: archetype {i}.\n\nCandidate cabins:\n{self.GRID}\n\nRecommend 4-6."}]}
               for i in range(12)]
        with self.assertRaises(cb.BulkRuleError) as e:
            cb.gate("cabin.advice", old, attempts=3, approved_cost=1000, log=self.lines.append, audit=self.audit.append)
        self.assertEqual(e.exception.rule, "cache")
        self.assertIn("cache_control", str(e.exception))

    def test_the_grid_in_a_marked_system_prefix_passes(self):
        new = [{"model": cb.MODELS["CHEAP"], "max_tokens": 1600,
                "system": [{"type": "text", "text": "You are Mark."},
                           {"type": "text", "text": f"Candidate cabins:\n{self.GRID}", "cache_control": {"type": "ephemeral"}}],
                "messages": [{"role": "user", "content": f"Traveler: archetype {i}. Recommend 4-6."}]} for i in range(12)]
        plan = cb.gate("cabin.advice", new, attempts=3, approved_cost=1000, log=self.lines.append, audit=self.audit.append)
        self.assertEqual(plan["mode"], "batch")
        self.assertGreater(plan["estimate"]["cached_tokens"], 100_000)


class Doors(Base):
    def test_sync_call_trips_at_n_plus_one(self):
        body = {"model": cb.MODELS["CHEAP"], "max_tokens": 10, "messages": [{"role": "user", "content": "x"}]}
        for _ in range(cb.BULK_MIN_CALLS):
            cb.sync_call(body, "cabin.geometry-reread")
        with self.assertRaises(cb.BulkRuleError):
            cb.sync_call(body, "cabin.geometry-reread")
        self.assertEqual(len(self.api.seen), cb.BULK_MIN_CALLS)
        self.assertTrue(all(s[2]["metadata"]["user_id"] == "site:cabin.geometry-reread" for s in self.api.seen))

    def test_api_refuses_an_untagged_post(self):
        with self.assertRaises(cb.JobTagError):
            cb.api("POST", "/messages", {"model": cb.MODELS["DEFAULT"], "max_tokens": 1, "messages": []})
        with self.assertRaises(cb.JobTagError):
            cb.api("POST", "/messages/batches", {"requests": [{"custom_id": "a", "params": {"model": cb.MODELS["DEFAULT"], "max_tokens": 1, "messages": []}}]})
        self.assertEqual(self.api.seen, [])

    def test_unregistered_tag_and_claude5_rules(self):
        with self.assertRaises(cb.JobTagError):
            cb.job_user_id("cabin.typo")
        body = {"model": cb.MODELS["DEFAULT"], "max_tokens": 1, "messages": [], "temperature": 0}
        with self.assertRaises(ValueError):
            cb.sync_call(body, "cabin.geometry-reread")
        self.assertTrue(cb.rejects_forced_tool_choice("claude-sonnet-5-5"))
        self.assertFalse(cb.rejects_forced_tool_choice("claude-haiku-4-5-20251001"))

    def test_resume_does_not_pay_twice(self):
        cb.run_bulk("cabin.categories", fake_job(), approved_cost=5, **self.kw)
        posts = sum(1 for s in self.api.seen if s[0] == "POST")
        cb.run_bulk("cabin.categories", fake_job(), approved_cost=5, **self.kw)
        self.assertEqual(sum(1 for s in self.api.seen if s[0] == "POST"), posts)

    def test_prices_match_the_server_table(self):
        core = (Path(__file__).resolve().parent.parent / "server/src/lib/claude-core.mjs").read_text()
        for model, p in cb.PRICES.items():
            m = re.search(r'"%s":\s*\{ input: ([\d.]+), output: ([\d.]+), write5m: ([\d.]+), write1h: ([\d.]+), read: ([\d.]+) \}' % re.escape(model), core)
            self.assertIsNotNone(m, model)
            self.assertEqual([float(x) for x in m.groups()], [p["input"], p["output"], p["write5m"], p["write1h"], p["read"]], model)
        self.assertEqual(cb.PRICES["claude-sonnet-5-5"], cb.PRICES["claude-sonnet-5"])


if __name__ == "__main__":
    unittest.main()
