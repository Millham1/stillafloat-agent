// group-journey.fixture.ts — a synthetic group file for the journey's tests and for the dashboard's dry runs of the
// rules. Not real people: every name, address, number and ship fact here is invented for the tests.

import type { Extras, JourneyInput, Row, ScanVideo } from "./group-journey-facts";

export const SAIL = "2027-03-06";
export const RETURN = "2027-03-13";

export function fixtureInput(over: { group?: Row; extraMessages?: Row[]; noEmailFor?: string[] } = {}): JourneyInput {
  const group: Row = {
    id: "g1", name: "Post 116 Cruise", slug: "post-116", status: "booking", organizer_name: "Pat Organizer", organizer_email: "pat@example.test",
    cruise_line: "MSC Cruises", ship_name: "MSC SEASIDE", ship_slug: "msc-seaside", sail_date: SAIL, return_date: RETURN, nights: 7,
    embark_port: "MIA", deposit_due: "2026-11-01", names_due: "2026-12-15", final_payment_due: "2027-01-05", lang: "both", fees: {}, journey: {},
    itinerary: [
      { day: 1, date: "2027-03-06", port: "Miami, Florida", arrive: null, depart: "16:30" },
      { day: 2, date: "2027-03-07", port: "At Sea", arrive: null, depart: null },
      { day: 3, date: "2027-03-08", port: "Nassau, Bahamas", arrive: "08:00", depart: "17:00" },
      { day: 4, date: "2027-03-09", port: "Cozumel, Mexico", arrive: "09:00", depart: "18:00" },
      { day: 5, date: "2027-03-10", port: "At Sea", arrive: null, depart: null },
      { day: 6, date: "2027-03-11", port: "Ocean Cay", arrive: "09:00", depart: "17:00" },
      { day: 7, date: "2027-03-12", port: "At Sea", arrive: null, depart: null },
      { day: 8, date: "2027-03-13", port: "Miami, Florida", arrive: "07:00", depart: null },
    ],
    terms: {
      deadlines: [
        { date: "2026-12-20", days_before: 76, text: "Specialty dining reservations and special event requests must be made by this date." },
        { date: "2027-01-20", days_before: 45, text: "Name changes carry a fee after this date." },
        { date: "2027-02-14", days_before: 20, text: "Web check-in opens 20 days prior to sailing." },
        { date: "2027-03-04", days_before: 2, text: "Web check-in closes 48 hours prior to sailing; passengers who have not checked in may be refused boarding." },
      ],
    },
  };
  const cabins: Row[] = [
    { id: "c1", group_id: "g1", cabin_num: "8123", deck: "8", category: "Balcony", category_code: "BA2", status: "booked", booking_number: "7781234", price_total: 3200, deposit_amount: 400, insurance: "offered", dining: "Late seating", bed_config: "Two twin beds" },
    { id: "c2", group_id: "g1", cabin_num: "9201", deck: "9", category: "Ocean View", category_code: "OV1", status: "booked", booking_number: "7781235", price_total: 2600, deposit_amount: 400, insurance: "accepted", dining: null, bed_config: null },
    { id: "c3", group_id: "g1", cabin_num: null, deck: null, category: "Inside", status: "held", booking_number: null, price_total: 2000, deposit_amount: 400, insurance: "not-offered" },
  ];
  const noEmail = new Set(over.noEmailFor ?? []);
  const t = (id: string, cabin: string | null, first: string, last: string, extra: Row = {}): Row => ({
    id, group_id: "g1", cabin_id: cabin, first_name: first, last_name: last, is_lead: false, lang: "en",
    email: noEmail.has(id) ? null : `${first.toLowerCase()}@example.test`, emergency_name: null, emergency_phone: null,
    passport_expiry: null, form_data: {}, ...extra,
  });
  const travelers: Row[] = [
    t("t1", "c1", "Ann", "Alpha", { is_lead: true, passport_expiry: "2027-06-01", emergency_name: "Sam Alpha", emergency_phone: "919-555-0100" }),
    t("t2", "c1", "Bob", "Alpha"),
    t("t3", "c2", "Carlos", "Cruz", { is_lead: true, lang: "es" }),
    t("t4", "c2", "Dulce", "Cruz", { lang: "es" }),
    t("t5", "c3", "Eve", "Echo"),
  ];
  const payments: Row[] = [
    { id: "p1", group_id: "g1", cabin_id: "c1", kind: "deposit", amount: 400, due_date: "2026-11-01", paid_at: "2026-10-20T14:00:00Z", notes: "internal: Legion chair pays late" },
    { id: "p2", group_id: "g1", cabin_id: "c1", kind: "final", amount: 2800, due_date: "2027-01-05", paid_at: null, notes: "Internal note.\nClient: Pay the cruise line directly with the booking number; Mark can take you through it by phone." },
    { id: "p3", group_id: "g1", cabin_id: "c2", kind: "deposit", amount: 400, due_date: "2026-11-01", paid_at: "2026-10-21T14:00:00Z" },
    { id: "p4", group_id: "g1", cabin_id: "c2", kind: "final", amount: 2200, due_date: "2027-01-05", paid_at: null },
  ];
  const travel: Row[] = [
    { id: "r1", group_id: "g1", cabin_id: null, traveler_id: "t1", kind: "flight", direction: "pre", provider: "American", reference: "AA 1234", from_place: "RDU", to_place: "MIA", starts_at: "2027-03-05T15:00:00Z", confirmation: "ABC123" },
    { id: "r2", group_id: "g1", cabin_id: "c1", traveler_id: null, kind: "hotel", direction: "pre", provider: "Hotel Example Miami", reference: null, starts_at: "2027-03-05T20:00:00Z", ends_at: "2027-03-06T15:00:00Z", confirmation: "HX99" },
    { id: "r9", group_id: "g1", cabin_id: null, traveler_id: null, kind: "hotel", direction: "pre", provider: "Group offer hotel", price_per_person: 120 },
  ];
  const checklist: Row[] = [
    { id: "k1", group_id: "g1", cabin_id: null, audience: "client", kind: "task", title: "Book your flights", detail: "Fly in the day before.", link_url: null, due_date: "2026-12-15", done_at: null, sort: 1 },
    { id: "k2", group_id: "g1", cabin_id: null, audience: "client", kind: "task", title: "Check your passport", detail: null, link_url: null, due_date: null, done_at: null, sort: 2 },
    { id: "k3", group_id: "g1", cabin_id: null, audience: "client", kind: "product", title: "Power strip without surge protection", detail: "Ships ban the surge kind.", link_url: "https://example.test/strip", due_date: null, done_at: null, sort: 3 },
    { id: "k4", group_id: "g1", cabin_id: null, audience: "client", kind: "excursion", title: "Nassau: Junkanoo walking tour", detail: "Two hours.", link_url: "https://example.test/nassau", due_date: null, done_at: null, sort: 4 },
    { id: "k5", group_id: "g1", cabin_id: null, audience: "client", kind: "task", title: "Print your boarding passes", detail: null, link_url: null, due_date: "2027-02-20", done_at: null, sort: 5 },
    { id: "k6", group_id: "g1", cabin_id: null, audience: "mark", kind: "task", title: "Chase the line for the rooming list", detail: "internal", link_url: null, due_date: "2026-12-01", done_at: null, sort: 6 },
  ];
  const signatures: Row[] = [
    { traveler_id: "t1", doc_key: "15-emergency-contact-form", signer_role: "traveler", signed_at: "2026-10-25T12:00:00Z" },
    { traveler_id: "t1", doc_key: "01-terms-and-conditions", signer_role: "traveler", signed_at: "2026-10-25T12:05:00Z" },
  ];
  return { group: { ...group, ...(over.group ?? {}) }, cabins, travelers, payments, travel, checklist, signatures, messages: over.extraMessages ?? [] };
}

