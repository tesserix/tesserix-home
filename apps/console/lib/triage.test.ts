import { describe, expect, it } from "vitest";
import { PlatformApiError } from "./platform-api";
import {
  parseCnpgHealth,
  parseOutbox,
  parseServiceHealth,
  parseTickets,
  triageState,
} from "./triage";

const SERVICE_HEALTH = {
  totals: { workloads: 19, healthy: 18, degraded: 1, down: 0, idle: 0, restarts24h: 3 },
  workloads: [
    { namespace: "tesserix", workload: "console", status: "healthy", readyReplicas: 2, replicas: 2 },
    { namespace: "kora", workload: "kora-api", status: "degraded", readyReplicas: 1, replicas: 2 },
  ],
  available: true,
  errorMessage: null,
  generatedAt: "2026-08-15T04:00:00.000Z",
};

const CNPG = {
  totals: { clusters: 6, healthy: 5, degraded: 1, down: 0 },
  clusters: [
    { namespace: "tesserix", cluster: "tesserix-postgres", status: "healthy", instances: 3, readyInstances: 3 },
    { namespace: "kora", cluster: "kora-postgres", status: "degraded", instances: 1, readyInstances: 0 },
  ],
  available: true,
  errorMessage: null,
  generatedAt: "2026-08-15T04:00:00.000Z",
};

const OUTBOX = {
  summaries: [
    { database: "platform_api", available: true, pending: 4, inFlight: 0, stuck: 2, dead: 1, oldestPendingAgeSeconds: 90, errorMessage: null },
  ],
  recent: [
    { database: "platform_api", id: "evt-1", kind: "tenant.created", status: "stuck", attempts: 5, ageSeconds: 900, lastError: "timeout", tenantId: null, aggregate: null, createdAt: "2026-08-15T03:45:00.000Z" },
  ],
  generatedAt: "2026-08-15T04:00:00.000Z",
};

const TICKETS = {
  summary: { open: 23, inProgress: 4, resolvedThisWeek: 11, urgentOpen: 4 },
  rows: [],
  generatedAt: "2026-08-15T04:00:00.000Z",
};

describe("parsers accept the shapes apps/web actually returns", () => {
  it("reads service health totals and workloads", () => {
    const parsed = parseServiceHealth(SERVICE_HEALTH);
    expect(parsed.totals.healthy).toBe(18);
    expect(parsed.totals.workloads).toBe(19);
    expect(parsed.available).toBe(true);
  });

  it("reads cnpg totals", () => {
    expect(parseCnpgHealth(CNPG).totals.degraded).toBe(1);
  });

  it("sums stuck and dead across outbox databases", () => {
    const parsed = parseOutbox(OUTBOX);
    // Triage cares about the total needing attention, not per-database detail.
    expect(parsed.needsAttention).toBe(3);
    expect(parsed.recent).toHaveLength(1);
  });

  it("reads the ticket summary", () => {
    expect(parseTickets(TICKETS).summary.urgentOpen).toBe(4);
  });

  it("rejects a malformed payload rather than coercing it", () => {
    expect(() => parseServiceHealth({ totals: {} })).toThrow(PlatformApiError);
    expect(() => parseTickets({ summary: { open: "23" } })).toThrow(PlatformApiError);
  });
});

describe("triageState", () => {
  it("reports instrumentation-unavailable when the source says available:false", () => {
    // The endpoints signal a parked Prometheus IN BAND — a 200 carrying
    // available:false — not an HTTP 501. Keying only off the status code
    // would render a parked plane as healthy, which is the exact failure the
    // five-state model exists to prevent.
    expect(triageState(null, { available: false })).toEqual({
      kind: "instrumentation-unavailable",
    });
  });

  it("still honours a 501 from the transport", () => {
    expect(triageState(new PlatformApiError("parked", 501), null)).toEqual({
      kind: "instrumentation-unavailable",
    });
  });

  it("reports a real failure as an error, not as uninstrumented", () => {
    expect(triageState(new PlatformApiError("boom", 500), null)).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("is ready when the payload arrived and the source is available", () => {
    expect(triageState(null, { available: true })).toEqual({ kind: "ready" });
  });

  it("treats a source with no availability flag as ready", () => {
    // Tickets and outbox have no `available` field — absence must not be read
    // as unavailable.
    expect(triageState(null, {})).toEqual({ kind: "ready" });
  });
});
