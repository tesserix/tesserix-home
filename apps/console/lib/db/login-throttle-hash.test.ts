import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOGIN_THROTTLE_HASH_KEY_ENV,
  isLoginThrottleHashKeyConfigured,
  loginNameHash,
} from "./login-throttle-hash";

/**
 * The keyed hash the TOTP cooldown counts against (#457).
 *
 * Two properties are load-bearing and neither is visible from the call site:
 * that the canonical form collapses the spellings an attacker would otherwise
 * use to buy themselves fresh attempts, and that an unset key is answered with
 * `null` rather than a throw or a bare digest.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loginNameHash", () => {
  it("is the keyed HMAC of the namespaced canonical form", () => {
    vi.stubEnv(LOGIN_THROTTLE_HASH_KEY_ENV, "k");

    // Pinned against the primitive rather than against a recorded digest: a
    // recorded string would still match after someone swapped the namespace
    // or the key out of the computation, which are the two ways this stops
    // being a keyed hash of what it claims.
    expect(loginNameHash("op@tesserix.test")).toBe(
      createHmac("sha256", "k").update("login:op@tesserix.test").digest("hex"),
    );
  });

  it("collapses case and surrounding whitespace onto one counter", () => {
    vi.stubEnv(LOGIN_THROTTLE_HASH_KEY_ENV, "k");

    // THIS IS THE BYPASS, not a tidiness preference. Without canonicalisation
    // `op@x`, `OP@x` and ` Op@X ` are three hashes, so an attacker gets the
    // whole threshold again for every spelling they can think of — while
    // Zitadel, which resolves them all to one user, keeps counting them
    // together toward the lockout this exists to prevent.
    const canonical = loginNameHash("op@tesserix.test");
    expect(loginNameHash("OP@Tesserix.TEST")).toBe(canonical);
    expect(loginNameHash("  op@tesserix.test  ")).toBe(canonical);
  });

  it("gives different login names different hashes", () => {
    vi.stubEnv(LOGIN_THROTTLE_HASH_KEY_ENV, "k");

    expect(loginNameHash("one@tesserix.test")).not.toBe(loginNameHash("two@tesserix.test"));
  });

  it("changes with the key, so a dump alone confirms nothing", () => {
    vi.stubEnv(LOGIN_THROTTLE_HASH_KEY_ENV, "k1");
    const first = loginNameHash("op@tesserix.test");
    vi.stubEnv(LOGIN_THROTTLE_HASH_KEY_ENV, "k2");

    expect(loginNameHash("op@tesserix.test")).not.toBe(first);
  });

  it("answers null rather than throwing when the key is unset", () => {
    vi.stubEnv(LOGIN_THROTTLE_HASH_KEY_ENV, "");

    // Deliberately unlike `erasureHashes`, which throws. Both of that
    // function's callers wanted different things from an absent key; both of
    // this one's want the same thing — carry on without the limiter — and a
    // throw here would have to be caught and discarded at every call site.
    expect(loginNameHash("op@tesserix.test")).toBeNull();
    expect(isLoginThrottleHashKeyConfigured()).toBe(false);
  });

  it("refuses to hash an empty login name", () => {
    vi.stubEnv(LOGIN_THROTTLE_HASH_KEY_ENV, "k");

    // A blank login name never passed a password check, so there is no
    // counter it could legitimately belong to. Hashing it would file every
    // such caller under one shared bucket.
    expect(loginNameHash("   ")).toBeNull();
  });
});
