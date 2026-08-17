/**
 * Thin re-export of the single canonical `location` -> country mapper.
 *
 * The implementation lives in `@tesserix/crm-country` (plain JS + JSDoc,
 * `packages/crm-country/index.mjs`), not here, because it also has to be
 * imported by `apps/web/scripts/backfill-crm-country.mjs` — a bare Node
 * script with no build step. Importing it there by package name (through
 * the pnpm workspace) rather than a relative path avoids a fragile reach
 * across an app boundary into this app's internals, and avoids depending on
 * Node's type-stripping to read a `.ts` file. See that package for the full
 * rationale, the mapping table, and why `planBackfill` lives there too
 * rather than being duplicated for this app's tests.
 */
export {
  countryFromLocation,
  COUNTRY_LABELS,
  COUNTRY_BY_LOCATION,
  planBackfill,
} from "@tesserix/crm-country";
