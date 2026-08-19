import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { QueryResultRow } from "pg";
import { isDatabaseConfigured, tesserixQuery } from "../db/tesserix";

/**
 * The server-side home of the console's Zitadel tokens.
 *
 * # Why this table exists at all
 *
 * `/auth/callback` used to put the access and refresh tokens into the
 * `tx_session` cookie. With ten roles the encrypted payload cleared the
 * browser's hard 4096-byte per-cookie limit, and a browser over that limit
 * DISCARDS the whole `Set-Cookie` without telling the origin: every login
 * succeeded server-side, left the browser with no session, and bounced back
 * through `/auth/login` until Chrome gave up. See
 * `.planning/debug/resolved/console-login-state-mismatch.md` and the header of
 * `apps/web/db/migrations/0029_operator_api_tokens.sql`.
 *
 * So identity stays in the cookie — `middleware.ts` runs on every request and
 * has to stay zero-I/O — and the credentials move here, keyed by the cookie's
 * `sid` claim and read only by the requests that actually call the platform
 * API.
 *
 * # What is encrypted, and how
 *
 * Both tokens are bearer credentials: anything holding one can act as the
 * operator until it expires. They are therefore stored as AES-256-GCM
 * ciphertext, so a database dump, a replica, or a backup is not a pile of
 * usable tokens.
 *
 * The stored bytea is laid out as:
 *
 *     iv (12 bytes) || auth tag (16 bytes) || ciphertext (rest)
 *
 * That layout is the contract between {@link encryptToken} and
 * {@link decryptToken} and must not drift: both derive their offsets from the
 * two constants below, so changing one changes both.
 *
 * The IV is FRESH random bytes on every single encryption. GCM's security
 * collapses entirely if a nonce is ever reused under the same key — two
 * ciphertexts under one nonce leak their XOR and, worse, the authentication
 * key. It is never derived from the plaintext, the `sid`, or a counter.
 *
 * # Nothing here logs a token
 *
 * No plaintext, no ciphertext, no key material, no token value of any kind
 * reaches a log line. Failures are reported with a `sid`, a boolean, or a
 * length, which is enough to debug a store problem and useless to anyone who
 * scrapes the logs.
 *
 * # Nothing here throws at its caller — with one deliberate exception
 *
 * The console must keep serving every surface that does not need the platform
 * API when the database is unreachable, the key is unset, or a row is
 * corrupt. Reads return null, writes do nothing. A throw out of this module
 * would take down the whole page for want of a token the page never wanted.
 *
 * The exception is a caller that supplies its own `query` — it is inside a
 * transaction, so it NEEDS the failure in order to roll back, and it has its
 * own boundary to catch at. See {@link TokenStoreOptions}; that is the only
 * path on which anything here rethrows.
 */

/** GCM's standard nonce length. 12 bytes is what the mode is specified for;
 *  anything else forces an extra GHASH derivation step for no benefit. */
const IV_BYTES = 12;

/** GCM's authentication tag length, in bytes. Full 128-bit tag — a truncated
 *  tag buys 4 bytes a row and weakens the only thing standing between a
 *  tampered row and a forged token. */
const TAG_BYTES = 16;

/** The shortest possible valid envelope: iv + tag + at least one byte of
 *  ciphertext. Anything SHORTER than this is truncated or not ours; exactly
 *  this length is a valid one-character token and is accepted, which is why
 *  the guard below is `<` and must not be tidied into `<=`. */
const MIN_ENVELOPE_BYTES = IV_BYTES + TAG_BYTES + 1;

/** What a caller gets back for a session that has tokens stored. */
export interface StoredOperatorTokens {
  accessToken: string;
  accessExpiresAt: Date;
  /** Null when Zitadel issued no refresh token, or when the one it issued was
   *  spent and its replacement was never persisted. The session then works
   *  until `accessExpiresAt` and no further — degrade, not break. */
  refreshToken: string | null;
}

