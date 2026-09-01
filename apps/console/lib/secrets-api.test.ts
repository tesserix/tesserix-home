import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformApiError } from "./platform-api-error";

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // `secrets-api.ts` memoises its dynamic `import("./auth/platform-token")`
  // into a module-level promise (see `platformTokenModule`'s comment), and
  // this test file's many `await import("./secrets-api")` calls all resolve
  // to the SAME cached module instance (only `vi.doMock`'d modules get
  // re-evaluated, and "./secrets-api" itself is never doMocked). Without
  // this, the first test to call `secretsRequest` would pin its mock's
  // token for every test that follows. `vi.resetModules()` would also fix
  // it, but at the cost of handing out a fresh `PlatformApiError` class per
  // test — see `__resetPlatformTokenModuleForTests`'s comment for why that
  // is worse.
  const { __resetPlatformTokenModuleForTests } = await import("./secrets-api");
  __resetPlatformTokenModuleForTests();
});

// Hoisted, for `fetchSecretsInventory` only (see below): it awaits several
// `secretsRequest` calls back to back (backends, then a `Promise.all` of the
// per-store walks and the grants read), each doing its own dynamic
// `import("./auth/platform-token")`. A per-test `vi.doMock` — the pattern the
// rest of this file uses for the single-hop `secretsRequest`/`fetchSecretPaths`
// calls — applied inconsistently across that many hops, the same failure mode
// documented in `platform-api.test.ts` next to its own `vi.hoisted`/`vi.mock`
// fix: the real module ran and called next/headers' `cookies()` outside a
// request scope, failing for a reason unrelated to what was under test.
const inventoryAuthState = vi.hoisted(() => ({ token: "t" as string | null }));
vi.mock("./auth/platform-token", () => ({
  resolvePlatformApiToken: async () => ({ token: inventoryAuthState.token, reauthRequired: false }),
}));

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

