import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for `0047_tenant_pricing_override_coupons.sql` AND
 * `tenant-pricing-overrides-repo.ts`, against real (in-process) Postgres via
 * pglite.
 *
 * One file for both, per `promo-codes.integration.test.ts`: every invariant
 * this table has lives in the DATABASE — at most one live override per tenant
 * per mode, a coupon recorded once, a removal that is whole — and the repo's
 * job is to be thin enough that those rules reach a caller intact.
 *
 * ══ EVERY NAMED CONSTRAINT IS VIOLATED HERE, BY NAME ══
 *
 * The pattern 0046's suite copied from `plan-catalog.integration.test.ts`:
 * assert the constraint NAME appears in the rejection, so a test cannot pass
 * because some OTHER rule rejected the row first.
 *
 * Own pglite instance with `vi.mock("./tesserix")` routed into it, because a
 * mock in one test file cannot be shared with another.
 */

const dbHolder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("./tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tesserix")>();
  return {
    ...actual,
    tesserixQuery: async (sql: string, params: readonly unknown[] = []) => {
      const db = dbHolder.db as {
        query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
      };
      const result = await db.query(sql, params as unknown[]);
      return result.rows;
    },
    isDatabaseConfigured: () => true,
  };
});

const {
  readLiveTenantOverrideCoupon,
  recordTenantOverrideCoupon,
  retireTenantOverrideCoupon,
} = await import("./tenant-pricing-overrides-repo");

const MIGRATION = path.resolve(
  __dirname,
  "../../../web/db/migrations/0047_tenant_pricing_override_coupons.sql",
);

const TENANT = "mark8ly:2b0f5f9e-1f2a-4c31-9c66-6f3d2b8e5a10";
const OTHER_TENANT = "mark8ly:9a1c7d20-3e4f-4a55-8b21-0d5e6c7a8b90";

let db: PGlite;

async function applyMigration() {
  await db.exec(readFileSync(MIGRATION, "utf-8"));
}

/** The message a rejected statement produced, or "" if it was accepted. */
async function rejection(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params);
    return "";
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

const INSERT = `INSERT INTO tenant_pricing_override_coupons
  (tenant_id, mode, stripe_coupon_id, granted_by) VALUES ($1, $2, $3, $4)`;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  await applyMigration();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("TRUNCATE tenant_pricing_override_coupons");
});