export const VIDEOS: ScanVideo[] = [
  { id: "AAAAAAAAAA1", title: "Cruise Travel Insurance: Is It Worth It?", views: 900, published: "2026-09-01T00:00:00Z" },
  { id: "AAAAAAAAAA2", title: "Your First Cruise: Embarkation Day Step by Step", views: 5000, published: "2026-08-01T00:00:00Z" },
  { id: "AAAAAAAAAA3", title: "What to Pack for a Cruise (and What to Leave Home)", views: 4000, published: "2026-07-01T00:00:00Z" },
  { id: "AAAAAAAAAA4", title: "Cruise Cabin Types Explained: Inside, Ocean View, Balcony", views: 3000, published: "2026-06-01T00:00:00Z" },
  { id: "BBBBBBBBBB1", title: "Seguro de viaje para cruceros: ¿vale la pena?", views: 100, published: "2026-09-10T00:00:00Z" },
  { id: "BBBBBBBBBB2", title: "Día de embarque: qué esperar en su primer crucero", views: 200, published: "2026-08-10T00:00:00Z" },
  { id: "CCCCCCCCCC1", title: "Ten Ways to Spend a Sea Day #shorts", views: 90000, isShort: true, published: "2026-05-01T00:00:00Z" },
];

export const RATING: Row = {
  ship_slug: "msc-seaside", rating: 4.2, status: "published", comment_status: "approved",
  comment: "Cruisers like the layout and the promenade.", comment_es: "A los cruceristas les gusta la distribución y el paseo.",
  salty_mark_take: "The buffet queue has its own weather system.", salty_mark_take_es: "La fila del buffet tiene su propio clima.",
};

export function fullExtras(over: Partial<Extras> = {}, shiftDays = 0): Extras {
  const day = (iso: string, high: number, low: number, code: number) => ({ day: iso, high, low, code });
  return {
    rating: RATING,
    shipInfo: { class: "Seaside", slug: "msc-seaside" },
    storm: null,
    videos: VIDEOS,
    notices: [],
    weather: {
      shiftDays, sample: shiftDays !== 0,
      places: {
        miami: [day("2027-03-06", 82, 70, 1), day("2027-03-10", 80, 68, 3), day("2027-03-11", 85, 72, 2)],
        nassau: [day("2027-03-08", 80, 71, 80)],
        cozumel: [day("2027-03-09", 84, 52, 0)],
      },
    },
    ...over,
  };
}
