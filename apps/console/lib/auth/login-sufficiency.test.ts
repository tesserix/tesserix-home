import { describe, expect, it } from "vitest";
import {
  TOTP_METHOD,
  decideSufficiency,
  noChecks,
  totpChecked,
  unknownFactors,
  unknownPolicy,
  type EnrolledFactors,
  type LoginPolicySnapshot,
} from "./login-sufficiency";

// This is the one decision in the console's own login path whose failure is
// SILENT: getting it wrong produces a login that works, feels normal, and
// skips a factor the organization configured. Zitadel will not catch it —
// it issues an authorization code for a password-only session even under
// forceMfa when the caller is a login client.
//
// So it is tested exhaustively rather than exercised by clicking through a
// browser.

const noPolicy: LoginPolicySnapshot = { forceMfa: false, forceMfaLocalOnly: false };
const nothingEnrolled: EnrolledFactors = { secondFactorTypes: [], passkeyCount: 0 };
const totpEnrolled: EnrolledFactors = { secondFactorTypes: [TOTP_METHOD], passkeyCount: 0 };

describe("decideSufficiency", () => {
  it("completes only when there is genuinely nothing else to ask for", () => {
    expect(decideSufficiency(noPolicy, nothingEnrolled, noChecks())).toEqual({ outcome: "complete" });
  });

  it("hands off when the policy forces MFA", () => {
    expect(decideSufficiency({ ...noPolicy, forceMfa: true }, nothingEnrolled, noChecks())).toEqual({
      outcome: "handoff",
      reason: "policy-forces-mfa",
    });
  });

  it("treats forceMfaLocalOnly as forcing MFA", () => {
    // This path IS the local login — username and password. The
    // "local only" carve-out exists to exempt federated logins, so on this
    // path the distinction collapses, and it collapses in the safe direction.
    expect(
      decideSufficiency({ forceMfa: false, forceMfaLocalOnly: true }, nothingEnrolled, noChecks()),
    ).toEqual({ outcome: "handoff", reason: "policy-forces-mfa" });
  });

  it("hands off when the user enrolled a second factor, even if policy does not require one", () => {
    // The user chose to protect this account. Completing on a password alone
    // would silently downgrade their own decision — the account would be less
    // protected than its owner believes.
    for (const type of [
      "AUTHENTICATION_METHOD_TYPE_U2F",
      "AUTHENTICATION_METHOD_TYPE_OTP_SMS",
      "AUTHENTICATION_METHOD_TYPE_OTP_EMAIL",
    ]) {
      expect(
        decideSufficiency(noPolicy, { secondFactorTypes: [type], passkeyCount: 0 }, noChecks()),
      ).toEqual({ outcome: "handoff", reason: "user-has-second-factor" });
    }
  });

  it("hands off when the user has a passkey", () => {
    // A passkey is not a second factor, but it means the account is protected
    // by something stronger than a password, and this path must not reduce it
    // to one.
    expect(decideSufficiency(noPolicy, { secondFactorTypes: [], passkeyCount: 1 }, noChecks())).toEqual({
      outcome: "handoff",
      reason: "user-has-passkey",
    });
  });

  it("hands off when the factor lookup failed", () => {
    // The improvised version of "we could not find out" is an empty array,
    // which reads as "nothing enrolled" and COMPLETES the login. That is the
    // bypass this helper exists to prevent, so it is asserted rather than
    // trusted to a convention.
    expect(decideSufficiency(noPolicy, unknownFactors(), noChecks()).outcome).toBe("handoff");
  });

  it("hands off when the policy lookup failed", () => {
    expect(decideSufficiency(unknownPolicy(), nothingEnrolled, noChecks()).outcome).toBe("handoff");
  });

  it("asks for TOTP in-page when a factor is owed and the user has an authenticator", () => {
    // The whole point of the change: this used to hand off to a URL that
    // could not resolve the auth request, so an operator with TOTP could not
    // sign in at all.
    expect(decideSufficiency(noPolicy, totpEnrolled, noChecks())).toEqual({ outcome: "totp" });
    expect(decideSufficiency({ ...noPolicy, forceMfa: true }, totpEnrolled, noChecks())).toEqual({
      outcome: "totp",
    });
    // A passkey alongside TOTP is still answerable in-page: password + TOTP is
    // two factors, which is what the passkey rule was protecting.
    expect(
      decideSufficiency(noPolicy, { secondFactorTypes: [TOTP_METHOD], passkeyCount: 2 }, noChecks()),
    ).toEqual({ outcome: "totp" });
  });

  it("still hands off when MFA is forced but the user has no authenticator to answer with", () => {
    // Enrolment is not something this page can do. Zitadel's own UI can.
    expect(decideSufficiency({ ...noPolicy, forceMfa: true }, nothingEnrolled, noChecks())).toEqual({
      outcome: "handoff",
      reason: "policy-forces-mfa",
    });
  });

  it("never asks for TOTP when the factor lookup failed", () => {
    // `unknownFactors()` means "we could not find out". Prompting for a code
    // the account may not have would be a dead end dressed as a challenge.
    expect(decideSufficiency(noPolicy, unknownFactors(), noChecks()).outcome).toBe("handoff");
  });

  it("completes once THIS session has verified a TOTP code", () => {
    // Password + TOTP is MFA. Re-deriving the decision with the verified check
    // is how the completion proof is obtained after the in-page prompt —
    // nothing casts its way past the decision.
    expect(decideSufficiency(unknownPolicy(), totpEnrolled, totpChecked())).toEqual({
      outcome: "complete",
    });
  });

  it("never completes on any input carrying a factor or a forcing policy", () => {
    // Exhaustive over the decision's whole input space, so a future edit that
    // reorders the checks cannot open a gap that the examples above happen to
    // miss.
    for (const forceMfa of [false, true]) {
      for (const forceMfaLocalOnly of [false, true]) {
        for (const secondFactorTypes of [[], ["AUTHENTICATION_METHOD_TYPE_U2F"], [TOTP_METHOD]]) {
          for (const passkeyCount of [0, 1]) {
            for (const checks of [noChecks(), totpChecked()]) {
              const result = decideSufficiency(
                { forceMfa, forceMfaLocalOnly },
                { secondFactorTypes, passkeyCount },
                checks,
              );
              const nothingToAsk =
                !forceMfa &&
                !forceMfaLocalOnly &&
                secondFactorTypes.length === 0 &&
                passkeyCount === 0;

              if (checks.totpVerified || nothingToAsk) {
                expect(result.outcome).toBe("complete");
                continue;
              }
              // The invariant that matters: with a factor owed and nothing
              // verified, the login MUST NOT complete. It may only prompt or
              // hand off.
              expect(result.outcome).toBe(
                secondFactorTypes.includes(TOTP_METHOD) ? "totp" : "handoff",
              );
            }
          }
        }
      }
    }
  });
});