describe("fetchSecretsInventory", () => {
  /** Routes the three endpoints `fetchSecretsInventory` calls through one
   *  `fetch` stub: `/api/backends`, `/api/secrets` (per store), and
   *  `/api/access/grants`. */
  function inventoryFetch(config: {
    backends: string[];
    default?: string;
    trees?: Record<string, Record<string, Array<{ name: string; isFolder: boolean }>>>;
    grants?: Array<{ namespace: string; app: string }>;
  }) {
    return vi.fn(async (url: string) => {
      if (url.includes("/api/backends")) {
        return new Response(
          JSON.stringify({ backends: config.backends, default: config.default ?? config.backends[0] }),
          { status: 200 },
        );
      }
      if (url.includes("/api/access/grants")) {
        return new Response(JSON.stringify({ grants: config.grants ?? [] }), { status: 200 });
      }
      const parsed = new URL(url);
      const backend = parsed.searchParams.get("backend") ?? "";
      const prefix = parsed.searchParams.get("prefix") ?? "/";
      const tree = config.trees?.[backend] ?? {};
      return new Response(JSON.stringify({ prefix, entries: tree[prefix] ?? [] }), { status: 200 });
    });
  }

  // The whole point of reading `/api/backends` instead of hardcoding the two
  // known stores: a deployment can run OpenBao only, and walking gcpsm
  // anyway would hit a store the API never enabled — an error the operator
  // cannot act on. This is the most important test in the task.
  it("walks only the backends the API reports as enabled", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    const fetchMock = inventoryFetch({
      backends: ["openbao"],
      trees: { openbao: { "/": [{ name: "root-key", isFolder: false }] } },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSecretsInventory } = await import("./secrets-api");
    const inventory = await fetchSecretsInventory();

    expect(inventory.rows.map((r) => r.path)).toEqual(["root-key"]);
    const gcpsmCalls = fetchMock.mock.calls.filter((call) =>
      new URL(call[0] as string).searchParams.get("backend") === "gcpsm",
    );
    expect(gcpsmCalls.length).toBe(0);
  });

  it("derives readers from the grants endpoint", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.stubGlobal(
      "fetch",
      inventoryFetch({
        backends: ["openbao", "gcpsm"],
        trees: {
          openbao: {
            "/": [
              { name: "mark8ly", isFolder: true },
              { name: "orphan-key", isFolder: false },
            ],
            "/mark8ly/": [{ name: "db-password", isFolder: false }],
          },
          gcpsm: { "/": [] },
        },
        grants: [{ namespace: "mark8ly", app: "db-password" }],
      }),
    );

    const { fetchSecretsInventory } = await import("./secrets-api");
    const inventory = await fetchSecretsInventory();

    const granted = inventory.rows.find((r) => r.path === "mark8ly/db-password");
    const ungranted = inventory.rows.find((r) => r.path === "orphan-key");
    expect(granted?.hasReader).toBe(true);
    expect(ungranted?.hasReader).toBe(false);
  });

  // The completeness signal exists to spot a secret nothing can read. A
  // truncated walk that still reports `complete: true` would present a
  // partial estate as the whole one — a missing row silently reads as "it
  // isn't there" instead of "we didn't look". One truncated store must sink
  // the whole inventory's flag, not just its own rows.
  it("reports the inventory incomplete when one store's walk truncates", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    // gcpsm is a self-referential tree: every prefix offers another "loop"
    // folder, so it can never finish and MAX_DEPTH truncates it. openbao is
    // a small, complete tree.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/backends")) {
        return new Response(JSON.stringify({ backends: ["openbao", "gcpsm"], default: "openbao" }), {
          status: 200,
        });
      }
      if (url.includes("/api/access/grants")) {
        return new Response(JSON.stringify({ grants: [] }), { status: 200 });
      }
      const parsed = new URL(url);
      const backend = parsed.searchParams.get("backend");
      const prefix = parsed.searchParams.get("prefix") ?? "/";
      if (backend === "gcpsm") {
        return new Response(
          JSON.stringify({ prefix, entries: [{ name: "loop", isFolder: true }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ prefix, entries: prefix === "/" ? [{ name: "root-key", isFolder: false }] : [] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSecretsInventory } = await import("./secrets-api");
    const inventory = await fetchSecretsInventory();

    expect(inventory.complete).toBe(false);
  });

  // Finding 1 of the whole-branch review: secrets-api registers
  // `/api/access/grants` only when OpenBao is configured
  // (`secrets-api/internal/api/server.go`, `if d.Bao != nil`), so a
  // `SECRET_BACKENDS=gcpsm` deployment 404s on that call — and, before this
  // fix, an unconditional `Promise.all` member rejected the whole inventory
  // over a store that was never walked. Without the gate in
  // `fetchSecretsInventory`, this test fails: the stub below has no handler
  // for `/api/access/grants` (it 404s, same as the real gcpsm-only
  // deployment), so `fetchSecretsInventory()` would reject instead of
  // resolving, and the assertion on `gcpsm` rows would never run.
  it("assembles a gcpsm-only inventory without ever requesting access grants", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/backends")) {
        return new Response(JSON.stringify({ backends: ["gcpsm"], default: "gcpsm" }), {
          status: 200,
        });
      }
      if (url.includes("/api/access/grants")) {
        // Mirrors the real server: this route does not exist without
        // OpenBao configured.
        return new Response("not found", { status: 404 });
      }
      const parsed = new URL(url);
      const prefix = parsed.searchParams.get("prefix") ?? "/";
      return new Response(
        JSON.stringify({ prefix, entries: prefix === "/" ? [{ name: "api-key", isFolder: false }] : [] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSecretsInventory } = await import("./secrets-api");
    const inventory = await fetchSecretsInventory();

    expect(inventory.rows.map((r) => r.path)).toEqual(["api-key"]);
    expect(inventory.rows[0]?.hasReader).toBeNull();
    const grantsCalls = fetchMock.mock.calls.filter((call) =>
      (call[0] as string).includes("/api/access/grants"),
    );
    expect(grantsCalls.length).toBe(0);
  });
});

describe("fetchSecretDetail", () => {
  it("requests the exact mount-relative path with no doubled or missing slash", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ path: "homechef/api/db", version: 1, keys: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSecretDetail } = await import("./secrets-api");
    await fetchSecretDetail("openbao", "homechef/api/db");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url] = call;
    expect(url).toBe("http://secrets/api/secrets/homechef/api/db?backend=openbao");
  });

  it("returns the parsed detail", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ path: "homechef/homechef-api/db", version: 3, keys: ["password"] }),
          { status: 200 },
        ),
      ),
    );

    const { fetchSecretDetail } = await import("./secrets-api");
    const detail = await fetchSecretDetail("openbao", "homechef/homechef-api/db");

    expect(detail).toMatchObject({ path: "homechef/homechef-api/db", version: 3, keys: ["password"] });
  });
});

