// Signed gateway to the HomeChef Go `/admin/*` API.
//
// ONE reusable proxy for every HomeChef admin section: the client pages call
// `/api/admin/apps/homechef/gw/<admin-path>` and this forwards (method + query +
// body) to the Go API via the HMAC-signed `homechefAdmin` client. Gated to admin
// sessions by middleware.ts; only `/admin/*` paths are reachable (the client
// prefixes `/admin`), and every write therefore flows through the Go API —
// preserving Temporal/NATS/Redis/escrow side-effects. No per-endpoint boilerplate.
import { NextResponse, type NextRequest } from "next/server";

import {
  HomechefAdminError,
  homechefAdmin,
  type AdminMethod,
} from "@/lib/api/homechef-admin";
import { logger } from "@/lib/logger";

async function proxy(req: NextRequest, segments: string[], method: AdminMethod) {
  const adminPath = `/${segments.join("/")}`;
  const search = req.nextUrl.searchParams;

  let body: unknown;
  if (method !== "GET") {
    const raw = await req.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "invalid_json" }, { status: 400 });
      }
    }
  }

  try {
    const { status, data } = await homechefAdmin(method, adminPath, { body, search });
    // Pass the body through UNCHANGED — `data ?? {}` used to sit here, and it
    // silently changed the shape of every empty response.
    //
    // A Go handler that returns a nil slice serialises as JSON `null`, so an
    // endpoint with no rows yet (GET /admin/activities on a quiet day) arrived
    // here as null and left as `{}`. Callers then did `data ?? []`, which does
    // not catch `{}`, and the next `.map` threw "v.map is not a function" —
    // meaning a page broke precisely because it had no data to show.
    //
    // null is a valid JSON body. Forwarding it lets the caller's own `?? []`
    // work as written.
    return NextResponse.json(data ?? null, { status });
  } catch (err) {
    if (err instanceof HomechefAdminError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    logger.error(`[homechef-gw] ${method} ${adminPath} failed`, err);
    return NextResponse.json({ error: "gateway_error" }, { status: 500 });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path, "GET");
}
export async function POST(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path, "POST");
}
export async function PUT(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path, "PUT");
}
export async function PATCH(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path, "PATCH");
}
export async function DELETE(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path, "DELETE");
}
