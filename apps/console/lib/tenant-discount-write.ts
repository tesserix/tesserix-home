// `server-only`: this reads the operator's session and their platform API
// token, through `platformRequestWithMeta`. A client component importing it
// must fail the build, naming the import chain.
import "server-only";

import type { StripeMode } from "@/lib/billing/stripe-read";
import { platformApiOrigin, platformRequestWithMeta } from "@/lib/platform-api";
import { PlatformApiError } from "@/lib/platform-api-error";

/**
 * Asking mark8ly to put the console's coupon on a tenant's subscriptions, and
 * to take it off again — tesserix-home#331, T1.
 *
 * # What this module is, and what it is not
 *
 * It is a CALLER. platform-api serves
 * `POST /v1/billing/tenants/{id}/discount` and `.../discount/remove`, which
 * forward a signed request to the product that owns the tenant; mark8ly does
 * the fan-out across that tenant's stores and reports one outcome per store.
 * Nothing here decides anything about billing — it addresses the request
 * correctly, narrows the report defensively, and turns a refusal into a
 * sentence an operator can act on.
 *
 * # THE AUDIT ROW IS NOT WRITTEN HERE
 *
 * `tenant-lifecycle-write.ts` states the estate's position on a federated
 * write and it applies unchanged:
 *
 *   > the audit row for this change is written by the PRODUCT, inside its own
 *   > transaction, bound to the state change it describes … a console-side
 *   > audit row would put a second, less trustworthy account of the same event
 *   > in a different database — and the two would disagree the first time a
 *   > write half-succeeded.
 *
 * mark8ly writes the row for each store inside that store's transaction, from
 * the `reason` this call carries. What the console DID — mint a Stripe object,
 * retire its record of one — is audited by `tenant-pricing-override-write.ts`,
 * because those are acts of this service.
 *
 * # NEITHER CAPABILITY IS CHECKED HERE
 *
 * Both callers check `billing` and `publish-catalog` inside their own
 * `auditedOperation`, which is what makes a refusal a `capability.refused`
 * row; platform-api checks both again and remains the authorisation boundary
 * (`handler.go:129-133`). A third check in this module would refuse outside
 * any audited operation — reaching no log — and would record nothing the
 * caller has not already recorded.
 */

/** Which verb was asked for. mark8ly scopes its stored idempotency key by this,
 *  so the two can never replay each other's report. */
export type TenantDiscountOperation = "apply" | "remove";

export interface TenantDiscountInput {
  /** The NAMESPACED tenant id (`<source>:<id>`), passed WHOLE — see
   *  {@link discountPath}. */
  readonly tenantId: string;
  /**
   * Which Stripe account the coupon was minted in.
   *
   * NOT SENT. It is not a field of `domain.DiscountRequest` and mark8ly does
   * not take one — the coupon id already names an object in exactly one
   * account. It is here only for the idempotency key, where it keeps a `test`
   * grant and a `live` grant of the same coupon id from colliding.
   */
  readonly mode: StripeMode;
  /** The Stripe Coupon this console minted and recorded. */
  readonly couponId: string;
  /** The operator's justification. mark8ly writes it into the audit row inside
   *  each store's transaction, which is the row read later by someone asking
   *  why a merchant is paying less. */
  readonly reason: string;
}

/**
 * mark8ly's per-store vocabulary, copied from
 * `internal/billing/tenantdiscount/outcome.go` by way of platform-api's
 * `domain.StoreOutcome`, which parses it and replaces anything else with
 * `unknown`.
 *
 * Spelled out here rather than typed as `string` for the reason platform-api
 * gives for making it a named type: a value this build cannot place must say
 * so, instead of arriving as text an operator reads as an outcome.
 */
export type TenantDiscountStoreOutcome =
  | "applied"
  | "already_applied"
  | "removed"
  | "not_applied"
  | "pending"
  | "no_override"
  | "no_subscription"
  | "no_stripe_customer"
  | "failed"
  | "unknown";

const STORE_OUTCOMES: readonly TenantDiscountStoreOutcome[] = [
  "applied",
  "already_applied",
  "removed",
  "not_applied",
  "pending",
  "no_override",
  "no_subscription",
  "no_stripe_customer",
  "failed",
];