describe("fetchSecretVersions", () => {
  it("requests the exact mount-relative path with no doubled or missing slash", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ path: "homechef/api/db", versions: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSecretVersions } = await import("./secrets-api");
    await fetchSecretVersions("openbao", "homechef/api/db");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url] = call;
    expect(url).toBe("http://secrets/api/secret-versions/homechef/api/db?backend=openbao");
  });

  it("returns the parsed version list", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            path: "homechef/homechef-api/db",
            versions: [{ version: 2, destroyed: false, deleted: true }],
          }),
          { status: 200 },
        ),
      ),
    );

    const { fetchSecretVersions } = await import("./secrets-api");
    const versions = await fetchSecretVersions("openbao", "homechef/homechef-api/db");

    expect(versions).toEqual([{ version: 2, destroyed: false, deleted: true, createdAt: undefined }]);
  });
});

describe("writeSecret", () => {
  it("PUTs the exact mount-relative path with the data in the body", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ path: "homechef/api/db", version: 1, backend: "openbao" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { writeSecret } = await import("./secrets-api");
    await writeSecret("openbao", "homechef/api/db", { password: "hunter2" });

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://secrets/api/secrets/homechef/api/db?backend=openbao");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toMatchObject({ data: { password: "hunter2" } });
  });

  // The concurrency guarantee: a rotate must send the POSITIVE version the
  // form was rendered from, verbatim, so a write built on stale data is
  // refused (409) rather than silently overwriting another operator's write.
  // Losing this is exactly the mutation this test exists to catch (see
  // task-2-report.md for the captured failure).
  it("sends the positive ifVersion verbatim on a rotate", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ path: "homechef/api/db", version: 6, backend: "openbao" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { writeSecret } = await import("./secrets-api");
    await writeSecret("openbao", "homechef/api/db", { password: "hunter2" }, 5);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [, init] = call;
    const body = JSON.parse(init.body as string);
    expect(body.ifVersion).toBe(5);
  });

  // On a create there is no current version to check against. This
  // deliberately does NOT assert whether `ifVersion` is present or absent in
  // the body: `IfVersion` is a bare Go `int` with no binding tag on the
  // server (`secrets-api/internal/api/handlers/secrets.go`), so an omitted
  // key and an explicit `0` decode identically there. Asserting on which
  // would pin an implementation detail the wire format does not actually
  // distinguish.
  it("succeeds on a create with no ifVersion supplied", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ path: "homechef/api/db", version: 1, backend: "openbao" }), {
          status: 200,
        }),
      ),
    );

    const { writeSecret } = await import("./secrets-api");
    const result = await writeSecret("openbao", "homechef/api/db", { password: "hunter2" });

    expect(result).toEqual({ path: "homechef/api/db", version: 1, backend: "openbao" });
  });

  // A stale write must be distinguishable from a permission failure: both are
  // non-2xx, but only the preserved upstream status tells a 409 (conflict)
  // apart from a 403 (lacks `rotate-credentials`).
  it("surfaces a conflict as a PlatformApiError carrying the upstream status", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: "the secret changed while you were editing it; reload and write again" }),
          { status: 409 },
        ),
      ),
    );

    const { writeSecret } = await import("./secrets-api");
    const caught = await writeSecret("openbao", "homechef/api/db", { password: "x" }, 5).catch(
      (e: unknown) => e,
    );

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(409);
  });

  // OpenBao KV v2 assigns versions starting at 1 and only increments, so a
  // response reporting version 0 (or negative) is not a shape the server
  // can legitimately return — a wrong response, not a valid "no version"
  // state. This is the boundary a wrong shape should die at, rather than
  // travel further as a value a caller (write-secret-form.tsx's
  // `asRotateVersion` guard exists for exactly this reason) has to remember
  // to re-check.
  it("rejects a write response reporting a non-positive version", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ path: "homechef/api/db", version: 0, backend: "openbao" }), {
          status: 200,
        }),
      ),
    );

    const { writeSecret } = await import("./secrets-api");
    await expect(writeSecret("openbao", "homechef/api/db", { password: "x" })).rejects.toThrow(
      /version is not a positive number/,
    );
  });
});

describe("restoreSecretVersion", () => {
  it("POSTs the exact mount-relative path with the version in the body", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ path: "homechef/api/db", version: 2, restored: true }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { restoreSecretVersion } = await import("./secrets-api");
    await restoreSecretVersion("openbao", "homechef/api/db", 2);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://secrets/api/secret-versions/homechef/api/db?backend=openbao");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ version: 2 });
  });
});

