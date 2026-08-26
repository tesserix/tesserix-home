// GET /api/admin/tenants/:id — one tenant, read from mark8ly's database.
//
// # The PATCH that used to live here is gone (#210)
//
// It ran `UPDATE tenants SET ...` against mark8ly's `tenants` table over the
// `mark8ly_platform_admin` grant, and every invariant mark8ly's own API would
// have enforced was bypassed: validation, domain events, cache invalidation,
// and mark8ly's own audit row. mark8ly had no record that the platform had
// changed one of its core entities.
//
// It stayed only because there was no alternative. There is now: mark8ly
// exposes POST /admin/tenants/{id}/suspend and /unsuspend (mark8ly#287), the
// platform API federates them (#344), and the console drives them from the
// tenant directory (#346) — through mark8ly's own API, so its invariants run
// and its audit row is written inside the transaction that changed the row.
//
// # The GET remains, deliberately
//
// This route's READ is a different risk class and belongs to #160, which owns
// the cross-database grant as a whole. Removing it today would break the
// tenant detail page and the deep links into it from the erasure queue,
// break-glass and onboarding — and the console has a tenant LIST, not a tenant
// DETAIL, so there is nowhere yet to send them. A stale read is a wrong number
// on a screen; the write was a corrupt row in another product's primary table.
// Only one of those had to go today.
//
// Retiring the read is #272's job, once a console detail surface exists.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { mark8lyQuery } from "@/lib/db/mark8ly";
import type { TenantRow } from "@/lib/db/types";
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
    const result = await mark8lyQuery<TenantRow>(
      "platform_api",
      `SELECT id, name, owner_user_id, owner_email, status, created_at, updated_at
       FROM tenants WHERE id = $1`,
      [idCheck.data],
    );
    const tenant = result.rows[0];
    if (!tenant) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ tenant });
  } catch (err) {
    logger.error("[tenants GET single] failed", err);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
