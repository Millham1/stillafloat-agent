import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cleanPortName, isNonPort, pageIdentity, parsePortTable, parseSchedule, resolvePort } from "./cruisemapper";

// Real markup captured from cruisemapper.com/ships/Carnival-Legend-551 on
// 2026-09-22. Kept verbatim (whitespace and all) so the tests fail if the
// site's shape changes rather than passing against a tidied-up fake.
const SCHEDULE_HTML = `
<tr data-row="5193604" data-state="0"><td class="cruiseDatetime">2026 Aug 30</td><td class="cruiseTitle">
  12 nights, one-way from Dover to Civitavecchia-Rome   </td><td class="cruiseDeparture"><i title="England"
  class="flag-icon flag-icon-gb"></i>
  Dover   </td><td class="cruisePrice"></td></tr>
<tr data-row="5193606" data-state="0"><td class="cruiseDatetime">2026 Sep 20</td><td class="cruiseTitle">
  12 nights, round-trip from Civitavecchia-Rome, Italy    </td><td class="cruiseDeparture"><i title="Italy"
  class="flag-icon flag-icon-it"></i>
  Civitavecchia-Rome   </td><td class="cruisePrice">$1219</td></tr>`;

const PORTS_HTML = `
<table class="table table-bordered cruiseExpand"><thead><tr>
<th>Date / Time</th><th class="labelPort">Port</th></tr></thead><tbody>
<tr><td class="date">20 Sep 18:30</td><td class="text"><i class="fa fa-flag"></i> &nbsp;<span
 class="flag-icon flag-icon-it" title="Italy"></span> &nbsp;<strong>Departing</strong> from
 <a href="https://www.cruisemapper.com/ports/civitavecchia-rome-port-81">Civitavecchia-Rome, Italy</a><a
 class="itineraryHotelsText" href="https://www.cruisemapper.com/ports/civitavecchia-rome-port-81?tab=hotels#hotels"><i
 class="fa fa-hotel"></i> hotels</a></td></tr>
<tr><td class="date">23 Sep 07:00 - 17:00</td><td class="text"><i class="fa fa-anchor"></i> &nbsp;<a
 href="https://www.cruisemapper.com/ports/kusadasi-port-129">Kusadasi, Ephesus, Turkey</a></td></tr>
<tr><td class="date">02 Oct 06:00</td><td class="text"><strong>Arriving</strong> in <a
 href="https://www.cruisemapper.com/ports/civitavecchia-rome-port-81">Civitavecchia-Rome, Italy</a><a
 class="itineraryHotelsText" href="#"> hotels</a></td></tr>
</tbody></table>`;

test("parseSchedule reads the year the port tables omit", () => {
  const rows = parseSchedule(SCHEDULE_HTML);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    cruiseId: "5193606",
    start: "2026-09-20",
    nights: 12,
    summary: "12 nights, round-trip from Civitavecchia-Rome, Italy",
    fromPort: "Civitavecchia-Rome",
  });
  // A one-way sailing has no price cell; it must still parse.
  assert.equal(rows[0]?.start, "2026-08-30");
  assert.equal(rows[0]?.nights, 12);
});

test("parseSchedule skips duplicate and undated rows", () => {
  assert.deepEqual(parseSchedule(`<tr data-row="9"><td>soon</td><td>7 nights</td></tr>`), []);
  const dupe = SCHEDULE_HTML + SCHEDULE_HTML;
  assert.equal(parseSchedule(dupe).length, 2);
});

test("parsePortTable returns ordered calls with the sailing's year", () => {
  const ports = parsePortTable(PORTS_HTML, "2026-09-20");
  assert.equal(ports.length, 3);
  assert.deepEqual(ports.map((p) => p.date), ["2026-09-20", "2026-09-23", "2026-10-02"]);
  assert.deepEqual(ports.map((p) => p.times), ["18:30", "07:00 - 17:00", "06:00"]);
});

test("parsePortTable strips Departing/Arriving and the hotels link", () => {
  const ports = parsePortTable(PORTS_HTML, "2026-09-20");
  assert.equal(ports[0]?.name, "Civitavecchia-Rome, Italy");
  assert.equal(ports[2]?.name, "Civitavecchia-Rome, Italy");
});

