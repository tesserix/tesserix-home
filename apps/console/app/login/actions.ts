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
  clearTotpFailures,
  recordLoginIdentity,
  recordTotpFailure,
  totpCooldownFor,
} from "@/lib/db/login-throttle";
import { handoffUrl } from "./handoff";
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

/**
 * A code the console declined to forward (#457).
 *
 * NOT "locked", and not by accident. The operator is not locked — Zitadel's
 * counter was never touched, which is the entire point of declining — and the
 * console is exactly where they would come to find out whether they were. The
 * wrong word here sends someone to a break-glass procedure for a state that
 * clears itself.
 *
 * So it says two things and no more: the attempt was not sent, and when to
 * come back. The minutes are rounded UP and floored at one, because "try again
 * in 0 minutes" reads as a bug and a rounded-down estimate would send them
 * back a moment early to be refused again.
 */
function totpCooldownMessage(retryAt: Date): string {
  const minutes = Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 60_000));
  return (
    `Too many incorrect codes. This one wasn't sent — ` +
    `try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`
  );
}

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

      // The ONE place a login name enters the attempt limiter, and it enters
      // it here — after the password check passed, from the server's own hand
      // — rather than at the code step from the cookie. `login-throttle.ts`
      // carries the argument; the short version is that a login name read
      // back out of `tx_login_pending` would be one the client chose, so an
      // attacker could spend any operator's attempts without holding their
      // password.
      //
      // After `savePendingSession` because it records the session that cookie
      // carries: written first, a failure to set the cookie would leave a
      // mapping for a login that never continued.
      await recordLoginIdentity(
        { authRequestId: input.authRequestId, sessionId: session.id },
        loginName,
      );

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

  // The limiter's key, and note what it is NOT: a login name. Both halves are
  // opaque server-issued handles, and the login name they resolve to is the
  // one the server recorded at the password step.
  const pendingLogin = { authRequestId: input.authRequestId, sessionId: pending.sessionId };

  // BEFORE `addTotpCheck`, and before the format check too. Not spending a
  // Zitadel attempt is the whole mechanism, so this cannot move below the
  // call; it sits above the format check as well so a throttled operator who
  // also mistypes learns the real reason rather than being told their code was
  // wrong.
  const cooldown = await totpCooldownFor(pendingLogin);
  if (cooldown) {
    return { outcome: "failed", message: totpCooldownMessage(cooldown.retryAt) };
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

    // Mirrors Zitadel's own reset-on-success, and for the same reason: the
    // code checked out, so whoever typed it is the operator, and carrying
    // their earlier fumbles forward would let an ordinary week's typing
    // accumulate into a cooldown. Here rather than after `finalize` because
    // this is the moment the factor was proven; a login that then fails
    // sufficiency has still proven it.
    await clearTotpFailures(pendingLogin);

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
    // Count ONLY a code Zitadel actually saw and actually rejected. Any other
    // kind — an expired auth request, an unreachable IdP — may not have
    // advanced Zitadel's own counter, so counting it would let a bad afternoon
    // on the network spend an operator's attempts for them.
    if (error instanceof LoginClientError && error.kind === "bad-credentials") {
      await recordTotpFailure(pendingLogin);
    }
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
