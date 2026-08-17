-- 0022_crm_suppressions_normalize.sql
--
-- Ruling 19. The console's `isSuppressed`/`addSuppression`
-- (apps/console/lib/db/crm-repo.ts) normalise email (lowercase) and
-- Instagram handle (strip a leading `@`, lowercase) at the application
-- boundary before they ever reach SQL. That is sound only if the
-- application is the only door into this table — and it is not. A
-- migration backfill, Task 8's bulk import, and a DBA running a manual
-- INSERT are all paths that bypass `addSuppression` entirely.
--
-- Concretely, without this migration: inserting '@HandRolled' directly
-- produces a row `isSuppressed({ instagramHandle: "@HandRolled" })` cannot
-- find (the lookup normalises to `handrolled`; `lower('@HandRolled')` is
-- `@handrolled`, which never matches), and a subsequent
-- `addSuppression({ instagramHandle: "handrolled" })` then SUCCEEDS, because
-- `crm_suppressions_ig_uq` (on `lower(instagram_handle)`) does not see
-- `@handrolled` and `handrolled` as colliding. Two rows for one person, one
-- of which can never be matched — the do-not-contact list failing open on
-- exactly the person it exists to protect.
--
-- The fix: hold the normal form in the schema, not only in application
-- code. `normalizeInstagramHandle`/the email trim+lowercase in crm-repo.ts
-- stay as defence-in-depth (belt and braces is right for a suppression
-- list), but the trigger below is what makes the invariant true regardless
-- of which door a row came through.
--
-- REQUIRED DEPLOY ORDER (Ruling 22): 0020 -> migrate-leads-to-crm.mjs
-- --commit -> 0021 -> 0022. `pnpm db:migrate` / db-migrate.mjs applies every
-- pending migration in one run and aborts the whole run on the first
-- failure (db-migrate.mjs:115-136, the same structural guard 0021's header
-- documents) — so on a database where 0020 and 0021 are both still pending,
-- 0021's own guard (`0021 requires scripts/migrate-leads-to-crm.mjs --commit
-- to run first`) blocks before 0022 is ever reached. This is not an
-- accident worth engineering around: the leads backfill is what makes the
-- CRM usable at all, migration 0019 created crm_suppressions as part of
-- that same CRM schema, and 0022 building on top of it is the same feature
-- landing in the order it was built. An operator who hits 0021's guard
-- while trying to apply 0022 should run the backfill, not look for a way to
-- skip ahead.

-- Ruling 21: a backfill must never resolve a collision on its own by
-- dropping or merging a row — that is the one thing a do-not-contact
-- migration must not do (removal is the consequential direction; see
-- crm-repo.ts's module comment), and silently dropping a suppression during
-- a schema migration is exactly how someone ends up contacted again. So,
-- before any row is touched, detect any two rows that would collide once
-- normalised and abort loudly, naming them by their current (un-normalised)
-- values — not by letting the backfill's own UPDATE below hit
-- crm_suppressions_email_uq/_ig_uq and surface a generic Postgres
-- constraint-violation that names no row at all. The table should be empty
-- today (migration 0019 created it; this task, #153, is its first writer),
-- so this is latent, not yet exercised — but the migration's stated goal is
-- to hold the invariant for EVERY row, and an untested collision path would
-- fail at exactly that the first time it mattered.
DO $$
DECLARE
  colliding text;
BEGIN
  SELECT string_agg(
           format('{%s} all normalise to %L', array_to_string(dup.emails, ', '), dup.norm),
           '; '
         )
    INTO colliding
    FROM (
      SELECT lower(trim(email)) AS norm, array_agg(DISTINCT email ORDER BY email) AS emails
        FROM crm_suppressions
       WHERE email IS NOT NULL
       GROUP BY lower(trim(email))
      HAVING count(DISTINCT email) > 1
    ) dup;

  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION
      '0022 refuses to normalise crm_suppressions.email — these rows would collide once normalised, and this migration will never drop or merge a suppression to resolve that automatically: %. Resolve the duplicate(s) manually (decide which row is authoritative, remove the other by hand with a deliberate, logged action), then re-run this migration.',
      colliding;
  END IF;
END $$;

DO $$
DECLARE
  colliding text;
BEGIN
  SELECT string_agg(
           format('{%s} all normalise to %L', array_to_string(dup.handles, ', '), dup.norm),
           '; '
         )
    INTO colliding
    FROM (
      SELECT lower(regexp_replace(trim(instagram_handle), '^@+', '')) AS norm,
             array_agg(DISTINCT instagram_handle ORDER BY instagram_handle) AS handles
        FROM crm_suppressions
       WHERE instagram_handle IS NOT NULL
       GROUP BY lower(regexp_replace(trim(instagram_handle), '^@+', ''))
      HAVING count(DISTINCT instagram_handle) > 1
    ) dup;

  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION
      '0022 refuses to normalise crm_suppressions.instagram_handle — these rows would collide once normalised, and this migration will never drop or merge a suppression to resolve that automatically: %. Resolve the duplicate(s) manually (decide which row is authoritative, remove the other by hand with a deliberate, logged action), then re-run this migration.',
      colliding;
  END IF;
END $$;
-- Each DO block above runs in this migration's one transaction; a
-- RAISE EXCEPTION aborts that transaction without recording 0022 in
-- schema_migrations (db-migrate.mjs's try/catch around each file, same
-- convergence property 0021 relies on) — so nothing here is left
-- half-applied, and the next `db:migrate` run after a human resolves the
-- collision retries this file cleanly from the top.

-- The normalisation function. `email` gets trim + lowercase (mirrors the
-- application's `.trim()` boundary fix and the table's own
-- `lower(email)` unique index); `instagram_handle` gets the same plus a
-- stripped leading `@`, matching `normalizeInstagramHandle` exactly so the
-- application and the database can never compute two different "canonical"
-- forms for the same input.
CREATE OR REPLACE FUNCTION crm_suppressions_normalize() RETURNS trigger AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    NEW.email := lower(trim(NEW.email));
  END IF;
  IF NEW.instagram_handle IS NOT NULL THEN
    NEW.instagram_handle := lower(regexp_replace(trim(NEW.instagram_handle), '^@+', ''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crm_suppressions_normalize_trg
  BEFORE INSERT OR UPDATE ON crm_suppressions
  FOR EACH ROW EXECUTE FUNCTION crm_suppressions_normalize();

-- Backfill: the trigger only fires on future writes, so any row already in
-- the table — there should be none yet (see above), but a from-scratch
-- guarantee is cheap and this migration must hold the invariant for every
-- row, not just the ones written after it applies — is normalised in
-- place. The collision check above has already run and passed by the time
-- this executes, so this UPDATE cannot itself hit
-- crm_suppressions_email_uq/_ig_uq. A bare `SET col = col` still re-runs
-- the trigger via `BEFORE ... UPDATE`, so this is the same normalisation
-- the trigger itself applies, not a second implementation of it.
UPDATE crm_suppressions SET email = email WHERE email IS NOT NULL;
UPDATE crm_suppressions SET instagram_handle = instagram_handle WHERE instagram_handle IS NOT NULL;
