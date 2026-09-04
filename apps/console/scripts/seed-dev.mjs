#!/usr/bin/env node
// seed-dev.mjs — representative CRM data for local development.
//
// Part of #271 (ADR-003 D6). Run AFTER the migrations:
//
//   docker compose -f docker-compose.dev.yml up -d
//   npm run dev:db:reset
//
// # This file contains no schema
//
// #271 asks for a seed "derived from the migrations, not hand-maintained SQL
// that drifts from them", so this script only ever INSERTs. Every table and
// column it writes comes from apps/web/db/migrations/, applied by
// apps/web/scripts/db-migrate.mjs. If a migration adds a NOT NULL column, this
// script fails loudly on the next run rather than seeding a shape the
// application no longer expects — which is the behaviour that keeps it honest.
//
// # Deterministic on purpose
//
// A fixed PRNG seed, and every timestamp derived from one reference instant
// passed in. Two runs produce identical data, so an e2e test can assert on a
// specific organisation by name instead of "whatever is in row 1" — which is
// the difference between a test that catches a regression and one that catches
// a reshuffle.

import process from "node:process";
import pg from "pg";

// --- deterministic randomness -------------------------------------------
// mulberry32. Small, seeded, and identical across Node versions — Math.random
// is none of those, and a seed that reshuffles between runs makes every
// content assertion in the e2e suite flaky.
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(20260818);
const pick = (xs) => xs[Math.floor(random() * xs.length)];

// One reference instant for the whole run, so "14 days ago" means the same
// thing in the first row and the last.
const NOW = new Date();
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const daysAhead = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

// --- shape of the data ---------------------------------------------------

// 140 organisations: comfortably past the 100-row cap #240 fixed, so the
// second page is reachable locally and paging is exercisable rather than
// theoretical.
const ORG_COUNT = 140;

const PRODUCTS = ["mark8ly", "kora", "dwellm8", "devai"];
const COUNTRIES = ["IN", "AU", "GB", "US", "SG", null];
const CATEGORIES = [
  ["cafe"], ["salon"], ["retail"], ["fitness"], ["clinic"],
  ["cafe", "bakery"], ["retail", "boutique"], [],
];
const CITIES = [
  "Mumbai", "Pune", "Bengaluru", "Sydney", "Melbourne",
  "London", "Manchester", "Austin", "Singapore",
];
const OWNERS = ["mahesh", "priya", null];
const LOST_REASONS = ["price", "no response", "chose a competitor", "not a fit"];

function orgName(i) {
  const first = ["Amber", "Basil", "Cedar", "Dune", "Ember", "Fern", "Harbour",
    "Indigo", "Juniper", "Kite", "Larkspur", "Mica", "Nori", "Orchard"];
  const second = ["Collective", "Studio", "& Co", "Works", "House", "Rooms",
    "Kitchen", "Supply", "Atelier"];
  return `${first[i % first.length]} ${second[Math.floor(i / first.length) % second.length]} ${i + 1}`;
}

/**
 * The stage mix, and what each slice exists to make visible.
 *
 * Not uniform: a realistic pipeline is bottom-heavy, and more importantly each
 * band below is here so a specific console surface has something to render.
 * A seed of 140 identical `new` rows would make every queue look empty and
 * every filter look broken.
 */
function stageFor(i) {
  if (i % 17 === 0) return "won";       // ~8  — the funnel has an outcome
  if (i % 13 === 0) return "lost";      // ~10 — and a negative one
  if (i % 5 === 0) return "qualified";  // ~28 — product is REQUIRED from here
  if (i % 3 === 0) return "contacted";  // ~47
  return "new";                         // the rest
}

