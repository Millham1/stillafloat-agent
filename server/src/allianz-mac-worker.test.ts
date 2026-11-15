import { test } from "node:test";
import assert from "node:assert/strict";
import { passOver, sitesFrom } from "./allianz-mac-worker";

test("the Mac worker's settings: each site is an address and its token; an entry without both is dropped", () => {
  assert.deepEqual(sitesFrom("https://dev.example.com/|tok1, http://localhost:8150|tok2 ,nonsense,https://x.example|"), [{ url: "https://dev.example.com", token: "tok1" }, { url: "http://localhost:8150", token: "tok2" }]);
  assert.deepEqual(sitesFrom(undefined), []);
});

test("one pass (Mark 2026-11-14: Allianz is asked from his Mac): each waiting request is asked once and its answer goes back with the time it was asked; a lookup that throws is reported as could-not-be-priced, never dropped", async () => {
  const sent: Array<{ url: string; body: unknown }> = [];
  const input = { state: "CA", total_trip_cost: 2413.26, ages: [33, 31], depart_date: "2027-05-09", return_date: "2027-05-13", deposit_date: "2026-11-14" };
  const http = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    assert.equal(init?.headers?.["x-affiliate-token"], "tok", "every call carries Mark's token");
    if (!init?.method) return { ok: true, status: 200, json: async () => ({ on: "mac", requests: [{ id: "t-1", requested_at: "2026-11-15T03:00:00.000Z", input }, { id: "t-2", requested_at: "2026-11-15T03:01:00.000Z", input }] }) };
    sent.push({ url, body: JSON.parse(init.body ?? "{}") });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }) as unknown as typeof fetch;
  let asked = 0;
  const done = await passOver({ url: "https://dev.example.com", token: "tok" }, async (got) => {
    assert.deepEqual(got, input);
    if (++asked === 2) throw new Error("the browser closed");
    return { status: "ready", plans: [{ name: "Classic Plan", total: 204 }] };
  }, http);
  assert.equal(done, 2);
  assert.deepEqual(sent, [
    { url: "https://dev.example.com/api/allianz/requests/t-1/result", body: { requested_at: "2026-11-15T03:00:00.000Z", status: "ready", plans: [{ name: "Classic Plan", total: 204 }] } },
    { url: "https://dev.example.com/api/allianz/requests/t-2/result", body: { requested_at: "2026-11-15T03:01:00.000Z", status: "unavailable", reason: "the browser closed" } },
  ]);
});
