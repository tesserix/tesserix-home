import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SITE_ORIGIN, siteOrigin } from "./site-origin";

afterEach(() => vi.unstubAllEnvs());

describe("siteOrigin", () => {
  it("defaults to the live production host, never a loopback", () => {
    expect(siteOrigin()).toBe(DEFAULT_SITE_ORIGIN);
    expect(siteOrigin()).not.toContain("localhost");
  });

  it("reads SITE_ORIGIN at runtime rather than a build-time inlined value", () => {
    vi.stubEnv("SITE_ORIGIN", "https://staging.example.test");
    expect(siteOrigin()).toBe("https://staging.example.test");
  });

  it("strips trailing slashes so callers can append paths", () => {
    vi.stubEnv("SITE_ORIGIN", "https://staging.example.test//");
    expect(siteOrigin()).toBe("https://staging.example.test");
  });

  it("treats a blank or unparseable value as unconfigured", () => {
    vi.stubEnv("SITE_ORIGIN", "   ");
    expect(siteOrigin()).toBe(DEFAULT_SITE_ORIGIN);
    vi.stubEnv("SITE_ORIGIN", "not a url");
    expect(siteOrigin()).toBe(DEFAULT_SITE_ORIGIN);
  });
});
