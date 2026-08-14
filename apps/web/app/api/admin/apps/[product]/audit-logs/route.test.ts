import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/mark8ly-audit", () => ({
  listAuditLogs: vi.fn(async () => []),
  getCriticalEventCount: vi.fn(async () => 0),
  getAuditFilterOptions: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db/mark8ly", () => ({ mark8lyQuery: vi.fn(async () => ({ rows: [] })) }));

import { GET } from "./route";

function req() {
  return new Request("http://x/api/admin/apps/homechef/audit-logs") as never;
}

describe("[product]/audit-logs", () => {
  it("404s for homechef instead of returning mark8ly rows", async () => {
    const res = await GET(req(), { params: Promise.resolve({ product: "homechef" }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unsupported_product" });
  });

  it("still serves mark8ly", async () => {
    const res = await GET(req(), { params: Promise.resolve({ product: "mark8ly" }) });
    expect(res.status).toBe(200);
  });
});