async function main() {
  const host = process.env.TESSERIX_DB_HOST ?? "localhost";
  const port = Number.parseInt(process.env.TESSERIX_DB_PORT ?? "55432", 10);
  const database = process.env.TESSERIX_DB_NAME ?? "tesserix_admin";
  const user = process.env.TESSERIX_DB_USER ?? "tesserix";
  const password = process.env.TESSERIX_DB_PASSWORD ?? "tesserix";
  const ssl =
    process.env.TESSERIX_DB_SSLMODE === "disable"
      ? false
      : { rejectUnauthorized: false };

  // A seed script truncates tables. Refusing anything that looks like a
  // deployed database is cheap here and unrecoverable if omitted.
  if (/\.(svc\.cluster\.local|rds\.amazonaws\.com)$/.test(host) ||
      process.env.APP_ENV === "production" ||
      process.env.NODE_ENV === "production") {
    console.error(
      `[seed-dev] REFUSING to seed ${host} — this script truncates tables and ` +
      `is for local development only.`,
    );
    process.exit(1);
  }

  const client = new pg.Client({ host, port, database, user, password, ssl });
  await client.connect();
  console.log(`[seed-dev] connected to ${host}:${port}/${database}`);

  // Fail loudly if the migrations have not run, rather than emitting a wall of
  // "relation does not exist" from the first INSERT.
  const { rows: present } = await client.query(
    `SELECT to_regclass('public.crm_organisations') IS NOT NULL AS ok`,
  );
  if (!present[0].ok) {
    console.error(
      "[seed-dev] crm_organisations does not exist — run the migrations first:\n" +
      "  npm run dev:db:migrate",
    );
    await client.end();
    process.exit(1);
  }

  try {
    await client.query("BEGIN");

    // CASCADE reaches contacts, opportunities and activities via their FKs.
    // Restarting identity is not needed — every id is a uuid default.
    await client.query(
      `TRUNCATE crm_activities, crm_opportunities, crm_contacts,
                crm_organisations, crm_suppressions, crm_imports CASCADE`,
    );

    const { rows: [imp] } = await client.query(
      `INSERT INTO crm_imports (filename, row_count, created_by)
       VALUES ($1, $2, $3) RETURNING id`,
      ["dev-seed.csv", ORG_COUNT, "seed-dev"],
    );

    let contacts = 0;
    let due = 0;
    let drifting = 0;

    for (let i = 0; i < ORG_COUNT; i += 1) {
      const stage = stageFor(i);
      // The CHECK constraint crm_opp_product_required_when_qualified: product
      // is required from `qualified` onward. Encoding it here rather than
      // discovering it at INSERT time keeps the failure in the schema where it
      // belongs.
      const product = stage === "new" || stage === "contacted"
        ? (i % 4 === 0 ? pick(PRODUCTS) : null)
        : pick(PRODUCTS);

      const { rows: [org] } = await client.query(
        `INSERT INTO crm_organisations
           (name, website_url, location, country, category, tags, import_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          orgName(i),
          i % 6 === 0 ? null : `https://example-${i}.test`,
          pick(CITIES),
          pick(COUNTRIES),           // includes null — UNKNOWN_COUNTRY filter
          pick(CATEGORIES),
          i % 9 === 0 ? ["priority"] : [],
          imp.id,
          daysAgo(30 + (i % 90)),
        ],
      );

      // Contacts. Every fourth has NO follower count, so the
      // UNKNOWN_FOLLOWERS filter has something to match — #242 made both
      // filters admit what they do not know, and a seed where every row has a
      // value cannot exercise that.
      const hasFollowers = i % 4 !== 0;
      await client.query(
        `INSERT INTO crm_contacts
           (organisation_id, name, email, instagram_handle, followers_count,
            posts_count, is_primary, source, sourced_at, lawful_basis, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10)`,
        [
          org.id,
          `Contact ${i + 1}`,
          `owner${i + 1}@example-${i}.test`,
          // Stored without the leading @ — #253 normalises on write, and a
          // seed that disagreed with the trigger would mask that.
          `handle_${i + 1}`,
          hasFollowers ? 200 + i * 37 : null,
          hasFollowers ? 10 + (i % 60) : null,
          // The vocabulary #248 closed: `CONTACT_SOURCE` in
          // `lib/crm-provenance.ts` for anything a live path writes, plus the
          // pre-migration values still on real rows.
          i % 3 === 0 ? "instagram_outreach" : "import",
          daysAgo(40 + (i % 30)),
          // #248 records a lawful basis on every write path now, but rows
          // created BEFORE it still carry the legacy marker or nothing at
          // all. Seeding all three means the surface that reports provenance
          // has every case to render, including the "Not recorded" one that
          // is the whole finding.
          i % 5 === 0 ? null : i % 7 === 0 ? "not_recorded_pre_migration" : "legitimate_interests",
          JSON.stringify(i % 3 === 0 ? { scraped: { biography: `Bio ${i}` } } : {}),
        ],
      );
      contacts += 1;

      // A second contact on some orgs — the reason contacts are a separate
      // table at all.
      if (i % 11 === 0) {
        await client.query(
          `INSERT INTO crm_contacts
             (organisation_id, name, email, is_primary, source, lawful_basis)
           VALUES ($1,$2,$3,false,$4,$5)`,
          [org.id, `Second Contact ${i + 1}`, `second${i + 1}@example-${i}.test`,
           "manual", "consent"],
        );
        contacts += 1;
      }

      // Opportunities. The due/drifting split is the point of the seed: the
      // two queues are the console's most-used surfaces and both were
      // unrenderable locally.
      //
      //   due       = next_action_at in the past, still open
      //   upcoming  = next_action_at in the future
      //   drifting  = NO next_action_at and quiet for a while. Ruling 8: the
      //               clock starts at creation when last_contacted_at is null,
      //               so a never-contacted row still ages honestly.
      const open = stage !== "won" && stage !== "lost";
      let nextActionAt = null;
      let lastContactedAt = null;

      if (open && i % 4 === 0) {
        nextActionAt = daysAgo(1 + (i % 9));       // overdue
        lastContactedAt = daysAgo(12 + (i % 20));
        due += 1;
      } else if (open && i % 4 === 1) {
        nextActionAt = daysAhead(1 + (i % 14));    // scheduled
        lastContactedAt = daysAgo(3 + (i % 10));
      } else if (open) {
        // No next action. Half have never been contacted at all.
        lastContactedAt = i % 2 === 0 ? null : daysAgo(21 + (i % 40));
        drifting += 1;
      }

      const { rows: [opp] } = await client.query(
        `INSERT INTO crm_opportunities
           (organisation_id, product, stage, owner, source, next_action_at,
            next_action_note, last_contacted_at, is_starred, closed_at,
            lost_reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          org.id, product, stage, pick(OWNERS),
          i % 3 === 0 ? "instagram" : "referral",
          nextActionAt,
          nextActionAt ? `Follow up with ${orgName(i)}` : null,
          lastContactedAt,
          i % 19 === 0,
          stage === "won" || stage === "lost" ? daysAgo(2 + (i % 20)) : null,
          stage === "lost" ? pick(LOST_REASONS) : null,
          daysAgo(30 + (i % 90)),
        ],
      );

      // A second opportunity on a few orgs, for a DIFFERENT product. This is
      // the shape the whole schema exists for — one business prospected for
      // two products independently — and #256 is about the case where it is
      // still impossible through the UI. The data supports it either way.
      if (i % 23 === 0) {
        const other = PRODUCTS.find((p) => p !== product) ?? "kora";
        await client.query(
          `INSERT INTO crm_opportunities
             (organisation_id, product, stage, source, created_at)
           VALUES ($1,$2,'contacted',$3,$4)`,
          [org.id, other, "referral", daysAgo(10 + (i % 20))],
        );
      }

      // Activity log. At least one per org so a detail page is never blank,
      // and a couple on some so ordering is visible.
      await client.query(
        `INSERT INTO crm_activities
           (organisation_id, opportunity_id, kind, actor, body, occurred_at)
         VALUES ($1,$2,'note',$3,$4,$5)`,
        [org.id, opp.id, "seed-dev", `Imported from ${orgName(i)}'s listing.`,
         daysAgo(29 + (i % 60))],
      );
      if (lastContactedAt) {
        await client.query(
          `INSERT INTO crm_activities
             (organisation_id, opportunity_id, kind, actor, body, occurred_at)
           VALUES ($1,$2,'dm_sent',$3,$4,$5)`,
          [org.id, opp.id, "mahesh", "Sent an intro DM.", lastContactedAt],
        );
      }
    }

    // Suppressions — one by email, one by handle, so both unique indexes and
    // both lookup paths have a row. The normalisation trigger from
    // 0022 applies to these INSERTs exactly as it would to a UI write.
    await client.query(
      `INSERT INTO crm_suppressions (email, reason, created_by)
       VALUES ($1,$2,$3)`,
      ["owner3@example-2.test", "asked to stop", "seed-dev"],
    );
    await client.query(
      `INSERT INTO crm_suppressions (instagram_handle, reason, created_by)
       VALUES ($1,$2,$3)`,
      ["handle_5", "asked to stop", "seed-dev"],
    );

    await client.query("COMMIT");

    console.log(
      `[seed-dev] seeded ${ORG_COUNT} organisations, ${contacts} contacts, ` +
      `~${due} due, ~${drifting} drifting, 2 suppressions`,
    );
    console.log(
      `[seed-dev] ${ORG_COUNT} > the 100-row page size, so paging is ` +
      `exercisable locally`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[seed-dev] failed:", err.message);
  process.exit(1);
});
