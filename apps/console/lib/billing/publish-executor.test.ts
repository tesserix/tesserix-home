import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { MARK8LY_LOOKUP_KEY_PREFIX, type CatalogAmount, type StripePriceLike, type TaxBehavior } from "./parity";
import { buildPublishPlan } from "./publish-plan";
import { checkGuards } from "./publish-guards";
import type { CreatePriceSpec, StripeCatalogWriter, StripeProductRef, StripePriceRef } from "./mark8ly/stripe-write";
import type { PublishAttempt, StripeCall } from "@/lib/db/publish-repo";
import { executePublish, type PublishExecutorDeps } from "./publish-executor";

/**
 * `executePublish`'s whole test surface: every dependency is injected (see
 * `PublishExecutorDeps` in `publish-executor.ts`), so this file never touches
 * a real database or the network — no `tesserixTx`, no `stripe` import, no
 * `vi.mock("stripe")`. It exercises the SAME six behaviours Task 6's brief
 * names: write-ahead ordering, a crash between write and call, abort on a
 * moved fingerprint, the archive/create id split on `replace_price`, the
 * attempt folded into every idempotency key, and one operation's failure not
 * stopping the rest.
 */

// ---------------------------------------------------------------------------
// Fixture builders — same shapes `publish-plan.test.ts` already uses.
// ---------------------------------------------------------------------------

function amount(
  lookupKey: string,
  currency: string,
  unitAmountMinor: number,
  taxBehavior: TaxBehavior = "unspecified",
): CatalogAmount {
  return { lookupKey, currency, unitAmountMinor, taxBehavior };
}

function price(overrides: {
  lookup_key: string;
  currency: string;
  unit_amount: number;
  id?: string;
  tax_behavior?: TaxBehavior;
  currency_options?: StripePriceLike["currency_options"];
}): StripePriceLike {
  return {
    id: overrides.id ?? `price_${overrides.lookup_key}`,
    lookup_key: overrides.lookup_key,
    currency: overrides.currency,
    unit_amount: overrides.unit_amount,
    tax_behavior: overrides.tax_behavior ?? "unspecified",
    active: true,
    currency_options: overrides.currency_options,
  };
}

const KEY_A = `${MARK8LY_LOOKUP_KEY_PREFIX}starter_monthly_developed_v1`;
const KEY_B = `${MARK8LY_LOOKUP_KEY_PREFIX}starter_monthly_ppp_inr_v1`;
const KEY_C = `${MARK8LY_LOOKUP_KEY_PREFIX}starter_monthly_ppp_brl_v1`;

// ---------------------------------------------------------------------------
// A fake operation log — mirrors `publish-repo.ts`'s `recordOperation` /
// `completeOperation` contract (write-ahead insert, then a terminal update)
// without a database, so the "row exists before Stripe is called" and "row
// stays pending" tests can inspect it directly.
// ---------------------------------------------------------------------------

interface FakeOperationRow {
  readonly id: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly stripeCall: StripeCall;
  readonly lookupKey: string | null;
  status: "pending" | "succeeded" | "failed";
  stripePriceId: string | null;
  error: string | null;
  idempotencyKey: string;
}

