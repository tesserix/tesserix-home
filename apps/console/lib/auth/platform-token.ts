import { cache } from "react";
import { getCurrentSession } from "@tesserix/platform-auth";
import { getOidcConfig, refreshAccessToken } from "./oidc";

/**
 * The Zitadel access token the console presents to the platform API.
 *
 * # Why this is its own module
 *
 * ADR-003 D8 requires the platform API to authenticate operators with a
 * Zitadel access token, and declined to teach it `tx_session`: a product
 * calling that API has no `tx_session` and never will, so the service
 * principal would need a second mechanism anyway.
 *
 * The console used to drop `access_token` and `refresh_token` at callback and
 * keep only the ID token, which is why the tickets module shipped behind
 * `PLATFORM_API_ORIGIN`. The callback now retains them; this reads them back.
 *
 * # Why it can still return null
 *
 * Three legitimate cases, and every caller must survive all of them:
 *
 *  1. **A session minted before this shipped.** Sessions live 7 days, so they
 *     outlive the deploy that started retaining tokens.
 *  2. **A mobile session.** It never went through the OIDC callback.
 *  3. **An expired access token with no way to renew it.** Zitadel issues a
 *     refresh token only when the application has the Refresh Token grant
 *     enabled, and `console-web` currently has `grantTypes:
 *     [AUTHORIZATION_CODE]` only.
 *
 * `lib/platform-api.ts` treats null as "the platform API is not reachable as
 * this operator" and says so, rather than sending an unauthenticated request
 * that returns a 401 carrying nothing an operator can act on.
 */

/**
 * Refresh this far ahead of expiry.
 *
 * A token that is valid for another ten seconds is not usable: it has to
 * survive the console's own request, the hop to the platform API, and that
 * service's clock, which is not this one's. Sixty seconds is comfortably more
 * than any of those and far less than the token's lifetime, so it costs at
 * most one extra refresh per session.
 */
const RENEW_WITHIN_SECONDS = 60;

/**
 * Memoised per request.
 *
 * Without this, a page that reads tickets and their summary would refresh
 * twice for one render — two round trips to Zitadel to answer the same
 * question. `cache` is React's request-scoped memo, so two callers in one
 * request share the result and two different requests do not.
 */
export const getPlatformApiToken = cache(async (): Promise<string | null> => {
  const session = await getCurrentSession();
  if (!session?.accessToken) return null;

  if (!isExpiring(session.accessTokenExpiresAt)) {
    return session.accessToken;
  }

  if (!session.refreshToken) {
    // Expired, and nothing to renew it with. Returning the dead token would
    // turn a clear "this session cannot reach the platform API" into a 401
    // from a service that has no idea why either.
    return null;
  }

  let config;
  try {
    config = getOidcConfig();
  } catch {
    // Zitadel is not configured on this deployment. Not an error worth
    // throwing from a read path — there is simply no token.
    return null;
  }

  const renewed = await refreshAccessToken(config, session.refreshToken);
  return renewed?.access_token ?? null;
});

/**
 * True when the token is expired, expiring imminently, or carries no expiry.
 *
 * An unknown expiry is treated as expiring, which is the safe direction: a
 * token refreshed too eagerly costs one request, and one refreshed too late
 * costs an operator's action. The callback only omits the expiry when Zitadel
 * omitted `expires_in`, which is rare enough that the extra refresh is cheaper
 * than reasoning about it.
 */
function isExpiring(expiresAt: number | undefined): boolean {
  if (expiresAt === undefined) return true;
  return expiresAt - RENEW_WITHIN_SECONDS <= Math.floor(Date.now() / 1000);
}

/**
 * # A refreshed token is not written back to the session, and that is known
 *
 * Persisting it needs a response to set a cookie on, and this runs in server
 * components where there is none. The consequence is bounded: a render that
 * needs the platform API after the access token has expired pays one refresh,
 * memoised across that request.
 *
 * The obvious home for persistence is `middleware.ts`, which does hold a
 * response — and it is deliberately not there yet. Middleware runs on the
 * critical path of every request including the login flow, which is the part
 * of this system currently being repaired (tesserix-home#290). Adding a token
 * exchange to it while that is in flight would be putting a second unknown
 * next to the first. It belongs there once login is stable and the Refresh
 * Token grant is actually enabled on the application, at which point this
 * comment is the note to act on.
 */
