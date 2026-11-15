import { test } from "node:test";
import assert from "node:assert/strict";
import { trailEmail, trailEvent, trailFromMailbox, trailPeople } from "./contact-trail";

test("paper trail (Mark 2026-11-14): an address is kept lowercased, and something that is not an address is not a person", () => {
  assert.equal(trailEmail("  Susan@Example.COM "), "susan@example.com");
  assert.equal(trailEmail("susan at example"), null);
  assert.equal(trailEvent({ email: "nobody", what: "Removed", key: "x" }), null);
  const ev = trailEvent({ email: "Susan@Example.com", name: " Susan Lee ", what: "Removed from Friends and Family 2027", detail: "party of 2", groupId: "g-1", groupName: "Friends and Family 2027", key: "left:r-1", at: "2026-11-15T03:00:00.000Z" });
  assert.deepEqual(ev, { email: "susan@example.com", name: "Susan Lee", kind: "event", direction: "note", subject: "Removed from Friends and Family 2027", snippet: "party of 2", status: null, at: "2026-11-15T03:00:00.000Z", group_id: "g-1", group_name: "Friends and Family 2027", source_id: "event:left:r-1" });
});

test("the mailbox's messages become trail rows; a site email that is already on the trail is not shown twice; what the person wrote is 'in'", () => {
  const site = [{ email: "susan@example.com", kind: "site-email" as const, subject: "Your quote from Mark… Friends and Family 2027", at: "2026-11-15T03:34:00.000Z" }];
  const rows = trailFromMailbox([
    { id: "a", address: "susan@example.com", direction: "out", from: "Mark <mark@stillafloatcruising.com>", to: "susan@example.com", subject: "Mark & Ceci’s first Friends and Family Cruise", snippet: "Use the QR", at: "2026-11-14T22:20:00Z" },
    { id: "b", address: "susan@example.com", direction: "out", from: "Mark <mark@stillafloatcruising.com>", to: "susan@example.com", subject: "Your quote from  Mark… Friends and Family 2027", snippet: "", at: "2026-11-15T03:34:40Z" },
    { id: "c", address: "susan@example.com", direction: "in", from: "Susan <susan@example.com>", to: "mark@stillafloatcruising.com", subject: "Re: Your quote", snippet: "looks good", at: "2026-11-15T04:00:00Z" },
    { id: "d", address: "not an address", direction: "in", from: "", to: "", subject: "x", snippet: "", at: "2026-11-15T04:00:00Z" },
  ], site, "Susan Lee");
  assert.deepEqual(rows.map((r) => [r.source_id, r.direction, r.status, r.name]), [["gmail:a", "out", "sent", "Susan Lee"], ["gmail:c", "in", "received", "Susan Lee"]], "the invite sent by hand and her reply are added; the site's own quote email is not doubled");
  assert.deepEqual(rows[0]!.meta, { from: "Mark <mark@stillafloatcruising.com>", to: "susan@example.com" });
});

test("the list of people: one line each, newest interaction first, with their name and groups", () => {
  assert.deepEqual(trailPeople([
    { email: "a@example.com", name: null, at: "2026-11-01T00:00:00Z", group_name: "Group One" },
    { email: "b@example.com", name: "Bea", at: "2026-11-03T00:00:00Z", group_name: null },
    { email: "a@example.com", name: "Ann", at: "2026-11-05T00:00:00Z", group_name: "Group Two" },
  ]), [{ email: "a@example.com", name: "Ann", count: 2, last_at: "2026-11-05T00:00:00Z", groups: ["Group One", "Group Two"] }, { email: "b@example.com", name: "Bea", count: 1, last_at: "2026-11-03T00:00:00Z", groups: [] }]);
});
