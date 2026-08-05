import { describe, expect, it } from "vitest";

import { ADMIN_PREFIX, buildSignedHeaders, computeSignature } from "./kora-admin";

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
