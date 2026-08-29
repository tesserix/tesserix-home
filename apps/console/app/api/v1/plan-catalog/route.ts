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
import { readCatalogRows, readLivePublication } from "@/lib/db/plan-catalog-repo";

/**
 * GET /api/v1/plan-catalog?mode=<test|live> — the plan catalog, for product
 * consumers.
 *
 * # This is a published contract, not a view
 *
 * mark8ly currently compiles its Stripe prices into
 * `internal/billing/pricing/catalog.go`. This endpoint is what lets it stop —
 * mark8ly's runtime PINS to the response shape below. That makes it a
 * contract between repositories, not an internal view this console can
 * reshape at will:
 *
 *   {
 *     "mode": "test",
 *     "revision_id": "…",          // the version; pin and revalidate on this
 *     "published_at": "…",         // ISO 8601, UTC
 *     "prices": [
 *       {
 *         "lookup_key": "…",
 *         "plan": "…",
 *         "period": "…",
 *         "tier": "…",
 *         "currency": "…",
 *         "unit_amount_minor": 0,  // minor units, §4.2's money convention
 *         "tax_behavior": "…"
 *       }
 *     ]
 *   }
 *
 * ADDITIVE CHANGES ARE THE ONLY SAFE ONES. Adding a field is fine; renaming,
 * removing, or changing the type or meaning of an existing field is a
 * breaking change and belongs behind `/api/v2/plan-catalog`, not a silent
 * edit here — see the estate's other versioned surfaces for the same rule.
 *
 * `published_by` is DELIBERATELY EXCLUDED. It names an operator, and this
 * response crosses a repository boundary into a product's runtime path — an
 * operator's identity has no business leaving this database. It remains
 * available on the console's own catalog surface, where an operator can be
 * identified appropriately.
 *
 * # Auth is two separate steps, and the status codes must not collapse them
 *
 * 1. `verifyMachineAuthHeader` — is this a valid Zitadel machine token at
 *    all? No -> 401. A caller with no token and a caller with an expired one
 *    get the identical answer: "you are not authenticated", because neither
 *    can fix itself by learning what it's missing beyond that.
 * 2. `assertCapability(identity.roles, "read-plan-catalog")` — a SEPARATE
 *    check. A valid, verified machine identity that lacks the capability is
 *    403, not 401: it correctly identified itself and is still not
 *    permitted. Collapsing the two into one status would leave a
 *    misconfigured caller unable to tell "reissue my credential" from "ask
 *    for the role grant" — two different fixes, two different teams.
 *
 * # 404 vs. an empty 200
 *
 * `readLivePublication(mode)` returning `null` means `mode` has never been
 * published, and that is answered 404 — NEVER a 200 with `prices: []`.
 * mark8ly caches this response, and caching "the catalog is empty" is worse
 * than caching nothing: an empty catalog is a plausible-looking answer that
 * would let mark8ly price nothing at all, silently. A 404 cannot be mistaken
 * for a legitimate priced state.
 *
 * # Cache-Control: `no-cache`, and the ETag does the revalidation
 *
 * The catalog changes only on publish, so it is highly cacheable in
 * principle — but a stale price actually charged is a wrong price actually
 * charged, and that risk outranks the bandwidth `max-age` would save. `
 * no-cache` tells a compliant cache it MUST revalidate before serving a
 * stored response; paired with the `ETag` below, a caller that has the
 * current revision pays only the round trip (a 304, no body) while a caller
 * behind a stale revision is never served it. `max-age` was considered and
 * rejected: it would let mark8ly serve a superseded price for up to the TTL
 * with no way to shorten that window from this side after a publish.
 *
 * # The ETag is the revision id
 *
 * `revision_id` is the catalog's version — it's why the response shape
 * carries it — so the ETag is exactly that value, not a hash of the body. An
 * `If-None-Match` that names the current revision gets 304 with no body;
 * anything else gets the full 200.
 *
 * # A database failure must not produce a partial catalog
 *
 * Every read below either fully succeeds or throws into the catch-all,
 * which answers 5xx with no body resembling a catalog. There is no path that
 * writes some prices into the response and then fails.
 */

// Every call re-verifies the token, re-checks the capability and re-reads
// the database. The `no-cache` policy above is the ONE place caching
// semantics for this route are decided.
export const dynamic = "force-dynamic";

function isStripeMode(value: string | null): value is StripeMode {
  return value !== null && (STRIPE_MODES as readonly string[]).includes(value);
}

/**
 * `If-None-Match` may carry a comma-separated list of entity tags, and may
 * use the weak-comparison `W/` prefix. Match either form against the strong
 * ETag this route always sends.
 */
function ifNoneMatchHits(header: string, etag: string): boolean {
  return header
    .split(",")
    .map((raw) => raw.trim())
    .some((candidate) => candidate === "*" || candidate === etag || candidate.replace(/^W\//, "") === etag);
}

interface CatalogPriceBody {
  readonly lookup_key: string;
  readonly plan: string;
  readonly period: string;
  readonly tier: string;
  readonly currency: string;
  readonly unit_amount_minor: number;
  readonly tax_behavior: string;
}

interface PlanCatalogBody {
  readonly mode: StripeMode;
  readonly revision_id: string;
  readonly published_at: string;
  readonly prices: readonly CatalogPriceBody[];
}

async function authenticate(request: Request): Promise<null | NextResponse> {
  try {
    const identity = await verifyMachineAuthHeader(
      request.headers.get("authorization"),
      getZitadelMachineConfig(),
    );
    // A SEPARATE step from verification above — see the docstring's "Auth is
    // two separate steps" section for why the two must not collapse.
    assertCapability(identity.roles, "read-plan-catalog");
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
    // rather than silently picking one and serving the wrong account's
    // catalog.
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
    const publication = await readLivePublication(mode);
    if (!publication) {
      // "Never published" and "published, currently empty" are different
      // facts. This is the former, and it is answered 404 — see the
      // docstring's "404 vs. an empty 200" section for why a 200 here would
      // be a materially worse answer than no answer at all.
      return NextResponse.json(
        { error: "not_published", message: `mode "${mode}" has never been published` },
        { status: 404 },
      );
    }

    // Quoted per RFC 9110 §8.8.3 — an entity tag is always a quoted string.
    const etag = `"${publication.revisionId}"`;
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatchHits(ifNoneMatch, etag)) {
      // No body: the caller already holds this exact revision.
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "no-cache" },
      });
    }

    // `source` is required and never defaulted — see this repo function's
    // own doc comment. A defaulted source would silently serve the wrong
    // catalog the moment a second source exists (tesserix-home#392's class
    // of bug, one axis over).
    const rows = await readCatalogRows(mode, SINGLE_SOURCE);

    const body: PlanCatalogBody = {
      mode,
      revision_id: publication.revisionId,
      published_at: publication.publishedAt,
      prices: rows.map((row) => ({
        lookup_key: row.lookupKey,
        plan: row.plan,
        period: row.period,
        tier: row.tier,
        currency: row.currency,
        unit_amount_minor: row.unitAmountMinor,
        tax_behavior: row.taxBehavior,
      })),
    };

    return NextResponse.json(body, {
      status: 200,
      headers: { ETag: etag, "Cache-Control": "no-cache" },
    });
  } catch {
    // Deliberately not the driver's message: it can carry the connection
    // string and the role name, and this response crosses into another
    // product's runtime path. Nothing partial is ever returned here — every
    // read above either fully succeeds or lands in this catch with no body
    // written yet.
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
}
