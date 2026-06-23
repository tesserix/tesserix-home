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

import { getCurrentSession } from "@/lib/auth/session-jwt";
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
  if (!OTTO_INTERNAL_AUTH) {
    return NextResponse.json(
      { error: "not_configured", message: "OTTO_INTERNAL_AUTH unset" },
      { status: 503 },
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
    // On a non-2xx from otto, pass it through untouched.
    if (!res.ok) {
      const text = await res.text();
      const out = new NextResponse(text, { status: res.status });
      out.headers.set(
        "Content-Type",
        res.headers.get("Content-Type") || "application/json",
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
    return NextResponse.json(
      {
        error: "upstream_unreachable",
        message: err instanceof Error ? err.message : "otto unreachable",
      },
      { status: 502 },
    );
  }
}
