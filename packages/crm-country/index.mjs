/**
 * Derives a country (ISO 3166-1 alpha-2) from `crm_organisations.location`,
 * the free text a scrape produced. The scrape mixes granularities —
 * `Australia` is a country, `Chennai`/`Delhi` are cities, `Kerala` is a
 * state, `Mumbai, Maharashtra` is both — so this is an explicit lookup
 * table, not a parser: a library capable of geocoding all of that would be
 * absurd overhead for an estate with one country of operation and a
 * scattered international tail.
 *
 * THE ONLY PLACE THIS MAPPING LIVES. It has to serve the backfill script
 * (apps/web/scripts/backfill-crm-country.mjs, a bare Node script with no
 * build step), the CSV import path and manual create (apps/console,
 * TypeScript/Next.js) identically — a second copy anywhere, including a SQL
 * backfill, is exactly the kind of divergence this codebase has been
 * bitten by before.
 *
 * WHY THIS IS PLAIN JS + JSDOC, NOT TYPESCRIPT. Both consumers need to
 * import the exact same module by package name (`@tesserix/crm-country`,
 * resolved through the pnpm workspace), never by a relative path that
 * reaches across an app boundary into another app's internal `lib/` — that
 * reach is fragile on its own (a file gets moved, the path silently 404s
 * with no test to catch it) and nothing in CI runs the backfill script to
 * notice. A `.ts` source here would additionally force the bare script to
 * depend on Node's automatic type-stripping, which is unflagged only from
 * Node >=22.18 — a CI runner or a laptop pinned to an older 22.x, or a
 * downgrade, breaks the import silently. Plain JS needs neither a relative
 * reach nor type-stripping nor a build step (contrast the other
 * `packages/*` here that go through tsup — this one, like
 * `@tesserix/eslint-config`, is consumed as-is). TypeScript still gets full
 * types on the console side via the JSDoc annotations below; nothing here
 * requires a hand-authored `.d.ts`.
 *
 * Unmapped values return `null` rather than a best guess. A wrong country
 * silently files a lead under a market it is not in and the operator has no
 * way to notice; `null` is at least visibly "not filtered", which is safe.
 * Unmapped values are expected — they are surfaced (by the backfill
 * script's distinct-unmapped-values report), not hidden or guessed away.
 */

/** Display names for the codes this module can return. Renaming a label is
 *  a code change here, not a data migration — the stored value is the code,
 *  never the label.
 *  @type {Readonly<Record<string, string>>} */
export const COUNTRY_LABELS = {
  AU: "Australia",
  IN: "India",
};

// Keys are lowercased location fragments (a whole `location` value, or the
// segment after its last comma). Values are ISO 3166-1 alpha-2 codes.
//
// Covers every value seen in production today (Australia, Chennai, Mumbai,
// Maharashtra, Kerala, Delhi) plus the obvious remaining Indian metros and
// states, since India is clearly the dominant market beyond the single
// country-level value. Extend this table — never guess in the function
// below — when the backfill script reports a new unmapped value.
//
// Exported (not module-private) so tests can assert `COUNTRY_LABELS` covers
// every code this table can actually produce, rather than hand-listing
// codes that silently drift out of sync with the table.
/** @type {Readonly<Record<string, string>>} */
export const COUNTRY_BY_LOCATION = {
  // Countries
  australia: "AU",
  india: "IN",

  // Indian metros / cities
  chennai: "IN",
  delhi: "IN",
  "new delhi": "IN",
  mumbai: "IN",
  bangalore: "IN",
  bengaluru: "IN",
  hyderabad: "IN",
  pune: "IN",
  kolkata: "IN",
  ahmedabad: "IN",
  surat: "IN",
  jaipur: "IN",
  lucknow: "IN",
  kanpur: "IN",
  nagpur: "IN",
  indore: "IN",
  thane: "IN",
  bhopal: "IN",
  visakhapatnam: "IN",
  patna: "IN",
  vadodara: "IN",
  ghaziabad: "IN",
  ludhiana: "IN",
  coimbatore: "IN",
  kochi: "IN",
  cochin: "IN",
  chandigarh: "IN",
  gurgaon: "IN",
  gurugram: "IN",
  noida: "IN",

  // Indian states
  maharashtra: "IN",
  kerala: "IN",
  karnataka: "IN",
  "tamil nadu": "IN",
  telangana: "IN",
  "andhra pradesh": "IN",
  gujarat: "IN",
  rajasthan: "IN",
  "uttar pradesh": "IN",
  "west bengal": "IN",
  punjab: "IN",
  haryana: "IN",
  bihar: "IN",
  "madhya pradesh": "IN",
  odisha: "IN",
  assam: "IN",
  goa: "IN",
};

/**
 * @param {string} value
 * @returns {string}
 */
function normalise(value) {
  return value.trim().toLowerCase();
}

/**
 * Best-effort country for a raw scraped location. Null when unknown.
 * @param {string | null} location
 * @returns {string | null}
 */
export function countryFromLocation(location) {
  if (!location) return null;

  const normalised = normalise(location);
  if (normalised === "") return null;

  const whole = COUNTRY_BY_LOCATION[normalised];
  if (whole) return whole;

  // "City, State" style values: try the segment after the last comma (the
  // state) when the whole string isn't a recognised key. This is an EXACT
  // match against that segment, never a substring/`.includes()` check — a
  // location like "Delhi Road, Ohio" must stay unmapped rather than
  // matching on "delhi" appearing inside "delhi road". See
  // crm-country.test.ts for the regression test.
  const lastCommaIndex = normalised.lastIndexOf(",");
  if (lastCommaIndex === -1) return null;

  const afterLastComma = normalise(normalised.slice(lastCommaIndex + 1));
  return COUNTRY_BY_LOCATION[afterLastComma] ?? null;
}

/**
 * @typedef {{ id: number | string, location: string | null }} OrganisationRow
 * @typedef {{ id: number | string, country: string }} MappedRow
 */

/**
 * Pure planning step for the backfill: splits rows into what can be mapped
 * and what can't, without touching a database.
 *
 * `unmappedRowCount` and `unmappedLocations` are DELIBERATELY different
 * shapes: `unmappedRowCount` counts every row whose `location` was present
 * but didn't map (for totals that must sum to `rows.length`);
 * `unmappedLocations` is the DISTINCT set of those location strings, sorted
 * (for a report an operator can read without seeing the same value 40
 * times). Two organisations can share one unrecognised location, so the
 * two numbers are not interchangeable — conflating them is exactly the bug
 * this split exists to prevent.
 *
 * @param {OrganisationRow[]} rows
 * @returns {{ mapped: MappedRow[], unmappedRowCount: number, unmappedLocations: string[] }}
 */
export function planBackfill(rows) {
  const mapped = [];
  const unmappedLocationSet = new Set();
  let unmappedRowCount = 0;

  for (const row of rows) {
    const country = countryFromLocation(row.location);
    if (country) {
      mapped.push({ id: row.id, country });
    } else if (row.location) {
      // A NULL location isn't a mapping gap — there was nothing to map.
      // Only a present-but-unrecognised location is worth an operator's
      // attention.
      unmappedRowCount += 1;
      unmappedLocationSet.add(row.location);
    }
  }

  return {
    mapped,
    unmappedRowCount,
    unmappedLocations: [...unmappedLocationSet].sort(),
  };
}