/** mark8ly's summary of the fan-out. It counts stores whose TRANSACTION
 *  failed, which is not the same question as "which stores carry the discount"
 *  — see `overrideFanOutCounts` in the control, which answers that one from
 *  the outcomes. */
export type TenantDiscountStatus = "ok" | "partial" | "failed" | "unknown";

const STATUSES: readonly TenantDiscountStatus[] = ["ok", "partial", "failed"];

/**
 * One store's line in the report.
 *
 * THREE FIELDS OF THE SEVEN mark8ly sends. The subscription id, the Stripe
 * customer id, the Stripe subscription id and `failure_code` are deliberately
 * dropped: nothing in this console renders them, they are handles for work
 * done in mark8ly's own admin, and carrying an unrendered field invites a
 * later reader to render it without checking what it means.
 *
 * `failureReason` is admitted because it is mark8ly's FIXED vocabulary, not
 * driver text — `storeFailure` composes one of five literal sentences from the
 * failure code and its own comment says the message "is composed here, never
 * taken from err.Error()". Verified in
 * `services/marketplace-api/internal/handlers/platformadmin/billing_tenant_discount.go:404`.
 */
export interface TenantDiscountStore {
  readonly storeId: string;
  readonly outcome: TenantDiscountStoreOutcome;
  /** Set only for `failed`, and only ever one of mark8ly's five sentences. */
  readonly failureReason?: string;
}

/**
 * What the caller gets back.
 *
 * The success arm is the REPORT, not a boolean: `status`,
 * `requiresReconciliation` and the per-store outcomes are three different
 * facts, and a caller that could only see "it worked" would have to guess at
 * the other two. See Decision 3 of
 * `.planning/quick/20260906-td3-console-tenant-discount-call/PLAN.md`.
 *
 * `ok: true` therefore does NOT mean every store carries the discount. It
 * means mark8ly answered with a report, and the report says what happened.
 */
export type TenantDiscountResult =
  | {
      readonly ok: true;
      readonly status: TenantDiscountStatus;
      /**
       * Set when at least one store changed in Stripe and the audit row
       * explaining it did not commit. Its own fact, and NOT a failure: Stripe
       * moved and mark8ly could not record it, so that store's real state and
       * mark8ly's account of it have diverged.
       */
      readonly requiresReconciliation: boolean;
      readonly stores: readonly TenantDiscountStore[];
    }
  | { readonly ok: false; readonly message: string };

const LABEL = "tenant discount";

const NO_PERMISSION =
  "You don't have permission to change what a tenant is charged.";

/**
 * The unset-origin message, and the ONE failure in this module that can say
 * plainly that nothing happened.
 *
 * `platformCall` throws a `PlatformApiError` with NO STATUS for three
 * different conditions (`platform-api.ts:226`, `:239-245`, `:259-261`):
 * an unconfigured origin, a session with no operator token, and a fetch that
 * never completed. Only the first is knowably a no-op, and only the first is
 * fixed by a deployment change rather than a retry — so it is detected HERE,
 * by reading the origin before the call, rather than by matching text on the
 * error a sibling module composed.
 */
const NOT_CONFIGURED =
  "This console cannot reach the platform API, so nothing was sent to the product. PLATFORM_API_ORIGIN is unset in this deployment — that is a configuration fix, not something to try again.";

/**
 * Deliberately does NOT say "nothing was applied", for the reason
 * `tenant-lifecycle-write.ts`'s `NOT_APPLIED` gives: a transport failure after
 * the product committed is indistinguishable from one before it. An operator
 * told the discount was not applied will apply it again, and a second attach
 * of an already-attached coupon is at best a wasted round trip and at worst a
 * second discount on a live subscription.
 */
function unreachable(operation: TenantDiscountOperation): string {
  const verb = operation === "apply" ? "put this coupon on" : "take this coupon off";
  return (
    `The product could not be reached to ${verb} this tenant's subscriptions, and whether it did ` +
    "cannot be told from here. Check the tenant's subscriptions in mark8ly before trying again."
  );
}

/**
 * Recover the API's own sentence from a `PlatformApiError`.
 *
 * `tenant-lifecycle-write.ts`'s anchoring trick, copied for its reason: the
 * envelope formats as `${label}: ${CODE} — ${message}`, and the messages
 * either side contain em-dashes of their own, so splitting on the first one
 * truncates them.
 */
