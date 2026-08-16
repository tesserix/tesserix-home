import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { publicOrigin } from "./public-origin";

/**
 * Minimal stand-in for the parts of NextRequest `publicOrigin` reads. The
 * default `nextUrl.origin` is the pod's bind address on purpose — that is the
 * exact condition the helper exists to correct, so the fake reproduces it
 * rather than hiding it.
 */
function fakeRequest(
  headers: Record<string, string>,
  nextUrlOrigin = "https://0.0.0.0:3000",
): NextRequest {
  return {
    headers: new Headers(headers),
    nextUrl: { origin: nextUrlOrigin },
  } as unknown as NextRequest;
}

// The helper reads process.env per call, so stubbing is enough — no module
// reset needed, and each test states exactly the config it depends on.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publicOrigin", () => {
  it("uses the forwarded host rather than the pod's bind address", () => {
    // The production symptom this fixes: the login redirect carried
    // returnTo=https://0.0.0.0:3000/ instead of the console's real host.
    const request = fakeRequest({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "console.tesserix.app",
    });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("falls back to the Host header when x-forwarded-host is absent", () => {
    const request = fakeRequest({
      "x-forwarded-proto": "https",
      host: "console.tesserix.app",
    });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("takes the first value when a proxy chain sends a list", () => {
    const request = fakeRequest({
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "console.tesserix.app, internal.svc",
    });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("assumes https when the proto header is missing", () => {
    const request = fakeRequest({ "x-forwarded-host": "console.tesserix.app" });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("falls back to nextUrl.origin when there is no proxy at all", () => {
    const request = fakeRequest({}, "http://localhost:3003");

    expect(publicOrigin(request)).toBe("http://localhost:3003");
  });
});

/**
 * The forwarded headers are proxy headers that our ingress forwards from the
 * client rather than overwriting, so they are attacker-controlled. These cases
 * are the reproduction from issue #184 turned into assertions.
 */
describe("publicOrigin trust boundary", () => {
  it("ignores a forged forwarded host and falls back to the configured origin", () => {
    // Verbatim reproduction:
    //   curl -H "X-Forwarded-Host: evil.example.com" https://console.tesserix.app/
    //   -> location: https://evil.example.com/auth/login?returnTo=%2F
    const request = fakeRequest({ "x-forwarded-host": "evil.example.com" });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("rejects a forged host that hides behind a real one in a proxy chain", () => {
    // Only the first value is the client-facing host, so appending a legitimate
    // host after the forged one must not launder it.
    const request = fakeRequest({
      "x-forwarded-host": "evil.example.com, console.tesserix.app",
    });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("does not let a forged proto downgrade an allowed host to http", () => {
    // The allowed host returns the *configured origin string*, so the request's
    // proto is never read on this path.
    const request = fakeRequest({
      "x-forwarded-host": "console.tesserix.app",
      "x-forwarded-proto": "http",
    });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("matches the allowed host case-insensitively", () => {
    // Hostnames are case-insensitive, so a mixed-case spelling is the same host
    // — and must not be a way to slip past the check.
    const request = fakeRequest({ "x-forwarded-host": "CONSOLE.tesserix.app" });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("rejects a host that merely starts with the allowed one", () => {
    // The classic suffix/prefix bug: `startsWith`/`includes` matching would let
    // an attacker register console.tesserix.app.evil.com and pass.
    const request = fakeRequest({
      "x-forwarded-host": "console.tesserix.app.evil.com",
    });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("rejects a host that merely ends with the allowed domain", () => {
    // No wildcard: a subdomain of tesserix.app is not automatically us. This is
    // the option the issue floated and the fix deliberately does not take.
    const request = fakeRequest({ "x-forwarded-host": "parked.tesserix.app" });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("accepts a host named in CONSOLE_ALLOWED_HOSTS, as itself over https", () => {
    vi.stubEnv("CONSOLE_ALLOWED_HOSTS", "preview.console.tesserix.app, staging.example.com");
    const request = fakeRequest({
      "x-forwarded-host": "staging.example.com",
      // Even a preview host does not get to pick its own scheme.
      "x-forwarded-proto": "http",
    });

    expect(publicOrigin(request)).toBe("https://staging.example.com");
  });

  it("tracks CONSOLE_PUBLIC_ORIGIN rather than hard-coding the production host", () => {
    // Guards the guard: if the allowlist were a literal, every assertion above
    // would still pass while the check read nothing. Move the configured
    // origin and the accept/reject verdicts must move with it.
    vi.stubEnv("CONSOLE_PUBLIC_ORIGIN", "https://console.example.test");

    expect(
      publicOrigin(fakeRequest({ "x-forwarded-host": "console.example.test" })),
    ).toBe("https://console.example.test");
    expect(
      publicOrigin(fakeRequest({ "x-forwarded-host": "console.tesserix.app" })),
    ).toBe("https://console.example.test");
  });

  it("keeps a port-bearing loopback host outside production", () => {
    // Dev has no proxy but does have a Host header, so a bare allowlist would
    // send developers to console.tesserix.app. Proto follows nextUrl.origin.
    const request = fakeRequest({ host: "localhost:3003" }, "http://localhost:3003");

    expect(publicOrigin(request)).toBe("http://localhost:3003");
  });

  it("accepts the other loopback spellings outside production", () => {
    expect(
      publicOrigin(fakeRequest({ host: "127.0.0.1:3003" }, "http://127.0.0.1:3003")),
    ).toBe("http://127.0.0.1:3003");
    expect(
      publicOrigin(fakeRequest({ host: "[::1]:3003" }, "http://[::1]:3003")),
    ).toBe("http://[::1]:3003");
  });

  it("rejects loopback in production", () => {
    // The dev exemption is the one loophole in the allowlist; it must not exist
    // in the environment that is actually exposed.
    vi.stubEnv("NODE_ENV", "production");
    const request = fakeRequest({ "x-forwarded-host": "localhost:3003" });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });

  it("uses the configured origin in production when no host header arrives", () => {
    // Without a host there is nothing to check, and nextUrl.origin is the pod's
    // bind address — the original 0.0.0.0 bug.
    vi.stubEnv("NODE_ENV", "production");

    expect(publicOrigin(fakeRequest({}))).toBe("https://console.tesserix.app");
  });

  it("survives a malformed CONSOLE_PUBLIC_ORIGIN instead of emitting it", () => {
    // A bad value must not become the URL we hand the browser, and must not
    // throw inside a redirect path.
    vi.stubEnv("CONSOLE_PUBLIC_ORIGIN", "not-a-url");
    const request = fakeRequest({ "x-forwarded-host": "console.tesserix.app" });

    expect(publicOrigin(request)).toBe("https://console.tesserix.app");
  });
});
