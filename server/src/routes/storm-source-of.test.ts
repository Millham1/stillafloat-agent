// storm-source-of.test.ts — the caption helper behind the public Storm Watch list must never throw.
// On 2026-09-26 the list query stopped selecting nhc_id; sourceOf(undefined) threw on every row
// and GET /storm-watch answered 500 whenever an alert was public.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(process.cwd(), "src/routes/storm.ts"), "utf8");

test("the public list query selects the columns its mapper reads", () => {
  const start = src.indexOf('router.get("/storm-watch", async');
  const select = /\.select\("([^"]+)"\)/.exec(src.slice(start))![1]!.split(",").map((c) => c.trim());
  for (const col of ["id", "nhc_id", "name", "affected_grounds", "raw", "window_start", "window_end"]) {
    assert.ok(select.includes(col), `GET /storm-watch does not select ${col}`);
  }
});

test("sourceOf tolerates a missing id", () => {
  const body = /export function sourceOf\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(src)![1]!;
  assert.match(body, /nhcId \?\? ""/);
});
