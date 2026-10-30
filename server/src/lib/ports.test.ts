// ports.test.ts — AIS destination strings as crews type them, decoded to ports.
// Every fixture below is a real destination string from the prod tracker
// snapshot on 2026-09-10; before this table a third of them decoded to null,
// which is why ships like Norwegian Getaway ("GSC") had no route line.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchDestination, matchPortName, portBySlug, nearestPort, CRUISE_LOCATIONS } from "./ports";

const CASES: Array<[string, string | null]> = [
  ["GSC", "great-stirrup"],                  // Norwegian Getaway
  ["BSGBI>HNRTM", "roatan"],                 // Carnival Celebration — last leg wins
  ["BS GBI", "freeport-bahamas"],            // Carnival Horizon
  ["US GBI", "freeport-bahamas"],            // Carnival Sunrise (mis-typed prefix)
  ["BS COC", "cococay"],                     // Icon of the Seas
  ["BSCOC", "cococay"],                      // Adventure of the Seas
  ["BS PCC", "cococay"],                     // Oasis of the Seas, Nassau -> Perfect Day at CocoCay (2026-10-07)
  ["BS CCC", "cococay"],                     // Freedom of the Seas
  ["BSPCY", "princess-cays"],                // Carnival Conquest
  ["BS PRI", "princess-cays"],               // Carnival Magic
  ["BSGOC", "castaway-cay"],                 // Disney Destiny
  ["BSOCE", "ocean-cay"],                    // MSC World America
  ["MXPGO", "progreso"],                     // Carnival Breeze / Valor
  ["CZM MX", "cozumel"],                     // Mariner of the Seas
  ["KRALENDIJK, BONAIRE", "bonaire"],        // Grandeur of the Seas
  ["CW CUR", "curacao"],                     // Celebrity Reflection
  ["VISTT", "st-thomas"],                    // Norwegian Prima
  ["BMKWF", "bermuda"],                      // Norwegian Aqua
  ["CAHAL > CASJB", "saint-john-nb"],        // Norwegian Breakaway — last leg wins
  ["CASYD", "sydney-ns"],                    // Independence of the Seas
  ["CA SYD", "sydney-ns"],                   // Zuiderdam
  ["USNPT", "newport-ri"],                   // Norwegian Escape
  ["ITLIV>FRMRS", "marseille"],              // MSC Meraviglia
  ["FRMRS", "marseille"],                    // Carnival Freedom
  ["IT CVV>IT SAL", "salerno"],              // Norwegian Epic
  ["IT LIV>IT MSN", "messina"],              // Norwegian Epic (dev box)
  ["IT SPE", "la-spezia"],                   // Sun Princess
  ["ES BCN", "barcelona"],                   // Sun Princess (dev box)
  ["NO BGO", "bergen"],                      // Sky Princess
  ["AUSYD>VULUG", "sydney"],                 // Carnival Adventure — Sydney, Australia, not Nova Scotia
  // Still unreadable — better null than a wrong route line.
  ["US ENC", null], ["US CKI", null], ["US KHH", null], ["PM FSP", null], ["MXCOM", null],
  // Regression: the codes that already worked keep working.
  ["US MIA > BS NAS", "nassau"], ["USHNL", "honolulu"], ["MIAMI", "miami"],
];

describe("matchDestination on live crew-typed strings", () => {
  for (const [raw, slug] of CASES) {
    it(`${JSON.stringify(raw)} → ${slug}`, () => {
      assert.equal(matchDestination(raw)?.slug ?? null, slug);
    });
  }
});

describe("new gazetteer entries", () => {
  const added = ["freeport-bahamas", "castaway-cay", "ocean-cay", "progreso", "bonaire", "livorno", "marseille",
    "messina", "salerno", "la-spezia", "bergen", "halifax", "sydney-ns", "saint-john-nb", "newport-ri"];
  it("every LOCODE/alias target exists in the gazetteer", () => {
    for (const slug of added) assert.ok(portBySlug(slug), slug);
  });
  it("slugs are unique", () => {
    const slugs = CRUISE_LOCATIONS.map((l) => l.slug);
    assert.equal(new Set(slugs).size, slugs.length);
  });
  it("a ship alongside at Great Stirrup Cay is detected in port there, not at Freeport", () => {
    assert.equal(nearestPort(25.8244, -77.9120, 4)?.slug, "great-stirrup");
    assert.equal(nearestPort(26.5170, -78.7780, 4)?.slug, "freeport-bahamas");
  });
});

describe("matchPortName: written itinerary names, no crew shorthand", () => {
  it("keeps the AIS matcher as it is", () => {
    assert.equal(matchDestination("CABO")?.slug, "cabo-san-lucas");
    assert.equal(matchDestination("US MIA > BS NAS")?.slug, "nassau");
  });
  it("needs the name spelled out", () => {
    assert.equal(matchPortName("Cabo Rojo-Pedernales, Dominicana"), null);
    assert.equal(matchPortName("CABO"), null);
    assert.equal(matchPortName("Cabo San Lucas, Baja California Mexico")?.slug, "cabo-san-lucas");
    assert.equal(matchPortName("Nassau, Bahamas, New Providence Island")?.slug, "nassau");
    assert.equal(matchPortName("Philipsburg St Maarten, Netherlands Antilles")?.slug, "st-maarten");
    assert.equal(matchPortName("Kings Wharf, Bermuda")?.slug, "bermuda");
    assert.equal(matchPortName("Miami, Florida")?.slug, "miami");
    assert.equal(matchPortName(null), null);
  });
});
