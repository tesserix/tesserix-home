// PATCH /api/admin/tenants/:id — soft-archive / unarchive / suspend.
//
// We do NOT expose hard-delete here. That has cross-table cascade
// concerns in mark8ly's schema and is handled out-of-band via the
// runbook (see tesserix-k8s/docs/cross-db-admin.md).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { mark8lyTx } from "@/lib/db/mark8ly";
import type { TenantRow } from "@/lib/db/types";
import { logger } from "@/lib/logger";

const uuidSchema = z.string().uuid();

const tenantUpdateSchema = z.object({
  status: z.enum(["active", "suspended", "archived"]).optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

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
  const parsed = tenantUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid update", details: parsed.error.format() },
      { status: 400 },
    );
  }
  const u = parsed.data;
  if (Object.keys(u).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  try {
    const updated = await mark8lyTx<TenantRow | null>("platform_api", async (client) => {
      // Lock the row so concurrent writers (mark8ly's own services) can't
      // race with our mutation.
      const lock = await client.query<TenantRow>(
        `SELECT id, name, owner_user_id, owner_email, status, created_at, updated_at
         FROM tenants WHERE id = $1 FOR UPDATE`,
        [idCheck.data],
      );
      if (lock.rows.length === 0) return null;

      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (u.status !== undefined) { sets.push(`status = $${i++}`); values.push(u.status); }
      if (u.name !== undefined) { sets.push(`name = $${i++}`); values.push(u.name); }
      sets.push(`updated_at = now()`);
      values.push(idCheck.data);

      const res = await client.query<TenantRow>(
        `UPDATE tenants SET ${sets.join(", ")}
         WHERE id = $${i}
         RETURNING id, name, owner_user_id, owner_email, status, created_at, updated_at`,
        values,
      );
      return res.rows[0];
    });

    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ tenant: updated });
  } catch (err) {
    logger.error("[tenants PATCH] failed", err);
    return NextResponse.json({ error: "update failed" }, { status: 500 });
  }
}
