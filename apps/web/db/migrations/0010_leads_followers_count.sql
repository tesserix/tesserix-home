-- 0010 — Add followers_count to leads.
--
-- Motivation: the Instagram scraper has the follower count for every
-- handle; until now we dropped it on the floor at import time. Storing
-- it lets the UI sort/filter "high-signal" leads (e.g. handle-only
-- accounts with >1k followers go to the top of the outreach queue).
--
-- Notes:
--   * Nullable — many manual / non-IG leads will never have a value.
--   * Non-negative CHECK; an explicit zero still passes (some new
--     accounts genuinely have 0 followers).
--   * Plain btree index. The expected query is `WHERE followers_count
--     >= N ORDER BY followers_count DESC`, which a btree handles. No
--     partial index — the API also wants `followers_count IS NOT NULL`
--     paths (e.g. "any IG lead with a follower count we know") and a
--     single index can serve both.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS followers_count integer;

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_followers_count_nonneg,
  ADD  CONSTRAINT          leads_followers_count_nonneg
    CHECK (followers_count IS NULL OR followers_count >= 0);

CREATE INDEX IF NOT EXISTS leads_followers_count_idx
  ON leads (followers_count DESC NULLS LAST);
