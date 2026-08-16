-- 0017_console_notification_reads.sql
--
-- Per-operator "last time I looked at the bell". The console derives unread
-- from this: anything newer than your last visit. One row per operator, so it
-- does not grow with items × operators the way read receipts would — and it
-- follows the operator across devices, which a cookie would not.
--
-- Deliberately NOT a notifications table. A notification here is a ticket or a
-- merchant reply that already exists; storing a copy would let the copy drift
-- from the thing it describes.

CREATE TABLE console_notification_reads (
  -- The session `sub` — a Zitadel subject, an opaque string and NOT a uuid.
  -- text for the same reason migration 0003 made author_user_id text.
  user_id      text        PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The bell's second query is "merchant replies across ALL tickets, newest
-- first, within a window". ptr_ticket_idx is (ticket_id, created_at) and
-- cannot serve it. Partial, because platform_admin replies are never a
-- notification — an operator does not need telling that they replied.
CREATE INDEX ptr_merchant_recent_idx
  ON platform_ticket_replies (created_at DESC)
  WHERE author_type = 'merchant';
