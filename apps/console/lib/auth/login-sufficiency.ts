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
 * Anything else must produce the missing factor before the login can finish.
 *
 * # TOTP is collected here; everything else still hands off
 *
 * The first version handed EVERY factor off to Zitadel's own login UI. That
 * path was never exercised until an operator needed a factor, and it turned
 * out to be broken: it pointed at the V1 hosted UI, which cannot resolve an
 * auth request created through the OIDC **v2** service and answers
 * `Errors.AuthRequest.NotFound (CACHE-d24aD)`. The operator could load the
 * page, type a correct password, and never get in.
 *
 * TOTP now resolves in-page, because it is a six-digit code and nothing more:
 * the console can collect it and hand it to Zitadel's session API without
 * reimplementing anything security-relevant. U2F and passkeys still hand off —
 * a half-built WebAuthn prompt is worse than none, and Zitadel's UI already
 * handles enrolment, recovery codes and WebAuthn correctly.
 *
 * Enrolment is likewise not something this page can do, so "MFA is forced and
 * the user has no authenticator" is still a hand-off.
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
  /** The session may be handed to the auth request as it stands. */
  | { readonly outcome: "complete" }
  /** Ask for a six-digit authenticator code in-page, then decide again. */
  | { readonly outcome: "totp" }
  /** This page cannot produce the missing factor; Zitadel's own login can. */
  | { readonly outcome: "handoff"; readonly reason: HandoffReason };

/**
 * Zitadel's `authMethodTypes` value for an authenticator app.
 *
 * Matched exactly, and only in this spelling. A looser match ("does it contain
 * TOTP") would let an unfamiliar future value route an operator to a code
 * prompt their account cannot answer; an unrecognised value has to fall
 * through to the hand-off, which is the outcome that copes with anything.
 */
export const TOTP_METHOD = "AUTHENTICATION_METHOD_TYPE_TOTP";

/** Zitadel's `authMethodTypes` value for a passwordless credential. */
export const PASSKEY_METHOD = "AUTHENTICATION_METHOD_TYPE_PASSKEY";

/**
 * The methods Zitadel lists that are NOT a second factor.
 *
 * `ListAuthenticationMethodTypes` answers with one flat list mixing the ways a
 * user can prove the FIRST factor with the ways they can prove a second, and
 * nothing in the response distinguishes them. From Zitadel v4.15.3's own
 * `AuthenticationMethodType` enum the full set is UNSPECIFIED, PASSWORD,
 * PASSKEY, IDP, TOTP, U2F, OTP_SMS, OTP_EMAIL, RECOVERY_CODE.
 *
 * # IDP is the one that cost two weeks
 *
 * A federated identity-provider link is how a user signs in, not an extra
 * thing they must produce afterwards. Zitadel returns
 * `["...PASSWORD", "...IDP"]` for every console operator linked to the Google
 * IdP — which the first version of this code, filtering out only PASSWORD and
 * PASSKEY, read as an enrolled second factor. The decision then owed a factor
 * that no page can collect, so every operator typed a correct password on the
 * console and landed on Zitadel's hosted login. VERIFIED against the live
 * instance: that is the literal response for the affected accounts.
 *
 * PASSKEY is excluded here because it is counted separately — a passwordless
 * credential is not a second factor, but it is not nothing either.
 */
const NOT_A_SECOND_FACTOR: ReadonlySet<string> = new Set([
  "AUTHENTICATION_METHOD_TYPE_PASSWORD",
  PASSKEY_METHOD,
  "AUTHENTICATION_METHOD_TYPE_IDP",
]);

/**
 * Turn Zitadel's `authMethodTypes` into the shape the decision reads.
 *
 * Deliberately an EXCLUDE list rather than an include list. An include list of
 * known second factors would silently drop a value this build has never seen,
 * and dropping it decides "nothing enrolled" — a login completed on a password
 * alone. Excluding only the three that are provably not second factors makes
 * an unrecognised value push towards the hand-off, which is the same
 * fail-closed direction `unknownFactors()` encodes.
 *
 * RECOVERY_CODE therefore counts as a second factor. It is really a fallback
 * for one, but a user holding recovery codes holds the factor they back up,
 * and erring towards asking is the safe half of the error.
 */
