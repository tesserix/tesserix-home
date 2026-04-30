// PATCH  /api/admin/leads/:id   — update fields (status, notes, owner, last_contacted_at, …)
// DELETE /api/admin/leads/:id   — hard delete

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { tesserixQuery } from "@/lib/db/tesserix";
import type { LeadRow } from "@/lib/db/types";
import { leadUpdateSchema } from "@/lib/leads/schema";
import { logger } from "@/lib/logger";

const uuidSchema = z.string().uuid();

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
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

  const parsed = leadUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid update", details: parsed.error.format() },
      { status: 400 },
    );
  }
  const u = parsed.data;

  // Build SET clause dynamically — only update fields the caller specified.
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (u.email !== undefined) { sets.push(`email = $${i++}`); values.push(u.email); }
  if (u.name !== undefined) { sets.push(`name = $${i++}`); values.push(u.name); }
  if (u.company !== undefined) { sets.push(`company = $${i++}`); values.push(u.company); }
  if (u.source !== undefined) { sets.push(`source = $${i++}`); values.push(u.source); }
  if (u.status !== undefined) { sets.push(`status = $${i++}`); values.push(u.status); }
  if (u.notes !== undefined) { sets.push(`notes = $${i++}`); values.push(u.notes); }
  if (u.owner !== undefined) { sets.push(`owner = $${i++}`); values.push(u.owner); }
  if (u.last_contacted_at !== undefined) {
    sets.push(`last_contacted_at = $${i++}`);
    values.push(u.last_contacted_at);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }
  values.push(idCheck.data);

  try {
    const result = await tesserixQuery<LeadRow>(
      `UPDATE leads SET ${sets.join(", ")}
       WHERE id = $${i}
       RETURNING id, email, name, company, source, status, notes, owner,
                 created_at, updated_at, last_contacted_at`,
      values,
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ lead: result.rows[0] });
  } catch (err) {
    logger.error("[leads PATCH] failed", err);
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const idCheck = uuidSchema.safeParse(id);
  if (!idCheck.success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const result = await tesserixQuery(
      `DELETE FROM leads WHERE id = $1 RETURNING id`,
      [idCheck.data],
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ deleted: idCheck.data });
  } catch (err) {
    logger.error("[leads DELETE] failed", err);
    return NextResponse.json({ error: "delete failed" }, { status: 500 });
  }
}