function apiMessage(error: PlatformApiError): string | undefined {
  const withoutLabel = error.message.startsWith(`${LABEL}: `)
    ? error.message.slice(LABEL.length + 2)
    : error.message;
  return /^[A-Z_]+ — ([\s\S]+)$/.exec(withoutLabel)?.[1];
}

/**
 * The path, with the tenant id WHOLE.
 *
 * platform-api splits it on the first colon to decide which product owns the
 * tenant (`service/discount.go:54`) and refuses an id that names no product
 * rather than aiming it at a default. `splitTenantId` in `lib/tenants.ts`
 * exists for the affordance that decides whether this console mints for the
 * product at all — it is not a step on the way to this call.
 *
 * Percent-encoded because a product's own id is opaque to this console and a
 * `/` in one would otherwise address a different route. The colon survives as
 * `%3A`, which Go's mux unescapes back to `:` before the service splits it.
 */
function discountPath(tenantId: string, operation: TenantDiscountOperation): string {
  const base = `/v1/billing/tenants/${encodeURIComponent(tenantId)}/discount`;
  // POST .../discount/remove rather than DELETE .../discount: both verbs carry
  // a body, the federated hop is HMAC-signed over a hash of that body, and an
  // intermediary is permitted to drop a DELETE's — which would surface as a
  // 401 and read as an authentication fault (`service/discount.go:75-80`).
  return operation === "remove" ? `${base}/remove` : base;
}

/**
 * The idempotency key, and it is DETERMINISTIC ON PURPOSE.
 *
 * # Why this does not copy `tenant-lifecycle-write.ts`
 *
 * That seam mints `randomUUID()` per call and says why: suspending an
 * already-suspended tenant is a legitimate no-op the product reports as
 * `changed: false`, so an operator submitting twice means it twice. Two other
 * seams copy the idiom. **Do not make this one consistent with them.**
 *
 * Here a repeat is not a second intention, it is a RETRY — and the case the
 * key exists for is precisely the one where this console cannot tell the
 * difference: the request arrived, mark8ly attached the coupon across the
 * tenant's stores, and the response was lost. Replaying a deterministic key
 * gets mark8ly's stored report back verbatim (it Reserves the key before the
 * fan-out and replays it, scoped `tenant_discount:<op>:<tenant>:<key>`). A
 * fresh key on that same retry is the same as having no key at all, which is
 * the argument `mintKey` in `tenant-pricing-override-write.ts` already makes
 * at length for the Stripe half of the same operation, and the argument
 * platform-api makes for refusing to generate one (`handler.go:163-167`).
 *
 * # What the key covers
 *
 * The tenant, the mode and the coupon — a stable identity for one grant,
 * because the recorded coupon id is unique per grant (0047's partial unique
 * index allows one live row per tenant per mode, and each mint records its
 * own `co_…`). The reason is NOT in it: it never changes what mark8ly is being
 * asked to do, and including it would give a reworded justification a new key,
 * so a retry would fan out a second time instead of replaying.
 *
 * # Two prefixes, not one
 *
 * `attach` and `detach` are separate namespaces because mark8ly scopes its
 * stored key by operation. A key shared across apply and remove is the bug
 * mark8ly#772's test pins — a remove replaying an apply's stored report, and
 * reporting a discount as removed while it is still on the subscription.
 *
 * `v1` for the reason `MINT_KEY_VERSION` is versioned: the day this key's
 * SHAPE changes, keys minted under the old shape must not collide with the new
 * ones inside anybody's replay window.
 */
function idempotencyKey(input: TenantDiscountInput, operation: TenantDiscountOperation): string {
  const prefix = operation === "apply" ? "tenant-override-attach" : "tenant-override-detach";
  return `${prefix}:v1:${input.tenantId}:${input.mode}:${input.couponId}`;
}

interface DiscountWire {
  readonly status?: unknown;
  readonly requires_reconciliation?: unknown;
  readonly stores?: unknown;
}

function readOutcome(raw: unknown): TenantDiscountStoreOutcome {
  return (STORE_OUTCOMES as readonly string[]).includes(raw as string)
    ? (raw as TenantDiscountStoreOutcome)
    : "unknown";
}

