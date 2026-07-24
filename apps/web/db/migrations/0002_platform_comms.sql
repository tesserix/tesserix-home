-- 0002_platform_comms.sql — Phase 5: Platform Tickets + Announcements.
-- Adds three tables under tesserix_admin schema:
--   platform_tickets        — merchant-to-platform support tickets
--   platform_ticket_replies — reply thread (merchant or platform_admin)
--   platform_announcements  — platform-broadcast messages to merchant admins
--
-- All tables are platform-owned (tesserix-postgres). Products read/write
-- via tesserix-home internal API endpoints, never directly to this DB.

BEGIN;

-- =======================================================================
-- platform_tickets — one row per ticket filed by a merchant against the
-- Tesserix platform team. Ticket-number format e.g. "M8-0042" generated
-- per (product_id, sequence) by the inserting endpoint.
-- =======================================================================
CREATE TABLE platform_tickets (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id           text          NOT NULL,
  tenant_id            uuid          NOT NULL,
  ticket_number        varchar(20)   NOT NULL,
  subject              varchar(300)  NOT NULL,
  description          text          NOT NULL,
  status               varchar(20)   NOT NULL DEFAULT 'open',
  priority             varchar(10)   NOT NULL DEFAULT 'medium',
  submitted_by_name    varchar(200)  NOT NULL,
  submitted_by_email   varchar(300)  NOT NULL,
  submitted_by_user_id uuid,
  resolved_at          timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT pt_status_chk   CHECK (status   IN ('open','in_progress','resolved','closed')),
  CONSTRAINT pt_priority_chk CHECK (priority IN ('low','medium','high','urgent')),
  UNIQUE (product_id, ticket_number)
);

-- Hot path: list-page open + urgent at the top.
CREATE INDEX pt_open_idx
  ON platform_tickets (created_at DESC)
  WHERE status IN ('open','in_progress');

-- Admin can pivot to one tenant's tickets.
CREATE INDEX pt_product_tenant_idx
  ON platform_tickets (product_id, tenant_id);

CREATE TRIGGER pt_set_updated_at
  BEFORE UPDATE ON platform_tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =======================================================================
-- platform_ticket_replies — append-only reply thread.
-- =======================================================================
CREATE TABLE platform_ticket_replies (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      uuid          NOT NULL REFERENCES platform_tickets(id) ON DELETE CASCADE,
  author_type    varchar(20)   NOT NULL,
  author_name    varchar(200)  NOT NULL,
  author_email   varchar(300),
  author_user_id uuid,
  content        text          NOT NULL,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ptr_author_chk CHECK (author_type IN ('merchant','platform_admin'))
);

CREATE INDEX ptr_ticket_idx ON platform_ticket_replies (ticket_id, created_at);

-- Sequence used to generate ticket_number values when inserting. Per-product
-- format applied in app code: e.g. mark8ly → "M8-0042", homechef → "HC-0001".
CREATE SEQUENCE platform_tickets_seq AS bigint START 1;

-- =======================================================================
-- platform_announcements — broadcast messages from Tesserix to merchants.
-- Audience is filtered via the JSON column at read time. Schema is
-- intentionally permissive so we can grow filters (tenant tags, segments)
-- without a migration.
-- =======================================================================
CREATE TABLE platform_announcements (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  title           varchar(200)  NOT NULL,
  body            text          NOT NULL,
  severity        varchar(20)   NOT NULL DEFAULT 'info',
  audience_filter jsonb         NOT NULL DEFAULT '{}'::jsonb,
  starts_at       timestamptz   NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  is_published    boolean       NOT NULL DEFAULT false,
  created_by      text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT pa_severity_chk CHECK (severity IN ('info','warning','maintenance','incident'))
);

-- Hot path: read-by-product fetches active announcements.
CREATE INDEX pa_active_idx
  ON platform_announcements (starts_at DESC)
  WHERE is_published = true;

CREATE TRIGGER pa_set_updated_at
  BEFORE UPDATE ON platform_announcements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
