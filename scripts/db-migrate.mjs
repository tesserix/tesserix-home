#!/usr/bin/env node
// db-migrate.mjs — applies any unapplied SQL migrations from db/migrations/
// against tesserix-postgres, recording applied versions in schema_migrations.
//
// Connection: reads TESSERIX_DB_HOST / PORT / NAME / USER / PASSWORD from
// env (same vars the app uses). Locally, a .env.local in the repo root works
// — load it with `node --env-file=.env.local scripts/db-migrate.mjs`.
//
// File naming: db/migrations/NNNN_name.sql where NNNN is a zero-padded
// integer version. Files are applied strictly in version order. Each
// migration runs inside a transaction; if SQL fails, the row is NOT
// recorded and the next run will retry.
//
// Tracker schema:
//   schema_migrations(version int PK, name text, applied_at timestamptz)
// One row per applied migration — full history, not just current version.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");
const FILE_PATTERN = /^(\d{4})_(.+)\.sql$/;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: ${name} env var is required`);
    process.exit(1);
  }
  return v;
}

async function listMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  const files = [];
  for (const entry of entries) {
    const match = entry.match(FILE_PATTERN);
    if (!match) continue;
    files.push({
      version: Number.parseInt(match[1], 10),
      name: match[2],
      filename: entry,
      fullPath: path.join(MIGRATIONS_DIR, entry),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

async function main() {
  const host = requireEnv("TESSERIX_DB_HOST");
  const user = requireEnv("TESSERIX_DB_USER");
  const password = requireEnv("TESSERIX_DB_PASSWORD");
  const database = process.env.TESSERIX_DB_NAME ?? "tesserix_admin";
  const port = process.env.TESSERIX_DB_PORT
    ? Number.parseInt(process.env.TESSERIX_DB_PORT, 10)
    : 5432;

  const client = new pg.Client({
    host,
    port,
    user,
    password,
    database,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60_000,
  });

  await client.connect();
  console.log(`[db-migrate] connected to ${host}:${port}/${database} as ${user}`);

  // Ensure tracker exists. Idempotent.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer      PRIMARY KEY,
        name       text         NOT NULL,
        applied_at timestamptz  NOT NULL DEFAULT now()
    )
  `);

  const appliedRes = await client.query(
    `SELECT version FROM schema_migrations ORDER BY version`,
  );
  const applied = new Set(appliedRes.rows.map((r) => r.version));
  console.log(
    `[db-migrate] already applied: ${
      applied.size === 0 ? "(none)" : Array.from(applied).join(", ")
    }`,
  );

  const files = await listMigrationFiles();
  if (files.length === 0) {
    console.error(`ERROR: no migrations found in ${MIGRATIONS_DIR}`);
    await client.end();
    process.exit(1);
  }

  const pending = files.filter((f) => !applied.has(f.version));
  if (pending.length === 0) {
    console.log(`[db-migrate] no pending migrations — schema up to date.`);
    await client.end();
    return;
  }

  console.log(
    `[db-migrate] applying ${pending.length} migration(s): ${pending
      .map((f) => f.filename)
      .join(", ")}`,
  );

  for (const m of pending) {
    const sql = await fs.readFile(m.fullPath, "utf8");
    console.log(`[db-migrate] applying ${m.filename} …`);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
        [m.version, m.name],
      );
      await client.query("COMMIT");
      console.log(`[db-migrate]   ✓ ${m.filename}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`[db-migrate]   ✗ ${m.filename} FAILED: ${err.message}`);
      console.error(
        `[db-migrate] aborting; subsequent migrations not attempted.`,
      );
      await client.end();
      process.exit(1);
    }
  }

  console.log(`[db-migrate] done — ${pending.length} migration(s) applied.`);
  await client.end();
}

main().catch((err) => {
  console.error(`[db-migrate] unexpected error: ${err.message}`);
  process.exit(1);
});
