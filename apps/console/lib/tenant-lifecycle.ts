/**
 * The reason codes a tenant lifecycle change may carry.
 *
 * # This file used to be the problem it now solves
 *
 * §8.3 requires reason codes on anything reversible-but-consequential, and the
 * product is the authority on its own set. Until contract §8.8 there was no
 * way to ASK for that set — mark8ly's lived in a Go var — so this module
 * carried a hand-copied duplicate keyed by product, with a long comment
 * arguing that the drift was safe in a specific direction (tesserix-home#345).
 *
 * The argument was true and the copy is still gone, because the safe direction
 * was only half of it. Offering a RETIRED code is refused loudly with §4.4's
 * `invalid_reason_code`. Missing an ADDED one is silent: the option is simply
 * absent, and the operator picks the nearest wrong reason, which lands on an
 * audit row and is never questioned again.
 *
 * So the vocabulary is now fetched from the product that owns it, through
 * `GET /v1/tenants/lifecycle/reason-codes?source=`. What is left here is the
 * parsing and the lookup — no codes.
 */

/**
 * Why this render has no vocabulary for a product.
 *
 * The two cases have DIFFERENT remedies and must not share a sentence:
 *
 *   - `unreachable` — the product was not reached. The platform API answers
 *     503 for this (`writeReasonCodesError`'s default branch, "the product
 *     could not be reached for its lifecycle reason codes"). Reloading is the
 *     remedy, and it is usually enough: `mark8ly-marketplace-api-admin` runs a
 *     single replica with `maxSurge: 0`, so every one of its deploys takes the
 *     platform-admin surface down for the length of an image pull. That window
 *     is a documented, accepted trade-off in its chart — not a fault — which
 *     is exactly why the console must render it as transient.
 *   - `unpublished` — the product answered and published nothing. The platform
 *     API answers 501 for this (`ErrNoReasonCodes`). It is a contract gap on
 *     the product's side (§8.8) and reloading will never fix it.
 *
 * `unknown` is anything else, and it deliberately keeps the older, cautious
 * copy rather than guessing at one of the two above.
 */
export type ReasonCodeGap = "unreachable" | "unpublished" | "unknown";

/** Why each product this render asked has no vocabulary, keyed by product. */
export type ReasonCodeGaps = Readonly<Record<string, ReasonCodeGap>>;

/** The empty map, for a render where every product answered. */
export const NO_REASON_CODE_GAPS: ReasonCodeGaps = Object.freeze({});

/**
 * Classifies a failed §8.8 read from its HTTP status.
 *
 * Takes the STATUS rather than the error, deliberately: this module has no
 * imports and must keep none — it is reached from a `"use client"` component,
 * and `PlatformApiError` is a value import whose chain used to drag `pg` into
 * the browser bundle (see `platform-api-error.ts`). The caller does the
 * `instanceof` on the server and passes the number.
 *
 * An absent status is `unknown`, not `unreachable`: a throw with no status is
 * a client-side bug (a parse failure, a missing origin) as often as it is a
 * transport one, and telling an operator to reload will not fix either.
 */
export function classifyReasonCodeGap(status: number | undefined): ReasonCodeGap {
  if (status === 503) return "unreachable";
  if (status === 501) return "unpublished";
  return "unknown";
}

/** One reason a lifecycle change may carry. */
export interface ReasonCode {
  readonly code: string;
  readonly label: string;
}

export type LifecycleVerb = "suspend" | "unsuspend";

/**
 * One product's vocabulary, verb to codes.
 *
 * Deliberately not narrowed to `Record<LifecycleVerb, ...>`. A product's set of
 * consequential verbs is its own — mark8ly publishes `purge` and `trial_extend`
 * beside the two this surface uses — and a type that could not represent them
 * would force this parser to drop what it does not recognise, which is how a
 * console comes to decide what a product is allowed to say.
 */
export type ProductReasonCodes = Readonly<Record<string, readonly ReasonCode[]>>;

/** Every product whose vocabulary this render has, keyed by product id. */
export type ReasonCodeCatalog = Readonly<Record<string, ProductReasonCodes>>;

/** The empty catalog, for a render that fetched nothing. */
export const NO_REASON_CODES: ReasonCodeCatalog = Object.freeze({});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads one entry, returning null for anything malformed.
 *
 * A bad entry is DROPPED rather than rendered with a placeholder label. A menu
 * option reading "undefined" is one an operator can still select, and the
 * write that follows carries whatever code was beside it.
 */
function parseEntry(value: unknown): ReasonCode | null {
  if (!isRecord(value)) return null;
  const { code, label } = value;
  if (typeof code !== "string" || code === "") return null;
  // The label is the product's words. An entry with none is dropped rather
  // than falling back to the code: `tos_violation` is not a sentence to put in
  // front of an operator, and §8.8 requires a label, so a missing one is the
  // product deviating rather than something this file should paper over.
  if (typeof label !== "string" || label.trim() === "") return null;
  return { code, label };
}

/**
 * Parses the `data` of a §8.8 response into one product's vocabulary.
 *
 * Throws for a body that is not the contract's shape, rather than returning an
 * empty vocabulary. An empty menu and a malformed response must not arrive at
 * the caller as the same value — the first is a product that published
 * nothing, the second is a bug, and only one of them is worth retrying.
 */
export function parseReasonCodes(json: unknown): ProductReasonCodes {
  if (!isRecord(json)) {
    throw new Error("reason codes: response is not an object");
  }
  const data = isRecord(json.data) ? json.data : null;
  if (data === null) {
    throw new Error("reason codes: response has no data object");
  }

  const out: Record<string, readonly ReasonCode[]> = {};
  for (const [verb, raw] of Object.entries(data)) {
    if (!Array.isArray(raw)) continue;
    const codes = raw.map(parseEntry).filter((entry): entry is ReasonCode => entry !== null);
    // A verb whose entries were all malformed is left ABSENT, not empty — the
    // caller renders an absent verb as a gap and an empty one as an empty menu.
    if (codes.length > 0) out[verb] = codes;
  }
  return out;
}

/**
 * The codes to offer for one product's verb.
 *
 * A product missing from the catalog returns EMPTY rather than borrowing
 * another's. Offering one product's vocabulary for another's tenant is how a
 * wrong reason lands on an audit row, and an empty menu is a visible gap where
 * a borrowed one is an invisible error. The caller renders the gap.
 */
export function reasonCodesFor(
  catalog: ReasonCodeCatalog,
  product: string,
  verb: LifecycleVerb,
): readonly ReasonCode[] {
  return catalog[product]?.[verb] ?? [];
}

/** Whether this render holds any codes for a product's verb. */
export function hasReasonCodes(
  catalog: ReasonCodeCatalog,
  product: string,
  verb: LifecycleVerb,
): boolean {
  return reasonCodesFor(catalog, product, verb).length > 0;
}
