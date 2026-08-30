-- Hand 0038's two tables to the role the console actually connects as.
--
-- # The bug, and why nothing caught it
--
-- Every migration in this directory relies on an IMPLICIT contract: whoever
-- runs it becomes the owner of what it creates, and the runner
-- (`apps/web/scripts/db-migrate.mjs`) connects as `TESSERIX_DB_USER` — the
-- same role the console connects as. Ownership is therefore never stated,
-- because it never had to be. Nothing in 0001-0038 contains an `OWNER TO` or
-- a `GRANT`.
--
-- In production that contract was broken exactly once. `0038_publish_
-- operations.sql` was applied as `postgres` rather than as the console's
-- role, so on 2026-08-30 production looked like this:
--
--   plan_catalog_amounts            owner tesserix_admin
--   plan_catalog_parity_runs        owner tesserix_admin
--   plan_catalog_prices             owner tesserix_admin
--   plan_catalog_publications       owner tesserix_admin
--   plan_catalog_revisions          owner tesserix_admin
--   plan_catalog_publish_attempts   owner postgres     <-- 0038
--   plan_catalog_publish_operations owner postgres     <-- 0038
--
-- with ZERO grants of any kind on the last two. The console could neither
-- read nor write them: `SELECT` returned `permission denied for table
-- plan_catalog_publish_operations`.
--
-- No test could have caught this. Unit and integration suites run against
-- pglite as a single all-powerful role, and a developer's local migration run
-- uses the correct user, so ownership is right everywhere except the one
-- place it matters. It is a property of how a migration was APPLIED, not of
-- anything in the repository — which is why it survived a green branch, a
-- green CI run, and a clean deploy.
--
-- # What it actually broke
--
-- Both halves of the publish feature, silently:
--
--   - The WRITE path. `startPublishAttempt`, `recordOperation` and
--     `completeOperation` (`apps/console/lib/db/publish-repo.ts`) all write
--     these tables, so a publish from the console fails at its first write.
--     No console publish has ever succeeded in production since 0038 landed.
--     This is the blocker under tesserix-home#327's "first live publish as a
--     dry-run diff", and it is independent of the Stripe write key.
--   - The READ path (tesserix-home#410). `latestPublishAttempt`,
--     `operationsForAttempt` and — through `archivedStripePriceIds` —
--     `findOrphans` all fail. The orphan check therefore fails at POSTGRES,
--     before Stripe is ever contacted, so it reports the generic read-failure
--     copy rather than the Stripe-credential copy. Retrying does not help.
--
-- The catalog table and the observation window keep rendering throughout,
-- because `page.tsx` narrows each read independently — that constraint is
-- what kept this from being a blank page, and the surface says the read
-- failed instead of showing a falsely clean one.
--
-- # Owner, not GRANT
--
-- A `GRANT SELECT, INSERT, UPDATE` would fix today's symptom and leave these
-- two tables permanently unlike their five siblings — a difference the next
-- migration to touch them (adding a column, an index, a constraint) would
-- discover the hard way, because those all require OWNERSHIP and no grant
-- confers it. Matching the siblings is the fix; anything less re-creates the
-- same class of surprise later.
--
-- # This migration must be run by a superuser
--
-- `ALTER TABLE ... OWNER TO` requires membership of both the current and the
-- target role, so `tesserix_admin` cannot reassign these to itself — the
-- normal runner CANNOT apply this in production. Apply it as `postgres` (or
-- another superuser), once:
--
--   TESSERIX_DB_USER=postgres TESSERIX_DB_PASSWORD=... \
--     node apps/web/scripts/db-migrate.mjs
--
-- ...or by hand with the two `ALTER TABLE` statements the block below issues.
-- Per this estate's rule that migrations are manual while deploys are not,
-- apply it to production BEFORE merging the PR that carries it.
--
-- # Idempotent, and self-consistent rather than hardcoded
--
-- The target owner is READ FROM a sibling table rather than written here as a
-- literal. `tesserix_admin` is the role today, but this file has no business
-- asserting that: if the console's role is ever renamed, a hardcoded name
-- would hand these two tables to a role that no longer connects, which is the
-- present bug with different names. Deriving it from `plan_catalog_amounts`
-- means "own these the way the rest of the plan catalog is owned", which is
-- the actual intent.
--
-- Where ownership is already correct — every developer machine, CI, and
-- production once this has run — the block is a no-op and re-running it is
-- safe.

DO $$
DECLARE
    target_owner  name;
    current_owner name;
    tbl           name;
BEGIN
    SELECT tableowner INTO target_owner
      FROM pg_tables
     WHERE schemaname = current_schema()
       AND tablename  = 'plan_catalog_amounts';

    -- 0032 creates `plan_catalog_amounts`, and the runner applies migrations
    -- in order, so its absence means this is being run against a database
    -- that never got the plan catalog at all. Refuse rather than invent an
    -- owner: guessing here would hand two tables to whoever happens to be
    -- connected.
    IF target_owner IS NULL THEN
        RAISE EXCEPTION
            '0039: plan_catalog_amounts not found in schema %, so the intended owner cannot be derived; apply 0032-0038 first',
            current_schema();
    END IF;

    FOREACH tbl IN ARRAY ARRAY['plan_catalog_publish_attempts',
                               'plan_catalog_publish_operations']
    LOOP
        SELECT tableowner INTO current_owner
          FROM pg_tables
         WHERE schemaname = current_schema()
           AND tablename  = tbl;

        IF current_owner IS NULL THEN
            RAISE EXCEPTION '0039: table % not found; apply 0038 first', tbl;

        ELSIF current_owner = target_owner THEN
            RAISE NOTICE '0039: % is already owned by %; nothing to do', tbl, target_owner;

        ELSE
            -- `format`/`%I` rather than string concatenation: these names are
            -- literals above, but an identifier built by concatenation is a
            -- habit that stops being safe the moment one is not.
            EXECUTE format('ALTER TABLE %I OWNER TO %I', tbl, target_owner);
            RAISE NOTICE '0039: reassigned % from % to %', tbl, current_owner, target_owner;
        END IF;
    END LOOP;
END
$$;
