import { test } from "node:test";
import assert from "node:assert/strict";
import { licenseClass, rankCandidates, type CommonsCandidate } from "./group-assets";

test("licenses: CC0 / public domain / CC BY are free to use; CC BY-SA is last resort; anything else is refused", () => {
  assert.equal(licenseClass("CC0"), "free"); assert.equal(licenseClass("Public domain"), "free");
  assert.equal(licenseClass("CC BY 4.0"), "free"); assert.equal(licenseClass("CC BY 2.0"), "free");
  assert.equal(licenseClass("CC BY-SA 4.0"), "sa");
  assert.equal(licenseClass("CC BY-NC 4.0"), "no"); assert.equal(licenseClass(""), "no"); assert.equal(licenseClass(null), "no");
});

test("rankCandidates prefers free licenses, then big landscape photos; drops unusable ones", () => {
  const c = (title: string, license: string, w: number, h: number): CommonsCandidate => ({ title, license, width: w, height: h, pageUrl: "", fileUrl: "f", shareAlike: /SA/.test(license), attribution: "" });
  const ranked = rankCandidates([c("nc", "CC BY-NC 2.0", 6000, 4000), c("sa-big", "CC BY-SA 4.0", 6000, 4000), c("by-small-portrait", "CC BY 4.0", 1200, 1800), c("cc0-big", "CC0", 4032, 2268)], 3);
  assert.deepEqual(ranked.map((x) => x.title), ["cc0-big", "by-small-portrait", "sa-big"]);
});


test("ship photos: an atrium or restaurant shot ranks below an exterior; destination photos: a same-name place elsewhere is refused", () => {
  const c = (title: string, license: string, w: number, h: number): CommonsCandidate => ({ title, license, width: w, height: h, pageUrl: "", fileUrl: "f", shareAlike: /SA/.test(license), attribution: "" });
  const ship = rankCandidates([c("MSC Seaside Atrium.jpg", "CC BY 2.0", 2732, 1821), c("MSC Seaside docked at Ocean Cay.jpg", "CC BY 4.0", 4624, 2600)], 2, "ship");
  assert.equal(ship[0]!.title, "MSC Seaside docked at Ocean Cay.jpg");
  const dest = rankCandidates([c("Nassau, New York 080909 098.jpg", "CC BY-SA 2.0", 1600, 1200), c("Nassau harbour, Bahamas.jpg", "CC BY 2.0", 3000, 2000)], 3, "destination");
  assert.deepEqual(dest.map((x) => x.title), ["Nassau harbour, Bahamas.jpg"]);
});
