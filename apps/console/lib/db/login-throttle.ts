import "server-only";

import { LOGIN_THROTTLE_HASH_KEY_ENV, loginNameHash } from "./login-throttle-hash";
import { isDatabaseConfigured, tesserixQuery } from "./tesserix";

/**
 * A cooldown on TOTP attempts, so a stolen password cannot lock an operator
 * out of the console (#457).
 *
 * # The attack
 *
 * Zitadel's `maxOtpAttempts: 10` bounds TOTP guessing, and #445 verified that
 * it does. It is also a weapon: anyone holding an operator's password can
 * spend ten wrong codes in a second and put that operator in
 * `USER_STATE_LOCKED`. The console is where an incident gets investigated, so
 * locking its operators out is a plausible opening move.
 *
 * Tuning the number cannot fix it — raising it weakens guessing protection,
 * lowering it makes the lockout cheaper. So the console keeps its own count
 * and, past a threshold, DECLINES TO FORWARD the attempt. Zitadel's counter is
 * never incremented, and the attack cannot reach 10 however fast it runs.
 *
 * # What this does and does not achieve
 *
 * Zitadel resets its failure count on a successful authentication, so the
 * cooldown converts a guaranteed instant lockout into a race the attacker
 * usually loses: the victim has time to sign in and reset the count. It does
 * NOT make the lockout impossible against an operator who never signs in
 * during the attack. Said plainly here rather than overclaimed.
 *
 * # THE LOGIN NAME NEVER COMES FROM THE CLIENT
 *
 * This is the property the whole module is arranged around, and it is why
 * every function below takes a {@link PendingLogin} — two opaque server-issued
 * handles — rather than a login name.
 *
 * The obvious source at the code step is `tx_login_pending`, the cookie the
 * password step already sets. That would be a hole. It is `httpOnly` but plain
 * unsigned JSON, and `httpOnly` stops the page's own JavaScript, not a person
 * with curl. A login name read from it is a login name the CLIENT chose, so an
 * attacker could name any operator and spend that operator's attempts WITHOUT
 * HOLDING THEIR PASSWORD — a new denial of service, in the shape of a fix for
 * one.
 *
 * Instead {@link recordLoginIdentity} writes the mapping server-side after the
 * password check passes, and everything here resolves the login name through
 * it. Because the public functions accept no login name, a caller CANNOT pass
 * a client-supplied one even by mistake. That is deliberate: the guarantee is
 * enforced by the signatures rather than by a rule the next caller has to
 * remember.
 *
 * # Everything here fails OPEN, and that is a decision, not an oversight
 *
 * If the database is unreachable, if the migration has not been applied, if
 * the hash key is unset — the attempt is forwarded and the limiter is simply
 * not in force.
 *
 * The other direction was considered and rejected. Refusing every TOTP attempt
 * because a limiter table is unreachable would lock every operator out of the
 * console, which is precisely the denial of service this exists to prevent,
 * only self-inflicted and affecting everyone at once rather than one targeted
 * account. It would also make a limiter outage indistinguishable from the
 * attack, at the moment an operator most needs to get in and look.
 *
 * The cost of failing open is real and is worth naming: the control is
 * OPTIONAL-BY-CONSTRUCTION, so a deployment that never provisions
 * `LOGIN_THROTTLE_HASH_KEY` runs without it and nothing breaks to say so. Two
 * things bound that. First, failing open degrades to the state that shipped
 * BEFORE this change — Zitadel's `maxOtpAttempts` is untouched and still the
 * backstop — rather than to something weaker. Second, every degraded path
 * below warns with a distinct message naming what is missing, so the condition
 * is visible in the console's logs rather than silent. That is deliberately
 * the same shape as `denied-attempts.ts`, which swallows its own failures for
 * the mirror-image reason: a logging outage must not become an access-control
 * outage.
 */

/** Failures inside {@link TOTP_FAILURE_WINDOW_MS} that trip the cooldown.
 *
 *  Five is generous against a fumbling operator — a genuine mis-type is one or
 *  two, and a rolled-over code is one more — while making Zitadel's ten take
 *  two sustained windows rather than one second. */
export const TOTP_FAILURE_THRESHOLD = 5;

/**
 * How far back failures are counted — and, as a direct consequence, how long
 * the cooldown lasts.
 *
 * ONE NUMBER, NOT TWO. There is no stored `cooldown_until`: "declined" means
 * `count(failures in the last window) >= threshold`, so the cooldown ends by
 * itself as the oldest counted failure ages out. A separate expiry would be a
 * second representation of the same fact, able to disagree with the rows it
 * was derived from, and — the reason that matters — able to outlive them. A
 * state that persists after its justification is gone is the shape of the
 * lockout this change exists to avoid.
 */
