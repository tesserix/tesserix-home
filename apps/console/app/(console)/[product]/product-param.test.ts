import { describe, expect, it } from "vitest";
import {
  PRODUCT_IDS,
  capabilityForPath,
  routeForPath,
  routeProduct,
} from "@tesserix/console-core";
import { resolveProductParam } from "./product-param";

describe("resolveProductParam", () => {
  it("accepts every product in the registry", () => {
    for (const id of PRODUCT_IDS) {
      expect(resolveProductParam(id), id).toBe(id);
    }
  });

  it("refuses the platform rail, which is not a product", () => {
    // `/platform` reaches `[product]/page.tsx` — `routing.test.ts` measures
    // that — so this is the row that keeps the platform rail off a product
    // overview. `products.ts` says why `platform` must never join `PRODUCTS`:
    // it has no federation slug, no entity types and no conformance
    // declaration, because it IS the estate rather than a source in it.
    expect(resolveProductParam("platform")).toBeNull();
  });

  it("refuses a product the console does not serve", () => {
    // In `estate.ts`, absent from `PRODUCTS` — `products.ts` records that
    // HomeChef declares no contract endpoints, so every federated read for it
    // would answer 400 at the first hop.
    expect(resolveProductParam("homechef")).toBeNull();
  });

  it("refuses anything else a URL segment can carry", () => {
    for (const param of ["", "..", "KORA", "kora/foods", "mark8ly ", "%2e%2e"]) {
      expect(resolveProductParam(param), JSON.stringify(param)).toBeNull();
    }
  });
});

/**
 * THE SECURITY BOUNDARY, generalised over the registry.
 *
 * `capabilityForPath` falls back to `"read"` — the ticket every operator who
 * can reach the console holds — for any path no route id claims, and that
 * fallback is not a failure path, so nothing reports it. `[product]` matches
 * any segment, so a product added to `PRODUCTS` without its route ids would
 * render this page world-readable and silently.
 *
 * `products.test.ts` in console-core already pins this for mark8ly's three
 * paths by name. These rows are the same assertion made over `PRODUCT_IDS`, so
 * the NEXT product added is covered without anyone remembering to extend a
 * list.
 */
describe("every product this page renders is gated on a declared route", () => {
  it.each([...PRODUCT_IDS])("%s has an overview route that claims its root path", (id) => {
    const route = routeForPath(`/${id}`);
    expect(route, `/${id} is claimed by no route id`).toBeDefined();
    // Its OWN product's route, not merely some route: one borrowing another
    // product's id would inherit a capability nobody declared for this path.
    expect(routeProduct(route!)).toBe(id);
  });

  it.each([...PRODUCT_IDS])("%s is not gated on the entry ticket", (id) => {
    // Spelled out as "not read" as well as compared, for the reason
    // `products.test.ts` gives: a future capability rename could satisfy an
    // equality check while quietly reintroducing the fallback.
    expect(capabilityForPath(`/${id}`)).not.toBe("read");
  });

  it("requires `platform` at /mark8ly", () => {
    expect(capabilityForPath("/mark8ly")).toBe("platform");
  });

  it("renders only products whose root path is gated", () => {
    // The relationship stated as one claim: the set this page will render is
    // exactly the set of registry products whose root path resolves to their
    // own route. Add a product to `PRODUCTS` with no route ids and the two
    // sides diverge here.
    const renderable = PRODUCT_IDS.filter((id) => resolveProductParam(id) !== null);
    const gated = PRODUCT_IDS.filter((id) => {
      const route = routeForPath(`/${id}`);
      return route !== undefined && routeProduct(route) === id;
    });
    expect(renderable).toEqual(gated);
    expect(renderable).toEqual([...PRODUCT_IDS]);
  });
});
