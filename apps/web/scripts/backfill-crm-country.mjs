#!/usr/bin/env node
// backfill-crm-country.mjs — one-shot backfill of `crm_organisations.country`
// from the existing `location` free text (migration 0025).
//
// The mapping itself is NOT reimplemented here. It lives in exactly one
// place — @tesserix/crm-country (packages/crm-country/index.mjs, plain JS +
// JSDoc) — and this script imports it BY PACKAGE NAME, through the pnpm
// workspace, not by a relative path into another app's internals. That's
// deliberate on two counts: the import path and manual create both need the
// same mapping, so a second copy anywhere is exactly the kind of divergence
// this codebase has been bitten by before; and a relative reach across an
// app boundary (this script previously did `../../console/lib/db/...ts`)
// is fragile in a way nothing here would catch — nothing in CI runs this
// script, so a moved file, or a `.ts` import depending on Node's
// type-stripping (unflagged only from Node >=22.18), would break it
// silently on the next one-shot run against production. The package has no
// build step either, so there's no "did you remember to build it first" to
// get wrong.
//
// `country` is DERIVED, never authoritative: `location` is never read from
// here to overwrite anything, and this script never writes `location`.
// Rows whose location doesn't map return `country = NULL` — never a guess.
// A wrong country silently files a lead under a market it is not in, and
// the operator has no way to notice; NULL is at least visibly unfiltered.
//
// A row whose `country` is ALREADY SET is never touched, deliberately: the
// query below reads only `WHERE country IS NULL`, so an operator's manual
// correction (or a value this script itself already wrote) is never
// silently reverted by a re-run. Re-running is therefore always safe and
// only ever fills gaps, never overwrites a decision someone already made.
//
// Usage:
//   TESSERIX_DB_HOST=... TESSERIX_DB_USER=... TESSERIX_DB_PASSWORD=... \
//     node scripts/backfill-crm-country.mjs [--commit]
//
// Dry-run by default (reads only, prints what *would* be written).
// Pass --commit to actually write.

import process from "node:process";
import pg from "pg";
import { planBackfill } from "@tesserix/crm-country";

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

/** Names every distinct unmapped location on exit, so an operator extends
 *  `COUNTRY_BY_LOCATION` in packages/crm-country/index.mjs rather than
 *  discovering the gap later through a country filter that silently
 *  returns nothing. */
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
      `packages/crm-country/index.mjs to cover these, then re-run. Do NOT ` +
      `guess a country for a row here — a wrong country is worse than no ` +
      `country at all.`,
  );
}

async function main() {
  const { commit } = parseArgs();
  const client = makeClient();
  await client.connect();
  console.log(`[backfill] connected ${commit ? "(COMMIT)" : "(DRY RUN)"}`);

  try {
    // WHERE country IS NULL: an already-set country (a prior run of this
    // script, or an operator's manual correction) is never re-read and
    // never overwritten. See the header — this is the thing that makes a
    // re-run safe.
    const res = await client.query(
      `SELECT id, location FROM crm_organisations WHERE country IS NULL`,
    );
    const rows = res.rows;

    const { mapped, unmappedRowCount, unmappedLocations } = planBackfill(rows);

    // These three are row counts, not distinct-value counts, and are
    // constructed to sum to `rows.length` exactly: `mapped.length` and
    // `unmappedRowCount` both count ROWS (planBackfill counts a row towards
    // `unmappedRowCount` for every occurrence of an unrecognised location,
    // not once per distinct string — `unmappedLocations` is the distinct
    // list, kept separate precisely so it can't be substituted into this
    // arithmetic by mistake).
    const noLocationCount = rows.length - mapped.length - unmappedRowCount;

    console.log(`[backfill] organisations read (country IS NULL): ${rows.length}`);
    console.log(`[backfill] would map: ${mapped.length}`);
    console.log(`[backfill] unrecognised location (left NULL): ${unmappedRowCount}`);
    console.log(`[backfill] no location at all: ${noLocationCount}`);

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
