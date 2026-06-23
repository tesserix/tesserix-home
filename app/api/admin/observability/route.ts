// Platform Observability API — reads the dedicated OTel ClickHouse
// (otel_traces). Trace-centric: the unit is a ROOT span (ParentSpanId='')
// i.e. a real distributed trace's entry point, so every instrumentation
// style is covered (mark8ly gin Server spans, devai pipeline spans, etc.).
// Returns: overview KPIs, per-app rollup, throughput + latency time-series,
// status distribution, top slow / error operations, per-service table, and a
// recent-traces list. Admin-only; range + app are whitelisted.
import { NextResponse } from "next/server";

import { getCurrentSession } from "@/lib/auth/session-jwt";
import { chQuery } from "@/lib/db/clickhouse";

const RANGES: Record<string, { interval: string; bucket: string }> = {
  "1h": { interval: "1 HOUR", bucket: "1 MINUTE" },
  "24h": { interval: "24 HOUR", bucket: "30 MINUTE" },
  "7d": { interval: "7 DAY", bucket: "6 HOUR" },
};

// app -> ServiceName prefix filter (whitelisted; no raw user input in SQL).
const APP_FILTER: Record<string, string> = {
  mark8ly: "ServiceName LIKE 'mark8ly-%'",
  fe3dr: "ServiceName LIKE 'homechef-%'",
  platform: "ServiceName LIKE 'support-platform-%'",
  devai: "ServiceName LIKE 'devai-%'",
};

// Derived app label from the service prefix.
const APP_CASE = `multiIf(
  ServiceName LIKE 'mark8ly-%','mark8ly',
  ServiceName LIKE 'homechef-%','fe3dr',
  ServiceName LIKE 'support-platform-%','platform',
  ServiceName LIKE 'devai-%','devai','other')`;

// OTel status: 'Error' = failure; 'Unset'/'Ok' = success.
const ERR = "StatusCode = 'Error'";

export async function GET(req: Request): Promise<Response> {
  const session = await getCurrentSession().catch(() => null);
  if (!session?.sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const r = RANGES[url.searchParams.get("range") ?? "24h"] ?? RANGES["24h"];
  const appKey = url.searchParams.get("app") ?? "";
  const appClause = APP_FILTER[appKey] ? ` AND ${APP_FILTER[appKey]}` : "";

  // Root spans = traces. base respects the app filter; baseAll never does
  // (per-app cards always show every app).
  const root = `ParentSpanId = '' AND Timestamp >= now() - INTERVAL ${r.interval}`;
  const base = `FROM otel.otel_traces WHERE ${root}${appClause}`;
  const baseAll = `FROM otel.otel_traces WHERE ${root}`;

  try {
    const [overview, byApp, throughput, latency, statusDist, topSlow, topErrors, byService, recentTraces] =
      await Promise.all([
        chQuery(`SELECT count() AS requests,
            round(100 * countIf(${ERR}) / greatest(count(),1), 2) AS errorRate,
            round(quantile(0.95)(Duration)/1e6, 1) AS p95Ms,
            uniqExact(ServiceName) AS services ${base}`),
        chQuery(`SELECT ${APP_CASE} AS app, count() AS requests,
            round(100 * countIf(${ERR}) / greatest(count(),1), 2) AS errorRate,
            round(quantile(0.95)(Duration)/1e6, 1) AS p95Ms,
            uniqExact(ServiceName) AS services
            ${baseAll} GROUP BY app ORDER BY requests DESC`),
        chQuery(`SELECT toStartOfInterval(Timestamp, INTERVAL ${r.bucket}) AS t,
            count() AS requests, countIf(${ERR}) AS errors
            ${base} GROUP BY t ORDER BY t`),
        chQuery(`SELECT toStartOfInterval(Timestamp, INTERVAL ${r.bucket}) AS t,
            round(quantile(0.50)(Duration)/1e6,1) AS p50Ms,
            round(quantile(0.95)(Duration)/1e6,1) AS p95Ms,
            round(quantile(0.99)(Duration)/1e6,1) AS p99Ms
            ${base} GROUP BY t ORDER BY t`),
        chQuery(`SELECT if(StatusCode='Error','Error','OK') AS status, count() AS count
            ${base} GROUP BY status ORDER BY count DESC`),
        chQuery(`SELECT ServiceName AS service, SpanName AS op, count() AS count,
            round(quantile(0.95)(Duration)/1e6,1) AS p95Ms
            ${base} GROUP BY service, op ORDER BY p95Ms DESC LIMIT 8`),
        chQuery(`SELECT ServiceName AS service, SpanName AS op, countIf(${ERR}) AS errors,
            count() AS count
            ${base} GROUP BY service, op HAVING errors > 0 ORDER BY errors DESC LIMIT 8`),
        chQuery(`SELECT ServiceName AS service, ${APP_CASE} AS app, count() AS requests,
            round(100 * countIf(${ERR}) / greatest(count(),1), 2) AS errorRate,
            round(quantile(0.50)(Duration)/1e6,1) AS p50Ms,
            round(quantile(0.95)(Duration)/1e6,1) AS p95Ms,
            round(quantile(0.99)(Duration)/1e6,1) AS p99Ms
            ${base} GROUP BY service, app ORDER BY requests DESC LIMIT 50`),
        chQuery(`SELECT TraceId AS traceId, ServiceName AS service, ${APP_CASE} AS app,
            SpanName AS op, round(Duration/1e6,1) AS durationMs,
            if(StatusCode='Error','Error','OK') AS status, Timestamp AS ts
            ${base} ORDER BY Timestamp DESC LIMIT 60`),
      ]);

    const out = NextResponse.json({
      range: url.searchParams.get("range") ?? "24h",
      app: appKey || "all",
      overview: overview[0] ?? { requests: 0, errorRate: 0, p95Ms: 0, services: 0 },
      byApp,
      throughput,
      latency,
      statusDist,
      topSlow,
      topErrors,
      byService,
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
