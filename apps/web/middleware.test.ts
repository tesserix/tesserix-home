import { describe, expect, it } from "vitest";
import { isPublicPath } from "./middleware";

/**
 * What an anonymous visitor can reach.
 *
 * Written because the legal pages were behind the session gate and nothing
 * noticed: /privacy, /terms and /cookies all 307'd to /login in production.
 * A privacy policy that requires an account is not published, and the people
 * with the strongest claim to read one — a regulator, an app-store reviewer,
 * someone deciding whether to sign up — are exactly the ones who have no
 * account.
 */
describe("isPublicPath — the legal pages", () => {
  it.each(["/privacy", "/terms", "/cookies"])("%s is reachable without a session", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  // The GDPR Art 14 notice. Art 12(1) requires it be "easily accessible", and
  // its whole audience is people who got a cold DM and have no relationship
  // with us at all — a login wall would make it unreadable by precisely the
  // people it exists for.
  it("covers /privacy/outreach through the prefix rule, not a second entry", () => {
    expect(isPublicPath("/privacy/outreach")).toBe(true);
  });

  // The guard against fixing this by making the prefix rule too generous:
  // "/privacy" must not make "/privacy-internal" public, and the console
  // surfaces must stay gated.
  it.each(["/admin", "/admin/erasure-requests", "/privacyinternal"])(
    "%s still requires a session",
    (path) => {
      expect(isPublicPath(path)).toBe(false);
    },
  );
});
