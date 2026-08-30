"use server";

import {
  LoginClientError,
  addTotpCheck,
  checkSufficiency,
  createPasswordSession,
  finalize,
  getAuthRequest,
  getEnrolledFactors,
  getLoginPolicy,
  loginClientConfig,
  type LoginSession,
  type TotpVerified,
} from "@/lib/auth/zitadel-login-client";
import {
  clearPendingSession,
  readPendingSession,
  savePendingSession,
} from "./pending-session";

/**
 * The console's own credential check.
 *
 * Runs the whole login-client dance: read the pending auth request, create a
 * session from the login name and password, decide whether that session is
 * enough, and then either finish the login, ask for the authenticator code, or
 * hand the browser to Zitadel's own UI for a factor this page does not collect.
 */

export type LoginOutcome =
  | { readonly outcome: "complete"; readonly callbackUrl: string }
  /** Ask for a six-digit code, then call `submitTotp`. */
  | { readonly outcome: "second-factor"; readonly factor: "totp" }
  | { readonly outcome: "handoff"; readonly handoffUrl: string; readonly reason: string }
  | { readonly outcome: "failed"; readonly message: string }
  | { readonly outcome: "restart"; readonly message: string }
  | { readonly outcome: "unavailable"; readonly message: string };

/**
 * One message for every credential failure.
 *
 * Zitadel distinguishes "no such user" from "wrong password" and this must
 * not. The instance already has `ignoreUnknownUsernames` on for the same
 * reason, and it would be undone by a login page that helpfully said which
 * half was wrong.
 */
const CREDENTIAL_FAILURE = "That username and password don't match.";

/**
 * A rejected authenticator code.
 *
 * Distinct from CREDENTIAL_FAILURE, and safely so: this message is only ever
 * reached by someone who already passed the password check, so it reveals
 * nothing about whether an account exists that they did not already know. It
 * says nothing about enrolment for the same reason the other message says
 * nothing about which half was wrong.
 */
const TOTP_FAILURE = "That code didn't work. Try the next one from your authenticator.";

/** Neither half is unrecoverable, but both need the whole login started over. */
const RESTART = "This sign-in link has expired. Start again.";
const UNAVAILABLE = "Sign-in is temporarily unavailable.";

export async function submitCredentials(input: {
  authRequestId: string;
  loginName: string;
  password: string;
}): Promise<LoginOutcome> {
  const config = loginClientConfig();
  if (!config) {
    // Not a credential problem, and it must not be reported as one: this
    // deployment has no login-client token, so it cannot host its own login
    // at all. Telling the operator their password was wrong would send them
    // to reset a password that works.
    return {
      outcome: "unavailable",
      message: "Sign-in is not configured on this deployment.",
    };
  }

  const loginName = input.loginName.trim();
  if (!loginName || !input.password) {
    return { outcome: "failed", message: CREDENTIAL_FAILURE };
  }

  try {
    // Read the auth request FIRST. One that has expired or already been used
    // — a tab left open, a bookmarked URL — is a "start again", and finding
    // out before a credential is typed is kinder than after.
    await getAuthRequest(config, input.authRequestId);

    const session = await createPasswordSession(config, loginName, input.password);

    // Zitadel does NOT enforce MFA for a login client. Whether this session is
    // enough is the console's decision, and it is made here. `null`: nothing
    // beyond the password has been checked yet.
    const { sufficiency, proof } = await decide(config, session, null);

    if (proof) {
      await clearPendingSession();
      return {
        outcome: "complete",
        callbackUrl: await finalize(config, input.authRequestId, session, proof),
      };
    }

    if (sufficiency.outcome === "totp") {
      // Park the session for the code prompt. Nothing about it reaches the
      // browser's JavaScript — see `pending-session.ts`.
      await savePendingSession({
        authRequestId: input.authRequestId,
        sessionId: session.id,
        sessionToken: session.token,
      });
      return { outcome: "second-factor", factor: "totp" };
    }

    return {
      outcome: "handoff",
      reason: sufficiency.outcome === "handoff" ? sufficiency.reason : "unknown",
      handoffUrl: handoffUrl(config.issuer, input.authRequestId),
    };
  } catch (error) {
    return failure(error, CREDENTIAL_FAILURE);
  }
}

