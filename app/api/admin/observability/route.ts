// Platform Observability API — reads the dedicated OTel ClickHouse
// (otel_traces) and returns service health: overview KPIs, per-service
// breakdown, throughput + latency time-series, and recent traces.
// Admin-only (tesserix-home session). Range is whitelisted (no SQL injection).
import { NextResponse } from "next/server";

import { getCurrentSession } from "@/lib/auth/session-jwt";
import { chQuery } from "@/lib/db/clickhouse";

// Whitelisted ranges → ClickHouse INTERVAL + time-series bucket.
const RANGES: Record<string, { interval: string; bucket: string }> = {
  "1h": { interval: "1 HOUR", bucket: "1 MINUTE" },
  "24h": { interval: "24 HOUR", bucket: "30 MINUTE" },
  "7d": { interval: "7 DAY", bucket: "6 HOUR" },
};

// OTel exporter writes short status/kind ('Error','Server'); some versions use
// the enum form. Match both so the numbers are correct either way.
const ERR = "StatusCode IN ('Error','STATUS_CODE_ERROR')";
const SERVER = "SpanKind IN ('Server','SPAN_KIND_SERVER')";

export async function GET(req: Request): Promise<Response> {
  const session = await getCurrentSession().catch(() => null);
  if (!session?.sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const rangeKey = url.searchParams.get("range") ?? "24h";
  const r = RANGES[rangeKey] ?? RANGES["24h"];
  const since = `Timestamp >= now() - INTERVAL ${r.interval}`;
  const base = `FROM otel.otel_traces WHERE ${since} AND ${SERVER}`;

  try {
    const [overview, byService, throughput, latency, recentTraces] =
      await Promise.all([
        chQuery(`SELECT count() AS requests,
            round(100 * countIf(${ERR}) / greatest(count(), 1), 2) AS errorRate,
            round(quantile(0.95)(Duration) / 1e6, 1) AS p95Ms,
            uniqExact(ServiceName) AS services ${base}`),
        chQuery(`SELECT ServiceName AS service, count() AS requests,
            round(100 * countIf(${ERR}) / greatest(count(), 1), 2) AS errorRate,
            round(quantile(0.50)(Duration) / 1e6, 1) AS p50Ms,
            round(quantile(0.95)(Duration) / 1e6, 1) AS p95Ms,
            round(quantile(0.99)(Duration) / 1e6, 1) AS p99Ms
            ${base} GROUP BY service ORDER BY requests DESC LIMIT 50`),
        chQuery(`SELECT toStartOfInterval(Timestamp, INTERVAL ${r.bucket}) AS t,
            count() AS requests, countIf(${ERR}) AS errors
            ${base} GROUP BY t ORDER BY t`),
        chQuery(`SELECT toStartOfInterval(Timestamp, INTERVAL ${r.bucket}) AS t,
            round(quantile(0.50)(Duration) / 1e6, 1) AS p50Ms,
            round(quantile(0.95)(Duration) / 1e6, 1) AS p95Ms,
            round(quantile(0.99)(Duration) / 1e6, 1) AS p99Ms
            ${base} GROUP BY t ORDER BY t`),
        chQuery(`SELECT Timestamp AS ts, ServiceName AS service, SpanName AS span,
            round(Duration / 1e6, 1) AS durationMs, StatusCode AS status
            ${base} ORDER BY Timestamp DESC LIMIT 50`),
      ]);

    const out = NextResponse.json({
      range: rangeKey,
      overview: overview[0] ?? { requests: 0, errorRate: 0, p95Ms: 0, services: 0 },
      byService,
      throughput,
      latency,
      recentTraces,
    });
    out.headers.set("Cache-Control", "no-store");
    return out;
  } catch (err) {
    return NextResponse.json(
      {
        error: "clickhouse_unreachable",
        message: err instanceof Error ? err.message : "clickhouse query failed",
      },
      { status: 502 },
    );
  }
}
