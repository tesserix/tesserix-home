#!/usr/bin/env node
// import-instagram-leads.mjs — import Instagram seller scrapes into leads.
//
// Usage:
//   TESSERIX_DB_HOST=... TESSERIX_DB_USER=... TESSERIX_DB_PASSWORD=... \
//     node scripts/import-instagram-leads.mjs <path-to.csv> [--dry-run]
//
// Expected CSV columns (header row required, in any order):
//   username, name, phone, email, location, what_they_sell,
//   website_status, biography, instagram_url, source_hashtags,
//   external_url_if_any (optional)
//
// Mapping into public.leads:
//   email   = <real email> or "<username>@instagram.placeholder"
//   name    = csv.name or csv.username
//   company = csv.username (the @handle is the brand on Instagram)
//   source  = "instagram_outreach"
//   status  = "new"
//   notes   = location · what_they_sell · website_status · bio · IG link
//             · external website · source hashtags (whichever are present)
//
// Idempotent — `ON CONFLICT (lower(email)) DO NOTHING`. Re-running with
// the same CSV is a no-op. Real-email rows beat placeholder rows: if
// you discover a real email later, UPDATE the row directly.
//
// Records every run in lead_imports for audit (filename + counts).

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const PLACEHOLDER_DOMAIN = "instagram.placeholder";
const SOURCE = "instagram_outreach";
const STATUS = "new";

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: import-instagram-leads.mjs <csv-path> [--dry-run]");
    process.exit(1);
  }
  return { file, dryRun };
}

// RFC 4180-ish CSV parser. Handles quoted fields, embedded commas,
// embedded quotes (escaped as ""), and \n / \r\n line endings. Good
// enough for tooling-generated exports — not for arbitrary user input.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function buildNotes(get) {
  const parts = [];
  const location = get("location");
  if (location) parts.push(`Location: ${location}`);
  const sells = get("what_they_sell");
  if (sells) parts.push(`Sells: ${sells}`);
  const website = get("website_status");
  if (website) parts.push(`Website status: ${website}`);
  const bio = get("biography");
  if (bio) parts.push(`Bio: ${bio}`);
  const ig = get("instagram_url");
  if (ig) parts.push(`IG: ${ig}`);
  const ext = get("external_url_if_any");
  if (ext) parts.push(`Website: ${ext}`);
  const phone = get("phone");
  if (phone) parts.push(`Phone: ${phone}`);
  const tags = get("source_hashtags");
  if (tags) parts.push(`Hashtags: ${tags}`);
  return parts.join(" · ");
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: ${name} env var is required`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const { file, dryRun } = parseArgs();
  const csvText = await fs.readFile(file, "utf8");
  const rows = parseCSV(csvText);
  if (rows.length < 2) {
    console.error("ERROR: CSV has no data rows");
    process.exit(1);
  }
  const header = rows[0].map((h) => h.trim());
  const colIndex = (name) => header.indexOf(name);

  const idx = {
    username: colIndex("username"),
    name: colIndex("name"),
    email: colIndex("email"),
    phone: colIndex("phone"),
    location: colIndex("location"),
    what_they_sell: colIndex("what_they_sell"),
    website_status: colIndex("website_status"),
    biography: colIndex("biography"),
    instagram_url: colIndex("instagram_url"),
    source_hashtags: colIndex("source_hashtags"),
    external_url_if_any: colIndex("external_url_if_any"),
  };
  if (idx.username < 0) {
    console.error("ERROR: 'username' column not found in CSV header");
    process.exit(1);
  }

  const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  console.log(
    `[import] ${path.basename(file)}: ${dataRows.length} data rows ${dryRun ? "(DRY RUN)" : ""}`,
  );

  const client = dryRun
    ? null
    : new pg.Client({
        host: requireEnv("TESSERIX_DB_HOST"),
        port: process.env.TESSERIX_DB_PORT
          ? Number.parseInt(process.env.TESSERIX_DB_PORT, 10)
          : 5432,
        user: requireEnv("TESSERIX_DB_USER"),
        password: requireEnv("TESSERIX_DB_PASSWORD"),
        database: process.env.TESSERIX_DB_NAME ?? "tesserix_admin",
        ssl: { rejectUnauthorized: false },
        statement_timeout: 60_000,
      });
  if (client) {
    await client.connect();
    console.log(`[import] connected`);
  }

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let realEmails = 0;
  const errors = [];

  for (const row of dataRows) {
    const get = (key) =>
      idx[key] >= 0 && row[idx[key]] ? row[idx[key]].trim() : "";
    const username = get("username");
    if (!username) {
      skipped++;
      continue;
    }
    const realEmail = get("email").toLowerCase();
    const email = realEmail || `${username.toLowerCase()}@${PLACEHOLDER_DOMAIN}`;
    if (realEmail) realEmails++;
    const name = get("name") || username;
    const company = username;
    const notes = buildNotes(get);

    if (dryRun) {
      console.log(
        `[import]   ${email.padEnd(50)} | ${name.padEnd(30)} | ${notes.slice(0, 80)}`,
      );
      inserted++;
      continue;
    }

    try {
      const res = await client.query(
        `
          INSERT INTO leads (email, name, company, source, status, notes)
          VALUES ($1, $2, $3, $4, $5::lead_status, $6)
          ON CONFLICT (lower(email)) DO NOTHING
          RETURNING id
        `,
        [email, name, company, SOURCE, STATUS, notes],
      );
      if (res.rowCount > 0) {
        inserted++;
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ username, error: msg });
      console.error(`[import]   ✗ ${username}: ${msg}`);
    }
  }

  if (!dryRun && client) {
    await client.query(
      `
        INSERT INTO lead_imports
          (source, filename, imported_by, total_rows, inserted_rows, updated_rows, failed_rows, errors)
        VALUES ($1, $2, $3, $4, $5, 0, $6, $7::jsonb)
      `,
      [
        SOURCE,
        path.basename(file),
        process.env.IMPORTED_BY ?? "import-script",
        dataRows.length,
        inserted,
        failed,
        JSON.stringify(errors),
      ],
    );
    await client.end();
  }

  console.log("");
  console.log("[import] summary:");
  console.log(`           total rows:   ${dataRows.length}`);
  console.log(`           inserted:     ${inserted}`);
  console.log(`           skipped (dup):${skipped}`);
  console.log(`           failed:       ${failed}`);
  console.log(`           real emails:  ${realEmails}`);
  console.log(
    `           placeholders: ${dataRows.length - realEmails - failed - skipped}`,
  );
}

main().catch((err) => {
  console.error(`[import] unexpected error: ${err.message}`);
  process.exit(1);
});