describe("createGrant", () => {
  it("POSTs namespace and the single app, with no ttl when none is given", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ grants: [], status: "granted", proposal: "unchanged" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createGrant } = await import("./secrets-api");
    await createGrant({ namespace: "tesserix", name: "console", serviceAccount: "console-sa" });

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://secrets/api/access/grants");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      namespace: "tesserix",
      apps: [{ name: "console", serviceAccount: "console-sa" }],
    });
    expect(body.ttl).toBeUndefined();
  });

  it("sends ttl when given", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ grants: [], status: "granted", proposal: "unchanged" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createGrant } = await import("./secrets-api");
    await createGrant({ namespace: "tesserix", name: "console", serviceAccount: "console-sa" }, "24h");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [, init] = call;
    const body = JSON.parse(init.body as string);
    expect(body.ttl).toBe("24h");
  });

  // The response's `grants[].secretPrefix` cannot be joined against the
  // mount-inclusive shape `GET /api/access/grants` returns (#476) — so a 403
  // (lacks `rotate-credentials`) must still surface as a `PlatformApiError`
  // the caller can distinguish from a store-side refusal, exactly like
  // `writeSecret`'s equivalent test.
  it("surfaces a 403 as a PlatformApiError carrying the upstream status", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "lacks rotate-credentials" }), { status: 403 })),
    );

    const { createGrant } = await import("./secrets-api");
    const caught = await createGrant({ namespace: "tesserix", name: "console", serviceAccount: "console-sa" }).catch(
      (e: unknown) => e,
    );

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(403);
  });
});

describe("revokeGrant", () => {
  it("DELETEs the URL-encoded namespace/app path", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ namespace: "tesserix", app: "console", status: "revoked" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { revokeGrant } = await import("./secrets-api");
    await revokeGrant("tesserix", "console");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://secrets/api/access/grants/tesserix/console");
    expect(init.method).toBe("DELETE");
  });

  it("URL-encodes each segment", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ namespace: "a/b", app: "c d", status: "revoked" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { revokeGrant } = await import("./secrets-api");
    await revokeGrant("a/b", "c d");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url] = call;
    expect(url).toBe("http://secrets/api/access/grants/a%2Fb/c%20d");
  });

  it("surfaces a 403 as a PlatformApiError carrying the upstream status", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "lacks rotate-credentials" }), { status: 403 })),
    );

    const { revokeGrant } = await import("./secrets-api");
    const caught = await revokeGrant("tesserix", "console").catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(403);
  });
});

describe("deleteSecret", () => {
  it("sends no destroy parameter for a soft delete", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ path: "homechef/api/db", destroyed: false }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { deleteSecret } = await import("./secrets-api");
    await deleteSecret("openbao", "homechef/api/db", false);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://secrets/api/secrets/homechef/api/db?backend=openbao");
    expect(init.method).toBe("DELETE");
  });

  it("sends destroy=true for a destroy", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ path: "homechef/api/db", destroyed: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { deleteSecret } = await import("./secrets-api");
    await deleteSecret("openbao", "homechef/api/db", true);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url] = call;
    expect(url).toBe("http://secrets/api/secrets/homechef/api/db?backend=openbao&destroy=true");
  });

  it("surfaces a 403 as a PlatformApiError carrying the upstream status", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "lacks rotate-credentials" }), { status: 403 })),
    );

    const { deleteSecret } = await import("./secrets-api");
    const caught = await deleteSecret("openbao", "homechef/api/db", false).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(403);
  });
});

describe("fetchProposals", () => {
  it("GETs /api/reviews and unwraps pulls", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({
          pulls: [
            {
              number: 7,
              title: "grant homechef reader access",
              url: "https://github.com/tesserix/tesserix-k8s/pull/7",
              branch: "console/homechef-grant",
              author: "console-bot",
              createdAt: "2026-08-30T09:30:00Z",
              targets: ["homechef/homechef-api"],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchProposals } = await import("./secrets-api");
    const proposals = await fetchProposals();

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://secrets/api/reviews");
    expect(init.method).toBeUndefined();
    expect(proposals).toEqual([
      {
        number: 7,
        title: "grant homechef reader access",
        url: "https://github.com/tesserix/tesserix-k8s/pull/7",
        branch: "console/homechef-grant",
        author: "console-bot",
        createdAt: "2026-08-30T09:30:00Z",
        targets: ["homechef/homechef-api"],
      },
    ]);
  });

  // The 503 case is not an error to swallow into an empty list — it's the
  // "not configured" state the page must render calmly, exactly like the
  // inventory's 501 for an unset SECRETS_API_ORIGIN. `secretsRequest`
  // already preserves the upstream status; this just proves this call
  // doesn't flatten it.
  it("surfaces a 503 (no review repository configured) as a PlatformApiError carrying that status", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "no review repository is configured" }), { status: 503 })),
    );

    const { fetchProposals } = await import("./secrets-api");
    const caught = await fetchProposals().catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(503);
  });
});

