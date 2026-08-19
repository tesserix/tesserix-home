import { getCurrentSession } from "@tesserix/platform-auth";

/**
 * The Zitadel access token the console presents to the platform API.
 *
 * # It is null today, and that is the honest answer
 *
 * ADR-003 D8 requires the platform API to authenticate operators with a
 * Zitadel access token. `app/auth/callback/route.ts` currently destructures
 * only `id_token` out of the token exchange and drops `access_token` and
 * `refresh_token` on the floor — so there is nothing to return, and
 * `SessionClaims` has nowhere to put one if there were.
 *
 * That is why this lives in its own module rather than as an inline
 * `session.accessToken`. It is the SEAM: the work that retains the token at
 * callback, widens the session and refreshes it before expiry fills this in,
 * and nothing else in the console changes. Until then it returns null, and
 * `lib/platform-api.ts` treats null as "the platform API is not reachable as
 * this operator" rather than sending an unauthenticated request that comes
 * back 401 with nothing an operator can act on.
 *
 * # Why the console cannot simply forward its own session
 *
 * `tx_session` is a JWE the platform API cannot read, and D8 declined to teach
 * it: a product calling the API has no `tx_session` and never will, so the
 * service principal would need a second mechanism anyway. The console holds a
 * Zitadel token or it holds nothing.
 *
 * Sessions live 7 days and access tokens do not, which is why the refresh
 * token is required rather than convenient — see D8.
 */
export async function getPlatformApiToken(): Promise<string | null> {
  const session = await getCurrentSession();
  if (!session) return null;

  // Read defensively rather than through the type: the field is not on
  // SessionClaims yet, and this should start working the moment it is, without
  // a second edit here.
  const token = (session as { accessToken?: unknown }).accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}
