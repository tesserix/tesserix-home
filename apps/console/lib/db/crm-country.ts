/**
 * Derives a country (ISO 3166-1 alpha-2) from `crm_organisations.location`,
 * the free text a scrape produced. The scrape mixes granularities —
 * `Australia` is a country, `Chennai`/`Delhi` are cities, `Kerala` is a
 * state, `Mumbai, Maharashtra` is both — so this is an explicit lookup
 * table, not a parser: a library capable of geocoding all of that would be
 * absurd overhead for an estate with one country of operation and a
 * scattered international tail.
 *
 * This is the ONLY place the mapping lives. It has to serve the backfill
 * script, the CSV import path and manual create identically — a second copy
 * in SQL (or anywhere else) is exactly the kind of divergence this codebase
 * has been bitten by before, so don't add one.
 *
 * Unmapped values return `null` rather than a best guess. A wrong country
 * silently files a lead under a market it is not in and the operator has no
 * way to notice; `null` is at least visibly "not filtered", which is safe.
 * Unmapped values are expected — they are surfaced (by the backfill
 * script's distinct-unmapped-values report), not hidden or guessed away.
 */

/** Display names for the codes this module can return. Renaming a label is
 *  a code change here, not a data migration — the stored value is the code,
 *  never the label. */
export const COUNTRY_LABELS: Readonly<Record<string, string>> = {
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
const COUNTRY_BY_LOCATION: Readonly<Record<string, string>> = {
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

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/** Best-effort country for a raw scraped location. Null when unknown. */
export function countryFromLocation(location: string | null): string | null {
  if (!location) return null;

  const normalised = normalise(location);
  if (normalised === "") return null;

  const whole = COUNTRY_BY_LOCATION[normalised];
  if (whole) return whole;

  // "City, State" style values: try the segment after the last comma (the
  // state) when the whole string isn't a recognised key.
  const lastCommaIndex = normalised.lastIndexOf(",");
  if (lastCommaIndex === -1) return null;

  const afterLastComma = normalise(normalised.slice(lastCommaIndex + 1));
  return COUNTRY_BY_LOCATION[afterLastComma] ?? null;
}
