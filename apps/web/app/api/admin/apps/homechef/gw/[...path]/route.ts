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
    return NextResponse.json(data ?? {}, { status });
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
export async function DELETE(req: NextRequest, { params }: Ctx) {
  return proxy(req, (await params).path, "DELETE");
}
