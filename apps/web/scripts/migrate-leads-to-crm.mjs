#!/usr/bin/env node
// migrate-leads-to-crm.mjs — one-shot migration of `leads` into the CRM
// schema (migrations 0019-0021).
//
// REQUIRED RUN ORDER — this is not optional, and getting it wrong fails
// most of the migration silently (see 0021's header for the full hazard):
//   1. apply migrations through 0020 (drops 0019's product-required CHECK
//      on crm_opportunities so historical rows with no product can land)
//   2. run this script with --commit, and CHECK ITS EXIT CODE. It exits
//      non-zero if any lead failed; 0021's guard is satisfied by one
//      migrated row, so a partial backfill would otherwise pass step 3 and
//      strand every remaining product-less lead behind the reinstated CHECK.
//   3. apply 0021 (re-adds the CHECK, NOT VALID, so it grandfathers the
//      rows this script just inserted while enforcing on everything after)
// 0021 itself refuses to apply if step 2 hasn't run yet, but nothing stops
// someone from running this script before 0020, or before 0021 in a
// database where 0021 was somehow already applied without a backfill — so
// don't rely on the guard alone, follow the order.
//
// Each `leads` row becomes one crm_organisations row + one crm_contacts row
// + one crm_opportunities row. Deliberately does NOT infer shared
// organisations: two leads at the same company become two organisations.
// Merging two later is easy; un-merging is not, and a wrong merge silently
// fuses two businesses' histories.
//
// `product` is left null on every migrated opportunity — a migrated lead
// was never matched to a product, and inventing one at import fabricates
// attribution the funnel would later report as fact. See 0020/0021 for how
// the schema accommodates that without weakening the CHECK for anything
// else.
//
// Idempotency: the brief's literal rule is "skip any lead whose email
// already exists in crm_contacts". That check is a no-op for the leads
// that have no email at all (nullable since migration 0007 — Instagram
// sellers, DM-only contacts) — it would never match, so those rows would
// be re-inserted on every re-run and violate "re-running produces no
// duplicates". Skipping is therefore keyed on `migrated_from_lead_id`
// instead, which is a strict superset: exact per-lead identity that also
// covers leads Task 1's schema doesn't require an email for. It's also
// enforced structurally by 0020's unique partial index, not just by this
// script's in-memory check.
//
// Usage:
//   TESSERIX_DB_HOST=... TESSERIX_DB_USER=... TESSERIX_DB_PASSWORD=... \
//     node scripts/migrate-leads-to-crm.mjs [--commit]
//
// Dry-run by default (reads only, prints what *would* be written).
// Pass --commit to actually write.

import process from "node:process";
import pg from "pg";

const ACTOR_MIGRATION = "migration";
const LAWFUL_BASIS_UNRECORDED = "not_recorded_pre_migration";

export function organisationName(lead) {
  const candidate =
    lead.company?.trim() || lead.name?.trim() || lead.instagram_handle?.trim();
  if (!candidate) {
    throw new Error(
      `lead has no company, name or handle to name an organisation from`,
    );
  }
  return candidate;
}

const STAGE_BY_STATUS = {
  new: "new",
  contacted: "contacted",
  qualified: "qualified",
  converted: "won",
  lost: "lost",
};

export function mapStage(status) {
  const stage = STAGE_BY_STATUS[status];
  if (!stage) throw new Error(`unknown lead status: ${status}`);
  return stage;
}

const ACTIVITY_KIND_BY_LEAD_KIND = {
  note: "note",
  dm_sent: "dm_sent",
  dm_received: "dm_received",
  email_sent: "email_sent",
  email_received: "email_received",
  call: "call",
  status_change: "stage_change",
  assigned: "assigned",
};

export function mapActivityKind(kind) {
  const mapped = ACTIVITY_KIND_BY_LEAD_KIND[kind];
  if (!mapped) throw new Error(`unknown lead_activities kind: ${kind}`);
  return mapped;
}

/**
 * Contact keys are stored NORMALISED, exactly as the application stores
 * them. `crm_suppressions` got a database trigger for this in 0022;
 * `crm_contacts` never did, so it is this script's job on the migration
 * path. It is not cosmetic: `findMatchingOrganisationId` (crm-repo.ts)
 * normalises its input and then compares against `lower(instagram_handle)`,
 * so a stored `@BondiBaker` can never match a lookup for `bondibaker` — and
 * every migrated lead whose handle carries a leading `@` would be created a
 * second time by the next CSV import, the one outcome that function exists
 * to prevent.
 *
 * Must stay byte-identical in behaviour to `normalizeInstagramHandle` in
 * `apps/console/lib/db/crm-repo.ts`: trim, strip leading `@`s, lowercase.
 */