export const TOTP_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * How long a pending-identity mapping is honoured.
 *
 * MUST BE >= the `tx_login_pending` cookie's max age (5 minutes, see
 * `app/login/pending-session.ts`). A mapping that expired before the cookie
 * would leave a live login whose failures are counted against nobody — the
 * limiter quietly off for the tail of every slow sign-in. It is set to the
 * failure window instead of to that 5 minutes so the two numbers that must not
 * drift apart are the same number, and generously, because an over-long
 * mapping costs only a row: it can be spent solely by a browser that holds a
 * live Zitadel session token for that exact auth request, which is to say by
 * the person who passed the password check.
 */
const IDENTITY_MAX_AGE_MS = TOTP_FAILURE_WINDOW_MS;

/**
 * The two server-issued handles a half-finished login is identified by.
 *
 * Both come from `tx_login_pending`, and neither is trusted AS A NAME — they
 * are only ever a lookup key into a row the SERVER wrote. Both must match, for
 * the reason `0050_login_totp_cooldown.sql` sets out: the auth request id
 * alone is a value the client carries, so keying on it alone would let someone
 * who learned a victim's in-flight id spend that victim's attempts. The
 * session id is not free to choose, because the code being spent is added to
 * that same session.
 */
export interface PendingLogin {
  readonly authRequestId: string;
  readonly sessionId: string;
}

/** A declined attempt, and when the operator may try again. */
export interface TotpCooldown {
  /** When the count drops back below the threshold, assuming no further
   *  failures — which a declined attempt cannot produce, because it is never
   *  sent. Derived from the OLDEST of the counted failures, since that is the
   *  one whose ageing out releases the cooldown. */
  readonly retryAt: Date;
}

/** Postgres interval literals, built from the constants so the SQL and the
 *  exported numbers cannot drift. */
const WINDOW_INTERVAL = `${TOTP_FAILURE_WINDOW_MS} milliseconds`;
const IDENTITY_INTERVAL = `${IDENTITY_MAX_AGE_MS} milliseconds`;

/**
 * Say that the limiter is not in force, and carry on.
 *
 * Every degraded path here is one the operator's login survives, so nothing
 * may be rethrown; this line is the only trace, which is why it names the
 * condition rather than saying "failed".
 *
 * NOT collapsed or rate-limited, unlike `denied-attempts.ts`'s five-minute
 * window. That one collapses because it writes an audit ROW an operator reads;
 * this only writes to stdout, and the volume is bounded by login attempts —
 * tens a day, not thousands. Collapsing it would also hide the case that
 * matters most: a limiter that is off on every attempt should look like it, in
 * the log, on every attempt.
 */
function degraded(reason: string, detail?: unknown): void {
  console.warn(`[login-throttle] not in force: ${reason}`, detail ?? "");
}

/**
 * Record which login name an auth request belongs to, after its password check
 * has passed.
 *
 * Call this and only this with a login name. See the module comment: it is the
 * one place a login name enters the limiter, and it enters it from the server's
 * own hand rather than from the browser's.
 *
 * The upsert replaces rather than accumulates: one auth request is in the
 * middle of exactly one login, and re-submitting the password for the same
 * request — a mistyped password, then the right one — must not leave the first
 * attempt's mapping in place.
 */
export async function recordLoginIdentity(
  pending: PendingLogin,
  loginName: string,
): Promise<void> {
  if (!isDatabaseConfigured()) return degraded("no database is configured");

  const hash = loginNameHash(loginName);
  if (hash === null) return degraded(`${LOGIN_THROTTLE_HASH_KEY_ENV} is not set`);

  try {
    await tesserixQuery(
      `INSERT INTO login_pending_identity (auth_request_id, login_name_hash, session_id, created_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (auth_request_id)
       DO UPDATE SET login_name_hash = EXCLUDED.login_name_hash,
                     session_id = EXCLUDED.session_id,
                     created_at = now()`,
      [pending.authRequestId, hash, pending.sessionId],
    );
    // Opportunistic, in the same round trip's shadow rather than on a
    // schedule: nothing in this estate runs a cleanup job, and a table that
    // only ever grows is one somebody finds at forty million rows. Deleting
    // here rather than at the read is what keeps the read a point lookup.
    await tesserixQuery(
      `DELETE FROM login_pending_identity WHERE created_at < now() - $1::interval`,
      [IDENTITY_INTERVAL],
    );
  } catch (error) {
    // Swallowed: the operator has just typed a correct password and is owed
    // the code prompt. The consequence is that this login is not counted,
    // which is the fail-open the module comment argues for.
    degraded("the pending identity could not be recorded", error);
  }
}

