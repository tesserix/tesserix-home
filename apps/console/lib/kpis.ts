import { NOT_IMPLEMENTED, toSurfaceError, type SurfaceError } from "@/components/kit/surface-state";
// The module that DECLARES the class. `platform-api.ts` re-exports the same
// binding (see its own comment on that re-export), so `instanceof` holds
// either way; this import is the shorter path to it.
import { PlatformApiError } from "./platform-api-error";

/**
 * One product's headline metrics — contract §3.1, read through platform-api's
 * `kpis` module (`GET /v1/kpis?source=<slug>`).
 *
 * This module is the parser and this surface's 501 copy. The request itself is
 * `fetchProductKpis` in `lib/platform-api.ts`, and the state mapping is
 * `resolveState`'s; nothing here decides either.
 *
 * # There is exactly one product per read
 *
 * `service.go`'s `Read` has no fan-out and says why: two products'
 * `orders_today` are different numbers about different businesses, so merging
 * them produces a figure that describes nothing. That is why this is a
 * product-rail surface rather than an estate one.
 *
 * # WHICH `data` WRAPPER THIS PARSER SEES — neither of the obvious answers
 *
 * There are two envelopes on this path and they are enforced in different
 * places:
 *
 * 1. Between the PRODUCT and platform-api, §8.6 wraps the metrics map in
 *    `data`. `service.go` unmarshals that wrapper itself and rejects a body
 *    without it, because §3.1 originally specified a bare top-level map and
 *    decoding that older shape would yield an empty map — indistinguishable
 *    from real zeroes. **That check is already made upstream; it is not this
 *    module's.**
 * 2. Between platform-api and the console, go-shared's `StandardResponse`
 *    wraps the payload in `data` again — and `platformRequest` unwraps that
 *    before any parser is called (see `unwrapEnvelope`).
 *
 * The handler passes `Metrics` straight to `httpx.WriteData`, so what reaches
 * `parseProductKpis` after both of those is the FLAT metrics map itself, not
 * an object with a `data` key. `platform-api`'s kpis handler test pins the
 * wire shape as `{"data":{"users_active":412}}`, whose unwrapped value is
 * `{"users_active":412}`.
 */

/**
 * One metric's value.
 *
 * Three types rather than `number`, matching `Metrics` (`map[string]any`) on
 * the producer. Its comment states the reason: §3.1 says scalars, and a
 * product may legitimately report a string ("healthy") or a bool beside its
 * numbers, so narrowing "would drop a metric the product meant to send, and
 * the console renders what it is given".
 */
export type MetricValue = number | string | boolean;

/**
 * A product's metrics, keyed by the product's own metric names.
 *
 * The keys are not enumerated here and are not configured per product. That is
 * what makes the surface generic: platform-api does not know them either — it
 * carries the map through — so the renderer shows whatever came back.
 */
export type ProductKpis = Readonly<Record<string, MetricValue>>;

function fail(message: string): never {
  throw new PlatformApiError(`kpis: ${message}`);
}

/**
 * Narrow one metric to a scalar.
 *
 * `null`, arrays and nested objects are refused rather than carried. §3.1's
 * map is flat and scalar-valued, and this surface has no rendering for the
 * other shapes: a `null` would reach the page as a blank or a dash sitting
 * beside real numbers, which is the same "a dash reads as a zero" confusion
 * the 501 contract exists to prevent. Refusing is the honest answer — the read
 * failed to mean anything, and the operator is told so.
 */
function scalar(value: unknown, key: string): MetricValue {
  if (typeof value === "number") {
    // JSON cannot carry NaN or Infinity, so this only excludes a non-JSON
    // caller; it costs nothing and keeps the type's promise true.
    if (!Number.isFinite(value)) fail(`${key} is not a finite number`);
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  fail(`${key} is not a number, string or boolean`);
}

/**
 * Parse the metrics map platform-api returned for one product.
 *
 * Returns a new object; the argument is never mutated.
 */
export function parseProductKpis(json: unknown): ProductKpis {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    fail("the metrics map is not an object");
  }

  const entries = Object.entries(json as Record<string, unknown>);

  // An empty map is a decode error, NOT the not-instrumented state.
  //
  // §3.1 requires a product with no metrics to answer 501 rather than `{}`,
  // and `service.go` refuses `{}` for the stated reason that it is
  // "indistinguishable from every metric being zero". Reporting it here as
  // "not instrumented" would hide a deviating product behind a
  // legitimate-looking answer.
  //
  // Honest about reachability: I could not construct a path where today's
  // platform-api hands `{}` to the console. Its own refusal is a plain
  // `fmt.Errorf`, which `writeReadError` falls through to `default` and
  // answers as 503 — so a product sending `{}` reaches the console as an
  // outage, not as an empty map. This check is therefore for a producer that
  // is not that code path, and its value is that "not instrumented" stays
  // decided by the status alone.
  if (entries.length === 0) {
    fail("the metrics map is empty — §3.1 requires 501 not_implemented instead");
  }

  return Object.fromEntries(entries.map(([key, value]) => [key, scalar(value, key)]));
}

/**
 * Callout heading for a 501 from this read.
 *
 * NOT the kit's default `instrumentation-unavailable` copy, which says the
 * observability data plane is parked and points at
 * `docs/observability-park.md`. That is the wrong place to send an operator
 * here: platform-api answers 501 when the PRODUCT says it has no headline
 * metrics — `service.go` folds the product's own 501, and an unmounted
 * `/admin/kpis` (404), into `ErrNotInstrumented` — or when this deployment
 * federates no products at all (`ErrNoProducts`). Neither is a parked
 * observability plane, and neither has anything to read in that doc.
 *
 * Kora answers 501 today ("kora does not report business KPIs yet"), so this
 * is the copy an operator sees on a real product, not a rare branch.
 */
export const KPIS_UNAVAILABLE_TITLE = "No headline metrics yet";

/**
 * Copy for the same 501.
 *
 * Says nothing failed and offers no retry, because neither would be true: the
 * product is answering, and it is answering that it has no numbers to give.
 * Deliberately makes no promise about when that changes — that is the
 * product's to decide, not this page's.
 */
export const KPIS_UNAVAILABLE_MESSAGE =
  "This product does not report headline metrics to the console yet. Nothing is broken " +
  "and there is nothing to retry — this surface fills in once the product reports them.";

/**
 * Narrow this read's rejection, attaching this surface's own 501 copy.
 *
 * Same shape and same reason as `inboxReadError` on the estate inbox page: the
 * STATUS carries the meaning — `resolveState` maps 501 to
 * `instrumentation-unavailable` and everything else to `error` — and the copy
 * override is opt-in precisely so `message`, an internal string, never reaches
 * the page.
 *
 * Everything that is not a 501 is left exactly as `toSurfaceError` made it. A
 * 503 in particular must stay an `error`: platform-api answers 503 when the
 * product could not be reached, and `writeReadError` is explicit that
 * rendering that as "no metrics" is the more dangerous of the two mistakes —
 * it tells an operator a number does not exist when it exists and cannot be
 * reached.
 */
export function kpisReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== NOT_IMPLEMENTED) return error;
  return {
    ...error,
    unavailable: { title: KPIS_UNAVAILABLE_TITLE, message: KPIS_UNAVAILABLE_MESSAGE },
  };
}
