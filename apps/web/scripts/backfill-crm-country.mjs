#!/usr/bin/env node
// backfill-crm-country.mjs — one-shot backfill of `crm_organisations.country`
// from the existing `location` free text (migration 0025).
//
// The mapping itself is NOT reimplemented here. It lives in exactly one
// place — apps/console/lib/db/crm-country.ts — and this script imports it
// directly rather than duplicating the lookup table in SQL or in this
// file. That's deliberate: the import path and manual create both need the
// same mapping, and a second copy anywhere is exactly the kind of
// divergence this codebase has been bitten by before.
//
// `country` is DERIVED, never authoritative: `location` is never read from
// here to overwrite anything, and this script never writes `location`.
// Rows whose location doesn't map return `country = NULL` — never a guess.
// A wrong country silently files a lead under a market it is not in, and
// the operator has no way to notice; NULL is at least visibly unfiltered.
//
// Usage:
//   TESSERIX_DB_HOST=... TESSERIX_DB_USER=... TESSERIX_DB_PASSWORD=... \
//     node scripts/backfill-crm-country.mjs [--commit]
//
// Dry-run by default (reads only, prints what *would* be written).
// Pass --commit to actually write.

import process from "node:process";
import pg from "pg";
import { countryFromLocation } from "../../console/lib/db/crm-country.ts";

function parseArgs() {
  const args = process.argv.slice(2);
  return { commit: args.includes("--commit") };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: ${name} env var is required`);
    process.exit(1);
  }
  return v;
}

function makeClient() {
  return new pg.Client({
    host: requireEnv("TESSERIX_DB_HOST"),
    port: process.env.TESSERIX_DB_PORT
      ? Number.parseInt(process.env.TESSERIX_DB_PORT, 10)
      : 5432,
    user: requireEnv("TESSERIX_DB_USER"),
    password: requireEnv("TESSERIX_DB_PASSWORD"),
    database: process.env.TESSERIX_DB_NAME ?? "tesserix_admin",
    ssl:
      process.env.TESSERIX_DB_SSL === "false"
        ? false
        : { rejectUnauthorized: false },
    statement_timeout: 60_000,
  });
}

/**
 * Pure: rows -> { mapped, unmapped }. `mapped` carries only what's needed
 * to write (`id`, `country`); `unmapped` carries the raw `location` values
 * so the caller can name them, distinct, on exit.
 */
export function planBackfill(rows) {
  const mapped = [];
  const unmappedLocations = new Set();

  for (const row of rows) {
    const country = countryFromLocation(row.location);
    if (country) {
      mapped.push({ id: row.id, country });
    } else if (row.location) {
      // A NULL location isn't a mapping gap — there was nothing to map.
      // Only a present-but-unrecognised location is worth an operator's
      // attention.
      unmappedLocations.add(row.location);
    }
  }

  return { mapped, unmappedLocations: [...unmappedLocations].sort() };
}

/** Names every distinct unmapped location on exit, so an operator extends
 *  `COUNTRY_BY_LOCATION` in crm-country.ts rather than discovering the gap
 *  later through a country filter that silently returns nothing. */
function reportUnmapped(unmappedLocations) {
  console.error(
    `[backfill] ${unmappedLocations.length} distinct location value(s) did ` +
      `not map to a country and were left NULL:`,
  );
  for (const location of unmappedLocations) {
    console.error(`[backfill]   ${JSON.stringify(location)}`);
  }
  console.error(
    `[backfill] Extend COUNTRY_BY_LOCATION in ` +
      `apps/console/lib/db/crm-country.ts to cover these, then re-run. Do ` +
      `NOT guess a country for a row here — a wrong country is worse than ` +
      `no country at all.`,
  );
}

async function main() {
  const { commit } = parseArgs();
  const client = makeClient();
  await client.connect();
  console.log(`[backfill] connected ${commit ? "(COMMIT)" : "(DRY RUN)"}`);

  try {
    const res = await client.query(
      `SELECT id, location FROM crm_organisations WHERE country IS NULL`,
    );
    const rows = res.rows;

    const { mapped, unmappedLocations } = planBackfill(rows);

    console.log(`[backfill] organisations read (country IS NULL): ${rows.length}`);
    console.log(`[backfill] would map: ${mapped.length}`);
    console.log(
      `[backfill] no location / already covered: ${
        rows.length - mapped.length - unmappedLocations.length
      }`,
    );

    if (!commit) {
      console.log(`[backfill] dry run — nothing written. Pass --commit to write.`);
      if (unmappedLocations.length > 0) reportUnmapped(unmappedLocations);
      return;
    }

    let written = 0;
    for (const { id, country } of mapped) {
      // `location` is never touched here — only `country`, and only for
      // rows this run itself identified as mappable.
      await client.query(
        `UPDATE crm_organisations SET country = $1 WHERE id = $2`,
        [country, id],
      );
      written += 1;
    }

    console.log(`[backfill] committed ${written} organisation(s).`);
    if (unmappedLocations.length > 0) reportUnmapped(unmappedLocations);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
