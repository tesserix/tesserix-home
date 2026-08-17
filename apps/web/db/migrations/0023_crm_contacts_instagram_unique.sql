-- 0023_crm_contacts_instagram_unique.sql
--
-- Issue #215. Two halves of one gap, both closed here.
--
-- HALF ONE — the missing unique index. Migration 0019 gave `crm_contacts` a
-- UNIQUE index on `lower(email)` (:98-99) but only a PLAIN index on
-- `lower(instagram_handle)` (:100-102). Two comments in
-- apps/console/lib/db/crm-repo.ts, and the CSV import that leans on them,
-- were written believing both were unique. The email path is therefore
-- backstopped by a real constraint — a second contact claiming an existing
-- email fails its INSERT, loudly, every time — while the handle path had no
-- backstop at all, only the import's own in-process `seenKeys` set, scoped
-- to one preview/commit. Two interleaved imports, or an import racing the
-- leads backfill, could land two contacts sharing one canonical handle,
-- after which `findMatchingOrganisationId` resolves it with LIMIT 1 and
-- returns whichever row the plan emitted first: an arbitrary, unrepeatable
-- answer to a question with exactly one right one, and nothing reported to
-- anyone. The quiet version of the failure the whole dedup exists to
-- prevent — not a duplicate that errors, but a duplicate that silently
-- picks. Handles are the field the CRM's Instagram-led prospecting depends
-- on most, so the unprotected one was the load-bearing one.
--
-- HALF TWO — the missing normalisation, and why the index alone is not
-- enough. A unique index can only enforce what it is expressed over, and
-- `lower('@bondibaker')` is `@bondibaker`, not `bondibaker`. So a
-- `lower()`-only index still lets `'@bondibaker'` and `'bondibaker'`
-- coexist as two contacts for one person — a PARTIAL backstop, which is
-- what #215 is actually complaining about. This is Ruling 19 unchanged:
-- normalising at the application boundary is sound only if the application
-- is the only door, and it is not. `normalizeInstagramHandle` lives in
-- crm-repo.ts; scripts/migrate-leads-to-crm.mjs carries its own copy; a DBA
-- running a manual INSERT and any future writer have neither. 0022 settled
-- this for `crm_suppressions` with a BEFORE INSERT OR UPDATE trigger;
-- `crm_contacts` never got one. It gets one below, deliberately identical
-- in behaviour, so the two tables cannot drift on the same two fields.
--
-- Together these make the index total rather than partial: the stored form
-- is normalised before the index ever sees it, so `lower()` over an
-- already-normalised column IS the canonical form. That is also what makes
-- the database and scripts/migrate-leads-to-crm.mjs's pre-flight
-- (`findContactKeyCollisions`, :261-333) agree EXACTLY rather than
-- approximately — before this migration the pre-flight refused a strict
-- superset of what the index would reject, which was the right way round
-- but still two different rules.
--
-- DEPLOY ORDER. 0023 sits after 0021/0022 and therefore after
-- scripts/migrate-leads-to-crm.mjs --commit, for the same reason 0022 does:
-- `pnpm db:migrate` applies every pending migration in one run
-- (db-migrate.mjs:115-136) and aborts the whole run on the first failure, so
-- on a database where 0020/0021 are still pending, 0021's own guard blocks
-- long before this file is reached. An operator who hits that guard should
-- run the backfill, not skip ahead.
--
-- TIMING IS IN OUR FAVOUR, AND WE DO NOT RELY ON IT. `crm_contacts` is
-- empty today — the leads backfill has not been run — so neither the unique
-- index nor the normalising backfill can fail on existing data. That is
-- exactly why both land now: this is the last moment either is free. But
-- "cannot fail today" is not the property this migration claims; it claims
-- to hold the invariant for EVERY row, including on a database restored
-- from somewhere we did not watch. So the collision check below runs first,
-- exactly as 0022's does.
--
-- IF THE GUARD FIRES ANYWAY. Because of the deploy order above,
-- `crm_contacts` is non-empty here only if the backfill already ran — and
-- the script's own pre-flight refuses to write a single row when two leads,
-- or a lead and an existing contact, normalise to one key. So a collision
-- at 0023 means one of: the backfill was bypassed, rows arrived through a
-- path neither the script nor the console import owns (a manual INSERT), or
-- two CSV imports interleaved. The operator's move is the same one 0022 and
-- the script both prescribe: read the named rows, decide by hand which
-- contact is authoritative, remove or re-key the other with a deliberate,
-- logged action, then re-run `pnpm db:migrate`. Do NOT reach for a dedupe
-- query.
--
-- NOT AUTO-RESOLVED, ON PURPOSE. Ruling 21 settled this for 0022's backfill
-- and the migration script's pre-flight repeats it: a migration that
-- silently drops or fuses contact records destroys history that cannot be
-- reconstructed, and fusing two contacts fuses two businesses' identities —
-- the same thing migrate-leads-to-crm.mjs refuses to do when it declines to
-- infer shared organisations. A trigger that rewrites `@Bob` to `bob` on
-- its way in is a different act entirely: it changes the spelling of one
-- row's key to the form every reader already assumes, and loses nothing.
-- Rewriting silently is fine; merging silently is not.

