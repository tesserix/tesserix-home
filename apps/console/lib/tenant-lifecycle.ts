/**
 * The reason codes a tenant lifecycle change may carry.
 *
 * # Why these live here at all, which is not ideal
 *
 * §8.3 requires reason codes on anything reversible-but-consequential, and the
 * product is the authority on its own set — mark8ly declares seven for suspend
 * and four DIFFERENT ones for unsuspend. But **no contract endpoint exposes
 * them**: they are a Go var in `platformadmin/tenant_lifecycle.go`, reachable
 * only by reading that file. A form cannot offer a menu it has no way to fetch.
 *
 * So the console carries a copy, keyed by product rather than pretending the
 * vocabulary is universal. That is a real duplication and it will drift.
 *
 * # Why the drift is safe, which is the part that makes this acceptable
 *
 * The product validates authoritatively and refuses an unknown code with
 * §4.4's `invalid_reason_code`, which platform-api surfaces and this surface
 * renders. So a stale list here has exactly two failure modes:
 *
 *   - it offers a code the product has retired — the write is REFUSED, visibly
 *   - it omits a code the product has added — the option is missing
 *
 * Neither writes a wrong reason. A console-side list that could silently
 * record an unintended reason on an audit row would not be acceptable; one
 * that can only under-offer or be refused is.
 *
 * The proper fix is a contract endpoint declaring them. Filed separately —
 * this comment is the argument for why shipping the copy meanwhile is not
 * reckless, not an argument that the copy is correct.
 */

export interface ReasonCode {
  readonly code: string;
  readonly label: string;
}

/**
 * Mirrors `SuspendReasonCodes` in mark8ly's
 * `internal/handlers/platformadmin/tenant_lifecycle.go`.
 *
 * Labels are the console's own words; the CODE is what crosses the wire and
 * must match exactly. Renaming a label is safe, renaming a code is not.
 */
const MARK8LY_SUSPEND: readonly ReasonCode[] = [
  { code: "abuse", label: "Abuse — abusive content or behaviour" },
  { code: "fraud", label: "Fraud — suspected fraudulent transactions or identity" },
  { code: "non_payment", label: "Non-payment — dunning exhausted" },
  { code: "legal", label: "Legal — legal or regulatory demand" },
  { code: "tos_violation", label: "Terms breach — not covered by abuse or fraud" },
  { code: "security", label: "Security — compromised account or active incident" },
  { code: "voluntary", label: "Voluntary — the merchant asked for a pause" },
];

/**
 * Mirrors `UnsuspendReasonCodes`. Deliberately a DIFFERENT set from suspend —
 * mark8ly says so in its own comment, and the asymmetry is the point: the
 * reason a suspension ends is not the reason it began.
 */
const MARK8LY_UNSUSPEND: readonly ReasonCode[] = [
  { code: "resolved", label: "Resolved — the issue is settled" },
  { code: "appeal_upheld", label: "Appeal upheld — the suspension was contested and reversed" },
  { code: "operator_error", label: "Operator error — suspended in error" },
  { code: "voluntary_end", label: "Voluntary end — the merchant asked to resume" },
];

const BY_PRODUCT: Readonly<Record<string, { suspend: readonly ReasonCode[]; unsuspend: readonly ReasonCode[] }>> = {
  mark8ly: { suspend: MARK8LY_SUSPEND, unsuspend: MARK8LY_UNSUSPEND },
};

export type LifecycleVerb = "suspend" | "unsuspend";

/**
 * The codes to offer for one product's verb.
 *
 * An unknown product returns EMPTY rather than mark8ly's list. Offering one
 * product's vocabulary for another's tenant is how a wrong reason lands on an
 * audit row, and an empty menu is a visible gap where a borrowed one is an
 * invisible error. The caller renders the gap rather than guessing.
 */
export function reasonCodesFor(product: string, verb: LifecycleVerb): readonly ReasonCode[] {
  return BY_PRODUCT[product]?.[verb] ?? [];
}

/** Whether this console build knows any codes for a product. */
export function hasReasonCodes(product: string): boolean {
  return BY_PRODUCT[product] !== undefined;
}
