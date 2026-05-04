// PATCH  /api/admin/leads/:id   — update fields (status, notes, owner, structured fields, …)
// DELETE /api/admin/leads/:id   — hard delete

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { tesserixQuery } from "@/lib/db/tesserix";
import type { LeadRow } from "@/lib/db/types";
import { leadUpdateSchema } from "@/lib/leads/schema";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

const uuidSchema = z.string().uuid();

const LEAD_RETURNING = `
  id, email, instagram_handle, phone, name, company,
  location, category, has_website, website_url, biography, tags,
  source, status, notes, owner,
  created_at, updated_at, last_contacted_at
`;

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
  // text[] columns (category, tags) take JS arrays directly via node-postgres.
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const setIfPresent = <K extends keyof typeof u>(col: string, key: K) => {
    if (u[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(u[key]);
    }
  };
  setIfPresent("email", "email");
  setIfPresent("instagram_handle", "instagram_handle");
  setIfPresent("phone", "phone");
  setIfPresent("name", "name");
  setIfPresent("company", "company");
  setIfPresent("location", "location");
  setIfPresent("category", "category");
  setIfPresent("has_website", "has_website");
  setIfPresent("website_url", "website_url");
  setIfPresent("biography", "biography");
  setIfPresent("tags", "tags");
  setIfPresent("source", "source");
  setIfPresent("status", "status");
  setIfPresent("notes", "notes");
  setIfPresent("owner", "owner");
  setIfPresent("last_contacted_at", "last_contacted_at");

  if (sets.length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }
  values.push(idCheck.data);

  try {
    // Snapshot the previous state for the things we auto-log on change
    // (status, owner). One round-trip is fine for a single-row patch.
    const prev = await tesserixQuery<{ status: string; owner: string | null }>(
      `SELECT status, owner FROM leads WHERE id = $1`,
      [idCheck.data],
    );
    if (prev.rows.length === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const before = prev.rows[0];

    const result = await tesserixQuery<LeadRow>(
      `UPDATE leads SET ${sets.join(", ")}
       WHERE id = $${i}
       RETURNING ${LEAD_RETURNING}`,
      values,
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const after = result.rows[0];

    // Auto-log status / owner changes as activities. Best-effort: a
    // failure here doesn't roll back the underlying mutation, since
    // the timeline is observation, not source-of-truth.
    const session = await getCurrentSession().catch(() => null);
    const actor = session?.email ?? "unknown@tesserix";
    try {
      if (u.status !== undefined && u.status !== before.status) {
        await tesserixQuery(
          `INSERT INTO lead_activities (lead_id, kind, actor_email, body, metadata)
           VALUES ($1, 'status_change', $2, $3, $4::jsonb)`,
          [
            idCheck.data,
            actor,
            `${before.status} → ${after.status}`,
            JSON.stringify({ from: before.status, to: after.status }),
          ],
        );
      }
      if (u.owner !== undefined && (u.owner ?? null) !== before.owner) {
        await tesserixQuery(
          `INSERT INTO lead_activities (lead_id, kind, actor_email, body, metadata)
           VALUES ($1, 'assigned', $2, $3, $4::jsonb)`,
          [
            idCheck.data,
            actor,
            after.owner
              ? `Assigned to ${after.owner}`
              : `Unassigned (was ${before.owner ?? "—"})`,
            JSON.stringify({ from: before.owner, to: after.owner }),
          ],
        );
      }
    } catch (logErr) {
      logger.warn("[leads PATCH] activity log failed (non-fatal)", logErr);
    }

    return NextResponse.json({ lead: after });
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