function makeFakeLog() {
  const rows: FakeOperationRow[] = [];
  let completeOperationImpl: PublishExecutorDeps["completeOperation"] = async (operationId, completion) => {
    const row = rows.find((r) => r.id === operationId);
    if (!row) throw new Error(`no such operation ${operationId}`);
    if (completion.status === "succeeded") {
      row.status = "succeeded";
      if (completion.stripePriceId) row.stripePriceId = completion.stripePriceId;
    } else {
      row.status = "failed";
      row.error = completion.error;
    }
  };

  const recordOperation: PublishExecutorDeps["recordOperation"] = async (input) => {
    const id = randomUUID();
    rows.push({
      id,
      attemptId: input.attemptId,
      sequence: input.sequence,
      stripeCall: input.stripeCall,
      lookupKey: input.lookupKey ?? null,
      status: "pending",
      stripePriceId: input.stripePriceId ?? null,
      error: null,
      idempotencyKey: input.idempotencyKey,
    });
    return id;
  };

  const completeOperation: PublishExecutorDeps["completeOperation"] = async (operationId, completion) =>
    completeOperationImpl(operationId, completion);

  return {
    rows,
    recordOperation,
    completeOperation,
    /** Swap in a completion handler that throws — models a crash between the
     *  write-ahead insert and the terminal update landing. */
    breakCompletion(): void {
      completeOperationImpl = async () => {
        throw new Error("simulated: the database connection died writing the completion");
      };
    },
  };
}

// ---------------------------------------------------------------------------
// A fake attempt store — mirrors `publishAttemptById` / `finishPublishAttempt`.
// ---------------------------------------------------------------------------

function makeFakeAttempts() {
  const attempts = new Map<string, PublishAttempt>();

  function start(fingerprint: string, overrides: Partial<PublishAttempt> = {}): PublishAttempt {
    const attempt: PublishAttempt = {
      id: randomUUID(),
      revisionId: randomUUID(),
      mode: "test",
      fingerprint,
      startedBy: "operator@example.com",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: null,
      ...overrides,
    };
    attempts.set(attempt.id, attempt);
    return attempt;
  }

  const getAttempt: PublishExecutorDeps["getAttempt"] = async (id) => attempts.get(id) ?? null;

  const finishPublishAttempt: PublishExecutorDeps["finishPublishAttempt"] = async (id, outcome) => {
    const existing = attempts.get(id);
    if (!existing) throw new Error(`no such attempt ${id}`);
    attempts.set(id, { ...existing, outcome, finishedAt: new Date().toISOString() });
  };

  return { attempts, start, getAttempt, finishPublishAttempt };
}

// ---------------------------------------------------------------------------
// A fake Stripe writer — no network, no `stripe` import. `seen` records call
// order across BOTH the log and the writer, for the write-ahead ordering
// test.
// ---------------------------------------------------------------------------

function makeFakeWriter(opts: {
  seen?: string[];
  archivePriceImpl?: (mode: string, priceId: string) => Promise<StripePriceRef>;
} = {}): StripeCatalogWriter {
  const seen = opts.seen;
  let createdPriceCounter = 0;

  return {
    async findProductByPlan(): Promise<StripeProductRef | null> {
      return { id: "prod_existing" };
    },
    async createProduct(): Promise<StripeProductRef> {
      seen?.push("stripe");
      return { id: "prod_new" };
    },
    async createPrice(_mode: string, _spec: CreatePriceSpec): Promise<StripePriceRef> {
      seen?.push("stripe");
      createdPriceCounter += 1;
      return { id: `price_new_${createdPriceCounter}` };
    },
    async addCurrencyOption(): Promise<StripePriceRef> {
      seen?.push("stripe");
      return { id: "price_updated" };
    },
    async updatePriceTaxBehavior(): Promise<StripePriceRef> {
      seen?.push("stripe");
      return { id: "price_updated" };
    },
    async archivePrice(mode: string, priceId: string): Promise<StripePriceRef> {
      seen?.push("stripe");
      if (opts.archivePriceImpl) return opts.archivePriceImpl(mode, priceId);
      return { id: priceId };
    },
  } as StripeCatalogWriter;
}

