import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `koraAdmin`/`listKoraFoods` read KORA_API_URL / KORA_BFF_HMAC_KEY from
// process.env at MODULE LOAD time (top-level consts), not at call time. Since
// `import` statements are hoisted above ordinary statements, a plain
// `process.env.X = ...` written above the static import below would still run
// AFTER the module's top-level code. `vi.hoisted` is the escape hatch: its
// callback is hoisted above even the hoisted imports, so these are set before
// "./kora-admin" is first evaluated.
const { TEST_KEY_B64 } = vi.hoisted(() => {
  process.env.KORA_API_URL = "http://kora-api-direct.kora.svc.cluster.local:8080";
  process.env.KORA_BFF_HMAC_KEY = "a29yYS10ZXN0LWhtYWMta2V5LTEyMzQ1Ng==";
  return { TEST_KEY_B64: process.env.KORA_BFF_HMAC_KEY };
});

const getCurrentSession = vi.fn();
vi.mock("@/lib/auth/session-jwt", () => ({ getCurrentSession: () => getCurrentSession() }));

const warn = vi.fn();
const error = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a), error: (...a: unknown[]) => error(...a) } }));

import {
  ADMIN_PREFIX,
  buildSignedHeaders,
  computeSignature,
  listKoraFoods,
  KoraAdminError,
} from "./kora-admin";

// Decodes to "kora-test-hmac-key-123456". The SAME constant and the SAME
// expected digest are pinned in kora's api/internal/bffauth/bffauth_test.go.
// This pair is the cross-repo drift guard: if either side changes the canonical
// string, one of the two tests goes red instead of every admin request 401ing
// silently in production.
const KEY_B64 = "a29yYS10ZXN0LWhtYWMta2V5LTEyMzQ1Ng==";
const EXPECTED = "592716969fc5d8c9c0b8013ca2027ae3318d02dd31a59868749a7d2dc2aa3ac7";

// Second vector, with a NON-ASCII body. Kora is a food index, so accented
// names are ordinary. Node's createHash().update(string) defaults to UTF-8 but
// silently accepts 'latin1', and the two digests are completely unrelated —
// latin-1 would give 4a2998d2265e54286e1f76af69455861d80411a2f4cff7f3ca2954102b3117d4.
// Without this vector the client signs ASCII foods correctly and 401s on the
// first `crème brûlée`. The Go side pins the identical constant in
// api/internal/bffauth/bffauth_test.go.
const BODY = '{"name":"crème brûlée","kcal":257}';
const EXPECTED_WITH_BODY = "c0328fe10ebf9e64f71f51d007abd65eb0b902bdefab3279033c1cb1d4019ac3";

describe("computeSignature", () => {
  it("matches the Go implementation's fixed vector", () => {
    const sig = computeSignature(
      "GET",
      "/v1/admin/foods",
      Buffer.alloc(0),
      "1735689600",
      Buffer.from(KEY_B64, "base64"),
      {
        userId: "admin-uid-1",
        email: "admin@tesserix.app",
        role: "admin",
        pool: "internal",
      },
    );
    expect(sig).toBe(EXPECTED);
  });

  it("changes when any bound field changes", () => {
    const base = {
      userId: "admin-uid-1",
      email: "admin@tesserix.app",
      role: "admin",
      pool: "internal",
    };
    const key = Buffer.from(KEY_B64, "base64");
    const sign = (id: typeof base) =>
      computeSignature("GET", "/v1/admin/foods", Buffer.alloc(0), "1735689600", key, id);

    // The twin of the fixed-vector test: without this, a computeSignature that
    // ignored identity entirely would still pass the test above as long as the
    // constant happened to match.
    expect(sign({ ...base, role: "customer" })).not.toBe(EXPECTED);
    expect(sign({ ...base, pool: "customer" })).not.toBe(EXPECTED);
    expect(sign({ ...base, userId: "someone-else" })).not.toBe(EXPECTED);
    expect(sign({ ...base, email: "other@tesserix.app" })).not.toBe(EXPECTED);
  });

  it("matches the Go implementation on a UTF-8 body", () => {
    const sig = computeSignature(
      "POST",
      "/v1/admin/foods",
      Buffer.from(BODY, "utf8"),
      "1735689600",
      Buffer.from(KEY_B64, "base64"),
      {
        userId: "admin-uid-1",
        email: "admin@tesserix.app",
        role: "admin",
        pool: "internal",
      },
    );
    expect(sig).toBe(EXPECTED_WITH_BODY);
  });

  it("binds the body", () => {
    const key = Buffer.from(KEY_B64, "base64");
    const a = computeSignature("POST", "/v1/admin/foods", Buffer.from('{"n":1}'), "1735689600", key, {
      userId: "u", email: "e", role: "admin", pool: "internal",
    });
    const b = computeSignature("POST", "/v1/admin/foods", Buffer.from('{"n":2}'), "1735689600", key, {
      userId: "u", email: "e", role: "admin", pool: "internal",
    });
    expect(a).not.toBe(b);
  });
});

