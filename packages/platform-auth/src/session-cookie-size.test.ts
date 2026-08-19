import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_MAX_BYTES,
  SESSION_COOKIE_WARN_BYTES,
  measureSessionCookie,
} from "./session-cookie-size";

const fill = (n: number) => "x".repeat(n);

describe("measureSessionCookie", () => {
  it("counts the name and the value, and not the `=` between them", () => {
    // The browser limit is on name + value. Counting the separator too would
    // make the guard fire one byte early — harmless, but it would also mean
    // the number in the log is not the number Chrome is comparing against,
    // and that log line exists to be believed.
    expect(measureSessionCookie("tx_session", fill(100)).bytes).toBe(110);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // A JWE is ASCII, so this only ever matters for the cookie NAME, which
    // comes from configuration. Still: the browsers count octets.
    expect(measureSessionCookie("é", "").bytes).toBe(2);
  });

  it("accepts a cookie exactly at the limit", () => {
    // Chrome's rule is "less than or equal to 4096", so the boundary is
    // allowed. An off-by-one here would refuse to mint a session that works.
    const m = measureSessionCookie("", fill(SESSION_COOKIE_MAX_BYTES));
    expect(m.bytes).toBe(SESSION_COOKIE_MAX_BYTES);
    expect(m.exceedsLimit).toBe(false);
    expect(m.headroom).toBe(0);
  });

  it("flags a cookie one byte over the limit", () => {
    // One byte over is the whole bug: the browser discards it in silence.
    const m = measureSessionCookie("", fill(SESSION_COOKIE_MAX_BYTES + 1));
    expect(m.exceedsLimit).toBe(true);
    expect(m.nearLimit).toBe(true);
    expect(m.headroom).toBe(-1);
  });

  it("does not flag a small cookie", () => {
    const m = measureSessionCookie("tx_session", fill(500));
    expect(m.exceedsLimit).toBe(false);
    expect(m.nearLimit).toBe(false);
    expect(m.headroom).toBe(SESSION_COOKIE_MAX_BYTES - 510);
  });

  it("warns before the ceiling, while the cookie still works", () => {
    // The point of the warning band: an operator with more roles than the one
    // who tested the deploy must not be the first to discover the ceiling.
    const m = measureSessionCookie("", fill(SESSION_COOKIE_WARN_BYTES + 1));
    expect(m.nearLimit).toBe(true);
    expect(m.exceedsLimit).toBe(false);
  });

  it("does not warn at the warning threshold itself", () => {
    expect(measureSessionCookie("", fill(SESSION_COOKIE_WARN_BYTES)).nearLimit).toBe(
      false,
    );
  });

  it("leaves the warning band strictly inside the limit", () => {
    // If these two ever converged, the guard would go straight from silent to
    // refusing, and the early warning this exists for would be gone.
    expect(SESSION_COOKIE_WARN_BYTES).toBeLessThan(SESSION_COOKIE_MAX_BYTES);
  });

  it("reports the limits it measured against", () => {
    // A log line carrying only "4021 bytes" is unreadable a year from now.
    const m = measureSessionCookie("tx_session", fill(10));
    expect(m.limit).toBe(SESSION_COOKIE_MAX_BYTES);
    expect(m.warnAt).toBe(SESSION_COOKIE_WARN_BYTES);
  });

  it("returns a frozen measurement", () => {
    const m = measureSessionCookie("tx_session", fill(10));
    expect(Object.isFrozen(m)).toBe(true);
  });
});