test("parsePortTable prefers CruiseMapper's own port slug over the display text", () => {
  // The visible text carries region noise ("Nassau, Bahamas, New Providence
  // Island"); the href does not. The slug is the stable key.
  const ports = parsePortTable(PORTS_HTML, "2026-09-20");
  assert.deepEqual(ports.map((p) => p.portSlug),
    ["civitavecchia-rome", "kusadasi", "civitavecchia-rome"]);
  assert.equal(ports[0]?.portId, "81");
});

test("parsePortTable rolls the year forward across New Year", () => {
  const xmas = `<table><tr><td class="date">29 Dec 17:00</td><td class="text"><a
    href="https://www.cruisemapper.com/ports/miami-port-9">Miami, Florida</a></td></tr>
    <tr><td class="date">02 Jan 08:00</td><td class="text"><a
    href="https://www.cruisemapper.com/ports/nassau-port-24">Nassau, Bahamas</a></td></tr></table>`;
  const ports = parsePortTable(xmas, "2026-12-29");
  assert.deepEqual(ports.map((p) => p.date), ["2026-12-29", "2027-01-02"]);
});

test("parsePortTable ignores the header row", () => {
  assert.equal(parsePortTable(PORTS_HTML, "2026-09-20").some((p) => /^Port$/i.test(p.name)), false);
});

test("isNonPort rejects the two labels that are not places", () => {
  // 954 of 28,032 scraped rows on 2026-09-23 were one of these two.
  assert.equal(isNonPort("sea cruising"), true);
  assert.equal(isNonPort("land tour, train/bus travel"), true);
  assert.equal(isNonPort("flight"), true);
  assert.equal(isNonPort("coastal cruising"), true);
  assert.equal(isNonPort("river cruising"), true);
  assert.equal(isNonPort("fjord cruising"), true);
  assert.equal(isNonPort("Coco Cay, Bahamas, Royal Caribbean"), false);
  assert.equal(isNonPort("Seattle, Washington"), false);
});

test("cleanPortName decodes entities without mangling real names", () => {
  assert.equal(cleanPortName("L&#039;Austral call at <a>Le Havre-Paris, France</a>"),
    "L'Austral call at Le Havre-Paris, France");
  assert.equal(cleanPortName("  Departing  from  Dover, England   hotels "), "Dover, England");
});

test("pageIdentity reads the page's own MMSI and IMO", () => {
  const html = `<p>built 2002, MMSI 229857000) and registered in Malta</p>
    <a href="https://www.marinetraffic.com/en/ais/details/ships/imo=9224726">track</a>`;
  assert.deepEqual(pageIdentity(html), { mmsi: "229857000", imo: "9224726" });
});

test("pageIdentity returns nulls rather than guessing", () => {
  assert.deepEqual(pageIdentity("<p>no identity here</p>"), { mmsi: null, imo: null });
});

test("resolvePort uses the curated matcher first", () => {
  // Nassau is curated, so it must come back as the same slug the AIS side
  // produces — both run through matchDestination.
  const p = resolvePort({ date: "2026-09-25", times: "08:00 - 17:00",
    name: "Nassau, Bahamas, New Providence Island", portSlug: "nassau", portId: "24" });
  assert.equal(p.slug, "nassau");
  assert.equal(p.ordered, true);
  assert.equal(p.date, "2026-09-25");
});

test("resolvePort matches Coco Cay written as two words", () => {
  // CruiseMapper writes "Coco Cay"; ports.ts stores the slug "cococay".
  assert.equal(resolvePort({ date: null, times: "", name: "Coco Cay, Bahamas, Royal Caribbean",
    portSlug: "coco-cay", portId: "1" }).slug, "cococay");
});

test("resolvePort falls back to the world catalogue for ports we never curated", () => {
  // 66% of the fleet's calls used to resolve to nothing at all.
  for (const [name, slug] of [
    ["Civitavecchia-Rome, Italy", "civitavecchia-rome"],
    ["Piraeus-Athens, Greece", "piraeus-athens"],
    ["Split, Croatia", "split"],
  ] as const) {
    assert.equal(resolvePort({ date: null, times: "", name, portSlug: null, portId: null }).slug, slug);
  }
});

test("resolvePort returns null rather than inventing a key", () => {
  assert.equal(resolvePort({ date: null, times: "", name: "Somewhere Nobody Charted",
    portSlug: null, portId: null }).slug, null);
});
