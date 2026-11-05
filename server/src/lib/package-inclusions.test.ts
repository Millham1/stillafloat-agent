import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeExtraction } from "./booking-extract";
import { applyPackageInclusions, packageFor, type PackageRow } from "./package-inclusions";

const ROW: PackageRow = {
  cruise_line: "Margaritaville at Sea", ship: "Paradise", package_name: "Ultimate License to Chill",
  inclusions: ["Ultimate Beverage Chill Package", "Premium WiFi for one device", "Priority embarkation and debarkation (Express Check-In)"],
  checked_on: "2026-11-05", source_url: "https://www.margaritavilleatsea.com/current-offers/paradise-ultimate-license-to-chill",
};
const read = (over: Record<string, unknown> = {}) => normalizeExtraction({
  cruise_line: "Margaritaville at Sea", ship_name: "Margaritaville at Sea Paradise",
  addons: [{ name: "ULTIMATE LICENSE TO CHILL", price: 699, qty: 1, total: 699 }], guest_inclusions: [], ...over,
});

test("a paid add-on named in the package table lists what it includes, and the guest's inclusions carry it (Mark 2026-11-05)", () => {
  const x = applyPackageInclusions(read(), [ROW]);
  assert.deepEqual(x.addons![0]!.includes, ROW.inclusions);
  assert.equal(x.addons![0]!.includes_checked_on, "2026-11-05");
  assert.deepEqual(x.guest_inclusions, ROW.inclusions);
  // the stored read keeps the package's lines when it is read back
  assert.deepEqual(normalizeExtraction(x).addons![0]!.includes, ROW.inclusions);
  assert.deepEqual(normalizeExtraction(x).guest_inclusions, ROW.inclusions);
});

test("the document's own inclusions come first and nothing is listed twice", () => {
  const x = applyPackageInclusions(read({ guest_inclusions: ["Premium Wifi for one device", "Onboard credit $50"] }), [ROW]);
  assert.deepEqual(x.guest_inclusions, ["Premium Wifi for one device", "Onboard credit $50", "Ultimate Beverage Chill Package", "Priority embarkation and debarkation (Express Check-In)"]);
});

test("a package of another ship, another line or another name is not matched; an add-on not in the table is left as read", () => {
  assert.equal(packageFor([ROW], "Margaritaville at Sea", "Margaritaville at Sea Islander", "Ultimate License to Chill"), null);
  assert.equal(packageFor([ROW], "MSC Cruises", "MSC Seashore", "Ultimate License to Chill"), null);
  assert.equal(packageFor([ROW], "Margaritaville at Sea", "Paradise", "License to Chill"), null);
  const x = applyPackageInclusions(read({ addons: [{ name: "Faster Chill", price: 129, qty: 1, total: 129 }] }), [ROW]);
  assert.equal(x.addons![0]!.includes, undefined);
  assert.deepEqual(x.guest_inclusions, []);
});

test("a line-wide row serves every ship, and the ship's own row goes first", () => {
  const wide: PackageRow = { ...ROW, ship: null, inclusions: ["Line-wide"] };
  assert.equal(packageFor([wide], "Margaritaville at Sea", "Islander", "ultimate license to chill")!.inclusions[0], "Line-wide");
  assert.equal(packageFor([wide, ROW], "Margaritaville at Sea", "Paradise", "ultimate license to chill"), ROW);
});
