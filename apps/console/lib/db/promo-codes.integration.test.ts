import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for `0046_promo_codes.sql` AND `promo-codes-repo.ts`,
 * against real (in-process) Postgres via pglite.
 *
 * One file for both, because the claims are one claim. Every invariant this
 * feature has lives in the DATABASE — the canonical upper-case form, "at least
 * one effect", the uniqueness of a code — and the repo's job is to be a thin
 * enough layer that those rules reach a caller intact. Asserting the migration
 * in one file and mocking it away in another would leave nothing testing the
 * seam, which is exactly where a repo that quietly `lower()`s a code, or
 * pre-empts a CHECK with a friendlier early return, would hide.
 *
 * ══ EVERY NAMED CONSTRAINT IS VIOLATED HERE, BY NAME ══
 *
 * `plan-catalog.integration.test.ts` pins
 * `plan_catalog_amounts_currency_is_lowercase_iso_4217` by inserting `USD` and
 * asserting the constraint NAME appears in the rejection, and that is the
 * pattern copied below for all six of 0046's. A constraint nobody tries to
 * violate is a comment with SQL syntax — and asserting the name rather than
 * merely "it threw" is what stops a test passing because some OTHER rule
 * happened to reject the row first.
 *
 * Own pglite instance, and `vi.mock("./tesserix")` routed into it, per
 * `crm-templates.integration.test.ts` — a mock in one test file cannot be
 * shared with another.
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
  normalisePromoCode,
  createPromoCode,
  readPromoCodeByCode,
  listPromoCodes,
  updatePromoCode,
  deactivatePromoCode,
  recordStripeCoupon,
  readStripeCoupons,
  DEFAULT_PROMO_CODE_SOURCE,
} = await import("./promo-codes-repo");

type Discount = import("./promo-codes-repo").PromoCodeDiscount;

/** The shortest valid terms, for the many cases that need SOME discount and do
 *  not care which. */
const PERCENT_OFF: Discount = { kind: "percent_off", percentOff: 25, duration: "once", durationInMonths: null };

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../web/db/migrations/0046_promo_codes.sql",
);

const ACTOR = "operator@tesserix.app";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  // Loaded on its own: `promo_codes` references nothing outside itself, which
  // is itself worth knowing — the definitions are a standalone table, not
  // something wired into the plan catalog's revision graph.
  await db.exec(readFileSync(MIGRATION_PATH, "utf-8"));
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // CASCADE because `promo_code_stripe_coupons` has an FK onto this table; a
  // bare TRUNCATE errors rather than leaving the child rows behind.
  await db.query("TRUNCATE promo_codes CASCADE");
});

/** Raw insert, bypassing the repo, for the cases that are about the SCHEMA
 *  refusing a row rather than about what the repo sends. */
async function insertRaw(columns: Record<string, unknown>): Promise<void> {
  const names = Object.keys(columns);
  const placeholders = names.map((_, i) => `$${i + 1}`);
  await db.query(
    `INSERT INTO promo_codes (${names.join(", ")}) VALUES (${placeholders.join(", ")})`,
    Object.values(columns),
  );
}

describe("normalisePromoCode", () => {
  it("produces a form the database's own CHECKs accept", async () => {
    // Asserted against POSTGRES, not against a second hand-written expectation.
    // The point is that the TypeScript's output is storable, and only the
    // engine can say that. A test comparing `normalisePromoCode` to a literal
    // would keep passing while the two definitions drifted.
    //
    // THIS TEST ALREADY EARNED ITS KEEP. The first version of 0046 spelled the
    // rule `code = upper(btrim(code))`, which reads as the exact mirror of
    // `raw.trim().toUpperCase()` and is not: Postgres `btrim(text)` strips
    // SPACES ONLY, JavaScript's `trim()` strips all whitespace. `\tlaunch50\n`
    // was therefore storable un-normalised, past a unique index that could not
    // see it collide with the `LAUNCH50` the repo would write for the same
    // input. See 0046's header for the two constraints that replaced it.
    for (const raw of ["  launch50 ", "Launch50", "LAUNCH50", "\tlaunch50\n", " promo "]) {
      const normalised = normalisePromoCode(raw);
      const { rows } = await db.query<{ upper_case: boolean; unspaced: boolean }>(
        "SELECT $1::text = upper($1::text) AS upper_case, $1::text ~ '^\\S+$' AS unspaced",
        [normalised],
      );
      expect(rows[0]).toEqual({ upper_case: true, unspaced: true });
    }
  });

  it("does not strip interior whitespace — the database refuses that, loudly", async () => {
    // Padding is a copy-paste artefact and safe to discard silently; a space in
    // the middle is part of what the operator typed and must not be rewritten
    // under them.
    expect(normalisePromoCode("  launch 50  ")).toBe("LAUNCH 50");
    await expect(
      createPromoCode({ code: " launch 50 ", trialExtensionDays: 30, createdBy: ACTOR }),
    ).rejects.toThrow(/promo_codes_code_has_no_whitespace/);
  });
});

