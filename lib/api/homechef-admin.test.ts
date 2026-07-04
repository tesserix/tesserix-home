import { describe, expect, it } from "vitest";

import { buildSignedHeaders, computeSignature } from "./homechef-admin";

// Fixed parity vectors — the HMAC must match apps/api/middleware/bff_auth.go:compute()
// byte-for-byte or the Go API returns 401. These constants were produced by the
// identical formula; any drift in computeSignature() fails here BEFORE it ships.
const KEY = Buffer.from("test-key-32-bytes-padding-padding!");
const KEY_B64 = KEY.toString("base64");
// The identity bound into the MAC (#461). Matches buildSignedHeaders' pinned
// admin/internal role/pool so the GET vector below is shared with that test.
const ID = { userId: "u-1", email: "ops@tesserix.com", role: "admin", pool: "internal" };

describe("computeSignature (parity with Go bff_auth.go:compute)", () => {
  it("matches the fixed vector for a PUT with a JSON body", () => {
    const sig = computeSignature(
      "PUT",
      "/api/v1/admin/chefs/abc/verify",
      Buffer.from(JSON.stringify({ reason: "ok" })),
      "1700000000",
      KEY,
      ID,
    );
    expect(sig).toBe(
      "55261490f58766b0bd2c3dbf331feae55071709fda0d4cedd2879044f53af5f2",
    );
  });

  it("matches the fixed vector for a GET with an empty body", () => {
    const sig = computeSignature(
      "GET",
      "/api/v1/admin/chefs",
      Buffer.alloc(0),
      "1700000000",
      KEY,
      ID,
    );
    expect(sig).toBe(
      "45b71ada5327f105446247af9827dc5fcbc911ba53abd41d365e63e9e6e693b2",
    );
  });

  it("changes when the body changes (body is bound into the signature)", () => {
    const a = computeSignature("POST", "/api/v1/admin/x", Buffer.from("a"), "1", KEY, ID);
    const b = computeSignature("POST", "/api/v1/admin/x", Buffer.from("b"), "1", KEY, ID);
    expect(a).not.toBe(b);
  });

  it("changes when the role is escalated (identity is bound — #461)", () => {
    const asCustomer = computeSignature("GET", "/api/v1/admin/x", Buffer.alloc(0), "1", KEY, {
      ...ID,
      role: "customer",
    });
    const asAdmin = computeSignature("GET", "/api/v1/admin/x", Buffer.alloc(0), "1", KEY, ID);
    expect(asCustomer).not.toBe(asAdmin);
  });
});

describe("buildSignedHeaders", () => {
  it("pins the admin identity + emits the full signed header set", () => {
    const headers = buildSignedHeaders(
      "GET",
      "/api/v1/admin/chefs",
      Buffer.alloc(0),
      { userId: "u-1", email: "ops@tesserix.com" },
      KEY_B64,
      1700000000_000, // ms -> ts 1700000000
    );
    expect(headers["X-User-Role"]).toBe("admin");
    expect(headers["X-Auth-Pool"]).toBe("internal");
    expect(headers["X-User-Id"]).toBe("u-1");
    expect(headers["X-User-Email"]).toBe("ops@tesserix.com");
    expect(headers["X-Auth-Ts"]).toBe("1700000000");
    expect(headers["X-Internal-Auth"]).toBe(
      "45b71ada5327f105446247af9827dc5fcbc911ba53abd41d365e63e9e6e693b2",
    );
  });
});