describe("buildSignedHeaders", () => {
  it("pins role and pool and sends seconds, not milliseconds", () => {
    const headers = buildSignedHeaders(
      "GET",
      "/v1/admin/foods",
      Buffer.alloc(0),
      { userId: "admin-uid-1", email: "admin@tesserix.app" },
      KEY_B64,
      1735689600123,
    );

    expect(headers["X-User-Role"]).toBe("admin");
    expect(headers["X-Auth-Pool"]).toBe("internal");
    // Go reads this with strconv.ParseInt and compares against Unix seconds. A
    // millisecond value parses fine and then lands ~55,000 years in the future,
    // which the freshness window rejects as an unexplained 401.
    expect(headers["X-Auth-Ts"]).toBe("1735689600");
    expect(headers["X-Internal-Auth"]).toBe(EXPECTED);
  });
});

describe("ADMIN_PREFIX", () => {
  it("is kora-api's /v1/admin, not HomeChef's /api/v1/admin", () => {
    // buildSignedHeaders/computeSignature take `path` as an explicit argument,
    // so the fixed-vector tests above pass unchanged even if ADMIN_PREFIX
    // itself drifts to the wrong mount point — that's a real coverage gap
    // (see task-5-report.md, Mutation C). This pins the constant directly so a
    // wrong prefix fails fast in CI instead of surfacing as a 404 against
    // kora-api that looks like a routing bug.
    expect(ADMIN_PREFIX).toBe("/v1/admin");
  });
});

// ---------------------------------------------------------------------------
// koraAdmin / listKoraFoods — the real call path. Nothing above this point
// exercises path assembly, query building, the non-200 throw, or the
// response unwrap; ADMIN_PREFIX's value could be hardcoded past entirely
// (see the ADMIN_PREFIX describe's comment) and every test above would still
// be green. These tests drive koraAdmin/listKoraFoods with a stubbed global
// fetch and a mocked session, so the assertions bind to what is ACTUALLY sent
// over the wire, not to the constants in isolation.

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ACTOR = { userId: "admin-uid-1", email: "admin@tesserix.app" };