/** What a caller hands in to persist. */
export interface OperatorTokensInput {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken?: string | null;
}

/**
 * A statement runner: `tesserixQuery`'s signature, so either the pool or a
 * transaction's scoped query satisfies it.
 *
 * Every exported function takes one optionally. That is what keeps the
 * refresh path — `SELECT ... FOR UPDATE`, refresh, `UPDATE`, all under one
 * lock on `sid` so two replicas cannot race to spend the same one-use refresh
 * token — from having to bypass this module and hand-roll its own SQL.
 */
export type TokenStoreQuery = <R extends QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
) => Promise<R[]>;

export interface TokenStoreOptions {
  /** Run inside this transaction instead of on the shared pool. When given,
   *  database errors PROPAGATE rather than degrading — a caller inside a
   *  transaction needs the failure so it can roll back, and it has its own
   *  boundary to catch at. On the pool path they are swallowed. */
  query?: TokenStoreQuery;
}

export interface ReadTokensOptions extends TokenStoreOptions {
  /** Take a row lock for the duration of the transaction. Only meaningful
   *  with `query`; a `FOR UPDATE` outside a transaction locks nothing, so it
   *  is ignored there rather than silently implying safety it cannot give. */
  forUpdate?: boolean;
}

/**
 * The AES-256 key, derived from `OPERATOR_TOKEN_ENCRYPT_KEY`.
 *
 * SEPARATE from `SESSION_ENCRYPT_KEY` on purpose: rotating the token key must
 * not sign every operator out, and a leak of either must not open the other.
 *
 * ALWAYS SHA-256 over the raw env value, for every key length.
 *
 * That is deliberately NOT what `getSecretKey()` in
 * `packages/platform-auth/src/session-jwt.ts` does: it returns the raw bytes
 * when the value is exactly 32 ASCII characters and only falls back to SHA-256
 * otherwise — and since the chart provisions exactly 32 characters, raw is its
 * production branch. Hashing unconditionally means the derivation does not
 * change shape if the provisioned key length ever does; under `getSecretKey`'s
 * rule, going from 32 characters to 33 silently switches derivation branch.
 *
 * Do not "harmonise" this with `getSecretKey()`. Adding the length-32 shortcut
 * would change the effective key for the key currently provisioned, and every
 * row already in `operator_api_tokens` would silently fail its auth tag —
 * every operator's platform-API access gone until they sign in again.
 *
 * Read at call time, not at import: like `isDatabaseConfigured`, this must be
 * able to answer "not configured" truthfully during the window before the
 * chart supplies the variable, rather than throwing on import and taking the
 * console down with it.
 */
function getEncryptionKey(): Buffer | null {
  const raw = process.env.OPERATOR_TOKEN_ENCRYPT_KEY;
  if (!raw || raw.length === 0) return null;
  return createHash("sha256").update(raw).digest();
}

/**
 * Encrypt one token into the `iv || tag || ciphertext` envelope.
 *
 * Returns null when no key is configured, so a caller degrades rather than
 * writing a plaintext token into a bytea column.
 *
 * Exported for tests: that a second encryption of the SAME plaintext produces
 * DIFFERENT bytes is the observable proof the IV is fresh, and it can only be
 * observed here.
 */
