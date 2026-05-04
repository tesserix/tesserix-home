// POST /api/admin/leads/import — batch upsert leads + insert lead_imports row.
// Accepts a JSON body shaped by lib/leads/schema.leadImportSchema. The
// browser converts CSV → JSON before posting (see app/admin/leads UI).
//
// Insert + audit are wrapped in a single transaction so a partial failure
// rolls back; lead_imports.errors records per-row failures.
//
// As of migration 0007, rows can land via email OR instagram_handle. The
// upsert dispatches its ON CONFLICT target based on which contact field
// is present so both kinds of rows stay idempotent.

import { NextResponse, type NextRequest } from "next/server";

import { tesserixTx } from "@/lib/db/tesserix";
import { leadImportSchema, type LeadInput } from "@/lib/leads/schema";
import { logger } from "@/lib/logger";

interface ImportError {
  row: number;
  email?: string | null;
  instagram_handle?: string | null;
  error: string;
}

interface ImportSummary {
  import_id: string;
  total: number;
  inserted: number;
  updated: number;
  failed: number;
  errors: ImportError[];
}

const UPSERT_BY_EMAIL = `
  INSERT INTO leads (
    email, instagram_handle, phone, name, company,
    location, category, has_website, website_url, biography, tags,
    source, status, notes, owner
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  ON CONFLICT (lower(email)) WHERE email IS NOT NULL
  DO UPDATE SET
    name             = COALESCE(EXCLUDED.name,             leads.name),
    company          = COALESCE(EXCLUDED.company,          leads.company),
    instagram_handle = COALESCE(EXCLUDED.instagram_handle, leads.instagram_handle),
    phone            = COALESCE(EXCLUDED.phone,            leads.phone),
    location         = COALESCE(EXCLUDED.location,         leads.location),
    category         = CASE WHEN array_length(EXCLUDED.category, 1) > 0
                            THEN EXCLUDED.category ELSE leads.category END,
    has_website      = COALESCE(EXCLUDED.has_website,      leads.has_website),
    website_url      = COALESCE(EXCLUDED.website_url,      leads.website_url),
    biography        = COALESCE(EXCLUDED.biography,        leads.biography),
    tags             = CASE WHEN array_length(EXCLUDED.tags, 1) > 0
                            THEN EXCLUDED.tags ELSE leads.tags END,
    source           = COALESCE(EXCLUDED.source,           leads.source),
    notes            = COALESCE(EXCLUDED.notes,            leads.notes),
    owner            = COALESCE(EXCLUDED.owner,            leads.owner),
    updated_at       = now()
  RETURNING (xmax = 0) AS inserted
`;

const UPSERT_BY_HANDLE = `
  INSERT INTO leads (
    email, instagram_handle, phone, name, company,
    location, category, has_website, website_url, biography, tags,
    source, status, notes, owner
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  ON CONFLICT (lower(instagram_handle)) WHERE instagram_handle IS NOT NULL
  DO UPDATE SET
    name             = COALESCE(EXCLUDED.name,             leads.name),
    company          = COALESCE(EXCLUDED.company,          leads.company),
    email            = COALESCE(EXCLUDED.email,            leads.email),
    phone            = COALESCE(EXCLUDED.phone,            leads.phone),
    location         = COALESCE(EXCLUDED.location,         leads.location),
    category         = CASE WHEN array_length(EXCLUDED.category, 1) > 0
                            THEN EXCLUDED.category ELSE leads.category END,
    has_website      = COALESCE(EXCLUDED.has_website,      leads.has_website),
    website_url      = COALESCE(EXCLUDED.website_url,      leads.website_url),
    biography        = COALESCE(EXCLUDED.biography,        leads.biography),
    tags             = CASE WHEN array_length(EXCLUDED.tags, 1) > 0
                            THEN EXCLUDED.tags ELSE leads.tags END,
    source           = COALESCE(EXCLUDED.source,           leads.source),
    notes            = COALESCE(EXCLUDED.notes,            leads.notes),
    owner            = COALESCE(EXCLUDED.owner,            leads.owner),
    updated_at       = now()
  RETURNING (xmax = 0) AS inserted
`;

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = leadImportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid import", details: parsed.error.format() },
      { status: 400 },
    );
  }
  const { source, filename, rows } = parsed.data;

  try {
    const summary = await tesserixTx<ImportSummary>(async (client) => {
      let inserted = 0;
      let updated = 0;
      const errors: ImportError[] = [];

      for (let idx = 0; idx < rows.length; idx++) {
        const r: LeadInput = rows[idx];
        try {
          const sql = r.email ? UPSERT_BY_EMAIL : UPSERT_BY_HANDLE;
          const upsert = await client.query<{ inserted: boolean }>(sql, [
            r.email ?? null,
            r.instagram_handle ?? null,
            r.phone ?? null,
            r.name ?? null,
            r.company ?? null,
            r.location ?? null,
            r.category ?? [],
            r.has_website ?? null,
            r.website_url ?? null,
            r.biography ?? null,
            r.tags ?? [],
            r.source ?? source,
            r.status ?? "new",
            r.notes ?? null,
            r.owner ?? null,
          ]);
          if (upsert.rows[0]?.inserted) inserted++;
          else updated++;
        } catch (err) {
          errors.push({
            row: idx,
            email: r.email ?? null,
            instagram_handle: r.instagram_handle ?? null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const importRes = await client.query<{ id: string }>(
        `INSERT INTO lead_imports (
           source, filename, imported_by, total_rows,
           inserted_rows, updated_rows, failed_rows, errors
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING id`,
        [
          source,
          filename ?? null,
          // TODO: thread the authenticated user email through middleware once
          // we expose it on the request. For now, leave imported_by null.
          null,
          rows.length,
          inserted,
          updated,
          errors.length,
          JSON.stringify(errors),
        ],
      );

      return {
        import_id: importRes.rows[0].id,
        total: rows.length,
        inserted,
        updated,
        failed: errors.length,
        errors,
      };
    });

    return NextResponse.json(summary, { status: 201 });
  } catch (err) {
    logger.error("[leads import] failed", err);
    return NextResponse.json({ error: "import failed" }, { status: 500 });
  }
}
