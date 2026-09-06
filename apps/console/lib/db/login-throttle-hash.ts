// `server-only`: this module reads an HMAC key out of the process
// environment. A client component that reaches it must fail the build loudly
// and name the import chain, not ship the key derivation — or the key — into
// a browser bundle.
import "server-only";

import { createHmac } from "node:crypto";

/**
 * The one-way form of a login name the TOTP cooldown counts against (#457).
 *
 * # Why the login name is stored at all, and why not in the clear
 *
 * The cooldown has to answer one question — "how many codes has THIS login got
 * wrong lately?" — which needs equality on the login name and nothing else. It
 * never displays one, never ranges over one, never joins on one. So the stored
 * value can be a digest, and `login_totp_failures` becomes a table that is
 * useless to anyone who dumps it.
 *
 * # HMAC, not sha256, for the reason `crm-erasure-hash.ts` gives
 *
 * This follows that module deliberately rather than inventing a second scheme.
 * A bare `sha256(login_name)` is not meaningfully one-way over this input: the
 * candidate space is the set of platform operator login names, which is small
 * and largely guessable from an org chart. Anyone holding a dump could confirm
 * which named operator had been fumbling their authenticator — and, during an
 * attack, which operator is being attacked. Keying the digest means a dump
 * alone confirms nothing without also holding {@link LOGIN_THROTTLE_HASH_KEY_ENV},
 * which lives in the environment and never in the database.
 *
 * The key is fixed and application-wide, forced by the requirement exactly as
 * it is there: a per-row salt cannot be matched against an incoming value,
 * because finding the salt means first finding the row you are looking for.
 *
 * # Its own key, not `CRM_ERASURE_HASH_KEY`
 *
 * Two unrelated subsystems sharing one HMAC key means rotating either one
 * invalidates the other's stored values — here a mass cooldown reset, there a
 * silently un-refusable erasure register. They also have different blast
 * radii and different reasons to be rotated. One key, one purpose.
 *
 * # Namespaced
 *
 * The HMAC message is `login:<canonical>`. Nothing else is hashed under this
 * key today; the prefix is there so that when something is, the two cannot
 * collide. It is part of the stored value's meaning — changing it invalidates
 * every hash already recorded, exactly as changing the key would, which in
 * this table means every live cooldown ends early rather than anything
 * breaking.
 *
 * # Absent key: `null`, not a throw
 *
 * DELIBERATELY UNLIKE `erasureHashes`, which throws, and the difference
 * is not carelessness. That function has two callers who want opposite things
 * from an absent key, so it refuses to decide for them. This one's callers all
 * want the same thing — carry on without the limiter, see `login-throttle.ts`
 * for why that direction — so a throw would have to be caught and discarded at
 * every call site, which is a worse place for the policy to live than here.
 */

/** The environment variable holding the HMAC key. */
export const LOGIN_THROTTLE_HASH_KEY_ENV = "LOGIN_THROTTLE_HASH_KEY";

/**
 * Read at call time, not at import: the console must not fail to boot because
 * a variable has not been provisioned yet, and a module-level read would also
 * make the value un-substitutable from a test that has already imported this.
 */
function readKey(): string | null {
  const raw = process.env[LOGIN_THROTTLE_HASH_KEY_ENV];
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Whether the cooldown can key anything right now.
 *
 * Exported so the caller can say so in a log line rather than inferring it
 * from a `null` hash, which is also what an empty login name produces.
 */
export function isLoginThrottleHashKeyConfigured(): boolean {
  return readKey() !== null;
}

/**
 * The canonical form a counter is keyed on: trimmed, and lower-cased.
 *
 * NOT tidiness. Without it `op@x`, `OP@x` and `  Op@X  ` are three different
 * hashes and therefore three separate quotas, so an attacker recovers the full
 * threshold for every spelling they can think of — while Zitadel, which
 * resolves all of them to one user, keeps counting them together toward the
 * lockout this control exists to prevent. The limiter would look present and
 * bound nothing.
 *
 * `toLowerCase()` rather than a locale-aware fold: this is applied on both
 * sides of a self-comparison, never rendered, so the only property required of
 * it is that it is a function — and a locale-sensitive one would not be, since
 * the same login name could canonicalise differently on two pods.
 */
function canonical(loginName: string): string {
  return loginName.trim().toLowerCase();
}

/**
 * The keyed hash for a login name, or `null` when there is nothing to key.
 *
 * `null` for two distinct reasons, and the caller does not need to tell them
 * apart because the answer to both is the same — do not throttle:
 *
 *  - the key is unset, so no hash can be computed at all; or
 *  - the login name is blank, so it is not a login name. A blank one never
 *    passed a password check, and hashing it would file every such caller
 *    under one shared bucket — a counter several unrelated logins could trip
 *    for each other.
 */
export function loginNameHash(loginName: string): string | null {
  const key = readKey();
  if (key === null) return null;

  const name = canonical(loginName);
  if (name.length === 0) return null;

  return createHmac("sha256", key).update(`login:${name}`).digest("hex");
}