describe("0047_tenant_pricing_override_coupons.sql", () => {
  it("is a no-op on a second application", async () => {
    // The regression #509 left: `db-migrate.mjs` exits on the first migration
    // that throws, so a file that cannot meet its own effect twice wedges every
    // migration after it. This file is hand-applied before its PR merges and
    // then re-attempted by the runner, which is exactly that situation.
    await expect(applyMigration()).resolves.not.toThrow();
  });

  it("refuses a bare product id in place of a namespaced tenant id", async () => {
    const message = await rejection(INSERT, [
      "2b0f5f9e-1f2a-4c31-9c66-6f3d2b8e5a10",
      "live",
      "co_1",
      "op-1",
    ]);
    expect(message).toContain("tenant_pricing_override_coupons_tenant_id_is_namespaced");
  });

  it("refuses a mode that is not a Stripe mode", async () => {
    const message = await rejection(INSERT, [TENANT, "sandbox", "co_1", "op-1"]);
    expect(message).toContain("tenant_pricing_override_coupons_mode_is_a_stripe_mode");
  });

  it("refuses a blank coupon id, which NOT NULL cannot see", async () => {
    const message = await rejection(INSERT, [TENANT, "live", "   ", "op-1"]);
    expect(message).toContain("tenant_pricing_override_coupons_coupon_id_is_not_blank");
  });

  it("refuses a blank granting operator", async () => {
    const message = await rejection(INSERT, [TENANT, "live", "co_1", ""]);
    expect(message).toContain("tenant_pricing_override_coupons_granted_by_is_not_blank");
  });

  it("refuses half a removal", async () => {
    await db.query(INSERT, [TENANT, "live", "co_1", "op-1"]);
    const message = await rejection(
      `UPDATE tenant_pricing_override_coupons SET removed_at = now()`,
    );
    expect(message).toContain("tenant_pricing_override_coupons_removal_is_whole");
  });

  it("refuses a removal timestamped before its grant", async () => {
    await db.query(INSERT, [TENANT, "live", "co_1", "op-1"]);
    const message = await rejection(
      `UPDATE tenant_pricing_override_coupons
          SET removed_at = granted_at - interval '1 day', removed_by = 'op-2'`,
    );
    expect(message).toContain("tenant_pricing_override_coupons_removal_follows_grant");
  });

  it("refuses a second LIVE override for the same tenant and mode", async () => {
    await db.query(INSERT, [TENANT, "live", "co_1", "op-1"]);
    const message = await rejection(INSERT, [TENANT, "live", "co_2", "op-1"]);
    expect(message).toContain("tenant_pricing_override_coupons_one_live_per_tenant");
  });

  it("allows a new override once the previous one is retired", async () => {
    await db.query(INSERT, [TENANT, "live", "co_1", "op-1"]);
    await db.query(
      `UPDATE tenant_pricing_override_coupons SET removed_at = now(), removed_by = 'op-2'`,
    );
    // The reason this table is not keyed on the bare pair: a tenant outlives
    // its coupons, and a removed override must not block the next grant.
    await expect(db.query(INSERT, [TENANT, "live", "co_2", "op-1"])).resolves.toBeDefined();
  });

  it("allows the same tenant an override in each mode", async () => {
    await db.query(INSERT, [TENANT, "live", "co_1", "op-1"]);
    await expect(db.query(INSERT, [TENANT, "test", "co_2", "op-1"])).resolves.toBeDefined();
  });

  it("refuses two tenants pointed at one coupon, retired or not", async () => {
    await db.query(INSERT, [TENANT, "live", "co_shared", "op-1"]);
    await db.query(
      `UPDATE tenant_pricing_override_coupons SET removed_at = now(), removed_by = 'op-2'`,
    );
    // Retiring the first row must NOT free the coupon id: removing the second
    // tenant's override would archive a coupon the first was charged against.
    const message = await rejection(INSERT, [OTHER_TENANT, "live", "co_shared", "op-1"]);
    expect(message).toContain("tenant_pricing_override_coupons_coupon_is_recorded_once");
  });

  it("lets the same coupon id exist once per mode", async () => {
    // Stripe ids are account-scoped, so `co_x` in test and `co_x` in live are
    // different objects and the uniqueness is per mode, not global.
    await db.query(INSERT, [TENANT, "live", "co_same", "op-1"]);
    await expect(
      db.query(INSERT, [OTHER_TENANT, "test", "co_same", "op-1"]),
    ).resolves.toBeDefined();
  });
});

