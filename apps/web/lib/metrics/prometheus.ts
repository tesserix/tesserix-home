// Prometheus query client. Reads PROMETHEUS_URL from env; no auth (in-cluster
// service is open within the mesh — verified live 2026-05-01). Includes a
// 60-second in-memory cache keyed by (query, time-bucket) so multi-operator
// page views don't fan out to repeated upstream queries.

import { logger } from "@/lib/logger";

const PROMETHEUS_URL = process.env.PROMETHEUS_URL;
const CACHE_TTL_MS = 60_000;

interface PromValue {
  readonly time: number;
  readonly value: number;
}

export interface PromInstantResult {
  readonly metric: Readonly<Record<string, string>>;
  readonly value: PromValue;
}

export interface PromRangeResult {
  readonly metric: Readonly<Record<string, string>>;
  readonly values: ReadonlyArray<PromValue>;
}

interface CacheEntry<T> {
  readonly storedAt: number;
  readonly result: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result as T;
}

function setCached<T>(key: string, result: T): void {
  cache.set(key, { storedAt: Date.now(), result });
}

function requireUrl(): string {
  if (!PROMETHEUS_URL) {
    throw new Error("PROMETHEUS_URL env not set");
  }
  return PROMETHEUS_URL;
}

function parseValue(raw: [number, string]): PromValue {
  return { time: raw[0] * 1000, value: Number(raw[1]) };
}

export async function queryInstant(promql: string, atSeconds?: number): Promise<ReadonlyArray<PromInstantResult>> {
  const url = requireUrl();
  const bucketSec = atSeconds ?? Math.floor(Date.now() / 1000 / 60) * 60;
  const cacheKey = `instant:${promql}:${bucketSec}`;

  const cached = getCached<ReadonlyArray<PromInstantResult>>(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({ query: promql, time: String(bucketSec) });
  const res = await fetch(`${url}/api/v1/query?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) {
    logger.error("prometheus instant query failed", { status: res.status, promql });
    throw new Error(`prometheus_unavailable: ${res.status}`);
  }
  const body = (await res.json()) as {
    status: string;
    data: { resultType: string; result: Array<{ metric: Record<string, string>; value: [number, string] }> };
  };
  if (body.status !== "success") {
    throw new Error(`prometheus_error: ${body.status}`);
  }
  const out: ReadonlyArray<PromInstantResult> = body.data.result.map((r) => ({
    metric: r.metric,
    value: parseValue(r.value),
  }));
  setCached(cacheKey, out);
  return out;
}

export async function queryRange(
  promql: string,
  startSeconds: number,
  endSeconds: number,
  stepSeconds: number,
): Promise<ReadonlyArray<PromRangeResult>> {
  const url = requireUrl();
  const cacheKey = `range:${promql}:${Math.floor(startSeconds / 60)}:${Math.floor(endSeconds / 60)}:${stepSeconds}`;

  const cached = getCached<ReadonlyArray<PromRangeResult>>(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    query: promql,
    start: String(startSeconds),
    end: String(endSeconds),
    step: String(stepSeconds),
  });
  const res = await fetch(`${url}/api/v1/query_range?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) {
    logger.error("prometheus range query failed", { status: res.status, promql });
    throw new Error(`prometheus_unavailable: ${res.status}`);
  }
  const body = (await res.json()) as {
    status: string;
    data: { resultType: string; result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> };
  };
  if (body.status !== "success") {
    throw new Error(`prometheus_error: ${body.status}`);
  }
  const out: ReadonlyArray<PromRangeResult> = body.data.result.map((r) => ({
    metric: r.metric,
    values: r.values.map(parseValue),
  }));
  setCached(cacheKey, out);
  return out;
}

export function clearCache(): void {
  cache.clear();
}