export function classifyAuthMethods(types: readonly string[]): EnrolledFactors {
  return {
    secondFactorTypes: types.filter((type) => !NOT_A_SECOND_FACTOR.has(type)),
    passkeyCount: types.filter((type) => type === PASSKEY_METHOD).length,
  };
}

/**
 * What THIS session has proved beyond the password.
 *
 * Not "what the user could prove" — `EnrolledFactors` already says that. This
 * is the narrower and more dangerous question: what Zitadel has actually
 * accepted against this session id. Only a check that succeeded may set it.
 */
export interface SessionChecks {
  readonly totpVerified: boolean;
  /**
   * Zitadel accepted a completed identity-provider intent against this session
   * — the operator arrived through "Continue with Google" rather than by
   * typing a password here.
   *
   * Recorded because ONE rule turns on it, `forceMfaLocalOnly`, and that rule
   * is otherwise unreadable from the session alone: a federated session and a
   * password session look identical to `decideSufficiency` once they exist.
   */
  readonly idpVerified: boolean;
}

/** The state of every session before a second factor has been offered. */
export function noChecks(): SessionChecks {
  return { totpVerified: false, idpVerified: false };
}

/**
 * A session created from a completed identity-provider intent.
 *
 * Built by the login client from the branded token `retrieveIdpIntent`
 * returns, on the same principle as `totpChecked()`: a caller cannot claim a
 * federated login it did not perform, because claiming one is what buys the
 * `forceMfaLocalOnly` exemption below.
 */
export function idpChecked(): SessionChecks {
  return { totpVerified: false, idpVerified: true };
}

/**
 * A session whose TOTP code Zitadel accepted.
 *
 * Exported for tests and for the login client, which is the only production
 * caller — it builds one from the branded token `addTotpCheck` returns, so a
 * caller cannot assert a verification it never performed.
 */
export function totpChecked(): SessionChecks {
  return { totpVerified: true, idpVerified: false };
}

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
  checks: SessionChecks,
): Sufficiency {
  if (checks.totpVerified) {
    // Password plus an authenticator code IS multi-factor, which answers every
    // reason below at once: the forcing policy, the factor the user chose, and
    // the passkey rule's concern that the account not be reduced to a password.
    return { outcome: "complete" };
  }

  const owesAFactor =
    // Unconditional, and it does not care how the first factor was proved: a
    // federated login is still one factor.
    policy.forceMfa ||
    // The one rule a federated login is exempt from, and deliberately an
    // explicit branch rather than a side effect of which path got here.
    //
    // "MFA required for local logins but not federated ones" is the whole
    // content of the flag. The password path reads it as forcing MFA because
    // that path IS the local login; the IdP path is the other half of the same
    // sentence. Left implicit, this would either force a factor on federated
    // operators that the org exempted, or — far worse, if written the other
    // way round — quietly stop forcing it on the local ones.
    //
    // An org that wants MFA for everyone sets `forceMfa`, which is above and
    // has no exemption. `unknownPolicy()` sets both, so a policy this code
    // could not read still hands off no matter which path is running.
    (policy.forceMfaLocalOnly && !checks.idpVerified) ||
    // The user chose to protect this account with a second factor. Completing
    // on a password alone would silently downgrade their own decision.
    factors.secondFactorTypes.length > 0 ||
    // A passkey is not a second factor, but it means the account is protected
    // by something stronger than a password, and this path must not reduce it
    // to one.
    factors.passkeyCount > 0;

  if (!owesAFactor) {
    return { outcome: "complete" };
  }

  if (factors.secondFactorTypes.includes(TOTP_METHOD)) {
    // Answerable here. Note this is reached only from a factor list we
    // actually read: `unknownFactors()` carries no recognised method, so a
    // failed lookup cannot produce a code prompt the account may not answer.
    return { outcome: "totp" };
  }

  if (policy.forceMfa || (policy.forceMfaLocalOnly && !checks.idpVerified)) {
    return { outcome: "handoff", reason: "policy-forces-mfa" };
  }
  if (factors.secondFactorTypes.length > 0) {
    return { outcome: "handoff", reason: "user-has-second-factor" };
  }
  return { outcome: "handoff", reason: "user-has-passkey" };
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
