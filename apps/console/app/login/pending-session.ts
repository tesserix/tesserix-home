import "server-only";

import { cookies } from "next/headers";

/**
 * The half-authenticated session, parked between the password and the code.
 *
 * The in-page TOTP prompt is a second server-action round trip, so the Zitadel
 * session created by the password check has to survive between the two. It is
 * kept in an httpOnly cookie rather than returned to the browser: the session
 * token can finish this login on its own, and a value the page's own
 * JavaScript can read is a value an XSS can post to somebody else.
 *
 * Bound to its auth request, so a cookie left over from one login cannot be
 * spent on another. Short-lived for the same reason — a TOTP code is typed in
 * seconds, and anything longer is just a credential lying around.
 */

const COOKIE = "tx_login_pending";

/** Long enough to read a code off a phone, short enough not to linger. */
const MAX_AGE_SECONDS = 5 * 60;

export interface PendingSession {
  readonly authRequestId: string;
  readonly sessionId: string;
  readonly sessionToken: string;
}

/**
 * `secure` is derived from the console's own OIDC redirect URI, not from
 * NODE_ENV: local development runs this page over plain http, and a `Secure`
 * cookie there is silently dropped — which would present as "your code was
 * wrong" on every attempt.
 */
function secureCookies(): boolean {
  return !process.env.ZITADEL_REDIRECT_URI?.startsWith("http://");
}

export async function savePendingSession(pending: PendingSession): Promise<void> {
  (await cookies()).set(COOKIE, JSON.stringify(pending), {
    httpOnly: true,
    secure: secureCookies(),
    // `strict` is safe here, unlike the OIDC state cookie: this cookie is only
    // ever read by a server action posted from the console's own page, never
    // on a top-level redirect arriving from Zitadel.
    sameSite: "strict",
    path: "/login",
    maxAge: MAX_AGE_SECONDS,
  });
}

/**
 * Read the pending session for THIS auth request, or nothing.
 *
 * A mismatched or unparseable cookie is treated as absent rather than as an
 * error: every caller's answer to both is the same — start again — and a
 * distinct error would only give an attacker a way to probe the cookie.
 */
export async function readPendingSession(authRequestId: string): Promise<PendingSession | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const { authRequestId: id, sessionId, sessionToken } = parsed as Record<string, unknown>;
  if (typeof id !== "string" || typeof sessionId !== "string" || typeof sessionToken !== "string") {
    return null;
  }
  if (id !== authRequestId) return null;

  return { authRequestId: id, sessionId, sessionToken };
}

export async function clearPendingSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
