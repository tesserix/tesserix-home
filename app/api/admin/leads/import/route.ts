// POST /api/admin/leads/import — batch upsert leads + insert lead_imports row.
// Accepts a JSON body shaped by lib/leads/schema.leadImportSchema. The
// browser converts CSV → JSON before posting (see app/admin/leads UI).
//
// Insert + audit are wrapped in a single transaction so a partial failure
// rolls back; lead_imports.errors records per-row failures.

import { NextResponse, type NextRequest } from "next/server";

import { tesserixTx } from "@/lib/db/tesserix";
import { leadImportSchema, type LeadInput } from "@/lib/leads/schema";
import { logger } from "@/lib/logger";

interface ImportError {
  row: number;
  email?: string;
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
          const upsert = await client.query<{ inserted: boolean }>(
            `INSERT INTO leads (email, name, company, source, status, notes, owner)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (lower(email)) DO UPDATE SET
               name       = COALESCE(EXCLUDED.name, leads.name),
               company    = COALESCE(EXCLUDED.company, leads.company),
               source     = COALESCE(EXCLUDED.source, leads.source),
               notes      = COALESCE(EXCLUDED.notes, leads.notes),
               owner      = COALESCE(EXCLUDED.owner, leads.owner),
               updated_at = now()
             RETURNING (xmax = 0) AS inserted`,
            [
              r.email,
              r.name ?? null,
              r.company ?? null,
              r.source ?? source, // fall back to batch-level source if row-level missing
              r.status ?? "new",
              r.notes ?? null,
              r.owner ?? null,
            ],
          );
          if (upsert.rows[0]?.inserted) inserted++;
          else updated++;
        } catch (err) {
          errors.push({
            row: idx,
            email: r.email,
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
