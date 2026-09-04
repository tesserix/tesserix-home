import type { SurfaceState } from "@/components/kit/surface-state";

/**
 * "This deployment does not federate that product" — the calm state, and its
 * copy, shared by the two generic product surfaces.
 *
 * # The defect this exists to close (#546)
 *
 * THE WIRE HAS SINCE BEEN FIXED — platform-api now answers 501 for every one
 * of the refusals below, so `resolveState` reaches
 * `instrumentation-unavailable` on its own and each surface's own 501 copy
 * renders. What follows describes the behaviour this gate was written against
 * and still covers: the console and platform-api are separate images, so a
 * console can be serving against an API that predates that change, and the
 * gate is what keeps THAT deployment calm. It is a fallback now, not the fix.
 *
 * platform-api scoped its federated reads to the products this DEPLOYMENT
 * declares, and refused a product outside that scope with 400:
 *
 *   - `kpis`: `service.Read` answers `ErrNoProducts` (→ 501) when
 *     `FEDERATION_PRODUCTS` is empty, but `ErrUnknownSource` (→ 400) when the
 *     list is non-empty and does not contain the requested slug.
 *   - `entities`: `service.Read` answers `ErrNotInstrumented` (→ 501) when
 *     `len(s.types) == 0` — which, because `main.go` writes a key per
 *     FEDERATED SLUG rather than per declaring one, means this deployment
 *     federates nothing at all. Otherwise `ErrUnknownSource` (→ 400) when the
 *     slug is not a federated product, and `ErrTypeNotServed` (→ 400) when it
 *     is one but declared no such type — including when its
 *     `FEDERATION_<SLUG>_ENTITIES` is unset entirely.
 *
 * `resolveState` maps 501 to `instrumentation-unavailable` and everything else
 * to `error`, so only the "nothing is federated at all" edge read calmly. The
 * likelier production state — one product federated, the other not — rendered
 * an outage-shaped page for a deployment working exactly as configured.
 *
 * # Why this started as a console fix, and what the Go change added
 *
 * `GET /v1/platform/sources` already tells the console which products declare
 * what, from the same configuration the refusals are computed from. That was
 * enough for the console to stop RENDERING the refusal as breakage, but not
 * enough to make the wire honest — and it left the console CONCLUDING from two
 * signals rather than reading one it could trust.
 *
 * platform-api now sends that signal: `ErrUnknownSource` and
 * `ErrTypeNotServed` are 501, each keeping its own message, and a product
 * answering `{}` is a 503 under `EXTERNAL_SERVICE_ERROR` rather than the
 * "could not be reached" default. A malformed request is still a 400, which is
 * the meaning that status can actually enforce.
 *
 * # No new `SurfaceState` kind
 *
 * `instrumentation-unavailable` already means "this is off, not broken", and
 * its `title`/`message` overrides exist precisely because "not wired up yet"
 * has more than one cause with more than one remedy — see the union's own
 * comment in `surface-state.ts`. An unfederated product is that state with a
 * config-shaped remedy, the same way `KPIS_UNAVAILABLE_*` and the entity
 * surface's 501 copy are.
 */

/**
 * 400 Bad Request, named for the same reason `NOT_IMPLEMENTED` is: the status
 * carries the meaning here, and two private copies of the number is how that
 * agreement drifts apart.
 */
export const BAD_REQUEST = 400;

/** Callout heading for a product this deployment does not federate. */
export function notFederatedTitle(label: string): string {
  return `${label} is not federated here`;
}

/**
 * Copy for the same state.
 *
 * Says nothing failed and offers no retry, because neither would be true: the
 * platform API answered, and it answered that it has no route to this product.
 * Points at the deployment's federation configuration rather than at
 * `docs/observability-park.md` — the kit's default sends an operator to a
 * parked observability plane, which has nothing to do with a product that was
 * never wired to this console.
 */
export function notFederatedMessage(label: string): string {
  return (
    `This console deployment does not federate ${label}, so the platform API ` +
    `has nothing to read for it. Nothing is broken and there is nothing to ` +
    `retry — this surface turns on when the platform API is configured to ` +
    `federate ${label}.`
  );
}

/** Callout heading for one entity type this deployment cannot read. */
export function typeNotFederatedTitle(label: string, type: string): string {
  return `${label}'s ${type} are not federated here`;
}

/**
 * Copy for the entity surface's version of the same state.
 *
 * TRUE OF BOTH CAUSES, deliberately: the deployment may federate no `${label}`
 * at all (`ErrUnknownSource`), or federate it without `${type}` among its
 * declared entity types (`ErrTypeNotServed`). The console cannot tell the two
 * apart from `/v1/platform/sources` — a slug with no declarations is absent
 * from the map exactly as an unfederated one is — so the message names the
 * observable fact both share and the one configuration value that fixes
 * either.
 */
export function typeNotFederatedMessage(label: string, type: string): string {
  return (
    `This console deployment does not federate ${label}'s ${type} records. ` +
    `Nothing is broken and there is nothing to retry — this surface turns on ` +
    `when the platform API federates ${label} with ${type} among its declared ` +
    `entity types.`
  );
}

/** The state itself, built once so the two surfaces cannot drift apart on the
 *  kind while agreeing on the copy. */
export function notFederatedState(title: string, message: string): SurfaceState {
  return { kind: "instrumentation-unavailable", title, message };
}
