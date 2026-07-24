-- 0008 — Leads data sanitization (post-0007 cleanup).
--
-- One-shot fixes for data-quality issues found after the Instagram
-- seller import landed structured fields. None of these are schema
-- changes — every fix could in principle be a one-off psql RUN, but
-- running them through the migration runner means:
--   1. The audit trail in schema_migrations records when sanitization
--      happened, which matters when a future export gets re-imported
--      and produces "different" data than expected.
--   2. We can re-bootstrap a dev DB from migrations alone and still
--      get the same clean state.
--
-- The matching importer change (scripts/import-instagram-leads.mjs)
-- prevents future imports from re-introducing the patterns this
-- migration cleans up, so 0008 should be effectively a no-op on a
-- fresh import.

-- ─── Locations ─────────────────────────────────────────────────────────
-- "India (unspecified)" is a placeholder the original scraper used
-- when location couldn't be inferred. Empty is more honest than that.
UPDATE leads
   SET location = NULL
 WHERE location ILIKE 'India (unspecified)';

-- Drop the redundant ", India" suffix — every lead in the seed cohort
-- is India-based and the country isn't a useful filter at this scale.
-- "Bangalore, India" → "Bangalore", "Ahmedabad, India" → "Ahmedabad", etc.
UPDATE leads
   SET location = trim(regexp_replace(location, ',?\s*India\s*$', '', 'i'))
 WHERE location ~* ', India\s*$';

-- One-off name normalization noticed in the audit.
UPDATE leads
   SET location = 'Indore'
 WHERE location = 'Indore City';

-- ─── Identity columns ──────────────────────────────────────────────────
-- The original importer fell back to instagram_handle when csv.name
-- was empty — produced rows where name = handle, which the UI then
-- displays twice (once as the contact, once as the name). Drop the
-- fallback so the UI's @handle display does the work.
UPDATE leads
   SET name = NULL
 WHERE name IS NOT NULL
   AND instagram_handle IS NOT NULL
   AND lower(name) = lower(instagram_handle);

-- The IG-sourced rows had company = csv.username (the slug) — same
-- value as instagram_handle, just stored in two columns. Clear it so
-- company is reserved for the genuine "different from handle" case
-- (e.g., manually entered B2B leads where the company is distinct
-- from the contact channel).
UPDATE leads
   SET company = NULL
 WHERE company IS NOT NULL
   AND instagram_handle IS NOT NULL
   AND lower(company) = lower(instagram_handle);

-- ─── Whitespace safety net ─────────────────────────────────────────────
-- Belt-and-braces trim on text fields. NULLIF reduces "" back to NULL
-- so we don't end up with empty-string-vs-NULL ambiguity.
UPDATE leads
   SET name        = NULLIF(trim(name), ''),
       company     = NULLIF(trim(company), ''),
       location    = NULLIF(trim(location), ''),
       biography   = NULLIF(trim(biography), ''),
       phone       = NULLIF(trim(phone), ''),
       website_url = NULLIF(trim(website_url), '')
 WHERE name        IS NOT NULL
    OR company     IS NOT NULL
    OR location    IS NOT NULL
    OR biography   IS NOT NULL
    OR phone       IS NOT NULL
    OR website_url IS NOT NULL;
