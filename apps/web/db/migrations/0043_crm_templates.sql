-- 0043_crm_templates.sql
--
-- Operator-authored outreach copy for the CRM: the DM or email a person
-- picks from, per lead, in `/platform/crm`. This is the UNRENDERED source
-- only — the merge fields (`{{contact.name}}` and friends) are substituted
-- at read time against the live contact row and never written back.
--
-- Not to be confused with `platform.leadTemplates`, the versioned marketing
-- email registry the platform API already serves (`GET /lead-templates`,
-- `htmlBody`/`version`/`status`, and a test-send). That is a different
-- surface with a different contract and a send path. Nothing here sends.
--
-- WHY A TABLE AND NOT A CONSTANT IN `lib/`. Campaign copy is tuned, not
-- authored once: the wording changes in response to reply rate, and it
-- changes on the timescale of reading a morning's replies. A constant makes
-- every one of those edits a deploy, and the person who reads the replies is
-- not the person who can ship one — so the copy stops being tuned, which is
-- the only thing that made templated outreach worth doing. The cost of a
-- table is this migration, paid once. The cost of the constant is paid every
-- time the copy should have changed and didn't.
--
-- WHY `product` IS NULLABLE, AND WHAT NULL MEANS. Null is "any product", not
-- "unknown". Two reasons, the first structural: the product estate is a
-- TypeScript constant, not a table, so there is no FK to hang this on —
-- `crm_opportunities.product` already records that same fact, and this
-- column is deliberately the same shape as its neighbour rather than a
-- second spelling. The second is about how templates are actually written: a
-- generic opener gets drafted before anyone has decided which product it
-- sells, and it must stay usable in the meantime. A NOT NULL column would
-- force the author to pick a product they do not yet have an opinion about,
-- and the value they invent to get past the form is worse than the null.
--
-- WHY THE SUBJECT CHECK. A DM has no subject line. Without
-- `crm_template_subject_is_email_only`, a subject authored against a `dm`
-- template is accepted by the form, stored, and then silently dropped at
-- render — the operator's words go nowhere and nothing ever tells them.
-- The database is the only place that can hold this rule, because both the
-- form and the renderer are things a future caller can route around: a
-- script, a second surface, or a repo function written by someone who read
-- neither. Rejecting the row is the only version of the rule that is still
-- true after the next caller arrives.
--
-- NO `body` LENGTH LIMIT, AND NO RENDERED-COPY COLUMN — the important
-- absence in this file. The rendered message embeds
-- `crm_contacts.biography`, which is scraped personal data about someone who
-- never filled in a form (0019's own words). `eraseContact`
-- (apps/console/lib/db/crm-erasure.ts) nulls the contact's personal columns
-- and empties its metadata bag; it does not reach every table. A rendered
-- copy persisted anywhere would therefore survive an erasure request, which
-- is the situation 0027's DPDP paragraph names as "a compliance defect, not
-- a feature". Nothing in this schema stores one, and that is a decision, not
-- an omission: what gets recorded about an outreach is the template id and
-- the timestamp, and the reconstruction of what was said stops working the
-- moment the contact is erased — which is the correct behaviour, not a gap.
-- A length limit is left off for the same reason it is left off `body` on
-- `crm_activities`: nothing here is truncating text a human wrote, and a
-- cap chosen now is a cap nobody can justify later.
--
-- NO `updated_at` TRIGGER. There are no triggers on any of the `crm_`
-- tables — `advanceStage` sets `updated_at = now()` in the same statement as
-- the change it is recording, and every writer here does the same. A trigger
-- would mean the timestamp is maintained in one place for these tables and
-- another for the rest, and the reader of a query has to know which.
--
-- NOT NULL WITH A DEFAULT on `is_archived` and both timestamps, per 0027's
-- standing argument: NULL and `false` would both mean "not archived", and
-- two spellings of one fact is two branches in every reader, one of which is
-- always the one nobody tested.

CREATE TYPE crm_template_channel AS ENUM ('dm', 'email');

CREATE TABLE crm_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  channel      crm_template_channel NOT NULL,
  -- Null = any product. See the header: no FK exists to point at.
  product      text,
  -- Email only, enforced below.
  subject      text,
  body         text NOT NULL,
  -- Archived, never deleted: `crm_activities.metadata` carries `template_id`
  -- forever, and a deleted template turns every one of those rows into a
  -- dangling id nobody can resolve.
  is_archived  boolean NOT NULL DEFAULT false,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_template_subject_is_email_only CHECK (
    (channel = 'email') OR subject IS NULL
  )
);

-- The composer's only read is "live templates for this channel". Partial on
-- `NOT is_archived` because archived rows become the majority over time —
-- copy is retired far more often than it is written, and the one query that
-- runs per lead should not be paying for the ones that were retired.
CREATE INDEX crm_templates_live_by_channel_idx
  ON crm_templates (channel)
  WHERE NOT is_archived;
