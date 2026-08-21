// `server-only`: this module reads Postgres. It used to read only the session
// cookie, which is why a client component could import it transitively without
// anyone noticing until `pg` failed to resolve in the browser bundle.
import "server-only";

import { cache } from "react";
import { getCurrentSession } from "@tesserix/platform-auth";
import { tesserixTx } from "../db/tesserix";
import { withDeadline } from "./deadline";
import {
  accessTokenExpiresAt,
  readTokenRecord,
  readTokens,
  saveTokens,
} from "./operator-token-store";
import type { ConsoleOidcConfig } from "./oidc";
import { getOidcConfig, refreshAccessToken } from "./oidc";

/**
 * The Zitadel access token the console presents to the platform API.
 *
 * # Why this is its own module
 *
 * ADR-003 D8 requires the platform API to authenticate operators with a
 * Zitadel access token, and declined to teach it `tx_session`: a product
 * calling that API has no `tx_session` and never will, so the service
 * principal would need a second mechanism anyway.
 *
 * # WHERE THE TOKENS ARE: `operator_api_tokens`, KEYED BY `sid`
 *
 * The callback briefly kept `access_token` and `refresh_token` in the session
 * cookie. That broke console login outright: with ten roles the encrypted
 * cookie cleared the browser's 4096-byte per-cookie limit, and a browser over
 * that limit DISCARDS the `Set-Cookie` without telling the origin. Every login
 * succeeded server-side and left the browser with no session, so middleware
 * bounced it back to `/auth/login` until Chrome gave up with
 * ERR_TOO_MANY_REDIRECTS. See
 * `.planning/debug/resolved/console-login-state-mismatch.md`.
 *
 * So the cookie carries IDENTITY — including a random `sid` claim — and the
 * CREDENTIALS live server-side in `operator_api_tokens` (migration 0029),
 * behind `operator-token-store.ts`. Middleware stays zero-I/O on every
 * request; only the requests that actually call the platform API touch the
 * table.
 *
 * # THE STORE IS THE ONLY SOURCE. THERE IS NO COOKIE FALLBACK.
 *
 * `session.accessToken` / `session.refreshToken` still decode — the claims
 * were left in place so sessions minted before the store keep working — but
 * this module deliberately does not read them, and adding a fallback would be
 * a mistake rather than a kindness. A session carrying those claims could only
 * exist if some browser had ACCEPTED the oversized cookie, which is exactly
 * what never happened: that is the outage. An absent `sid` therefore means "no
 * tokens", full stop, and returns null.
 *
 * # Why it can still return null, and why every caller must survive that
 *
 * Five legitimate cases:
 *
 *  1. **No `sid`.** A session minted before the store existed. They live 7
 *     days and outlive the deploy.
 *  2. **No row for the `sid`.** The callback could not write one, or the row
 *     was pruned or deleted at logout.
 *  3. **A mobile session.** It never went through the OIDC callback.
 *  4. **An expired access token with no way to renew it.** Zitadel issues a
 *     refresh token only when the application has the Refresh Token grant
 *     enabled.
 *  5. **Zitadel is not configured, or unreachable, on this deployment.**
 *
 * `lib/platform-api.ts` treats null as "the platform API is not reachable as
 * this operator" and says so, rather than sending an unauthenticated request
 * that returns a 401 carrying nothing an operator can act on.
 *
 * # Not every null is answered by signing in again
 *
 * Of the five cases above, only some are a REMEDY the operator holds: cases
 * 1, 2 and 3 all end with "this session has no credential, a fresh sign-in
 * mints one". Case 5 — and a database that will not answer, and an encryption
 * key that was never provisioned — are deployment faults, and a console that
 * answers them with "sign in again" issues an instruction that cannot work
 * however many times it is followed.
 *
 * So the resolver reports WHICH, and `platform-api.ts` marks only the
 * remediable ones. See {@link PlatformTokenResult.reauthRequired}, and
 * `readTokenRecord` in `./operator-token-store`, which is where the
 * distinction is actually observed.
 *
 * NOTHING HERE THROWS. It renders inside pages that have no need of the
 * platform API, and a token lookup must never be what takes one of those down.
 */

/**
 * Refresh this far ahead of expiry.
 *
 * A token that is valid for another ten seconds is not usable: it has to
 * survive the console's own request, the hop to the platform API, and that
 * service's clock, which is not this one's. Sixty seconds is comfortably more
 * than any of those and far less than the token's lifetime, so it costs at
 * most one extra refresh per session.
 */
const RENEW_WITHIN_SECONDS = 60;

