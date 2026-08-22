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

// The loader's OWN dependency boundary. A `fetch` spy cannot prove "this
// loader never asks the platform API when PLATFORM_API_ORIGIN is unset":
// `platformCall` in lib/platform-api.ts independently re-checks the origin
// and throws before any `fetch`, so `fetch` is never called whether or not
// the loader's own early return exists — a fetch spy proves "the system does
// not hit the network", which was never in doubt, not "this loader does not
// try". `platformApiOrigin` is left real (via `importOriginal`) so the branch
// under test is genuinely the loader's own `if (!platformApiOrigin())`.
const platformRequestWithMetaSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/platform-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform-api")>();
  return {
    ...actual,
    platformRequestWithMeta: async (
      ...args: Parameters<typeof actual.platformRequestWithMeta>
    ) => {
      platformRequestWithMetaSpy(...args);
      return actual.platformRequestWithMeta(...args);
    },
  };
});

afterEach(() => {
  process.env.PLATFORM_API_ORIGIN = ORIGINAL_ORIGIN;
  vi.unstubAllGlobals();
  vi.resetModules();
  platformRequestWithMetaSpy.mockClear();
});

async function load() {
  return import("./tools-directory");
}

describe("readToolsDirectory", () => {
  it("returns the built-in directory when PLATFORM_API_ORIGIN is unset, and never asks the platform API", async () => {
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
    // Proves the loader's OWN early return, not a downstream guard: see the
    // comment on `platformRequestWithMetaSpy` above.
    expect(platformRequestWithMetaSpy).not.toHaveBeenCalled();
  });

  it("reads the platform API when the origin is set", async () => {
    process.env.PLATFORM_API_ORIGIN = "https://api.tesserix.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("tool-groups")
          ? {
              success: true,
              data: {
                groups: [
                  { key: "identity", label: "Identity and secrets", sort_order: 5 },
                  { key: "observability", label: "Observability", sort_order: 15 },
                ],
              },
            }
          : {
              success: true,
              data: {
                tools: [
                  {
                    id: "11111111-1111-1111-1111-111111111111",
                    name: "Zitadel",
                    subdomain: "auth",
                    purpose: "Identity platform. Operators, organisations, projects and roles.",
                    note: null,
                    group_key: "identity",
                    sort_order: 10,
                  },
                  {
                    id: "22222222-2222-2222-2222-222222222222",
                    name: "Secret service",
                    subdomain: "secret-service",
                    purpose:
                      "Admin console for OpenBao and GCP Secret Manager, and which namespaces may read each secret.",
                    // Real, non-null value from the golden file, not every
                    // fixture row's `null` — a misspelled key here would
                    // otherwise pass every other assertion in this suite.
                    note: "Separate login — independent of the platform's identity on purpose.",
                    group_key: "identity",
                    sort_order: 20,
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
    // Groups asserted in full, `label` included: a defect isolated to
    // `label: str(row, "label")` passed every earlier version of this suite.
    expect(directory.groups).toEqual([
      { key: "identity", label: "Identity and secrets", sortOrder: 5 },
      { key: "observability", label: "Observability", sortOrder: 15 },
    ]);
    expect(directory.tools).toHaveLength(2);
    // Every field asserted individually and with distinct values, so a swap
    // between two same-typed fields (id/name/purpose/subdomain are all
    // strings) is detectable rather than silently passing `toMatchObject`.
    expect(directory.tools[0]).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Zitadel",
      subdomain: "auth",
      purpose: "Identity platform. Operators, organisations, projects and roles.",
      note: null,
      groupKey: "identity",
      sortOrder: 10,
    });
    // Proves `note` actually survives the wire: every other fixture in this
    // suite carries `note: null`, which `nullableStr` would also produce for
    // a misspelled key.
    expect(directory.tools[1]).toEqual({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Secret service",
      subdomain: "secret-service",
      purpose:
        "Admin console for OpenBao and GCP Secret Manager, and which namespaces may read each secret.",
      note: "Separate login — independent of the platform's identity on purpose.",
      groupKey: "identity",
      sortOrder: 20,
    });
    // Non-contiguous on purpose: `[1, 2]` would pass even if the loader
    // invented the values from the array index, which is the exact bug this
    // task prevents.
    expect(directory.tools.map((t) => t.sortOrder)).toEqual([10, 20]);
    expect(directory.groups.map((g) => g.sortOrder)).toEqual([5, 15]);
  });

  it("gives the built-in list positions too, so the type has no hole", async () => {
    delete process.env.PLATFORM_API_ORIGIN;
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    // 1-based declaration order. The built-in list is never editable — the
    // surface is hidden when the origin is unset — but a reader should not
    // have to reason about a missing field.
    //
    // The first THREE, not just the first: `[0].sortOrder === 1` alone would
    // still pass against a hardcoded `sortOrder: 1` on every entry, which is
    // not what "positions" means.
    expect(directory.groups[0].sortOrder).toBe(1);
    expect(directory.tools.slice(0, 3).map((t) => t.sortOrder)).toEqual([1, 2, 3]);
  });

  it("falls back to the built-in directory, LABELLED, when the API fails", async () => {
    process.env.PLATFORM_API_ORIGIN = "https://api.tesserix.test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const { readToolsDirectory } = await load();

    const directory = await readToolsDirectory();

    // The directory survives an outage — that is the point of the fallback.
    expect(directory.tools).toHaveLength(15);
    // And it says so: "degraded", not "builtin" — the origin IS set, so this
    // is "on and broken", which the banner reports, not "off on purpose",
    // which stays silent. A silent fallback is two lists that disagree with
    // nobody able to tell which one they are looking at.
    expect(directory.source).toBe("degraded");
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
    // directory of links. Still "degraded": the origin is set, so this is
    // the API failing to answer, not the phase being switched off.
    expect(directory.source).toBe("degraded");
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

  it("falls back when a single tool's note is the wrong type", async () => {
    // Exercises `nullableStr`'s own throw branch directly, rather than only
    // `arrayAt`'s top-level shape check — a `note` that is neither a string
    // nor null/undefined (here, a number) must not reach the renderer.
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
                    purpose: "x",
                    note: 12345,
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

    // "degraded", not "builtin": the origin is set, so a malformed field is
    // the API failing, not the phase being off.
    expect(directory.source).toBe("degraded");
    expect(directory.tools).toHaveLength(15);
  });

  it("falls back when a single tool has no id", async () => {
    // Exercises `str`'s own throw branch directly: a missing `id` must not
    // reach the renderer as `undefined`.
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
                    name: "Zitadel",
                    subdomain: "auth",
                    purpose: "x",
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

    // "degraded", not "builtin": the origin is set, so a malformed field is
    // the API failing, not the phase being off.
    expect(directory.source).toBe("degraded");
    expect(directory.tools).toHaveLength(15);
  });
});
