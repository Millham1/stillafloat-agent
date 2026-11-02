import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Tests run with cwd = server/ (pnpm --filter @workspace/api-server test).
const server = process.cwd();
const script = path.join(server, "scripts", "gen-client-documents.mjs");
const committed = path.join(server, "src", "content", "client-documents.ts");
const sources = path.join(server, "..", "content", "client-documents", "source");

test("regenerating the client-documents module gives exactly the committed file", () => {
  const regenerated = execFileSync(process.execPath, [script, "--stdout"], { encoding: "utf8" });
  assert.equal(
    regenerated,
    readFileSync(committed, "utf8"),
    "server/src/content/client-documents.ts is out of date: run  node server/scripts/gen-client-documents.mjs",
  );
});

test("every Cornerstone template source is in the module, and the module holds nothing else", async () => {
  const { CLIENT_DOCUMENTS } = await import("../content/client-documents");
  const files = readdirSync(sources).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
  assert.equal(files.length, 13);
  assert.deepEqual(Object.keys(CLIENT_DOCUMENTS).sort(), files);
  for (const key of files) {
    assert.equal(CLIENT_DOCUMENTS[key], readFileSync(path.join(sources, `${key}.md`), "utf8").replace(/\r\n?/g, "\n"), `${key} differs from its source`);
    assert.ok(CLIENT_DOCUMENTS[key]!.length > 2000, `${key} looks truncated`);
  }
});
