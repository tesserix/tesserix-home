import { NextResponse, type NextRequest } from "next/server";
import {
  CapabilityError,
  getCurrentSession,
  sessionCookieName,
  sessionCookieOptions,
} from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { deleteTokens } from "@/lib/auth/operator-token-store";
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

  // Revoke platform API access for this session. Best-effort, and it must
  // stay that way: signing out has to succeed locally no matter what happens
  // here, or a database blip would leave an operator unable to sign out at
  // all. Today, without this, logout revokes nothing and the row survives
  // until `session_expires_at` — reachable by anyone who still holds the
  // (encrypted) row's key, i.e. nobody once the cookie naming it is gone, but
  // it should not sit there a moment longer than it has to.
  //
  // `session?.sid` — not `session.sid` — because a session minted before this
  // shipped, or minted by `apps/web` (which shares the `tx_session` cookie),
  // carries no `sid` at all. That is not an error: there is simply no row to
  // delete, and `deleteTokens` is never called.
  if (session?.sid) {
    try {
      await deleteTokens(session.sid);
    } catch {
      // `deleteTokens` already swallows pool-path errors internally (see its
      // JSDoc) and this branch should be unreachable in production — but the
      // catch stays so this call site's guarantee ("logout never fails on
      // this") is explicit and does not silently evaporate if the store's
      // contract changes later.
      console.error("[auth/logout] failed to delete operator API tokens", {
        sid: session.sid,
      });
    }
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
