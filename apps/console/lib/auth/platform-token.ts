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
 * # WHERE THE TOKENS ARE RIGHT NOW: NOWHERE, AND THAT IS DELIBERATE
 *
 * The callback briefly kept `access_token` and `refresh_token` in the session
 * cookie. That broke console login outright: with ten roles the encrypted
 * cookie cleared the browser's 4096-byte per-cookie limit, and a browser over
 * that limit DISCARDS the `Set-Cookie` without telling the origin. Every login
 * succeeded server-side and left the browser with no session, so middleware
 * bounced it back to `/auth/login` until Chrome gave up with
 * ERR_TOO_MANY_REDIRECTS. See
 * `.planning/debug/console-login-state-mismatch.md`.
 *
 * So `/auth/callback` no longer writes them anywhere, and this function
 * returns null for every current session. The tokens are going into a
 * server-side store keyed by a new `sid` claim on the cookie — identity in the
 * cookie so middleware stays zero-I/O on every request, credentials in a table
 * read only by the requests that call the platform API. That is step 2 and it
 * is not built yet.
 *
 * Returning null in the meantime is not a regression that needs hiding: no
 * operator could sign in at all while the tokens were in the cookie, so
 * nothing was reaching the platform API either way.
 *
 * # Why it can still return null once the store exists
 *
 * Four legitimate cases, and every caller must survive all of them:
 *
 *  1. **No token is stored for this session at all.** Today that is every
 *     session; after step 2 it is the sessions minted before it, which live 7
 *     days and outlive the deploy.
 *  2. **A mobile session.** It never went through the OIDC callback.
 *  3. **An expired access token with no way to renew it.** Zitadel issues a
 *     refresh token only when the application has the Refresh Token grant
 *     enabled, and `console-web` currently has `grantTypes:
 *     [AUTHORIZATION_CODE]` only.
 *  4. **Zitadel is not configured on this deployment.**
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
 * # A refreshed token is not written back, and the store is the fix
 *
 * Persisting it needs a response to set a cookie on, and this runs in server
 * components where there is none. That is worse than it sounds: Zitadel
 * ROTATES refresh tokens on use, so the first refresh discards the replacement
 * and every later refresh fails with the token it kept.
 *
 * `middleware.ts` does hold a response, and persisting there is still the
 * wrong answer — it would put a token exchange on the critical path of every
 * request, including the login flow. The right answer is the server-side store
 * (step 2): a write needs no response, so a rotated refresh token can simply
 * be saved, under a lock on `sid` because two replicas and parallel RSC
 * renders will otherwise race to spend the same one-use token. React `cache`
 * only dedupes within a single request.
 *
 * Until that lands this function short-circuits at "no token stored", so none
 * of the above executes.
 */
