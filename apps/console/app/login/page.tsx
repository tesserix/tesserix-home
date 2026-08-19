import type { Metadata } from "next";
import Link from "next/link";

import { loginClientConfig } from "@/lib/auth/zitadel-login-client";
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
  searchParams: Promise<{ authRequest?: string; authRequestID?: string }>;
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

  if (!loginClientConfig()) {
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

  return (
    <Shell>
      <LoginForm authRequestId={authRequestId} />
    </Shell>
  );
}

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
