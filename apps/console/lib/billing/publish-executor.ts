// `server-only`: this module is the ONE place a Stripe write and the
// `plan_catalog_publish_*` log meet — it reaches `pg` (through
// `publish-repo.ts` and `plan-catalog-repo.ts`) and `stripe` (through
// `mark8ly/stripe-write.ts` and `stripe-read.ts`). A client component that
// reaches it must fail the build with the chain named, the same guard every
// module it composes already carries individually.
import "server-only";

import {
  planOf,
  expectedInterval,
  type CatalogAmount,
  type StripePriceLike,
} from "./parity";
import { policyFor, SINGLE_SOURCE, type SourcePolicy } from "./source-policy";
import {
  buildPublishPlan,
  type OperationKind,
  type PublishOperation,
  type ReplacePriceOperation,
} from "./publish-plan";
import { checkGuards } from "./publish-guards";
import { stripeCatalogWriter, type StripeCatalogWriter } from "./mark8ly/stripe-write";
import { stripePriceReader, type StripeMode } from "./stripe-read";
import {
  publishAttemptById,
  finishPublishAttempt,
  recordOperation,
  completeOperation,
  type PublishAttempt,
  type StripeCall,
  type OperationCompletion,
} from "@/lib/db/publish-repo";
import { readCatalogAmounts, readRevisionAmounts } from "@/lib/db/plan-catalog-repo";

/**
 * The publish executor: `executePublish(attemptId)` is the only function in
 * this plan that writes to Stripe.
 *
 * # What it does, in order (mirrors 0038's header)
 *
 * 1. Load the attempt (`revision_id`, `mode`, `fingerprint` — Task 5).
 * 2. RE-OBSERVE: read the ancestor (what `mode` currently publishes), the
 *    draft (the revision being published), and Stripe's own current state,
 *    fresh — never whatever was read when the attempt started.
 * 3. Rebuild the plan (Task 3) from that fresh observation. `buildPublishPlan`
 *    is a pure function of its three inputs, so a plan built from an
 *    observation whose fingerprint matches `attempt.fingerprint` is BYTE FOR
 *    BYTE the plan a human already confirmed — there is nothing here to
 *    re-derive from a stored copy, because none is kept. If the fingerprint
 *    has moved, the world changed since planning and this ABORTS rather than
 *    executing a plan built against a state that no longer exists.
 * 4. A second, narrower safety net: `checkGuards` (Task 4) runs again, and a
 *    REFUSAL (currency-coverage — since #327 P2b the only rule this system
 *    treats as never legitimate) also aborts. A CONFIRMATION-only verdict
 *    does not, and that now includes a live publish's own `mode` breach: that
 *    decision was already made by a human before this attempt was started,
 *    and nothing this function receives lets it re-derive "was it confirmed"
 *    — see `checkExecutionGuards` below for the reasoning spelled out.
 * 5. Execute each planned operation in order — write-ahead, one or two
 *    Stripe calls per operation (Task 5's log: `create_product`,
 *    `create_price`, `add_currency_option`, `update_tax_behavior`,
 *    `archive_price` are one call; `replace_price` is two, create then
 *    archive) — continuing past a single operation's failure rather than
 *    stopping the whole publish.
 * 6. Close the attempt with its terminal outcome.
 *
 * # A SUCCESSFUL PUBLISH IS NOT A PROMOTION
 *
 * F4 (whole-branch fix wave, 2026-08-28). Stated here plainly because the
 * six steps above stop at "close the attempt" and a wiring author reading
 * only that list would reasonably assume a green publish is done: it is not.
 * `executePublish` never writes a `plan_catalog_publications` row.
 * `readCatalogAmounts` (`plan-catalog-repo.ts`) joins through THAT table, so
 * after a `"succeeded"` outcome here, the nightly parity check's CATALOG side
 * still reads the OLD revision while Stripe now holds the NEW one — the
 * check goes red by construction, on the shared window #327's write-key
 * revocation reads, until something promotes the published revision.
 *
 * Promotion (and orphan detection) is Task 7's, correctly deferred — this
 * module does not build it. But Task 7 MUST land the promotion write in the
 * SAME change that first gives this function a real caller; wiring
 * `executePublish` up from this header alone, without also promoting on
 * success, resets #327's window on the very first green publish.
 *
 * # Recovery is re-observe-and-re-plan, NOT draining a stored queue
 *
 * There is no `PublishPlan` persisted anywhere — 0038 stores attempts and
 * OPERATIONS (one row per Stripe call actually made), not plans. A second
 * call to `executePublish` for an attempt that already finished is refused
 * (see the guard below); resuming a crashed publish means starting a NEW
 * attempt, which gets a new fingerprint and new idempotency keys — see this
 * module's `idempotencyKeyFor` and the design note on 0038 about why a stale
 * key must never be replayed.
 */

