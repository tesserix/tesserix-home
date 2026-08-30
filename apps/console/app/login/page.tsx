import type { Metadata } from "next";
import Link from "next/link";

import { listLoginPolicyIdps, loginClientConfig } from "@/lib/auth/zitadel-login-client";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

// Never cached: the page is keyed to a one-shot auth request.
export const dynamic = "force-dynamic";

/**
 * The console's own login page.
 *
 * Zitadel sends a browser here when the `console-web` application is on
 * Login V2 with this origin as its base URI: it appends `/login` and the
 * pending auth request's id. Without that configuration nothing routes here
 * and Zitadel's hosted login is used instead, which is the state this ships
 * in — the page is inert until the application is flipped.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    authRequest?: string;
    authRequestID?: string;
    /** Set by the federated callback when it parked a session owing a code. */
    step?: string;
    /** A code, never a message — see `RETURN_MESSAGES`. */
    error?: string;
  }>;
}) {
  const params = await searchParams;
  // Zitadel has spelled this both ways across versions and surfaces; accept
  // either rather than have the page render an error that is really a
  // casing difference.
  const authRequestId = params.authRequest ?? params.authRequestID ?? "";

  if (!authRequestId) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          This page is reached from a sign-in link. Start at{" "}
          <Link className="underline" href="/">
            the console
          </Link>
          .
        </p>
      </Shell>
    );
  }

  const config = loginClientConfig();
  if (!config) {
    // An operator problem, said plainly. The alternative — rendering the form
    // and failing every submission — would read as "my password is wrong".
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          Sign-in is not configured on this deployment.
        </p>
      </Shell>
    );
  }

  // Read from Zitadel on every render rather than cached or configured: the
  // bootstrap owns these objects, and a provider it binds or unbinds has to
  // show up here without a deploy. The call answers `[]` rather than throwing,
  // so an unreadable policy costs the button and not the login.
  const providers = await listLoginPolicyIdps(config);

  return (
    <Shell>
      <LoginForm
        authRequestId={authRequestId}
        providers={providers.map((idp) => ({ id: idp.id, name: idp.name }))}
        initialStep={params.step === "totp" ? "totp" : "credentials"}
        initialError={RETURN_MESSAGES[params.error ?? ""] ?? null}
      />
    </Shell>
  );
}

/**
 * What a redirect back to this page is allowed to say.
 *
 * Looked up by code, so the page can only ever render a string written here.
 * Echoing `error` from the query string would let anyone who can get an
 * operator to follow a link put arbitrary text on the console's own sign-in
 * page, which is a phishing surface rather than an error message.
 *
 * The federated message names no cause on purpose: "not linked to an operator
 * account", "the provider refused" and "the intent expired" are one message,
 * because which of them happened is not something this page may reveal.
 */
const RETURN_MESSAGES: Readonly<Record<string, string>> = {
  idp: "That sign-in didn't work. Try again, or use your password.",
  restart: "This sign-in link has expired. Start again.",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-background p-6"
    >
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
