// The review page's JavaScript is written inside a TypeScript template literal, so
// nothing typechecks it and no unit test executes it. On 2026-09-04 that cost a
// production outage of the whole page: a string written as
//
//     note("<b>"+label+"</b><br><span class=\"muted small\">Working…</span>")
//
// emits a BARE double quote inside a double-quoted JS string, because \" in a
// template literal is just ". The string closed early, the entire <script> block
// failed to parse, and every declared function — doReject, publish, synth, write —
// was undefined. The page still rendered and the buttons still highlighted, so it
// looked fine; clicking simply did nothing, and no request ever reached the server.
// Mark hit it as "the reject button is not working".
//
// This test parses the script the way a browser would. It is the only thing standing
// between a quoting slip and a dead page.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

// Resolved from process.cwd() — the suite runs from server/ (same convention as
// cabin-match.test.ts). import.meta.url points at the BUNDLE in dist-test/, not the
// source tree, so a path relative to the module cannot find this file.
const source = readFileSync(join(process.cwd(), "src/routes/commentary.ts"), "utf8");

/**
 * Apply the escape collapsing a template literal performs before the browser ever
 * sees the code. THIS IS THE WHOLE POINT: in the source the text reads
 * `class=\"muted small\"`, and \" is a perfectly legal escape, so parsing the raw
 * source proves nothing — the first version of this test passed with the bug
 * present. The runtime string is what breaks, so reproduce it.
 */
function collapseTemplateEscapes(code: string): string {
  return code.replace(/\\(.)/g, (_m, c: string) => {
    if (c === "n") return "\n";
    if (c === "t") return "\t";
    if (c === "r") return "\r";
    return c; // \" -> "   \' -> '   \\ -> \   \` -> `   \$ -> $
  });
}

/** Replace ${...} interpolations with a literal, honouring nested braces. */
function stripInterpolations(code: string): string {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "$" && code[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < code.length && depth > 0) {
        if (code[i] === "{") depth++;
        else if (code[i] === "}") depth--;
        i++;
      }
      i--;
      out += '"X"';
    } else {
      out += code[i];
    }
  }
  return out;
}

function scriptBlocks(): string[] {
  const blocks: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) blocks.push(m[1]!);
  return blocks;
}

test("the review page ships at least one inline script", () => {
  assert.ok(scriptBlocks().length > 0, "no <script> found — did the page move?");
});

test("every inline script parses as JavaScript", () => {
  for (const [i, raw] of scriptBlocks().entries()) {
    const code = stripInterpolations(collapseTemplateEscapes(raw));
    assert.doesNotThrow(
      () => new vm.Script(code),
      `inline script #${i + 1} does not parse — the page's buttons will all be dead`,
    );
  }
});

test("the emitted script is what is checked, not the escaped source", () => {
  // Guard on the guard: if collapseTemplateEscapes ever stops collapsing, the parse
  // test silently goes vacuous again.
  assert.equal(collapseTemplateEscapes('a=\\"b\\"'), 'a="b"');
});

test("the click handlers the buttons call are actually declared", () => {
  // onclick="doReject(this)" is useless if doReject never gets defined, which is
  // exactly what a parse failure produces.
  const all = scriptBlocks().join("\n");
  for (const fn of ["doReject", "publish", "synth", "write", "gen", "waitForRun", "call"]) {
    assert.match(all, new RegExp(`function\\s+${fn}\\b`), `${fn}() is referenced but never declared`);
  }
});

test("no bare double quote is emitted inside a double-quoted string", () => {
  // The specific slip: \" inside a template literal collapses to " and closes the
  // JS string early. Use single quotes for HTML attributes in emitted script.
  assert.doesNotMatch(
    source.replace(/\r/g, ""),
    /note\("[^"]*\\"/,
    'found \\" inside an emitted double-quoted string — use single quotes for HTML attributes',
  );
});