-- =======================================================================
-- GUARD. Runs before the trigger, the backfill and the index — all three
-- of which it protects. It must precede the BACKFILL specifically because
-- normalisation itself can CREATE a collision that does not exist in the
-- stored data: `'@bondibaker'` and `'bondibaker'` are two distinct values
-- to `lower()` today and one value afterwards. Left to the backfill's own
-- UPDATE, that surfaces as a generic Postgres constraint violation naming
-- no row an operator could act on — or, worse, as a silent success if the
-- index is not there yet.
--
-- Grouped by the NORMALISED form (trim, strip leading `@`s, lowercase),
-- not by `lower()`, because the normalised form is what the column will
-- hold once this migration finishes and therefore what the index will
-- actually constrain. Same rule as `findContactKeyCollisions`.
-- =======================================================================
DO $$
DECLARE
  colliding text;
BEGIN
  SELECT string_agg(
           format('{%s} all normalise to %L', array_to_string(dup.rows, ', '), dup.norm),
           '; '
         )
    INTO colliding
    FROM (
      SELECT lower(trim(email)) AS norm,
             array_agg(format('contact %s (%L)', id, email) ORDER BY id) AS rows
        FROM crm_contacts
       WHERE email IS NOT NULL
       GROUP BY lower(trim(email))
      HAVING count(*) > 1
    ) dup;

  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION
      '0023 refuses to normalise crm_contacts.email — these contacts would collide once normalised, and this migration will never delete or merge a contact to resolve that automatically: %. Decide by hand which row is authoritative, remove or re-key the other with a deliberate, logged action, then re-run this migration.',
      colliding;
  END IF;
END $$;

DO $$
DECLARE
  colliding text;
BEGIN
  SELECT string_agg(
           format('{%s} all normalise to %L', array_to_string(dup.rows, ', '), dup.norm),
           '; '
         )
    INTO colliding
    FROM (
      SELECT lower(regexp_replace(trim(instagram_handle), '^@+', '')) AS norm,
             array_agg(format('contact %s (%L)', id, instagram_handle) ORDER BY id) AS rows
        FROM crm_contacts
       WHERE instagram_handle IS NOT NULL
       GROUP BY lower(regexp_replace(trim(instagram_handle), '^@+', ''))
      HAVING count(*) > 1
    ) dup;

  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION
      '0023 refuses to add crm_contacts_instagram_lower_uq — these contacts already share one canonical Instagram handle, and this migration will never delete or merge a contact to resolve that automatically: %. Decide by hand which row is authoritative, remove or re-key the other with a deliberate, logged action, then re-run this migration.',
      colliding;
  END IF;
END $$;
-- Each DO block runs in this migration's one transaction; a RAISE EXCEPTION
-- aborts it without recording 0023 in schema_migrations (db-migrate.mjs's
-- per-file try/catch), so nothing is left half-applied and the next
-- `db:migrate` after a human resolves the collision retries this file
-- cleanly from the top.

-- =======================================================================
-- THE TRIGGER. Byte-identical in behaviour to
-- `crm_suppressions_normalize()` (0022), to `normalizeInstagramHandle` in
-- apps/console/lib/db/crm-repo.ts, and to its twin in
-- scripts/migrate-leads-to-crm.mjs — all four now compute the same
-- canonical form, in the same order: trim, then strip EVERY leading `@`
-- (`^@+`, so `@@bob` normalises to `bob`, not `@bob`), then lowercase.
-- Email gets trim + lowercase, matching 0022 and the table's own
-- `crm_contacts_email_lower_uq`, so the two tables do not diverge on the
-- one field they share.
--
-- A separate function rather than reusing `crm_suppressions_normalize()`:
-- that one is named for its table and a shared function would make either
-- table's future divergence silently rewrite the other's rows.
-- =======================================================================
CREATE OR REPLACE FUNCTION crm_contacts_normalize() RETURNS trigger AS $$
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

CREATE TRIGGER crm_contacts_normalize_trg
  BEFORE INSERT OR UPDATE ON crm_contacts
  FOR EACH ROW EXECUTE FUNCTION crm_contacts_normalize();

-- Backfill: the trigger only fires on future writes, so any row already in
-- the table — there should be none today, but a from-scratch guarantee is
-- cheap and this migration must hold the invariant for every row, not just
-- the ones written after it applies — is normalised in place. The guard
-- above has already run and passed, so this UPDATE cannot itself produce a
-- duplicate. A bare `SET col = col` still re-runs the trigger via
-- `BEFORE ... UPDATE`, so this is the same normalisation the trigger
-- applies, not a second implementation of it.
UPDATE crm_contacts SET email = email WHERE email IS NOT NULL;
UPDATE crm_contacts SET instagram_handle = instagram_handle WHERE instagram_handle IS NOT NULL;

-- =======================================================================
-- THE INDEX. Created last, over data the trigger and backfill have already
-- normalised, so `lower(instagram_handle)` over this column is the full
-- canonical form and not an approximation of it.
--
-- Partial, matching `crm_suppressions_ig_uq` (0019:187-188) and 0019's own
-- plain handle index: a NULL handle is "we don't have one", not a value,
-- and many contacts legitimately have none. (Postgres would not collapse
-- NULLs under a unique index anyway; the WHERE clause keeps the index off
-- the rows it can never constrain.)
--
-- Replaces 0019's plain `crm_contacts_instagram_idx` rather than sitting
-- beside it — identical expression and predicate, so a unique index serves
-- every lookup the plain one did, and keeping both would pay for two
-- B-trees on every write to buy nothing.
-- =======================================================================
CREATE UNIQUE INDEX crm_contacts_instagram_lower_uq
  ON crm_contacts (lower(instagram_handle)) WHERE instagram_handle IS NOT NULL;
DROP INDEX crm_contacts_instagram_idx;