/**
 * The login name this auth request belongs to, as the SERVER recorded it, or
 * `null` when there is none to be had.
 *
 * `null` covers a mapping that was never written (the database was down at the
 * password step), one that has aged out, a request id the client invented, and
 * a request id that belongs to somebody else's login. All four mean the same
 * thing to every caller: there is no login name this server can vouch for, so
 * nothing may be counted. Guessing one from the client's cookie is the hole
 * this design exists to close.
 */
async function identityHash(pending: PendingLogin): Promise<string | null> {
  const rows = await tesserixQuery<{ login_name_hash: string }>(
    `SELECT login_name_hash FROM login_pending_identity
      WHERE auth_request_id = $1 AND session_id = $2
        AND created_at > now() - $3::interval`,
    [pending.authRequestId, pending.sessionId, IDENTITY_INTERVAL],
  );
  return rows[0]?.login_name_hash ?? null;
}

/**
 * Whether this attempt must be declined, and when it may be retried.
 *
 * CALL THIS BEFORE `addTotpCheck`, NEVER AFTER. Not spending a Zitadel attempt
 * is the entire mechanism; a check that runs after the code has been forwarded
 * has already let the increment through and is decoration.
 */
export async function totpCooldownFor(pending: PendingLogin): Promise<TotpCooldown | null> {
  if (!isDatabaseConfigured()) {
    degraded("no database is configured");
    return null;
  }

  try {
    const hash = await identityHash(pending);
    if (hash === null) return null;

    // The most recent failures inside the window, newest first. `LIMIT
    // threshold` is what makes the last row the OLDEST OF THE COUNTED ones
    // rather than the oldest in the window — and it is that row's expiry, not
    // the window's start, that releases the cooldown.
    const rows = await tesserixQuery<{ failed_at: Date }>(
      `SELECT failed_at FROM login_totp_failures
        WHERE login_name_hash = $1 AND failed_at > now() - $2::interval
        ORDER BY failed_at DESC
        LIMIT $3`,
      [hash, WINDOW_INTERVAL, TOTP_FAILURE_THRESHOLD],
    );

    if (rows.length < TOTP_FAILURE_THRESHOLD) return null;

    const oldestCounted = rows[rows.length - 1].failed_at;
    return { retryAt: new Date(oldestCounted.getTime() + TOTP_FAILURE_WINDOW_MS) };
  } catch (error) {
    // Fail open. See the module comment: refusing every attempt because the
    // limiter is unreadable would lock every operator out of the console at
    // once, which is a worse version of the outage this prevents.
    degraded("the cooldown could not be read", error);
    return null;
  }
}

/**
 * Record a code that WAS sent to Zitadel and rejected by it.
 *
 * Only a rejection, and only a real one. A code the console refused to forward
 * — malformed, or already inside a cooldown — never reached Zitadel and so
 * incremented nothing there; counting it would let an attacker extend their
 * victim's cooldown indefinitely by hammering a door that is already closed.
 */
export async function recordTotpFailure(pending: PendingLogin): Promise<void> {
  if (!isDatabaseConfigured()) return degraded("no database is configured");

  try {
    const hash = await identityHash(pending);
    if (hash === null) return;

    await tesserixQuery(
      `INSERT INTO login_totp_failures (login_name_hash, failed_at) VALUES ($1, now())`,
      [hash],
    );
    // Prune this login's own expired failures, for the reason the identity
    // prune gives. Scoped to the one hash so the write stays a single index
    // range rather than a table-wide scan on every wrong code.
    await tesserixQuery(
      `DELETE FROM login_totp_failures
        WHERE login_name_hash = $1 AND failed_at <= now() - $2::interval`,
      [hash, WINDOW_INTERVAL],
    );
  } catch (error) {
    // Swallowed: the operator is already being told their code was wrong, and
    // failing that response because the counter could not be written would
    // turn a limiter outage into a login outage.
    degraded("the failure could not be recorded", error);
  }
}

/**
 * Forget this login name's failures, on a code that checked out.
 *
 * Mirrors Zitadel's own reset-on-success, and for the same reason: an operator
 * who fumbles twice and then gets it right has demonstrated they are the
 * operator, so carrying those near-misses into their next sign-in would make
 * an ordinary week's typing accumulate into a cooldown.
 */
export async function clearTotpFailures(pending: PendingLogin): Promise<void> {
  if (!isDatabaseConfigured()) return degraded("no database is configured");

  try {
    const hash = await identityHash(pending);
    if (hash === null) return;

    await tesserixQuery(`DELETE FROM login_totp_failures WHERE login_name_hash = $1`, [hash]);
  } catch (error) {
    // Swallowed, and this one is the benign direction: an uncleared count
    // costs a successful operator some of their next window's headroom, where
    // rethrowing would cost them the login they just completed.
    degraded("the failure count could not be cleared", error);
  }
}