/**
 * How long the refresh may hold the row lock — and the pooled connection —
 * waiting on Zitadel.
 *
 * The refresh runs INSIDE the transaction (it has to — see `renewUnderLock`),
 * which means a network call to the IdP holds `SELECT ... FOR UPDATE` on this
 * session's row for its whole duration. `refreshAccessToken` has no timeout of
 * its own and `fetch` will wait a very long time.
 *
 * # THE BLAST RADIUS IS THE WHOLE CONSOLE, NOT THIS SESSION
 *
 * `lib/db/tesserix.ts` runs ONE pool with `max: 2`, shared by everything the
 * console reads: CRM, tickets, audit, the sidebar. A transaction holds its
 * connection from `BEGIN` to `COMMIT`, so an unbounded refresh does not merely
 * queue other readers of this session's row — it takes one of the two
 * connections out of circulation for every query in the process. Two
 * simultaneous hanging refreshes take both, and the next caller — "a save, or
 * an unrelated read anywhere else in the console", as `tesserixTx`'s own
 * comment puts it — waits out `connectionTimeoutMillis` and then fails.
 *
 * # WHY 3 SECONDS, AND WHY IT MUST STAY BELOW connectionTimeoutMillis
 *
 * `connectionTimeoutMillis` in `lib/db/tesserix.ts` is 5s. THESE TWO NUMBERS
 * ARE COUPLED, and the coupling is the reason this one is not also 5s: the
 * connection is held for `BEGIN` + `SELECT ... FOR UPDATE` + the fetch + the
 * `INSERT` + `COMMIT`, which is strictly LONGER than the fetch deadline. At 5s
 * a query arriving 50ms into two simultaneous hangs would wait past its own 5s
 * timeout and fail — the bound would be honest but untrue. 3s leaves real
 * headroom for the surrounding statements, so the claim "a hung IdP cannot
 * outlast a connection wait" actually holds.
 *
 * If either number changes, change it against the other. Raising this to meet
 * `connectionTimeoutMillis`, or lowering `connectionTimeoutMillis` to meet
 * this, silently reinstates the starvation.
 *
 * ACCEPTED, not discovered: the worst case is still a few seconds of
 * console-wide database starvation during an IdP hang. At a refresh volume of
 * roughly once per session per hour that is a price worth paying for a single
 * shared pool, and it is bounded rather than open-ended.
 *
 * Also accepted: a slow-but-alive Zitadel answering between 3s and 5s now
 * fails a refresh that would once have succeeded. It degrades to "the platform
 * API is not reachable as this operator" for one render, which every caller
 * already handles, and the next request tries again.
 *
 * IF ZITADEL IS SLOW: the wait is abandoned at this deadline, the transaction
 * ROLLS BACK (releasing the lock and the connection), the stored row is left
 * exactly as it was, and the caller gets null. The next request retries from a
 * clean state.
 *
 * The residual risk is accepted and worth naming: the abandoned request may
 * still complete at Zitadel and rotate the refresh token, in which case the
 * token we kept is dead and this session cannot refresh again. That degrades to
 * "this operator signs in again", which is strictly better than a lock held
 * until the pod is restarted.
 */
const REFRESH_TIMEOUT_MS = 3_000;

/**
 * Memoised per request.
 *
 * Without this, a page that reads tickets and their summary would hit the
 * store twice for one render. `cache` is React's request-scoped memo, so two
 * callers in one request share the result and two different requests do not —
 * which is also why it is NOT the answer to the concurrency problem below.
 */
export interface PlatformTokenResult {
  /** The bearer token, or null when there is none to give. */
  token: string | null;
  /**
   * True ONLY when the absence is one a fresh sign-in fixes: the store
   * answered, and this session has no usable credential in it.
   *
   * Never true for a store that could not answer at all — no encryption key, no
   * database, a read that threw, a row that would not decrypt — nor for a
   * refresh that failed. Those are deployment or infrastructure faults, and
   * "sign in again" is advice that cannot work for any of them.
   *
   * Meaningless when `token` is non-null, and always false there.
   */
  reauthRequired: boolean;
}

const NO_TOKEN: PlatformTokenResult = { token: null, reauthRequired: false };
const SIGN_IN_AGAIN: PlatformTokenResult = { token: null, reauthRequired: true };

/**
 * The token, plus whether its absence is the operator's to fix.
 *
 * Memoised per request for the same reason {@link getPlatformApiToken} was:
 * one render that reads tickets and their summary must hit the store once.
 */
