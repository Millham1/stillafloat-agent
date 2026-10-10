import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCampaign, tidyCampaign } from "./group-campaign";
import type { GroupFacts } from "./group-marketing";

const facts = { lang: "en", allowedNumbers: ["575.8", "99", "2027", "10", "14", "4"] } as unknown as GroupFacts;
const url = "https://stillafloatcruising.com/group.html?g=rj4qhy2xft";
const good = () => ({
  emails: [
    { slot: "announcement", subject: "A group cruise for the Post", preheader: "Four nights on MSC Seaside", body: "We sail May 10, 2027. Cabins from $575.80 per person. Call or text Mark at 919-346-6127." },
    { slot: "reminder", subject: "Cabins are going", preheader: "Reserve by January 10", body: "A few balconies are left. Deposit is $99 per person." },
    { slot: "last_call", subject: "Last call", preheader: "Reserve-by is this week", body: "Call or text Mark at 919-346-6127 or use the link." },
  ],
  facebook: { announcement: "Group cruise for veterans and friends, May 10 to 14, 2027.", reminder: "Reserve by January 10.", event_title: "Legion cruise 2027", event_description: "Four nights on MSC Seaside from Miami.", boosted: "Four nights, from $575.80 per person. Call or text Mark 919-346-6127." },
});

test("a campaign whose numbers all come from the file, the phone or the link passes", () => {
  assert.deepEqual(validateCampaign(good(), facts, { why_sailing: "a fun week" }, url), []);
});

test("an invented number, a banned word and a missing email are reported by field", () => {
  const c = good();
  c.emails[0]!.body += " Save $300 if you book this week. Guaranteed.";
  c.emails.pop();
  const p = validateCampaign(c, facts, {}, url);
  assert.ok(p.some((x) => x.field === "emails[0].body" && /not in the group file: 300/.test(x.problem)));
  assert.ok(p.some((x) => x.field === "emails[0].body" && /Guaranteed/.test(x.problem)));
  assert.ok(p.some((x) => x.field === "emails" && /expected 3 emails, got 2/.test(x.problem)));
});

test("a number Mark wrote in the interview is his to state", () => {
  const c = good();
  c.facebook.boosted += " Bus leaves the Post at 6.";
  assert.ok(validateCampaign(c, facts, {}, url).some((x) => /: 6$/.test(x.problem)));
  assert.deepEqual(validateCampaign(c, facts, { extras: "Bus leaves the Post at 6" }, url), []);
});

test("tidyCampaign fills the three slots in order and trims", () => {
  const t = tidyCampaign({ emails: [{ subject: " A ", body: "b\n" }, { slot: "last_call", subject: "c", body: "d" }], facebook: { announcement: " x " } });
  assert.deepEqual(t.emails.map((e) => e.slot), ["announcement", "last_call"]);
  assert.equal(t.emails[0]!.subject, "A"); assert.equal(t.facebook.announcement, "x"); assert.equal(t.facebook.boosted, "");
});
