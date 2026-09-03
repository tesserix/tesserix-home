import {
  PRODUCT_IDS,
  routeForPath,
  routeProduct,
  type ProductId,
} from "@tesserix/console-core";

/**
 * Which product, if any, a `[product]` path segment may render.
 *
 * # Registry membership alone is not enough, and the gap is an access one
 *
 * `[product]` matches ANY single segment, so this file decides which strings
 * reach a rendered page. `capabilityForPath` (`route-access.ts`) falls back to
 * `ENTRY_CAPABILITY` — `"read"`, the ticket every operator who can reach the
 * console holds — for any path no route id claims. So a product that sat in
 * `PRODUCTS` but had no route id for its root would render this page gated on
 * the ticket everybody has, and nothing would report an error: the fallback is
 * not a failure path.
 *
 * That is why the check below is TWO conditions and not one. Registry
 * membership says the console knows the product; the route lookup says the
 * access gate knows the path. Only both together mean the layout's gate ran
 * against a declared capability.
 *
 * # `routeForPath`, not a hand-built id string
 *
 * The gate in `app/(console)/layout.tsx` calls `capabilityForPath`, which is
 * `routeForPath` plus one lookup. Asking the SAME resolver here means this
 * page can only render for a path the gate resolved the same way — a route id
 * spelled `<product>.overview` but pointing its `console` path somewhere else
 * would fail here rather than render on the fallback.
 */
export function resolveProductParam(param: string): ProductId | null {
  const id = PRODUCT_IDS.find((candidate) => candidate === param);
  if (id === undefined) return null;

  // Built from `id` (a registry key that just matched), never from the raw
  // param, so nothing an operator can type reaches this string.
  const route = routeForPath(`/${id}`);
  if (route === undefined) return null;
  // `routeProduct` rather than "some route matched": a route claiming this
  // path while belonging to a different product (or to none) would be
  // borrowing its neighbour's capability, which is the same silent
  // mis-gating the fallback produces.
  return routeProduct(route) === id ? id : null;
}
