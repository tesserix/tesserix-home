import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  verifyMachineAuthHeader: vi.fn(),
  getZitadelMachineConfig: vi.fn(() => ({
    issuer: "https://auth.tesserix.app",
    audience: "urn:tesserix:catalog-read",
    internalOrgId: undefined,
  })),
}));
vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  tesserixQuery: vi.fn(),
}));
vi.mock("@/lib/db/plan-catalog-repo", () => ({
  readLivePublication: vi.fn(),
  readCatalogRows: vi.fn(),
}));

import { MachineTokenError, verifyMachineAuthHeader } from "@tesserix/platform-auth";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  readCatalogRows,
  readLivePublication,
  type CatalogRow,
  type LivePublication,
} from "@/lib/db/plan-catalog-repo";
import { GET } from "./route";

/**
 * The product-facing catalog read: `GET /api/v1/plan-catalog?mode=<test|live>`.
 *
 * The two properties this suite exists to prove above everything else:
 *
 * 1. 401 (not authenticated) and 403 (authenticated but not permitted) are
 *    NEVER the same response. Collapsing them would leave a misconfigured
 *    caller unable to tell "reissue the credential" from "grant the role".
 * 2. A mode that has never been published is 404 — NOT a 200 with an empty
 *    `prices` array. mark8ly caches this response, and caching "the catalog
 *    is empty" is a materially worse answer than caching nothing at all.
 */

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

const URL_TEST = "https://console.tesserix.app/api/v1/plan-catalog?mode=test";
const URL_LIVE = "https://console.tesserix.app/api/v1/plan-catalog?mode=live";
const URL_NO_MODE = "https://console.tesserix.app/api/v1/plan-catalog";
const URL_BAD_MODE = "https://console.tesserix.app/api/v1/plan-catalog?mode=sandbox";

const AUTHED_HEADERS = { authorization: "Bearer machine-token" };

function identity(roles: readonly string[]) {
  return { sub: "service-user-1", clientId: "catalog-reader", roles, orgId: undefined };
}

const publication: LivePublication = {
  id: "pub-1",
  revisionId: "rev-42",
  publishedBy: "operator@tesserix.app",
  publishedAt: "2026-08-20T00:00:00.000Z",
};

const rows: CatalogRow[] = [
  {
    lookupKey: "mark8ly_starter_monthly_usd_v1",
    plan: "starter",
    period: "monthly",
    tier: "standard",
    source: "mark8ly",
    currency: "usd",
    unitAmountMinor: 1900,
    taxBehavior: "unspecified",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(verifyMachineAuthHeader).mockResolvedValue(identity(["read-plan-catalog"]));
  vi.mocked(readLivePublication).mockResolvedValue(publication);
  vi.mocked(readCatalogRows).mockResolvedValue(rows);
});

describe("authentication: 401", () => {
  it("refuses a request with no bearer token, and the body carries no catalog data", async () => {
    vi.mocked(verifyMachineAuthHeader).mockRejectedValue(
      new MachineTokenError("missing-token", "zitadel: missing or malformed Authorization header"),
    );

    const res = await GET(request(URL_TEST));

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("prices");
    expect(body).not.toHaveProperty("revision_id");
    expect(readLivePublication).not.toHaveBeenCalled();
    expect(readCatalogRows).not.toHaveBeenCalled();
  });

  it("refuses an invalid or expired token the same way as a missing one", async () => {
    vi.mocked(verifyMachineAuthHeader).mockRejectedValue(
      new MachineTokenError("invalid-token", "zitadel: machine token failed verification"),
    );

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBe(401);
    expect(readCatalogRows).not.toHaveBeenCalled();
  });
});

describe("authorization: 403, distinct from 401", () => {
  it("refuses a verified identity that lacks read-plan-catalog", async () => {
    vi.mocked(verifyMachineAuthHeader).mockResolvedValue(identity(["publish-catalog"]));

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    // The property this suite is built to catch a regression of: a valid,
    // verified caller without the capability is 403, never 401.
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
    expect(readLivePublication).not.toHaveBeenCalled();
  });

  it("refuses a verified identity with no roles at all", async () => {
    vi.mocked(verifyMachineAuthHeader).mockResolvedValue(identity([]));

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBe(403);
  });
});

describe("mode validation: 400", () => {
  it("names the accepted values when mode is absent", async () => {
    const res = await GET(request(URL_NO_MODE, AUTHED_HEADERS));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("test");
    expect(body.message).toContain("live");
    expect(readLivePublication).not.toHaveBeenCalled();
  });

  it("never defaults an unknown mode to a real one", async () => {
    const res = await GET(request(URL_BAD_MODE, AUTHED_HEADERS));

    expect(res.status).toBe(400);
    expect(readLivePublication).not.toHaveBeenCalled();
    expect(readCatalogRows).not.toHaveBeenCalled();
  });
});

