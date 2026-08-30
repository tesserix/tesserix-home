"use client";

import { useState, useTransition } from "react";
import {
  AuthCredentialForm,
  AuthOtpStep,
  AuthPanel,
  type AuthCredentialValues,
} from "@tesserix/web";

import { submitCredentials, submitTotp, type LoginOutcome } from "./actions";

/**
 * The console's sign-in form.
 *
 * Built from @tesserix/web's auth components rather than bespoke markup, so it
 * inherits the console's own tokens: `app/globals.css` maps that package onto
 * the console's CSS variables through `@theme inline`, which is what makes
 * this page look like the console instead of like a login page that happens to
 * live next to it.
 *
 * # One page for the credentials
 *
 * The login name and the password are collected together and submitted in one
 * call. `createPasswordSession` always sent both at once — the split was never
 * a protocol constraint.
 *
 * This form used to be stepped, login name then password, and the reason
 * recorded here was that "that is the shape Zitadel's own login uses, and an
 * operator moving between the two should not have to relearn the form". That
 * reason no longer governs. Since #439 fixed the hand-off, this page is the
 * primary sign-in surface rather than a lookalike an operator is bounced away
 * from, so matching Zitadel's shape buys nothing; and a password manager can
 * fill a username/password pair in one go, which a stepped form denies it.
 *
 * # The argument for stepping, kept rather than deleted
 *
 * Stepping exists so an identity provider can be chosen BEFORE a password is
 * asked for — with several federated domains, which IdP a login name belongs
 * to decides whether a password should be asked for at all. That is a real
 * benefit, and this change gives it up knowingly: the estate has one IdP and a
 * small operator set, so nothing is currently branching on the login name. If
 * a second federated domain ever appears, stepping earns its keep again and
 * this decision should be reopened rather than treated as settled.
 *
 * # The authenticator code stays a separate step
 *
 * It is owed only when the account has a factor, and only knowable once the
 * session exists — there is nothing to ask for until the password has been
 * checked. Folding it in would mean prompting every operator for a code most
 * of them do not have.
 *
 * That step exists at all because the hand-off could not carry it: it pointed
 * at Zitadel's V1 login UI, which cannot resolve an auth request created
 * through the OIDC v2 service, so an operator with an authenticator could not
 * sign in at all. Only TOTP is collected here. A security key still hands off,
 * because a half-built WebAuthn prompt is worse than none.
 */
export function LoginForm({ authRequestId }: { authRequestId: string }) {
  const [values, setValues] = useState<AuthCredentialValues>({ loginName: "", password: "" });
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(next: AuthCredentialValues) {
    run(() =>
      submitCredentials({
        authRequestId,
        loginName: next.loginName ?? "",
        password: next.password ?? "",
      }),
    );
  }

  function onSubmitCode(entered: string) {
    // The password is long gone from this component by now; the server holds
    // the session it produced. The code is all this step carries.
    run(() => submitTotp({ authRequestId, code: entered }));
  }

  function run(action: () => Promise<LoginOutcome>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result: LoginOutcome = await action();

      switch (result.outcome) {
        case "complete":
          // A full URL on Zitadel's side, so assign rather than route(): this
          // deliberately leaves the SPA.
          window.location.assign(result.callbackUrl);
          return;
        case "second-factor":
          // Collected here, on the console's own page. Nothing navigates.
          setCode("");
          setStep("totp");
          return;
        case "handoff":
          // The account needs a factor this page does not collect — a
          // security key, or an enrolment this page cannot run. Zitadel's own
          // Login V2 resumes the SAME auth request, so the operator still
          // lands back at the console's callback rather than signing in
          // twice; it does start that request from the login name, so they
          // re-enter their credentials there.
          setNotice("Finishing sign-in with your second factor…");
          window.location.assign(result.handoffUrl);
          return;
        case "restart":
          setError(result.message);
          setCode("");
          setStep("credentials");
          return;
        default:
          setError(result.message);
          // Stay where the operator is. A rejected code must leave them on the
          // code field with the next one already coming — sending them back to
          // the credentials would be the dead end this step exists to remove.
          // A rejected credential leaves them on the credential form with both
          // fields as they typed them, because this page cannot tell them
          // which half was wrong and re-typing both would be busywork.
          setCode("");
      }
    });
  }

  return (
    <AuthPanel
      title="Tesserix Console"
      tagline="Sign in to continue"
      // No brandColor: the panel then paints from the host's design tokens,
      // which are the console's. Passing one here would introduce a second
      // source of truth for a colour the console already defines.
      mode="auto"
    >
      {step === "totp" ? (
        <AuthOtpStep
          factor="totp"
          value={code}
          onValueChange={setCode}
          onSubmit={onSubmitCode}
          loading={pending}
          error={error ?? notice}
        />
      ) : (
        <AuthCredentialForm
          // Unstepped, so both fields render at once with their own
          // `autoComplete` of "username" and "current-password".
          //
          // `error` is the form-level slot, and it is the ONLY one used here:
          // `loginNameError` and `passwordError` would hang the message on a
          // field, marking that input `aria-invalid` and telling the operator
          // — and anyone probing — which half was wrong. The instance runs
          // `ignoreUnknownUsernames` precisely so that cannot be learned, and
          // with both fields on one page a field-level error would be the
          // whole answer.
          values={values}
          onValuesChange={setValues}
          onSubmit={onSubmit}
          loading={pending}
          error={error ?? notice}
          submitLabel="Sign in"
        />
      )}
    </AuthPanel>
  );
}
