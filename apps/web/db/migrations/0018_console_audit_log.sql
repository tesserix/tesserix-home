-- 0018_console_audit_log.sql
--
-- The console's record of what an operator DID — starting with identity
-- lookup (#134), and intended for every operator action that reaches across
-- into a product's data afterwards.
--
-- Why here, and not audit-service: audit-service was a mark8ly-era
-- per-microservice app, and mark8ly v2 replaced it in-house —
-- mark8ly-platform-api owns the platform_api.audit_logs that
-- /admin/apps/mark8ly/audit-logs reads today. The platform's own audit need
-- never had a home; it was borrowing mark8ly's and lost the loan. Reviving a
-- retired service of one product to serve a different owner's need would cost
-- a Knative service and a database on a shared db-f1-micro, to hold rows only
-- the console writes and only the console reads.
--
-- Why this database is the right one: operator-action audit is platform-owned
-- by definition. Apply the coupling test — if the platform is unavailable,
-- must the product still function? — and it passes trivially: no product
-- reads or depends on a record of what a console operator looked up. The
-- console already owns tables here (platform_tickets, platform_ticket_replies,
-- console_notification_reads) and already has the pool, so nothing new is
-- provisioned.
--
-- This is NOT a second central audit store. #158's timeline is an aggregating
-- reader over each product's own audit; this table is one more source it
-- reads, alongside mark8ly's, Kora's and Fe3dr's — not a copy of them.

-- =======================================================================
-- console_audit_log
--
-- The columns are @tesserix/web's AuditLogEntry, deliberately:
--
--   { id, actor, action, target?, timestamp, metadata? }
--
-- AuditLogViewer is the component #139's merged audit surface and #158's
-- timeline will both render this through. Storing the viewer's shape means a
-- row reaches it without a mapping layer, and means the schema chosen once
-- here is the one three surfaces read — rather than discovering the mismatch
-- on the second consumer.
-- =======================================================================
CREATE TABLE console_audit_log (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The operator's Zitadel `sub` — an opaque string, NOT a uuid. text for
  -- exactly the reason migration 0003 relaxed author_user_id and migration
  -- 0017 declared console_notification_reads.user_id as text: a
  -- foreign-issued identifier stored as uuid fails the implicit cast and
  -- lies about its shape. No FK for the same reason — the subject is issued
  -- by the IdP and there is no local users table to point at.
  actor    text        NOT NULL,

  -- What was done, as a stable dotted identifier — `identity.lookup` for
  -- #134. Not free prose: this is the column a future retention or alerting
  -- rule discriminates on, and prose cannot be discriminated on.
  action   text        NOT NULL,

  -- What it was done to — for a lookup, the query as the operator entered
  -- it. Nullable because AuditLogViewer's `target` is optional and not every
  -- action has one.
  --
  -- This column DOES hold personal data (the email someone searched for) and
  -- that is the point: "who searched for whom" is the accountable fact.
  -- `metadata` is where the line is drawn instead — see below.
  target   text,

  -- AuditLogViewer calls this field `timestamp`. The column does not,
  -- because `timestamp` is a type name in SQL and every hand-written query,
  -- psql session and dump against it would need quoting to stay unambiguous.
  -- The repository aliases it back (`occurred_at AS "timestamp"`) in the one
  -- SELECT, which costs a word and no per-row mapping.
  --
  -- Written by the application, not defaulted from now(), so the recorded
  -- instant is the operation's, not the INSERT's. The DEFAULT is a floor for
  -- a row inserted by hand.
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- A SUMMARY of what the action returned — counts per source, serialised.
  -- Never the returned rows themselves: an audit trail that copies the
  -- personal data it exists to account for is a second copy of the problem,
  -- with a longer retention and a wider read grant than the original.
  --
  -- text, not jsonb, because AuditLogViewer's `metadata` is a string and a
  -- jsonb column would need a mapper the viewer cannot use. The writer
  -- constrains what can reach here far more tightly than the type does —
  -- values are numbers and keys must be identifier-shaped, so a name or an
  -- email cannot be smuggled through either half of a pair. See
  -- apps/console/lib/db/audit-repo.ts.
  metadata text
);

-- =======================================================================
-- Indexes. Two, one per read pattern that actually exists — an append-only
-- table pays for every index on every write, and there is no reader here to
-- amortise a speculative one.
-- =======================================================================

-- 1. Recent-first overall. This is the read this commit ships
--    (recentAuditEntries) and the read #139/#158 will make. It is also what
--    a retention DELETE ... WHERE occurred_at < $cutoff will use, so it
--    earns its keep twice.
CREATE INDEX console_audit_recent_idx
  ON console_audit_log (occurred_at DESC);

-- 2. By actor, recent-first. "What did this operator look at?" is the
--    question the table exists to answer — it is asked of an audit trail
--    long before a UI exists to ask it, by a human at a psql prompt during
--    an incident. Composite rather than a bare (actor) index because the
--    question is always time-bounded, and a bare actor index would leave the
--    sort to be done in memory.
CREATE INDEX console_audit_actor_recent_idx
  ON console_audit_log (actor, occurred_at DESC);

-- No index on action or target. Nothing reads by either yet, and target is
-- the highest-cardinality column in the table; an index on it would be the
-- largest object here in service of a query nobody has written.

-- =======================================================================
-- Retention: decided, not implemented.
--
-- Kept indefinitely for now, deliberately. The write rate is bounded by
-- humans typing: a handful of operators making manual lookups, so hundreds
-- of rows a year at a few hundred bytes each — the row count will not be
-- visible against the tickets tables on this db-f1-micro, and an accountability
-- trail that silently deletes itself is worth less than a small table.
--
-- The bound that matters is not size, it is the personal data in `target`.
-- When a retention policy is set (the working assumption is 365 days, long
-- enough to cover an audit cycle), it is one scheduled statement —
--   DELETE FROM console_audit_log WHERE occurred_at < now() - interval '1 year'
-- — served by console_audit_recent_idx, and it does not need a schema change,
-- which is why it is not being guessed at now.
--
-- The thing that would invalidate this: any machine-driven action writing
-- here. `action` is the column that would show it, and unbounded growth
-- would then need addressing before it is inherited rather than after.
-- =======================================================================
