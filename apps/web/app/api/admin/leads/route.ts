// GET  /api/admin/leads      — list with filters (?status=, ?source=, ?has_website=, ?country=, ?min_followers=, ?min_posts=, ?starred=, ?q=)
// POST /api/admin/leads      — create one lead

import { NextResponse, type NextRequest } from "next/server";

import { tesserixQuery } from "@/lib/db/tesserix";
import type { LeadRow } from "@/lib/db/types";
import { leadInputSchema, leadStatusSchema } from "@/lib/leads/schema";
import { logger } from "@/lib/logger";

const LEAD_COLUMNS = `
  id, email, instagram_handle, phone, name, company,
  location, category, has_website, website_url, biography, tags,
  followers_count, posts_count, is_starred,
  source, status, notes, owner,
  created_at, updated_at, last_contacted_at
`;

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const sourceParam = url.searchParams.get("source");
  const hasWebsiteParam = url.searchParams.get("has_website");
  const countryParam = url.searchParams.get("country");
  const minFollowersParam = url.searchParams.get("min_followers");
  const minPostsParam = url.searchParams.get("min_posts");
  const starredParam = url.searchParams.get("starred");
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

  // Country derivation from `location`. There is no `country` column on
  // leads — Australia rows store the literal string "Australia", India
  // rows store either NULL (importer strips ", India") or an Indian
  // city/state. Treat the AU bucket as the only positive match and
  // everything else as India. When more countries arrive, lift this
  // into a real column.
  if (countryParam === "australia") {
    where.push(`location ILIKE 'australia'`);
  } else if (countryParam === "india") {
    where.push(`(location IS NULL OR location NOT ILIKE 'australia')`);
  }

  // min_followers — filter to leads with a known follower count at or
  // above the threshold. Rows where followers_count IS NULL are excluded
  // (they're typically non-IG leads). Reject non-integer / negative
  // input rather than silently coerce so the URL stays auditable.
  if (minFollowersParam !== null && minFollowersParam !== "") {
    const n = Number.parseInt(minFollowersParam, 10);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json(
        { error: "min_followers must be a non-negative integer" },
        { status: 400 },
      );
    }
    where.push(`followers_count >= $${i++}`);
    args.push(n);
  }

  // min_posts — same shape as min_followers. Excludes NULL post counts
  // (manual / non-IG leads). The combined "active account" filter
  // (followers + posts) reads as "this is a real shop, not a stub".
  if (minPostsParam !== null && minPostsParam !== "") {
    const n = Number.parseInt(minPostsParam, 10);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json(
        { error: "min_posts must be a non-negative integer" },
        { status: 400 },
      );
    }
    where.push(`posts_count >= $${i++}`);
    args.push(n);
  }

  // starred=true returns only bookmarked leads. Any other value is a
  // no-op (we don't expose "starred=false" — it's just "no filter").
  if (starredParam === "true") {
    where.push(`is_starred = true`);
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
    // activity_count: a correlated subquery is cheaper than a LATERAL
    // join here since we LIMIT 500 leads. Indexed on (lead_id, …) so
    // each subquery is an index-only count.
    const result = await tesserixQuery<LeadRow & { activity_count: number }>(
      `SELECT ${LEAD_COLUMNS},
              (SELECT count(*)::int FROM lead_activities a WHERE a.lead_id = leads.id) AS activity_count
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
         followers_count, posts_count, is_starred,
         source, status, notes, owner
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
         followers_count  = COALESCE(EXCLUDED.followers_count,  leads.followers_count),
         posts_count      = COALESCE(EXCLUDED.posts_count,      leads.posts_count),
         -- is_starred is intentionally NOT updated on conflict: re-imports
         -- shouldn't reset an operator's bookmark. Star flips happen via
         -- PATCH only.
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
        lead.followers_count ?? null,
        lead.posts_count ?? null,
        lead.is_starred ?? false,
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