export const resolvePlatformApiToken = cache(
  async (): Promise<PlatformTokenResult> => {
    const session = await getCurrentSession();
    // No `sid`, no tokens. Not a fallback point: see the header. A fresh
    // sign-in DOES fix this — every session minted since the store exists
    // carries a `sid` — so it is one of the remediable cases.
    if (!session?.sid) return SIGN_IN_AGAIN;
    const sid = session.sid;

    // The common path, and deliberately lock-free: a valid token is the answer
    // for the whole hour it lives, and taking a row lock to read it would put
    // every platform-API render behind a two-connection pool.
    const { outcome, tokens } = await readTokenRecord(sid);
    // The store worked and holds nothing for this session — the one shape the
    // sign-in prompt is true for.
    if (outcome === "absent") return SIGN_IN_AGAIN;
    // Key unset, database unreachable, read threw, ciphertext dead. Signing in
    // again would land on this identical state, because the callback's write
    // fails the same checks this read did.
    if (outcome !== "ok" || !tokens) return NO_TOKEN;

    if (!isExpiring(tokens.accessExpiresAt)) {
      return { token: tokens.accessToken, reauthRequired: false };
    }
    if (!tokens.refreshToken) {
      // Expired, and nothing to renew it with. Returning the dead token would
      // turn a clear "this session cannot reach the platform API" into a 401
      // from a service that has no idea why either. The row exists but holds
      // nothing usable and nothing renewable, so a fresh sign-in is exactly the
      // remedy — same as case 4 in the header.
      return SIGN_IN_AGAIN;
    }

    let config: ConsoleOidcConfig;
    try {
      config = getOidcConfig();
    } catch {
      // Zitadel is not configured on this deployment. Not an error worth
      // throwing from a read path — there is simply no token. Checked BEFORE the
      // transaction so a misconfiguration never opens one. Not remediable: with
      // no OIDC config there is no sign-in to send anyone to.
      return NO_TOKEN;
    }

    const renewed = await renewUnderLock(
      sid,
      session.sub,
      sessionExpiry(session.exp),
      config,
    );
    // A failed renewal is an IdP or database problem, not a missing credential:
    // the row is still there and the operator holds no lever over any of the
    // reasons it did not work.
    return renewed ? { token: renewed, reauthRequired: false } : NO_TOKEN;
  },
);

/**
 * Just the token, for callers with nothing to explain.
 *
 * A thin wrapper over {@link resolvePlatformApiToken}, sharing its per-request
 * memo, so the two can never disagree about whether a session has a token.
 */
export async function getPlatformApiToken(): Promise<string | null> {
  return (await resolvePlatformApiToken()).token;
}

/**
 * Refresh exactly once per session, however many callers arrive at once.
 *
 * # Why a database transaction and not something in-process
 *
 * Zitadel ROTATES refresh tokens on use: spending one invalidates it and issues
 * a replacement. Two concurrent refreshes therefore both spend the SAME token,
 * one wins, and the loser's response is worthless — worse, the loser has
 * already written its dead token over the winner's row, so the session cannot
 * refresh again at all.
 *
 * That race is real on two axes and neither is fixable in this process:
 * parallel server-component renders inside ONE request tree, and TWO console
 * replicas serving the same operator. React's `cache` dedupes within a single
 * request and does nothing for either. The only lock both replicas can see is
 * the row itself.
 *
 * So:
 *
 *     BEGIN
 *     SELECT ... FROM operator_api_tokens WHERE sid = $1 FOR UPDATE
 *       -- re-check expiry, then refresh, then persist BOTH tokens
 *     COMMIT
 *
 * # The cheaper shape, and why it was rejected
 *
 * The obvious alternative is to refresh OUTSIDE the transaction and persist
 * with a compare-and-set — no connection held across a network call, and none
 * of the starvation `REFRESH_TIMEOUT_MS` is sized against. It does not work,
 * because a CAS on the WRITE is too late: both callers have already presented
 * the same one-use refresh token to Zitadel by the time either tries to store
 * anything. The loser is not merely wasted — Zitadel treats a reused refresh
 * token as theft and can revoke the ENTIRE grant, signing the operator out
 * everywhere. That is worse than the bug being fixed.
 *
 * The shape that does work is claim-then-refresh-then-CAS: win a claim on the
 * row first, refresh outside the lock, then write only if the claim still
 * holds. It needs a `refresh_started_at`-style column migration 0029 does not
 * have, plus a lease-expiry policy so a claimant that crashes mid-refresh does
 * not strand the session until its access token dies. Deferred deliberately,
 * not overlooked; the column is the cheap part and the lease policy is not.
 *
 * # The re-check is not optional
 *
 * A caller that waited on the lock is looking at a row that may have been
 * refreshed by whoever held it. Re-reading the expiry INSIDE the lock and
 * returning early is what turns "everyone who was waiting also refreshes" into
 * "exactly one refresh". Skipping it is textbook double-checked locking done
 * wrong, and it reintroduces precisely the double-spend the lock exists to
 * prevent — the lock would only serialise the damage, not stop it.
 *
 * # The write joins this transaction
 *
 * `saveTokens` is handed the transaction's `query`, so the new tokens are
 * written under the same lock that authorised spending the old ones; the
 * refreshed pair is visible to the next waiter the instant COMMIT lands.
 * That path also makes the store RETHROW database errors instead of swallowing
 * them, which is what lets a failed write roll the whole thing back rather than
 * silently losing a rotated refresh token. Note that `saveTokens` skips its
 * opportunistic prune when given a `query`, on purpose — a table-wide DELETE
 * under this lock is a deadlock shape, and a failing prune would roll back the
 * save. Do not defeat that by pruning here.
 *
 * Returns null on every failure, including a rolled-back transaction: an
 * operator who cannot refresh is an operator the platform API is unreachable
 * for, not a page that fails to render.
 */
