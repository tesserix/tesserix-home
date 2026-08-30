import { NextResponse, type NextRequest } from "next/server";

import {
  checkSufficiency,
  createIdpSession,
  finalize,
  getEnrolledFactors,
  getLoginPolicy,
  loginClientConfig,
  retrieveIdpIntent,
} from "@/lib/auth/zitadel-login-client";
import { publicOrigin } from "@/lib/public-origin";
import { handoffUrl } from "../../handoff";
import { savePendingSession } from "../../pending-session";
import { clearPendingIdpLogin, readPendingIdpLogin } from "../../pending-idp";

// GET /login/idp/callback — Zitadel returns the browser here with the intent.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Finish a federated login.
 *
 * The same three steps the password path takes, in the same order and through
 * the same decision — only the first factor differs. Zitadel appends `id` and
 * `token` for the completed intent; the auth request comes from the cookie the
 * start route set, never from this URL.
 *
 * # Arriving through Google is ONE factor, not two
 *
 * `decideSufficiency` runs here exactly as it does after a password. The only
 * thing that changes is that it is told the session is federated, which buys
 * the `forceMfaLocalOnly` exemption and nothing else: an unconditional
 * `forceMfa`, an enrolled authenticator and a passkey all still owe what they
 * owed. `finalize` still demands the `Sufficient` proof, so a federated login
 * cannot reach the callback URL without that decision having been made.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = publicOrigin(request);
  const pending = await readPendingIdpLogin();
  if (!pending) {
    // No cookie means this console never started this login. Without it there
    // is nothing that says which auth request to finish, and taking one from
    // the URL would be letting the caller choose.
    return NextResponse.redirect(new URL("/login?error=restart", origin));
  }
  await clearPendingIdpLogin();

  const authRequestId = pending.authRequestId;
  const failureUrl = `${origin}/login?authRequest=${encodeURIComponent(authRequestId)}&error=idp`;

  const config = loginClientConfig();
  if (!config) return NextResponse.redirect(failureUrl);

  const intentId = request.nextUrl.searchParams.get("id")?.trim() ?? "";
  const intentToken = request.nextUrl.searchParams.get("token")?.trim() ?? "";
  if (!intentId || !intentToken) return NextResponse.redirect(failureUrl);

  try {
    // Throws `unknown-user` for an external identity linked to no operator.
    // That falls into the same catch as every other failure and produces the
    // same message, because whether an email belongs to an operator is not
    // something this page may reveal.
    const { userId, verified } = await retrieveIdpIntent(config, { id: intentId, token: intentToken });
    const session = await createIdpSession(config, { id: intentId, token: intentToken }, userId);

    const [policy, factors] = await Promise.all([
      getLoginPolicy(config),
      getEnrolledFactors(config, session),
    ]);
    const { sufficiency, proof } = checkSufficiency(policy, factors, null, verified);

    if (proof) {
      return NextResponse.redirect(await finalize(config, authRequestId, session, proof));
    }

    if (sufficiency.outcome === "totp") {
      // Park the session for the in-page code step and land back on the login
      // page already in it. The same cookie and the same `submitTotp` the
      // password path uses — a federated operator owes the same code, so it
      // must be collected by the same tested path rather than a second one.
      await savePendingSession({
        authRequestId,
        sessionId: session.id,
        sessionToken: session.token,
      });
      return NextResponse.redirect(
        `${origin}/login?authRequest=${encodeURIComponent(authRequestId)}&step=totp`,
      );
    }

    return NextResponse.redirect(handoffUrl(config.issuer, authRequestId));
  } catch (error) {
    console.warn("[login] federated sign-in failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.redirect(failureUrl);
  }
}
