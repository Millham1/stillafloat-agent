import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, zipName, zipStored } from "./group-zip";

test("a ZIP of the signed copies opens with the computer's own unzip and gives back every file byte for byte", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "the standard check value");
  assert.equal(zipName("1. Terms & Conditions / Términos.pdf"), "1. Terms Conditions Terminos.pdf");
  const files = [{ name: "1 Terms and Conditions.pdf", bytes: Buffer.from("%PDF-1.4 one") }, { name: "2 Liability Waiver.pdf", bytes: Buffer.from("%PDF-1.4 two, longer") }];
  const zip = zipStored(files, new Date("2026-11-14T16:00:00Z"));
  const dir = mkdtempSync(join(tmpdir(), "saf-zip-"));
  writeFileSync(join(dir, "all.zip"), zip);
  let unzip = true;
  try { execFileSync("unzip", ["-q", "all.zip", "-d", "out"], { cwd: dir }); } catch (e) { if ((e as { code?: string }).code === "ENOENT") unzip = false; else throw e; }
  if (!unzip) return; // a box without unzip: the structure checks above still ran
  assert.deepEqual(readdirSync(join(dir, "out")).sort(), files.map((f) => f.name));
  for (const f of files) assert.deepEqual(readFileSync(join(dir, "out", f.name)), f.bytes);
});