// ---------------------------------------------------------------------------
// Dependencies — injected so this module is testable with a fake Stripe
// writer and a fake log, and never touches the network or a real database in
// its own test file. `defaultExecutorDeps` wires the real modules; every
// other caller (Task 7 and later, out of scope here) is expected to call
// `executePublish` with no second argument.
// ---------------------------------------------------------------------------

export interface PublishExecutorDeps {
  getAttempt(attemptId: string): Promise<PublishAttempt | null>;
  readAncestor(mode: StripeMode): Promise<CatalogAmount[]>;
  readDraft(revisionId: string): Promise<CatalogAmount[]>;
  observe(mode: StripeMode): Promise<StripePriceLike[]>;
  buildPlan: typeof buildPublishPlan;
  checkGuards: typeof checkGuards;
  writer: StripeCatalogWriter;
  recordOperation: typeof recordOperation;
  completeOperation: typeof completeOperation;
  finishPublishAttempt: typeof finishPublishAttempt;
}

export const defaultExecutorDeps: PublishExecutorDeps = {
  getAttempt: publishAttemptById,
  readAncestor: (mode) => readCatalogAmounts(mode, SINGLE_SOURCE),
  readDraft: (revisionId) => readRevisionAmounts(revisionId, SINGLE_SOURCE),
  observe: (mode) => stripePriceReader.listPrices(mode),
  buildPlan: buildPublishPlan,
  checkGuards,
  writer: stripeCatalogWriter,
  recordOperation,
  completeOperation,
  finishPublishAttempt,
};

// ---------------------------------------------------------------------------
// Outcome shape
// ---------------------------------------------------------------------------

export interface OperationResult {
  readonly kind: OperationKind;
  /** `null` only for `create_product`, which has no lookup key. */
  readonly lookupKey: string | null;
  readonly status: "succeeded" | "failed";
  readonly error?: string;
}

