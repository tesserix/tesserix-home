// Read-only HTTP client for the dedicated OpenTelemetry ClickHouse
// (clickhouse-otel.observability). Powers the platform Observability page:
// service health, throughput, latency and traces from the otel_* tables the
// collector writes. Credentials come from env (provisioned via ExternalSecret
// in the tesserix ns); auth goes in headers, never the URL.
//
// In-cluster traffic; the API routes that use this are admin-gated.

const CH_URL = (
  process.env.CLICKHOUSE_OTEL_URL ??
  "http://clickhouse-otel.observability.svc.cluster.local:8123"
).replace(/\/+$/, "");
const CH_USER = process.env.CLICKHOUSE_OTEL_USER ?? "default";
const CH_PASSWORD = process.env.CLICKHOUSE_OTEL_PASSWORD ?? "";
const TIMEOUT_MS = 15_000;

/** Whether ClickHouse is reachable (env present). */
export function clickhouseConfigured(): boolean {
  return Boolean(CH_URL);
}

/**
 * Runs a read-only SQL query and returns the rows as typed objects
 * (ClickHouse JSONEachRow — one JSON object per line).
 */
export async function chQuery<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // quote_64bit_integers=0 so count()/UInt64 come back as JSON numbers
    // (not strings) — the charts need real numbers.
    const res = await fetch(
      `${CH_URL}/?default_format=JSONEachRow&output_format_json_quote_64bit_integers=0`,
      {
      method: "POST",
      headers: {
        "X-ClickHouse-User": CH_USER,
        "X-ClickHouse-Key": CH_PASSWORD,
        "Content-Type": "text/plain",
      },
      body: sql,
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`clickhouse ${res.status}: ${body.slice(0, 300)}`);
    }
    const text = (await res.text()).trim();
    if (!text) return [];
    return text.split("\n").map((line) => JSON.parse(line) as T);
  } finally {
    clearTimeout(t);
  }
}