// NB: block body, not an expression arrow — `mockReset()` returns the mock
// itself, and Vitest treats a value returned from `beforeEach` as an
// implicit cleanup callback, invoking it (with no args) after the test. See
// app/api/admin/apps/[product]/kpis/route.test.ts for the same note.
beforeEach(() => {
  fetchMock.mockReset();
  getCurrentSession.mockReset();
  warn.mockReset();
  error.mockReset();
  getCurrentSession.mockResolvedValue({ sub: ACTOR.userId, email: ACTOR.email });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("koraAdmin / listKoraFoods", () => {
  it("builds the request path from ADMIN_PREFIX (not a hardcoded mount) and signs exactly that path", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { items: [], total: 0 } }));

    await listKoraFoods({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    const signedPath = new URL(urlArg).pathname;

    // Catches a hardcoded "/api/v1/admin" + adminPath assembly: ADMIN_PREFIX
    // (the exported constant, not a string literal) is used to compute the
    // expectation, so this fails if the runtime path assembly ever diverges
    // from it — unlike the ADMIN_PREFIX describe above, which only pins the
    // constant's own value and never touches the real assembly.
    expect(signedPath).toBe(`${ADMIN_PREFIX}/foods`);

    // The load-bearing identity: whatever path fetch was actually told to
    // hit is the SAME path that was signed. Recomputed from the OBSERVED
    // path (not from a constant) so it holds independently of the assertion
    // above.
    const expectedSig = computeSignature(
      "GET",
      signedPath,
      Buffer.alloc(0),
      initArg.headers["X-Auth-Ts"],
      Buffer.from(TEST_KEY_B64, "base64"),
      { userId: ACTOR.userId, email: ACTOR.email, role: "admin", pool: "internal" },
    );
    expect(initArg.headers["X-Internal-Auth"]).toBe(expectedSig);
  });

  it("builds the query string from search params, excluded from the signed path", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { items: [], total: 0 } }));

    await listKoraFoods({ q: "chicken", limit: 20, offset: 40 });

    const [urlArg, initArg] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    const url = new URL(urlArg);
    expect(url.search).toBe("?q=chicken&limit=20&offset=40");
    expect(url.pathname).toBe("/v1/admin/foods");

    // Go's r.URL.Path never includes the query string — the signature must
    // be computed over the pathname alone, or every filtered/paginated list
    // call 401s while the unfiltered first page happens to work.
    const expectedSig = computeSignature(
      "GET",
      url.pathname,
      Buffer.alloc(0),
      initArg.headers["X-Auth-Ts"],
      Buffer.from(TEST_KEY_B64, "base64"),
      { userId: ACTOR.userId, email: ACTOR.email, role: "admin", pool: "internal" },
    );
    expect(initArg.headers["X-Internal-Auth"]).toBe(expectedSig);
  });

  it("sends no body on a GET", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { items: [], total: 0 } }));

    await listKoraFoods({});

    const [, initArg] = fetchMock.mock.calls[0] as [string, { body?: unknown }];
    expect(initArg.body).toBeUndefined();
  });

  it("throws on a non-200 rather than silently returning an empty page", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, { error: "internal_error", message: "something went wrong" }),
    );

    await expect(listKoraFoods({})).rejects.toBeInstanceOf(KoraAdminError);
  });

  it("unwraps kora's {data: ...} envelope exactly once", async () => {
    const page = {
      items: [
        {
          id: "food-1",
          name: "Apple",
          brand: "",
          provenance: "usda",
          serving_desc: "1 medium",
          serving_grams: 182,
          kcal_per_100g: 52,
          protein_per_100g: 0.3,
          carbs_per_100g: 13.8,
          fat_per_100g: 0.2,
          fiber_per_100g: 2.4,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      total: 1,
    };
    fetchMock.mockResolvedValue(jsonResponse(200, { data: page }));

    const result = await listKoraFoods({});

    // Unwrapped exactly once: still-wrapped (`{data: page}`) or double-
    // unwrapped (`page.items[0]` itself) would both fail this.
    expect(result).toEqual(page);
    expect(result).not.toHaveProperty("data");
  });

  // Important 2: Kora's bffauth middleware deliberately distinguishes 401
  // (bad signature/clock/key), 403 (correctly signed but not an admin
  // identity), and 400 (unreadable body) — see
  // api/internal/bffauth/bffauth.go. Losing that distinction here sends
  // whoever is paged hunting a key mismatch that does not exist.
  it("surfaces Kora's error code and message on a 403 (correctly signed, not an admin identity)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: "forbidden", message: "admin identity required" }),
    );

    await expect(listKoraFoods({})).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: "admin identity required",
    });

    // The logged line must carry the same diagnostic, not just the bare
    // status code.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("forbidden: admin identity required"));
  });

  // Task 6 defect: `res.data.data` in listKoraFoods was an unchecked cast —
  // a 200 with an unexpected body shape returned `undefined` TYPED as
  // KoraFoodPage, without throwing. Every caller (the food index page) would
  // then render that as a genuinely empty index rather than as the failure
  // it is. A narrow runtime shape check (items is an array, total is a
  // number) must catch this and throw instead.
  it("throws when a 200 body does not have the KoraFoodPage shape (items array + total number)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { not: "a page" } }));

    await expect(listKoraFoods({})).rejects.toBeInstanceOf(KoraAdminError);
  });

  it("throws when the 200 body is missing the data envelope entirely", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await expect(listKoraFoods({})).rejects.toBeInstanceOf(KoraAdminError);
  });

  it("throws when total is not a number, even if items is a valid array", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { items: [], total: "3" } }));

    await expect(listKoraFoods({})).rejects.toBeInstanceOf(KoraAdminError);
  });

  // Minor 3: KORA_API_URL + path is plain string concatenation. A trailing
  // slash on the configured base URL gives "http://host//v1/admin/foods" —
  // Node's URL parser does not collapse the double slash, and Gin's router
  // won't match it, so it 404s BEFORE bffauth runs (no signature evidence to
  // diagnose from). API_URL is read from process.env at module load, so this
  // needs a fresh module instance with the trailing-slash value in place
  // before that top-level code runs.
  it("strips a trailing slash from KORA_API_URL so the request path has no double slash", async () => {
    vi.resetModules();
    vi.stubEnv("KORA_API_URL", "http://kora-api-direct.kora.svc.cluster.local:8080/");
    const mod = await import("./kora-admin");

    fetchMock.mockResolvedValue(jsonResponse(200, { data: { items: [], total: 0 } }));
    await mod.listKoraFoods({});

    const [urlArg] = fetchMock.mock.calls[0] as [string];
    expect(new URL(urlArg).pathname).toBe("/v1/admin/foods");
  });
});
