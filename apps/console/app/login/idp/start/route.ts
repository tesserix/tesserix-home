import { NextResponse, type NextRequest } from "next/server";

import {
  listLoginPolicyIdps,
  loginClientConfig,
  startIdpIntent,
} from "@/lib/auth/zitadel-login-client";
import { publicOrigin } from "@/lib/public-origin";
import { savePendingIdpLogin } from "../../pending-idp";

// GET /login/idp/start — begin "Continue with <provider>".

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a federated login.
 *
 * A route handler rather than a server action because the whole job is a
 * redirect that leaves the origin, and because `publicOrigin(request)` needs
 * the request: the success and failure URLs are absolute, and building them
 * from `nextUrl.origin` would hand Zitadel the pod's own bind address —
 * `https://0.0.0.0:3000/...` — which is precisely the bug that helper exists
 * to prevent.
 *
 * # Both inputs arrive from the browser and neither is trusted
 *
 * `idp` is checked against the providers Zitadel says the login policy offers
 * RIGHT NOW, so a crafted link cannot make the console start an intent for a
 * provider the org never bound. `authRequest` is not checked here — it is
 * checked by being spent: it goes into a cookie the callback reads, and
 * `finalize` will refuse an id Zitadel does not hold.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = publicOrigin(request);
  const authRequestId = request.nextUrl.searchParams.get("authRequest")?.trim() ?? "";
  const idpId = request.nextUrl.searchParams.get("idp")?.trim() ?? "";

  // Nothing to finish. Send them to the page that starts a login properly
  // rather than rendering an error for a URL nobody types by hand.
  if (!authRequestId) return NextResponse.redirect(new URL("/login", origin));

  const failureUrl = `${origin}/login?authRequest=${encodeURIComponent(authRequestId)}&error=idp`;

  const config = loginClientConfig();
  if (!config || !idpId) return NextResponse.redirect(failureUrl);

  try {
    const offered = await listLoginPolicyIdps(config);
    if (!offered.some((idp) => idp.id === idpId)) {
      console.warn("[login] refused an idp the login policy does not offer", { idpId });
      return NextResponse.redirect(failureUrl);
    }

    // Before the browser leaves: once it is at the provider, the only thing
    // that will say which login this was is this cookie.
    await savePendingIdpLogin({ authRequestId });

    const authUrl = await startIdpIntent(config, idpId, {
      successUrl: `${origin}/login/idp/callback`,
      failureUrl,
    });
    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.warn("[login] could not start the identity provider intent", {
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.redirect(failureUrl);
  }
}
