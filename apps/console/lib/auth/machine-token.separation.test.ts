import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ONE THING #618 MUST NOT DO: let the session path reach the machine token.
 *
 * `resolvePlatformApiToken` answers as the OPERATOR. `resolveMachineToken`
 * answers as the CONSOLE. If the first ever fell back to the second, then every
 * operator-facing read would keep succeeding once a session expired — silently,
 * as the machine. The audit trail on the platform API would name the service
 * principal for actions a human did or did not take, and the data reachable
 * without a live operator session would widen to everything the machine may
 * read. Neither failure produces a symptom until an incident review.
 *
 * Two checks, and they fail for different edits:
 *
 *  - BEHAVIOURAL. With the machine credential fully configured and a session
 *    that holds nothing, `resolvePlatformApiToken` must still answer "no
 *    token". This is what reds if someone wires the fallback.
 *  - STRUCTURAL. Neither module may import the other. This is what reds if
 *    someone wires it somewhere the behavioural test does not look — a helper,
 *    a second entry point — or prepares to.
 *
 * Measured 2026-09-08 by adding
 * `if (!session?.sid) return { token: (await resolveMachineToken()).token, ... }`
 * to `resolvePlatformApiToken`: BOTH rows red.
 */

const AUTH_DIR = __dirname;

function source(file: string): string {
  return readFileSync(path.join(AUTH_DIR, file), "utf-8");
}

/**
 * `file` with every comment removed, so a module named only in prose does not
 * read as a dependency on it. `machine-token.ts` mentions `./platform-token` in
 * a `{@link}` on purpose — the sentence explaining why it is NOT a fallback is
 * the most important sentence in the file, and it must not be what fails here.
 */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("the session path and the machine path are separate modules", () => {
  it("platform-token.ts does not reference machine-token in code", () => {
    expect(code("platform-token.ts")).not.toContain("machine-token");
  });

  it("machine-token.ts does not reference platform-token in code", () => {
    expect(code("machine-token.ts")).not.toContain("platform-token");
  });

  it("keeps the sentence that says why, so the next editor reads it before undoing it", () => {
    // The structural rows above enforce the rule; this one keeps its reason
    // attached to it. A rule with no reason beside it is the one that gets
    // relaxed.
    expect(source("machine-token.ts")).toContain("THE TWO MUST NEVER BE WIRED TOGETHER");
  });
});

// ---------------------------------------------------------------------------
// The behavioural half.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
}));

vi.mock("@tesserix/platform-auth", () => ({
  getCurrentSession: async () => state.session,
}));

// The store answers honestly: this session simply has no row. That is the
// shape a fallback would be tempted to paper over.
vi.mock("./operator-token-store", () => ({
  accessTokenExpiresAt: (seconds: number) => new Date(Date.now() + seconds * 1000),
  readTokenRecord: async () => ({ outcome: "absent" as const, tokens: null }),
  readTokens: async () => null,
  saveTokens: async () => {},
  readCapabilities: async () => null,
}));

vi.mock("../db/tesserix", () => ({
  tesserixTx: async () => {
    throw new Error("the session path must not open a transaction here");
  },
}));

beforeEach(() => {
  state.session = null;
  // A machine credential that WOULD mint, if anything asked it to. The point of
  // the test is that nothing does.
  vi.stubEnv("ZITADEL_MACHINE_CLIENT_ID", "machine-client");
  vi.stubEnv("ZITADEL_MACHINE_CLIENT_SECRET", "machine-secret");
  vi.stubEnv("ZITADEL_ISSUER", "https://auth.tesserix.test");
  vi.stubEnv("ZITADEL_PROJECT_ID", "386377618200461939");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("resolvePlatformApiToken with a machine credential available", () => {
  /** Any call to Zitadel from the session path is the failure. */
  function refuseToMint() {
    const fetchMock = vi.fn(async () => {
      throw new Error("the session path minted a machine token");
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns no token for a session with no `sid`, rather than the machine's", async () => {
    const fetchMock = refuseToMint();
    state.session = { sub: "operator-1", email: "operator@tesserix.test" };

    const { resolvePlatformApiToken } = await import("./platform-token");
    const result = await resolvePlatformApiToken();

    expect(result.token).toBeNull();
    // Remediable by signing in, which is exactly the answer a fallback would
    // have replaced with a working request as somebody else.
    expect(result.reauthRequired).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns no token when there is no session at all", async () => {
    const fetchMock = refuseToMint();
    state.session = null;

    const { resolvePlatformApiToken } = await import("./platform-token");
    await expect(resolvePlatformApiToken()).resolves.toMatchObject({ token: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still mints for a caller that asks for the machine explicitly", async () => {
    // The mirror of the rows above: the separation must not be achieved by the
    // machine path simply not working.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "machine-token-1", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const { resolveMachineToken } = await import("./machine-token");
    await expect(resolveMachineToken()).resolves.toEqual({ token: "machine-token-1" });
  });
});
