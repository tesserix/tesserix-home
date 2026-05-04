// PATCH  /api/admin/leads/:id   — update fields (status, notes, owner, structured fields, …)
// DELETE /api/admin/leads/:id   — hard delete

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { tesserixQuery } from "@/lib/db/tesserix";
import type { LeadRow } from "@/lib/db/types";
import { leadUpdateSchema } from "@/lib/leads/schema";
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
    const result = await tesserixQuery<LeadRow>(
      `UPDATE leads SET ${sets.join(", ")}
       WHERE id = $${i}
       RETURNING ${LEAD_RETURNING}`,
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
