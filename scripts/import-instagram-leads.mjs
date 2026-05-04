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
// Mapping into public.leads (post-migration 0007):
//   email             = real email if present, else NULL
//   instagram_handle  = csv.username (lowered)
//   phone             = csv.phone
//   name              = csv.name (fallback: username)
//   company           = csv.username
//   location          = csv.location
//   category          = csv.what_they_sell split on `, `
//   has_website       = true  if website_status matches /Has website/i
//                       false otherwise (any "no/social/aggregator" variant)
//                       NULL  if website_status missing
//   website_url       = csv.external_url_if_any
//   biography         = csv.biography
//   tags              = csv.source_hashtags split on `, `
//   source            = "instagram_outreach"
//   status            = "new"
//
// Idempotent dedup:
//   - If email present     → ON CONFLICT (lower(email))            DO NOTHING
//   - Else handle present  → ON CONFLICT (lower(instagram_handle)) DO NOTHING
//
// Records every run in lead_imports for audit (filename + counts).

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

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
// embedded quotes (escaped as ""), and \n / \r\n line endings.
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

function splitCommaList(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseHasWebsite(raw) {
  if (!raw) return null;
  if (/Has website/i.test(raw)) return true;
  if (
    /No links|no website|WhatsApp\/social|aggregator|Linktree/i.test(raw)
  ) {
    return false;
  }
  return null;
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
  let updated = 0;
  let failed = 0;
  let realEmails = 0;
  const errors = [];

  // Two SQL paths — one for each conflict target. We have to pick at
  // statement-construction time because PostgreSQL only supports a
  // single ON CONFLICT clause per query.
  const insertByEmail = `
    INSERT INTO leads (
      email, instagram_handle, phone, name, company,
      location, category, has_website, website_url, biography, tags,
      source, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (lower(email)) WHERE email IS NOT NULL
    DO UPDATE SET
      instagram_handle = COALESCE(EXCLUDED.instagram_handle, leads.instagram_handle),
      phone            = COALESCE(EXCLUDED.phone,            leads.phone),
      name             = COALESCE(EXCLUDED.name,             leads.name),
      company          = COALESCE(EXCLUDED.company,          leads.company),
      location         = COALESCE(EXCLUDED.location,         leads.location),
      category         = CASE WHEN array_length(EXCLUDED.category, 1) > 0
                              THEN EXCLUDED.category ELSE leads.category END,
      has_website      = COALESCE(EXCLUDED.has_website,      leads.has_website),
      website_url      = COALESCE(EXCLUDED.website_url,      leads.website_url),
      biography        = COALESCE(EXCLUDED.biography,        leads.biography),
      tags             = CASE WHEN array_length(EXCLUDED.tags, 1) > 0
                              THEN EXCLUDED.tags ELSE leads.tags END,
      updated_at       = now()
    RETURNING (xmax = 0) AS inserted
  `;
  const insertByHandle = insertByEmail.replace(
    "ON CONFLICT (lower(email)) WHERE email IS NOT NULL",
    "ON CONFLICT (lower(instagram_handle)) WHERE instagram_handle IS NOT NULL",
  );

  for (const row of dataRows) {
    const get = (key) =>
      idx[key] >= 0 && row[idx[key]] ? row[idx[key]].trim() : "";
    const username = get("username");
    if (!username) {
      continue;
    }
    const realEmail = get("email").toLowerCase() || null;
    const handle = username.toLowerCase();
    if (realEmail) realEmails++;
    const args = [
      realEmail,
      handle,
      get("phone") || null,
      get("name") || username,
      username,
      get("location") || null,
      splitCommaList(get("what_they_sell")),
      parseHasWebsite(get("website_status")),
      get("external_url_if_any") || null,
      get("biography") || null,
      splitCommaList(get("source_hashtags")),
      SOURCE,
      STATUS,
    ];

    if (dryRun) {
      console.log(
        `[import]   ${(realEmail ?? `@${handle}`).padEnd(50)} | ${args[3].padEnd(30)} | ${(args[5] ?? "").padEnd(20)} | site=${args[7]}`,
      );
      inserted++;
      continue;
    }

    try {
      const sql = realEmail ? insertByEmail : insertByHandle;
      const res = await client.query(sql, args);
      if (res.rows[0]?.inserted) inserted++;
      else updated++;
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        SOURCE,
        path.basename(file),
        process.env.IMPORTED_BY ?? "import-script",
        dataRows.length,
        inserted,
        updated,
        failed,
        JSON.stringify(errors),
      ],
    );
    await client.end();
  }

  console.log("");
  console.log("[import] summary:");
  console.log(`           total rows:    ${dataRows.length}`);
  console.log(`           inserted:      ${inserted}`);
  console.log(`           updated:       ${updated}`);
  console.log(`           failed:        ${failed}`);
  console.log(`           with email:    ${realEmails}`);
  console.log(`           handle-only:   ${dataRows.length - realEmails - failed}`);
}

main().catch((err) => {
  console.error(`[import] unexpected error: ${err.message}`);
  process.exit(1);
});
