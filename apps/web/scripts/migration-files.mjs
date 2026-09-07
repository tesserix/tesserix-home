// migration-files.mjs — what counts as a migration, and what its version is.
//
// ONE definition, shared by everything that has an opinion about the ledger:
//
//   - `db-migrate.mjs`, which APPLIES the files and writes `schema_migrations`
//   - `apps/console/scripts/emit-schema-version.mjs`, which bakes the set of
//     versions a console image expects into that image at build time
//
// Shared rather than copied, because the two must never disagree. A second
// regex here is not a cosmetic duplication: if the emitter's pattern accepted
// a file the runner ignores, the preflight would demand a version the runner
// will never apply and no console image could ever start; if it REJECTED a
// file the runner applies, the preflight would fall silent about exactly the
// migration nobody remembered to run — which is the failure the preflight
// exists to catch. Both halves of that drift are silent until production.
//
// File naming: db/migrations/NNNN_name.sql, NNNN a zero-padded integer
// version. Anything else in the directory (a README, an editor swapfile, a
// `.sql.bak`) is not a migration and is skipped.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The canonical location of the SQL migrations, resolved from this file so
 *  that a caller in another app does not have to hardcode `../../web/db/…`. */
export const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");

export const FILE_PATTERN = /^(\d{4})_(.+)\.sql$/;

/**
 * List every migration in `dir`, in strict version order.
 *
 * Sorted numerically rather than lexicographically — the runner applies in
 * this order, and while four zero-padded digits happen to sort the same way
 * either side of 1000, the ordering contract is on the NUMBER and should not
 * quietly depend on the padding staying at four.
 *
 * Returns `{ version, name, filename, fullPath }` for each.
 */
export async function listMigrationFiles(dir = MIGRATIONS_DIR) {
  const entries = await fs.readdir(dir);
  const files = [];
  for (const entry of entries) {
    const match = entry.match(FILE_PATTERN);
    if (!match) continue;
    files.push({
      version: Number.parseInt(match[1], 10),
      name: match[2],
      filename: entry,
      fullPath: path.join(dir, entry),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}