describe("a mode that has never been published: 404, never an empty 200", () => {
  it("answers 404 rather than 200 with an empty prices array", async () => {
    vi.mocked(readLivePublication).mockResolvedValue(null);

    const res = await GET(request(URL_LIVE, AUTHED_HEADERS));

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    // The regression this guards against: a 200 with `prices: []` would pass
    // a naive status-agnostic assertion, so check the shape explicitly.
    expect(body).not.toHaveProperty("prices");
    expect(res.status).not.toBe(200);
  });

  it("never reads catalog rows for an unpublished mode", async () => {
    vi.mocked(readLivePublication).mockResolvedValue(null);

    await GET(request(URL_LIVE, AUTHED_HEADERS));

    expect(readCatalogRows).not.toHaveBeenCalled();
  });
});

describe("a published mode: 200 with the documented shape", () => {
  it("returns the full contract, snake_cased, without published_by", async () => {
    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      mode: "test",
      revision_id: "rev-42",
      published_at: "2026-08-20T00:00:00.000Z",
      prices: [
        {
          lookup_key: "mark8ly_starter_monthly_usd_v1",
          plan: "starter",
          period: "monthly",
          tier: "standard",
          currency: "usd",
          unit_amount_minor: 1900,
          tax_behavior: "unspecified",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("published_by");
    expect(JSON.stringify(body)).not.toContain("operator@tesserix.app");
  });

  it("reads with the required, non-defaulted source", async () => {
    await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(readCatalogRows).toHaveBeenCalledWith("test", "mark8ly");
  });

  it("reads the mode the caller asked for, not a default", async () => {
    await GET(request(URL_LIVE, AUTHED_HEADERS));

    expect(readLivePublication).toHaveBeenCalledWith("live");
    expect(readCatalogRows).toHaveBeenCalledWith("live", "mark8ly");
  });
});

describe("caching: explicit Cache-Control and an ETag derived from the revision id", () => {
  it("carries an explicit Cache-Control on the 200", async () => {
    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.headers.get("cache-control")).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("carries an ETag equal to the revision id", async () => {
    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.headers.get("etag")).toBe('"rev-42"');
  });
});

describe("conditional requests: 304 with no body", () => {
  it("answers 304 with no body when If-None-Match matches the current revision", async () => {
    const res = await GET(
      request(URL_TEST, { ...AUTHED_HEADERS, "if-none-match": '"rev-42"' }),
    );

    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(readCatalogRows).not.toHaveBeenCalled();
  });

  it("still carries Cache-Control and ETag on a 304", async () => {
    const res = await GET(
      request(URL_TEST, { ...AUTHED_HEADERS, "if-none-match": '"rev-42"' }),
    );

    expect(res.headers.get("etag")).toBe('"rev-42"');
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers 200 in full when If-None-Match names a stale revision", async () => {
    const res = await GET(
      request(URL_TEST, { ...AUTHED_HEADERS, "if-none-match": '"rev-41"' }),
    );

    expect(res.status).toBe(200);
    expect(readCatalogRows).toHaveBeenCalled();
  });
});

describe("a database failure: 5xx, never a partial catalog", () => {
  it("answers 5xx when reading the publication fails", async () => {
    vi.mocked(readLivePublication).mockRejectedValue(new Error("connect ECONNREFUSED"));

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("prices");
  });

  it("answers 5xx when reading the catalog rows fails, after the publication succeeded", async () => {
    vi.mocked(readCatalogRows).mockRejectedValue(new Error("relation does not exist"));

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = (await res.json()) as Record<string, unknown>;
    // No half-built catalog: the revision id learned from the (successful)
    // publication read must not leak into an otherwise-failed response.
    expect(body).not.toHaveProperty("revision_id");
    expect(body).not.toHaveProperty("prices");
  });

  it("never leaks the driver's error message", async () => {
    vi.mocked(readLivePublication).mockRejectedValue(
      new Error("password authentication failed for user tesserix_admin"),
    );

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(JSON.stringify(await res.json())).not.toContain("password");
  });
});

describe("the data plane not being wired up yet", () => {
  it("answers 501 rather than attempting a read it cannot serve", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    const res = await GET(request(URL_TEST, AUTHED_HEADERS));

    expect(res.status).toBe(501);
    expect(readLivePublication).not.toHaveBeenCalled();
  });
});
