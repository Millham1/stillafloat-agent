import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readAllRows, PAGE } from "./read-all";

describe("readAllRows — past the 1,000-row cap", () => {
  it("keeps asking until a short page arrives and returns every row", async () => {
    const total = 2 * PAGE + 137;
    const calls: Array<[number, number]> = [];
    const { rows, error } = await readAllRows<number>(async (from, to) => {
      calls.push([from, to]);
      const n = Math.max(0, Math.min(to + 1, total) - from);
      return { data: Array.from({ length: n }, (_, i) => from + i), error: null };
    });
    assert.equal(error, null);
    assert.equal(rows.length, total);
    assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
    assert.equal(rows[total - 1], total - 1);
  });
  it("an exact multiple of the page size needs one extra empty page", async () => {
    let n = 0;
    const { rows } = await readAllRows<number>(async (from) => { n++; return { data: from < PAGE ? Array(PAGE).fill(1) : [], error: null }; });
    assert.equal(rows.length, PAGE); assert.equal(n, 2);
  });
  it("surfaces a read error instead of pretending the table is short", async () => {
    const { rows, error } = await readAllRows<number>(async () => ({ data: null, error: { message: "boom" } }));
    assert.equal(rows.length, 0); assert.equal(error?.message, "boom");
  });
});
