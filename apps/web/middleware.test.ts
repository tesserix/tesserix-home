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

  // Kora's App Store and Google Play listings link these two. Store reviewers
  // open them signed out, and Play's Data safety form rejects a deletion URL
  // that needs an account to read.
  it.each(["/privacy/kora", "/privacy/kora/delete-account"])(
    "%s is reachable without a session",
    (path) => {
      expect(isPublicPath(path)).toBe(true);
    },
  );

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

describe('anonymous research forms',()=>{
 it.each(['/vending-customers','/vending-customers/','/vending-business','/vending-business/','/api/questionnaires/vending-customers','/api/questionnaires/vending-business','/api/questionnaires/location'])('does not redirect %s to login',async path=>{const {NextRequest}=await import('next/server');const {middleware}=await import('./middleware');const r=await middleware(new NextRequest(`https://questionnaire.tesserix.app${path}`));expect(r.headers.get('location')).toBeNull();expect(r.headers.get('x-middleware-next')).toBe('1')});
});

// The CMS publish webhook is server-to-server: no cookie, no Origin, a shared
// secret the route itself verifies. The CSRF gate was answering 403 "Origin
// header required" before the route ever saw it, so publishes never expired
// the cache (found live on tesserix.app, 2026-11-19).
describe("CMS revalidate webhook", () => {
  it("POST /api/revalidate without Origin or cookie reaches the route", async () => {
    const { NextRequest } = await import("next/server");
    const { middleware } = await import("./middleware");
    const r = await middleware(
      new NextRequest("https://tesserix.app/api/revalidate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cms-secret": "x" },
        body: JSON.stringify({ collection: "products" }),
      }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("x-middleware-next")).toBe("1");
  });
});