export function encryptToken(plaintext: string): Buffer | null {
  const key = getEncryptionKey();
  if (!key) return null;
  // Fresh per call. Never a counter, never derived from anything.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Decrypt one envelope, verifying the GCM auth tag.
 *
 * FAILS CLOSED, always. A tampered tag, a tampered body, a truncated buffer, a
 * value encrypted under a rotated key, or a missing key all return null. It
 * never returns partial plaintext — GCM verifies the tag in `final()` and
 * Node throws there, which is caught here and never leaves the module.
 *
 * Exported for tests, for the same reason as {@link encryptToken}.
 */
export function decryptToken(envelope: Buffer | Uint8Array | null): string | null {
  if (!envelope) return null;
  const key = getEncryptionKey();
  if (!key) return null;
  // pg hands back a Buffer for bytea; pglite hands back a Uint8Array. Normalise
  // rather than assume, so the integration tests exercise the same code path
  // production does.
  const buf = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
  if (buf.length < MIN_ENVELOPE_BYTES) return null;
  try {
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    // `final()` is where the tag is checked. Both halves are needed; the
    // update output must NOT be returned on its own.
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    // Tag mismatch, wrong key, or a mangled row. There is nothing safe to say
    // about the value here and nothing to log about it either.
    return null;
  }
}

/** True when this module can do anything at all: a reachable database AND a
 *  key to encrypt with. Both are required — a store that can write but not
 *  encrypt is worse than a store that does nothing. */
function isStoreUsable(options: TokenStoreOptions): boolean {
  if (!getEncryptionKey()) return false;
  // A caller-supplied query brings its own connection; the pool's env check
  // does not apply to it.
  return Boolean(options.query) || isDatabaseConfigured();
}

function runner(options: TokenStoreOptions): TokenStoreQuery {
  return options.query ?? ((sql, params) => tesserixQuery(sql, params ?? []));
}

/**
 * Report a store failure without saying anything a log scraper could use.
 *
 * `sid` names the session, the operation names the call. No token, no
 * ciphertext, no key, and not even the driver's error text — a Postgres error
 * on an INSERT can echo the parameters back.
 */
function reportFailure(operation: string, sid: string | null): void {
  console.error(
    `[auth] operator token store: ${operation} failed`,
    sid ? { sid } : {},
  );
}

interface TokenRow extends QueryResultRow {
  access_token: Uint8Array;
  access_expires_at: Date;
  refresh_token: Uint8Array | null;
}

/**
 * Read the tokens for one session, or null.
 *
 * Null covers every "no usable token" case a caller must survive identically:
 * no row, no key, no database, a row whose ciphertext will not authenticate.
 * The access token failing to decrypt discards the whole row's worth of
 * answer — a refresh token without the access token it belongs to is not a
 * partial success worth returning.
 */
export async function readTokens(
  sid: string,
  options: ReadTokensOptions = {},
): Promise<StoredOperatorTokens | null> {
  if (!isStoreUsable(options)) return null;
  const lock = options.query && options.forUpdate ? " FOR UPDATE" : "";
  try {
    const rows = await runner(options)<TokenRow>(
      `SELECT access_token, access_expires_at, refresh_token
         FROM operator_api_tokens
        WHERE sid = $1${lock}`,
      [sid],
    );
    const row = rows[0];
    if (!row) return null;
    const accessToken = decryptToken(row.access_token);
    if (!accessToken) {
      reportFailure("access token did not decrypt", sid);
      return null;
    }
    return {
      accessToken,
      accessExpiresAt: row.access_expires_at,
      // A refresh token that will not decrypt degrades to "no refresh token",
      // which is already a case every caller handles: the session works until
      // the access token expires.
      refreshToken: decryptToken(row.refresh_token),
    };
  } catch (err) {
    if (options.query) throw err;
    reportFailure("read", sid);
    return null;
  }
}

/**
 * Persist (or replace) the tokens for one session.
 *
 * Upsert on `sid`: a refresh writes over the row the callback created, which
 * is the same statement, so there is no insert-or-update branch to get wrong.
 *
 * Best-effort by contract. A failure here means the platform API is
 * unreachable as this operator for this session; it does not mean the login
 * failed, and it must not be allowed to make the login fail.
 */
export async function saveTokens(
  sid: string,
  sub: string,
  tokens: OperatorTokensInput,
  sessionExpiresAt: Date,
  options: TokenStoreOptions = {},
): Promise<void> {
  if (!isStoreUsable(options)) return;
  const accessCiphertext = encryptToken(tokens.accessToken);
  if (!accessCiphertext) return;
  const refreshCiphertext = tokens.refreshToken
    ? encryptToken(tokens.refreshToken)
    : null;
  try {
    await runner(options)(
      `INSERT INTO operator_api_tokens
         (sid, sub, access_token, access_expires_at, refresh_token,
          session_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (sid) DO UPDATE SET
         sub = EXCLUDED.sub,
         access_token = EXCLUDED.access_token,
         access_expires_at = EXCLUDED.access_expires_at,
         refresh_token = EXCLUDED.refresh_token,
         session_expires_at = EXCLUDED.session_expires_at,
         updated_at = now()`,
      [
        sid,
        sub,
        accessCiphertext,
        tokens.accessExpiresAt,
        refreshCiphertext,
        sessionExpiresAt,
      ],
    );
  } catch (err) {
    if (options.query) throw err;
    reportFailure("save", sid);
    return;
  }
  // Opportunistic, and deliberately after the write rather than before it: the
  // write is what the caller is waiting on, and a prune that fails must not
  // cost them the row they came to store. Piggy-backing on writes is what
  // migration 0029 records instead of a scheduled job — the sweep is one
  // indexed statement and needs no infrastructure to carry it.
  //
  // NEVER INSIDE A TRANSACTION, AND DO NOT PUT IT BACK. Two reasons, both of
  // which cost a session:
  //
  //  1. On the transaction path this function rethrows, so a prune that fails
  //     after a successful INSERT rolls the INSERT back with it. Zitadel
  //     ROTATES refresh tokens on use, so the refreshed token would be lost and
  //     the caller's next attempt would spend an already-spent one — exactly
  //     the "must not cost them the row they came to store" the line above
  //     promises, inverted.
  //  2. The refresh path is BEGIN -> SELECT ... FOR UPDATE (one sid) -> save ->
  //     COMMIT. A table-wide `DELETE ... WHERE session_expires_at < now()`
  //     inside that lock takes row locks in whatever order the scan finds them,
  //     so two concurrent refreshes of sessions near their expiry can lock in
  //     opposite orders and deadlock.
  //
  // Skipping it here fixes both: the transaction does one row's work and
  // nothing else, and the sweep still happens on every non-transactional write.
  if (!options.query) await pruneExpired(options);
}

/**
 * Drop this session's tokens. Logout's half of the contract.
 *
 * Best-effort: a logout whose cookie is cleared but whose row survives is
 * recoverable — the row is unreachable without the `sid` claim and gets swept
 * by {@link pruneExpired} — whereas a logout that throws leaves the operator
 * signed in.
 */
export async function deleteTokens(
  sid: string,
  options: TokenStoreOptions = {},
): Promise<void> {
  if (!isStoreUsable(options)) return;
  try {
    await runner(options)(`DELETE FROM operator_api_tokens WHERE sid = $1`, [
      sid,
    ]);
  } catch (err) {
    if (options.query) throw err;
    reportFailure("delete", sid);
  }
}

/**
 * Sweep rows whose session could not possibly be presented again.
 *
 * `session_expires_at` and not either token's expiry: an access token expires
 * hourly and its row must survive to be refreshed, while the session's own
 * expiry is the point past which no cookie can name this row at all. Backed by
 * `operator_api_tokens_session_expires_idx`, which 0029 created for exactly
 * this statement.
 *
 * The only function here that does not need the encryption key: deleting a row
 * never looks inside it. It still needs a database, so it degrades to a no-op
 * without one like everything else.
 */
export async function pruneExpired(
  options: TokenStoreOptions = {},
): Promise<void> {
  if (!options.query && !isDatabaseConfigured()) return;
  try {
    await runner(options)(
      `DELETE FROM operator_api_tokens WHERE session_expires_at < now()`,
    );
  } catch (err) {
    if (options.query) throw err;
    reportFailure("prune", null);
  }
}
