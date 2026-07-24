-- 0011 — Add is_starred + posts_count to leads.
--
-- Motivation:
--   * is_starred — the operator wants to bookmark high-priority leads
--     (e.g. the top 28 from a triage run) so the warm-up + DM queue
--     surfaces them first. Boolean flag is enough; we don't need a
--     separate "priority" enum until we have more than two tiers.
--   * posts_count — the Instagram scraper hands us a post count per
--     handle alongside followers; we already store followers_count
--     (0010) and the same "active account" filter wants both signals.
--     A handle with 1k followers and 5 posts reads very differently
--     from 1k followers + 800 posts.
--
-- Notes:
--   * is_starred — non-null with default false; existing rows flip to
--     false at migration time and stay there until the operator stars
--     them. Partial index keyed on is_starred = true keeps the "starred
--     only" filter cheap (only the bookmarked rows index, typically
--     a few dozen at most).
--   * posts_count — nullable, mirroring followers_count. Many manual /
--     non-IG leads will never have a value. Non-negative CHECK; an
--     explicit zero passes (genuinely-empty new accounts exist).
--   * Plain btree index on posts_count DESC NULLS LAST mirrors the
--     followers_count pattern — the API wants both `WHERE posts_count
--     >= N ORDER BY posts_count DESC` and `posts_count IS NOT NULL`
--     paths from a single index.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_starred boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS posts_count integer;

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_posts_count_nonneg,
  ADD  CONSTRAINT          leads_posts_count_nonneg
    CHECK (posts_count IS NULL OR posts_count >= 0);

CREATE INDEX IF NOT EXISTS leads_is_starred_idx
  ON leads (is_starred) WHERE is_starred = true;

CREATE INDEX IF NOT EXISTS leads_posts_count_idx
  ON leads (posts_count DESC NULLS LAST);
