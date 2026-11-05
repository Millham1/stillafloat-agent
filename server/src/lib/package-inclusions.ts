// What a paid package includes (Mark 2026-11-05): a confirmation prints only the package's name and price, so the intake
// looks the name up in our own table (public.package_inclusions, migration 0066) and lists what the guest gets.
import type { BookingExtraction } from "./booking-extract";

export interface PackageRow {
  cruise_line: string;
  ship: string | null;
  package_name: string;
  inclusions: string[];
  checked_on: string;
  source_url: string;
}

const norm = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The table's row for this add-on on this booking: same line, same package name, and the booking's ship when the row names one. */
export function packageFor(rows: PackageRow[], cruiseLine: string | null, shipName: string | null, addonName: string): PackageRow | null {
  const line = norm(cruiseLine), ship = norm(shipName), name = norm(addonName);
  if (!name) return null;
  const hits = rows.filter((r) => norm(r.package_name) === name
    && (!line || line.includes(norm(r.cruise_line)) || norm(r.cruise_line).includes(line))
    && (!r.ship || ship.includes(norm(r.ship))));
  // a row for the ship goes before the line-wide one
  return hits.find((r) => r.ship) ?? hits[0] ?? null;
}

/**
 * Each paid add-on found in the table carries what it includes, and those lines join the guest's inclusions
 * (the document's own come first; nothing is listed twice).
 */
export function applyPackageInclusions(x: BookingExtraction, rows: PackageRow[]): BookingExtraction {
  if (!x.addons?.length || !rows.length) return x;
  const inclusions = [...(x.guest_inclusions ?? [])];
  const seen = new Set(inclusions.map(norm));
  const addons = x.addons.map((a) => {
    const row = packageFor(rows, x.cruise_line, x.ship_name, a.name);
    if (!row) return a;
    for (const inc of row.inclusions) if (!seen.has(norm(inc))) { seen.add(norm(inc)); inclusions.push(inc); }
    return { ...a, includes: row.inclusions, includes_checked_on: row.checked_on, includes_source: row.source_url };
  });
  return { ...x, addons, guest_inclusions: inclusions };
}
