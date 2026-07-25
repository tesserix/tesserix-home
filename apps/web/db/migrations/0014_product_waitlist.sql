-- 0014 — Product launch waitlist.
--
-- "Get notified when we launch" used to be a plain link to /contact, so nobody
-- who clicked it was ever recorded and there was no way to tell them when the
-- product actually shipped. This gives that button somewhere to write to, and
-- gives the launch announcement a list to send to.
--
-- Deliberately NOT folded into `leads`: that table is one row per person
-- (unique on lower(email)) and models a sales pipeline. A waitlist is
-- many-to-many — one person can be waiting on MediCare and FanZone at once —
-- and overloading `leads.notes` would lose per-product notify state.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS product_waitlist (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_slug   text        NOT NULL,
    email          text        NOT NULL,
    name           text,
    -- Where the signup came from, for attribution (product page, campaign, …).
    source         text        NOT NULL DEFAULT 'product-page',
    -- Set when the launch announcement for this product reached this address.
    -- NULL = still waiting. This, not the announcement row, is what guarantees
    -- an individual is never emailed twice.
    notified_at    timestamptz,
    -- One-click unsubscribe. Required for marketing mail (CAN-SPAM/GDPR) and
    -- it must work without a login, so it is a capability token in the URL.
    unsubscribe_token uuid    NOT NULL DEFAULT gen_random_uuid(),
    unsubscribed_at   timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One subscription per address per product. Case-insensitive: people type
-- their address inconsistently and we must not mail them twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_waitlist_product_email
    ON product_waitlist (product_slug, lower(email));

-- The announce job's hot path: "who on this product's list still needs telling".
CREATE INDEX IF NOT EXISTS idx_product_waitlist_pending
    ON product_waitlist (product_slug)
    WHERE notified_at IS NULL AND unsubscribed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_waitlist_unsub_token
    ON product_waitlist (unsubscribe_token);

-- One row per product whose launch has been announced. The announce job is
-- automatic, so this is the guard that stops a redeploy — or two pods racing
-- the same cron tick — from blasting the list a second time.
CREATE TABLE IF NOT EXISTS product_launch_announcements (
    product_slug  text PRIMARY KEY,
    announced_at  timestamptz NOT NULL DEFAULT now(),
    recipients    integer     NOT NULL DEFAULT 0
);