async function renewUnderLock(
  sid: string,
  sub: string,
  sessionExpiresAt: Date,
  config: ConsoleOidcConfig,
): Promise<string | null> {
  try {
    return await tesserixTx(async (query) => {
      const locked = await readTokens(sid, { query, forUpdate: true });
      // Deleted between the unlocked read and the lock — a logout, or a prune.
      if (!locked) return null;

      // THE RE-CHECK. Another request refreshed while this one waited, so its
      // token is the answer and there is nothing to spend.
      if (!isExpiring(locked.accessExpiresAt)) return locked.accessToken;
      if (!locked.refreshToken) return null;

      const renewed = await withDeadline(
        refreshAccessToken(config, locked.refreshToken),
        REFRESH_TIMEOUT_MS,
      );
      // Rejected, revoked, or already rotated out from under us.
      // `refreshAccessToken` already logged why. NOTHING IS WRITTEN — the row
      // keeps the tokens it had, which is the only state that could still be
      // valid.
      if (!renewed?.access_token) return null;

      await saveTokens(
        sid,
        sub,
        {
          accessToken: renewed.access_token,
          accessExpiresAt: accessTokenExpiresAt(renewed.expires_in),
          // PERSIST THE ROTATED REFRESH TOKEN. Dropping it is the bug this
          // whole change exists to fix: the next refresh would present a spent
          // token and fail forever. Falling back to the one we just spent is
          // correct only for the case where the response carries no
          // replacement, which means the IdP did not rotate and the old one is
          // still live.
          refreshToken: renewed.refresh_token ?? locked.refreshToken,
        },
        sessionExpiresAt,
        { query },
      );

      return renewed.access_token;
    });
  } catch {
    // A rolled-back transaction, an unreachable database, or the deadline
    // above. All of them mean the same thing to a caller, and none of them is
    // worth throwing into a page render. The store has already reported the
    // detail without logging anything a scraper could use.
    return null;
  }
}

/**
 * True when the token is expired, expiring imminently, or carries no expiry.
 *
 * An unknown expiry is treated as expiring, which is the safe direction: a
 * token refreshed too eagerly costs one request, and one refreshed too late
 * costs an operator's action.
 */
function isExpiring(expiresAt: Date | undefined): boolean {
  if (!expiresAt) return true;
  const seconds = Math.floor(expiresAt.getTime() / 1000);
  if (!Number.isFinite(seconds)) return true;
  return seconds - RENEW_WITHIN_SECONDS <= Math.floor(Date.now() / 1000);
}

/**
 * The row's `session_expires_at`, mirroring the cookie's own `exp`.
 *
 * Only the prune sweep reads it, and the safe direction is the opposite of
 * `isExpiring`'s: an unknown session expiry must NOT read as "already expired",
 * or the next prune would delete a live session's tokens. It falls back to the
 * cookie's own 7-day lifetime, which is the longest the session could be.
 */
function sessionExpiry(exp: number | undefined): Date {
  if (!exp || !Number.isFinite(exp)) {
    return new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000);
  }
  return new Date(exp * 1000);
}

/** The `tx_session` lifetime, per ADR-003 D8. Mirrored rather than imported
 *  because it is only a fallback for a claim that is always present. */
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
