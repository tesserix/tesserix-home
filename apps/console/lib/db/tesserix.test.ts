import { afterEach, describe, expect, it, vi } from "vitest";
import { isDatabaseConfigured, sslOption } from "./tesserix";

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

describe("sslOption", () => {
  const original = process.env.TESSERIX_DB_SSLMODE;

  afterEach(() => {
    if (original === undefined) delete process.env.TESSERIX_DB_SSLMODE;
    else process.env.TESSERIX_DB_SSLMODE = original;
  });

  it("keeps TLS on, unverified, when unset", () => {
    delete process.env.TESSERIX_DB_SSLMODE;

    // Encrypted but not verified: CNPG self-signs and rotates internally, so
    // pinning the CA would force a rebuild on every rotation.
    expect(sslOption()).toEqual({ rejectUnauthorized: false });
  });

  it("disables TLS only for the exact opt-out value", () => {
    process.env.TESSERIX_DB_SSLMODE = "disable";

    expect(sslOption()).toBe(false);
  });

  it("keeps TLS on for every other value, including the chart's", () => {
    // THE property that matters. A mistyped or unexpected value must not
    // silently downgrade a deployed connection to plaintext, and the Helm
    // charts set `require` — which must behave exactly like unset.
    for (const value of ["require", "Disable", "DISABLE", "disabled", "", "0", "false"]) {
      process.env.TESSERIX_DB_SSLMODE = value;

      expect(sslOption(), `TESSERIX_DB_SSLMODE=${JSON.stringify(value)}`).toEqual({
        rejectUnauthorized: false,
      });
    }
  });
});