// ---------------------------------------------------------------------------
// Assembling deps
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<PublishExecutorDeps>): PublishExecutorDeps {
  return {
    getAttempt: async () => null,
    readAncestor: async () => [],
    readDraft: async () => [],
    observe: async () => [],
    buildPlan: buildPublishPlan,
    checkGuards,
    writer: makeFakeWriter(),
    recordOperation: async () => randomUUID(),
    completeOperation: async () => {},
    finishPublishAttempt: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executePublish", () => {
  it("writes the operation row BEFORE calling Stripe", async () => {
    // If this order ever inverts, a crash between the two produces exactly
    // the "Stripe changed with no record" gap the design exists to prevent.
    const seen: string[] = [];
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const log = makeFakeLog();
    const recordOperation: PublishExecutorDeps["recordOperation"] = async (input) => {
      seen.push("db");
      return log.recordOperation(input);
    };

    const ancestor: CatalogAmount[] = [];
    const draft: CatalogAmount[] = [];
    const observed = [price({ lookup_key: KEY_A, currency: "usd", unit_amount: 1000 })];
    const plan = buildPublishPlan({ ancestor, draft, observed });
    expect(plan.operations).toHaveLength(1); // a single archive_price call

    const attempt = start(plan.fingerprint);
    const deps = makeDeps({
      getAttempt,
      finishPublishAttempt,
      readAncestor: async () => ancestor,
      readDraft: async () => draft,
      observe: async () => observed,
      writer: makeFakeWriter({ seen }),
      recordOperation,
      completeOperation: log.completeOperation,
    });

    const result = await executePublish(attempt.id, deps);

    expect(result.outcome).toBe("succeeded");
    expect(seen).toEqual(["db", "stripe"]);
  });

  it("leaves a pending row when the process dies after the write", async () => {
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const log = makeFakeLog();
    log.breakCompletion();

    const ancestor: CatalogAmount[] = [];
    const draft: CatalogAmount[] = [];
    const observed = [price({ lookup_key: KEY_A, currency: "usd", unit_amount: 1000 })];
    const plan = buildPublishPlan({ ancestor, draft, observed });
    const attempt = start(plan.fingerprint);

    const deps = makeDeps({
      getAttempt,
      finishPublishAttempt,
      readAncestor: async () => ancestor,
      readDraft: async () => draft,
      observe: async () => observed,
      writer: makeFakeWriter(),
      recordOperation: log.recordOperation,
      completeOperation: log.completeOperation,
    });

    await expect(executePublish(attempt.id, deps)).rejects.toThrow();
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].status).toBe("pending");
  });

  it("aborts without calling Stripe when the observation moved", async () => {
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const log = makeFakeLog();
    const stripeCalls: string[] = [];

    const ancestor: CatalogAmount[] = [];
    const draft: CatalogAmount[] = [];
    const observedAtPlanTime = [price({ lookup_key: KEY_A, currency: "usd", unit_amount: 1000 })];
    const observedAtExecuteTime = [
      price({ lookup_key: KEY_A, currency: "usd", unit_amount: 1000 }),
      price({ lookup_key: KEY_B, currency: "inr", unit_amount: 500 }),
    ];
    const staleFingerprint = buildPublishPlan({ ancestor, draft, observed: observedAtPlanTime }).fingerprint;
    const attempt = start(staleFingerprint);

    const deps = makeDeps({
      getAttempt,
      finishPublishAttempt,
      readAncestor: async () => ancestor,
      readDraft: async () => draft,
      observe: async () => observedAtExecuteTime, // moved since the attempt started
      writer: makeFakeWriter({ seen: stripeCalls }),
      recordOperation: log.recordOperation,
      completeOperation: log.completeOperation,
    });

    const result = await executePublish(attempt.id, deps);

    expect(result.outcome).toBe("aborted");
    expect(result.operations).toEqual([]);
    expect(stripeCalls).toHaveLength(0);
    expect(log.rows).toHaveLength(0);
    expect((await getAttempt(attempt.id))?.outcome).toBe("aborted");
  });

  it("captures the old price id before creating its replacement", async () => {
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const log = makeFakeLog();

    const ancestor = [amount(KEY_A, "usd", 1000)];
    const draft = [amount(KEY_A, "usd", 1500)]; // a real repricing, not a bootstrap
    const observed = [price({ lookup_key: KEY_A, currency: "usd", unit_amount: 1000, id: "price_old" })];
    const plan = buildPublishPlan({ ancestor, draft, observed });
    expect(plan.operations).toEqual([expect.objectContaining({ kind: "replace_price" })]);

    const attempt = start(plan.fingerprint);
    const deps = makeDeps({
      getAttempt,
      finishPublishAttempt,
      readAncestor: async () => ancestor,
      readDraft: async () => draft,
      observe: async () => observed,
      writer: makeFakeWriter(),
      recordOperation: log.recordOperation,
      completeOperation: log.completeOperation,
    });

    const result = await executePublish(attempt.id, deps);
    expect(result.outcome).toBe("succeeded");

    const [create, archive] = [...log.rows].sort((a, b) => a.sequence - b.sequence);
    expect(create.stripeCall).toBe("create");
    expect(archive.stripeCall).toBe("archive");
    expect(archive.stripePriceId).toBe("price_old");
    expect(archive.stripePriceId).not.toBe(create.stripePriceId);
  });

  it("puts the attempt number in the idempotency key", async () => {
    // Stripe replays cached FAILURES and expires keys after 24h. mark8ly
    // already deadlocked on this and bumped its key v1 -> v3. Without an
    // attempt counter, a retry of a transiently-failed operation gets the
    // cached error back forever.
    const ancestor: CatalogAmount[] = [];
    const draft: CatalogAmount[] = [];
    const observed = [price({ lookup_key: KEY_A, currency: "usd", unit_amount: 1000 })];
    const plan = buildPublishPlan({ ancestor, draft, observed });

    async function runOnce(): Promise<string> {
      const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
      const log = makeFakeLog();
      const attempt = start(plan.fingerprint);
      const deps = makeDeps({
        getAttempt,
        finishPublishAttempt,
        readAncestor: async () => ancestor,
        readDraft: async () => draft,
        observe: async () => observed,
        writer: makeFakeWriter(),
        recordOperation: log.recordOperation,
        completeOperation: log.completeOperation,
      });
      await executePublish(attempt.id, deps);
      const row = log.rows.find((r) => r.sequence === 1);
      if (!row) throw new Error("no sequence 1 row recorded");
      return row.idempotencyKey;
    }

    const first = await runOnce();
    const second = await runOnce();
    expect(first).not.toBe(second);
  });

  it("re-running a completed publish produces an empty plan", async () => {
    // A live Stripe store the fake writer and `observe` both read/write, so
    // a plan rebuilt AFTER the publish sees what the publish actually did —
    // proving convergence, not just that the mocks were called.
    const stripeStore = new Map<string, StripePriceLike>();
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const log = makeFakeLog();

    const ancestor: CatalogAmount[] = [];
    const draft = [amount(KEY_A, "usd", 1000)];
    const observedBefore: StripePriceLike[] = [];
    const plan = buildPublishPlan({ ancestor, draft, observed: observedBefore });
    expect(plan.operations.length).toBeGreaterThan(0);

    const attempt = start(plan.fingerprint);
    const writer: StripeCatalogWriter = {
      async findProductByPlan() {
        return null;
      },
      async createProduct() {
        return { id: "prod_starter" };
      },
      async createPrice(_mode, spec) {
        const id = `price_${spec.lookupKey}`;
        stripeStore.set(spec.lookupKey, {
          id,
          lookup_key: spec.lookupKey,
          currency: spec.currency,
          unit_amount: spec.unitAmount,
          tax_behavior: spec.taxBehavior,
          active: true,
        });
        return { id };
      },
      async addCurrencyOption() {
        throw new Error("not used by this fixture");
      },
      async updatePriceTaxBehavior() {
        throw new Error("not used by this fixture");
      },
      async archivePrice() {
        throw new Error("not used by this fixture");
      },
    };

    const deps = makeDeps({
      getAttempt,
      finishPublishAttempt,
      readAncestor: async () => ancestor,
      readDraft: async () => draft,
      observe: async () => observedBefore,
      writer,
      recordOperation: log.recordOperation,
      completeOperation: log.completeOperation,
    });

    const result = await executePublish(attempt.id, deps);
    expect(result.outcome).toBe("succeeded");

    const observedAfter = [...stripeStore.values()];
    const rebuilt = buildPublishPlan({ ancestor: draft, draft, observed: observedAfter });
    expect(rebuilt.operations).toEqual([]);
  });

  it("does not stop the whole publish when one operation fails", async () => {
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const log = makeFakeLog();

    const ancestor: CatalogAmount[] = [];
    const draft: CatalogAmount[] = [];
    // Three independent archive_price operations, sorted by lookup key — the
    // same order `buildPublishPlan` emits them in.
    const observed = [
      price({ lookup_key: KEY_A, currency: "usd", unit_amount: 1000, id: "price_a" }),
      price({ lookup_key: KEY_C, currency: "brl", unit_amount: 500, id: "price_c" }),
      price({ lookup_key: KEY_B, currency: "inr", unit_amount: 500, id: "price_b" }),
    ];
    const plan = buildPublishPlan({ ancestor, draft, observed });
    expect(plan.operations).toHaveLength(3);
    expect(plan.operations.every((op) => op.kind === "archive_price")).toBe(true);

    const attempt = start(plan.fingerprint);
    // `buildPublishPlan` orders operations by lookup key: developed sorts
    // before ppp, and "brl" sorts before "inr" — so KEY_C is the SECOND
    // operation here, not KEY_B.
    const writer = makeFakeWriter({
      archivePriceImpl: async (_mode, priceId) => {
        if (priceId === "price_c") throw new Error("stripe rejected this archive");
        return { id: priceId };
      },
    });

    const deps = makeDeps({
      getAttempt,
      finishPublishAttempt,
      readAncestor: async () => ancestor,
      readDraft: async () => draft,
      observe: async () => observed,
      writer,
      recordOperation: log.recordOperation,
      completeOperation: log.completeOperation,
    });

    const result = await executePublish(attempt.id, deps);

    expect(result.operations.map((o) => o.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(result.outcome).toBe("failed");
    expect((await getAttempt(attempt.id))?.outcome).toBe("failed");
  });

  it("aborts on a guard REFUSAL without executing any operation, even one it could have run", async () => {
    // #327 P2b retargeted this test. It used to use `mode: "live"` as its
    // refusal, which stopped being one when live became a confirmation;
    // `currency-coverage` is now the only rule that reaches this branch, so
    // it is the only vehicle left for the behaviour under test — the
    // executor's own defence-in-depth re-run of `checkGuards` (module
    // header, point 4).
    //
    // The plan deliberately carries a RUNNABLE operation alongside the
    // refusal: KEY_A is a real repricing. Without it, "no Stripe calls" would
    // be true of an empty plan too and this assertion would prove nothing.
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const log = makeFakeLog();
    const stripeCalls: string[] = [];

    const ancestor = [amount(KEY_A, "usd", 1000), amount(KEY_B, "usd", 500)];
    const draft = [amount(KEY_A, "usd", 1500), amount(KEY_B, "usd", 500)];
    const observed = [
      price({ lookup_key: KEY_A, currency: "usd", unit_amount: 1000, id: "price_old" }),
      // Stripe carries a currency the catalog does not, and no Stripe call
      // can remove a `currency_options` entry — `checkCurrencyCoverage`'s
      // own reason for being a refusal rather than a confirmation.
      price({
        lookup_key: KEY_B,
        currency: "usd",
        unit_amount: 500,
        currency_options: { eur: { unit_amount: 400, tax_behavior: "unspecified" } },
      }),
    ];
    const plan = buildPublishPlan({ ancestor, draft, observed });
    expect(plan.operations).toEqual([expect.objectContaining({ kind: "replace_price" })]);

    const attempt = start(plan.fingerprint);
    const deps = makeDeps({
      getAttempt,
      finishPublishAttempt,
      readAncestor: async () => ancestor,
      readDraft: async () => draft,
      observe: async () => observed,
      writer: makeFakeWriter({ seen: stripeCalls }),
      recordOperation: log.recordOperation,
      completeOperation: log.completeOperation,
    });

    const result = await executePublish(attempt.id, deps);

    expect(result.outcome).toBe("aborted");
    expect(stripeCalls).toHaveLength(0);
  });

  it("executes a LIVE attempt — a mode confirmation is not a refusal here", async () => {
    // #327 P2b, and the reason this test is worth its space: the operator
    // acknowledged the live confirmation in `publish-view.tsx` before
    // `publishAction` ever opened this attempt, and nothing reaching
    // `executePublish` can re-derive that they did (module header, point 4).
    // If `mode` were ever moved back into `checkGuards`' `refused` bucket,
    // every confirmed live publish would abort HERE, after the operator had
    // done everything asked of them — a live catalog that silently never
    // updates. This is the test that would say so.
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const log = makeFakeLog();

    const ancestor = [amount(KEY_A, "usd", 1000)];
    const draft = [amount(KEY_A, "usd", 1500)];
    const observed = [price({ lookup_key: KEY_A, currency: "usd", unit_amount: 1000, id: "price_old" })];
    const plan = buildPublishPlan({ ancestor, draft, observed });

    const attempt = start(plan.fingerprint, { mode: "live" });
    const deps = makeDeps({
      getAttempt,
      finishPublishAttempt,
      readAncestor: async () => ancestor,
      readDraft: async () => draft,
      observe: async () => observed,
      writer: makeFakeWriter(),
      recordOperation: log.recordOperation,
      completeOperation: log.completeOperation,
    });

    const result = await executePublish(attempt.id, deps);

    expect(result.outcome).toBe("succeeded");
    expect((await getAttempt(attempt.id))?.outcome).toBe("succeeded");
  });

  it("refuses to execute an attempt that has already finished", async () => {
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const attempt = start("fp", { outcome: "succeeded", finishedAt: new Date().toISOString() });
    const deps = makeDeps({ getAttempt, finishPublishAttempt });

    await expect(executePublish(attempt.id, deps)).rejects.toThrow(/already finished/);
  });

  it("throws for an attempt id that does not exist", async () => {
    const deps = makeDeps({ getAttempt: async () => null });
    await expect(executePublish("does-not-exist", deps)).rejects.toThrow(/no publish attempt/);
  });
});