/**
 * The second step: an authenticator code against the parked session.
 *
 * Separate from `submitCredentials` rather than a branch inside it, because
 * the password must not be held anywhere to get here. The session the password
 * already produced is what carries the login forward.
 */
export async function submitTotp(input: {
  authRequestId: string;
  code: string;
}): Promise<LoginOutcome> {
  const config = loginClientConfig();
  if (!config) {
    return {
      outcome: "unavailable",
      message: "Sign-in is not configured on this deployment.",
    };
  }

  const pending = await readPendingSession(input.authRequestId);
  if (!pending) {
    // The cookie expired, or belongs to a different auth request. Either way
    // the password step has to happen again — there is no session to add a
    // check to, and inventing one would mean a code alone could sign in.
    return { outcome: "restart", message: RESTART };
  }

  const code = input.code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) {
    // Rejected without a round trip, and with the same message as a wrong
    // code: a distinct "that isn't six digits" would be one more signal than
    // this page owes anyone.
    return { outcome: "failed", message: TOTP_FAILURE };
  }

  const session: LoginSession = { id: pending.sessionId, token: pending.sessionToken };

  try {
    // The pending cookie is deliberately left in place through a failure: an
    // operator whose authenticator rolled over mid-type must be able to enter
    // the next code, not be sent back to the password field. It clears on
    // completion, on a restart, and on its own five-minute expiry.
    const verified: TotpVerified = await addTotpCheck(config, session, code);

    // Back through the SAME decision, now carrying the verified check. This is
    // the only way to obtain the completion proof — the alternative, assuming
    // a successful check means the login may finish, is the assumption this
    // whole design exists to make unexpressible.
    const { sufficiency, proof } = await decide(config, session, verified);

    if (!proof) {
      // Not reachable from the rules as they stand, and not asserted away
      // either: if a future rule makes a verified code insufficient, this must
      // stop the login rather than quietly complete it.
      console.warn("[login] totp verified but the session is still insufficient", {
        outcome: sufficiency.outcome,
      });
      return { outcome: "unavailable", message: UNAVAILABLE };
    }

    const callbackUrl = await finalize(config, input.authRequestId, session, proof);
    await clearPendingSession();
    return { outcome: "complete", callbackUrl };
  } catch (error) {
    return failure(error, TOTP_FAILURE);
  }
}

/**
 * Read the policy and the enrolled factors, and put them to the decision.
 *
 * One helper for both steps so the two cannot drift: the second step has to
 * ask the same question of the same inputs, or "re-deriving the decision"
 * would be re-deriving a different one.
 */
async function decide(
  config: NonNullable<ReturnType<typeof loginClientConfig>>,
  session: LoginSession,
  verifiedTotp: TotpVerified | null,
) {
  const [policy, factors] = await Promise.all([
    getLoginPolicy(config),
    getEnrolledFactors(config, session),
  ]);
  return checkSufficiency(policy, factors, verifiedTotp);
}

/**
 * Turn a thrown error into an outcome, without saying which secret was wrong.
 *
 * `credentialMessage` is the caller's own "you got the secret wrong" copy —
 * the password message on the first step, the code message on the second.
 */
function failure(error: unknown, credentialMessage: string): LoginOutcome {
  if (error instanceof LoginClientError) {
    // Logged with its kind, answered without it. The kinds distinguish an
    // unknown user from a wrong password, which is exactly what the
    // response must not reveal.
    console.warn("[login] credential check failed", { kind: error.kind, message: error.message });
    if (error.kind === "auth-request") {
      return { outcome: "restart", message: RESTART };
    }
    if (error.kind === "bad-credentials") {
      return { outcome: "failed", message: credentialMessage };
    }
    return { outcome: "unavailable", message: UNAVAILABLE };
  }
  console.error("[login] unexpected failure", error);
  return { outcome: "unavailable", message: UNAVAILABLE };
}

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
 */
function handoffUrl(issuer: string, authRequestId: string): string {
  const base = (process.env.ZITADEL_LOGIN_V2_BASE_URI?.trim() || `${issuer}/ui/v2/login`).replace(
    /\/+$/,
    "",
  );
  return `${base}/login?authRequest=${encodeURIComponent(authRequestId)}`;
}
