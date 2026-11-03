import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { uploadsPlaylistId, parsePlaylistItems, fetchUploads, channelIdForHandle, stampedLanguage, fetchVideoLanguages, capHistory, spanishTitle, inLanguage, titleIn } from "./youtube-api";

const CID = "UC1sZkmM4CezcS5DPIPlrCtA";
const item = (id: string, title: string, at = "2026-10-01T00:00:00Z") => ({
  snippet: { title, publishedAt: at, resourceId: { videoId: id }, thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hq.jpg` } } },
  contentDetails: { videoId: id, videoPublishedAt: at },
});
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });

describe("uploads playlist id", () => {
  it("swaps UC for UU and refuses anything that is not a channel id", () => {
    assert.equal(uploadsPlaylistId(CID), "UU1sZkmM4CezcS5DPIPlrCtA");
    assert.equal(uploadsPlaylistId("@handle"), null);
    assert.equal(uploadsPlaylistId("UC123"), null);
    assert.equal(uploadsPlaylistId(""), null);
  });
});

describe("playlist items → uploads", () => {
  it("keeps id, title, the VIDEO's publish time and the best thumbnail", () => {
    const { videos, next } = parsePlaylistItems({ items: [item("aaaaaaaaaaa", "A real video", "2026-09-30T12:00:00Z")], nextPageToken: "T2" });
    assert.deepEqual(videos, [{ id: "aaaaaaaaaaa", title: "A real video", published: "2026-09-30T12:00:00Z", thumbnail: "https://i.ytimg.com/vi/aaaaaaaaaaa/hq.jpg" }]);
    assert.equal(next, "T2");
  });
  it("drops private and deleted uploads and entries with no id", () => {
    const { videos } = parsePlaylistItems({ items: [item("bbbbbbbbbbb", "Private video"), item("ccccccccccc", "Deleted video"), { snippet: { title: "No id" } }, item("ddddddddddd", "Kept")] });
    assert.deepEqual(videos.map((v) => v.id), ["ddddddddddd"]);
  });
  it("falls back to the playlist entry's own time and to the default thumbnail; tolerates junk", () => {
    const { videos } = parsePlaylistItems({ items: [{ snippet: { title: "T", publishedAt: "2026-01-01T00:00:00Z", resourceId: { videoId: "eeeeeeeeeee" } } }] });
    assert.equal(videos[0]!.published, "2026-01-01T00:00:00Z");
    assert.equal(videos[0]!.thumbnail, "https://img.youtube.com/vi/eeeeeeeeeee/mqdefault.jpg");
    assert.deepEqual(parsePlaylistItems(null), { videos: [], next: null });
    assert.deepEqual(parsePlaylistItems({}), { videos: [], next: null });
  });
});

describe("fetchUploads", () => {
  it("follows the page token up to the page limit and asks for the uploads playlist with the key", async () => {
    const urls: string[] = [];
    const pages = [{ items: [item("aaaaaaaaaaa", "One")], nextPageToken: "P2" }, { items: [item("bbbbbbbbbbb", "Two")], nextPageToken: "P3" }, { items: [item("ccccccccccc", "Three")] }];
    const got = await fetchUploads(CID, "KEY", (u) => { urls.push(u); return ok(pages[urls.length - 1]); }, 2);
    assert.deepEqual(got.map((v) => v.id), ["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    assert.equal(urls.length, 2);
    assert.match(urls[0]!, /playlistId=UU1sZkmM4CezcS5DPIPlrCtA/);
    assert.match(urls[0]!, /key=KEY/);
    assert.match(urls[1]!, /pageToken=P2/);
  });
  it("stops when there is no next page", async () => {
    let n = 0;
    const got = await fetchUploads(CID, "KEY", () => { n++; return ok({ items: [item("aaaaaaaaaaa", "Only")] }); }, 5);
    assert.equal(got.length, 1);
    assert.equal(n, 1);
  });
  it("throws with the HTTP status when the API refuses (quota, key restriction) so the scan can fall back", async () => {
    await assert.rejects(fetchUploads(CID, "KEY", () => Promise.resolve({ ok: false, status: 403, json: async () => ({}) })), /playlistItems\.list answered HTTP 403/);
  });
  it("refuses a value that is not a channel id without calling the API", async () => {
    let called = false;
    await assert.rejects(fetchUploads("@nope", "KEY", () => { called = true; return ok({}); }), /not a channel id/);
    assert.equal(called, false);
  });
});

describe("channel id for a handle", () => {
  it("returns the channel id the API names, and null for anything else", async () => {
    const urls: string[] = [];
    assert.equal(await channelIdForHandle("@StillAfloatcruising2026", "KEY", (u) => { urls.push(u); return ok({ items: [{ id: CID }] }); }), CID);
    assert.match(urls[0]!, /forHandle=StillAfloatcruising2026/);
    assert.equal(await channelIdForHandle("@x", "KEY", () => ok({ items: [] })), null);
    assert.equal(await channelIdForHandle("@x", "KEY", () => ok({ items: [{ id: "not-a-channel" }] })), null);
  });
});

describe("recorded video language", () => {
  it("reads the title/description language first — older Spanish uploads carry an en-US audio stamp", () => {
    assert.equal(stampedLanguage({ defaultLanguage: "es", defaultAudioLanguage: "en-US" }), "es");
    assert.equal(stampedLanguage({ defaultLanguage: "es-419", defaultAudioLanguage: "es-419" }), "es");
    assert.equal(stampedLanguage({ defaultLanguage: "en", defaultAudioLanguage: "en-US" }), "en");
  });
  it("falls back to the audio stamp, and is null when neither names English or Spanish", () => {
    assert.equal(stampedLanguage({ defaultAudioLanguage: "es" }), "es");
    assert.equal(stampedLanguage({ defaultLanguage: "fr" }), null);
    assert.equal(stampedLanguage({}), null);
    assert.equal(stampedLanguage(undefined), null);
  });
  it("never looks at the title: an accent-free Spanish title is still Spanish", async () => {
    const body = { items: [
      { id: "L18spl6KxF8", snippet: { title: "7 cosas que debes hacer apenas entras a tu cabina de crucero", defaultLanguage: "es", defaultAudioLanguage: "es" } },
      { id: "6NeMFj0SYxM", snippet: { title: "The First Hour In Your Cruise Cabin: 7 Moves That Fix The Week", defaultLanguage: "en", defaultAudioLanguage: "en" } },
      { id: "nostampnost", snippet: { title: "¿Sin sello?" } },
    ] };
    const got = await fetchVideoLanguages(["L18spl6KxF8", "6NeMFj0SYxM", "nostampnost"], "KEY", () => ok(body));
    assert.equal(got.get("L18spl6KxF8"), "es");
    assert.equal(got.get("6NeMFj0SYxM"), "en");
    assert.equal(got.has("nostampnost"), false);
  });
  it("asks in batches of 50 and throws on an API refusal", async () => {
    const urls: string[] = [];
    const ids = Array.from({ length: 51 }, (_, i) => `v${String(i).padStart(10, "0")}`);
    await fetchVideoLanguages(ids, "KEY", (u) => { urls.push(u); return ok({ items: [] }); });
    assert.equal(urls.length, 2);
    assert.match(urls[0]!, /part=snippet/);
    await assert.rejects(fetchVideoLanguages(["x"], "KEY", () => Promise.resolve({ ok: false, status: 403, json: async () => ({}) })), /videos\.list answered HTTP 403/);
  });
});

describe("history cap", () => {
  const vids = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}` }));
  it("keeps the newest max videos", () => {
    assert.deepEqual(capHistory(vids, null, 3).map((v) => v.id), ["v0", "v1", "v2"]);
  });
  it("keeps Mark's pinned video when it falls past the cap", () => {
    assert.deepEqual(capHistory(vids, "v4", 3).map((v) => v.id), ["v0", "v1", "v2", "v4"]);
  });
  it("does not repeat a pinned video already inside the cap, and ignores a pin that is not in the history", () => {
    assert.deepEqual(capHistory(vids, "v1", 3).map((v) => v.id), ["v0", "v1", "v2"]);
    assert.deepEqual(capHistory(vids, "gone", 3).map((v) => v.id), ["v0", "v1", "v2"]);
  });
});

