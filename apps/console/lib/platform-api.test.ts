import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError, fetchDashboard, parseDashboard } from "./platform-api";

const VALID = {
  tenants: { total: 12, active: 9 },
  stores: { total: 4 },
  leads: {
    by_status: { new: 3, contacted: 2, qualified: 1, converted: 5, lost: 0 },
    total: 11,
  },
  apps: { active: 6 },
  generated_at: "2026-08-14T07:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseDashboard", () => {
  it("accepts the documented shape", () => {
    expect(parseDashboard(VALID)).toEqual(VALID);
  });

  it("rejects a response missing a section rather than coercing it", () => {
    // A silently-wrong dashboard is worse than a visibly broken one: if the
    // contract drifts, the operator must see an error, not zeroes.
    const { tenants: _omitted, ...withoutTenants } = VALID;
    expect(() => parseDashboard(withoutTenants)).toThrow(PlatformApiError);
  });

  it("rejects a non-numeric count", () => {
    expect(() =>
      parseDashboard({ ...VALID, stores: { total: "4" } }),
    ).toThrow(PlatformApiError);
  });
});

describe("fetchDashboard", () => {
  it("forwards the caller's session cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(VALID), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchDashboard("tx_session=abc123");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("cookie")).toBe("tx_session=abc123");
  });

  it("preserves a 501 so the surface can report instrumentation-unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 501 })),
    );

    await expect(fetchDashboard("c=1")).rejects.toMatchObject({ status: 501 });
  });

  it("preserves a 500 as a plain error, distinct from 501", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );

    await expect(fetchDashboard("c=1")).rejects.toMatchObject({ status: 500 });
  });

  it("surfaces a transport failure as a PlatformApiError with no status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const err = await fetchDashboard("c=1").catch((e) => e);
    expect(err).toBeInstanceOf(PlatformApiError);
    expect(err.status).toBeUndefined();
  });
});
