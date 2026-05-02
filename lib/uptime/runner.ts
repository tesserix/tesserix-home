// M1 — synthetic probe runner.
// One pass: collect all storefront subdomains per product, fan out
// HEAD requests with a tight timeout, persist results.

import { mark8lyQuery } from "@/lib/db/mark8ly";
import {
  recordProbeBatch,
  type ProbeResultInput,
  type ProbeTarget,
} from "@/lib/db/uptime-probes";
import { logger } from "@/lib/logger";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CONCURRENCY = 10;

/** Resolve every active mark8ly storefront subdomain. */
async function listMark8lyTargets(): Promise<ProbeTarget[]> {
  // Active stores → storefront at {slug}.mark8ly.com. Custom domains
  // are out of scope for v1; covered when domain mapping data gets
  // imported into the registry.
  const res = await mark8lyQuery<{
    tenant_id: string;
    slug: string;
  }>(
    "marketplace_api",
    `SELECT tenant_id::text, slug
     FROM stores
     WHERE status = 'active' AND slug IS NOT NULL AND slug <> ''`,
  );
  return res.rows.map((r) => ({
    productId: "mark8ly",
    tenantId: r.tenant_id,
    hostname: `${r.slug}.mark8ly.com`,
  }));
}

interface SingleProbeOutcome {
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly ok: boolean;
  readonly error: string | null;
}

async function probeOne(hostname: string): Promise<SingleProbeOutcome> {
  const url = `https://${hostname}/`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: ctrl.signal,
      // Don't follow redirects — a 301/302 to the storefront app is
      // already a "live" signal. Following would double the latency
      // budget for no probe benefit.
      redirect: "manual",
      cache: "no-store",
    });
    const latency = Date.now() - start;
    // 2xx, 3xx, 4xx are all "the origin responded". 5xx and network
    // failures are real outages. We classify 4xx as ok=true because
    // a storefront 404 still proves the routing layer is up.
    const ok = res.status < 500;
    return {
      httpStatus: res.status,
      latencyMs: latency,
      ok,
      error: ok ? null : `http_${Math.floor(res.status / 100)}xx`,
    };
  } catch (err) {
    const latency = Date.now() - start;
    const msg = err instanceof Error ? err.message : "unknown";
    let code = "network_error";
    if (msg.includes("aborted") || msg.includes("timeout")) code = "timeout";
    else if (msg.toLowerCase().includes("dns")) code = "dns_error";
    return { httpStatus: null, latencyMs: latency, ok: false, error: code };
  } finally {
    clearTimeout(timer);
  }
}

async function runWithLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    });
  await Promise.all(workers);
  return out;
}

export interface RunSummary {
  readonly probed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly elapsedMs: number;
}

export async function runProbeSweep(): Promise<RunSummary> {
  const start = Date.now();
  const targets = await listMark8lyTargets();
  if (targets.length === 0) {
    return { probed: 0, succeeded: 0, failed: 0, elapsedMs: 0 };
  }

  const outcomes = await runWithLimit(targets, PROBE_CONCURRENCY, async (t) => {
    const o = await probeOne(t.hostname);
    return { target: t, outcome: o };
  });

  const rows: ProbeResultInput[] = outcomes.map(({ target, outcome }) => ({
    productId: target.productId,
    tenantId: target.tenantId,
    hostname: target.hostname,
    httpStatus: outcome.httpStatus,
    latencyMs: outcome.latencyMs,
    ok: outcome.ok,
    error: outcome.error,
  }));
  try {
    await recordProbeBatch(rows);
  } catch (err) {
    logger.error("[uptime] failed to persist probe batch", err);
    // Surface the error so the cron pod sees a non-2xx and alerts.
    throw err;
  }

  const succeeded = rows.filter((r) => r.ok).length;
  return {
    probed: rows.length,
    succeeded,
    failed: rows.length - succeeded,
    elapsedMs: Date.now() - start,
  };
}
