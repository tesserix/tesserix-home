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
 * Stepped — login name, then password, then the authenticator code when one is
 * owed — because that is the shape Zitadel's own login uses, and an operator
 * moving between the two should not have to relearn the form.
 *
 * The third step exists because the hand-off could not carry it: it pointed at
 * Zitadel's V1 login UI, which cannot resolve an auth request created through
 * the OIDC v2 service, so an operator with an authenticator could not sign in
 * at all. Only TOTP is collected here. A security key still hands off, because
 * a half-built WebAuthn prompt is worse than none.
 */
export function LoginForm({ authRequestId }: { authRequestId: string }) {
  const [values, setValues] = useState<AuthCredentialValues>({ loginName: "", password: "" });
  const [step, setStep] = useState<"loginName" | "password" | "totp">("loginName");
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
          setStep("loginName");
          return;
        default:
          setError(result.message);
          // Stay where the operator is. A rejected code must leave them on the
          // code field with the next one already coming — sending them back to
          // the password would be the dead end this step exists to remove.
          // Otherwise: back to the password field, never the login name.
          // Re-typing a username that was accepted is busywork, and this page
          // cannot tell the operator which half was wrong anyway.
          setCode("");
          setStep((current) => (current === "totp" ? "totp" : "password"));
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
          stepped
          step={step}
          onStepChange={setStep}
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
