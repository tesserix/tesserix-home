import { describe, expect, it } from "vitest";

import { buildSignedHeaders, computeSignature } from "./homechef-admin";

// Fixed parity vectors — the HMAC must match apps/api/middleware/bff_auth.go:compute()
// byte-for-byte or the Go API returns 401. These constants were produced by the
// identical formula; any drift in computeSignature() fails here BEFORE it ships.
const KEY = Buffer.from("test-key-32-bytes-padding-padding!");
const KEY_B64 = KEY.toString("base64");

describe("computeSignature (parity with Go bff_auth.go:compute)", () => {
  it("matches the fixed vector for a PUT with a JSON body", () => {
    const sig = computeSignature(
      "PUT",
      "/api/v1/admin/chefs/abc/verify",
      Buffer.from(JSON.stringify({ reason: "ok" })),
      "1700000000",
      KEY,
    );
    expect(sig).toBe(
      "98c2cbe720f510bd1017b9de5bcdeee2f362baf086505ce208a85ac510da38d4",
    );
  });

  it("matches the fixed vector for a GET with an empty body", () => {
    const sig = computeSignature(
      "GET",
      "/api/v1/admin/chefs",
      Buffer.alloc(0),
      "1700000000",
      KEY,
    );
    expect(sig).toBe(
      "683f8207ad98ca5df28a0cd2a58804395a614bd6db6fa0f413aba0b54073afa4",
    );
  });

  it("changes when the body changes (body is bound into the signature)", () => {
    const a = computeSignature("POST", "/api/v1/admin/x", Buffer.from("a"), "1", KEY);
    const b = computeSignature("POST", "/api/v1/admin/x", Buffer.from("b"), "1", KEY);
    expect(a).not.toBe(b);
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
      "683f8207ad98ca5df28a0cd2a58804395a614bd6db6fa0f413aba0b54073afa4",
    );
  });
});
