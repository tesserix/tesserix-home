import { PlatformApiError } from "./platform-api";
// Re-exported so callers have one import for the billing vocabulary, while the
// implementation stays in a module with no server-side ancestry — a client
// component importing `formatMoney` from HERE would pull `pg` and node:crypto
// into the browser bundle through `platform-api`. See lib/money.ts.
export { formatMoney, type Money } from "./money";
import type { Money } from "./money";

/**
 * The estate's billing surfaces — contract §8.2, federated by platform-api
 * across every product that implements them.
 *
 * §8.2 exists because five endpoints made a product *manageable* and did not
 * make it *legible as a business*: a flat KPI map cannot express "which trials
 * expire this week, with dunning state, across tenants". That is a list with
 * per-row state, not a headline number.
 */


export interface Subscription {
  readonly source: string;
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly storeId?: string;
  readonly plan: string;
  readonly period?: string;
  /** The PRODUCT's vocabulary, rendered verbatim — a console-side enumeration
   *  would be a second vocabulary that drifts from the first. */
  readonly status: string;
  /** Absent when no catalog price resolves. **Absent is not zero**: rendering
   *  a missing price as 0 says "this tenant pays nothing", a different and
   *  wrong claim. */
  readonly amount?: Money;
  readonly currentPeriodEnd?: string;
  readonly cancelAtPeriodEnd: boolean;
}

export interface Trial {
  readonly source: string;
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly storeId?: string;
  readonly trialEndsAt: string;
  readonly daysRemaining: number;
  readonly plan: string;
  readonly period?: string;
  readonly amount?: Money;
  /** Separate from `amount.currency`: a trial may have a billing currency
   *  chosen with no resolvable price yet, and collapsing the two loses that. */
  readonly billingCurrency?: string;
  /** The field that makes this a work queue rather than a report — a trial
   *  ending without one is the row somebody acts on. */
  readonly paymentMethodOnFile: boolean;
  readonly status: string;
  readonly stripeManaged: boolean;
}

export interface BillingSourceFailure {
  readonly source: string;
  readonly message: string;
}

export interface SubscriptionPage {
  readonly data: readonly Subscription[];
  /** The sum of each ANSWERING product's own count. Understates the estate
   *  whenever `failures` is non-empty, which is why the two render together. */
  readonly total: number;
  readonly failures: readonly BillingSourceFailure[];
}

export interface TrialPage {
  readonly data: readonly Trial[];
  readonly total: number;
  readonly failures: readonly BillingSourceFailure[];
}

/**
 * ONE product's compiled plan-feature matrix — what each of its plans entitles
 * a tenant to, as that product's own gate enforces it.
 *
 * `value` is a single integer read two ways, never an "enabled" flag beside a
 * "limit": `0` is Disabled and is also the zero value, `-1` Unlimited, `-2`
 * Negotiated, and a positive n a cap. mark8ly's `plangate` stores exactly that
 * and reads it with `IsAllowed`/`Limit`; splitting it here would invent a
 * distinction the enforcement point does not make. Carried VERBATIM — nothing
 * in this module normalises, defaults or fills a cell, because a sentinel
 * rewritten on the way through is a limit nobody wrote.
 */
export interface EntitlementMatrix {
  readonly source: string;
  /**
   * The plan catalog mode the PRODUCT reports reading, passed through exactly
   * as it sent it, INCLUDING EMPTY.
   *
   * It is on the wire because the console cannot see it any other way: the
   * mode lives in the product's own `CONSOLE_CATALOG_MODE`, is not derivable
   * from anything the console observes, and moves at the Stripe live-key swap.
   * A console that assumed `test` would go silently wrong at the swap.
   */
  readonly catalogMode: string;
  /** The product's canonical ORDERED feature list. Order is part of the
   *  contract, not incidental. */
  readonly features: readonly string[];
  /** Plan name -> feature name -> value, for every plan the product's matrix
   *  keys on. A plan the matrix does not key on is ABSENT rather than
   *  published as all-Disabled — a row of zeroes would assert a policy nobody
   *  wrote. mark8ly keys on four: trial, starter, studio and pro. */
  readonly plans: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/**
 * The entitlements surface's response: a LIST of per-product matrices.
 *
 * The one federated read on this surface that does not blend. A feature
 * vocabulary is per-product — `stores` is mark8ly's word about mark8ly's gate,
 * and another product's identically named feature would be a different thing —
 * so the rows are federated but never merged, and each keeps its source. A
 * caller wanting one product's matrix SELECTS BY `source`; indexing `data[0]`
 * positionally reads whichever product answered first.
 *
 * No `total`, unlike {@link SubscriptionPage} and {@link TrialPage}. There is
 * nothing here a product could hold more of than it returned — the matrix is
 * compiled into its binary and answered whole — so a count would be a number
 * with no question behind it, and `parseEntitlements` must not demand one.
 */
export interface EntitlementPage {
  readonly data: readonly EntitlementMatrix[];
  readonly failures: readonly BillingSourceFailure[];
}

function fail(message: string): never {
  throw new PlatformApiError(`billing: ${message}`);
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function optionalStr(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") fail(`${path} is not a string`);
  return value;
}

function whole(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${path} is not a whole number`);
  }
  return value;
}

/**
 * Money, or absent.
 *
 * A present amount MUST carry a currency. §4.2 admits no exception, and a
 * number without one is the failure §8.2 names by name — so a malformed money
 * object throws rather than rendering as a bare figure someone reads in the
 * wrong denomination.
 */
function money(value: unknown, path: string): Money | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) fail(`${path} is not an object`);
  const row = value as Record<string, unknown>;
  const currency = str(row.currency, `${path}.currency`);
  if (currency === "") fail(`${path}.currency is empty; §4.2 requires an explicit currency`);
  return { amount: whole(row.amount, `${path}.amount`), currency };
}

function rowOf(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is not an object`);
  }
  return value as Record<string, unknown>;
}

