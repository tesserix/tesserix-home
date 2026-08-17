-- 0023_crm_contacts_instagram_unique.sql
--
-- Issue #215. Migration 0019 gave `crm_contacts` a UNIQUE index on
-- `lower(email)` (:98-99) but only a PLAIN index on
-- `lower(instagram_handle)` (:100-102). Two comments in
-- apps/console/lib/db/crm-repo.ts, and the CSV import that leans on them,
-- were written believing both were unique. This migration makes that
-- belief true rather than documenting its absence, matching the shape
-- `crm_suppressions` already uses for the same pair of keys (0019:185-188).
--
-- WHAT THE GAP ACTUALLY COSTS. The email path is backstopped by a real
-- unique index, so a second contact claiming an existing email fails its
-- INSERT, loudly, every time. The handle path had no backstop at all — only
-- the CSV import's own in-process `seenKeys` set, which is scoped to one
-- preview/commit. Two interleaved imports, or an import racing the leads
-- backfill, could therefore land two contacts sharing one canonical handle,
-- after which `findMatchingOrganisationId` (crm-repo.ts) resolves it with
-- LIMIT 1 and returns whichever row the plan happened to emit first: an
-- arbitrary, unrepeatable answer to a question that has exactly one right
-- one, with nothing reported to anyone. That is the quiet version of the
-- failure the whole dedup exists to prevent — not a duplicate that errors,
-- but a duplicate that silently picks. `crm_contacts` is what
-- `findMatchingOrganisationId` keys the CRM's Instagram-led prospecting on,
-- so the unprotected field was the load-bearing one.
--
-- DEPLOY ORDER. 0023 sits after 0021/0022 and therefore after
-- scripts/migrate-leads-to-crm.mjs --commit, for the same reason 0022 does:
-- `pnpm db:migrate` applies every pending migration in one run
-- (db-migrate.mjs:115-136), so on a database where 0020/0021 are still
-- pending, 0021's own guard blocks long before this file is reached. An
-- operator who hits that guard should run the backfill, not skip ahead.
--
-- TIMING IS IN OUR FAVOUR, AND WE DO NOT RELY ON IT. `crm_contacts` is
-- empty today — the leads backfill has not been run — so adding a unique
-- index cannot fail on existing data. But "cannot fail today" is not the
-- property this migration claims; it claims to hold the invariant for every
-- row, including on a database restored from somewhere we did not watch. So
-- the collision check below runs first, exactly as 0022's does.
--
-- IF THE GUARD FIRES ANYWAY. Because of the deploy order above,
-- `crm_contacts` is non-empty here only if the backfill already ran — and
-- migrate-leads-to-crm.mjs's own pre-flight (`findContactKeyCollisions`,
-- migrate-leads-to-crm.mjs:261-333) refuses to write a single row when two
-- leads, or a lead and an existing contact, normalise to one handle. So a
-- collision at 0023 means one of: the backfill was bypassed, rows arrived
-- through a path neither the script nor the console import owns (a manual
-- INSERT), or two CSV imports interleaved. The operator's move is the same
-- one 0022 and the script both prescribe: read the named rows, decide by
-- hand which contact is authoritative, remove or re-key the other with a
-- deliberate, logged action, then re-run `pnpm db:migrate`. Do NOT reach
-- for a dedupe query.
--
-- NOT AUTO-RESOLVED, ON PURPOSE. Ruling 21 settled this for 0022's
-- backfill and the migration script's pre-flight repeats it: a migration
-- that silently drops or fuses contact records destroys history that cannot
-- be reconstructed, and fusing two contacts fuses two businesses' identities
-- — the same thing migrate-leads-to-crm.mjs refuses to do when it declines
-- to infer shared organisations. Refusing and naming the rows is worse for
-- the operator's afternoon and better for everything else.

-- The guard detects EXACTLY what the index below rejects — rows whose
-- `lower(instagram_handle)` is shared — so the two can never disagree about
-- what a collision is. Note this is deliberately a NARROWER rule than
-- `normalizeInstagramHandle`'s (which also strips leading `@`s): the index
-- can only enforce what it is expressed over, and checking a stricter rule
-- here would refuse rows the index would go on to accept. The script's
-- pre-flight is the stricter of the two and refuses a superset of these
-- groups; see the note at the foot of this file.
DO $$
DECLARE
  colliding text;
BEGIN
  SELECT string_agg(
           format('{%s} all share lower(instagram_handle) = %L',
                  array_to_string(dup.rows, ', '), dup.norm),
           '; '
         )
    INTO colliding
    FROM (
      SELECT lower(instagram_handle) AS norm,
             array_agg(format('contact %s (%L)', id, instagram_handle)
                       ORDER BY id) AS rows
        FROM crm_contacts
       WHERE instagram_handle IS NOT NULL
       GROUP BY lower(instagram_handle)
      HAVING count(*) > 1
    ) dup;

  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION
      '0023 refuses to add crm_contacts_instagram_lower_uq — these contacts already share one canonical Instagram handle, and this migration will never delete or merge a contact to resolve that automatically: %. Decide by hand which row is authoritative, remove or re-key the other with a deliberate, logged action, then re-run this migration.',
      colliding;
  END IF;
END $$;
-- The DO block runs in this migration's one transaction; RAISE EXCEPTION
-- aborts it without recording 0023 in schema_migrations (db-migrate.mjs's
-- per-file try/catch), so nothing is left half-applied and the next
-- `db:migrate` after a human resolves the collision retries this file
-- cleanly from the top.

-- Partial, matching `crm_suppressions_ig_uq` (0019:187-188) and 0019's own
-- plain handle index: a NULL handle is "we don't have one", not a value, and
-- many contacts legitimately have none. (Postgres would not collapse NULLs
-- under a unique index anyway; the WHERE clause keeps the index off the rows
-- it can never constrain.) Replaces 0019's plain
-- `crm_contacts_instagram_idx` rather than sitting beside it — a unique
-- index serves every lookup the plain one did, and keeping both would pay
-- for two B-trees on every write to buy nothing.
CREATE UNIQUE INDEX crm_contacts_instagram_lower_uq
  ON crm_contacts (lower(instagram_handle)) WHERE instagram_handle IS NOT NULL;
DROP INDEX crm_contacts_instagram_idx;

-- WHAT THIS DOES NOT FIX. `crm_suppressions` got a normalising trigger in
-- 0022; `crm_contacts` did not, and this migration does not add one. Both
-- of today's writers normalise before insert — the console's CSV import
-- (crm-repo.ts:1250-1257) and migrate-leads-to-crm.mjs (:183-189) both call
-- their `normalizeInstagramHandle`, which strips leading `@`s and
-- lowercases — so within the application the index and the stored values
-- agree. But a unique index on `lower()` alone cannot enforce the `@`
-- strip: a hand-written `INSERT ... '@bondibaker'` still coexists happily
-- with a stored `bondibaker`, because `lower('@bondibaker')` is
-- `@bondibaker`. That is precisely the failure 0022 wrote a trigger to
-- close for the suppression list. It is not closed here, and this migration
-- should not be read as closing it. The narrower claim it does make: the
-- normalised-handle duplicates the CSV import's `seenKeys` set was the only
-- thing standing between us and are now impossible, which is what #215
-- asked for.
