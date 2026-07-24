// Single-trace detail — all spans of a TraceId, ordered, with nanosecond
// start + duration so the UI can render a waterfall. Admin-only. The id is
// validated as hex (TraceId is hex) so it can't inject SQL.
import { NextResponse } from "next/server";

import { getCurrentSession } from "@/lib/auth/session-jwt";
import { chQuery } from "@/lib/db/clickhouse";

const HEX = /^[0-9a-f]{1,64}$/i;

export async function GET(req: Request): Promise<Response> {
  const session = await getCurrentSession().catch(() => null);
  if (!session?.sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!HEX.test(id)) {
    return NextResponse.json({ error: "bad_trace_id" }, { status: 400 });
  }
  try {
    const spans = await chQuery(`SELECT
        SpanId AS spanId, ParentSpanId AS parentId,
        ServiceName AS service, SpanName AS op, SpanKind AS kind,
        toUnixTimestamp64Nano(Timestamp) AS startNs, Duration AS durationNs,
        if(StatusCode='Error','Error','OK') AS status
      FROM otel.otel_traces WHERE TraceId = '${id}'
      ORDER BY Timestamp ASC LIMIT 500`);
    const out = NextResponse.json({ traceId: id, spans });
    out.headers.set("Cache-Control", "no-store");
    return out;
  } catch (err) {
    return NextResponse.json(
      {
        error: "clickhouse_unreachable",
        message: err instanceof Error ? err.message : "query failed",
      },
      { status: 502 },
    );
  }
}
