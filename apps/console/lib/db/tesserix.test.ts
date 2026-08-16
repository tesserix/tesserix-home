import { afterEach, describe, expect, it, vi } from "vitest";
import { isDatabaseConfigured } from "./tesserix";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isDatabaseConfigured", () => {
  it("is false when the host is unset", () => {
    // The window between this shipping and the k8s change deploying. The bell
    // must read as unavailable, not crash the sidebar on every page.
    vi.stubEnv("TESSERIX_DB_HOST", "");
    vi.stubEnv("TESSERIX_DB_USER", "u");
    vi.stubEnv("TESSERIX_DB_PASSWORD", "p");
    expect(isDatabaseConfigured()).toBe(false);
  });

  it("is false when only the password is missing", () => {
    vi.stubEnv("TESSERIX_DB_HOST", "h");
    vi.stubEnv("TESSERIX_DB_USER", "u");
    vi.stubEnv("TESSERIX_DB_PASSWORD", "");
    expect(isDatabaseConfigured()).toBe(false);
  });

  it("is true when host, user and password are all present", () => {
    vi.stubEnv("TESSERIX_DB_HOST", "h");
    vi.stubEnv("TESSERIX_DB_USER", "u");
    vi.stubEnv("TESSERIX_DB_PASSWORD", "p");
    expect(isDatabaseConfigured()).toBe(true);
  });
});
