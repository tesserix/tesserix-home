import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  CapabilityError,
  MachineTokenError,
  assertCapability,
  getZitadelMachineConfig,
  verifyMachineAuthHeader,
} from "@tesserix/platform-auth";

import { STRIPE_MODES, type StripeMode } from "@/lib/billing/stripe-read";
import { SINGLE_SOURCE } from "@/lib/billing/source-policy";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  listPromoCodes,
  readStripeCouponIdsForMode,
  type PromoCodeRow,
} from "@/lib/db/promo-codes-repo";

/**
 * GET /api/v1/promo-catalog?mode=<test|live> — the promo code definitions, for
 * product consumers (tesserix-home#521).
 *
 * # This is a published contract, not a view
 *
 * A merchant types a code during mark8ly's onboarding; mark8ly reads THIS to
 * decide what the code does. The console owns the definitions, mark8ly
 * redeems — the same relationship `/api/v1/plan-catalog` has, and this route
 * is deliberately its mirror rather than a second auth story or a second
 * contract idiom.
 *
 *   {
 *     "source": "mark8ly",
 *     "mode": "test",
 *     "revision_id": "…",          // the version; pin and revalidate on this
 *     "codes": [
 *       {
 *         "code": "LAUNCH50",      // canonical: upper-case, no whitespace
 *         "trial_extension_days": 30,   // null when the code does not extend it
 *         "discount": {                 // null for a trial-extension-only code
 *           "kind": "percent_off",      // or "amount_off"
 *           "percent_off": 50,          // percent_off arm only
 *           "duration": "repeating",    // once | repeating | forever
 *           "duration_in_months": 3,    // null unless duration is "repeating"
 *           "stripe_coupon_id": "co_…"  // KEY ABSENT when not minted in `mode`
 *         },
 *         "valid_from": "…",       // ISO 8601, UTC
 *         "valid_until": null,     // null means no expiry, not unknown
 *         "max_redemptions": 100   // null means uncapped
 *       }
 *     ]
 *   }
 *
 * The `amount_off` arm carries `amount_off_minor` (minor units, §4.2's money
 * convention) and `currency` (lower-case ISO 4217) in place of `percent_off`.
 * Exactly one of the two arms, ever — 0046's
 * `promo_codes_discount_is_percent_off_xor_amount_off` is the same rule one
 * layer down.
 *
 * ADDITIVE CHANGES ARE THE ONLY SAFE ONES, the same rule plan-catalog states.
 * Adding a field is fine; renaming, removing, or changing the type or meaning
 * of an existing field is a breaking change and belongs behind
 * `/api/v2/promo-catalog`, not a silent edit here.
 *
 * # Auth is two separate steps, and the status codes must not collapse them
 *
 * 1. `verifyMachineAuthHeader` — is this a valid Zitadel machine token at
 *    all? No -> 401. A caller with no token and a caller with an expired one
 *    get the identical answer: "you are not authenticated", because neither
 *    can fix itself by learning what it's missing beyond that.
 * 2. `assertCapability(identity.roles, "read-promo-catalog")` — a SEPARATE
 *    check. A valid, verified machine identity that lacks the capability is
 *    403, not 401. Collapsing the two would leave a misconfigured caller
 *    unable to tell "reissue my credential" from "ask for the role grant" —
 *    two different fixes, two different teams.
 *
 * `read-promo-catalog`, NOT `read-plan-catalog`: see the capability's own
 * comment. Reading prices and enumerating every promo code in the estate are
 * different grants, and the existing price reader must not acquire the second
 * by our reusing its string. Until that role is granted in Zitadel this
 * endpoint answers 403 to everyone, which is correct and not a defect.
 *
 * # A COMPLETE SNAPSHOT, so a consumer can cache it and fail closed on a code
 *
 * mark8ly must be able to hold this response and, when the console is
 * unreachable, keep onboarding merchants off the last-known copy — treating a
 * code it does not recognise as INVALID rather than erroring the signup.
 * Someone who mistypes a code must still be able to finish onboarding. That
 * is mark8ly's to implement, but two properties of this contract are what
 * make it possible and neither may be traded away:
 *
 *   - It is a WHOLE-CATALOG response, never a per-code lookup. A
 *     `?code=` endpoint would make "is this code real?" require a live call,
 *     and there is no safe answer to that question during an outage.
 *   - An empty catalog is 200 with `codes: []`, NOT 404. This is the one
 *     place this route deliberately departs from plan-catalog's reasoning,
 *     and it departs because the danger runs the other way. There, an empty
 *     catalog means "price nothing", which is a plausible-looking answer that
 *     silently breaks billing — hence 404. Here, an empty catalog means
 *     "every typed code is invalid", which is exactly the safe degradation
 *     the fail-closed-on-a-code rule already asks for: the merchant onboards
 *     at the standard trial and price. There is also no "never published"
 *     state to distinguish it from — promo codes have no publication event.
 *
 * # WHAT IS FILTERED, AND THE LINE THAT DECIDES IT
 *
 * The console filters on facts only an OPERATOR can change, and never on
 * facts the CLOCK changes.
 *
 *   - `is_active = false` is an operator saying "stop honouring this". Those
 *     rows are not served at all, so a redeemer cannot honour one by
 *     forgetting to check a flag. Deactivating moves `revision_id`, so a
 *     cache finds out on its next revalidation.
 *   - The validity window is NOT filtered. Expired and not-yet-started
 *     definitions are served WITH their window, and the redeemer evaluates it
 *     against its own clock inside the transaction that redeems. Filtering it
 *     here would be actively wrong for a cached consumer: a snapshot of
 *     "valid right now" is a set of codes that WERE valid when it was taken,
 *     so an outage would leave mark8ly honouring codes that have since
 *     expired — the failure this endpoint exists to avoid. It also makes the
 *     better merchant-facing copy possible: a code present with a past
 *     `valid_until` is "that code expired", not "no such code".
 *
 * A consequence worth stating: because nothing served here depends on the
 * request's timestamp, the body changes ONLY when an operator changes
 * something. That is what makes `revision_id` stable and conditional requests
 * worth anything at all.
 *
 * # What is deliberately excluded, and why
 *
 * The same test plan-catalog applies to `published_by` — this response
 * crosses a repository boundary into a product's runtime path, so it carries
 * only what a redeemer needs to redeem:
 *
 *   - `created_by` — EXCLUDED. It names an operator. An operator's identity
 *     has no business leaving this database, for exactly plan-catalog's
 *     reason. It stays on the console's own authoring surface.
 *   - `id` (the definition's uuid) — EXCLUDED. The `code` string is what
 *     mark8ly's redemption ledger references, which is why 0046 forbids
 *     re-coding a definition at all. Serving the uuid would invite a second
 *     cross-repo key with no job, and a reader keying on it would be keying
 *     on a value this contract never promised to keep.
 *   - `created_at` / `updated_at` — EXCLUDED. Authoring timestamps answer no
 *     redemption question, and `updated_at` additionally publishes an edit
 *     cadence. They would also make `revision_id` churn on edits that change
 *     nothing a redeemer can see.
 *   - `is_active` — EXCLUDED as a FIELD because it is a FILTER: every row
 *     served is active by construction, so a field would be the constant
 *     `true` and an invitation to write a branch that never runs.
 *   - THE REDEMPTION COUNT SO FAR — EXCLUDED, and this is the important one.
 *     The console is not the writer of redemption state; that ledger is
 *     transactional and tenant-scoped and lives where redemptions happen.
 *     Serving a count from here would be a number a reader would trust and
 *     act on, stale by construction and wrong under exactly the concurrency
 *     the cap is meant to survive.
 *
 * `max_redemptions` IS included, and its inclusion is what makes the cap
 * enforceable: mark8ly counts its own redemptions transactionally, and it can
 * do that EXACTLY because it is the sole redeemer. A SECOND CONSUMER OF THIS
 * ENDPOINT MAKES THE CAP DISTRIBUTED AND SILENTLY APPROXIMATE — it would keep
 * presenting as a hard limit while over-issuing, and nothing here would say
 * so. Adding one is a design decision, not an integration.
 *
 * # `?mode=` selects a Stripe ACCOUNT, not a set of definitions
 *
 * Definitions are mode-independent — the terms an operator authored are true
 * of any account. Only the minted Stripe Coupon is per-mode, so `mode`
 * chooses WHICH ACCOUNT'S COUPON ID is attached, and never which definitions
 * are served. A redeemer working against the test account gets the test
 * `co_...`; the same call against `live` gets the live one.
 *
 * `stripe_coupon_id` IS ABSENT when this definition has no coupon minted in
 * the requested mode, and ABSENCE IS THE NORM RATHER THAN A DEFECT — nothing
 * in this estate has ever bootstrapped live, so every definition's `live`
 * coupon is absent today. A redeemer meeting a discount with no coupon id
 * applies whatever else the code carries (a trial extension) and does not
 * attempt the discount in that mode. The key is omitted rather than sent as
 * `null` for the reason `readStripeCoupons` gives for not padding: a null
 * reads as a value that failed to arrive.
 *
 * `mode` is never defaulted, exactly as in plan-catalog: an absent or unknown
 * value names the accepted ones rather than silently answering for the wrong
 * account.
 *
 * # The revision id is a CONTENT HASH, and that is a real difference
 *
 * plan-catalog's ETag is its publication's `revision_id`, because a published
 * catalog HAS a version. Promo codes have no publication event — a definition
 * is authored and is immediately live — so there is no id to serve, and the
 * version has to be derived. It is a SHA-256 over the exact served body, so
 * it changes when and only when the answer changes.
 *
 * This is why no `generated_at` is served: a per-request timestamp in the
 * body would make two responses with the same ETag differ, which is precisely
 * what an entity tag promises does not happen. A consumer that wants to know
 * how old its copy is knows when it fetched it.
 *
 * # Cache-Control: `no-cache`, and the ETag does the revalidation
 *
 * Same header as plan-catalog, and partly a different argument. There it is
 * "a stale price actually charged is a wrong price actually charged". Here
 * the urgent case is DEACTIVATION: a code that leaked publicly, or one whose
 * cap was reached, must stop being honoured now, and `max-age` would leave no
 * way to shorten that window from this side. `no-cache` tells a compliant
 * cache it MUST revalidate before serving a stored response; with the `ETag`
 * below, a caller holding the current revision pays only a round trip (a 304,
 * no body), and a caller behind a stale one is never served it.
 *
 * The obvious objection — mark8ly is expected to serve a STALE snapshot
 * during an outage, so why refuse it a small TTL? — is answered by which path
 * each governs. The fallback is a degraded path the consumer enters
 * knowingly, when the true answer is unavailable. `max-age` would impose
 * staleness on the HEALTHY path, where the console is reachable and the true
 * answer is one revalidation away. Those are not the same trade.
 *
 * # A database failure must not produce a partial catalog
 *
 * Every read below either fully succeeds or throws into the catch-all, which
 * answers 5xx with no body resembling a catalog. There is no path that writes
 * some codes into the response and then fails.
 */

