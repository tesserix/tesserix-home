// B1 — Email templates registry: test send.
//
// Proxies to mark8ly's /internal/templates/:key/test endpoint. Rendering
// + sending happens in mark8ly so what the operator receives is exactly
// what production would render. We don't render here — that would risk
// previewing a different output than the actual send.
//
// Routes by `?database=` so marketplace_api templates hit marketplace-api,
// not platform-api (which doesn't know those template keys).

import { NextResponse, type NextRequest } from "next/server";
import { sendTestEmail } from "@/lib/api/mark8ly-internal";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";
import type { Mark8lyDatabase } from "@/lib/db/mark8ly";

const ALLOWED_DBS: ReadonlyArray<Mark8lyDatabase> = ["platform_api", "marketplace_api"];

function pickDB(raw: string | null): Mark8lyDatabase {
  return raw && ALLOWED_DBS.includes(raw as Mark8lyDatabase)
    ? (raw as Mark8lyDatabase)
    : "platform_api";
}

interface PostBody {
  to?: string;
  vars?: Record<string, unknown>;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const url = new URL(req.url);
  const database = pickDB(url.searchParams.get("database"));

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Default to operator's own email — safer than letting tests be
  // sent to arbitrary addresses without explicit intent. Operators
  // can override but it requires typing a deliberate value.
  let to = (body.to ?? "").trim();
  if (!to) {
    const session = await getCurrentSession().catch(() => null);
    to = session?.email ?? "";
  }
  if (!to) {
    return NextResponse.json(
      { error: "missing_to", message: "test recipient is required" },
      { status: 400 },
    );
  }

  try {
    const result = await sendTestEmail({
      database,
      key,
      to,
      vars: body.vars ?? {},
    });
    if (!result.ok) {
      logger.warn("[admin email-templates test-send] mark8ly returned error", result);
      return NextResponse.json(
        { error: "send_failed", status: result.status, message: result.errorMessage },
        { status: 502 },
      );
    }
    return NextResponse.json({ sent: true, to });
  } catch (err) {
    logger.error("[admin email-templates test-send] failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
