import { beforeEach, describe, expect, it, vi } from "vitest";

// Each product's real source is mocked at ITS OWN boundary rather than the
// route's, so the normalisation this route exists to perform is exercised for
// real. A test that mocked `fetchAuditSource` would pass even if every
// normaliser emitted the wrong shape.

// vi.hoisted, not bare consts: `vi.mock` factories run when the mocked module
// is first imported, which happens during the hoisted `import { GET }` below —
// before any plain top-level const has been initialised.
const mocks = vi.hoisted(() => ({
  listAuditLogs: vi.fn(),
  getCriticalEventCount: vi.fn(),
  getAuditFilterOptions: vi.fn(),
  mark8lyQuery: vi.fn(),
  listKoraEvents: vi.fn(),
  homechefAdmin: vi.fn(),
}));
const {
  listAuditLogs,
  getCriticalEventCount,
  getAuditFilterOptions,
  mark8lyQuery,
  listKoraEvents,
  homechefAdmin,
} = mocks;

vi.mock("@/lib/db/mark8ly-audit", () => ({
  listAuditLogs: mocks.listAuditLogs,
  getCriticalEventCount: mocks.getCriticalEventCount,
  getAuditFilterOptions: mocks.getAuditFilterOptions,
}));
vi.mock("@/lib/db/mark8ly", () => ({ mark8lyQuery: mocks.mark8lyQuery }));
vi.mock("@/lib/api/kora-admin", () => ({ listKoraEvents: mocks.listKoraEvents }));
vi.mock("@/lib/api/homechef-admin", () => ({ homechefAdmin: mocks.homechefAdmin }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GET } from "./route";

interface WireEntry {
  id: string;
  actor: string;
  action: string;
  target?: string;
  timestamp: string;
  metadata?: string;
}
interface WireBody {
  product: string;
  entries: WireEntry[];
  failures: { source: string; message: string }[];
  summary: { criticalLast24h: number | null };
  rows?: unknown[];
}

function call(product: string, query = "") {
  const req = new Request(
    `http://x/api/admin/apps/${product}/audit-logs${query}`,
  ) as never;
  return GET(req, { params: Promise.resolve({ product }) });
}

const MARK8LY_ROW = {
  id: "m-1",
  tenant_id: "11111111-1111-1111-1111-111111111111",
  store_id: "s-1",
  actor_user_id: "u-1",
  actor_email: "owner@mark8ly.test",
  actor_type: "user",
  action: "store.settings.update",
  resource_type: "store",
  resource_id: "s-1",
  status: "success",
  severity: "critical",
  ip_address: "10.0.0.1",
  user_agent: "curl",
  metadata: { field: "currency" },
  created_at: new Date("2026-08-10T10:00:00.000Z"),
};

const KORA_EVENT = {
  id: "k-1",
  actor_id: "ka-1",
  actor_email: "admin@kora.test",
  action: "food.update",
  target_type: "food",
  target_id: "f-1",
  before: { kcal: 1 },
  after: { kcal: 2 },
  created_at: "2026-08-11T10:00:00.000Z",
};

const HOMECHEF_ROW = {
  id: "h-1",
  userId: "hu-1",
  action: "chef.payout.release",
  entityType: "chef",
  entityId: "c-1",
  oldValue: '{"status":"pending"}',
  newValue: '{"status":"released"}',
  ipAddress: "10.1.2.3",
  createdAt: "2026-08-12T10:00:00.000Z",
  user: { firstName: "Ada", lastName: "Lovelace", email: "ada@fe3dr.test" },
};

/** A `not_configured` failure as both signed clients raise it. */
function notConfigured(): Error {
  return Object.assign(new Error("API_URL / HMAC key are not set"), {
    status: 500,
    code: "not_configured",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getCriticalEventCount.mockResolvedValue(3);
  getAuditFilterOptions.mockResolvedValue({ actions: [], resourceTypes: [] });
  mark8lyQuery.mockResolvedValue({ rows: [] });
  listAuditLogs.mockResolvedValue([MARK8LY_ROW]);
  listKoraEvents.mockResolvedValue({ items: [KORA_EVENT], total: 1 });
  homechefAdmin.mockResolvedValue({ status: 200, data: { logs: [HOMECHEF_ROW], total: 1 } });
});

/** Asserts the six-field wire contract — not just "an object came back". */
function expectAuditLogEntry(entry: WireEntry) {
  expect(typeof entry.id).toBe("string");
  expect(entry.id).not.toBe("");
  expect(typeof entry.actor).toBe("string");
  expect(entry.actor).not.toBe("");
  expect(typeof entry.action).toBe("string");
  expect(typeof entry.timestamp).toBe("string");
  expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
  if (entry.target !== undefined) expect(typeof entry.target).toBe("string");
  // metadata is a STRING on this wire shape, not an object.
  if (entry.metadata !== undefined) expect(typeof entry.metadata).toBe("string");
}

describe("[product]/audit-logs — the 404 gate", () => {
  it("404s an unknown product rather than returning an empty list", async () => {
    const res = await call("dwellm8");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unsupported_product" });
  });

  it("never reads any source for an unknown product", async () => {
    await call("devai");
    expect(listAuditLogs).not.toHaveBeenCalled();
    expect(listKoraEvents).not.toHaveBeenCalled();
    expect(homechefAdmin).not.toHaveBeenCalled();
  });
});

describe("[product]/audit-logs — normalisation", () => {
  it("normalises mark8ly onto AuditLogEntry", async () => {
    const res = await call("mark8ly");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireBody;
    expect(body.entries).toHaveLength(1);
    expectAuditLogEntry(body.entries[0]);
    expect(body.entries[0]).toMatchObject({
      id: "m-1",
      actor: "owner@mark8ly.test",
      action: "store.settings.update",
      target: "store:s-1",
      timestamp: "2026-08-10T10:00:00.000Z",
    });
    expect(JSON.parse(body.entries[0].metadata!)).toMatchObject({ severity: "critical" });
  });

  it("normalises kora onto AuditLogEntry", async () => {
    const res = await call("kora");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireBody;
    expect(body.entries).toHaveLength(1);
    expectAuditLogEntry(body.entries[0]);
    expect(body.entries[0]).toMatchObject({
      id: "k-1",
      actor: "admin@kora.test",
      action: "food.update",
      target: "food:f-1",
      timestamp: "2026-08-11T10:00:00.000Z",
    });
  });

  it("normalises homechef onto AuditLogEntry", async () => {
    const res = await call("homechef");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireBody;
    expect(body.entries).toHaveLength(1);
    expectAuditLogEntry(body.entries[0]);
    expect(body.entries[0]).toMatchObject({
      id: "h-1",
      actor: "Ada Lovelace",
      action: "chef.payout.release",
      target: "chef:c-1",
      timestamp: "2026-08-12T10:00:00.000Z",
    });
  });

  it("carries homechef's null userId across as a system actor, not a blank", async () => {
    homechefAdmin.mockResolvedValue({
      status: 200,
      data: { logs: [{ ...HOMECHEF_ROW, userId: null, user: undefined }] },
    });
    const body = (await (await call("homechef")).json()) as WireBody;
    expect(body.entries[0].actor).toBe("system");
  });

  it("reports criticalLast24h as null for a product with no severity concept", async () => {
    const kora = (await (await call("kora")).json()) as WireBody;
    expect(kora.summary.criticalLast24h).toBeNull();
    const mark8ly = (await (await call("mark8ly")).json()) as WireBody;
    expect(mark8ly.summary.criticalLast24h).toBe(3);
  });
});

describe("[product]/audit-logs — the original bug", () => {
  it("does not serve mark8ly's rows under another product's URL", async () => {
    for (const product of ["kora", "homechef"]) {
      const body = (await (await call(product)).json()) as WireBody;
      expect(body.entries.map((e) => e.id)).not.toContain("m-1");
      expect(body.rows).toBeUndefined();
    }
    // ...and mark8ly's own source was never even consulted.
    expect(listAuditLogs).not.toHaveBeenCalled();
  });

  it("does not leak mark8ly's critical count into another product's summary", async () => {
    const body = (await (await call("homechef")).json()) as WireBody;
    expect(body.summary.criticalLast24h).not.toBe(3);
    expect(getCriticalEventCount).not.toHaveBeenCalled();
  });
});

describe("[product]/audit-logs — the 501 contract", () => {
  it("answers 501, not 503 and not 500, when the upstream is unconfigured", async () => {
    listKoraEvents.mockRejectedValue(notConfigured());
    const res = await call("kora");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; failures: { source: string }[] };
    expect(body.error).toBe("not_configured");
    expect(body.failures.map((f) => f.source)).toEqual(["kora"]);
  });

  it("answers 501 for mark8ly's bare unconfigured-DB Error, which carries no code", async () => {
    listAuditLogs.mockRejectedValue(
      new Error("mark8ly DB env not set: MARK8LY_DB_HOST/USER/PASSWORD required"),
    );
    expect((await call("mark8ly")).status).toBe(501);
  });

  it("answers 502, not 501, for a configured-but-broken upstream", async () => {
    listKoraEvents.mockRejectedValue(
      Object.assign(new Error("upstream_unreachable"), { status: 502, code: "upstream_unreachable" }),
    );
    const res = await call("kora");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("audit_unavailable");
  });

  it("does not answer 200 with an empty list when the only source failed", async () => {
    homechefAdmin.mockResolvedValue({ status: 403, data: { error: "forbidden" } });
    const res = await call("homechef");
    expect(res.status).not.toBe(200);
  });
});

describe("[product]/audit-logs — partial results across products", () => {
  it("one product failing yields the others' rows plus a named failure", async () => {
    listKoraEvents.mockRejectedValue(new Error("kora-api is down"));

    const res = await call("all");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireBody;

    // Guards the guard: "returns 200" also passes when every source silently
    // returned nothing, which is the failure mode this endpoint exists to
    // prevent. Assert the surviving rows are actually present and are the
    // ones from the sources that did NOT fail.
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.map((e) => e.id).sort()).toEqual(["h-1", "m-1"]);
    for (const entry of body.entries) expectAuditLogEntry(entry);

    expect(body.failures).toEqual([{ source: "kora", message: "kora-api is down" }]);
  });

  it("merges every source newest-first when all of them succeed", async () => {
    const body = (await (await call("all")).json()) as WireBody;
    expect(body.failures).toEqual([]);
    expect(body.entries.map((e) => e.id)).toEqual(["h-1", "k-1", "m-1"]);
  });

  it("still fails as a whole when every source fails", async () => {
    listAuditLogs.mockRejectedValue(new Error("db down"));
    listKoraEvents.mockRejectedValue(new Error("kora down"));
    homechefAdmin.mockRejectedValue(new Error("homechef down"));
    const res = await call("all");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { failures: { source: string }[] };
    expect(body.failures.map((f) => f.source).sort()).toEqual(["homechef", "kora", "mark8ly"]);
  });

  it("is 501 only when EVERY failure is an unconfigured upstream", async () => {
    listAuditLogs.mockRejectedValue(
      new Error("mark8ly DB env not set: MARK8LY_DB_HOST/USER/PASSWORD required"),
    );
    listKoraEvents.mockRejectedValue(notConfigured());
    homechefAdmin.mockRejectedValue(notConfigured());
    expect((await call("all")).status).toBe(501);

    // One genuine outage among them makes the whole thing an outage, not a
    // parked data plane — 501 would tell an operator there is nothing to fix.
    homechefAdmin.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect((await call("all")).status).toBe(502);
  });
});

describe("[product]/audit-logs — legacy mark8ly body", () => {
  it("still serves the rows/filterOptions the mark8ly page reads", async () => {
    const res = await call("mark8ly", "?severity=critical&since_hours=168");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireBody & { filterOptions?: unknown; sinceHours: number };
    expect(body.rows).toHaveLength(1);
    expect(body.filterOptions).toBeDefined();
    expect(body.sinceHours).toBe(168);
    expect(listAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "critical", sinceHours: 168 }),
    );
  });
});
