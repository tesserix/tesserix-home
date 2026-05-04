// GET  /api/admin/leads/:id/activities  — chronological timeline (newest first)
// POST /api/admin/leads/:id/activities  — append a note / dm / call / etc.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { tesserixQuery } from "@/lib/db/tesserix";
import type { LeadActivityRow } from "@/lib/db/types";
import { leadActivityInputSchema } from "@/lib/leads/schema";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

const uuidSchema = z.string().uuid();

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const idCheck = uuidSchema.safeParse(id);
  if (!idCheck.success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const result = await tesserixQuery<LeadActivityRow>(
      `SELECT id, lead_id, kind, actor_email, body, metadata, created_at
       FROM lead_activities
       WHERE lead_id = $1
       ORDER BY created_at DESC
       LIMIT 500`,
      [idCheck.data],
    );
    return NextResponse.json({ activities: result.rows });
  } catch (err) {
    logger.error("[lead-activities GET] failed", err);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const idCheck = uuidSchema.safeParse(id);
  if (!idCheck.success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = leadActivityInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid activity", details: parsed.error.format() },
      { status: 400 },
    );
  }

  const session = await getCurrentSession().catch(() => null);
  const actor = session?.email ?? "unknown@tesserix";

  try {
    const result = await tesserixQuery<LeadActivityRow>(
      `INSERT INTO lead_activities (lead_id, kind, actor_email, body, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, lead_id, kind, actor_email, body, metadata, created_at`,
      [
        idCheck.data,
        parsed.data.kind,
        actor,
        parsed.data.body ?? null,
        JSON.stringify(parsed.data.metadata ?? {}),
      ],
    );
    // Bump last_contacted_at on the lead for outbound contact kinds.
    if (
      parsed.data.kind === "dm_sent" ||
      parsed.data.kind === "email_sent" ||
      parsed.data.kind === "call"
    ) {
      await tesserixQuery(
        `UPDATE leads SET last_contacted_at = now(), updated_at = now() WHERE id = $1`,
        [idCheck.data],
      );
    }
    return NextResponse.json({ activity: result.rows[0] }, { status: 201 });
  } catch (err) {
    logger.error("[lead-activities POST] failed", err);
    return NextResponse.json({ error: "insert failed" }, { status: 500 });
  }
}
