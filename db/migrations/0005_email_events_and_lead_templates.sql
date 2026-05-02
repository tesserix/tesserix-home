-- 0005 — email_events (Phase 1 Wave 1.5) + platform_lead_templates (B2)
--
-- Two changes bundled because both are tesserix-home-owned and ship in
-- the same release window:
--
-- 1. email_events
--    SendGrid webhook events keyed by Wave 5 custom_args (product,
--    tenant_id, kind, template_key) so per-product / per-tenant
--    engagement dashboards stop returning zeros.
--
-- 2. platform_lead_templates
--    B2 — tesserix-home is the authoring + sending surface for lead
--    invite / marketing emails. Templates live here (not in mark8ly's
--    DB) because the lead pipeline is platform-owned: leads exist in
--    tesserix_admin.leads (not in mark8ly), and the send happens
--    directly from tesserix-home → SendGrid (no mark8ly hop).

-- ─── email_events ────────────────────────────────────────────────────
CREATE TABLE email_events (
    id              bigserial    PRIMARY KEY,
    -- SendGrid's per-event ID (sg_event_id). Unique so retries from
    -- SendGrid (which can fire the same event twice on slow ack) are
    -- idempotent at the DB layer.
    sg_event_id     text         NOT NULL UNIQUE,
    -- Event type: processed, delivered, open, click, bounce, dropped,
    -- spamreport, unsubscribe, group_unsubscribe, group_resubscribe.
    -- Stored as text rather than enum so we don't need a migration when
    -- SendGrid adds a new type.
    event_type      text         NOT NULL,
    -- Wave 5 instrumentation guarantees these are set on every send
    -- from mark8ly's services. May be null for SendGrid-internal events
    -- or sends that pre-date Wave 5.
    product         text,
    tenant_id       text,
    kind            text,
    template_key    text,
    campaign_id     text,
    lead_id         text,
    -- Recipient at send time (can differ from current address if the
    -- user later changed it). Useful for bounce diagnostics.
    recipient       text,
    -- HTTP status / error reason for bounce/dropped events.
    reason          text,
    -- Raw event JSON for debugging — full SendGrid payload as received.
    raw             jsonb        NOT NULL,
    -- Timestamps. event_at is from SendGrid (when the event happened);
    -- received_at is when we ingested it.
    event_at        timestamptz  NOT NULL,
    received_at     timestamptz  NOT NULL DEFAULT now()
);

-- Aggregation queries: GROUP BY (product, tenant_id, event_type) over a
-- time window. Index supports the common dashboard query shape.
CREATE INDEX email_events_product_tenant_idx
    ON email_events (product, tenant_id, event_at DESC)
    WHERE product IS NOT NULL;

CREATE INDEX email_events_event_at_idx
    ON email_events (event_at DESC);

CREATE INDEX email_events_template_key_idx
    ON email_events (template_key, event_at DESC)
    WHERE template_key IS NOT NULL;

CREATE INDEX email_events_lead_id_idx
    ON email_events (lead_id, event_at DESC)
    WHERE lead_id IS NOT NULL;

-- ─── platform_lead_templates ─────────────────────────────────────────
CREATE TABLE platform_lead_templates (
    key          text         PRIMARY KEY,
    label        text         NOT NULL,           -- human-readable name shown in UI
    subject      text         NOT NULL,           -- Go-template string
    html_body    text         NOT NULL,
    text_body    text         NOT NULL,
    -- variables is the declared variable schema (an array of {name, type, required})
    -- so the admin UI knows which placeholders the operator can use.
    variables    jsonb        NOT NULL DEFAULT '[]'::jsonb,
    status       text         NOT NULL DEFAULT 'published'
                                  CHECK (status IN ('draft','published')),
    -- product scopes the template to a product audience (e.g.
    -- 'mark8ly', 'homechef'). Empty string = cross-product.
    product      text         NOT NULL DEFAULT '',
    version      integer      NOT NULL DEFAULT 1,
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    updated_by   text
);

CREATE INDEX platform_lead_templates_product_idx
    ON platform_lead_templates (product, status);

-- ─── Outbound send log (B2) ──────────────────────────────────────────
-- Every outbound lead/marketing send from tesserix-home gets a row
-- here so we have an audit trail independent of SendGrid (which can
-- expire activity data and isn't queryable for older sends).
CREATE TABLE platform_outbound_emails (
    id            bigserial    PRIMARY KEY,
    -- Idempotency key from the caller (operator action). Prevents
    -- double-sends if the operator double-clicks.
    idempotency_key text       NOT NULL UNIQUE,
    template_key  text         NOT NULL,
    template_version integer,
    product       text         NOT NULL,
    lead_id       text,
    recipient     text         NOT NULL,
    subject       text         NOT NULL,
    -- Result of the SendGrid POST.
    sent_at       timestamptz,
    sg_message_id text,
    error_message text,
    sent_by       text,           -- operator email
    created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX platform_outbound_emails_lead_idx
    ON platform_outbound_emails (lead_id, created_at DESC)
    WHERE lead_id IS NOT NULL;

CREATE INDEX platform_outbound_emails_template_idx
    ON platform_outbound_emails (template_key, created_at DESC);