describe("tenant-pricing-overrides-repo", () => {
  it("records a mint and reads it back", async () => {
    const recorded = await recordTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_1",
      grantedBy: "op-1",
    });

    expect(recorded).toMatchObject({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_1",
      grantedBy: "op-1",
      removedBy: null,
      removedAt: null,
    });
    expect(recorded.grantedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const read = await readLiveTenantOverrideCoupon(TENANT, "live");
    expect(read?.stripeCouponId).toBe("co_live_1");
  });

  it("reads null for a tenant with nothing minted in that mode", async () => {
    await recordTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_1",
      grantedBy: "op-1",
    });

    // Per mode, not per tenant: a live coupon must not make the console think
    // the tenant already has a test one.
    expect(await readLiveTenantOverrideCoupon(TENANT, "test")).toBeNull();
    expect(await readLiveTenantOverrideCoupon(OTHER_TENANT, "live")).toBeNull();
  });

  it("stops seeing an override once it is retired", async () => {
    await recordTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_1",
      grantedBy: "op-1",
    });
    await db.query(
      `UPDATE tenant_pricing_override_coupons SET removed_at = now(), removed_by = 'op-2'`,
    );

    // The read and 0047's partial index have to agree about which rows count,
    // or the console refuses a grant the database would have accepted.
    expect(await readLiveTenantOverrideCoupon(TENANT, "live")).toBeNull();
  });

  it("does not paper over a second live mint — the index refuses it", async () => {
    await recordTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_1",
      grantedBy: "op-1",
    });

    // No `ON CONFLICT`: overwriting the id would orphan a coupon that is still
    // live in a real Stripe account.
    await expect(
      recordTenantOverrideCoupon({
        tenantId: TENANT,
        mode: "live",
        stripeCouponId: "co_live_2",
        grantedBy: "op-1",
      }),
    ).rejects.toThrow(/one_live_per_tenant/);
  });

  it("retires a live override, setting both halves of the retirement", async () => {
    const recorded = await recordTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_1",
      grantedBy: "op-1",
    });

    const retired = await retireTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      removedBy: "op-2",
    });

    // The same row, not a new one: the id has to carry over, because the
    // retired row is what still names the Stripe coupon the caller then goes
    // and deletes.
    expect(retired).toMatchObject({
      id: recorded.id,
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_1",
      grantedBy: "op-1",
      removedBy: "op-2",
    });
    // Both halves, or 0047's `removal_is_whole` biconditional would have
    // rejected the UPDATE outright.
    expect(retired?.removedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("retires per (tenant, mode), leaving the other mode alone", async () => {
    await recordTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_1",
      grantedBy: "op-1",
    });
    await recordTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "test",
      stripeCouponId: "co_test_1",
      grantedBy: "op-1",
    });

    await retireTenantOverrideCoupon({ tenantId: TENANT, mode: "live", removedBy: "op-2" });

    // A `test` coupon id is meaningless against the live account (0047), so
    // retiring one account's override must not touch the other's.
    expect(await readLiveTenantOverrideCoupon(TENANT, "live")).toBeNull();
    expect((await readLiveTenantOverrideCoupon(TENANT, "test"))?.stripeCouponId).toBe(
      "co_test_1",
    );
  });

  it("returns null when there is no live override to retire", async () => {
    // Null is an answer, not a failure — nothing was minted for this tenant in
    // this mode, so there is nothing to retire and no error to raise.
    expect(
      await retireTenantOverrideCoupon({
        tenantId: OTHER_TENANT,
        mode: "live",
        removedBy: "op-2",
      }),
    ).toBeNull();
  });

  it("returns null for an already-retired override, keeping the first retirement", async () => {
    await recordTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_1",
      grantedBy: "op-1",
    });

    const first = await retireTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      removedBy: "op-2",
    });
    const second = await retireTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      removedBy: "op-3",
    });

    // The `removed_at IS NULL` in the WHERE is what makes this true: the loser
    // of a double revoke matches zero rows rather than overwriting the operator
    // and timestamp the first one recorded.
    expect(second).toBeNull();

    const rows = await db.query<{ removed_by: string; removed_at: Date }>(
      `SELECT removed_by, removed_at FROM tenant_pricing_override_coupons`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].removed_by).toBe("op-2");
    expect(rows.rows[0].removed_at.toISOString()).toBe(first?.removedAt);
  });

  it("frees the tenant for a corrected grant once the override is retired", async () => {
    // #581 end to end: a mis-keyed override is uncorrectable while its row
    // stays live, because 0047's partial unique index counts it.
    await recordTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_wrong",
      grantedBy: "op-1",
    });

    await retireTenantOverrideCoupon({ tenantId: TENANT, mode: "live", removedBy: "op-2" });

    expect(await readLiveTenantOverrideCoupon(TENANT, "live")).toBeNull();
    const corrected = await recordTenantOverrideCoupon({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_right",
      grantedBy: "op-2",
    });
    expect(corrected.stripeCouponId).toBe("co_right");
    expect((await readLiveTenantOverrideCoupon(TENANT, "live"))?.stripeCouponId).toBe(
      "co_right",
    );
  });
});
