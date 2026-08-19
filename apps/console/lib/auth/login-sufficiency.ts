/**
 * Whether a Zitadel session is allowed to complete a login.
 *
 * # Why this file exists at all
 *
 * When the console drives login itself through Zitadel's session API — as a
 * "login client" — **Zitadel does not enforce MFA.** It will issue an
 * authorization code for a password-only session even when the organization's
 * login policy sets `forceMfa`. Helivanta proved this against the live
 * instance and its client carries the finding in a comment; this module is the
 * console's answer to it.
 *
 * That inverts the usual assumption. On Zitadel's own hosted login, MFA is the
 * identity provider's job and the application cannot weaken it. Here the
 * application is the login, so the second factor happens only if this code
 * says it must. Getting this wrong does not fail loudly — it produces a login
 * that works, feels normal, and quietly skips a factor the org configured.
 *
 * # The rule
 *
 * A password-only session may complete ONLY when there is no second factor to
 * ask for: the policy does not force MFA, and the user has enrolled none.
 * Anything else hands off to Zitadel's own login UI, which knows how to
 * collect every factor type this instance supports.
 *
 * Handing off rather than implementing TOTP and U2F here is deliberate for a
 * first version. A half-built factor prompt is worse than none: it is the
 * screen an operator meets when their account is most sensitive, and Zitadel's
 * already handles enrolment, recovery codes and WebAuthn correctly.
 */

/** The subset of the org login policy this decision reads. */
export interface LoginPolicySnapshot {
  /** `forceMfa` on the org (or instance) login policy. */
  readonly forceMfa: boolean;
  /**
   * `forceMfaLocalOnly` — MFA required for local logins but not for federated
   * ones. Read as forcing MFA here: this path is username+password, which IS
   * the local login, so the distinction collapses in our favour.
   */
  readonly forceMfaLocalOnly: boolean;
}

/** What the user has actually enrolled. */
export interface EnrolledFactors {
  /** TOTP, U2F, OTP-SMS, OTP-email — anything Zitadel counts as a second factor. */
  readonly secondFactorTypes: readonly string[];
  /** Passkeys. A passwordless credential is not a second factor, but its
   *  presence means the account is protected by something stronger than a
   *  password and must not be reduced to one. */
  readonly passkeyCount: number;
}

export type Sufficiency =
  | { readonly outcome: "complete" }
  | { readonly outcome: "handoff"; readonly reason: HandoffReason };

export type HandoffReason = "policy-forces-mfa" | "user-has-second-factor" | "user-has-passkey";

/**
 * Decide whether a password-only session may finish the login.
 *
 * Pure, and deliberately so: this is the one decision in the login path whose
 * failure is silent, so it is tested exhaustively rather than exercised by
 * clicking through a browser.
 *
 * Fails CLOSED on every uncertain input. An empty factor list from a failed
 * lookup must not read as "no factors enrolled" — callers pass what they know,
 * and a caller that could not determine the factors passes `unknownFactors()`,
 * which hands off.
 */
export function decideSufficiency(
  policy: LoginPolicySnapshot,
  factors: EnrolledFactors,
): Sufficiency {
  if (policy.forceMfa || policy.forceMfaLocalOnly) {
    return { outcome: "handoff", reason: "policy-forces-mfa" };
  }
  if (factors.secondFactorTypes.length > 0) {
    // The user chose to protect this account with a second factor. Completing
    // on a password alone would silently downgrade their own decision.
    return { outcome: "handoff", reason: "user-has-second-factor" };
  }
  if (factors.passkeyCount > 0) {
    return { outcome: "handoff", reason: "user-has-passkey" };
  }
  return { outcome: "complete" };
}

/**
 * What to pass when the factor lookup failed.
 *
 * Named rather than left to each caller to improvise, because the improvised
 * version is `{ secondFactorTypes: [], passkeyCount: 0 }` — which reads as
 * "nothing enrolled" and completes the login. The failure mode of a lookup
 * error must be a hand-off, not a bypass.
 */
export function unknownFactors(): EnrolledFactors {
  return { secondFactorTypes: ["unknown"], passkeyCount: 0 };
}

/**
 * What to pass when the policy lookup failed. Forces a hand-off for the same
 * reason.
 */
export function unknownPolicy(): LoginPolicySnapshot {
  return { forceMfa: true, forceMfaLocalOnly: true };
}
