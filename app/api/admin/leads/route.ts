// GET  /api/admin/leads      — list with filters (?status=, ?source=, ?has_website=, ?q=)
// POST /api/admin/leads      — create one lead

import { NextResponse, type NextRequest } from "next/server";

import { tesserixQuery } from "@/lib/db/tesserix";
import type { LeadRow } from "@/lib/db/types";
import { leadInputSchema, leadStatusSchema } from "@/lib/leads/schema";
import { logger } from "@/lib/logger";

const LEAD_COLUMNS = `
  id, email, instagram_handle, phone, name, company,
  location, category, has_website, website_url, biography, tags,
  source, status, notes, owner,
  created_at, updated_at, last_contacted_at
`;

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const sourceParam = url.searchParams.get("source");
  const hasWebsiteParam = url.searchParams.get("has_website");
  const q = url.searchParams.get("q");

  const where: string[] = [];
  const args: unknown[] = [];
  let i = 1;

  if (statusParam && statusParam !== "all") {
    const parsed = leadStatusSchema.safeParse(statusParam);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    where.push(`status = $${i++}`);
    args.push(parsed.data);
  }

  if (sourceParam && sourceParam !== "all") {
    where.push(`source = $${i++}`);
    args.push(sourceParam);
  }

  if (hasWebsiteParam === "true") {
    where.push(`has_website = true`);
  } else if (hasWebsiteParam === "false") {
    where.push(`has_website = false`);
  } else if (hasWebsiteParam === "unknown") {
    where.push(`has_website IS NULL`);
  }

  if (q && q.trim().length > 0) {
    // Free-text search across the obvious identity columns. lower() on
    // both sides so the index on lower(email) / lower(instagram_handle)
    // and the lower(location) index are usable. Wildcard both ends so
    // partial matches work.
    where.push(`(
      lower(coalesce(email, '')) LIKE $${i} OR
      lower(coalesce(instagram_handle, '')) LIKE $${i} OR
      lower(coalesce(name, '')) LIKE $${i} OR
      lower(coalesce(company, '')) LIKE $${i} OR
      lower(coalesce(location, '')) LIKE $${i}
    )`);
    args.push(`%${q.trim().toLowerCase()}%`);
    i++;
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const result = await tesserixQuery<LeadRow>(
      `SELECT ${LEAD_COLUMNS}
       FROM leads
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT 500`,
      args,
    );
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

  // Conflict resolution: a row with a matching lower(email) takes
  // precedence; if no email but a matching lower(instagram_handle)
  // exists, we want to update that row instead. We only have ONE
  // ON CONFLICT target per statement, so dispatch by which field is
  // present. This keeps either route idempotent.
  const onEmail = Boolean(lead.email);
  const conflictTarget = onEmail ? "(lower(email))" : "(lower(instagram_handle))";
  const conflictWhere = onEmail
    ? "WHERE email IS NOT NULL"
    : "WHERE instagram_handle IS NOT NULL";

  try {
    const result = await tesserixQuery<LeadRow>(
      `INSERT INTO leads (
         email, instagram_handle, phone, name, company,
         location, category, has_website, website_url, biography, tags,
         source, status, notes, owner
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT ${conflictTarget} ${conflictWhere}
       DO UPDATE SET
         name             = COALESCE(EXCLUDED.name,             leads.name),
         company          = COALESCE(EXCLUDED.company,          leads.company),
         phone            = COALESCE(EXCLUDED.phone,            leads.phone),
         instagram_handle = COALESCE(EXCLUDED.instagram_handle, leads.instagram_handle),
         email            = COALESCE(EXCLUDED.email,            leads.email),
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
       RETURNING ${LEAD_COLUMNS}`,
      [
        lead.email ?? null,
        lead.instagram_handle ?? null,
        lead.phone ?? null,
        lead.name ?? null,
        lead.company ?? null,
        lead.location ?? null,
        lead.category ?? [],
        lead.has_website ?? null,
        lead.website_url ?? null,
        lead.biography ?? null,
        lead.tags ?? [],
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