describe("fetchProposal", () => {
  it("GETs /api/reviews/:number and parses the bare (unwrapped) detail", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({
          number: 7,
          title: "grant homechef reader access",
          url: "https://github.com/tesserix/tesserix-k8s/pull/7",
          branch: "console/homechef-grant",
          author: "console-bot",
          createdAt: "2026-08-30T09:30:00Z",
          targets: ["homechef/homechef-api"],
          mergeableState: "clean",
          approvals: ["reviewer-one"],
          files: [{ filename: "apps/homechef/rbac.yaml", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@" }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchProposal } = await import("./secrets-api");
    const detail = await fetchProposal(7);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url] = call;
    expect(url).toBe("http://secrets/api/reviews/7");
    expect(detail).toMatchObject({ number: 7, mergeableState: "clean", approvals: ["reviewer-one"] });
  });

  it("surfaces a 503 (no review repository configured) as a PlatformApiError carrying that status", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "no review repository is configured" }), { status: 503 })),
    );

    const { fetchProposal } = await import("./secrets-api");
    const caught = await fetchProposal(7).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(503);
  });
});

describe("approveProposal", () => {
  it("POSTs /api/reviews/:number/approve with no body", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ number: 7, status: "approved" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { approveProposal } = await import("./secrets-api");
    await approveProposal(7);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://secrets/api/reviews/7/approve");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("surfaces a 403 as a PlatformApiError carrying the upstream status", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "lacks rotate-credentials" }), { status: 403 })),
    );

    const { approveProposal } = await import("./secrets-api");
    const caught = await approveProposal(7).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(403);
  });
});

describe("mergeProposal", () => {
  it("POSTs /api/reviews/:number/merge and returns the merge commit sha", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ number: 7, sha: "abc1234", status: "merged" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { mergeProposal } = await import("./secrets-api");
    const result = await mergeProposal(7);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://secrets/api/reviews/7/merge");
    expect(init.method).toBe("POST");
    expect(result).toEqual({ number: 7, sha: "abc1234" });
  });

  it("rejects a merge response with no sha rather than returning it undefined", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ number: 7, status: "merged" }), { status: 200 })),
    );

    const { mergeProposal } = await import("./secrets-api");
    await expect(mergeProposal(7)).rejects.toThrow(/sha/);
  });

  it("surfaces a 403 as a PlatformApiError carrying the upstream status", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "lacks rotate-credentials" }), { status: 403 })),
    );

    const { mergeProposal } = await import("./secrets-api");
    const caught = await mergeProposal(7).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(403);
  });
});

describe("rejectProposal", () => {
  it("POSTs /api/reviews/:number/reject with no body when no reason is given", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ number: 7, status: "rejected" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { rejectProposal } = await import("./secrets-api");
    await rejectProposal(7);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [url, init] = call;
    expect(url).toBe("http://secrets/api/reviews/7/reject");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("sends a reason when given", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ number: 7, status: "rejected" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { rejectProposal } = await import("./secrets-api");
    await rejectProposal(7, "wrong app");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected fetch to have been called");
    const [, init] = call;
    expect(JSON.parse(init.body as string)).toEqual({ reason: "wrong app" });
  });

  it("surfaces a 403 as a PlatformApiError carrying the upstream status", async () => {
    vi.stubEnv("SECRETS_API_ORIGIN", "http://secrets");
    vi.doMock("./auth/platform-token", () => ({
      resolvePlatformApiToken: async () => ({ token: "t", reauthRequired: false }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "lacks rotate-credentials" }), { status: 403 })),
    );

    const { rejectProposal } = await import("./secrets-api");
    const caught = await rejectProposal(7).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(PlatformApiError);
    expect((caught as PlatformApiError).status).toBe(403);
  });
});
