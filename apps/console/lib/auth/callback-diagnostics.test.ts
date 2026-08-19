import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callbackRetryEnabled,
  retryRefusal,
  type CallbackRequestShape,
} from "./callback-diagnostics";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A cookieless callback that DOES look like a real top-level navigation. */
function shape(
  overrides: Partial<CallbackRequestShape> = {},
): CallbackRequestShape {
  return {
    cookieNames: ["cf_clearance"],
    hasSession: false,
    host: "console.tesserix.app",
    forwardedHost: "console.tesserix.app",
    origin: "https://console.tesserix.app",
    referer: "https://auth.tesserix.app",
    secFetchSite: "same-site",
    secFetchMode: "navigate",
    secFetchDest: "document",
    secPurpose: null,
    purpose: null,
    ...overrides,
  };
}

describe("callbackRetryEnabled", () => {
  it("is off when the variable is unset", () => {
    expect(callbackRetryEnabled(undefined)).toBe(false);
  });

  it.each(["1", "true", "TRUE", " true "])("opts in on %s", (raw) => {
    expect(callbackRetryEnabled(raw)).toBe(true);
  });

  it.each(["", "0", "false", "yes", "on", "enabled"])(
    "stays off on %s",
    (raw) => {
      expect(callbackRetryEnabled(raw)).toBe(false);
    },
  );

  it("reads CONSOLE_CALLBACK_RETRY from the environment by default", () => {
    vi.stubEnv("CONSOLE_CALLBACK_RETRY", "1");
    expect(callbackRetryEnabled()).toBe(true);
  });

  it("defaults to off with no environment at all", () => {
    vi.stubEnv("CONSOLE_CALLBACK_RETRY", "");
    expect(callbackRetryEnabled()).toBe(false);
  });
});

describe("retryRefusal", () => {
  it("allows one bounce for a genuine cookieless navigation", () => {
    expect(retryRefusal(shape(), { enabled: true, retried: false })).toBeNull();
  });

  it("refuses everything while the flag is off, whatever the request", () => {
    // The rollout guarantee: with the flag off there is no ordering of pods
    // that can produce a redirect, because the reader never redirects.
    expect(retryRefusal(shape(), { enabled: false, retried: false })).toBe(
      "disabled",
    );
  });

  it("refuses a second time, so the retry is one-shot", () => {
    expect(retryRefusal(shape(), { enabled: true, retried: true })).toBe(
      "already_retried",
    );
  });

  it.each([
    ["Sec-Purpose", { secPurpose: "prefetch;prerender" }],
    ["the legacy Purpose header", { purpose: "prefetch" }],
  ])("refuses a speculative request announced by %s", (_label, headers) => {
    // Healing a prefetch would re-run /auth/login and overwrite the cookies of
    // a login that was working in another tab.
    expect(
      retryRefusal(shape(headers), { enabled: true, retried: false }),
    ).toBe("speculative");
  });

  it.each([
    ["cors", "cors"],
    ["no-cors", "no-cors"],
    ["absent", null],
  ])("refuses a non-navigation (%s) and names it", (_label, mode) => {
    expect(
      retryRefusal(shape({ secFetchMode: mode }), {
        enabled: true,
        retried: false,
      }),
    ).toBe("not_a_navigation");
  });

  it("reports the flag before anything else, so the log is unambiguous", () => {
    expect(
      retryRefusal(shape({ secPurpose: "prefetch" }), {
        enabled: false,
        retried: true,
      }),
    ).toBe("disabled");
  });
});
