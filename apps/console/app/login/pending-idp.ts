import "server-only";

import { cookies } from "next/headers";

/**
 * The login being finished, parked across the trip to the identity provider.
 *
 * "Continue with Google" leaves the console entirely, and Zitadel brings the
 * browser back with only `id` and `token` — nothing that says WHICH pending
 * auth request those belong to. That has to come from somewhere the round trip
 * cannot rewrite.
 *
 * A query parameter on the success URL would be the obvious place and is the
 * wrong one: it would put the auth request id in a redirect chain that passes
 * through a third party, and the callback would then be finishing whichever
 * login the URL it was handed named. This cookie is set before the browser
 * leaves and is the only thing the callback will accept.
 */

const COOKIE = "tx_login_idp";

/** An OAuth round trip through a consent screen, plus room to read it. */
const MAX_AGE_SECONDS = 10 * 60;

export interface PendingIdpLogin {
  readonly authRequestId: string;
}

/**
 * `sameSite: "lax"` — and this is the one place in this directory where
 * `strict` would be wrong.
 *
 * `pending-session.ts` can afford `strict` because it is only ever read by a
 * server action posted from the console's own page. This cookie is read on a
 * TOP-LEVEL redirect arriving from Zitadel, which `strict` would omit — the
 * callback would see no cookie and send every federated operator back to the
 * password form.
 *
 * `secure` is derived from the console's own redirect URI rather than
 * NODE_ENV, for the same reason the pending session derives it: local
 * development runs over plain http, where a `Secure` cookie is dropped in
 * silence.
 */
export async function savePendingIdpLogin(pending: PendingIdpLogin): Promise<void> {
  (await cookies()).set(COOKIE, JSON.stringify(pending), {
    httpOnly: true,
    secure: !process.env.ZITADEL_REDIRECT_URI?.startsWith("http://"),
    sameSite: "lax",
    path: "/login",
    maxAge: MAX_AGE_SECONDS,
  });
}

/**
 * Read the login this callback is finishing, or nothing.
 *
 * Unparseable is treated as absent, as in `pending-session.ts`: both answers
 * are "start again", and a distinct error would only be a way to probe the
 * cookie.
 */
export async function readPendingIdpLogin(): Promise<PendingIdpLogin | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { authRequestId } = parsed as Record<string, unknown>;
  if (typeof authRequestId !== "string" || !authRequestId) return null;
  return { authRequestId };
}

export async function clearPendingIdpLogin(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