/* ------------------------------------------------------------------------ *
 * transfer_lookup_key — the field a replace cannot succeed without
 * ------------------------------------------------------------------------ */

/**
 * A writer that records the specs it is handed, so a test can assert on the
 * REQUEST rather than on the outcome.
 *
 * The distinction is the whole point of this block. Every other writer stub
 * in this file returns success unconditionally, so an executor that builds a
 * request Stripe would reject still produces `outcome: "succeeded"` here.
 * That is exactly how the missing `transferLookupKey` survived a green
 * suite: the plan was right, the ordering was right, the operation log was
 * right, and the one thing that was wrong was a field in the payload that no
 * test looked at.
 */
function makeRecordingWriter(specs: CreatePriceSpec[]): StripeCatalogWriter {
  return {
    async findProductByPlan(): Promise<StripeProductRef | null> {
      return { id: "prod_existing" };
    },
    async createProduct(): Promise<StripeProductRef> {
      return { id: "prod_new" };
    },
    async createPrice(_mode: string, spec: CreatePriceSpec): Promise<StripePriceRef> {
      specs.push(spec);
      return { id: "price_new" };
    },
    async addCurrencyOption(): Promise<StripePriceRef> {
      return { id: "price_updated" };
    },
    async updatePriceTaxBehavior(): Promise<StripePriceRef> {
      return { id: "price_updated" };
    },
    async archivePrice(_mode: string, priceId: string): Promise<StripePriceRef> {
      return { id: priceId };
    },
  };
}

