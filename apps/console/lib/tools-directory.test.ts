import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ORIGIN = process.env.PLATFORM_API_ORIGIN;

// Mocked at the PACKAGE boundary, matching lib/platform-api.test.ts's
// established pattern for the same reason: the real `getCurrentSession` calls
// next/headers' `cookies()`, which throws outside a request scope. Left
// unmocked, `readToolsDirectory`'s try/catch swallows that throw and every
// "reads the platform API" case degrades to the fallback path for a reason
// that has nothing to do with what these tests exercise (the wire parsing).
// A valid token is granted unconditionally — the token-refusal paths already
// have their own coverage in lib/auth/platform-token.test.ts.
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentSession: async () => ({
    sub: "operator-1",
    email: "operator@tesserix.test",
    sid: "sid-1",
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
  }),
}));

vi.mock("./auth/operator-token-store", () => {
  const record = {
    outcome: "ok" as const,
    tokens: {
      accessToken: "test-token",
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      refreshToken: null,
    },
  };
  return {
    readTokenRecord: async () => record,
    readTokens: async () => record.tokens,
    saveTokens: async () => {},
  };
});

afterEach(() => {
  process.env.PLATFORM_API_ORIGIN = ORIGINAL_ORIGIN;
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load() {
  return import("./tools-directory");
}

describe("readToolsDirectory", () => {
  it("returns the built-in directory when PLATFORM_API_ORIGIN is unset", async () => {
    delete process.env.PLATFORM_API_ORIGIN;
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    // Unset is byte-for-byte the old behaviour, which is what makes this whole
    // phase revert by removing one variable rather than by reverting code.
    expect(directory.source).toBe("builtin");
    expect(directory.tools).toHaveLength(15);
    expect(directory.groups.map((g) => g.key)).toEqual([
      "identity",
      "observability",
      "delivery",
      "cost",
      "reference",
    ]);
  });

  it("reads the platform API when the origin is set", async () => {
    process.env.PLATFORM_API_ORIGIN = "https://api.tesserix.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("tool-groups")
          ? { success: true, data: { groups: [{ key: "identity", label: "Identity", sort_order: 1 }] } }
          : {
              success: true,
              data: {
                tools: [
                  {
                    id: "1",
                    name: "Zitadel",
                    subdomain: "auth",
                    purpose: "Identity platform.",
                    note: null,
                    group_key: "identity",
                    sort_order: 1,
                  },
                ],
              },
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    expect(directory.source).toBe("platform-api");
    expect(directory.tools).toHaveLength(1);
    // snake_case on the wire, camelCase in the console: the translation
    // happens once, here, rather than in each renderer.
    expect(directory.tools[0]).toMatchObject({ subdomain: "auth", groupKey: "identity" });
  });

  it("falls back to the built-in directory, LABELLED, when the API fails", async () => {
    process.env.PLATFORM_API_ORIGIN = "https://api.tesserix.test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    // The directory survives an outage — that is the point of the fallback.
    expect(directory.tools).toHaveLength(15);
    // And it says so. A silent fallback is two lists that disagree with
    // nobody able to tell which one they are looking at.
    expect(directory.source).toBe("builtin");
  });

  it("falls back rather than throwing when the payload is the wrong shape", async () => {
    process.env.PLATFORM_API_ORIGIN = "https://api.tesserix.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: { tools: "not an array" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    // A malformed success is a failure. The home page must not blow up over a
    // directory of links.
    expect(directory.source).toBe("builtin");
    expect(directory.tools).toHaveLength(15);
  });

  it("drops a tool whose group is not declared", async () => {
    process.env.PLATFORM_API_ORIGIN = "https://api.tesserix.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("tool-groups")
          ? { success: true, data: { groups: [{ key: "identity", label: "Identity", sort_order: 1 }] } }
          : {
              success: true,
              data: {
                tools: [
                  { id: "1", name: "Zitadel", subdomain: "auth", purpose: "x", note: null, group_key: "identity", sort_order: 1 },
                  { id: "2", name: "Orphan", subdomain: "orphan", purpose: "x", note: null, group_key: "ghost", sort_order: 1 },
                ],
              },
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    // The foreign key makes this unreachable through the API, but the console
    // renders whatever it is handed and an orphan would be a card under no
    // heading. Dropped rather than shown under an invented one.
    expect(directory.tools.map((t) => t.subdomain)).toEqual(["auth"]);
  });
});
