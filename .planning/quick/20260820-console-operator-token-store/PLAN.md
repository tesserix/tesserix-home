# Console operator token store (step 2 of the login fix)

Restores ADR-003 D8 — the console calling the platform API — without putting
the credentials back in the cookie that broke login.

Context: `.planning/debug/resolved/console-login-state-mismatch.md`.
Step 1 (`dec6eb5`, PR #297) removed `accessToken` / `accessTokenExpiresAt` /
`refreshToken` from the session cookie because they pushed `tx_session` past the
browser's 4096-byte limit and Chrome silently discarded it, looping every login.
`getPlatformApiToken()` has returned null since, so tickets reports unreachable.

## Design (agreed 2026-08-20)

**Hybrid, not a full server-side session.** The cookie keeps identity — `sub`,
`email`, `name`, `roles`, `iat`/`exp` — plus one new random `sid`. Tokens move to
Postgres keyed by `sid`.

The reason it is hybrid: `middleware.ts` runs on EVERY request and is currently
zero-I/O (a stateless JWE verify). An opaque-session-id design would put a DB
read on the critical path of every request, against a shared `db-f1-micro` that
CLAUDE.md names as a budget constraint. Tokens are read only on the requests
that actually call the platform API.

**This also fixes a second, already-live bug.** `lib/auth/platform-token.ts`
documents that a refreshed token is never written back, because persisting it
needs a response to set a cookie on and the refresh runs in server components.
Zitadel ROTATES refresh tokens on use, so today the first refresh discards the
replacement and every later refresh fails. A DB row can be written from
anywhere.

**On ADR-003 D2a.** The `refreshToken` comment in `session-jwt.ts` cites D2a
("do not add infrastructure") as why the token lives in the cookie. That
argument holds against Redis; it does not hold here, because the console
already connects to Postgres (`TESSERIX_DB_*`, `lib/db/tesserix.ts`). A table in
a database it already owns is not new infrastructure. Write this into the ADR so
the cookie decision is not re-derived later.

## Non-goals

- The custom login page / Zitadel Login V2. Explicitly last, after this.
- Any change to `middleware.ts`. It stays zero-I/O; that is the point.
- `apps/web`. Its session is identity-only and nowhere near the limit.

## Tasks

### Task 1: Migration `0029_operator_api_tokens.sql`

`apps/web/db/migrations/` (shared runner, applied by
`apps/web/scripts/db-migrate.mjs`, tracked in `schema_migrations`).

```
operator_api_tokens (
  sid                 text        PRIMARY KEY,
  sub                 text        NOT NULL,
  access_token        bytea       NOT NULL,
  access_expires_at   timestamptz NOT NULL,
  refresh_token       bytea,
  session_expires_at  timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
)
CREATE INDEX ON operator_api_tokens (session_expires_at);
```

- `text` not `uuid` for `sid`/`sub` — migrations 0003, 0017, 0018 all record
  that a foreign-issued identifier stored as `uuid` fails the implicit cast.
- `bytea` because the values are encrypted before they reach SQL.
- `session_expires_at` exists only so rows can be pruned; it mirrors the
  cookie's `exp`.
- Comment in the house style of `0028_platform_api_idempotency.sql`: why the
  table exists, why not the cookie, why not Redis.

Additive only — no existing table is touched, so the currently-deployed code
keeps running against the new schema. That is what makes apply-before-merge safe.

### Task 2: `sid` claim

`packages/platform-auth/src/session-jwt.ts` — add `sid?: string` to
`SessionClaims`.

OPTIONAL, and it must stay optional: every session minted before this carries
none, and a console that refused those would sign every operator out on deploy.
Absent `sid` means "no tokens available", which is the same null path callers
already handle.

`app/auth/callback/route.ts` mints it: `randomBytes(16).toString("hex")`.
Adds ~40 bytes to a 499-byte cookie; the step-1 size guard still applies.

### Task 3: Token store — `apps/console/lib/auth/operator-token-store.ts`

- `saveTokens(sid, sub, tokens, sessionExpiresAt)`
- `readTokens(sid)` → `{ accessToken, accessExpiresAt, refreshToken } | null`
- `deleteTokens(sid)`
- `pruneExpired()` — opportunistic, on write, `WHERE session_expires_at < now()`

Encryption: AES-256-GCM, key from **`OPERATOR_TOKEN_ENCRYPT_KEY`** — SEPARATE
from `SESSION_ENCRYPT_KEY`, so rotating the token key does not sign every
operator out, and a leak of one does not compromise the other. Store
`iv || tag || ciphertext`. Never log plaintext, ciphertext, or key material.

Every function must tolerate `isDatabaseConfigured() === false` and a missing
key by returning null / no-op, matching the existing pattern in
`lib/db/tesserix.ts`. A console that cannot reach its database must still serve
every surface that does not need the platform API.

### Task 4: Single-flight refresh

`lib/auth/platform-token.ts` — `getPlatformApiToken()` reads the store by `sid`
instead of the session, and on expiry refreshes INSIDE a transaction:

```
BEGIN
SELECT ... FROM operator_api_tokens WHERE sid = $1 FOR UPDATE
  -- re-check expiry here: another request may have refreshed while we waited
  -- refresh against Zitadel, persist BOTH new tokens (Zitadel rotates)
COMMIT
```

Two replicas and parallel server-component renders make this real: two
concurrent refreshes both spend the same refresh token, one wins, the other's
is dead. React's `cache` only dedupes within a single request.

Keep returning `null` on every existing failure path — callers already treat
null as "the platform API is not reachable as this operator".

### Task 5: Wire callback and logout

- Callback: after `signSession`, `saveTokens(...)`.
  **A store failure MUST NOT fail the login.** Log it and continue — signing in
  is more important than reaching the platform API, and coupling them would
  turn a database blip into an outage of the whole console. This is the same
  judgment step 1 made in the other direction: refuse to mint a cookie the
  browser will drop, but never refuse a login over an optional capability.
- Logout: `deleteTokens(sid)`, so signing out revokes API access rather than
  leaving a usable row until `session_expires_at`. Today logout revokes nothing.

### Task 6: Secret (NOT a subagent task — see ledger Ruling R2)

- Generate a 32-byte key; GCP Secret Manager as `prod-console-operator-token-key`.
- Add a `data` entry to the `console-secrets` ExternalSecret (store
  `gcp-secret-store`, refresh 1h) mapping it to `OPERATOR_TOKEN_ENCRYPT_KEY`.
- Land BEFORE the code deploys. Because task 3 degrades to null on a missing
  key, the reverse order is survivable rather than an outage — but it would
  silently disable the feature, so verify the env var is present on the pods
  before declaring this done.

### Task 7: Tests (folded into Tasks 2-5 — see ledger Ruling R3)

- Unit: encrypt/decrypt round-trip, tamper detection (GCM tag), missing key,
  missing DB, absent `sid`, expiry arithmetic.
- Integration (repo already has `*.integration.test.ts` against pg): save →
  read → refresh → delete; concurrent refresh takes the lock once.
- Callback: a store write failure still mints the session and still redirects.

## Deploy order

1. Secret in GCP + ExternalSecret entry; confirm `OPERATOR_TOKEN_ENCRYPT_KEY`
   on the pods.
2. Apply `0029` to prod (`kubectl port-forward` to
   `tesserix-postgres-rw.tesserix.svc.cluster.local`, credentials from the
   `tesserix-postgres-tesserix-admin` secret), verify the table and the
   `schema_migrations` row.
3. Merge. Kargo deploys.
4. Verify: fresh login still lands with one `session minted`; a tickets surface
   loads instead of reporting unreachable; `operator_api_tokens` has one row.

The precondition for step 3 is the live schema, not the merge — Kargo
auto-deploys and `db:migrate` does not ride along.

## Verification

- [ ] Login unchanged: one `session minted`, `cookieBytes` still far under 4096
- [ ] Tickets loads for a signed-in operator
- [ ] Exactly one row per active session; row deleted on logout
- [ ] Forcing an expired access token yields one refresh, not two, under
      concurrent renders
- [ ] Killing the DB degrades tickets to "unreachable" and leaves login working