describe("replace_price asks Stripe to transfer the lookup key", () => {
  /**
   * Stripe refuses `prices.create` when the `lookup_key` is held by another
   * Price unless the create also asks to transfer it. On a `replace_price`
   * the key is ALWAYS held — by the very Price being replaced — so without
   * this field the operation cannot succeed at all.
   *
   * It never could. The first amount change this console ever attempted, run
   * against the live account on 2026-09-03, failed here with: "A price
   * (`price_1U94tmCyiazmanuP0CU2s7MA`) already uses that lookup key." The
   * create failed, so the archive that follows it never ran and nothing was
   * written — the executor's failure handling was correct throughout. Only
   * the request was wrong.
   */
  it("sets transferLookupKey on the create, because the key is held by the price being replaced", async () => {
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const log = makeFakeLog();
    const specs: CreatePriceSpec[] = [];

    const ancestor = [amount(KEY_A, "usd", 1000)];
    const draft = [amount(KEY_A, "usd", 1500)];
    const observed = [price({ lookup_key: KEY_A, currency: "usd", unit_amount: 1000, id: "price_old" })];
    const plan = buildPublishPlan({ ancestor, draft, observed });
    expect(plan.operations).toEqual([expect.objectContaining({ kind: "replace_price" })]);

    const attempt = start(plan.fingerprint);
    const result = await executePublish(
      attempt.id,
      makeDeps({
        getAttempt,
        finishPublishAttempt,
        readAncestor: async () => ancestor,
        readDraft: async () => draft,
        observe: async () => observed,
        writer: makeRecordingWriter(specs),
        recordOperation: log.recordOperation,
        completeOperation: log.completeOperation,
      }),
    );

    expect(result.outcome).toBe("succeeded");
    expect(specs).toHaveLength(1);
    expect(specs[0].lookupKey).toBe(KEY_A);
    expect(specs[0].transferLookupKey).toBe(true);
  });

  /**
   * The mirror, and not symmetry for its own sake: a `create_price` mints a
   * key nothing holds yet, so asking to transfer would succeed and would
   * also SILENCE Stripe's rejection — the one signal that a key believed
   * unused is in fact live on some other Price. That is a surprise a
   * bootstrap should stop on, not absorb, so the flag must stay off here.
   */
  it("does NOT set transferLookupKey on a create_price, so a key that is not new still fails loudly", async () => {
    const { start, getAttempt, finishPublishAttempt } = makeFakeAttempts();
    const log = makeFakeLog();
    const specs: CreatePriceSpec[] = [];

    const ancestor: CatalogAmount[] = [];
    const draft = [amount(KEY_A, "usd", 1500)];
    const observed: StripePriceLike[] = [];
    const plan = buildPublishPlan({ ancestor, draft, observed });
    // A from-scratch draft mints the Product before the Price that
    // references it, so the plan is two operations; only the create_price
    // reaches `createPrice`, which is what `specs` records.
    expect(plan.operations.map((o) => o.kind)).toEqual(["create_product", "create_price"]);

    const attempt = start(plan.fingerprint);
    const result = await executePublish(
      attempt.id,
      makeDeps({
        getAttempt,
        finishPublishAttempt,
        readAncestor: async () => ancestor,
        readDraft: async () => draft,
        observe: async () => observed,
        writer: makeRecordingWriter(specs),
        recordOperation: log.recordOperation,
        completeOperation: log.completeOperation,
      }),
    );

    expect(result.outcome).toBe("succeeded");
    expect(specs).toHaveLength(1);
    expect(specs[0].transferLookupKey).toBeFalsy();
  });
});