function readStatus(raw: unknown): TenantDiscountStatus {
  return (STATUSES as readonly string[]).includes(raw as string)
    ? (raw as TenantDiscountStatus)
    : "unknown";
}

/**
 * Narrow the report field by field.
 *
 * Every field is treated as untrusted, the discipline every parser in `lib/`
 * keeps: this JSON crossed two service boundaries, and a version skew arrives
 * here as a well-typed response with a field missing rather than as an error.
 * A store line whose id is not a string is DROPPED rather than rendered as
 * `undefined`, because a line naming no store tells an operator nothing and
 * looks like a store they cannot find.
 */
function readReport(data: unknown): TenantDiscountResult {
  const wire = (data ?? {}) as DiscountWire;
  const stores = Array.isArray(wire.stores) ? wire.stores : [];
  return {
    ok: true,
    status: readStatus(wire.status),
    requiresReconciliation: wire.requires_reconciliation === true,
    stores: stores.flatMap((entry) => {
      const line = (entry ?? {}) as {
        store_id?: unknown;
        outcome?: unknown;
        failure_reason?: unknown;
      };
      if (typeof line.store_id !== "string") return [];
      const failureReason =
        typeof line.failure_reason === "string" && line.failure_reason !== ""
          ? line.failure_reason
          : undefined;
      return [
        {
          storeId: line.store_id,
          outcome: readOutcome(line.outcome),
          // Spread rather than an always-present `undefined`, so a store with
          // nothing to report has no key at all and a caller cannot render an
          // empty reason as a blank line.
          ...(failureReason === undefined ? {} : { failureReason }),
        },
      ];
    }),
  };
}

/** Put the console's coupon on every store this tenant owns. */
export async function applyTenantDiscount(
  input: TenantDiscountInput,
): Promise<TenantDiscountResult> {
  return call(input, "apply");
}

/** Take it back off. */
export async function removeTenantDiscount(
  input: TenantDiscountInput,
): Promise<TenantDiscountResult> {
  return call(input, "remove");
}

/**
 * The shared path. The two verbs differ in the trailing segment and in the
 * key's prefix, and in nothing else.
 *
 * Neither `couponId` nor `reason` is re-validated here. Both callers already
 * refuse a blank reason before they reach this point (`validate` and
 * `validateRevoke`), the coupon id comes from a row this console wrote, and
 * platform-api refuses either one blank with its own sentence
 * (`handler.go:184-194`) — which the 400 branch below surfaces verbatim. A
 * third rule here would be a fourth place for the three to disagree.
 */
async function call(
  input: TenantDiscountInput,
  operation: TenantDiscountOperation,
): Promise<TenantDiscountResult> {
  // BEFORE the call, so an unconfigured deployment is reported as itself. See
  // NOT_CONFIGURED for why this is not left to the thrown error's status.
  if (platformApiOrigin() === null) {
    return { ok: false, message: NOT_CONFIGURED };
  }

  try {
    const { data } = await platformRequestWithMeta(LABEL, discountPath(input.tenantId, operation), {
      method: "POST",
      headers: {
        "idempotency-key": idempotencyKey(input, operation),
        "content-type": "application/json",
      },
      body: JSON.stringify({ coupon_id: input.couponId, reason: input.reason }),
    });
    return readReport(data);
  } catch (cause) {
    if (cause instanceof PlatformApiError) {
      switch (cause.status) {
        case 400:
          // The product's own refusal, which names its §4.4 code — the only
          // actionable thing a refusal carries. platform-api composes it as
          // "the product refused this change: <code>"; it is passed through
          // rather than re-worded, because this console does not know what
          // each of mark8ly's codes means and a guess would be a worse
          // sentence than the code itself.
          return { ok: false, message: apiMessage(cause) ?? unreachable(operation) };
        case 403:
          return { ok: false, message: NO_PERMISSION };
        default:
          // 503 and statusless both land here. 503 is platform-api saying the
          // product could not be reached; statusless is this console failing
          // to reach platform-api, or a session with no operator token. None
          // of the three can say whether mark8ly acted, so all three get the
          // message that refuses to claim it did not.
          return { ok: false, message: unreachable(operation) };
      }
    }
    // Anything else thrown out of the transport. Its text is written for a run
    // log — it names hosts and internals — so it is not shown.
    return { ok: false, message: unreachable(operation) };
  }
}
