import { describe, expect, it } from "vitest";
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
