// live-ais-core.test.ts — fixtures are VERBATIM live responses captured from
// api.live-ais.com on 2026-09-21 (Norwegian Getaway, MMSI 311050900), not the
// dashboard's idealised samples. The two disagree in ways that matter: the
// docs show cog: 74 and eta ISO, the live API sends "115°" and "Sep 22, 10:15".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseVessel, parseTrack, parsePorts, parseEta, parseStamp, parseLastPort,
  num, mapSource, dedupeRepeats, fixFromTrack, callsFromTrack, trackGaps, calledAt,
  creditCost, trackDays, liveAisUrl, distanceKm,
  parseBbox, isPassengerType, bboxCreditsCharged, boxAround,
  blankCreditState, foldMonthlyUsage, creditStatus, creditAlarm,
  DEFAULT_LIVE_AIS_CAP, MAX_TRACK_DAYS, CALL_RADIUS_KM, DEFAULT_LOW_CREDIT_THRESHOLD,
  type TrackPoint, type PortPoint,
} from "./live-ais-core";

// GET /api/v1/vessel/311050900 — note: NO lat/lon, numbers as display strings.
const VESSEL = {
  call_sign: "C6ZJ4", cog: "115°", destination: "Great Stirrup Cay, Bahamas",
  draught: "8.5 m", dwt: "11110.0", eta: "Sep 22, 10:15", flag: "BS", gt: "145655",
  imo: "9606924", last_port: "Miami, United States (USA) ATA: Sep 21", length: "326",
  mmsi: "311050900", nav_status: "Moored", sog: "", status: "Moored",
  timestamp: "2026-09-21 15:02:30", vessel_name: "NORWEGIAN GETAWAY",
  vessel_type: "Passenger ship", width: "54 m", year_built: "2014",
};

// GET /api/v1/vessel/311050900/track/3 — the Nassau block repeats ONE fix four times.
const TRACK = {
  mmsi: "311050900", days: 3, points_count: 8, source: "saagar",
  points: [
    { timestamp: "2026-09-18 15:34:14", lat: 25.868826, lon: -79.837502, sog: 13.0, cog: 242.0, heading: 233.0, destination: "MIAMI", eta: "" },
    { timestamp: "2026-09-19 10:08:19", lat: 25.0700, lon: -77.4100, sog: 9.6, cog: 90.0, heading: 88.0, destination: "NASSAU", eta: "" },
    { timestamp: "2026-09-19 11:16:00", lat: 25.0700, lon: -77.4100, sog: 9.6, cog: 90.0, heading: 88.0, destination: "NASSAU", eta: "" },
    { timestamp: "2026-09-19 12:40:32", lat: 25.0700, lon: -77.4100, sog: 9.6, cog: 90.0, heading: 88.0, destination: "NASSAU", eta: "" },
    { timestamp: "2026-09-20 13:08:54", lat: 25.8250, lon: -77.9060, sog: 0.0, cog: 0.0, heading: 0.0, destination: "GREAT STIRRUP CAY", eta: "" },
    { timestamp: "2026-09-20 16:09:11", lat: 25.8250, lon: -77.9060, sog: 0.0, cog: 12.0, heading: 0.0, destination: "GREAT STIRRUP CAY", eta: "" },
    { timestamp: "2026-09-20 20:38:14", lat: 25.8250, lon: -77.9060, sog: 0.0, cog: 20.0, heading: 0.0, destination: "GREAT STIRRUP CAY", eta: "" },
    { timestamp: "2026-09-20 22:08:36", lat: 25.8450, lon: -77.9300, sog: 11.0, cog: 250.0, heading: 248.0, destination: "MIAMI", eta: "" },
  ],
};

const PORTS: PortPoint[] = [
  { slug: "great-stirrup", lat: 25.8244, lon: -77.9120 },
  { slug: "nassau", lat: 25.0443, lon: -77.3504 },
  { slug: "miami", lat: 25.7743, lon: -80.1937 },
];

