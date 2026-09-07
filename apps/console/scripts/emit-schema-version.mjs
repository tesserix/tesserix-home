#!/usr/bin/env node
// emit-schema-version.mjs — bake the migrations THIS image ships into a file
// the image can read back at startup.
//
// Run by `pnpm --filter console build:schema-version`, which `Dockerfile.console`
// invokes in the builder stage; the resulting JSON is copied into the runtime
// image beside `require-schema-version.mjs`, which compares it against the
// database's `schema_migrations` ledger before the server is allowed to start.
//
// ══ WHY A BUILD ARTEFACT AND NOT AN ENVIRONMENT VARIABLE ══
//
// The expected version is a property of the IMAGE — it is "which migrations
// did this build's source tree contain" — and it must not be settable by
// whoever deploys the image. A value an operator can set is a value an
// operator can set wrong, and this whole check exists because a human step
// (running the migration runner) was skipped. An env var would let the same
// human skip the check itself, with the pod reporting healthy either way.
//
// ══ WHY THE FULL LIST AND NOT JUST THE MAXIMUM ══
//
// The maximum alone cannot describe a HOLE. A database that applied 0049 and
// 0051 but never 0050 has a maximum of 51 and is nonetheless missing a
// migration this image requires — and that shape is not hypothetical: on
// 2026-09-07 production had 0051's DDL hand-piped through psql, so the ledger
// and the schema disagreed in exactly this direction. The list also lets the
// failure message NAME the missing versions, which is the whole difference
// between a 2am page someone can act on and one they have to reverse-engineer.
//
// `maxVersion` is emitted too, but only as context for the log line. The
// comparison is over `versions`.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The SAME listing the runner applies with. See migration-files.mjs for why a
// second regex here would be a silent, production-only divergence.
import { MIGRATIONS_DIR, listMigrationFiles } from "../../web/scripts/migration-files.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default alongside the esbuild bundles, because it is the same KIND of thing:
// a generated artefact the Dockerfile copies into the runtime stage. `dist/`
// is gitignored, so this never lands in a commit and can never go stale in a
// working tree.
const DEFAULT_OUT = path.join(__dirname, "..", "dist", "schema-version.json");

async function main() {
  const outPath = process.argv[2] ?? DEFAULT_OUT;

  const files = await listMigrationFiles();

  // A build that found no migrations has NOT discovered that the project has
  // none — it has discovered that its own assumptions about the source tree
  // are wrong (a moved directory, a bad COPY, a filename convention change).
  // Emitting an empty list would ship an image whose preflight passes against
  // literally any database, including an empty one. That is the silent-pass
  // failure the preflight exists to prevent, so it is a build failure here
  // instead.
  if (files.length === 0) {
    console.error(
      `[schema-version] ERROR: no migrations found in ${MIGRATIONS_DIR}. ` +
        `Refusing to emit an empty version file — it would make the startup ` +
        `preflight pass against any database at all.`,
    );
    process.exit(1);
  }

  const versions = files.map((f) => f.version);
  const maxVersion = versions[versions.length - 1];

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(
    outPath,
    `${JSON.stringify(
      {
        // Provenance, for whoever finds this file in a container and wonders
        // what wrote it.
        generatedBy: "apps/console/scripts/emit-schema-version.mjs",
        source: "apps/web/db/migrations",
        maxVersion,
        versions,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(
    `[schema-version] wrote ${outPath} — ${versions.length} migration(s), max ${maxVersion}`,
  );
}

main().catch((err) => {
  console.error(`[schema-version] unexpected error: ${err.message}`);
  process.exit(1);
});