export function normalizeInstagramHandle(handle) {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

/** Trim + lowercase, matching the email half of `isSuppressed`/
 *  `findMatchingOrganisationId` and 0022's trigger. */
export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function normalizedOrNull(value, normalize) {
  if (value === null || value === undefined) return null;
  const normalized = normalize(value);
  return normalized === "" ? null : normalized;
}

/** Terminal stages. A migrated deal in one of these already closed — it just
 *  closed before this schema existed to record when. */
const TERMINAL_STAGES = new Set(["won", "lost"]);

// Pure: leads row -> {organisation, contact, opportunity}. No DB access.
// Throws if the lead can't be named (see organisationName) or has an
// unrecognized status (see mapStage) — callers are expected to catch and
// count those as rejected rather than let one bad row abort the run.
export function mapLead(lead) {
  const stage = mapStage(lead.status);

  const organisation = {
    name: organisationName(lead),
    website_url: lead.website_url ?? null,
    location: lead.location ?? null,
    category: lead.category ?? [],
    tags: lead.tags ?? [],
    // Preserved, not left to DEFAULT now(): a migrated lead that reads as
    // created today is a lead with no history, and the drift rule
    // (DRIFT_DAYS) would then surface nothing at all for the first two
    // weeks after cutover — precisely the backlog the queue exists to show.
    created_at: lead.created_at,
  };

  const contact = {
    email: normalizedOrNull(lead.email, normalizeEmail),
    name: lead.name ?? null,
    phone: lead.phone ?? null,
    instagram_handle: normalizedOrNull(
      lead.instagram_handle,
      normalizeInstagramHandle,
    ),
    followers_count: lead.followers_count ?? null,
    posts_count: lead.posts_count ?? null,
    biography: lead.biography ?? null,
    is_primary: true,
    source: lead.source ?? null,
    sourced_at: lead.created_at,
    // 0019 added lawful_basis deliberately for DPDP: it records why we
    // hold data about a person who never filled in a form. Leaving it
    // null on migrated rows would be indistinguishable from "not yet
    // filled in" for a live contact. These rows predate the field
    // entirely — no lawful basis was ever captured at collection time —
    // so the honest value is an explicit marker saying so, not a
    // fabricated basis like "consent" or "legitimate_interest".
    lawful_basis: LAWFUL_BASIS_UNRECORDED,
    created_at: lead.created_at,
  };

  const opportunity = {
    stage,
    owner: lead.owner ?? null,
    last_contacted_at: lead.last_contacted_at ?? null,
    is_starred: lead.is_starred ?? false,
    source: lead.source ?? null,
    product: null,
    migrated_from_lead_id: lead.id,
    created_at: lead.created_at,
    // A won/lost deal closed at some point the `leads` table never recorded.
    // Left null, it sorts LAST under the handoff queue's
    // `ORDER BY o.closed_at ASC NULLS LAST` — the exact inverse of
    // "longest-waiting first", which would bury every migrated deal beneath
    // every deal closed since. The best evidence available is the last time
    // anyone touched the lead, falling back to when it was created; both are
    // real dates from the row, neither is invented.
    closed_at: TERMINAL_STAGES.has(stage)
      ? (lead.last_contacted_at ?? lead.created_at)
      : null,
  };

  return { organisation, contact, opportunity };
}

/** Thrown when a `--commit` run wrote some leads but not all of them.
 *  Carries the count so the exit path can report it without re-deriving it. */
export class PartialMigrationError extends Error {
  constructor(failureCount) {
    super(`${failureCount} lead(s) failed to migrate; the backfill is incomplete`);
    this.name = "PartialMigrationError";
    this.failureCount = failureCount;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  return { commit: args.includes("--commit") };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: ${name} env var is required`);
    process.exit(1);
  }
  return v;
}

function makeClient() {
  return new pg.Client({
    host: requireEnv("TESSERIX_DB_HOST"),
    port: process.env.TESSERIX_DB_PORT
      ? Number.parseInt(process.env.TESSERIX_DB_PORT, 10)
      : 5432,
    user: requireEnv("TESSERIX_DB_USER"),
    password: requireEnv("TESSERIX_DB_PASSWORD"),
    database: process.env.TESSERIX_DB_NAME ?? "tesserix_admin",
    ssl:
      process.env.TESSERIX_DB_SSL === "false"
        ? false
        : { rejectUnauthorized: false },
    statement_timeout: 60_000,
  });
}

// Splits every lead into: migratable (mapped successfully, not already
// migrated), skipped (already migrated), rejected (mapLead threw).
function planMigration(leads, migratedLeadIds) {
  const toMigrate = [];
  const skipped = [];
  const rejected = [];

  for (const lead of leads) {
    if (migratedLeadIds.has(lead.id)) {
      skipped.push(lead);
      continue;
    }
    try {
      const mapped = mapLead(lead);
      toMigrate.push({ lead, mapped });
    } catch (err) {
      rejected.push({ lead, reason: err.message });
    }
  }

  return { toMigrate, skipped, rejected };
}

async function insertOrganisation(client, organisation, importId = null) {
  const res = await client.query(
    `INSERT INTO crm_organisations
       (name, website_url, location, category, tags, import_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
     RETURNING id`,
    [
      organisation.name,
      organisation.website_url,
      organisation.location,
      organisation.category,
      organisation.tags,
      importId,
      organisation.created_at ?? null,
    ],
  );
  return res.rows[0].id;
}

async function insertContact(client, contact, organisationId) {
  const res = await client.query(
    `INSERT INTO crm_contacts
       (organisation_id, name, email, phone, instagram_handle,
        followers_count, posts_count, biography, is_primary, source,
        sourced_at, lawful_basis, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             COALESCE($13, now()))
     RETURNING id`,
    [
      organisationId,
      contact.name,
      contact.email,
      contact.phone,
      contact.instagram_handle,
      contact.followers_count,
      contact.posts_count,
      contact.biography,
      contact.is_primary,
      contact.source,
      contact.sourced_at,
      contact.lawful_basis,
      contact.created_at ?? null,
    ],
  );
  return res.rows[0].id;
}

async function insertOpportunity(client, opportunity, organisationId) {
  const res = await client.query(
    `INSERT INTO crm_opportunities
       (organisation_id, product, stage, owner, source, last_contacted_at,
        is_starred, migrated_from_lead_id, closed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()))
     RETURNING id`,
    [
      organisationId,
      opportunity.product,
      opportunity.stage,
      opportunity.owner,
      opportunity.source,
      opportunity.last_contacted_at,
      opportunity.is_starred,
      opportunity.migrated_from_lead_id,
      opportunity.closed_at ?? null,
      opportunity.created_at ?? null,
    ],
  );
  return res.rows[0].id;
}

async function insertActivity(client, activity) {
  await client.query(
    `INSERT INTO crm_activities
       (organisation_id, opportunity_id, contact_id, kind, actor, body, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      activity.organisation_id,
      activity.opportunity_id,
      activity.contact_id,
      activity.kind,
      activity.actor,
      activity.body,
      activity.metadata ?? {},
      activity.occurred_at,
    ],
  );
}

// Writes one lead's organisation + contact + opportunity + activities in a
// single transaction. Returns the number of activities written.
async function migrateOneLead(client, lead, mapped) {
  await client.query("BEGIN");
  try {
    const organisationId = await insertOrganisation(client, mapped.organisation);
    const contactId = await insertContact(client, mapped.contact, organisationId);
    const opportunityId = await insertOpportunity(
      client,
      mapped.opportunity,
      organisationId,
    );

    let activityCount = 0;

    if (lead.notes && lead.notes.trim().length > 0) {
      await insertActivity(client, {
        organisation_id: organisationId,
        opportunity_id: opportunityId,
        contact_id: contactId,
        kind: "note",
        actor: ACTOR_MIGRATION,
        body: lead.notes,
        occurred_at: lead.created_at,
      });
      activityCount += 1;
    }

    const leadActivitiesRes = await client.query(
      `SELECT kind, actor_email, body, metadata, created_at
         FROM lead_activities WHERE lead_id = $1 ORDER BY created_at`,
      [lead.id],
    );
    for (const row of leadActivitiesRes.rows) {
      await insertActivity(client, {
        organisation_id: organisationId,
        opportunity_id: opportunityId,
        contact_id: contactId,
        kind: mapActivityKind(row.kind),
        actor: row.actor_email,
        body: row.body,
        metadata: row.metadata,
        occurred_at: row.created_at,
      });
      activityCount += 1;
    }

    await client.query("COMMIT");
    return activityCount;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

// Read-only: counts activities that *would* be written for a lead, without
// writing anything. Mirrors migrateOneLead's activity logic exactly.
async function countPlannedActivities(client, lead) {
  let count = lead.notes && lead.notes.trim().length > 0 ? 1 : 0;
  const res = await client.query(
    `SELECT count(*)::int AS n FROM lead_activities WHERE lead_id = $1`,
    [lead.id],
  );
  count += res.rows[0].n;
  return count;
}

function printSummary({ leadsRead, toWrite, skipped, rejected }) {
  console.log(`[migrate] leads read: ${leadsRead}`);
  console.log(
    `[migrate] to write — organisations: ${toWrite.organisations}, ` +
      `contacts: ${toWrite.contacts}, opportunities: ${toWrite.opportunities}, ` +
      `activities: ${toWrite.activities}`,
  );
  console.log(`[migrate] skipped (already migrated): ${skipped}`);
  console.log(`[migrate] rejected (unnameable / unmappable): ${rejected}`);
}

async function main() {
  const { commit } = parseArgs();
  const client = makeClient();
  await client.connect();
  console.log(`[migrate] connected ${commit ? "(COMMIT)" : "(DRY RUN)"}`);

  try {
    const leadsRes = await client.query(
      `SELECT id, email, name, company, source, status, notes, owner,
              created_at, last_contacted_at, instagram_handle, phone,
              location, category, website_url, biography, tags,
              followers_count, is_starred, posts_count
         FROM leads ORDER BY created_at`,
    );
    const leads = leadsRes.rows;

    const migratedRes = await client.query(
      `SELECT migrated_from_lead_id FROM crm_opportunities
        WHERE migrated_from_lead_id IS NOT NULL`,
    );
    const migratedLeadIds = new Set(
      migratedRes.rows.map((r) => r.migrated_from_lead_id),
    );

    const { toMigrate, skipped, rejected } = planMigration(
      leads,
      migratedLeadIds,
    );

    for (const { lead, reason } of rejected) {
      console.warn(`[migrate] rejected lead ${lead.id}: ${reason}`);
    }

    if (!commit) {
      let activities = 0;
      for (const { lead } of toMigrate) {
        activities += await countPlannedActivities(client, lead);
      }
      printSummary({
        leadsRead: leads.length,
        toWrite: {
          organisations: toMigrate.length,
          contacts: toMigrate.length,
          opportunities: toMigrate.length,
          activities,
        },
        skipped: skipped.length,
        rejected: rejected.length,
      });
      console.log(`[migrate] dry run — nothing written. Pass --commit to write.`);
      return;
    }

    let written = 0;
    let activities = 0;
    const failures = [];
    for (const { lead, mapped } of toMigrate) {
      try {
        activities += await migrateOneLead(client, lead, mapped);
        written += 1;
      } catch (err) {
        failures.push({ lead, error: err.message });
        console.error(`[migrate] FAILED lead ${lead.id}: ${err.message}`);
      }
    }

    printSummary({
      leadsRead: leads.length,
      toWrite: {
        organisations: written,
        contacts: written,
        opportunities: written,
        activities,
      },
      skipped: skipped.length,
      rejected: rejected.length + failures.length,
    });
    console.log(`[migrate] committed ${written} lead(s).`);
    if (failures.length > 0) {
      console.error(`[migrate] ${failures.length} lead(s) failed and were skipped.`);
      // Exit non-zero, and it matters more than a normal "report the
      // failures" convention would suggest. 0021's guard is satisfied by a
      // SINGLE migrated row, so a run where 258 of 259 leads failed still
      // exits cleanly, still satisfies the guard, and 0021 then reinstates
      // the product CHECK — after which every remaining qualified/won/lost
      // lead with a null product is permanently un-migratable without hand
      // DDL on production. That is exactly the recovery 0021's header says
      // the guard exists to make unnecessary. A non-zero exit is what stops
      // an operator (or a deploy script running steps 2 and 3 in sequence)
      // from proceeding to 0021 on a partial backfill.
      console.error(
        `[migrate] NOT SAFE to apply 0021 — re-run this script until it exits 0.`,
      );
      throw new PartialMigrationError(failures.length);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // A partial backfill has already reported every failing lead by id; the
    // stack of the summary error adds nothing an operator can act on.
    console.error(err instanceof PartialMigrationError ? err.message : err);
    process.exit(1);
  });
}
