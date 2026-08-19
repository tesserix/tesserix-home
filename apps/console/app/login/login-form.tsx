"use client";

import { useState, useTransition } from "react";
import { AuthCredentialForm, AuthPanel, type AuthCredentialValues } from "@tesserix/web";

import { submitCredentials, type LoginOutcome } from "./actions";

/**
 * The console's sign-in form.
 *
 * Built from @tesserix/web's auth components rather than bespoke markup, so it
 * inherits the console's own tokens: `app/globals.css` maps that package onto
 * the console's CSS variables through `@theme inline`, which is what makes
 * this page look like the console instead of like a login page that happens to
 * live next to it.
 *
 * Stepped — login name, then password — because that is the shape Zitadel's
 * own login uses, and an operator moving between the two should not have to
 * relearn the form.
 */
export function LoginForm({ authRequestId }: { authRequestId: string }) {
  const [values, setValues] = useState<AuthCredentialValues>({ loginName: "", password: "" });
  const [step, setStep] = useState<"loginName" | "password">("loginName");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(next: AuthCredentialValues) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result: LoginOutcome = await submitCredentials({
        authRequestId,
        loginName: next.loginName ?? "",
        password: next.password ?? "",
      });

      switch (result.outcome) {
        case "complete":
          // A full URL on Zitadel's side, so assign rather than route(): this
          // deliberately leaves the SPA.
          window.location.assign(result.callbackUrl);
          return;
        case "handoff":
          // The account needs a factor this page does not collect. Zitadel's
          // own login resumes the SAME auth request, so the operator finishes
          // there and still lands back at the console — no second sign-in.
          setNotice("Finishing sign-in with your second factor…");
          window.location.assign(result.handoffUrl);
          return;
        case "restart":
          setError(result.message);
          setStep("loginName");
          return;
        default:
          setError(result.message);
          // Back to the password field, never the login name: re-typing a
          // username that was accepted is busywork, and this page cannot tell
          // the operator which half was wrong anyway.
          setStep("password");
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
    </AuthPanel>
  );
}
