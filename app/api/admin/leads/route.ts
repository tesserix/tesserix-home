// GET  /api/admin/leads      — list (with optional ?status= filter)
// POST /api/admin/leads      — create one lead

import { NextResponse, type NextRequest } from "next/server";

import { tesserixQuery } from "@/lib/db/tesserix";
import type { LeadRow } from "@/lib/db/types";
import { leadInputSchema, leadStatusSchema } from "@/lib/leads/schema";
import { logger } from "@/lib/logger";

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");

  try {
    let result;
    if (statusParam) {
      const parsed = leadStatusSchema.safeParse(statusParam);
      if (!parsed.success) {
        return NextResponse.json({ error: "invalid status" }, { status: 400 });
      }
      result = await tesserixQuery<LeadRow>(
        `SELECT id, email, name, company, source, status, notes, owner,
                created_at, updated_at, last_contacted_at
         FROM leads
         WHERE status = $1
         ORDER BY created_at DESC
         LIMIT 500`,
        [parsed.data],
      );
    } else {
      result = await tesserixQuery<LeadRow>(
        `SELECT id, email, name, company, source, status, notes, owner,
                created_at, updated_at, last_contacted_at
         FROM leads
         ORDER BY created_at DESC
         LIMIT 500`,
      );
    }
    return NextResponse.json({ leads: result.rows });
  } catch (err) {
    logger.error("[leads GET] failed", err);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = leadInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid lead", details: parsed.error.format() },
      { status: 400 },
    );
  }
  const lead = parsed.data;

  try {
    const result = await tesserixQuery<LeadRow>(
      `INSERT INTO leads (email, name, company, source, status, notes, owner)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (lower(email)) DO UPDATE SET
         name              = COALESCE(EXCLUDED.name, leads.name),
         company           = COALESCE(EXCLUDED.company, leads.company),
         source            = COALESCE(EXCLUDED.source, leads.source),
         notes             = COALESCE(EXCLUDED.notes, leads.notes),
         owner             = COALESCE(EXCLUDED.owner, leads.owner),
         updated_at        = now()
       RETURNING id, email, name, company, source, status, notes, owner,
                 created_at, updated_at, last_contacted_at`,
      [
        lead.email,
        lead.name ?? null,
        lead.company ?? null,
        lead.source ?? null,
        lead.status ?? "new",
        lead.notes ?? null,
        lead.owner ?? null,
      ],
    );
    return NextResponse.json({ lead: result.rows[0] }, { status: 201 });
  } catch (err) {
    logger.error("[leads POST] failed", err);
    return NextResponse.json({ error: "insert failed" }, { status: 500 });
  }
}
