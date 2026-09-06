-- 0050_login_totp_cooldown.sql
--
-- The store behind a cooldown on TOTP attempts (tesserix-home#457).
--
-- ══ WHAT THIS IS FOR ══
--
-- Zitadel's `maxOtpAttempts: 10` bounds TOTP guessing, and #445 verified that
-- it does. It is also a weapon: anyone who can reach `/login` holding an
-- operator's password — leaked, shared, reused — can spend ten wrong codes in
-- one second and put that operator in `USER_STATE_LOCKED`. The console is
-- where an incident gets investigated, so locking its operators out is a
-- plausible opening move rather than an annoyance.
--
-- Tuning the number cannot fix it. Raising it weakens guessing protection;
-- lowering it makes the denial of service cheaper. So the console counts its
-- own failures and, past a threshold, DECLINES TO FORWARD the attempt.
-- Zitadel's counter is never incremented, and the attack cannot reach 10
-- however fast it runs.
--
-- ══ WHY POSTGRES AND NOT MEMORY ══
--
-- An in-process counter is reset by a pod restart, and the console runs more
-- than one replica — so a counter held in memory is both evictable by the
-- attacker (crash-loop the pod, or simply spread the attempt across replicas)
-- and untestable in the shape that matters. The count has to be shared and it
-- has to survive, which makes it a table.
--
-- ══ TWO TABLES, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS ══
--
-- `login_pending_identity` answers "whose login is this browser in the middle
-- of?" and `login_totp_failures` answers "how many codes has that login got
-- wrong lately?". They have different lifetimes, different keys and different
-- write points; one table carrying both would have to invent a row shape that
-- is half-empty in each of its two roles.
--
-- ══ THE LOGIN NAME IS HASHED, AND THE HASH IS KEYED ══
--
-- The limiter needs equality on the login name and nothing else — it never
-- displays one, never ranges over one, never joins on one. A hash gives
-- exactly that behaviour while leaving these tables useless to anyone who
-- dumps them.
--
-- Keyed (HMAC-SHA256), not a bare digest, for the reason
-- `0041_crm_erased_identifiers.sql` gives at length for the same choice: the
-- candidate space here is the set of platform operator login names, which is
-- small and largely guessable, so a bare `sha256(login_name)` would let anyone
-- holding a dump confirm which named operator had been fumbling their
-- authenticator — and, during an attack, which operator is being attacked.
-- The key lives in the application environment and never in this database.
-- `apps/console/lib/db/login-throttle-hash.ts` computes it and carries the
-- full argument.
--
-- ══ NO OPERATOR IDENTITY, NO FOREIGN KEYS, NOTHING TO RE-IDENTIFY FROM ══
--
-- Same discipline as 0041. There is no `user_id`, no email, no IP, no user
-- agent, and no reference to any table that carries an identity. What is
-- retained is the minimum needed to decide whether to forward one attempt.
--
-- ══ RE-RUNNABILITY ══
--
-- `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` throughout,
-- with every constraint declared inside the CREATE rather than by a later
-- ALTER, so a second application is a no-op with no `DROP CONSTRAINT IF
-- EXISTS` dance. Migrations here are applied by hand and `scripts/db-migrate.mjs`
-- stops at the first file that throws — after which every LATER migration
-- silently stops being applied (tesserix-home#509, and the reason
-- `migration-idempotency.integration.test.ts` exists).
--
-- ══ APPLY THIS BEFORE MERGING ══
--
-- Kargo deploys the console on merge; `db:migrate` does not ride along. Apply
-- 0050 to production BEFORE the PR carrying it merges, or the deployed console
-- queries tables that do not exist. Note what the console does when they are
-- missing: it FAILS OPEN and forwards the attempt, so the symptom of a
-- forgotten migration is not a broken login — it is a control that quietly
-- is not there. See `login-throttle.ts` for why that direction was chosen and
-- what makes it noisy enough to notice.

-- ══════════════════════════════════════════════════════════════════════════
-- login_pending_identity
--
-- The server's own record of which login name a half-finished login belongs
-- to, written after the password check passes.
--
-- THIS TABLE IS THE SECURITY CONTROL, not an optimisation. The obvious place
-- to find the login name at the code step is the `tx_login_pending` cookie the
-- password step already sets — and that would be a hole, not a shortcut. That
-- cookie is `httpOnly` but plain unsigned JSON, and `httpOnly` stops the
-- page's own JavaScript, not a person with curl. A login name taken from it
-- would be a login name the CLIENT chose, so an attacker could name any
-- operator they liked and spend that operator's five attempts WITHOUT EVER
-- HOLDING THEIR PASSWORD: a brand new denial of service, in the shape of a fix
-- for one.
--
-- Writing the mapping here instead means the value read at the code step is
-- one the client never supplied, and one that could only have been written by
-- somebody who passed that login name's password check.
--
-- ── AND THE AUTH REQUEST ID ALONE IS NOT ENOUGH TO LOOK IT UP ──
--
-- The auth request id IS carried by the client, so a lookup keyed on it alone
-- leaves one residue of the same attack: someone who learned a victim's
-- in-flight auth request id could present it, fail five codes against their
-- OWN Zitadel session, and have those failures counted against the victim —
-- putting the victim into a cooldown they did not earn. Far weaker than the
-- Zitadel lockout (it is 15 minutes and self-healing, not a state an admin has
-- to clear), and it needs an unguessable id inside a five-minute window, but
-- it is the very property this table exists to provide and it should hold
-- outright rather than nearly.
--
-- So `session_id` is stored alongside, and the read matches on BOTH. The
-- session id lives in the same cookie, but it is not free to choose: it is the
-- id of a Zitadel session the attacker would have to actually hold, because
-- the code they are spending is added to THAT session. Counting against
-- somebody else now requires holding that person's live half-authenticated
-- session — at which point the cooldown is not what is in danger.
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS login_pending_identity (
    -- Zitadel's auth request id, which is what the browser carries between the
    -- two steps and the only handle both steps share. PRIMARY KEY because one
    -- auth request is in the middle of exactly one login: re-submitting the
    -- password for the same request REPLACES this row rather than adding a
    -- second, and a surrogate id would make that upsert impossible to express.
    auth_request_id text PRIMARY KEY,

    -- Hex-encoded HMAC-SHA256 of the canonicalised login name. `text` and not
    -- `bytea` for 0041's reason: it is only ever compared for equality against
    -- another hex string the application produced, and text keeps it readable
    -- in a psql session without changing what it is. There is nothing to
    -- decode — it is a digest, not ciphertext.
    login_name_hash text NOT NULL,

    -- The Zitadel session the password step created for this login. Half of
    -- the lookup key, for the reason above. NOT hashed, and not a secret: it
    -- is an opaque id, the session TOKEN that accompanies it in the cookie is
    -- the credential, and that token is deliberately not stored here — this
    -- table must not become somewhere a database dump yields a live session.
    session_id text NOT NULL,

    -- Written once, at the password step. Read to age the row out: a mapping
    -- older than the pending cookie it accompanies can no longer belong to a
    -- live login, and serving it would key a limiter off a login that ended.
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Pruning is by `created_at` across ALL rows — `deleteExpiredLoginIdentities`
-- in `login-throttle.ts` runs it opportunistically on each write, because
-- nothing in this estate schedules a vacuum job and a table that only ever
-- grows is a table someone finds at 40 million rows. The PK cannot serve that
-- scan, so this index exists for it. It is the only extra index here: every
-- other access is a point lookup on the primary key.
CREATE INDEX IF NOT EXISTS login_pending_identity_created_at_idx
    ON login_pending_identity (created_at);

-- ══════════════════════════════════════════════════════════════════════════
-- login_totp_failures
--
-- One row per code that was actually sent to Zitadel and rejected by it.
--
-- APPEND-ONLY, AND WITHOUT A COOLDOWN-EXPIRY COLUMN. The cooldown is not
-- stored; it is derived. "Declined" means `count(failures within the window)
-- >= threshold`, so the cooldown ends by itself as the oldest of those
-- failures ages out of the window, and NOTHING EVER HAS TO BE UNLOCKED. A
-- stored `cooldown_until` would be a second representation of the same fact,
-- able to disagree with the rows it was computed from — and, worse, a state
-- that persists after the failures justifying it are gone, which is the shape
-- of the lockout this change exists to avoid.
--
-- A declined attempt writes NOTHING here. It was never sent, so there is no
-- rejection to record — and recording one would let an attacker extend their
-- own victim's cooldown indefinitely by continuing to hammer a door that is
-- already closed.
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS login_totp_failures (
    -- The same keyed hash as above, of the same canonical form. It is NOT a
    -- foreign key to `login_pending_identity`: that mapping is deleted minutes
    -- after the login it described, while a failure has to outlive it — an
    -- attacker who is refused simply starts a fresh auth request, and a count
    -- that died with the old one would reset on every retry and bound nothing.
    login_name_hash text NOT NULL,

    failed_at timestamptz NOT NULL DEFAULT now()
);

-- The one read this table serves: the most recent N failures for one hash
-- inside a window. `(login_name_hash, failed_at DESC)` answers it from the
-- index alone, and also serves the per-hash prune that follows every insert.
--
-- No primary key and no surrogate id. There is nothing to identify a failure
-- by — two wrong codes a second apart are genuinely two indistinguishable
-- facts, and both must count. A `PRIMARY KEY (login_name_hash, failed_at)`
-- would additionally make two failures inside the same microsecond collide
-- and silently drop one, which is precisely the direction an attacker wants.
CREATE INDEX IF NOT EXISTS login_totp_failures_hash_failed_at_idx
    ON login_totp_failures (login_name_hash, failed_at DESC);
