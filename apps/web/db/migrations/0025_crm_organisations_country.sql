-- 0025_crm_organisations_country.sql
--
-- Derived `country` for `crm_organisations`, so the browse surface can
-- filter by market without every page load re-parsing free text.
--
-- WHY DERIVED, NOT AUTHORITATIVE. `location` is what the scrape actually
-- saw — `Australia` (a country), `Chennai`/`Delhi` (cities), `Kerala` (a
-- state), `Mumbai, Maharashtra` (both) — and mixes granularities that get
-- worse with every product's leads added. Filtering that text directly
-- gives a long tail of near-duplicates that only grows. `country` is a
-- best-effort read of `location` at a single granularity (ISO 3166-1
-- alpha-2), computed once and indexed, rather than re-derived on every
-- query. It is NEVER used to overwrite `location`: the raw string stays
-- the only record of what the scrape actually returned, and the only way
-- to re-derive `country` if the mapping is later found wrong. An
-- unrecognised `location` leaves `country` NULL rather than guessing — a
-- wrong country silently files a lead under a market it is not in, which
-- is worse than an organisation the filter doesn't (yet) catch.
--
-- The mapping itself lives in one place only — the `@tesserix/crm-country`
-- workspace package (packages/crm-country/index.mjs; plain JS so a bare
-- Node script can import it without a build step). Not here: this migration
-- adds the column and its index and nothing else. Backfilling in SQL would
-- be a second copy of the same lookup table, and divergence between two
-- copies is exactly what this codebase has been bitten by before. Existing
-- rows are populated by scripts/backfill-crm-country.mjs, which imports that
-- package; apps/console/lib/db/crm-country.ts is only a re-export shell over
-- it, so extend the package, never the shell.
ALTER TABLE crm_organisations
  ADD COLUMN IF NOT EXISTS country text;

-- Partial: most rows have no location to derive a country from (208 of 259
-- today), and the only query filtering on this asks for a specific country.
CREATE INDEX IF NOT EXISTS crm_org_country_idx
  ON crm_organisations (country)
  WHERE country IS NOT NULL;