function failuresOf(value: unknown): readonly BillingSourceFailure[] {
  if (!Array.isArray(value)) fail("failures is missing");
  return value.map((entry, i) => {
    const row = rowOf(entry, `failures[${i}]`);
    return {
      source: str(row.source, `failures[${i}].source`),
      message: str(row.message, `failures[${i}].message`),
    };
  });
}

function totalOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail("total is not a non-negative whole number");
  }
  return value;
}

export function parseSubscriptions(json: unknown): SubscriptionPage {
  const body = rowOf(json, "response");
  if (!Array.isArray(body.data)) fail("data is not an array");
  return {
    data: body.data.map((entry, i) => {
      const row = rowOf(entry, `data[${i}]`);
      return {
        source: str(row.source, `data[${i}].source`),
        tenantId: str(row.tenant_id, `data[${i}].tenant_id`),
        tenantName: optionalStr(row.tenant_name, `data[${i}].tenant_name`),
        storeId: optionalStr(row.store_id, `data[${i}].store_id`),
        plan: str(row.plan, `data[${i}].plan`),
        period: optionalStr(row.period, `data[${i}].period`),
        status: str(row.status, `data[${i}].status`),
        amount: money(row.amount, `data[${i}].amount`),
        currentPeriodEnd: optionalStr(row.current_period_end, `data[${i}].current_period_end`),
        cancelAtPeriodEnd: row.cancel_at_period_end === true,
      };
    }),
    total: totalOf(body.total),
    failures: failuresOf(body.failures),
  };
}

export function parseTrials(json: unknown): TrialPage {
  const body = rowOf(json, "response");
  if (!Array.isArray(body.data)) fail("data is not an array");
  return {
    data: body.data.map((entry, i) => {
      const row = rowOf(entry, `data[${i}]`);
      return {
        source: str(row.source, `data[${i}].source`),
        tenantId: str(row.tenant_id, `data[${i}].tenant_id`),
        tenantName: optionalStr(row.tenant_name, `data[${i}].tenant_name`),
        storeId: optionalStr(row.store_id, `data[${i}].store_id`),
        trialEndsAt: str(row.trial_ends_at, `data[${i}].trial_ends_at`),
        daysRemaining: whole(row.days_remaining, `data[${i}].days_remaining`),
        plan: str(row.plan, `data[${i}].plan`),
        period: optionalStr(row.period, `data[${i}].period`),
        amount: money(row.amount, `data[${i}].amount`),
        billingCurrency: optionalStr(row.billing_currency, `data[${i}].billing_currency`),
        paymentMethodOnFile: row.payment_method_on_file === true,
        status: str(row.status, `data[${i}].status`),
        stripeManaged: row.stripe_managed === true,
      };
    }),
    total: totalOf(body.total),
    failures: failuresOf(body.failures),
  };
}

/**
 * Every federating product's compiled matrix.
 *
 * Strict in both directions, and deliberately so — this parser is the seam a
 * seed is derived through, so a malformed cell must stop the seed rather than
 * become a value nobody wrote. `whole` rejects a non-integer or a string, and
 * a plan whose map is not an object throws rather than resolving to `{}`,
 * which would seed as "this plan entitles nothing" and then compare clean
 * against a matrix that says otherwise.
 *
 * `catalog_mode` is read with `str`, not `optionalStr`: the product may
 * legitimately report an EMPTY mode, and that is a fact worth carrying rather
 * than a field to drop. A missing one is still a malformed response.
 */
export function parseEntitlements(json: unknown): EntitlementPage {
  const body = rowOf(json, "response");
  if (!Array.isArray(body.data)) fail("data is not an array");
  return {
    data: body.data.map((entry, i) => {
      const row = rowOf(entry, `data[${i}]`);
      const features = row.features;
      if (!Array.isArray(features)) fail(`data[${i}].features is not an array`);
      const plans = rowOf(row.plans, `data[${i}].plans`);
      return {
        source: str(row.source, `data[${i}].source`),
        catalogMode: str(row.catalog_mode, `data[${i}].catalog_mode`),
        features: features.map((name, f) => str(name, `data[${i}].features[${f}]`)),
        plans: Object.fromEntries(
          Object.entries(plans).map(([plan, cells]) => [
            plan,
            Object.fromEntries(
              Object.entries(rowOf(cells, `data[${i}].plans.${plan}`)).map(
                ([feature, value]) => [
                  feature,
                  whole(value, `data[${i}].plans.${plan}.${feature}`),
                ],
              ),
            ),
          ]),
        ),
      };
    }),
    // No `total`: see {@link EntitlementPage}. Reading one here would make
    // every well-formed response fail.
    failures: failuresOf(body.failures),
  };
}

/**
 * Render money in its own currency.
 *
 * `Intl.NumberFormat` with the payload's currency rather than a hardcoded
 * locale symbol: the estate already spans AUD, INR and USD, and a "$" prefix
 * would be wrong for two of the three. Minor units are divided by the
 * currency's own exponent, which `Intl` knows and a hardcoded /100 does not —
 * JPY has no minor unit at all.
 */
