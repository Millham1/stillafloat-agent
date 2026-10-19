import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCampaign, tidyCampaign, campaignSystemPrompt } from "./group-campaign";
import { HOUSE_VOICE_RULES, type GroupFacts } from "./group-marketing";

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

test("a piece over its limit says how much and what to do, in the same words as the page copy", () => {
  const c = good();
  c.emails[0]!.subject = "x".repeat(81);
  c.facebook.event_title = "y".repeat(71);
  assert.deepEqual(validateCampaign(c, facts, {}, url), [
    { field: "emails[0].subject", problem: "too long: 81 of 80 characters — shorten it, or ask Mark" },
    { field: "facebook.event_title", problem: "too long: 71 of 70 characters — shorten it, or ask Mark" },
  ]);
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


// ── Mark's pitch: the announcement email carries it word for word ───────────────────────────────────────────

const PITCH = "Four nights out of Miami with the people you already like. Sunset on the beach, then a light show. Scan the QR to join the fun.";
const withPitchInFirstEmail = () => { const c = good(); c.emails[0]!.body = `${PITCH}\n\nCall or text Mark at 919-346-6127.`; return c; };

test("a campaign whose announcement email carries every pitch sentence passes", () => {
  assert.deepEqual(validateCampaign(withPitchInFirstEmail(), facts, { pitch: PITCH }, url), []);
  // the other emails and the posts are free of it
  assert.deepEqual(validateCampaign(withPitchInFirstEmail(), facts, { pitch: PITCH.replace("Sunset on the beach, then a light show. ", "") }, url), []);
});

test("each pitch sentence missing from the announcement email is a problem on that email; the other pieces do not make up for it", () => {
  const c = good();
  c.emails[1]!.body = PITCH;           // the reminder carries it, the announcement does not
  c.facebook.announcement = PITCH;
  const p = validateCampaign(c, facts, { pitch: PITCH }, url);
  assert.deepEqual(p.map((x) => [x.field, x.problem]), [
    ["emails[0].body", "Pitch sentence not kept: 'Four nights out of Miami with the people you already like.'"],
    ["emails[0].body", "Pitch sentence not kept: 'Sunset on the beach, then a light show.'"],
    ["emails[0].body", "Pitch sentence not kept: 'Scan the QR to join the fun.'"],
  ]);
  // no pitch given: nothing to check
  assert.deepEqual(validateCampaign(good(), facts, {}, url), []);
});

test("a tightened pitch sentence in the announcement is caught", () => {
  const c = withPitchInFirstEmail();
  c.emails[0]!.body = c.emails[0]!.body.replace("with the people you already like", "with people you like");
  assert.ok(validateCampaign(c, facts, { pitch: PITCH }, url).some((x) => /Pitch sentence not kept: 'Four nights out of Miami with the people you already like\.'/.test(x.problem)));
});

test("a Spanish campaign carries a translation, so it is not matched by sentence", () => {
  const es = { ...facts, lang: "es" } as unknown as GroupFacts;
  assert.deepEqual(validateCampaign(good(), es, { pitch: PITCH }, url), []);
});

test("the pitch's numbers are fact-checked once, on the pitch, with the phone and the link allowed", () => {
  const c = good();
  c.emails[0]!.body = "Bus leaves at 6.";
  const p = validateCampaign(c, facts, { pitch: "Bus leaves at 6." }, url);
  assert.deepEqual(p.map((x) => [x.field, x.problem]), [["pitch", "Mark's pitch states a number that is not in the group file: 6"]]);
  assert.deepEqual(validateCampaign(withPitchInFirstEmail(), facts, { pitch: `${PITCH} Call 919-346-6127.` }, url).filter((x) => x.field === "pitch"), []);
});

test("exclamation marks, 'Join Mark' and amenity points fail every campaign piece", () => {
  const c = good();
  c.emails[0]!.subject = "Sail with us!";
  c.emails[1]!.body += " Join Mark on the Seaside.";
  c.facebook.reminder += " Three amenity points for the group.";
  const p = validateCampaign(c, facts, {}, url);
  assert.ok(p.some((x) => x.field === "emails[0].subject" && /exclamation/.test(x.problem)));
  assert.ok(p.some((x) => x.field === "emails[1].body" && /Join Mark/.test(x.problem)));
  assert.ok(p.some((x) => x.field === "facebook.reminder" && /amenity points/.test(x.problem)));
});

// ── Mark's pitch is verbatim here too: his "!" and his word choices are his (Mark 2026-10-19) ─────────────────────────────

const MARK_PITCH = "Join us for our first Friends and Family cruise to the Bahamas! Enjoy  all that Nassau has to offer, then spend two incredible days at MSC's Ocean Cay, including an amazing evening beach party and light show from the island's lighthouse!";
const VERBATIM = "Join us for our first Friends and Family cruise to the Bahamas! Enjoy all that Nassau has to offer, then spend two incredible days at MSC's Ocean Cay, including an amazing evening beach party and light show from the island's lighthouse!";

test("an announcement that carries Mark's pitch verbatim, '!' and 'incredible' included, passes; the other pieces may quote it", () => {
  const c = good();
  c.emails[0]!.body = `${VERBATIM}\n\nCall or text Mark at 919-346-6127.`;
  c.facebook.announcement = VERBATIM;
  assert.deepEqual(validateCampaign(c, facts, { pitch: MARK_PITCH }, url), []);
});

test("the same words with the closing marks softened are kept; a paraphrase ('two amazing days') is not", () => {
  const c = good();
  c.emails[0]!.body = VERBATIM.replace(/!/g, ".");
  assert.deepEqual(validateCampaign(c, facts, { pitch: MARK_PITCH }, url), []);
  c.emails[0]!.body = VERBATIM.replace("two incredible days", "two amazing days");
  const p = validateCampaign(c, facts, { pitch: MARK_PITCH }, url);
  assert.deepEqual(p.map((x) => x.field), ["emails[0].body", "emails[0].body"]);
  assert.match(p.find((x) => x.problem.startsWith("Pitch sentence not kept"))!.problem, /^Pitch sentence not kept: 'Enjoy  all that Nassau has to offer/);
  assert.equal(p.filter((x) => x.problem.startsWith("Pitch sentence not kept")).length, 1, "only his second sentence; the first has his words");
  // the paraphrase is the writer's words, not his, so its closing "!" is ours to answer for; the first sentence is untouched
  assert.deepEqual(p.filter((x) => !x.problem.startsWith("Pitch sentence not kept")).map((x) => x.problem), ["has an exclamation mark"]);
});

test("the bans still apply to our own words around his pitch, in every piece", () => {
  const c = good();
  c.emails[0]!.body = `${VERBATIM} An amazing week, guaranteed!`;
  c.facebook.reminder += " Join Mark on the Seaside!";
  const p = validateCampaign(c, facts, { pitch: MARK_PITCH }, url);
  assert.ok(p.some((x) => x.field === "emails[0].body" && /exclamation/.test(x.problem)));
  assert.ok(p.some((x) => x.field === "emails[0].body" && /Guaranteed|guaranteed/.test(x.problem)));
  assert.ok(p.some((x) => x.field === "facebook.reminder" && /Join Mark/.test(x.problem)));
  assert.ok(!p.some((x) => /Pitch sentence not kept/.test(x.problem)), JSON.stringify(p));
});

test("the campaign prompt says the pitch is copied character for character and the bans are for our words", () => {
  const sys = campaignSystemPrompt("en");
  assert.match(sys, /character for character: his punctuation and his word choices stay exactly as he wrote them/);
  assert.match(sys, /not even a closing exclamation mark becoming a full stop/);
  assert.match(sys, /no urgency words in the words we write\. .*Mark's pitch sentences are his own words/);
  assert.doesNotMatch(sys, /The only change allowed is a closing exclamation mark/);
});

test("the campaign prompt carries the house voice verbatim and puts the pitch in email 1", () => {
  const sys = campaignSystemPrompt("en");
  for (const rule of HOUSE_VOICE_RULES) assert.ok(sys.includes(rule), rule);
  assert.match(sys, /every sentence of it into the body of email 1 \(the announcement\), word for word, in his order, and cut nothing/);
  assert.match(sys, /no exclamation marks/);
  assert.doesNotMatch(sys, /stacked exclamation/);
});
