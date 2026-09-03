import {
  productEntities,
  routeForPath,
  routeProduct,
  type ProductId,
} from "@tesserix/console-core";
import { resolveProductParam } from "../product-param";

/**
 * Which `(product, entity)` pair, if any, a `[product]/[entity]` path may render.
 *
 * # The product half is not re-checked here
 *
 * `resolveProductParam` is called rather than reimplemented. Both files guard
 * the same access boundary — `capabilityForPath` falls back to
 * `ENTRY_CAPABILITY` (`"read"`, the ticket every operator holds) for any path
 * no route id claims — and two independent implementations of one boundary
 * check drift apart. That file's own comment carries the full argument.
 *
 * # The entity half is the same two conditions, one segment deeper
 *
 * `productEntities(id)` says the console knows the type; `routeForPath` says
 * the access gate knows the path. Both are needed, and for different reasons:
 *
 *   - An undeclared type must not reach platform-api at all. It answers 400
 *     (`ErrTypeNotServed` → `BadRequest`) before calling the product, and a
 *     400 is not a state this page renders.
 *   - A declared type with NO route id would render on the `read` fallback,
 *     readable by every signed-in operator, with nothing reporting an error —
 *     the fallback is not a failure path. `products.test.ts` asserts every
 *     declared type has its route id so that gap fails a test rather than
 *     shipping; this check is what makes it a 404 rather than an open page if
 *     it ever ships anyway.
 *
 * The path is built from `id` and the MATCHED type, never from the raw params,
 * so nothing an operator can type reaches the lookup string.
 */
export interface EntitySurface {
  readonly product: ProductId;
  /** The declared entity type, as the registry spells it. */
  readonly type: string;
}

export function resolveEntitySurface(
  productParam: string,
  entityParam: string,
): EntitySurface | null {
  const product = resolveProductParam(productParam);
  if (product === null) return null;

  const type = productEntities(product).find((candidate) => candidate === entityParam);
  if (type === undefined) return null;

  const route = routeForPath(`/${product}/${type}`);
  if (route === undefined) return null;
  // `routeProduct` rather than "some route matched", for the reason
  // `resolveProductParam` states: a route claiming this path while belonging
  // to another product would be borrowing its neighbour's capability.
  return routeProduct(route) === product ? { product, type } : null;
}
