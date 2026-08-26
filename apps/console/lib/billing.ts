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
 * Render money in its own currency.
 *
 * `Intl.NumberFormat` with the payload's currency rather than a hardcoded
 * locale symbol: the estate already spans AUD, INR and USD, and a "$" prefix
 * would be wrong for two of the three. Minor units are divided by the
 * currency's own exponent, which `Intl` knows and a hardcoded /100 does not —
 * JPY has no minor unit at all.
 */
