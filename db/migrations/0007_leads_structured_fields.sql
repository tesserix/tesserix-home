-- 0007 — Restructure leads for multi-channel contact + filterable fields.
--
-- Motivation: the original shape required `email NOT NULL UNIQUE` and
-- shoehorned every other signal (location, category, has-website, bio,
-- phone, hashtags, IG link) into the free-text `notes` column. Real
-- outreach data has many leads with no email at all (Instagram sellers,
-- DM-only contacts) and the only filter that matters for mark8ly's
-- ICP — "no website yet" — wasn't queryable.
--
-- Changes:
--   1. email becomes nullable; uniqueness becomes a partial index that
--      still dedups when set.
--   2. New columns: instagram_handle (with its own partial UQ), phone,
--      location, category text[], has_website, website_url, biography,
--      tags text[].
--   3. CHECK constraint guarantees every row has at least ONE of
--      email / phone / instagram_handle (no zero-contact ghosts).
--   4. Filter indexes: partial on has_website=false (the high-value
--      target slice), lower(location), GIN on category[] and tags[].
--   5. Backfill the 76 instagram_outreach rows: extract structured
--      fields from notes via regex; pull the IG handle out of the
--      synthetic `<username>@instagram.placeholder` email and set
--      email back to NULL.

-- ─── 1. New columns (nullable / defaulted; safe to add to populated table) ──
ALTER TABLE leads ADD COLUMN IF NOT EXISTS instagram_handle  varchar(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone             varchar(40);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS location          varchar(200);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS category          text[]  NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS has_website       boolean;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS website_url       varchar(500);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS biography         text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags              text[]  NOT NULL DEFAULT '{}';

-- ─── 2. Loosen email constraint ──────────────────────────────────────────
-- Order matters: drop NOT NULL before the backfill writes NULLs.
ALTER TABLE leads ALTER COLUMN email DROP NOT NULL;
DROP INDEX IF EXISTS leads_email_lower_uq;
CREATE UNIQUE INDEX leads_email_lower_uq
    ON leads (lower(email))
    WHERE email IS NOT NULL;

-- ─── 3. Backfill — Instagram outreach rows ───────────────────────────────
-- Pull the IG username out of the synthetic email and clear the email.
UPDATE leads
   SET instagram_handle = split_part(email, '@', 1),
       email            = NULL
 WHERE email LIKE '%@instagram.placeholder';

-- Parse notes for every instagram_outreach row, even ones we just blanked
-- the email on. COALESCE preserves anything explicitly set. Empty regex
-- captures yield NULL via NULLIF, so we never overwrite real data with ''.
UPDATE leads
   SET location    = COALESCE(location,    NULLIF(trim(substring(notes FROM 'Location: ([^·]+)')), '')),
       biography   = COALESCE(biography,   NULLIF(trim(substring(notes FROM 'Bio: ([^·]+)')), '')),
       phone       = COALESCE(phone,       NULLIF(trim(substring(notes FROM 'Phone: ([^·]+)')), '')),
       website_url = COALESCE(website_url, NULLIF(trim(substring(notes FROM 'Website: ([^·]+)')), '')),
       has_website = COALESCE(
           has_website,
           CASE
             WHEN substring(notes FROM 'Website status: ([^·]+)') ~* 'Has website' THEN true
             WHEN substring(notes FROM 'Website status:') IS NOT NULL              THEN false
             ELSE NULL
           END
       ),
       category    = CASE
           WHEN array_length(category, 1) IS NULL
                AND substring(notes FROM 'Sells: ([^·]+)') IS NOT NULL
             THEN string_to_array(trim(substring(notes FROM 'Sells: ([^·]+)')), ', ')
           ELSE category
         END,
       tags        = CASE
           WHEN array_length(tags, 1) IS NULL
                AND substring(notes FROM 'Hashtags: ([^·]+)') IS NOT NULL
             THEN string_to_array(trim(substring(notes FROM 'Hashtags: ([^·]+)')), ', ')
           ELSE tags
         END
 WHERE source = 'instagram_outreach';

-- ─── 4. Partial unique on instagram_handle (after backfill so it sticks) ──
CREATE UNIQUE INDEX leads_instagram_handle_lower_uq
    ON leads (lower(instagram_handle))
    WHERE instagram_handle IS NOT NULL;

-- ─── 5. Filter indexes ───────────────────────────────────────────────────
-- has_website partial: only indexes "no website yet" (mark8ly ICP slice).
-- Keeps the index tiny and the common filter fast.
CREATE INDEX leads_has_website_false_idx
    ON leads (has_website)
    WHERE has_website = false;

CREATE INDEX leads_location_lower_idx
    ON leads (lower(location))
    WHERE location IS NOT NULL;

CREATE INDEX leads_category_gin_idx
    ON leads USING gin (category);

CREATE INDEX leads_tags_gin_idx
    ON leads USING gin (tags);

CREATE INDEX leads_source_idx
    ON leads (source)
    WHERE source IS NOT NULL;

-- ─── 6. CHECK: every row must carry at least one usable contact ──────────
-- Added LAST so the backfill step doesn't trip over rows mid-mutation.
ALTER TABLE leads
    ADD CONSTRAINT leads_contact_present
    CHECK (email IS NOT NULL OR phone IS NOT NULL OR instagram_handle IS NOT NULL);
