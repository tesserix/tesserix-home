import Link from "next/link";
import { consolePath, isPending, type RouteId } from "@tesserix/console-core";

/**
 * "View tenant" — apps/web's link at
 * `apps/web/app/admin/platform-tickets/[id]/page.tsx:193`, resolved through
 * console-core instead of hand-built.
 *
 * The rail is `platform.apps`: a tenant lives under the product it belongs to
 * (`/admin/apps/{product}/tenants/{id}` in web, `/platform/apps/...` here), so
 * the Apps surface is the route entry that owns this path. There is no
 * per-tenant route id and inventing one would put a surface in the palette and
 * the estate map that nothing serves.
 *
 * `isPending` is load-bearing, not defensive. Its contract (`routes.ts:18-30`)
 * is explicit that a renderer must not link a pending route — not in-app,
 * because the page does not exist, and not to apps/web either, because the old
 * admin is being retired and linking there would make the console a shell
 * around the app it replaces. So a pending rail renders the tenant as inert
 * text: the fact is still shown, the navigation is not offered.
 *
 * A server component. It touches neither `@tesserix/web` nor React state, so
 * it needs no `"use client"` — and must not acquire one, since the page that
 * renders it is an RSC.
 */
const TENANT_RAIL: RouteId = "platform.apps";

export interface TenantLinkProps {
  productId: string;
  tenantId: string;
}

export function TenantLink({ productId, tenantId }: TenantLinkProps) {
  // `parseTicketDetail` lets `tenant_id` be absent (it coerces to ""), so a
  // ticket genuinely may have no tenant. Say so rather than linking nowhere.
  if (tenantId === "") {
    return <span className="text-muted-foreground">No tenant</span>;
  }

  if (isPending(TENANT_RAIL)) {
    return (
      <span data-testid="tenant-link" data-pending="true" className="break-words">
        <span className="font-mono text-xs">{tenantId}</span>{" "}
        <span className="text-xs text-muted-foreground">
          — not in the console yet
        </span>
      </span>
    );
  }

  return (
    <Link
      data-testid="tenant-link"
      href={`${consolePath(TENANT_RAIL)}/${encodeURIComponent(productId)}/tenants/${encodeURIComponent(tenantId)}`}
      className="text-xs underline underline-offset-2 hover:text-foreground"
    >
      View tenant →
    </Link>
  );
}
