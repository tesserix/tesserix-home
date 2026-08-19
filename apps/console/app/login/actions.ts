"use server";

import {
  LoginClientError,
  checkSufficiency,
  createPasswordSession,
  finalize,
  getAuthRequest,
  getEnrolledFactors,
  getLoginPolicy,
  loginClientConfig,
} from "@/lib/auth/zitadel-login-client";

/**
 * The console's own credential check.
 *
 * Runs the whole login-client dance: read the pending auth request, create a
 * session from the login name and password, decide whether that session is
 * enough, and either finish the login or hand the browser to Zitadel's own UI
 * for the factor this page does not collect.
 */

export type LoginOutcome =
  | { readonly outcome: "complete"; readonly callbackUrl: string }
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
    // enough is the console's decision, and it is made here.
    const [policy, factors] = await Promise.all([
      getLoginPolicy(config),
      getEnrolledFactors(config, session),
    ]);
    const { sufficiency, proof } = checkSufficiency(policy, factors);

    if (!proof) {
      const reason = sufficiency.outcome === "handoff" ? sufficiency.reason : "unknown";
      return {
        outcome: "handoff",
        reason,
        handoffUrl: handoffUrl(config.issuer, input.authRequestId),
      };
    }

    return { outcome: "complete", callbackUrl: await finalize(config, input.authRequestId, session, proof) };
  } catch (error) {
    if (error instanceof LoginClientError) {
      // Logged with its kind, answered without it. The kinds distinguish an
      // unknown user from a wrong password, which is exactly what the
      // response must not reveal.
      console.warn("[login] credential check failed", { kind: error.kind, message: error.message });
      if (error.kind === "auth-request") {
        return { outcome: "restart", message: "This sign-in link has expired. Start again." };
      }
      if (error.kind === "bad-credentials") {
        return { outcome: "failed", message: CREDENTIAL_FAILURE };
      }
      return { outcome: "unavailable", message: "Sign-in is temporarily unavailable." };
    }
    console.error("[login] unexpected failure", error);
    return { outcome: "unavailable", message: "Sign-in is temporarily unavailable." };
  }
}

/**
 * Where to send a browser this page cannot finish authenticating.
 *
 * Zitadel's own login, resuming the SAME auth request — so the operator
 * completes their factor there and lands back at the console's callback with
 * no second sign-in. It is the hosted UI's own entry point, which is why this
 * hand-off costs the user nothing but a change of styling.
 */
function handoffUrl(issuer: string, authRequestId: string): string {
  return `${issuer}/ui/login/login?authRequestID=${encodeURIComponent(authRequestId)}`;
}
