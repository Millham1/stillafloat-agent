import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCampaign, tidyCampaign, campaignSystemPrompt, campaignUserPrompt, facebookPostText, renderCampaignEmail, renderCampaignEmails } from "./group-campaign";
import { HOUSE_VOICE_RULES, LEAD_WITH_RULES, QR_PROBLEM, buildFacts, ctaRule, normalizeAnswers, type GroupFacts } from "./group-marketing";

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

test("'Join Mark' and amenity points fail every campaign piece; an exclamation mark does not", () => {
  const c = good();
  c.emails[0]!.subject = "Sail with us!";
  c.emails[1]!.body += " Join Mark on the Seaside.";
  c.facebook.reminder += " Three amenity points for the group.";
  const p = validateCampaign(c, facts, {}, url);
  assert.ok(!p.some((x) => x.field === "emails[0].subject"), "the '!' is the register");
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
  assert.deepEqual(p.map((x) => x.field), ["emails[0].body"]);
  assert.match(p.find((x) => x.problem.startsWith("Pitch sentence not kept"))!.problem, /^Pitch sentence not kept: 'Enjoy  all that Nassau has to offer/);
  assert.equal(p.filter((x) => x.problem.startsWith("Pitch sentence not kept")).length, 1, "only his second sentence; the first has his words");
  // nothing else is wrong with the paraphrase: his "!" and his adjectives are the register, so it is a cut and no more
  assert.deepEqual(p.filter((x) => !x.problem.startsWith("Pitch sentence not kept")).map((x) => x.problem), []);
});

test("the bans that remain still apply to our own words around his pitch, in every piece", () => {
  const c = good();
  c.emails[0]!.body = `${VERBATIM} An amazing week, guaranteed!`;
  c.facebook.reminder += " Join Mark on the Seaside!";
  const p = validateCampaign(c, facts, { pitch: MARK_PITCH }, url);
  assert.ok(!p.some((x) => /exclamation|amazing/.test(x.problem)), "the '!' and 'amazing' are the register");
  assert.ok(p.some((x) => x.field === "emails[0].body" && /Guaranteed|guaranteed/.test(x.problem)));
  assert.ok(p.some((x) => x.field === "facebook.reminder" && /Join Mark/.test(x.problem)));
  assert.ok(!p.some((x) => /Pitch sentence not kept/.test(x.problem)), JSON.stringify(p));
});

test("the campaign prompt says the pitch is copied character for character and the bans are for our words", () => {
  const sys = campaignSystemPrompt("en");
  assert.match(sys, /character for character: his punctuation and his word choices stay exactly as he wrote them/);
  assert.match(sys, /not even a closing exclamation mark becoming a full stop/);
  assert.match(sys, /No urgency words, no promises\. .*Mark's pitch sentences are his own words/);
  assert.doesNotMatch(sys, /The only change allowed is a closing exclamation mark/);
});

test("the campaign prompt carries the house voice verbatim and puts the pitch in email 1", () => {
  const sys = campaignSystemPrompt("en");
  for (const rule of HOUSE_VOICE_RULES) assert.ok(sys.includes(rule), rule);
  assert.match(sys, /every sentence of it into the body of email 1 \(the announcement\), word for word, in his order, and cut nothing/);
  assert.match(sys, /Exclamation marks and the capitalised payoff are part of the register/);
  assert.doesNotMatch(sys, /no exclamation marks/);
  assert.doesNotMatch(sys, /no all-caps/);
  assert.doesNotMatch(sys, /stacked exclamation/);
});

// ── Mark's register in the campaign (Mark 2026-10-19) ────────────────────────────────────────────────────────

const SENTENCE = "Imagine shopping Nassau in the morning, watching the sunset from the beach at Ocean Cay, dancing under the lighthouse light show at the beach party that night, then walking that same beach into a Bahamas sunrise… ALL ON THE SAME CRUISE!";

test("email 1 opens with the 'Imagine…' sentence and its payoff, then his pitch verbatim; emails 2 and 3 keep his register; the Facebook announcement is the sentence, the facts and the call to action", () => {
  const sys = campaignSystemPrompt("en", normalizeAnswers({ pitch: MARK_PITCH }));
  assert.match(sys, /Layout of email 1: the 'Imagine…' sentence and its payoff as the opening \(built from <lead_with>: the headline activity first, the event and the sunset-to-sunrise arc named in it\), then Mark's pitch verbatim, then the facts/);
  assert.match(sys, /Emails 2 and 3 keep his register too: full flowing sentences, never fragments; their reminders stay fact-based/);
  assert.match(sys, /Facebook: the announcement is the 'Imagine…' sentence and its payoff, then the facts, then the call to action/);
  assert.match(sys, /the event title is a short line \(70 characters at most\)/);
  assert.match(sys, /the boosted-post text \(300 characters at most\) is the sentence trimmed to the moments that fit, its payoff and the call to action/);
  assert.match(sys, /Never a chain of two-word sentences\. No fragments/);
  assert.match(sys, /the hook is ONE flowing sentence that starts "Imagine…"/);
  assert.ok(LEAD_WITH_RULES.every((r) => sys.includes(r)));
  assert.doesNotMatch(sys, /dry understated humor|the hook as the opening line, then the walk-through sentence/);
  assert.doesNotMatch(sys, /Scan the QR to join the fun/);
  // the user message asks for the sentence in email 1 and the announcement, and carries the info-sheet link and the phone
  const real = buildFacts({ group: { name: "Millham F/F 2027", ship_name: "MSC SEASHORE", cruise_line: "MSC CRUISES", sail_date: "2027-05-09", nights: 4, embark_port: "PCV", itinerary: [{ day: 2, port: "Nassau, Bahamas" }] }, cabins: [] }, null, "en");
  const user = campaignUserPrompt(real, normalizeAnswers({ pitch: MARK_PITCH, picture: "The lighthouse beach party, the sunset and the sunrise" }), url);
  assert.match(user, /email 1 and the Facebook announcement open with ONE rising sentence through the <lead_with> moments in that order and its capitalised payoff, and never a chain of two-word sentences/);
  assert.ok(user.includes(url) && user.includes("919-346-6127"));
  assert.doesNotMatch(user, /The button asks the reader/, "the campaign has no button");
});

test("the call to action is 'Tap here to book your spot!' in every campaign piece (no QR code), or the group's own cta_line", () => {
  const rule = ctaRule({}, "en", "in EVERY piece (every email and every Facebook text: the link is the info sheet, tapped on a phone or a computer; no piece carries a QR code, which is printed on the poster only)");
  assert.ok(campaignSystemPrompt("en").includes(rule));
  assert.match(rule, /the exact words "Tap here to book your spot!" \(in a Facebook text the same words end in a colon, "Tap here to book your spot:", and the link follows on the next line\), then the link, then the phone 919-346-6127/);
  assert.match(rule, /Never mention a QR code: a QR code is for the printed poster only/);
  assert.match(campaignSystemPrompt("es"), /the exact words "¡Toque aquí para reservar su lugar!"/);
  assert.doesNotMatch(campaignSystemPrompt("en"), /Use the QR code to book your spot!|carries the QR image/);
  const own = campaignSystemPrompt("en", { cta_line: "Scan the QR to join the fun" });
  assert.match(own, /the exact words "Scan the QR to join the fun", then the link/);
  assert.doesNotMatch(own, /Use the QR code to book your spot!|Tap here to book your spot!/);
});

test("a campaign piece that mentions a QR code is refused; Mark's pitch sentence and his own cta_line may", () => {
  const c = good();
  c.emails[0]!.body += " Use the QR code to book your spot!";
  c.facebook.reminder += " Scan the QR to book.";
  const p = validateCampaign(c, facts, {}, url);
  assert.deepEqual(p.filter((x) => x.problem === QR_PROBLEM).map((x) => x.field), ["emails[0].body", "facebook.reminder"]);
  // a pitch sentence of his that names the QR is his word; so is a cta_line he typed
  const c2 = good();
  c2.emails[0]!.body = `${PITCH}\n\nTap here to book your spot!\n\nStill Afloat Cruising`;
  assert.ok(!validateCampaign(c2, facts, { pitch: PITCH }, url).some((x) => x.problem === QR_PROBLEM));
  const c3 = good();
  c3.facebook.boosted = "Scan the QR to join the fun";
  assert.ok(!validateCampaign(c3, facts, { cta_line: "Scan the QR to join the fun" }, url).some((x) => x.problem === QR_PROBLEM));
});

// ── The email as it is sent or previewed: a button to tap, never a QR code ───────────────────────────────────────

test("a campaign email is drawn with a 'Tap here' button, the plain link under it, the phone and the signature, and no QR code", () => {
  const e = { slot: "announcement" as const, subject: "A group cruise for the Post", preheader: "Four nights on MSC Seaside", body: `We sail May 10, 2027 & the cabins start at $575.80 per person.\n\nTap here to book your spot!\n${url}\n\nCall or text Mark at 919-346-6127.\n\nStill Afloat Cruising` };
  const r = renderCampaignEmail(e, { url, lang: "en" });
  assert.equal((r.html.match(/data-cta="1"/g) ?? []).length, 1, "exactly one button");
  assert.match(r.html, new RegExp(`<a data-cta="1" href="${url.replace(/[?]/g, "\\?")}"[^>]*>Tap here to book your spot!</a>`));
  assert.ok(r.html.includes(`<a href="${url}"`), "the plain link is under the button");
  assert.doesNotMatch(r.html, /<img|qr/i, "no QR image and no mention of one");
  assert.equal((r.html.match(/Tap here to book your spot!/g) ?? []).length, 1, "the call to action is said once, as the button");
  assert.equal((r.html.match(/919-346-6127/g) ?? []).length, 1, "the phone the writer gave is not repeated");
  assert.ok(r.html.indexOf("We sail May 10, 2027 &amp;") < r.html.indexOf('data-cta="1"') && r.html.indexOf('data-cta="1"') < r.html.indexOf("Call or text Mark"), "the button sits where the writer put the call to action");
  assert.ok(r.html.endsWith("<p style=\"margin:0\">Still Afloat Cruising</p></div>"));
  assert.equal((r.html.match(/Still Afloat Cruising/g) ?? []).length, 1);
  assert.equal(r.text, `We sail May 10, 2027 & the cabins start at $575.80 per person.\n\nTap here to book your spot!\n${url}\n\nCall or text Mark at 919-346-6127.\n\nStill Afloat Cruising\n`);
  assert.match(r.html, /display:none[^>]*>Four nights on MSC Seaside</, "the preview line is carried");
});

test("a campaign email whose writer put the call to action at the end of a sentence, or left it out, still gets one button and the phone", () => {
  const inline = renderCampaignEmail({ slot: "reminder", subject: "s", preheader: "", body: `A few balconies are left. Tap here to book your spot! ${url}` }, { url, lang: "en" });
  assert.match(inline.html, />A few balconies are left\.</);
  assert.equal((inline.html.match(/Tap here to book your spot!/g) ?? []).length, 1);
  assert.equal((inline.html.match(/href="https:\/\/stillafloatcruising\.com\/group\.html\?g=rj4qhy2xft"/g) ?? []).length, 2, "the button and the plain link, nothing else");
  assert.match(inline.html, /Prefer to call or text\? Reach us at 919-346-6127\./, "no phone in the body: the email adds its own line");
  const none = renderCampaignEmail({ slot: "last_call", subject: "s", preheader: "", body: "Last days to reserve." }, { url, lang: "en" });
  assert.ok(none.html.indexOf("Last days to reserve.") < none.html.indexOf('data-cta="1"'), "no call to action in the body: the button follows the body");
  // Spanish and the group's own line
  const es = renderCampaignEmail({ slot: "announcement", subject: "s", preheader: "", body: "Zarpamos el 10 de mayo de 2027." }, { url, lang: "es" });
  assert.match(es.html, />¡Toque aquí para reservar su lugar!</);
  assert.match(es.html, /¿Prefiere llamar o escribir\?/);
  const own = renderCampaignEmail({ slot: "announcement", subject: "s", preheader: "", body: "Hello." }, { url, lang: "en", answers: { cta_line: "Count us in" } });
  assert.match(own.html, />Count us in</);
  assert.equal(renderCampaignEmails(good() as never, { url, lang: "en" }).length, 3);
});

test("a Facebook text gets 'Tap here to book your spot:' and the link, unless the writer already gave the link", () => {
  assert.equal(facebookPostText("Group cruise for veterans.", { url, lang: "en" }), `Group cruise for veterans.\n\nTap here to book your spot:\n${url}`);
  assert.equal(facebookPostText("Group cruise.\n\nTap here to book your spot:\n" + url, { url, lang: "en" }), `Group cruise.\n\nTap here to book your spot:\n${url}`);
  assert.equal(facebookPostText("Crucero en grupo.", { url, lang: "es" }), `Crucero en grupo.\n\n¡Toque aquí para reservar su lugar:\n${url}`);
  assert.equal(facebookPostText("Hello.", { url, lang: "en", answers: { cta_line: "Count us in" } }), `Hello.\n\nCount us in\n${url}`);
});

test("a campaign in Mark's register passes: the sentence and its payoff open email 1 and the announcement, his pitch follows, '!' and capitals included", () => {
  const c = good();
  c.emails[0]!.body = `${SENTENCE}\n\n${VERBATIM}\n\nTap here to book your spot!\n\nStill Afloat Cruising`;
  c.emails[1]!.body = "Imagine the beach party under the lighthouse light show, with a few cabins still open and the deposit at $99 per person. Tap here to book your spot!";
  c.facebook.announcement = `${SENTENCE}\n\nTap here to book your spot:\n${url}`;
  c.facebook.boosted = "Imagine the lighthouse light show at the beach party, then a Bahamas sunrise… ALL ON THE SAME CRUISE! Tap here to book your spot!";
  assert.deepEqual(validateCampaign(c, facts, { pitch: MARK_PITCH }, url), []);
  // the "Join Mark" hook is still refused in any of them
  c.facebook.announcement = `Join Mark! ${SENTENCE}`;
  assert.ok(validateCampaign(c, facts, { pitch: MARK_PITCH }, url).some((x) => x.field === "facebook.announcement" && /Join Mark/.test(x.problem)));
});