describe("field coercion (live API sends display strings, docs show numbers)", () => {
  it('reads a number out of "115°" and "8.5 m"', () => {
    assert.equal(num("115°", 360), 115);
    assert.equal(num("8.5 m", 100), 8.5);
    assert.equal(num(18, 102.3), 18);
  });
  it('treats an empty sog (moored) as unknown, not zero', () => {
    assert.equal(num("", 102.3), null, "a blank speed must not become 0 kn — that would read as 'in port'");
  });
  it("rejects out-of-range values", () => {
    assert.equal(num("511", 360), null);
    assert.equal(num("-4", 360), null);
  });
  it('maps the undocumented source "saagar" to unknown, never satellite', () => {
    assert.equal(mapSource("saagar"), "unknown");
    assert.equal(mapSource("SAT-AIS"), "satellite");
    assert.equal(mapSource("terrestrial"), "terrestrial");
  });
});

describe("parseStamp / parseEta", () => {
  it("reads the provider's zone-less UTC stamp", () => {
    assert.equal(parseStamp("2026-09-21 15:02:30"), "2026-09-21T15:02:30.000Z");
  });
  it('resolves a year-less eta "Sep 22, 10:15" against now', () => {
    assert.equal(parseEta("Sep 22, 10:15", new Date("2026-09-21T15:02:30Z")), "2026-09-22T10:15:00.000Z");
  });
  it("picks the nearest year across a new-year boundary", () => {
    assert.equal(parseEta("Jan 02, 06:00", new Date("2026-12-31T20:00:00Z")), "2027-01-02T06:00:00.000Z");
    assert.equal(parseEta("Dec 30, 06:00", new Date("2027-01-01T04:00:00Z")), "2026-12-30T06:00:00.000Z");
  });
  it("returns null for an absent eta", () => {
    assert.equal(parseEta(""), null);
  });
});

describe("parseLastPort", () => {
  it('splits "Miami, United States (USA) ATA: Sep 21" into name and arrival text', () => {
    const lp = parseLastPort(VESSEL.last_port)!;
    assert.equal(lp.name, "Miami");
    assert.equal(lp.ataText, "Sep 21");
  });
  it("keeps the name when there is no ATA clause", () => {
    assert.deepEqual(parseLastPort("Nassau, Bahamas"), { name: "Nassau", ataText: null });
  });
});

describe("parseVessel (1 credit — carries NO position)", () => {
  const v = parseVessel(VESSEL)!;
  it("decodes the record", () => {
    assert.equal(v.mmsi, "311050900");
    assert.equal(v.name, "NORWEGIAN GETAWAY");
    assert.equal(v.imo, "9606924");
    assert.equal(v.destination, "Great Stirrup Cay, Bahamas");
    assert.equal(v.at, "2026-09-21T15:02:30.000Z");
    assert.equal(v.courseDeg, 115);
  });
  it("flags moored from nav_status", () => {
    assert.equal(v.stopped, true);
    assert.equal(v.speedKn, null, "sog is blank while moored");
  });
  it("has no lat/lon to give — the whole reason a fix comes from a track", () => {
    assert.equal((v as unknown as Record<string, unknown>)["lat"], undefined);
  });
  it("falls back to `timestamp` only when the provider omits last_reported_at", () => {
    assert.equal(v.at, "2026-09-21T15:02:30.000Z");
    assert.equal(v.reportedAtKnown, false, "we must know this is the QUERY time, not her report time");
  });
  it("REGRESSION: prefers last_reported_at — `timestamp` is when WE asked", () => {
    // Verbatim MSC Meraviglia, 2026-09-22: answered at 15:40:45, she reported 15:37:00.
    const m = parseVessel({
      mmsi: "249973000", imo: "9760512", vessel_name: "MSC MERAVIGLIA",
      timestamp: "2026-09-22 15:40:45", last_reported_at: "2026-09-22 15:37:00",
      nav_status: "Moored", sog: "0.1 kn", cog: "226\u00b0",
      destination: "La Goulette Nord (Halqueloued), Tunisia",
      last_port: "Barcelona, Spain ATA: Sep 22", eta: "Sep 24, 05:30",
    })!;
    assert.equal(m.at, "2026-09-22T15:37:00.000Z", "using `timestamp` makes every fix look seconds old");
    assert.equal(m.reportedAtKnown, true);
    assert.equal(m.lastPort!.name, "Barcelona");
    assert.equal(m.speedKn, 0.1);
  });
  it("refuses a body without a 9-digit MMSI", () => {
    assert.equal(parseVessel({ mmsi: "abc" }), null);
    assert.equal(parseVessel(null), null);
  });
});

