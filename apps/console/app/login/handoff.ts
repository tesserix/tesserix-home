import "server-only";

/**
 * Where to send a browser this page cannot finish authenticating.
 *
 * Zitadel's own login, resuming the SAME auth request, so the operator
 * completes their factor there and lands back at the console's callback with
 * no second sign-in — at the cost of re-entering the login name and password,
 * because that UI starts the request from the beginning.
 *
 * # Login V2, and why the version matters
 *
 * This used to point at `/ui/login/login?authRequestID=`, the V1 hosted UI.
 * The console drives login through the OIDC **v2** service, and V1 resolves
 * auth requests against a different store entirely — `auth.auth_requests`,
 * which never holds a `V2_`-prefixed id. It answered
 * `Errors.AuthRequest.NotFound (CACHE-d24aD)` for every hand-off, so this
 * outcome could never work. It shipped unexercised because no operator needed
 * a factor until one did.
 *
 * The V2 contract, from Zitadel v4.15.3's own source: the route is `/login`
 * under the login app's base URI and the parameter is `authRequest` — not
 * `authRequestID`, which is V1-only. See `internal/api/oidc/client_converter.go`
 * (`LoginAuthRequestParam = "authRequest"`, `LoginPath = "/login"`) and
 * `apps/login/src/lib/auth-utils.ts`, which reads exactly that name.
 *
 * # Why the issuer's own origin is the default
 *
 * Login V2 is a SEPARATE service — `ghcr.io/zitadel/zitadel-login` — and hits
 * a bare 404 where it is not deployed. On this instance it is: the chart runs
 * it (`charts/thirdparty/zitadel` `login.enabled: true`, image
 * `zitadel-login:v4.15.3-aurora.4`) and the VirtualService routes the
 * `/ui/v2/login` prefix on the issuer's host to it, which is also what the
 * instance feature's `BaseURI` is set to. The override exists so a deployment
 * that moves it does not silently inherit a URL that is wrong again.
 *
 * Lives in its own module rather than in `actions.ts` because the federated
 * callback route hands off too, and two spellings of this URL is exactly how
 * the V1 mistake would come back on one of the paths.
 */
export function handoffUrl(issuer: string, authRequestId: string): string {
  const base = (process.env.ZITADEL_LOGIN_V2_BASE_URI?.trim() || `${issuer}/ui/v2/login`).replace(
    /\/+$/,
    "",
  );
  return `${base}/login?authRequest=${encodeURIComponent(authRequestId)}`;
}