// Every call re-verifies the token, re-checks the capability and re-reads the
// database. The `no-cache` policy above is the ONE place caching semantics
// for this route are decided.
export const dynamic = "force-dynamic";

function isStripeMode(value: string | null): value is StripeMode {
  return value !== null && (STRIPE_MODES as readonly string[]).includes(value);
}

/**
 * `If-None-Match` may carry a comma-separated list of entity tags, and may use
 * the weak-comparison `W/` prefix. Match either form against the strong ETag
 * this route always sends. Identical to plan-catalog's, and kept local rather
 * than shared for now: two copies of six lines is cheaper than a
 * `lib/http/etag` that one more route would have to be talked out of adding
 * policy to.
 */
function ifNoneMatchHits(header: string, etag: string): boolean {
  return header
    .split(",")
    .map((raw) => raw.trim())
    .some((candidate) => candidate === "*" || candidate === etag || candidate.replace(/^W\//, "") === etag);
}

/**
 * Pull a short, known-safe error code off an unknown thrown value, for
 * logging.
 *
 * Deliberately returns a STRING, never the error (or its `.cause`) itself —
 * see plan-catalog's copy of this function for the full argument. The short
 * version: `JWTClaimValidationFailed`, thrown deep inside
 * `verifyMachineAuthHeader`, carries the DECODED TOKEN CLAIMS on the error
 * object, so logging "whatever lands in this catch" wholesale would be one
 * refactor away from dumping a caller's claims to the log.
 */
function safeErrorCode(err: unknown): string | undefined {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  ) {
    return (err as { code: string }).code;
  }
  return undefined;
}

interface PercentOffDiscountBody {
  readonly kind: "percent_off";
  readonly percent_off: number;
  readonly duration: string;
  readonly duration_in_months: number | null;
  /** Absent when nothing is minted in the requested mode — see the module doc. */
  readonly stripe_coupon_id?: string;
}

interface AmountOffDiscountBody {
  readonly kind: "amount_off";
  readonly amount_off_minor: number;
  readonly currency: string;
  readonly duration: string;
  readonly duration_in_months: number | null;
  /** Absent when nothing is minted in the requested mode — see the module doc. */
  readonly stripe_coupon_id?: string;
}

type DiscountBody = PercentOffDiscountBody | AmountOffDiscountBody;

interface PromoCodeBody {
  readonly code: string;
  readonly trial_extension_days: number | null;
  readonly discount: DiscountBody | null;
  readonly valid_from: string;
  readonly valid_until: string | null;
  readonly max_redemptions: number | null;
}

interface PromoCatalogBody {
  readonly source: string;
  readonly mode: StripeMode;
  readonly revision_id: string;
  readonly codes: readonly PromoCodeBody[];
}

/**
 * One definition, in contract shape.
 *
 * `couponId` is threaded in rather than looked up here so the caller does the
 * single batched read — an N+1 on a contract endpoint would fall on a
 * `db-f1-micro` with a five-connection pool.
 */
function toBody(row: PromoCodeRow, couponId: string | undefined): PromoCodeBody {
  return {
    code: row.code,
    trial_extension_days: row.trialExtensionDays,
    discount: row.discount === null ? null : toDiscountBody(row.discount, couponId),
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    max_redemptions: row.maxRedemptions,
  };
}

function toDiscountBody(
  discount: NonNullable<PromoCodeRow["discount"]>,
  couponId: string | undefined,
): DiscountBody {
  // Spread the key in only when there is one: `{ stripe_coupon_id: undefined }`
  // would still serialise away, but it would also typecheck against a shape
  // that promises the key is optional rather than sometimes-undefined, and the
  // two drift apart the first time someone iterates the object's keys.
  const minted = couponId === undefined ? {} : { stripe_coupon_id: couponId };
  const common = {
    duration: discount.duration,
    duration_in_months: discount.durationInMonths,
    ...minted,
  };
  return discount.kind === "percent_off"
    ? { kind: "percent_off", percent_off: discount.percentOff, ...common }
    : {
        kind: "amount_off",
        amount_off_minor: discount.amountOffMinor,
        currency: discount.currency,
        ...common,
      };
}

/**
 * The version of this exact answer.
 *
 * Hashes the SERVED content — mode, source and every code — rather than a
 * database column, because there is no publication row to take a version from.
 * `mode` is inside the hash on purpose: two modes with the same definitions and
 * no coupons minted in either would otherwise share an ETag, and a caller
 * switching modes with an `If-None-Match` would be told 304 for a body it has
 * never seen.
 */
function revisionIdFor(mode: StripeMode, source: string, codes: readonly PromoCodeBody[]): string {
  return createHash("sha256").update(JSON.stringify({ mode, source, codes })).digest("hex");
}

async function authenticate(request: Request): Promise<null | NextResponse> {
  try {
    const identity = await verifyMachineAuthHeader(
      request.headers.get("authorization"),
      getZitadelMachineConfig(),
    );
    // A SEPARATE step from verification above — see the docstring's "Auth is
    // two separate steps" section for why the two must not collapse.
    assertCapability(identity.roles, "read-promo-catalog");
  } catch (cause) {
    if (cause instanceof MachineTokenError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (cause instanceof CapabilityError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw cause;
  }
  return null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const refusal = await authenticate(request);
  if (refusal) return refusal;

  const modeParam = new URL(request.url).searchParams.get("mode");
  if (!isStripeMode(modeParam)) {
    // Never a default: an unknown or absent `mode` names the accepted values
    // rather than silently attaching the wrong account's coupon ids.
    return NextResponse.json(
      {
        error: "invalid_mode",
        message: `mode must be one of: ${STRIPE_MODES.join(", ")}`,
      },
      { status: 400 },
    );
  }
  const mode = modeParam;

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  try {
    // `source` is required and never defaulted, for the reason plan-catalog
    // gives: a defaulted source silently serves another product's catalog the
    // moment a second source exists (tesserix-home#392's class of bug).
    // `includeInactive` is left at its default — deactivated definitions are
    // not served at all, per the module doc's filtering rule.
    const rows = await listPromoCodes({ source: SINGLE_SOURCE });

    const coupons = await readStripeCouponIdsForMode(
      mode,
      rows.map((row) => row.id),
    );

    // Sorted by `code` here rather than relying on the repository's ordering.
    // `code` is unique (0046's `promo_codes_code_unique`), so this is a TOTAL
    // order, and a total order is what makes the content hash below stable:
    // ordering by `created_at DESC` — the repository's default, and not unique
    // — would let two definitions written in the same statement swap places
    // between reads and change `revision_id` with nothing having changed.
    const codes = rows
      .map((row) => toBody(row, coupons.get(row.id)))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    const etag = `"${revisionIdFor(mode, SINGLE_SOURCE, codes)}"`;
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatchHits(ifNoneMatch, etag)) {
      // No body: the caller already holds this exact revision. Unlike
      // plan-catalog, the revision is only known AFTER the read, so this
      // saves the caller the payload rather than the console the query.
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "no-cache" },
      });
    }

    const body: PromoCatalogBody = {
      source: SINGLE_SOURCE,
      mode,
      // Quoted per RFC 9110 §8.8.3 in the header; unquoted in the body, where
      // it is an identifier rather than an entity tag.
      revision_id: etag.slice(1, -1),
      codes,
    };

    return NextResponse.json(body, {
      status: 200,
      headers: { ETag: etag, "Cache-Control": "no-cache" },
    });
  } catch (err) {
    // Logged server-side so a database outage on a cross-repo contract isn't
    // invisible to an operator — but only `name`/`code`, never the error (or
    // `.cause`) itself: the driver's own message can carry the connection
    // string and the role name.
    console.error("[api/v1/promo-catalog] failed to read the promo catalog", {
      mode,
      name: err instanceof Error ? err.name : typeof err,
      code: safeErrorCode(err),
    });
    // The response says nothing more than "unavailable": this crosses into
    // another product's runtime path. Nothing partial is ever returned — every
    // read above either fully succeeds or lands here with no body written yet.
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
}
