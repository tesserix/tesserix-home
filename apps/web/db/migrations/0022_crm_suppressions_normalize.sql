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
-- code. `normalizeInstagramHandle` in crm-repo.ts stays as defence-in-depth
-- (belt and braces is right for a suppression list), but the trigger below
-- is what makes the invariant true regardless of which door a row came
-- through.

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
-- the table — there should be none yet, since Task 7 is what first wrote to
-- this table, but a from-scratch guarantee is cheap and this migration must
-- hold the invariant for every row, not just the ones written after it
-- applies — is normalised in place. A bare UPDATE re-runs the trigger via
-- `BEFORE ... UPDATE`, so this is the same normalisation the trigger itself
-- applies, not a second implementation of it.
UPDATE crm_suppressions SET email = email WHERE email IS NOT NULL;
UPDATE crm_suppressions SET instagram_handle = instagram_handle WHERE instagram_handle IS NOT NULL;
