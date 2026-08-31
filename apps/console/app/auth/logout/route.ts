import { NextResponse, type NextRequest } from "next/server";
import {
  CapabilityError,
  getCurrentSession,
  sessionCookieName,
  sessionCookieOptions,
} from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { withDeadline } from "@/lib/auth/deadline";
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
 * How long the token-store delete may run before sign-out stops waiting on it.
 *
 * THIS IS THE POINT OF THE WHOLE THING. Before the token store, logout did no
 * I/O at all and could not hang. Now it awaits a DELETE, and nothing in this
 * stack bounds a query that has already started: `connectionTimeoutMillis` in
 * `lib/db/tesserix.ts` bounds pool ACQUISITION only, and there is no
 * `statement_timeout` anywhere. A DELETE stuck behind a lock would therefore
 * hang this response — and the cookie is expired on the response, so a response
 * that never returns leaves `tx_session` intact. The operator stays
 * AUTHENTICATED, on a cookie shared across `.tesserix.app`, on the one surface
 * whose entire purpose is ending that session.
 *
 * `withDeadline` REJECTS past this rather than resolving, which drops the hang
 * into the same `catch` a thrown store error already falls into: logged, cookie
 * still expired, still redirected. 2000ms to match `SAVE_TOKENS_DEADLINE_MS` in
 * `/auth/callback` — the same store, the same pool, the same reasoning.
 *
 * ACCEPTED COST: a slow-but-alive database leaves the row behind. It is
 * unreachable without the `sid` claim the cleared cookie carried, and
 * `pruneExpired` sweeps it at `session_expires_at`. That is strictly better
 * than a sign-out that does not sign anyone out.
 */
const DELETE_TOKENS_DEADLINE_MS = 2_000;

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
    // THE SYNC GATE, DELIBERATELY — the one mutating call site that was NOT
    // moved to `checkOperatorCapabilityLive` (tesserix-home#285).
    //
    // Two reasons, and both are about not being able to leave:
    //
    //  1. Signing out must not depend on the database or on Zitadel. The live
    //     gate reads the store and, every five minutes, spends a refresh token
    //     against the IdP. Putting either in front of logout means an operator
    //     cannot sign out during an outage — and this handler's own comment
    //     below already commits to logout succeeding "no matter what happens"
    //     to the store.
    //  2. Revoking `read` must not strand a live session. Under the live gate,
    //     an operator whose console entry was removed would be refused HERE
    //     and keep a valid cookie they cannot clear, which is the opposite of
    //     what a revocation is for.
    //
    // The staleness this leaves is `read` only, and the action it authorises is
    // destroying this session's own credentials. There is nothing to widen.
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
      await withDeadline(
        deleteTokens(session.sid),
        DELETE_TOKENS_DEADLINE_MS,
        "operator token store delete timed out",
      );
    } catch {
      // Two ways in. `deleteTokens` already swallows pool-path errors
      // internally (see its JSDoc), so a throw from it should be unreachable in
      // production — but the catch stays so this call site's guarantee ("logout
      // never fails on this") is explicit and does not silently evaporate if
      // the store's contract changes later. The deadline above is the reachable
      // one, and it lands here deliberately: a hang must degrade exactly like a
      // failure, not worse than one.
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
