-- 0040_operator_capabilities.sql
--
-- Make a revoked capability take effect in minutes rather than a week
-- (tesserix-home#285).
--
-- `/auth/callback` writes `capabilitiesFor(email, roles)` into the `tx_session`
-- JWE exactly once, at login, and nothing re-reads Zitadel for the seven days
-- that cookie lives. Remove an operator's `hard-delete` in Zitadel and they
-- keep it in the console until the cookie expires. The same mechanism was
-- observed pointing the harmless way on 2026-08-19: four roles were GRANTED
-- and neither operator saw them until they signed in again.
--
-- The session cannot be the fix. Migration 0029's header records why the
-- credentials left the cookie in the first place — the browser's hard
-- 4096-byte per-cookie limit, silently enforced by DISCARDING the whole
-- `Set-Cookie` — and the cookie has already crossed it once. Adding a field is
-- not available. Neither is re-issuing the cookie from the render path: Next
-- forbids setting cookies during render, so a server component that notices
-- staleness has nowhere to write the correction.
--
-- So the authoritative capability list moves here, beside the tokens that can
-- refresh it, and the cookie's copy is demoted to what it has always actually
-- been: a UX hint that decides which buttons render. The verb gate —
-- `checkOperatorCapability`, called by every server action and route handler
-- before a mutation — reads these columns instead.
--
-- WHY THIS TABLE AND NOT A NEW ONE: the row is already keyed by `sid`, already
-- holds the refresh token that is the ONLY way to ask Zitadel what an operator
-- currently holds, and is already pruned when the session dies. A second table
-- would need the same key, the same lifetime and the same sweep, and would add
-- a second place for the two facts to disagree.
BEGIN;

-- =======================================================================
-- operator_api_tokens — capabilities, and when they were last confirmed
-- =======================================================================

-- The MAPPED capability keys — exactly what `capabilitiesFor(email, roles)`
-- produces for the cookie, not the raw Zitadel role strings it was derived
-- from. Storing the raw roles would leave two representations of the same
-- grant that can disagree with each other, which is the bug class this whole
-- change exists to close; the mapping is applied once, at the point the token
-- is read, and only its result is persisted.
--
-- text[] and not jsonb: this is a flat list of a dozen short, fixed keys
-- (`crm`, `hard-delete`, `publish-catalog` — see
-- packages/platform-auth/src/capabilities.ts), it is only ever read and
-- written AS A WHOLE, and nothing queries into it. jsonb would buy containment
-- operators and a GIN index for a value that is never searched, at the cost of
-- a representation that can hold shapes this column has no meaning for — an
-- object, a nested array, a number. text[] can only hold the thing it is for.
--
-- NULLABLE, and NULL DOES NOT MEAN "HOLDS NOTHING". It means "never checked":
-- every row written before this migration predates the column, and a row is
-- also created by `/auth/callback` on deployments where the capability read is
-- not wired up. A reader MUST treat NULL as STALE and go and ask, exactly as
-- it treats an old `capabilities_checked_at`. Reading it as an empty grant
-- would refuse every gated action for every session that existed at deploy
-- time — an outage, delivered by a change whose purpose is to avoid one.
--
-- An operator who genuinely holds nothing is stored as `{}` — an empty array,
-- which is NOT NULL and is a real answer. The two are distinguished
-- deliberately and the distinction is load-bearing; do not collapse them with
-- `DEFAULT '{}'`, which would turn "never checked" into "checked, and holds
-- nothing" for every pre-existing row.
ALTER TABLE operator_api_tokens
  ADD COLUMN capabilities text[];

-- When `capabilities` above was last confirmed against Zitadel, set by the
-- application at login and on every proactive revalidation.
--
-- THIS COLUMN IS THE REVOCATION WINDOW. The console refuses to trust
-- `capabilities` older than CAPABILITY_REVALIDATE_SECONDS (300s, in
-- apps/console/lib/auth/platform-token.ts) and refreshes the access token to
-- re-derive them. That bound is the whole point of the change: the access
-- token lives about twelve hours, so revalidating only when the TOKEN is near
-- expiry would give a twelve-hour revocation window rather than a five-minute
-- one. The refresh is driven by THIS timestamp, not by the token's.
--
-- timestamptz, like every other instant in this schema: the console runs in
-- one timezone today and the comparison is against `now()`, so a naive
-- timestamp would be correct only for as long as that stays true.
--
-- NULLABLE for the same reason as `capabilities`, and read the same way — NULL
-- is "never checked", which is stale. The two columns are always written
-- together and a row with one set and not the other should not exist; nothing
-- enforces that in the schema because the only writer is `saveTokens`, which
-- writes them as a pair.
ALTER TABLE operator_api_tokens
  ADD COLUMN capabilities_checked_at timestamptz;

-- No index. The only read is by primary key — `WHERE sid = $1`, the same point
-- lookup 0029 describes for the tokens — and `capabilities_checked_at` is
-- compared to `now()` only after that row has already been found. An index on
-- it would be maintained on every login and every revalidation to serve no
-- query. The prune sweep still goes through
-- `operator_api_tokens_session_expires_idx`, unchanged.

COMMIT;
