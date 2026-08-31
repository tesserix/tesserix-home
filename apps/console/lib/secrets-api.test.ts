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
  it("refuses when there is no operator token, and says so distinguishably", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({ getPlatformApiToken: async () => null }));
    const { secretsRequest } = await import("./secrets-api");

    const caught = await secretsRequest("inventory", "/api/secrets").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).noOperatorToken).toBe(true);
  });

  it("sends the operator token as a bearer credential", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({ getPlatformApiToken: async () => "tok-123" }));
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
    vi.doMock("./auth/platform-token", () => ({ getPlatformApiToken: async () => "tok-123" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));

    const { secretsRequest } = await import("./secrets-api");
    const caught = await secretsRequest("inventory", "/api/secrets").catch((e: unknown) => e);

    expect((caught as PlatformApiError).status).toBe(403);
    expect((caught as PlatformApiError).noOperatorToken).toBe(false);
  });
});