describe("one video, two languages (2026-11-02)", () => {
  it("reads our Spanish title from es-419, then es, else null", () => {
    assert.equal(spanishTitle({ en: { title: "E" }, "es-419": { title: "¿Cuánto?" } }), "¿Cuánto?");
    assert.equal(spanishTitle({ es: { title: "Hola" } }), "Hola");
    assert.equal(spanishTitle({ en: { title: "E" } }), null);
    assert.equal(spanishTitle(undefined), null);
  });
  it("puts an English long-form with our Spanish title on both pages, under the right title", () => {
    const one = { title: "The True Cost", lang: "en" as const, titleEs: "¿Cuánto cuesta?" };
    assert.equal(inLanguage(one, "en"), true);
    assert.equal(inLanguage(one, "es"), true);
    assert.equal(titleIn(one, "es"), "¿Cuánto cuesta?");
    assert.equal(titleIn(one, "en"), "The True Cost");
    assert.equal(titleIn(one, null), "The True Cost");
  });
  it("keeps an English video with no Spanish title off the Spanish page, and a Spanish Short off the English one", () => {
    assert.equal(inLanguage({ lang: "en" }, "es"), false);
    assert.equal(inLanguage({ lang: "es" }, "en"), false);
    assert.equal(inLanguage({ lang: "es" }, "es"), true);
  });
});
