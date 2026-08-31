// Server-side proxy for the platform-wide Otto support analytics.
//
// Admin-only: requires a valid tesserix-home admin session, then calls
// otto's CROSS-TENANT platform-stats endpoint with the internal shared
// secret. otto's PlatformAuth denies on an empty secret, so this surface
// (data across every tenant) never falls open. Mirrors the otto proxy's
// auth wiring but targets /api/v1/platform/otto/stats instead of the
// store-scoped storefront/admin surfaces.
//
// The otto rollup keys "by_tenant" on raw tenant ids. We enrich the
// response with a `tenant_names` map: mark8ly tenants (UUIDs) resolve to
// their display name from the mark8ly platform DB; non-UUID ids (e.g.
// "fanzone", "platform" — other products / the platform itself) are just
// humanized. Resolution is best-effort: any DB failure leaves the raw id.
import { NextResponse } from "next/server";

import { getCurrentSession } from "@tesserix/platform-auth";
import { mark8lyQuery } from "@/lib/db/mark8ly";

const OTTO_URL = (process.env.OTTO_URL ?? "http://localhost:8089").replace(
  /\/+$/,
  "",
);
const OTTO_INTERNAL_AUTH = (process.env.OTTO_INTERNAL_AUTH ?? "").trim();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function humanize(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function resolveTenantNames(
  ids: string[],
): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const uuids: string[] = [];
  for (const id of ids) {
    if (UUID_RE.test(id)) uuids.push(id);
    else names[id] = humanize(id); // "fanzone" -> "Fanzone", "platform" -> "Platform"
  }
  if (uuids.length === 0) return names;
  try {
    const res = await mark8lyQuery<{ id: string; name: string }>(
      "platform_api",
      "SELECT id::text AS id, name FROM tenants WHERE id = ANY($1::uuid[])",
      [uuids],
    );
    for (const r of res.rows) {
      if (r.name) names[r.id] = r.name;
    }
  } catch {
    // Fail-soft: unresolved UUIDs fall back to the raw id in the UI.
  }
  return names;
}

export async function GET(): Promise<Response> {
  const session = await getCurrentSession().catch(() => null);
  if (!session?.sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // 501, not 503, when the secret is unset. The console reads a status, not a
  // body: `apps/console/components/kit/surface-state.ts` maps 501 onto
  // `instrumentation-unavailable` — the calm "not measured yet" callout — and
  // maps EVERY other non-2xx onto a red error state. An unset
  // OTTO_INTERNAL_AUTH is not a fault; it is an integration nobody switched on
  // yet, and answering 503 told an operator that platform support analytics
  // were BROKEN when they had simply never been wired. See #198.
  //
  // The distinction the contract turns on: 501 means "never wired", 5xx below
  // means "wired and not answering". The 502 in the catch must stay a 502 — an
  // otto that was reached and failed is a real fault and should read as one.
  // The full contract is stated in docs/PLATFORM-API-CONVENTIONS.md §1c, and
  // apps/web/app/api/admin/apps/[product]/audit-logs/route.ts's header is the
  // worked example.
  if (!OTTO_INTERNAL_AUTH) {
    return NextResponse.json(
      { error: "not_configured", message: "OTTO_INTERNAL_AUTH unset" },
      { status: 501 },
    );
  }
  try {
    const res = await fetch(`${OTTO_URL}/api/v1/platform/otto/stats`, {
      method: "GET",
      headers: {
        "X-Internal-Auth": OTTO_INTERNAL_AUTH,
        "X-User-Id": session.sub,
      },
      cache: "no-store",
    });
    // On a non-2xx from otto, return a generic error — don't echo the upstream
    // body, which can leak internal host/IP/stack details to the client.
    if (!res.ok) {
      const out = NextResponse.json(
        { error: "upstream_error" },
        { status: res.status },
      );
      out.headers.set("Cache-Control", "no-store");
      return out;
    }
    const stats = (await res.json()) as {
      by_tenant?: Record<string, number>;
    } & Record<string, unknown>;
    const tenant_names = await resolveTenantNames(
      Object.keys(stats.by_tenant ?? {}),
    );
    const out = NextResponse.json({ ...stats, tenant_names });
    out.headers.set("Cache-Control", "no-store");
    return out;
  } catch (err) {
    console.error("[otto-analytics] upstream request failed:", err);
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
}
