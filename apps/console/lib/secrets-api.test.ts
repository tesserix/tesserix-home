import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError } from "./platform-api-error";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("secretsApiOrigin", () => {
  it("is undefined when SECRETS_API_ORIGIN is unset", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "");
    const { secretsApiOrigin } = await import("./secrets-api");
    expect(secretsApiOrigin()).toBeUndefined();
  });

  it("is the configured origin with any trailing slash removed", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secret-service-api.secret-service.svc.cluster.local:8080/");
    const { secretsApiOrigin } = await import("./secrets-api");
    expect(secretsApiOrigin()).toBe("http://secret-service-api.secret-service.svc.cluster.local:8080");
  });
});

describe("secretsRequest", () => {
  it("refuses with 501 when the origin is unset, naming the variable", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "");
    const { secretsRequest } = await import("./secrets-api");

    await expect(secretsRequest("inventory", "/api/secrets")).rejects.toMatchObject({
      status: 501,
    });
    await expect(secretsRequest("inventory", "/api/secrets")).rejects.toThrow(/SECRETS_API_ORIGIN/);
  });

  // The operator token is the ONLY credential. Sending the request without one
  // would 401 and read as an outage rather than as a session problem, so the
  // client refuses before the network call and says which it is.
  //
  // `reauthRequired: true` is the ONLY case this must report as
  // `noOperatorToken: true` — the absence a fresh sign-in actually fixes. See
  // the paired test below for the case that must NOT be reported that way.
  it("refuses when there is no operator token, and says so distinguishably", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: null, reauthRequired: true }),
    }));
    const { secretsRequest } = await import("./secrets-api");

    const caught = await secretsRequest("inventory", "/api/secrets").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).noOperatorToken).toBe(true);
  });

  // The paired case: no token, but NOT because a fresh sign-in would fix it —
  // an unset encryption key or a down tesserix-postgres land here too. Telling
  // the operator to sign in again for an infrastructure failure is a
  // confidently wrong answer, which is why this must stay `false`.
  it("does not claim a missing token when the store itself is unusable, not the session", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: null, reauthRequired: false }),
    }));
    const { secretsRequest } = await import("./secrets-api");

    const caught = await secretsRequest("inventory", "/api/secrets").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).noOperatorToken).toBe(false);
  });

  it("sends the operator token as a bearer credential", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "tok-123", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ prefix: "/", entries: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { secretsRequest } = await import("./secrets-api");
    await secretsRequest("inventory", "/api/secrets");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://secrets/api/secrets");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok-123");
  });

  // A 403 means the operator lacks `platform`. It must NOT be reported as a
  // missing session: telling someone to sign in again for a permission they
  // were never granted sends them round a loop that cannot help.
  it("preserves the upstream status and does not claim a missing token on 403", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "tok-123", reauthRequired: false }),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));

    const { secretsRequest } = await import("./secrets-api");
    const caught = await secretsRequest("inventory", "/api/secrets").catch((e: unknown) => e);

    expect((caught as PlatformApiError).status).toBe(403);
    expect((caught as PlatformApiError).noOperatorToken).toBe(false);
  });

  // A network failure (service down, DNS, connection refused) must arrive as
  // a `PlatformApiError` too — a raw `TypeError` from `fetch` would slip past
  // every consumer's `instanceof PlatformApiError` branch. It is an outage,
  // not a session problem, so `noOperatorToken` stays false.
  it("wraps a network failure in PlatformApiError rather than letting a raw TypeError through", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "tok-123", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connect ECONNREFUSED");
      }),
    );

    const { secretsRequest } = await import("./secrets-api");
    const caught = await secretsRequest("inventory", "/api/secrets").catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).noOperatorToken).toBe(false);
  });

  // A 200 with a body that isn't JSON (an ingress error page, per
  // platform-api.ts's own comment) must also arrive as a `PlatformApiError`,
  // not a raw `SyntaxError` from `response.json()`.
  it("wraps a non-JSON response body in PlatformApiError", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "tok-123", reauthRequired: false }),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 200 })));

    const { secretsRequest } = await import("./secrets-api");
    const caught = await secretsRequest("inventory", "/api/secrets").catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(PlatformApiError);
  });
});

describe("fetchSecretPaths", () => {
  function treeFetch(tree: Record<string, Array<{ name: string; isFolder: boolean }>>) {
    return vi.fn(async (url: string) => {
      const prefix = new URL(url).searchParams.get("prefix") ?? "/";
      return new Response(JSON.stringify({ prefix, entries: tree[prefix] ?? [] }), { status: 200 });
    });
  }

  it("returns leaf paths, not folders", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal("fetch", treeFetch({
      "/": [{ name: "mark8ly", isFolder: true }, { name: "root-key", isFolder: false }],
      "/mark8ly/": [{ name: "db", isFolder: false }],
    }));

    const { fetchSecretPaths } = await import("./secrets-api");
    expect((await fetchSecretPaths("openbao")).sort()).toEqual(["mark8ly/db", "root-key"]);
  });

  // A backend that returned a folder containing itself would otherwise walk
  // forever and hang the page rather than failing.
  it("stops at the depth limit instead of recursing forever", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const selfReferential = vi.fn(async (url: string) => {
      const prefix = new URL(url).searchParams.get("prefix") ?? "/";
      return new Response(
        JSON.stringify({ prefix, entries: [{ name: "loop", isFolder: true }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", selfReferential);

    const { fetchSecretPaths } = await import("./secrets-api");
    await expect(fetchSecretPaths("openbao")).resolves.toBeInstanceOf(Array);
    expect(selfReferential.mock.calls.length).toBeLessThan(100);
  });

  it("asks for the requested store", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = treeFetch({ "/": [] });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSecretPaths } = await import("./secrets-api");
    await fetchSecretPaths("gcpsm");

    expect(fetchMock.mock.calls[0][0]).toContain("backend=gcpsm");
  });
});
