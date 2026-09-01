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
    // Typed with fetch's own (url, init) signature so `.mock.calls[0]` is a
    // real `[string, RequestInit]` tuple — not the `[]` TypeScript infers from
    // a zero-arg implementation, which a bare `as` cast would have papered
    // over instead of fixing.
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ prefix: "/", entries: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { secretsRequest } = await import("./secrets-api");
    await secretsRequest("inventory", "/api/secrets");

    // A narrowing check, not a cast: an empty `calls` array (fetch never
    // invoked) fails the test loudly here instead of being silenced.
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url, init] = call;
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

  it("returns leaf paths, not folders, and reports the walk as complete", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal("fetch", treeFetch({
      "/": [{ name: "mark8ly", isFolder: true }, { name: "root-key", isFolder: false }],
      "/mark8ly/": [{ name: "db", isFolder: false }],
    }));

    const { fetchSecretPaths } = await import("./secrets-api");
    const result = await fetchSecretPaths("openbao");
    expect(result.paths.sort()).toEqual(["mark8ly/db", "root-key"]);
    // A walk that fits comfortably inside both bounds exhausted the whole
    // tree — nothing was declined, so it is complete.
    expect(result.complete).toBe(true);
  });

  // A backend that returned a folder containing itself would otherwise walk
  // forever and hang the page rather than failing. The mock's prefix keeps
  // growing (`/loop/`, `/loop/loop/`, …) and never repeats, so this exercises
  // MAX_DEPTH specifically, not the visited set — see the dedicated visited-set
  // test below for that.
  it("stops at the depth limit instead of recursing forever, and reports the walk as incomplete", async () => {
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
    const result = await fetchSecretPaths("openbao");
    expect(Array.isArray(result.paths)).toBe(true);
    expect(selfReferential.mock.calls.length).toBeLessThan(100);
    // A folder was actually declined at the depth limit (it never ran out of
    // "loop" children to offer), so the walk must say it did not finish.
    expect(result.complete).toBe(false);
  });

  // Distinct from the depth-limit test above: here the tree is wide, not
  // deep, and every prefix is genuinely distinct, so MAX_DEPTH never comes
  // close to firing. Only MAX_NODES can be responsible for stopping this one.
  it("stops at the node cap for a wide tree, and reports the walk as incomplete", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const wideRoot = Array.from({ length: 600 }, (_, i) => ({ name: `folder-${i}`, isFolder: true }));
    const wide = vi.fn(async (url: string) => {
      const prefix = new URL(url).searchParams.get("prefix") ?? "/";
      const entries = prefix === "/" ? wideRoot : [];
      return new Response(JSON.stringify({ prefix, entries }), { status: 200 });
    });
    vi.stubGlobal("fetch", wide);

    const { fetchSecretPaths } = await import("./secrets-api");
    const result = await fetchSecretPaths("openbao");
    // The node cap (512) is well below the 601 prefixes (root + 600 children)
    // this tree would otherwise require.
    expect(wide.mock.calls.length).toBeLessThanOrEqual(512);
    expect(result.complete).toBe(false);
  });

  // The visited set, not the depth limit, is what must prevent a second
  // fetch of an already-seen prefix. A tree cannot legitimately recompose an
  // ancestor's exact prefix through ordinary concatenation (see the report),
  // so the realistic way this happens is a backend listing the same folder
  // name twice in one response — which is exactly what this asserts against:
  // both instances resolve to the same child prefix ("/dup/"), and only the
  // first may actually be requested.
  it("requests a repeated prefix only once, proving the visited set (not the depth limit) terminates it", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = treeFetch({
      "/": [{ name: "dup", isFolder: true }, { name: "dup", isFolder: true }],
      "/dup/": [{ name: "key", isFolder: false }],
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSecretPaths } = await import("./secrets-api");
    const result = await fetchSecretPaths("openbao");

    expect(result.paths).toEqual(["dup/key"]);
    expect(result.complete).toBe(true);
    const dupRequests = fetchMock.mock.calls.filter((call) =>
      new URL(call[0] as string).searchParams.get("prefix") === "/dup/",
    );
    expect(dupRequests.length).toBe(1);
  });

  // A prefix that fails outright mid-walk (not merely a folder that turns
  // out to be empty) must not be swallowed into a smaller, silently-wrong
  // inventory — see the doc comment on `fetchSecretPaths`. Failing loud beats
  // a confidently incomplete list on a surface whose job is to say what's
  // missing.
  it("rejects the whole walk when a prefix 404s partway through", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const prefix = new URL(url).searchParams.get("prefix") ?? "/";
        if (prefix === "/mark8ly/") return new Response("nope", { status: 404 });
        return new Response(
          JSON.stringify({ prefix, entries: [{ name: "mark8ly", isFolder: true }] }),
          { status: 200 },
        );
      }),
    );

    const { fetchSecretPaths } = await import("./secrets-api");
    await expect(fetchSecretPaths("openbao")).rejects.toBeInstanceOf(PlatformApiError);
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
