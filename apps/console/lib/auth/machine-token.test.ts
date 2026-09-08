import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The console's machine credential (#618).
 *
 * Every test imports the module FRESH — `vi.resetModules()` plus a dynamic
 * import — because the token cache is module scope. Sharing one instance
 * across tests would let the first mint answer the rest of the file, which is
 * the one thing the caching tests are trying to observe.
 *
 * The credential does not exist on any deployment yet, so nothing here can be
 * an integration test. What it CAN pin is the request shape — the grant, the
 * audience scope, the secret's placement — which is where this class of thing
 * goes wrong, and the separation from the operator path, which is where it
 * would go wrong expensively.
 */

const ISSUER = "https://auth.tesserix.test";
const PROJECT = "386377618200461939";

async function load() {
  vi.resetModules();
  return import("./machine-token");
}

/** A configured deployment: client id and secret set, the rest derived. */
function withCredential() {
  vi.stubEnv("ZITADEL_MACHINE_CLIENT_ID", "machine-client");
  vi.stubEnv("ZITADEL_MACHINE_CLIENT_SECRET", "machine-secret");
  vi.stubEnv("ZITADEL_ISSUER", ISSUER);
  vi.stubEnv("ZITADEL_PROJECT_ID", PROJECT);
}

/** A token response, with a lifetime long enough to be worth caching. */
function tokenResponse(token: string, expiresIn: number | null = 3600) {
  return new Response(
    JSON.stringify({
      access_token: token,
      token_type: "Bearer",
      ...(expiresIn === null ? {} : { expires_in: expiresIn }),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  // Nothing from the ambient environment: a developer with these set locally
  // must not change what this file asserts.
  vi.stubEnv("ZITADEL_MACHINE_CLIENT_ID", "");
  vi.stubEnv("ZITADEL_MACHINE_CLIENT_SECRET", "");
  vi.stubEnv("ZITADEL_MACHINE_TOKEN_URL", "");
  vi.stubEnv("ZITADEL_MACHINE_PROJECT_ID", "");
  vi.stubEnv("ZITADEL_ISSUER", "");
  vi.stubEnv("ZITADEL_PROJECT_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("machineCredential", () => {
  it("reports `absent` when nothing is configured, which is every deployment today", async () => {
    const { machineCredential } = await load();
    expect(machineCredential()).toEqual({ state: "absent" });
  });

  it("derives the token URL and the project from the operator's own Zitadel config", async () => {
    withCredential();
    const { machineCredential } = await load();
    expect(machineCredential()).toEqual({
      state: "configured",
      credential: {
        clientId: "machine-client",
        clientSecret: "machine-secret",
        tokenUrl: `${ISSUER}/oauth/v2/token`,
        projectId: PROJECT,
      },
    });
  });

  it("prefers the machine-specific overrides when they are set", async () => {
    withCredential();
    vi.stubEnv("ZITADEL_MACHINE_TOKEN_URL", "https://elsewhere.test/oauth/v2/token");
    vi.stubEnv("ZITADEL_MACHINE_PROJECT_ID", "999");
    const { machineCredential } = await load();
    expect(machineCredential()).toMatchObject({
      state: "configured",
      credential: { tokenUrl: "https://elsewhere.test/oauth/v2/token", projectId: "999" },
    });
  });

  it("separates a half-configured deployment from an unconfigured one, and names what is missing", async () => {
    // The symptom is otherwise identical, and the causes are not: one is the
    // expected state, the other is a secret that did not land.
    vi.stubEnv("ZITADEL_MACHINE_CLIENT_ID", "machine-client");
    const { machineCredential } = await load();
    const resolution = machineCredential();
    expect(resolution.state).toBe("incomplete");
    expect(resolution.state === "incomplete" && resolution.missing).toContain(
      "ZITADEL_MACHINE_CLIENT_SECRET",
    );
  });

  it("treats whitespace as unset, so a blank ESO value is not a credential", async () => {
    vi.stubEnv("ZITADEL_MACHINE_CLIENT_ID", "   ");
    vi.stubEnv("ZITADEL_MACHINE_CLIENT_SECRET", "   ");
    const { machineCredential } = await load();
    expect(machineCredential()).toEqual({ state: "absent" });
  });
});

describe("machineScopes", () => {
  it("requests the project audience, without which the token verifies and is then refused", async () => {
    const { machineScopes } = await load();
    expect(machineScopes(PROJECT)).toBe(
      `openid urn:zitadel:iam:org:project:id:${PROJECT}:aud urn:zitadel:iam:org:projects:roles`,
    );
  });
});

describe("resolveMachineToken", () => {
  it("answers `not-configured` without calling Zitadel, and never throws", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { resolveMachineToken } = await load();
    await expect(resolveMachineToken()).resolves.toEqual({
      token: null,
      unavailable: "not-configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers `incomplete-configuration` for a half-provisioned deployment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ZITADEL_MACHINE_CLIENT_SECRET", "machine-secret");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { resolveMachineToken } = await load();
    await expect(resolveMachineToken()).resolves.toEqual({
      token: null,
      unavailable: "incomplete-configuration",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a client_credentials grant with the audience scope and the secret in the header", async () => {
    withCredential();
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("machine-token-1"));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveMachineToken } = await load();
    await expect(resolveMachineToken()).resolves.toEqual({ token: "machine-token-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ISSUER}/oauth/v2/token`);
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toContain(`urn:zitadel:iam:org:project:id:${PROJECT}:aud`);
    // `client_secret_basic`: the secret is in the header, never in the form
    // body a proxy might log.
    expect(body.get("client_secret")).toBeNull();
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("machine-client:machine-secret").toString("base64")}`,
    );
  });

  it("caches the token rather than minting one per request", async () => {
    withCredential();
    const fetchMock = vi.fn(async () => tokenResponse("machine-token-1"));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveMachineToken } = await load();
    await resolveMachineToken();
    await expect(resolveMachineToken()).resolves.toEqual({ token: "machine-token-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mints again once the cached token is close enough to expiry to be unusable", async () => {
    // The failure this guards: a cached token served past its expiry produces a
    // 401 that reads exactly like a misconfigured grant.
    withCredential();
    let minted = 0;
    const fetchMock = vi.fn(async () => tokenResponse(`machine-token-${++minted}`, 3600));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveMachineToken } = await load();
    await expect(resolveMachineToken()).resolves.toEqual({ token: "machine-token-1" });

    // Only `Date` is faked — `withDeadline`'s timer must stay real, or the
    // mint below would never settle.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_600_000);

    await expect(resolveMachineToken()).resolves.toEqual({ token: "machine-token-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a token whose lifetime it cannot read, and refuses to cache it", async () => {
    // Caching a token whose expiry had to be guessed is how a cache starts
    // handing out dead bearers. Using it once is free; remembering it is not.
    withCredential();
    let minted = 0;
    const fetchMock = vi.fn(async () => tokenResponse(`machine-token-${++minted}`, null));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveMachineToken } = await load();
    await expect(resolveMachineToken()).resolves.toEqual({ token: "machine-token-1" });
    await expect(resolveMachineToken()).resolves.toEqual({ token: "machine-token-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves concurrent callers from one in-flight mint", async () => {
    withCredential();
    const fetchMock = vi.fn(async () => tokenResponse("machine-token-1"));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveMachineToken } = await load();
    const [a, b, c] = await Promise.all([
      resolveMachineToken(),
      resolveMachineToken(),
      resolveMachineToken(),
    ]);
    expect([a, b, c]).toEqual([
      { token: "machine-token-1" },
      { token: "machine-token-1" },
      { token: "machine-token-1" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports `mint-failed` on a refusal, and keeps the secret out of the log", async () => {
    withCredential();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`{"error":"invalid_client"}`, { status: 401 })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { resolveMachineToken } = await load();
    await expect(resolveMachineToken()).resolves.toEqual({
      token: null,
      unavailable: "mint-failed",
    });
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("machine-client");
    expect(logged).not.toContain("machine-secret");
  });

  it("reports `mint-failed` when the response carries no access_token", async () => {
    withCredential();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`{"token_type":"Bearer"}`, { status: 200 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { resolveMachineToken } = await load();
    await expect(resolveMachineToken()).resolves.toEqual({
      token: null,
      unavailable: "mint-failed",
    });
  });

  it("reports `mint-failed` on a transport failure rather than throwing into the caller", async () => {
    withCredential();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { resolveMachineToken } = await load();
    await expect(resolveMachineToken()).resolves.toEqual({
      token: null,
      unavailable: "mint-failed",
    });
  });

  it("does not cache a failure — the next caller tries again", async () => {
    withCredential();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(tokenResponse("machine-token-1"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { resolveMachineToken } = await load();
    await expect(resolveMachineToken()).resolves.toMatchObject({ token: null });
    await expect(resolveMachineToken()).resolves.toEqual({ token: "machine-token-1" });
  });
});
