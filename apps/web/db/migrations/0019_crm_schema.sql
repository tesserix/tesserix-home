-- 0019_crm_schema.sql
--
-- The CRM. Six tables, prefixed crm_ so they coexist with `leads` until the
-- console surfaces are proven and the old admin page is retired.
--
-- The shape that matters: STAGE LIVES ON THE OPPORTUNITY, never on the
-- organisation or the contact. One business can be prospected for Mark8ly and
-- Kora independently, lost for one and won for the other, without either
-- outcome overwriting the other. The old `leads` table could not express that
-- because one row was simultaneously the person, the business and the deal.

CREATE TYPE crm_stage AS ENUM ('new', 'contacted', 'qualified', 'won', 'lost');

CREATE TYPE crm_activity_kind AS ENUM (
  'note', 'dm_sent', 'dm_received', 'email_sent', 'email_received',
  'call', 'stage_change', 'assigned'
);

-- =======================================================================
-- crm_imports
--
-- One row per bulk upload. Kept even though nothing here references it
-- except crm_organisations.import_id, because "which import produced this
-- row" is the first question asked when an import goes wrong, and
-- reconstructing it from created_at timestamps after the fact is a guess.
-- =======================================================================
CREATE TABLE crm_imports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     text,
  row_count    integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- =======================================================================
-- crm_organisations
--
-- The business. Not the deal, not the person — see crm_opportunities and
-- crm_contacts below for why those are split out.
-- =======================================================================
CREATE TABLE crm_organisations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  website_url  text,
  location     text,
  category     text[] NOT NULL DEFAULT '{}',
  tags         text[] NOT NULL DEFAULT '{}',
  -- No `notes` column on purpose: crm_activities is the record. A standing
  -- note and an event log about the same business drift apart.
  --
  -- `converted_ref` is opaque and product-scoped, and is meaningless without
  -- `converted_product` beside it: Mark8ly produces tenants, Kora has users,
  -- HMS has facilities. A bare `converted_tenant_id` would bake one product's
  -- vocabulary into a cross-product table.
  converted_product     text,
  converted_ref         text,
  converted_label       text,
  converted_at          timestamptz,
  converted_link_method text,   -- 'matched' | 'manual'
  import_id    uuid REFERENCES crm_imports(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_org_conversion_complete CHECK (
    (converted_ref IS NULL AND converted_product IS NULL)
    OR (converted_ref IS NOT NULL AND converted_product IS NOT NULL)
  )
);

-- =======================================================================
-- crm_contacts
--
-- The person at the business. Split from crm_organisations because a
-- business can have several people (owner, marketing lead, a second contact
-- added mid-deal) and merging them into the org row would mean overwriting
-- one to record another.
-- =======================================================================
CREATE TABLE crm_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES crm_organisations(id) ON DELETE CASCADE,
  name         text,
  email        text,
  phone        text,
  instagram_handle text,
  followers_count  integer,
  posts_count      integer,
  biography    text,
  is_primary   boolean NOT NULL DEFAULT false,
  -- DPDP: we hold scraped social profiles about people who never filled in a
  -- form. `source`/`sourced_at`/`lawful_basis` record what we hold and why.
  source       text,
  sourced_at   timestamptz,
  lawful_basis text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX crm_contacts_email_lower_uq
  ON crm_contacts (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX crm_contacts_org_idx ON crm_contacts (organisation_id);
CREATE INDEX crm_contacts_instagram_idx
  ON crm_contacts (lower(instagram_handle)) WHERE instagram_handle IS NOT NULL;

-- =======================================================================
-- crm_opportunities
--
-- The deal, per product. This is where `stage` lives — see the file header.
-- =======================================================================
CREATE TABLE crm_opportunities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES crm_organisations(id) ON DELETE CASCADE,
  -- Null until qualified. A migrated lead was never matched to a product, and
  -- inventing one at import fabricates attribution the funnel later reports as
  -- fact. Required from `qualified` onward, enforced below.
  product      text,
  stage        crm_stage NOT NULL DEFAULT 'new',
  owner        text,
  source       text,
  next_action_at   timestamptz,
  next_action_note text,
  last_contacted_at timestamptz,
  is_starred   boolean NOT NULL DEFAULT false,
  closed_at    timestamptz,
  lost_reason  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_opp_product_required_when_qualified CHECK (
    stage IN ('new', 'contacted') OR product IS NOT NULL
  )
);

CREATE INDEX crm_opp_due_idx
  ON crm_opportunities (next_action_at)
  WHERE next_action_at IS NOT NULL AND stage NOT IN ('won', 'lost');
CREATE INDEX crm_opp_drifting_idx
  ON crm_opportunities (last_contacted_at)
  WHERE next_action_at IS NULL AND stage NOT IN ('won', 'lost');
CREATE INDEX crm_opp_org_idx ON crm_opportunities (organisation_id);

-- =======================================================================
-- crm_activities
--
-- The event log — notes, messages, calls, stage changes. Always attached to
-- the organisation, optionally scoped to a deal or a person: "everything we
-- have ever said to this business" survives across deals, and a note taken
-- before any opportunity exists still has a home.
-- =======================================================================
CREATE TABLE crm_activities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES crm_organisations(id) ON DELETE CASCADE,
  opportunity_id  uuid REFERENCES crm_opportunities(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES crm_contacts(id) ON DELETE SET NULL,
  kind         crm_activity_kind NOT NULL,
  actor        text NOT NULL,
  body         text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_activities_org_recent_idx
  ON crm_activities (organisation_id, occurred_at DESC);
CREATE INDEX crm_activities_opp_recent_idx
  ON crm_activities (opportunity_id, occurred_at DESC)
  WHERE opportunity_id IS NOT NULL;

-- =======================================================================
-- crm_suppressions
--
-- A do-not-contact list, keyed by whichever identifier the request to stop
-- came in on. Checked before an outbound email or DM, not before a note or a
-- call — those are things we did, not things we sent.
-- =======================================================================
CREATE TABLE crm_suppressions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text,
  instagram_handle text,
  reason       text NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_suppression_has_a_key CHECK (
    email IS NOT NULL OR instagram_handle IS NOT NULL
  )
);

CREATE UNIQUE INDEX crm_suppressions_email_uq
  ON crm_suppressions (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX crm_suppressions_ig_uq
  ON crm_suppressions (lower(instagram_handle)) WHERE instagram_handle IS NOT NULL;
