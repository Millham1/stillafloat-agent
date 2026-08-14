// news-archive-search.test.ts — the archive browser's text + date filtering.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  queryTerms,
  matchesQuery,
  inRange,
  parseFrom,
  parseTo,
} from "./news-archive-search";

const STORY = {
  id: "carnival-norovirus-outbreak",
  title: "Norovirus Outbreak Hits Carnival Ship",
  title_es: "Brote de norovirus golpea un barco de Carnival",
  summary: "Hundreds of passengers fell ill during the sailing.",
  summary_es: "Cientos de pasajeros se enfermaron durante la travesía.",
  travelerImpact: "Wash your hands and watch cruise line advisories.",
  reasoning: "High reader interest.",
  category: "Health & Safety",
  sources: ["Cruise Hive"],
  approvedAt: "2026-07-01T12:00:00.000Z",
};

test("empty query matches everything", () => {
  assert.equal(matchesQuery(STORY, queryTerms("")), true);
  assert.equal(matchesQuery(STORY, queryTerms("   ")), true);
});

test("case-insensitive match across title/summary", () => {
  assert.equal(matchesQuery(STORY, queryTerms("NOROVIRUS carnival")), true);
  assert.equal(matchesQuery(STORY, queryTerms("norovirus royal")), false); // AND semantics
});

test("Spanish fields are searchable", () => {
  assert.equal(matchesQuery(STORY, queryTerms("pasajeros")), true);
  assert.equal(matchesQuery(STORY, queryTerms("travesía")), true);
});

test("source names are searchable", () => {
  assert.equal(matchesQuery(STORY, queryTerms("cruise hive")), true);
});

test("date range filters on approvedAt, inclusive of the 'to' day", () => {
  const from = parseFrom("2026-07-01");
  const to = parseTo("2026-07-01"); // whole day inclusive
  assert.equal(inRange(STORY, from, to), true);
  assert.equal(inRange(STORY, parseFrom("2026-07-02"), null), false);
  assert.equal(inRange(STORY, null, parseTo("2026-06-30")), false);
});

test("open range always matches; bounded range rejects dateless stories", () => {
  const dateless = { ...STORY, approvedAt: undefined };
  assert.equal(inRange(dateless, null, null), true);
  assert.equal(inRange(dateless, parseFrom("2026-01-01"), null), false);
});

test("bad date inputs parse to null (treated as unbounded)", () => {
  assert.equal(parseFrom("not-a-date"), null);
  assert.equal(parseTo("not-a-date"), null);
});
