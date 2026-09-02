// `server-only`: this module reads Postgres. It used to read only the session
// cookie, which is why a client component could import it transitively without
// anyone noticing until `pg` failed to resolve in the browser bundle.
import "server-only";

import { cache } from "react";
import {
  capabilitiesFor,
  getCurrentSession,
  rolesFromAccessToken,
} from "@tesserix/platform-auth";
import { tesserixTx } from "../db/tesserix";
import { withDeadline } from "./deadline";
import {
  accessTokenExpiresAt,
  readCapabilities,
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
 * How long a stored capability list may be trusted before Zitadel is asked
 * again. FIVE MINUTES.
 *
 * # This number IS the fix, and the obvious implementation gets it wrong
 *
 * Removing an operator's `hard-delete` in Zitadel used to leave them holding
 * it in the console for up to SEVEN DAYS — the life of the `tx_session`
 * cookie, which is written once at login and never re-read
 * (tesserix-home#285). The same mechanism was watched pointing the harmless
 * way on 2026-08-19: four roles were granted and neither operator saw them
 * until they signed in again.
 *
 * The tempting fix is to re-derive capabilities whenever the access token is
 * refreshed anyway. THAT DOES NOT WORK. The access token lives about twelve
 * hours, so `RENEW_WITHIN_SECONDS` fires roughly twice a day and the
 * revocation window would be TWELVE HOURS, not minutes — better than a week,
 * and still not the thing #285 asks for. Minutes require refreshing
 * PROACTIVELY: calling the token endpoint because the CAPABILITIES are stale,
 * not because the token is. That is why this constant exists separately from
 * `RENEW_WITHIN_SECONDS` and drives its own path rather than riding on that
 * one.
 *
 * # Why 300 and not lower
 *
 * 300s is #285's stated acceptance criterion ("minutes, not a week"). The cost
 * is one Zitadel refresh per ACTIVE operator per five minutes — this estate
 * has two operators on the allowlist, and both short-circuit before any I/O at
 * all (see `checkOperatorCapabilityLive`), so the real steady-state cost today
 * is zero and the ceiling is negligible. Lowering it further buys seconds off
 * a window measured against a human revoking a grant and noticing it took
 * effect, and pays for them with IdP traffic on the critical path of every
 * mutation.
 */
export const CAPABILITY_REVALIDATE_SECONDS = 300;

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

// =========================================================================
// LIVE CAPABILITIES (tesserix-home#285)
//
// Everything above answers "what credential does this session hold". What
// follows answers "what is this operator allowed to do RIGHT NOW", which the
// cookie cannot answer because it was written once, at login, and lives seven
// days.
//
// The two share the row, the lock and the refresh token on purpose: asking
// Zitadel what an operator currently holds MEANS spending the refresh token,
// so a second mechanism would double-spend a one-use credential against the
// first one. See `renewUnderLock` for why that is not survivable.
// =========================================================================

/** The session fields the capability path needs. A structural type rather than
 *  an import of `SessionClaims`, so a caller can pass a test double without
 *  minting a JWE. */
export interface CapabilitySession {
  sub: string;
  email?: string;
  sid?: string;
  exp?: number;
}

/**
 * What the store could tell us about an operator's current capabilities.
 *
 * `unavailable` is NOT "holds nothing" and must never be read as a refusal —
 * see {@link resolveLiveCapabilities} for the full argument. `[]` is a real
 * answer meaning every grant is gone.
 */
export type CapabilityResolution =
  | { source: "store"; capabilities: string[] }
  | { source: "unavailable"; reason: CapabilityUnavailableReason };

/**
 * Why there is no live answer. Carried rather than collapsed because the gate
 * logs it, and "this session predates the store" is an ordinary fact while
 * "the refresh failed" is worth looking at.
 */
export type CapabilityUnavailableReason =
  /** No `sid` claim: a session minted before the token store existed. */
  | "no-sid"
  /** The store worked and holds no row for this session. */
  | "no-row"
  /** No database, or the read threw. */
  | "store-unavailable"
  /** Zitadel is not configured on this deployment. */
  | "not-configured"
  /** The refresh, or the roles read off its result, did not produce an answer. */
  | "revalidation-failed";

/**
 * Is a stored capability list still inside the revalidation window?
 *
 * NULL IS STALE, NOT EMPTY. A row written before migration 0040 has no
 * timestamp, and so does one whose capability write never ran; both must send
 * the reader to ask Zitadel rather than conclude the operator holds nothing.
 * Migration 0040's header says the same thing at the schema.
 *
 * A timestamp in the FUTURE is also stale. Clock skew between the console and
 * Postgres could otherwise park a list permanently inside the window — the one
 * direction where being wrong reinstates exactly the bug this closes — so the
 * comparison is on a non-negative age rather than on `checkedAt > cutoff`.
 */
function capabilitiesAreFresh(checkedAt: Date | null | undefined): boolean {
  if (!checkedAt) return false;
  const at = checkedAt.getTime();
  if (!Number.isFinite(at)) return false;
  const age = Date.now() - at;
  return age >= 0 && age < CAPABILITY_REVALIDATE_SECONDS * 1000;
}

/**
 * Whether the "access tokens are opaque" warning has been said.
 *
 * Module-level for the same reason `warnedMissingKey` is in the store: this
 * reports a DEPLOYMENT FACT that cannot change without a restart, and it is on
 * the path of every gated mutation. One line per process makes it visible; one
 * per action would bury it.
 */
let warnedUnreadableRoles = false;

/**
 * The capabilities this operator holds right now, according to the store.
 *
 * # The order, and why each step is where it is
 *
 * 1. No `sid` — a session minted before the token store existed. There is no
 *    row to consult and never will be for this session; it expires within
 *    seven days of the store's deploy.
 * 2. Read the store. This read needs a database and NOT the encryption key
 *    (see `readCapabilities`), so a key problem does not cost the gate its
 *    answer.
 * 3. Fresh list — serve it. This is the common path and it is deliberately
 *    LOCK-FREE and IdP-free: for the 300 seconds a list is good, a gated
 *    action costs one indexed point lookup.
 * 4. Stale or never checked — refresh the access token under the row lock and
 *    re-derive from the NEW token's project-scoped roles claim.
 *
 * # `unavailable` means "keep what you had", never "refuse"
 *
 * Every failure here — no database, a read that threw, Zitadel down, an
 * unreadable token — resolves to `unavailable`, and the caller falls back to
 * the cookie's snapshot. That is a deliberate widening and it is the accepted
 * trade: see `checkOperatorCapabilityLive` in `./operator`, which owns the
 * argument and the WARN.
 */
export async function resolveLiveCapabilities(
  session: CapabilitySession,
): Promise<CapabilityResolution> {
  if (!session.sid) return unavailable("no-sid");
  const sid = session.sid;

  const stored = await readCapabilities(sid);
  if (stored.outcome === "unavailable") return unavailable("store-unavailable");
  // The store answered and there is no row: a logout raced this request, or the
  // callback never managed to write one. Nothing to refresh WITH — the refresh
  // token lives in the row that is not there — so there is no revalidation to
  // attempt and the cookie is all that is left.
  if (stored.outcome === "absent") return unavailable("no-row");

  if (stored.capabilities && capabilitiesAreFresh(stored.checkedAt)) {
    return { source: "store", capabilities: stored.capabilities };
  }

  let config: ConsoleOidcConfig;
  try {
    config = getOidcConfig();
  } catch {
    // Zitadel is not configured on this deployment — local dev without the
    // OIDC env, typically. Checked BEFORE the transaction so a
    // misconfiguration never opens one, exactly as the token path does.
    return unavailable("not-configured");
  }

  const revalidated = await revalidateUnderLock(
    sid,
    session.sub,
    session.email,
    sessionExpiry(session.exp),
    config,
  );
  return revalidated
    ? { source: "store", capabilities: revalidated }
    : unavailable("revalidation-failed");
}

function unavailable(
  reason: CapabilityUnavailableReason,
): CapabilityResolution {
  return { source: "unavailable", reason };
}

/**
 * Spend the refresh token, read the roles off the new access token, store both.
 *
 * # Same lock, same reasons, and it must stay that way
 *
 * This is `renewUnderLock`'s shape and it is not duplication for its own sake:
 * revalidating MEANS refreshing, so both paths spend the same one-use refresh
 * token and must serialise against each other on the same row. Two locks, or
 * one path skipping the lock, would reintroduce the double-spend
 * `renewUnderLock`'s docstring describes — and Zitadel treats a reused refresh
 * token as theft and can revoke the entire grant, signing the operator out
 * everywhere. Read that docstring before changing this one.
 *
 * # The re-check inside the lock
 *
 * A caller that waited on the lock may be looking at a row somebody else has
 * just revalidated. Re-reading freshness INSIDE the lock and returning early
 * is what turns "everyone who was waiting also refreshes" into "exactly one
 * refresh", and skipping it would serialise the double-spend rather than
 * prevent it.
 *
 * # ONE deadline covering BOTH network calls
 *
 * The refresh and the JWKS-backed verification of its result are wrapped in a
 * SINGLE `REFRESH_TIMEOUT_MS` budget, not one each. That constant is sized
 * against `connectionTimeoutMillis` in `lib/db/tesserix.ts` — read its
 * docstring — and two 3s budgets in series would hold a connection from a
 * two-connection pool for 6s, quietly breaking the bound it documents. The
 * JWKS is cached after the first fetch, so in steady state the second call
 * costs arithmetic.
 *
 * # THE TOKENS ARE WRITTEN EVEN WHEN THE ROLES CANNOT BE READ
 *
 * By the time the roles read fails the refresh token has ALREADY been spent
 * and rotated. Returning early without persisting the replacement would leave
 * the row holding a dead token, and the session could never refresh again —
 * turning a capability read that failed into a lost session. So the write
 * always happens; only the capability columns are omitted, and omitting them
 * PRESERVES the previous list rather than clearing it (see `saveTokens`).
 */
async function revalidateUnderLock(
  sid: string,
  sub: string,
  email: string | undefined,
  sessionExpiresAt: Date,
  config: ConsoleOidcConfig,
): Promise<string[] | null> {
  try {
    return await tesserixTx(async (query) => {
      const locked = await readTokens(sid, { query, forUpdate: true });
      // Deleted between the unlocked read and the lock — a logout, or a prune.
      if (!locked) return null;

      // THE RE-CHECK. Another request revalidated while this one waited, so its
      // answer is the answer and there is nothing to spend.
      if (locked.capabilities && capabilitiesAreFresh(locked.capabilitiesCheckedAt)) {
        return locked.capabilities;
      }
      const refreshToken = locked.refreshToken;
      // Nothing to ask Zitadel with. The session keeps working until its access
      // token expires; the gate falls back to the cookie meanwhile.
      if (!refreshToken) return null;

      const outcome = await withDeadline(
        (async () => {
          const renewed = await refreshAccessToken(config, refreshToken);
          // Held in its own const so the narrowing survives into the object
          // returned below — `renewed.access_token` is `string | undefined` on
          // the response type, and TypeScript does not carry a property guard
          // across an object literal.
          const accessToken = renewed?.access_token;
          if (!renewed || !accessToken) return null;
          // VERIFIED, not decoded — `rolesFromAccessToken` owns that argument.
          // null here means the token could not be read at all (an OPAQUE
          // access token is the likely cause; see the deploy precondition in
          // its docstring), which is not the same as "holds no roles".
          const roles = await rolesFromAccessToken(accessToken, {
            issuer: config.issuer,
            projectId: config.projectId,
          });
          return { renewed, accessToken, roles };
        })(),
        REFRESH_TIMEOUT_MS,
      );

      // Rejected, revoked, or already rotated out from under us.
      // `refreshAccessToken` already logged why. NOTHING IS WRITTEN — the row
      // keeps the tokens it had, which is the only state that could still be
      // valid.
      if (!outcome) return null;
      const { renewed, accessToken, roles } = outcome;

      // `capabilitiesFor`, the SAME mapping `/auth/callback` applies, so the
      // stored list is the same representation the cookie carries and the two
      // cannot mean different things. `roles === null` means "no answer", and
      // is passed through as `undefined` so the upsert leaves the stored list
      // exactly as it found it.
      const capabilities =
        roles === null ? undefined : (capabilitiesFor(roles) as string[]);

      if (roles === null && !warnedUnreadableRoles) {
        warnedUnreadableRoles = true;
        console.warn(
          "[auth] capability revalidation could not read roles from the refreshed access token; " +
            "capabilities will stay at their last known value and revocation reverts to the session lifetime. " +
            "Check that the Zitadel application issues JWT access tokens rather than opaque ones",
          { sid },
        );
      }

      await saveTokens(
        sid,
        sub,
        {
          accessToken,
          accessExpiresAt: accessTokenExpiresAt(renewed.expires_in),
          // PERSIST THE ROTATED REFRESH TOKEN, on every branch. See the
          // docstring: the token is already spent by this point, so dropping
          // its replacement costs the session.
          refreshToken: renewed.refresh_token ?? refreshToken,
          capabilities,
          // Stamped only when there is a real answer. Advancing it on a failed
          // read would claim freshness for a list nobody confirmed, and the
          // next 300 seconds of gated actions would trust it.
          capabilitiesCheckedAt: capabilities ? new Date() : undefined,
        },
        sessionExpiresAt,
        { query },
      );

      return capabilities ?? null;
    });
  } catch {
    // A rolled-back transaction, an unreachable database, or the deadline
    // above. The caller treats all of them as "no live answer" and keeps the
    // cookie's snapshot; the store has already reported the detail without
    // logging anything a scraper could use.
    return null;
  }
}
