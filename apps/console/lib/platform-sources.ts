// `PlatformApiError` from HERE, not from `./platform-api`: the funnel page
// hands this module's output to a client component, and the class is a VALUE,
// so importing it from `platform-api.ts` would rope `pg` into the browser
// bundle. See `platform-api-error.ts`'s own header.
import { PlatformApiError } from "./platform-api-error";

/**
 * Which products declare what — `GET /v1/platform/sources`.
 *
 * # Why this read exists at all
 *
 * Several federated routes are scoped to the products DECLARING an endpoint,
 * require a `source`, and answer 400 for a product that did not declare one.
 * Until this route there was nothing a caller could read to avoid that 400,
 * which is why `/platform/onboarding` carried a hardcoded `mark8ly` and could
 * not offer a picker: the picker would have offered sources the API refuses.
 *
 * The list is the DEPLOYMENT's own declarations rather than a console-side
 * literal, so a second product appears here without a console change — and,
 * just as importantly, a product that stops declaring disappears without one.
 *
 * # A slug here is a declaration, not a working product
 *
 * platform-api's `sources` module answers from configuration alone and calls
 * no product, deliberately. So a slug appears because
 * `FEDERATION_<SLUG>_ENDPOINTS` named the endpoint, and whether that product
 * actually answers is a different question, settled on the read that needs it —
 * which is where "unreachable" is already kept distinct from "empty".
 *
 * # Both maps are always present
 *
 * The API marshals `{}` rather than `null` for an estate that federates
 * nothing, and this parser preserves that: an empty picker is a legitimate
 * answer, and a page that throws on an empty estate is worse than one that
 * shows nothing to pick.
 */
export interface PlatformSources {
  /** Endpoint name to the slugs declaring it — `onboarding`, `outbox`. */
  readonly endpoints: Readonly<Record<string, readonly string[]>>;
  /** §3.4 entity type to the slugs serving it — `tenants`, `users`. */
  readonly entities: Readonly<Record<string, readonly string[]>>;
}

function fail(message: string): never {
  throw new PlatformApiError(`platform sources: ${message}`);
}

/**
 * One inverted map — declaration name to slugs.
 *
 * A missing key is refused rather than defaulted to `{}`. The two are not the
 * same answer: `{}` means "this deployment declares no endpoints", which is a
 * real and renderable fact, while an absent key means something other than
 * this route answered — a proxy, an error page, a rewritten body — and
 * rendering that as "nothing is federated" is the same phantom-measurement
 * failure the funnel's parser exists to prevent, one surface over.
 */
function invertedMap(value: unknown, path: string): Record<string, readonly string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} is missing`);
  }
  const out: Record<string, readonly string[]> = {};
  for (const [name, slugs] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(slugs)) fail(`${path}.${name} is not a list`);
    for (const slug of slugs) {
      if (typeof slug !== "string") fail(`${path}.${name} carries a slug that is not a string`);
    }
    out[name] = slugs as readonly string[];
  }
  return out;
}

/** Parse the platform API's `/v1/platform/sources` `data` object. */
export function parsePlatformSources(json: unknown): PlatformSources {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    fail("response is not an object");
  }
  const body = json as Record<string, unknown>;
  return {
    endpoints: invertedMap(body.endpoints, "endpoints"),
    entities: invertedMap(body.entities, "entities"),
  };
}

/**
 * The slugs declaring one endpoint, in the order the API sorted them.
 *
 * An endpoint nobody declares is absent from the map, not present-and-empty,
 * and both mean the same thing to a caller: no product to ask. The order is
 * the API's — it sorts, so two identical deployments render an identical
 * picker rather than looking like different estates.
 */
export function slugsDeclaring(
  sources: PlatformSources,
  endpoint: string,
): readonly string[] {
  return sources.endpoints[endpoint] ?? [];
}
