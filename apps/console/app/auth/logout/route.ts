import { NextResponse, type NextRequest } from "next/server";
import {
  CapabilityError,
  getCurrentSession,
  sessionCookieName,
  sessionCookieOptions,
} from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { publicOrigin } from "@/lib/public-origin";

/**
 * Sign out.
 *
 * Clears `tx_session`, which is scoped to `.tesserix.app` and therefore shared
 * with the web app — so this signs the operator out of both. That is the
 * honest meaning of the word; a console-only sign-out would leave them
 * authenticated on a surface they believed they had left.
 */

export const dynamic = "force-dynamic";

/**
 * Ending the Zitadel session as well, when configured.
 *
 * Without it, signing out and signing back in re-authenticates with no prompt,
 * because the IdP session outlives our cookie. On a shared machine the next
 * person to click sign-in lands here as the previous operator, holding their
 * capabilities.
 *
 * Gated on the variable because Zitadel rejects a `post_logout_redirect_uri`
 * that is not registered against the application, and registering it is a
 * change in Zitadel rather than in this repository. Unset, this behaves
 * exactly like apps/web's logout.
 */
function idpLogoutUrl(): string | null {
  const redirect = process.env.ZITADEL_POST_LOGOUT_REDIRECT_URI;
  const issuer = process.env.ZITADEL_ISSUER;
  const clientId = process.env.ZITADEL_CLIENT_ID;
  if (!redirect || !issuer || !clientId) return null;
  const url = new URL(`${issuer.replace(/\/$/, "")}/oidc/v1/end_session`);
  url.searchParams.set("post_logout_redirect_uri", redirect);
  url.searchParams.set("client_id", clientId);
  return url.toString();
}

async function signOut(request: NextRequest): Promise<NextResponse> {
  const session = await getCurrentSession();
  try {
    checkOperatorCapability(session, "read");
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw cause;
  }

  const destination = idpLogoutUrl() ?? `${publicOrigin(request)}/auth/login`;
  const response = NextResponse.redirect(destination);
  // Expire the cookie on the response that redirects, so the local session
  // ends even when the destination is Zitadel and Zitadel refuses us.
  response.cookies.set(sessionCookieName(), "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    domain: sessionCookieOptions().domain,
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return signOut(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return signOut(request);
}
