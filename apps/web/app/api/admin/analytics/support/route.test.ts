import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the #198 contract on this route: an UNSET OTTO_INTERNAL_AUTH answers
 * 501, an otto that was reached and failed answers 502, and the two never
 * collapse into one status.
 *
 * Why the status is what is asserted, and as a literal: the console branches on
 * the number. `apps/console/components/kit/surface-state.ts` maps 501 onto
 * `instrumentation-unavailable` (the calm "not measured yet" callout) and every
 * other non-2xx onto a red error state, so the difference between "support
 * analytics were never switched on" and "otto is down" is carried entirely by
 * this integer. Importing the console's `NOT_IMPLEMENTED` constant here would
 * make the test pass if BOTH sides drifted to the same wrong number together —
 * self-consistency, not the contract. See docs/PLATFORM-API-CONVENTIONS.md §1c.
 *
 * Every test re-imports the route: OTTO_INTERNAL_AUTH is read into a module
 * const at import time, so the env has to be in place before the module's
 * top-level code runs. A single hoisted `import { GET }` would freeze one value
 * for the whole file and the unset case could never be exercised.
 */

const getCurrentSession = vi.fn();
vi.mock("@tesserix/platform-auth", () => ({
  getCurrentSession: () => getCurrentSession(),
}));

const mark8lyQuery = vi.fn();
vi.mock("@/lib/db/mark8ly", () => ({ mark8lyQuery: (...a: unknown[]) => mark8lyQuery(...a) }));

interface NotConfiguredBody {
  error: string;
  message?: string;
}

async function loadRoute(internalAuth: string) {
  vi.resetModules();
  vi.stubEnv("OTTO_INTERNAL_AUTH", internalAuth);
  return import("./route");
}

const fetchMock = vi.fn();

beforeEach(() => {
  getCurrentSession.mockReset();
  mark8lyQuery.mockReset();
  fetchMock.mockReset();
  getCurrentSession.mockResolvedValue({ sub: "admin-1", email: "admin@tesserix.test" });
  mark8lyQuery.mockResolvedValue({ rows: [] });
  vi.stubGlobal("fetch", fetchMock);
  // The 502 path logs the transport failure. Silence it so a passing run does
  // not print a stack that reads like a real failure.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("GET /api/admin/analytics/support — the unconfigured/unavailable split (#198)", () => {
  it("answers 501, not 503, when OTTO_INTERNAL_AUTH is unset", async () => {
    const { GET } = await loadRoute("");

    const res = await GET();

    // The literal, deliberately: 501 is what the console reads as "parked".
    expect(res.status).toBe(501);
    // 503 was the old answer and is the specific regression being pinned.
    expect(res.status).not.toBe(503);
  });

  it("still carries error: \"not_configured\" in the body of that 501", async () => {
    const { GET } = await loadRoute("");

    const res = await GET();
    const body = (await res.json()) as NotConfiguredBody;

    // The status changed; the body did not. Anything reading the machine code
    // rather than the number must keep working across #198.
    expect(body.error).toBe("not_configured");
  });

  it("never attempts the upstream when the credential is unset", async () => {
    // Proves the 501 means "nothing was tried", which is what distinguishes it
    // from the 502 below — not merely a different number for the same event.
    const { GET } = await loadRoute("");

    await GET();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 when the credential IS set and the upstream throws", async () => {
    const { GET } = await loadRoute("shared-secret");
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await GET();

    // Unchanged by #198, and asserted here so the fix cannot quietly flatten
    // "wired and not answering" into "never wired".
    expect(res.status).toBe(502);
    expect(res.status).not.toBe(501);
  });
});
