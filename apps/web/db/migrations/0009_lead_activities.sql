-- 0009 — lead_activities — append-only conversation/touchpoint log per lead.
--
-- Captures who did what when, replacing the single `notes` blob on
-- leads with a chronological timeline. Existing notes stay where they
-- are (they're scrape data, not conversations) — new conversations,
-- DM logs, call summaries, status flips all land here.
--
-- Identity is the Google OAuth email (getCurrentSession().email). No
-- separate operators table — YAGNI until two operators disagree.
--
-- The `kind` enum starts narrow; extending later via ALTER TYPE is
-- cheap. metadata jsonb captures kind-specific extras (template_key
-- for email_sent, before/after for status_change, etc).

CREATE TYPE lead_activity_kind AS ENUM (
    'note',
    'dm_sent',
    'dm_received',
    'email_sent',
    'email_received',
    'call',
    'status_change',
    'assigned'
);

CREATE TABLE lead_activities (
    id          uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id     uuid               NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    kind        lead_activity_kind NOT NULL,
    actor_email varchar(320)       NOT NULL,
    body        text,
    metadata    jsonb              NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz        NOT NULL DEFAULT now()
);

CREATE INDEX lead_activities_lead_id_created_at_idx
    ON lead_activities (lead_id, created_at DESC);

CREATE INDEX lead_activities_actor_idx
    ON lead_activities (actor_email);

CREATE INDEX lead_activities_kind_idx
    ON lead_activities (kind);