export interface PublishOutcome {
  readonly outcome: "succeeded" | "failed" | "aborted";
  readonly operations: readonly OperationResult[];
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

/**
 * `v1`, versioned like mark8ly's own `price:v3:` scheme (Task 6's brief) —
 * bumped the day this derivation changes, never reused for a changed
 * meaning.
 *
 * Folds in `attemptId`: every attempt is a fresh UUID, so two attempts can
 * never mint the same key for "their own" sequence 1 — which is exactly what
 * 0038's global `UNIQUE (idempotency_key)` is there to catch if a future edit
 * ever drops this component. Recovery is a NEW attempt (see the module
 * header), never a replay of an old attempt's keys, so there is no case where
 * this function is called twice with the same `(attemptId, sequence, call)`
 * for a call that is meant to be idempotent against an EARLIER try — each
 * triple is minted, used once, and never revisited.
 */
const IDEMPOTENCY_KEY_VERSION = "v1";

function idempotencyKeyFor(attemptId: string, sequence: number, call: StripeCall): string {
  return `catalog-publish:${IDEMPOTENCY_KEY_VERSION}:${attemptId}:${sequence}:${call}`;
}

// ---------------------------------------------------------------------------
// A failure this executor must not swallow
// ---------------------------------------------------------------------------

/**
 * Raised when the write-ahead LOG ITSELF cannot be written to — not when a
 * Stripe call fails (that is a normal, recorded `failed` operation), but when
 * recording that outcome fails too.
 *
 * This is deliberately NOT caught anywhere in this module and propagates all
 * the way out of {@link executePublish}, rejecting its promise. The
 * alternative — swallowing it and moving on to the next operation — would
 * mean continuing to publish while no longer able to trust what the log says
 * happened, which is the exact ambiguity 0038's write-ahead design exists to
 * prevent. Letting the process die here, with the last operation's row still
 * `pending`, is the honest state: it says "this may have happened", which is
 * true, rather than a `failed` row this function was never able to confirm
 * it actually wrote.
 */
class OperationLogWriteFailure extends Error {
  constructor(cause: unknown) {
    super(
      `executePublish: failed to record an operation's outcome after its Stripe call — ` +
        `the log no longer reflects reality, so this publish stops rather than continuing on an ` +
        `unknown state: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "OperationLogWriteFailure";
  }
}

// ---------------------------------------------------------------------------
// Executing one Stripe call, write-ahead
// ---------------------------------------------------------------------------

interface RunCallParams<T extends { id: string }> {
  readonly attempt: PublishAttempt;
  readonly deps: PublishExecutorDeps;
  readonly kind: OperationKind;
  readonly stripeCall: StripeCall;
  readonly lookupKey: string | null;
  readonly currency: string | null;
  /**
   * The id known at WRITE-AHEAD time, before the call — the OLD id for an
   * `archive`, the EXISTING id for an `update`, `null` for a `create` (see
   * `publish-repo.ts`'s `recordOperation` doc comment; this executor is the
   * only intended caller of that contract).
   */
  readonly stripePriceId: string | null;
  readonly sequence: number;
  /** Only a `create` call learns a NEW Stripe id worth recording on success. */
  readonly captureIdOnSuccess: boolean;
  readonly call: (idempotencyKey: string) => Promise<T>;
}

/**
 * Insert the `pending` row, THEN call Stripe, THEN update the row — in that
 * order, and never any other order. See this module's header and 0038's own
 * header for what a crash between steps 1 and 2 is supposed to leave behind:
 * exactly this row, still `pending`.
 */
async function runCall<T extends { id: string }>(params: RunCallParams<T>): Promise<T> {
  const idempotencyKey = idempotencyKeyFor(params.attempt.id, params.sequence, params.stripeCall);

  // Step 1: write-ahead. If THIS throws, nothing has been recorded and no
  // Stripe call has been made — there is no ambiguous state to protect, so
  // the failure propagates as an ordinary thrown error for the caller to
  // turn into a `failed` OperationResult.
  const operationId = await params.deps.recordOperation({
    attemptId: params.attempt.id,
    sequence: params.sequence,
    kind: params.kind,
    stripeCall: params.stripeCall,
    source: SINGLE_SOURCE,
    lookupKey: params.lookupKey,
    currency: params.currency,
    stripePriceId: params.stripePriceId,
    idempotencyKey,
  });

  // Step 2: the Stripe call.
  let result: T;
  try {
    result = await params.call(idempotencyKey);
  } catch (stripeCause) {
    // Step 3 (failure path): record what Stripe said. If THAT write also
    // fails, this is the "process died after the write" case — see
    // `OperationLogWriteFailure`.
    const completion: OperationCompletion = {
      status: "failed",
      error: stripeCause instanceof Error ? stripeCause.message : String(stripeCause),
    };
    await recordCompletionOrDie(params.deps, operationId, completion);
    throw stripeCause;
  }

  // Step 3 (success path).
  const completion: OperationCompletion = {
    status: "succeeded",
    stripePriceId: params.captureIdOnSuccess ? result.id : undefined,
  };
  await recordCompletionOrDie(params.deps, operationId, completion);
  return result;
}

async function recordCompletionOrDie(
  deps: PublishExecutorDeps,
  operationId: string,
  completion: OperationCompletion,
): Promise<void> {
  try {
    await deps.completeOperation(operationId, completion);
  } catch (writeCause) {
    throw new OperationLogWriteFailure(writeCause);
  }
}

// ---------------------------------------------------------------------------
// Resolving a Stripe Product id for a `create_price` / `replace_price`
// ---------------------------------------------------------------------------

/**
 * `create_price` operations carry `plan` (Task 3's plan already knows it);
 * `replace_price` operations do not, because the Price it replaces already
 * belongs to a Product and Task 3 had no reason to re-derive that fact — see
 * `planOf`, which is exactly the derivation `stripe-write.ts` and
 * `publish-plan.ts` already share rather than duplicate.
 *
 * Not a Stripe call in its own right worth logging: `findProductByPlan` is a
 * READ (`prices.list` under the hood, actually `products.list`), not one of
 * 0038's three `stripe_call` values, and it mints no idempotency key —
 * consistent with `stripe-write.ts`'s own doc comment on why it returns
 * `null` rather than throwing.
 */
async function resolveProductId(
  plan: string,
  mode: StripeMode,
  productIds: Map<string, string>,
  deps: PublishExecutorDeps,
): Promise<string> {
  const known = productIds.get(plan);
  if (known) return known;

  const existing = await deps.writer.findProductByPlan(mode, plan);
  if (!existing) {
    throw new Error(
      `executePublish: no Stripe Product found for plan "${plan}", and none was created earlier in this attempt`,
    );
  }
  productIds.set(plan, existing.id);
  return existing.id;
}

// ---------------------------------------------------------------------------
// `interval` <-> `period`
// ---------------------------------------------------------------------------

/**
 * `CreatePriceOperation.interval` and `ReplacePriceOperation` (derived below
 * via `expectedInterval`) are already in STRIPE's vocabulary (`"year"` /
 * `"month"`) — Task 3 computed it that way so `publish-plan.ts` never has to
 * import `stripe-write.ts`. `CreatePriceSpec.period` is in the CATALOG's
 * vocabulary (`"monthly"` / `"annual"`) because `stripe-write.ts` derives
 * `recurring.interval` from it via its own `intervalOf` — see that module's
 * doc comment on `CreatePriceSpec.period`. This executor is the one place
 * that sits between both vocabularies, so it is the one place that converts
 * between them; neither producer should have to know the other's.
 */
function periodFromInterval(interval: "year" | "month"): "monthly" | "annual" {
  return interval === "year" ? "annual" : "monthly";
}

// ---------------------------------------------------------------------------
// Executing one planned operation
// ---------------------------------------------------------------------------

async function runReplacePrice(
  op: ReplacePriceOperation,
  attempt: PublishAttempt,
  nextSequence: () => number,
  productIds: Map<string, string>,
  policy: SourcePolicy,
  deps: PublishExecutorDeps,
): Promise<OperationResult> {
  const plan = planOf(op.lookupKey, policy.lookupKeyPrefix);
  const productId = await resolveProductId(plan, attempt.mode, productIds, deps);

  // Create the replacement FIRST. If this throws, the outer catch in
  // `runOperation` turns it into a `failed` result and the archive below is
  // never attempted — the old Price is left untouched, exactly the "products
  // before the prices that reference them" / "create before archive" order
  // Task 6's brief requires, and the only safe response to a failed create:
  // there is nothing yet to make the old Price's replacement.
  await runCall({
    attempt,
    deps,
    kind: op.kind,
    stripeCall: "create",
    lookupKey: op.lookupKey,
    currency: op.currency,
    stripePriceId: null,
    sequence: nextSequence(),
    captureIdOnSuccess: true,
    call: (idempotencyKey) =>
      deps.writer.createPrice(attempt.mode, {
        productId,
        lookupKey: op.lookupKey,
        currency: op.currency,
        unitAmount: op.unitAmount,
        period: periodFromInterval(expectedInterval(op.lookupKey)),
        taxBehavior: op.taxBehavior,
        currencyOptions: op.currencyOptions,
        idempotencyKey,
      }),
  });

  // Archive the OLD id, captured by Task 3 BEFORE this create ran — see
  // `ReplacePriceOperation.oldPriceId`'s own doc comment and
  // `stripe-write.ts`'s `archivePrice`: resolving "the price to archive" by
  // lookup key here instead would resolve to the price just created above,
  // because `transfer_lookup_key` has already moved the key to it.
  await runCall({
    attempt,
    deps,
    kind: op.kind,
    stripeCall: "archive",
    lookupKey: op.lookupKey,
    currency: null,
    stripePriceId: op.oldPriceId,
    sequence: nextSequence(),
    captureIdOnSuccess: false,
    call: (idempotencyKey) => deps.writer.archivePrice(attempt.mode, op.oldPriceId, idempotencyKey),
  });

  return { kind: op.kind, lookupKey: op.lookupKey, status: "succeeded" };
}

/**
 * `add_currency_option` is planned as ONE operation but may need SEVERAL
 * Stripe calls: `stripeCatalogWriter.addCurrencyOption` takes one currency at
 * a time (mirroring Stripe's own per-currency-key update surface), while
 * `AddCurrencyOptionOperation.currencyOptions` may name more than one new
 * currency. Each currency gets its own write-ahead row, its own idempotency
 * key, and its own chance to fail independently — the SAME reasoning 0038's
 * header gives for `replace_price` being two rows, applied to as many
 * currencies as this operation adds. Every currency is attempted even if an
 * earlier one failed: unlike `replace_price`'s create-then-archive, adding
 * `eur` and adding `cad` to the same Price have no ordering dependency on
 * each other.
 */
async function runAddCurrencyOption(
  op: Extract<PublishOperation, { kind: "add_currency_option" }>,
  attempt: PublishAttempt,
  nextSequence: () => number,
  deps: PublishExecutorDeps,
): Promise<OperationResult> {
  let firstError: string | undefined;

  for (const [currency, value] of Object.entries(op.currencyOptions)) {
    try {
      await runCall({
        attempt,
        deps,
        kind: op.kind,
        stripeCall: "update",
        lookupKey: op.lookupKey,
        currency,
        stripePriceId: op.priceId,
        sequence: nextSequence(),
        captureIdOnSuccess: false,
        call: (idempotencyKey) =>
          deps.writer.addCurrencyOption(attempt.mode, op.priceId, currency, value.unitAmount, idempotencyKey),
      });
    } catch (cause) {
      if (cause instanceof OperationLogWriteFailure) throw cause;
      firstError ??= cause instanceof Error ? cause.message : String(cause);
    }
  }

  return firstError === undefined
    ? { kind: op.kind, lookupKey: op.lookupKey, status: "succeeded" }
    : { kind: op.kind, lookupKey: op.lookupKey, status: "failed", error: firstError };
}

/**
 * One planned operation, start to finish. Returns a `failed` result rather
 * than throwing for an ordinary Stripe rejection — see this module's header,
 * point 5: one operation's failure does not stop the rest of the publish.
 * The one exception is {@link OperationLogWriteFailure}, rethrown unchanged
 * so it propagates out of {@link executePublish} instead of being folded into
 * a result the caller could mistake for an ordinary failure.
 */
async function runOperation(
  op: PublishOperation,
  attempt: PublishAttempt,
  nextSequence: () => number,
  productIds: Map<string, string>,
  policy: SourcePolicy,
  deps: PublishExecutorDeps,
): Promise<OperationResult> {
  if (op.kind === "add_currency_option") {
    return runAddCurrencyOption(op, attempt, nextSequence, deps);
  }

  try {
    switch (op.kind) {
      case "create_product": {
        const product = await runCall({
          attempt,
          deps,
          kind: op.kind,
          stripeCall: "create",
          lookupKey: null,
          currency: null,
          stripePriceId: null,
          sequence: nextSequence(),
          captureIdOnSuccess: false,
          call: (idempotencyKey) => deps.writer.createProduct(attempt.mode, op.plan, idempotencyKey),
        });
        productIds.set(op.plan, product.id);
        return { kind: op.kind, lookupKey: null, status: "succeeded" };
      }

      case "create_price": {
        const productId = await resolveProductId(op.plan, attempt.mode, productIds, deps);
        await runCall({
          attempt,
          deps,
          kind: op.kind,
          stripeCall: "create",
          lookupKey: op.lookupKey,
          currency: op.currency,
          stripePriceId: null,
          sequence: nextSequence(),
          captureIdOnSuccess: true,
          call: (idempotencyKey) =>
            deps.writer.createPrice(attempt.mode, {
              productId,
              lookupKey: op.lookupKey,
              currency: op.currency,
              unitAmount: op.unitAmount,
              period: periodFromInterval(op.interval),
              taxBehavior: op.taxBehavior,
              currencyOptions: op.currencyOptions,
              idempotencyKey,
            }),
        });
        return { kind: op.kind, lookupKey: op.lookupKey, status: "succeeded" };
      }

      case "replace_price":
        return await runReplacePrice(op, attempt, nextSequence, productIds, policy, deps);

      case "update_tax_behavior": {
        await runCall({
          attempt,
          deps,
          kind: op.kind,
          stripeCall: "update",
          lookupKey: op.lookupKey,
          currency: null,
          stripePriceId: op.priceId,
          sequence: nextSequence(),
          captureIdOnSuccess: false,
          call: (idempotencyKey) =>
            deps.writer.updatePriceTaxBehavior(attempt.mode, op.priceId, op.taxBehavior, idempotencyKey),
        });
        return { kind: op.kind, lookupKey: op.lookupKey, status: "succeeded" };
      }

      case "archive_price": {
        await runCall({
          attempt,
          deps,
          kind: op.kind,
          stripeCall: "archive",
          lookupKey: op.lookupKey,
          currency: null,
          stripePriceId: op.priceId,
          sequence: nextSequence(),
          captureIdOnSuccess: false,
          call: (idempotencyKey) => deps.writer.archivePrice(attempt.mode, op.priceId, idempotencyKey),
        });
        return { kind: op.kind, lookupKey: op.lookupKey, status: "succeeded" };
      }
    }
  } catch (cause) {
    if (cause instanceof OperationLogWriteFailure) throw cause;
    return {
      kind: op.kind,
      lookupKey: "lookupKey" in op ? op.lookupKey : null,
      status: "failed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

// ---------------------------------------------------------------------------
// Scoping the observation
// ---------------------------------------------------------------------------

/**
 * `buildPublishPlan`'s fingerprint deliberately covers whatever `observed`
 * it is handed, unfiltered (see that module's `observedTuples` doc comment) —
 * the CALLER's job is to scope it first, the same way `performParityCheck`
 * scopes via `compareCatalogToStripe`'s prefix argument. This executor's
 * `observe` may return every active Price in a shared Stripe account; only
 * this source's own rows should ever reach `buildPublishPlan` or its
 * fingerprint.
 *
 * EXPORTED (2026-08-28, the task that gave this module its first caller):
 * `startPublishAttempt` needs a plan's `fingerprint` BEFORE `executePublish`
 * can be called with the attempt it opens, so the action in
 * `app/(console)/platform/billing/catalog/actions.ts` builds a plan of its
 * own — and a plan built from a DIFFERENTLY scoped observation has a
 * different fingerprint, which this function's own caller below would then
 * read as "the world moved" and abort on, every single time. There is
 * exactly one correct scoping, so there is exactly one copy of it.
 */
export function scopeObserved(observed: readonly StripePriceLike[], prefix: string): StripePriceLike[] {
  return observed.filter((price) => (price.lookup_key ?? "").startsWith(prefix));
}

// ---------------------------------------------------------------------------
// executePublish
// ---------------------------------------------------------------------------

export async function executePublish(
  attemptId: string,
  deps: PublishExecutorDeps = defaultExecutorDeps,
): Promise<PublishOutcome> {
  const attempt = await deps.getAttempt(attemptId);
  if (!attempt) {
    throw new Error(`executePublish: no publish attempt "${attemptId}"`);
  }
  if (attempt.outcome !== null) {
    // Recovery is a NEW attempt (see the module header) — re-closing a
    // finished one here would let a caller accidentally execute the same
    // attempt's operations twice, minting a second, DIFFERENT set of
    // idempotency keys (they fold in `sequence`, not just `attemptId`) for
    // work already done.
    throw new Error(
      `executePublish: attempt "${attemptId}" already finished with outcome "${attempt.outcome}"`,
    );
  }

  const policy = policyFor(SINGLE_SOURCE);

  // RE-OBSERVE. Never the observation (if any) that produced the plan a
  // human confirmed before this attempt started — see the module header.
  const [ancestor, draft, observedRaw] = await Promise.all([
    deps.readAncestor(attempt.mode),
    deps.readDraft(attempt.revisionId),
    deps.observe(attempt.mode),
  ]);
  const observed = scopeObserved(observedRaw, policy.lookupKeyPrefix);

  const plan = deps.buildPlan({ ancestor, draft, observed });

  // ABORT if the observation moved. `buildPublishPlan` is pure, so a plan
  // built from an observation whose fingerprint matches `attempt.fingerprint`
  // is IDENTICAL to the one already confirmed; there is nothing else that
  // could have changed underneath it since `ancestor` and `draft` are read
  // from the same rows the confirmation step itself would have read (the
  // mode's current publication and the draft revision by id).
  if (plan.fingerprint !== attempt.fingerprint) {
    await deps.finishPublishAttempt(attemptId, "aborted");
    return { outcome: "aborted", operations: [] };
  }

  // A second, narrower safety net — see the module header, point 4. Only a
  // REFUSAL aborts; a plan that merely requires confirmation was already
  // confirmed by a human before this attempt existed, and nothing here can
  // tell "requires confirmation, unconfirmed" apart from "requires
  // confirmation, already confirmed" — re-refusing every such publish forever
  // would be exactly the "warning nobody can act on" failure mode
  // `publish-guards.ts`'s own header rejects for a REFUSAL, let alone a
  // confirmation.
  const verdict = deps.checkGuards(plan, ancestor, attempt.mode);
  if (!verdict.ok && "refused" in verdict) {
    await deps.finishPublishAttempt(attemptId, "aborted");
    return { outcome: "aborted", operations: [] };
  }

  let sequence = 0;
  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };
  const productIds = new Map<string, string>();

  // Sequential, deliberately: each operation's write-ahead row and Stripe
  // call must happen in order relative to the ones before it (products
  // before the prices that reference them, create before archive within a
  // replace) — `Promise.all` here would race the log.
  const results: OperationResult[] = [];
  for (const op of plan.operations) {
    const result = await runOperation(op, attempt, nextSequence, productIds, policy, deps);
    results.push(result);
  }

  const outcome: "succeeded" | "failed" = results.some((r) => r.status === "failed")
    ? "failed"
    : "succeeded";
  await deps.finishPublishAttempt(attemptId, outcome);
  return { outcome, operations: results };
}