describe("round trip", () => {
  it("stores a definition and reads it back whole", async () => {
    const created = await createPromoCode({
      code: "  launch50  ",
      trialExtensionDays: 30,
      discount: {
        kind: "amount_off",
        amountOffMinor: 1500,
        currency: "usd",
        duration: "repeating",
        durationInMonths: 3,
      },
      validFrom: new Date("2026-09-01T00:00:00Z"),
      validUntil: new Date("2026-12-31T00:00:00Z"),
      maxRedemptions: 100,
      createdBy: ACTOR,
    });

    expect(created).toMatchObject({
      source: DEFAULT_PROMO_CODE_SOURCE,
      code: "LAUNCH50",
      trialExtensionDays: 30,
      discount: {
        kind: "amount_off",
        amountOffMinor: 1500,
        currency: "usd",
        duration: "repeating",
        durationInMonths: 3,
      },
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: "2026-12-31T00:00:00.000Z",
      maxRedemptions: 100,
      isActive: true,
      createdBy: ACTOR,
    });

    // The read is what redemption actually does, and it is given the code in a
    // shape no operator would type twice the same way.
    expect(await readPromoCodeByCode(" LaUnCh50 ")).toEqual(created);
  });

  it("defaults the window start, expiry, cap and active flag", async () => {
    const before = Date.now();
    const created = await createPromoCode({
      code: "EVERGREEN",
      trialExtensionDays: 14,
      createdBy: ACTOR,
    });

    // Null expiry is "no expiry", null cap is "uncapped" — 0046's header. Both
    // asserted so a later NOT NULL DEFAULT cannot quietly change the meaning.
    expect(created.validUntil).toBeNull();
    expect(created.maxRedemptions).toBeNull();
    // Terms absent is a trial-extension-only code, not an incomplete one.
    expect(created.discount).toBeNull();
    expect(created.isActive).toBe(true);
    expect(Date.parse(created.validFrom)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("returns null for a code that does not exist", async () => {
    expect(await readPromoCodeByCode("NOPE")).toBeNull();
  });

  it("finds an inactive or expired code, rather than pretending it is absent", async () => {
    // "Expired" and "never existed" want different copy at the boundary, so
    // the read must not collapse them. This is the assertion that stops a
    // future `AND is_active AND now() < valid_until` being added to the
    // lookup as a convenience.
    const created = await createPromoCode({
      code: "LAPSED",
      trialExtensionDays: 7,
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2020-02-01T00:00:00Z"),
      isActive: false,
      createdBy: ACTOR,
    });
    const found = await readPromoCodeByCode("lapsed");
    expect(found).toEqual(created);
    expect(found?.isActive).toBe(false);
  });
});

describe("listPromoCodes", () => {
  beforeEach(async () => {
    await createPromoCode({ code: "LIVE_A", trialExtensionDays: 7, createdBy: ACTOR });
    await createPromoCode({ code: "LIVE_B", discount: PERCENT_OFF, createdBy: ACTOR });
    await createPromoCode({
      code: "RETIRED",
      trialExtensionDays: 1,
      isActive: false,
      createdBy: ACTOR,
    });
  });

  it("excludes inactive definitions by default", async () => {
    const codes = (await listPromoCodes()).map((r) => r.code);
    expect(codes.sort()).toEqual(["LIVE_A", "LIVE_B"]);
  });

  it("includes them on request", async () => {
    const codes = (await listPromoCodes({ includeInactive: true })).map((r) => r.code);
    expect(codes.sort()).toEqual(["LIVE_A", "LIVE_B", "RETIRED"]);
  });

  it("filters by source", async () => {
    expect(
      (await listPromoCodes({ source: DEFAULT_PROMO_CODE_SOURCE })).map((r) => r.code).sort(),
    ).toEqual(["LIVE_A", "LIVE_B"]);
  });
});

describe("updatePromoCode", () => {
  it("changes only the fields it was given, and bumps updated_at", async () => {
    const created = await createPromoCode({
      code: "AMEND",
      trialExtensionDays: 30,
      discount: PERCENT_OFF,
      maxRedemptions: 10,
      createdBy: ACTOR,
    });

    const updated = await updatePromoCode(created.id, { maxRedemptions: 25 });

    expect(updated).toMatchObject({
      id: created.id,
      code: "AMEND",
      trialExtensionDays: 30,
      discount: PERCENT_OFF,
      maxRedemptions: 25,
    });
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));
  });

  it("distinguishes 'leave alone' from 'clear it'", async () => {
    // The distinction the `undefined` vs `null` shape exists for. Collapsing
    // them is how a partial update from a form silently wipes the redemption
    // cap of every code it touches — and the row stays VALID, so nothing fails
    // loudly: an uncapped code is a perfectly legal one, it is just not the one
    // the operator authored.
    const created = await createPromoCode({
      code: "CLEARABLE",
      trialExtensionDays: 30,
      maxRedemptions: 100,
      validUntil: new Date("2026-12-31T00:00:00Z"),
      createdBy: ACTOR,
    });

    const untouched = await updatePromoCode(created.id, { trialExtensionDays: 45 });
    expect(untouched?.maxRedemptions).toBe(100);
    expect(untouched?.validUntil).toBe("2026-12-31T00:00:00.000Z");

    const cleared = await updatePromoCode(created.id, { maxRedemptions: null });
    expect(cleared?.maxRedemptions).toBeNull();
    expect(cleared?.trialExtensionDays).toBe(45);
  });

  it("cannot change the discount terms — a minted Stripe coupon is immutable", async () => {
    // Not an omission. A Stripe Coupon's percent_off / amount_off / duration
    // cannot be changed after creation, so an edit here would leave the row
    // describing a discount different from the one Stripe applies, with nothing
    // to reconcile them. `UpdatePromoCodeInput` has no such field, and this
    // asserts that a caller reaching for one is a TYPE error rather than a
    // silent no-op — which is what a plain `updatePromoCode(id, { discount })`
    // would be, since the dynamic SET skips keys it does not know.
    const created = await createPromoCode({
      code: "IMMUTABLE",
      discount: PERCENT_OFF,
      createdBy: ACTOR,
    });

    // @ts-expect-error `discount` is deliberately not an updatable field.
    await updatePromoCode(created.id, { discount: null });

    expect((await readPromoCodeByCode("IMMUTABLE"))!.discount).toEqual(PERCENT_OFF);
  });

  it("returns null for an unknown id and for an empty change set", async () => {
    const created = await createPromoCode({
      code: "PRESENT",
      trialExtensionDays: 1,
      createdBy: ACTOR,
    });
    expect(await updatePromoCode("00000000-0000-0000-0000-000000000000", { isActive: false }))
      .toBeNull();
    // No UPDATE is issued at all — an `updated_at = now()` with no other
    // change would record an amendment that did not happen.
    expect(await updatePromoCode(created.id, {})).toBeNull();
    expect((await readPromoCodeByCode("PRESENT"))!.updatedAt).toBe(created.updatedAt);
  });
});

describe("deactivatePromoCode", () => {
  it("retires a live definition and reports the row", async () => {
    const created = await createPromoCode({
      code: "RETIRE_ME",
      trialExtensionDays: 3,
      createdBy: ACTOR,
    });
    const [row] = await deactivatePromoCode(created.id);
    expect(row.isActive).toBe(false);
    // Deactivated, NEVER deleted: mark8ly's ledger references the code that was
    // redeemed, so the definition has to stay resolvable.
    expect(await readPromoCodeByCode("RETIRE_ME")).not.toBeNull();
  });

  it("reports nothing on a second deactivation or an unknown id", async () => {
    const created = await createPromoCode({
      code: "ONCE",
      trialExtensionDays: 3,
      createdBy: ACTOR,
    });
    expect(await deactivatePromoCode(created.id)).toHaveLength(1);
    // `WHERE ... AND is_active` matched nothing, so the caller's audit row says
    // `{ deactivated: 0 }` rather than recording a retirement that did not
    // happen.
    expect(await deactivatePromoCode(created.id)).toEqual([]);
    expect(await deactivatePromoCode("00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});

describe("constraints", () => {
  it("rejects a lower-case code — the canonical form is the database's rule", async () => {
    // The repo normalises, so this has to bypass it. That is the point: the
    // CHECK is what makes the un-normalised form UNSTORABLE by a script, a
    // second surface, or a psql session, rather than merely discouraged.
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "launch50",
        trial_extension_days: 30,
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_code_is_upper_case/);
  });

  it("rejects a padded code, an empty one, and a tab-padded one", async () => {
    // The third case is the one `code = upper(btrim(code))` let through, since
    // Postgres `btrim` strips spaces only. All three are one rule now.
    for (const code of [" LAUNCH50", "", "\tLAUNCH50\n", "LAUNCH 50"]) {
      await expect(
        insertRaw({ source: "mark8ly", code, trial_extension_days: 30, created_by: ACTOR }),
      ).rejects.toThrow(/promo_codes_code_has_no_whitespace/);
    }
  });

  it("rejects a definition with neither effect", async () => {
    // A code that does nothing: accepted at redemption, silently rewarding the
    // merchant with neither a longer trial nor a discount and no error to
    // explain it.
    await expect(
      insertRaw({ source: "mark8ly", code: "INERT", created_by: ACTOR }),
    ).rejects.toThrow(/promo_codes_has_at_least_one_effect/);

    // …and through the repo, which does NOT pre-empt the rule with a friendlier
    // early return. If it ever does, this assertion is what notices.
    await expect(createPromoCode({ code: "INERT", createdBy: ACTOR })).rejects.toThrow(
      /promo_codes_has_at_least_one_effect/,
    );
  });

  it("rejects a duplicate code", async () => {
    await createPromoCode({ code: "DUPE", trialExtensionDays: 5, createdBy: ACTOR });
    // Case-differing, because that is the duplicate the unique index could not
    // see without the canonical form. Both spellings normalise to `DUPE`, so
    // the second insert collides rather than creating a second live code whose
    // winner depends on row order.
    await expect(
      createPromoCode({ code: " dupe ", discount: PERCENT_OFF, createdBy: ACTOR }),
    ).rejects.toThrow(/promo_codes_code_unique/);
  });

  it("rejects a zero or negative trial extension", async () => {
    // 0 is an extension that extends nothing — a value that reads as "set"
    // while behaving as "unset", which is the expensive direction.
    await expect(
      insertRaw({ source: "mark8ly", code: "ZERODAYS", trial_extension_days: 0, created_by: ACTOR }),
    ).rejects.toThrow(/promo_codes_trial_extension_is_positive/);

    await expect(
      insertRaw({ source: "mark8ly", code: "NEGDAYS", trial_extension_days: -1, created_by: ACTOR }),
    ).rejects.toThrow(/promo_codes_trial_extension_is_positive/);
  });

  it("rejects a non-positive redemption cap", async () => {
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "ZEROCAP",
        trial_extension_days: 1,
        max_redemptions: 0,
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_max_redemptions_is_positive/);
  });

  it("rejects a window that ends before — or exactly when — it begins", async () => {
    // Both are the same unredeemable row that renders as live; the second is
    // the subtler typo, and `>` rather than `>=` is what catches it.
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "BACKWARDS",
        trial_extension_days: 1,
        valid_from: "2026-12-01T00:00:00Z",
        valid_until: "2026-11-01T00:00:00Z",
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_validity_window_is_ordered/);

    await expect(
      insertRaw({
        source: "mark8ly",
        code: "INSTANT",
        trial_extension_days: 1,
        valid_from: "2026-12-01T00:00:00Z",
        valid_until: "2026-12-01T00:00:00Z",
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_validity_window_is_ordered/);
  });

  it("rejects a definition with terms but neither a percent-off nor an amount-off", async () => {
    // Stripe refuses a coupon with neither, so this row is one that can never
    // be materialised — discovered at publish time, against a live account, by
    // whoever is publishing rather than whoever authored it.
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "NOAMOUNT",
        discount_duration: "once",
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_is_percent_off_xor_amount_off/);
  });

  it("rejects a definition carrying BOTH a percent-off and an amount-off", async () => {
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "BOTH",
        discount_duration: "once",
        discount_percent_off: 10,
        discount_amount_off: 500,
        discount_currency: "usd",
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_is_percent_off_xor_amount_off/);
  });

  it("rejects an amount-off with no currency, and a percent-off that carries one", async () => {
    // ONE biconditional, so both halves are the same named failure. A
    // percent-off with a currency is not harmless: it renders as a
    // currency-scoped discount and is not one.
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "NOCURRENCY",
        discount_duration: "once",
        discount_amount_off: 500,
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_currency_accompanies_amount_off/);

    await expect(
      insertRaw({
        source: "mark8ly",
        code: "PCTCURRENCY",
        discount_duration: "once",
        discount_percent_off: 10,
        discount_currency: "usd",
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_currency_accompanies_amount_off/);
  });

  it("rejects an upper-case discount currency", async () => {
    // The same Stripe fact `plan_catalog_amounts_currency_is_lowercase_iso_4217`
    // encodes, one table over.
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "LOUDCCY",
        discount_duration: "once",
        discount_amount_off: 500,
        discount_currency: "USD",
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_currency_is_lowercase_iso_4217/);
  });

  it("rejects loose discount fields with no duration to anchor them", async () => {
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "ORPHANTERMS",
        trial_extension_days: 5,
        discount_percent_off: 10,
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_terms_are_all_or_nothing/);
  });

  it("rejects an unknown duration", async () => {
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "WEEKLY",
        discount_duration: "monthly",
        discount_percent_off: 10,
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_duration_is_a_stripe_duration/);
  });

  it("rejects a percent-off outside (0, 100]", async () => {
    for (const percent of [0, 100.01]) {
      await expect(
        insertRaw({
          source: "mark8ly",
          code: "BADPCT",
          discount_duration: "once",
          discount_percent_off: percent,
          created_by: ACTOR,
        }),
      ).rejects.toThrow(/promo_codes_discount_percent_off_is_in_range/);
    }
  });

  it("rejects a non-positive amount-off", async () => {
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "ZEROAMT",
        discount_duration: "once",
        discount_amount_off: 0,
        discount_currency: "usd",
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_amount_off_is_positive/);
  });

  it("requires duration_in_months for repeating and refuses it for the others", async () => {
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "REPEATNOMONTHS",
        discount_duration: "repeating",
        discount_percent_off: 10,
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_months_iff_repeating/);

    for (const duration of ["once", "forever"]) {
      await expect(
        insertRaw({
          source: "mark8ly",
          code: "MONTHSANYWAY",
          discount_duration: duration,
          discount_percent_off: 10,
          discount_duration_in_months: 3,
          created_by: ACTOR,
        }),
      ).rejects.toThrow(/promo_codes_discount_months_iff_repeating/);
    }
  });

  it("refuses months on a code with NO terms at all — the rule is total on its own", async () => {
    // This is what `IS NOT DISTINCT FROM` buys over a plain `=`. With `=`, a
    // NULL `discount_duration` makes the comparison NULL and the CHECK PASSES,
    // leaving this row to be caught only by `..._terms_are_all_or_nothing` —
    // i.e. a constraint correct only because a different constraint exists.
    // Asserted by NAME, so the mutation to `=` fails here rather than silently
    // passing on the other rule's rejection.
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "MONTHSNOTERMS",
        trial_extension_days: 5,
        discount_duration_in_months: 3,
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_months_iff_repeating/);
  });

  it("rejects a non-positive duration_in_months", async () => {
    await expect(
      insertRaw({
        source: "mark8ly",
        code: "ZEROMONTHS",
        discount_duration: "repeating",
        discount_percent_off: 10,
        discount_duration_in_months: 0,
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_discount_months_is_positive/);
  });

  it("rejects an unknown source", async () => {
    await expect(
      insertRaw({
        source: "acme",
        code: "FOREIGN",
        trial_extension_days: 1,
        created_by: ACTOR,
      }),
    ).rejects.toThrow(/promo_codes_source_is_a_known_source/);
  });
});

describe("promo_code_stripe_coupons", () => {
  it("records one coupon per mode and reads them back in STRIPE_MODES order", async () => {
    const created = await createPromoCode({
      code: "MINTED",
      discount: PERCENT_OFF,
      createdBy: ACTOR,
    });

    // Inserted live-first, read back test-first, so the ordering assertion is
    // about `array_position` rather than about insertion order.
    await recordStripeCoupon({
      promoCodeId: created.id,
      mode: "live",
      stripeCouponId: "co_live_minted",
      createdBy: ACTOR,
    });
    await recordStripeCoupon({
      promoCodeId: created.id,
      mode: "test",
      stripeCouponId: "co_test_minted",
      createdBy: ACTOR,
    });

    expect(
      (await readStripeCoupons(created.id)).map((c) => [c.mode, c.stripeCouponId]),
    ).toEqual([
      ["test", "co_test_minted"],
      ["live", "co_live_minted"],
    ]);
  });

  it("returns [] for a definition minted nowhere — the normal state, not a defect", async () => {
    // The whole point of the split: terms authored, no account touched yet.
    const created = await createPromoCode({
      code: "UNMINTED",
      discount: PERCENT_OFF,
      createdBy: ACTOR,
    });
    expect(created.discount).toEqual(PERCENT_OFF);
    expect(await readStripeCoupons(created.id)).toEqual([]);
  });

  it("refuses a second coupon in the same mode, rather than orphaning the first", async () => {
    // An overwrite would leave the first coupon live in Stripe, still
    // redeemable by anyone holding it, and no longer named by anything in this
    // database.
    const created = await createPromoCode({
      code: "TWICE",
      discount: PERCENT_OFF,
      createdBy: ACTOR,
    });
    await recordStripeCoupon({
      promoCodeId: created.id,
      mode: "test",
      stripeCouponId: "co_first",
      createdBy: ACTOR,
    });
    await expect(
      recordStripeCoupon({
        promoCodeId: created.id,
        mode: "test",
        stripeCouponId: "co_second",
        createdBy: ACTOR,
      }),
    ).rejects.toThrow(/promo_code_stripe_coupons_pkey/);

    expect((await readStripeCoupons(created.id))[0].stripeCouponId).toBe("co_first");
  });

  it("rejects an unknown mode and a blank coupon id", async () => {
    const created = await createPromoCode({
      code: "GUARDED",
      discount: PERCENT_OFF,
      createdBy: ACTOR,
    });

    await expect(
      db.query(
        `INSERT INTO promo_code_stripe_coupons (promo_code_id, mode, stripe_coupon_id, created_by)
         VALUES ($1, 'sandbox', 'co_x', $2)`,
        [created.id, ACTOR],
      ),
    ).rejects.toThrow(/promo_code_stripe_coupons_mode_is_a_stripe_mode/);

    // `''` is NOT NULL, so without this CHECK it records a materialisation that
    // did not happen, in the one spelling NOT NULL cannot see.
    await expect(
      recordStripeCoupon({
        promoCodeId: created.id,
        mode: "test",
        stripeCouponId: "",
        createdBy: ACTOR,
      }),
    ).rejects.toThrow(/promo_code_stripe_coupons_coupon_id_is_not_blank/);
  });

  it("refuses a coupon against a definition that does not exist", async () => {
    await expect(
      recordStripeCoupon({
        promoCodeId: "00000000-0000-0000-0000-000000000000",
        mode: "test",
        stripeCouponId: "co_ghost",
        createdBy: ACTOR,
      }),
    ).rejects.toThrow(/promo_code_stripe_coupons_promo_code_id_fkey/);
  });
});

describe("re-runnability", () => {
  it("applies cleanly onto a database that already has its effect", async () => {
    // The runner applies files in version order and aborts on the first that
    // throws, so a migration that cannot meet its own effect twice wedges every
    // migration after it — tesserix-home#509, four migrations and one subsystem
    // away from its symptom.
    const fresh = new PGlite();
    try {
      const sql = readFileSync(MIGRATION_PATH, "utf-8");
      await fresh.exec(sql);
      await expect(fresh.exec(sql)).resolves.toBeDefined();

      // …and the second run left the table as the first created it. Asserted by
      // constraint NAME because `CREATE TABLE IF NOT EXISTS` skips on the table
      // name alone: it would also no-op over a pre-existing table of an
      // entirely different shape.
      const { rows } = await fresh.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'promo_codes'::regclass AND contype = 'c'
          ORDER BY conname`,
      );
      expect(rows.map((r) => r.conname)).toEqual([
        "promo_codes_code_has_no_whitespace",
        "promo_codes_code_is_upper_case",
        "promo_codes_discount_amount_off_is_positive",
        "promo_codes_discount_currency_accompanies_amount_off",
        "promo_codes_discount_currency_is_lowercase_iso_4217",
        "promo_codes_discount_duration_is_a_stripe_duration",
        "promo_codes_discount_is_percent_off_xor_amount_off",
        "promo_codes_discount_months_iff_repeating",
        "promo_codes_discount_months_is_positive",
        "promo_codes_discount_percent_off_is_in_range",
        "promo_codes_discount_terms_are_all_or_nothing",
        "promo_codes_has_at_least_one_effect",
        "promo_codes_max_redemptions_is_positive",
        "promo_codes_source_is_a_known_source",
        "promo_codes_trial_extension_is_positive",
        "promo_codes_validity_window_is_ordered",
      ]);
    } finally {
      await fresh.close();
    }
  });
});
