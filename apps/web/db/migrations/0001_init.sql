-- 0001_init.sql — initial schema for tesserix-postgres.tesserix_admin
--
-- Owns the platform-operator's local data only:
--   apps           — registry of products this super-admin oversees
--                    (mark8ly today; fanzone, homechef, … later)
--   leads          — sales pipeline; manual CSV / paste-JSON dump supported
--   lead_imports   — batch-tracking for each manual dump (audit + retry)
--
-- Cross-product reads/writes against each product's own DB happen live
-- via per-product elevated roles (e.g. mark8ly_platform_admin) — there
-- is NO ETL into this database. See tesserix-k8s/docs/cross-db-admin.md.

BEGIN;

-- =======================================================================
-- updated_at trigger helper. Reused by every table that has updated_at.
-- =======================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- =======================================================================
-- apps — registry of products this super-admin manages.
-- =======================================================================
CREATE TABLE apps (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 varchar(64)   NOT NULL UNIQUE,
  name                 varchar(200)  NOT NULL,
  description          text,
  status               varchar(20)   NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','planned','archived','deprecated')),

  -- Cross-DB connection metadata. Used by tesserix-home / tesserix-admin-api
  -- to know where to point the elevated-role client. Keeping this as data
  -- (not config) lets us add a new product (fanzone, homechef…) by inserting
  -- a row + its ExternalSecret + a NetPol entry — no code change.
  db_namespace         varchar(64),
  db_host              varchar(255),
  db_port              int           DEFAULT 5432,
  db_admin_secret_name varchar(64),
  db_databases         jsonb         NOT NULL DEFAULT '[]'::jsonb,

  -- Public-facing URLs. Useful for the dashboard's "Open product admin"
  -- link and for quick-navigation in the tenant detail view.
  primary_domain       varchar(200),
  admin_url            varchar(500),

  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX apps_status_idx ON apps (status);

CREATE TRIGGER apps_updated_at_trg
  BEFORE UPDATE ON apps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =======================================================================
-- leads — minimum sales pipeline schema. Manual CSV / JSON dump via the
-- super-admin UI inserts into this table; the lead_imports table tracks
-- each batch.
-- =======================================================================
CREATE TYPE lead_status AS ENUM (
  'new',
  'contacted',
  'qualified',
  'converted',
  'lost'
);

CREATE TABLE leads (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  email             varchar(320)  NOT NULL,
  name              varchar(200),
  company           varchar(200),
  source            varchar(100),                       -- where they came from
  status            lead_status   NOT NULL DEFAULT 'new',
  notes             text,
  owner             varchar(200),                       -- email of the human handling this lead

  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  last_contacted_at timestamptz,

  CONSTRAINT leads_email_format
    CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- Case-insensitive uniqueness on email — manual imports will frequently
-- collide on case (Foo@x.com vs foo@x.com). Use a partial unique index
-- so we can later extend with soft-delete (status='lost') re-imports.
CREATE UNIQUE INDEX leads_email_lower_uq ON leads (lower(email));
CREATE INDEX leads_status_idx ON leads (status);
CREATE INDEX leads_created_at_idx ON leads (created_at DESC);

CREATE TRIGGER leads_updated_at_trg
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =======================================================================
-- lead_imports — batch tracking for manual dumps. Lets the UI show
-- "you imported 412 leads on 2026-04-30, 8 failed" and re-try failures.
-- =======================================================================
CREATE TABLE lead_imports (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  source        varchar(100)  NOT NULL,                -- 'csv','manual','paste','typeform','webhook',...
  filename      varchar(500),
  imported_by   varchar(200),                          -- super-admin email
  total_rows    int           NOT NULL DEFAULT 0,
  inserted_rows int           NOT NULL DEFAULT 0,
  updated_rows  int           NOT NULL DEFAULT 0,
  failed_rows   int           NOT NULL DEFAULT 0,
  errors        jsonb         NOT NULL DEFAULT '[]'::jsonb,    -- [{row: 5, email: "...", error: "..."}]
  created_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX lead_imports_created_at_idx ON lead_imports (created_at DESC);

COMMIT;
