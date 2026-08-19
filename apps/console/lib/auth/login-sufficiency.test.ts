import { describe, expect, it } from "vitest";
import {
  decideSufficiency,
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

describe("decideSufficiency", () => {
  it("completes only when there is genuinely nothing else to ask for", () => {
    expect(decideSufficiency(noPolicy, nothingEnrolled)).toEqual({ outcome: "complete" });
  });

  it("hands off when the policy forces MFA", () => {
    expect(decideSufficiency({ ...noPolicy, forceMfa: true }, nothingEnrolled)).toEqual({
      outcome: "handoff",
      reason: "policy-forces-mfa",
    });
  });

  it("treats forceMfaLocalOnly as forcing MFA", () => {
    // This path IS the local login — username and password. The
    // "local only" carve-out exists to exempt federated logins, so on this
    // path the distinction collapses, and it collapses in the safe direction.
    expect(
      decideSufficiency({ forceMfa: false, forceMfaLocalOnly: true }, nothingEnrolled),
    ).toEqual({ outcome: "handoff", reason: "policy-forces-mfa" });
  });

  it("hands off when the user enrolled a second factor, even if policy does not require one", () => {
    // The user chose to protect this account. Completing on a password alone
    // would silently downgrade their own decision — the account would be less
    // protected than its owner believes.
    for (const type of ["TOTP", "U2F", "OTP_SMS", "OTP_EMAIL"]) {
      expect(
        decideSufficiency(noPolicy, { secondFactorTypes: [type], passkeyCount: 0 }),
      ).toEqual({ outcome: "handoff", reason: "user-has-second-factor" });
    }
  });

  it("hands off when the user has a passkey", () => {
    // A passkey is not a second factor, but it means the account is protected
    // by something stronger than a password, and this path must not reduce it
    // to one.
    expect(decideSufficiency(noPolicy, { secondFactorTypes: [], passkeyCount: 1 })).toEqual({
      outcome: "handoff",
      reason: "user-has-passkey",
    });
  });

  it("hands off when the factor lookup failed", () => {
    // The improvised version of "we could not find out" is an empty array,
    // which reads as "nothing enrolled" and COMPLETES the login. That is the
    // bypass this helper exists to prevent, so it is asserted rather than
    // trusted to a convention.
    expect(decideSufficiency(noPolicy, unknownFactors()).outcome).toBe("handoff");
  });

  it("hands off when the policy lookup failed", () => {
    expect(decideSufficiency(unknownPolicy(), nothingEnrolled).outcome).toBe("handoff");
  });

  it("never completes on any input carrying a factor or a forcing policy", () => {
    // Exhaustive over the decision's whole input space, so a future edit that
    // reorders the checks cannot open a gap that the examples above happen to
    // miss.
    for (const forceMfa of [false, true]) {
      for (const forceMfaLocalOnly of [false, true]) {
        for (const secondFactorTypes of [[], ["TOTP"]]) {
          for (const passkeyCount of [0, 1]) {
            const result = decideSufficiency(
              { forceMfa, forceMfaLocalOnly },
              { secondFactorTypes, passkeyCount },
            );
            const nothingToAsk =
              !forceMfa && !forceMfaLocalOnly && secondFactorTypes.length === 0 && passkeyCount === 0;
            expect(result.outcome).toBe(nothingToAsk ? "complete" : "handoff");
          }
        }
      }
    }
  });
});