describe("parseTrack", () => {
  const pts = parseTrack(TRACK);
  it("drops the repeated stale fix that claims 9.6 kn while not moving", () => {
    assert.equal(TRACK.points.length, 8);
    assert.equal(pts.length, 6, "the three frozen Nassau rows collapse to one");
    assert.equal(pts.filter((p) => p.destination === "NASSAU").length, 1);
  });
  it("KEEPS the repeated moored fixes — they are how long she stayed", () => {
    const kept = pts.filter((p) => p.destination === "GREAT STIRRUP CAY");
    assert.equal(kept.length, 3,
      "collapsing 0.0 kn repeats would erase the port call's duration, which is the whole point");
  });
  it("returns oldest first", () => {
    const times = pts.map((p) => Date.parse(p.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });
  it("skips rows with no usable position", () => {
    assert.deepEqual(parseTrack({ points: [{ timestamp: "2026-09-20 10:00:00", lat: 0, lon: 0 }] }), []);
    assert.deepEqual(parseTrack({ points: "nope" }), []);
  });
});

describe("dedupeRepeats", () => {
  it("only collapses CONSECUTIVE repeats — a real return to the same berth survives", () => {
    const p = (at: string, lat: number, sog: number): TrackPoint =>
      ({ lat, lon: -80, at, speedKn: sog, courseDeg: null, headingDeg: null, destination: null });
    const out = dedupeRepeats([p("2026-09-01T00:00:00Z", 25, 0), p("2026-09-01T02:00:00Z", 26, 12), p("2026-09-01T04:00:00Z", 25, 0)]);
    assert.equal(out.length, 3);
  });
});

describe("fixFromTrack", () => {
  it("takes the newest point and never claims satellite for an unknown source", () => {
    const fix = fixFromTrack(parseTrack(TRACK), TRACK.source)!;
    assert.equal(fix.at, "2026-09-20T22:08:36.000Z");
    assert.equal(fix.speedKn, 11);
    assert.equal(fix.source, "unknown");
    assert.equal(fix.destination, "MIAMI");
  });
  it("returns null for an empty track", () => {
    assert.equal(fixFromTrack([]), null);
  });
});

describe("callsFromTrack — the island blind spot this provider exists to close", () => {
  const pts = parseTrack(TRACK);
  const calls = callsFromTrack(pts, PORTS);
  it("sees the Great Stirrup Cay call the free terrestrial feed never logged", () => {
    const gs = calls.find((c) => c.slug === "great-stirrup");
    assert.ok(gs, "Great Stirrup Cay must be evidenced");
    assert.equal(gs!.arrivedAt, "2026-09-20T13:08:54.000Z");
    assert.ok(gs!.closestKm < CALL_RADIUS_KM);
  });
  it("preserves how long she stayed, not just that she arrived", () => {
    const gs = calls.find((c) => c.slug === "great-stirrup")!;
    const hours = (Date.parse(gs.departedAt!) - Date.parse(gs.arrivedAt)) / 3_600_000;
    assert.ok(hours > 7, `a full island day, got ${hours}h`);
  });
  it("does NOT invent a Nassau call from a stale 9.6 kn fix", () => {
    assert.equal(calls.some((c) => c.slug === "nassau"), false,
      "she was never observed stopped at Nassau in this track — that is 'not seen', not 'did not call'");
  });
  it("ignores a port the ship only passed at speed", () => {
    assert.equal(calls.some((c) => c.slug === "miami"), false);
  });
});

describe("calledAt — silence must never become a headline", () => {
  const pts = parseTrack(TRACK);
  it("answers yes when the call is evidenced", () => {
    assert.equal(calledAt(pts, PORTS, "great-stirrup", "2026-09-20T00:00:00Z", "2026-09-21T00:00:00Z"), "yes");
  });
  it("answers unknown — not no — when a blind gap sits inside the window", () => {
    assert.equal(calledAt(pts, PORTS, "nassau", "2026-09-18T00:00:00Z", "2026-09-21T00:00:00Z"), "unknown",
      "the 19-hour hole could hide the whole call");
  });
  it("answers unknown when the window has no points at all", () => {
    assert.equal(calledAt(pts, PORTS, "nassau", "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"), "unknown");
  });
  it("answers no only when the window is genuinely covered", () => {
    const dense: TrackPoint[] = [];
    for (let h = 0; h <= 12; h += 1) {
      dense.push({ lat: 24.0, lon: -79.0, at: new Date(Date.UTC(2026, 8, 22, h)).toISOString(), speedKn: 14, courseDeg: null, headingDeg: null, destination: null });
    }
    assert.equal(calledAt(dense, PORTS, "nassau", "2026-09-22T00:00:00Z", "2026-09-22T12:00:00Z"), "no");
  });
});

describe("trackGaps", () => {
  it("reports the holes the provider left", () => {
    const gaps = trackGaps(parseTrack(TRACK));
    assert.ok(gaps.length >= 1);
    assert.ok(gaps.every((g) => g.hours > 6));
  });
});

describe("cost model — a call may cost 1 to 15 credits, never assumed to be 1", () => {
  it("prices each endpoint from the published table", () => {
    assert.equal(creditCost("vessel"), 1);
    assert.equal(creditCost("track", 1), 1);
    assert.equal(creditCost("track", 7), 7);
    assert.equal(creditCost("ports"), 5, "5, or 1 when the ship has no schedule — assume the worst");
  });
  it("clamps a track to the provider's 15-day maximum", () => {
    assert.equal(creditCost("track", 99), MAX_TRACK_DAYS);
    assert.equal(creditCost("track", 0), 1);
  });
  it("keeps a spend ceiling by default", () => {
    assert.ok(DEFAULT_LIVE_AIS_CAP > 0);
  });
});

describe("config", () => {
  it("builds urls under the documented base", () => {
    assert.equal(liveAisUrl("vessel/311050900/track/3"), "https://api.live-ais.com/api/v1/vessel/311050900/track/3");
    assert.equal(liveAisUrl("/usage/monthly"), "https://api.live-ais.com/api/v1/usage/monthly");
  });
  it("clamps LIVEAIS_TRACK_DAYS to the provider maximum", () => {
    const prev = process.env["LIVEAIS_TRACK_DAYS"];
    process.env["LIVEAIS_TRACK_DAYS"] = "40";
    assert.equal(trackDays(), MAX_TRACK_DAYS);
    process.env["LIVEAIS_TRACK_DAYS"] = "2";
    assert.equal(trackDays(), 2);
    if (prev === undefined) delete process.env["LIVEAIS_TRACK_DAYS"]; else process.env["LIVEAIS_TRACK_DAYS"] = prev;
  });
});

describe("parsePorts (5 credits)", () => {
  it("decodes the documented schedule shape and normalises the locode", () => {
    const ports = parsePorts({ ports_count: 1, ports: [{ port: "Singapore", locode: "SG SIN", start_date: "2026-06-17T23:00:00Z", end_date: "2026-06-19T05:00:00Z" }] });
    assert.equal(ports.length, 1);
    assert.equal(ports[0]!.locode, "SGSIN");
    assert.equal(ports[0]!.start, "2026-06-17T23:00:00.000Z");
  });
  it("returns nothing for a vessel with no schedule", () => {
    assert.deepEqual(parsePorts({ ports_count: 0, ports: [] }), []);
  });
});

// GET /vessels/bbox over the Bahamas, 2026-09-21 — verbatim rows, including the
// "SAT PING" pseudo-vessel that sat 30 m from Star of the Seas.
const BBOX = {
  results: [
    { mmsi: "satping_76077bb6", name: "SAT PING", type: "6", lat: 25.825001, lon: -77.936668, sog: 0.0, cog: 0.0, heading: 0, destination: null },
    { mmsi: "311001551", name: "STAR OF THE SEAS", type: "6", lat: 25.824862, lon: -77.936172, sog: 0.2, cog: 126.0, heading: 22, destination: "US PCV>>>BS COC", flag: "BS", sanctions: "CLEAR" },
    { mmsi: "369023000", name: "GRANDE CARIBE", type: "6", lat: 25.82509, lon: -77.911453, sog: 0.1, cog: 0.0, heading: 511, destination: null },
    { mmsi: "304880000", name: "GRAND EXPRESS", type: "7", lat: 25.841431, lon: -78.164284, sog: 9.8, cog: 90.0, heading: 88, destination: null },
    { mmsi: "0", name: "BAD ROW", type: "6", lat: 0, lon: 0, sog: 0, cog: 0, heading: 0, destination: null },
  ],
  summary: { credits_used: 5, limit: 20, page: 1, returned: 18, total_matched: 18 },
};

describe("parseBbox — the call that closes the island blind spot", () => {
  const vs = parseBbox(BBOX);
  it("drops the SAT PING pseudo-vessel and the 0/0 row", () => {
    assert.equal(vs.length, 3);
    assert.equal(vs.some((v) => v.mmsi.startsWith("satping")), false,
      "an unresolved satellite detection is not a vessel and must never reach registry matching");
    assert.equal(vs.some((v) => v.mmsi === "0"), false);
  });
  it("reads clean numeric position, unlike the per-vessel endpoint's strings", () => {
    const star = vs.find((v) => v.mmsi === "311001551")!;
    assert.equal(star.fix.lat, 25.824862);
    assert.equal(star.fix.speedKn, 0.2);
    assert.equal(star.fix.courseDeg, 126);
    assert.equal(star.fix.destination, "US PCV>>>BS COC", "crew-typed route decodes through our LOCODE table");
  });
  it("treats heading 511 as unknown", () => {
    assert.equal(vs.find((v) => v.mmsi === "369023000")!.fix.headingDeg, null);
  });
  it("never claims satellite for a box (it carries no lineage)", () => {
    assert.ok(vs.every((v) => v.fix.source === "unknown"));
  });
  it("leaves `at` for the caller — a box has no per-vessel timestamp", () => {
    assert.ok(vs.every((v) => v.fix.at === ""));
  });
});

describe("isPassengerType", () => {
  it("accepts AIS 6x and rejects cargo/tanker", () => {
    assert.equal(isPassengerType("6"), true);
    assert.equal(isPassengerType("69"), true);
    assert.equal(isPassengerType("7"), false);
    assert.equal(isPassengerType("8"), false);
  });
});

describe("bbox cost", () => {
  it("prices 5 credits per 50 returned", () => {
    assert.equal(creditCost("bbox", 20), 5);
    assert.equal(creditCost("bbox", 50), 5);
    assert.equal(creditCost("bbox", 51), 10);
  });
  it("reads what the provider actually charged, so an empty box settles to zero", () => {
    assert.equal(bboxCreditsCharged(BBOX), 5);
    assert.equal(bboxCreditsCharged({ summary: { credits_used: 0, returned: 0 } }), 0);
    assert.equal(bboxCreditsCharged({}), null);
  });
});

describe("boxAround", () => {
  it("covers the points with padding for drift", () => {
    const b = boxAround([{ lat: 25.0, lon: -77.0 }, { lat: 26.0, lon: -78.0 }], 0.5)!;
    assert.equal(b.minLat, 24.5);
    assert.equal(b.maxLat, 26.5);
    assert.equal(b.minLon, -78.5);
    assert.equal(b.maxLon, -76.5);
  });
  it("clamps at the poles and the antimeridian", () => {
    const b = boxAround([{ lat: 89.8, lon: 179.8 }], 0.5)!;
    assert.equal(b.maxLat, 90);
    assert.equal(b.maxLon, 180);
  });
  it("returns null for no points", () => {
    assert.equal(boxAround([]), null);
  });
});

const creditStatusUsed = (s: ReturnType<typeof blankCreditState>): number => s.bankedUsed + s.lastMonthUsed;

describe("credit balance — there is no balance endpoint, so it is computed", () => {
  const withPurchased = (n: string | undefined, fn: () => void) => {
    const prev = process.env["LIVEAIS_CREDITS_PURCHASED"];
    if (n === undefined) delete process.env["LIVEAIS_CREDITS_PURCHASED"]; else process.env["LIVEAIS_CREDITS_PURCHASED"] = n;
    try { fn(); } finally {
      if (prev === undefined) delete process.env["LIVEAIS_CREDITS_PURCHASED"]; else process.env["LIVEAIS_CREDITS_PURCHASED"] = prev;
    }
  };

  it("banks a closed month instead of forgiving it when the month rolls over", () => {
    let s = blankCreditState();
    s = foldMonthlyUsage(s, "2026-09", 13);
    assert.equal(creditStatusUsed(s), 13);
    s = foldMonthlyUsage(s, "2026-09", 400);          // same month, latest figure wins
    assert.equal(creditStatusUsed(s), 400);
    s = foldMonthlyUsage(s, "2026-10", 25);           // rollover: September is banked
    assert.equal(s.bankedUsed, 400);
    assert.equal(creditStatusUsed(s), 425, "a new month must not forgive the last one");
  });

  it("ignores an out-of-order report", () => {
    let s = foldMonthlyUsage(blankCreditState(), "2026-10", 25);
    s = foldMonthlyUsage(s, "2026-09", 999);
    assert.equal(creditStatusUsed(s), 25);
  });

  it("reports remaining against what was purchased", () => {
    withPurchased("2500", () => {
      const s = foldMonthlyUsage(blankCreditState(), "2026-09", 13);
      const st = creditStatus(s);
      assert.equal(st.purchased, 2500);
      assert.equal(st.remaining, 2487);
      assert.equal(st.low, false);
    });
  });

  it("goes low under the threshold", () => {
    withPurchased("2500", () => {
      const s = foldMonthlyUsage(blankCreditState(), "2026-09", 2460);
      const st = creditStatus(s);
      assert.equal(st.remaining, 40);
      assert.equal(st.threshold, DEFAULT_LOW_CREDIT_THRESHOLD);
      assert.equal(st.low, true);
    });
  });

  it("cannot report a balance when the purchase is unset — and never guesses one", () => {
    withPurchased(undefined, () => {
      const st = creditStatus(foldMonthlyUsage(blankCreditState(), "2026-09", 13));
      assert.equal(st.remaining, null);
      assert.equal(st.low, false, "unknown must not raise a false alarm");
    });
  });
});

describe("creditAlarm — one alert per crossing, not one per tick", () => {
  const st = (remaining: number | null): ReturnType<typeof creditStatus> =>
    ({ purchased: 2500, used: 0, remaining, threshold: 50, low: remaining !== null && remaining < 50 });

  it("fires the first time the balance crosses the line", () => {
    const a = creditAlarm(st(40), null);
    assert.equal(a.alert, true);
    assert.equal(a.warnAt, 40);
  });
  it("stays quiet on every tick after that", () => {
    assert.equal(creditAlarm(st(38), 40).alert, false);
    assert.equal(creditAlarm(st(12), 40).alert, false);
  });
  it("speaks again only after another threshold's worth is gone", () => {
    const a = creditAlarm(st(-11), 40);
    assert.equal(a.alert, true, "40 → -11 is more than another 50 credits");
    assert.equal(a.warnAt, -11);
  });
  it("clears the latch when a top-up lifts it back over the line", () => {
    const a = creditAlarm(st(2500), 40);
    assert.equal(a.alert, false);
    assert.equal(a.clear, true);
    assert.equal(a.warnAt, null, "so the next crossing alerts again");
  });
  it("never alarms on an unknown balance", () => {
    assert.equal(creditAlarm(st(null), null).alert, false);
  });
});

describe("distanceKm", () => {
  it("matches the measured Getaway/Great Stirrup approach", () => {
    assert.ok(distanceKm(25.8250, -77.9060, 25.8244, -77.9120) < 1);
  });
});
