import { describe, expect, it } from "vitest";
import {
  PRODUCT_IDS,
  capabilityForPath,
  productEntities,
  routeForPath,
  routeProduct,
} from "@tesserix/console-core";
import { resolveEntitySurface } from "./entity-param";

const DECLARED = PRODUCT_IDS.flatMap((id) =>
  productEntities(id).map((type) => ({ id, type })),
);

describe("resolveEntitySurface", () => {
  it("accepts every type every registry product declares", () => {
    expect(DECLARED.length, "no declared pairs — the rows below would be vacuous").toBe(4);
    for (const { id, type } of DECLARED) {
      expect(resolveEntitySurface(id, type), `${id}/${type}`).toEqual({ product: id, type });
    }
  });

  it("refuses a type another product declares", () => {
    // `foods` is Kora's and `tenants` is mark8ly's. A cross-product type is
    // the realistic mistake — a made-up string would not test that the check
    // is per product rather than a union of every declared type.
    expect(resolveEntitySurface("mark8ly", "foods")).toBeNull();
    expect(resolveEntitySurface("kora", "tenants")).toBeNull();
  });

  it("refuses the platform rail, which routing now sends here", () => {
    // `/platform/nope` matched nothing until a two-segment dynamic route
    // existed; `routing.test.ts` measures that it reaches this page now.
    expect(resolveEntitySurface("platform", "tenants")).toBeNull();
    expect(resolveEntitySurface("platform", "inbox")).toBeNull();
  });

  it("refuses a product the console does not serve", () => {
    expect(resolveEntitySurface("homechef", "users")).toBeNull();
  });

  it("refuses anything else a URL segment can carry", () => {
    for (const type of ["", "..", "USERS", "users/1", "tenants ", "%2e%2e"]) {
      expect(resolveEntitySurface("mark8ly", type), JSON.stringify(type)).toBeNull();
    }
  });
});

/**
 * THE SECURITY BOUNDARY at this depth.
 *
 * `capabilityForPath` falls back to `"read"` — the ticket every operator who
 * can reach the console holds — for any path no route id claims, and that
 * fallback is not a failure path, so nothing reports it.
 * `[product]/[entity]` matches any two segments, so a type added to `PRODUCTS`
 * without its route id would render one product's records world-readable and
 * silently.
 *
 * `products.test.ts` in console-core asserts the capability side over the
 * whole registry. What is added here is the tie to what this page will
 * ACTUALLY render: the two sets must be the same set.
 */
describe("every surface this page renders is gated on a declared route", () => {
  it("renders exactly the declared types whose path resolves to their own product's route", () => {
    const renderable = DECLARED.filter(
      ({ id, type }) => resolveEntitySurface(id, type) !== null,
    );
    const gated = DECLARED.filter(({ id, type }) => {
      const route = routeForPath(`/${id}/${type}`);
      return route !== undefined && routeProduct(route) === id;
    });
    expect(renderable).toEqual(gated);
    // And both are everything declared — so today no declared type is refused
    // for want of a route id, which is the state the assertion above is
    // guarding rather than merely describing.
    expect(renderable).toEqual(DECLARED);
  });

  it.each(DECLARED)("is not on the entry ticket at /$id/$type", ({ id, type }) => {
    expect(capabilityForPath(`/${id}/${type}`)).toBe("platform");
    // Spelled out as "not read" as well, because a future capability rename
    // could satisfy the equality above while reintroducing the fallback.
    expect(capabilityForPath(`/${id}/${type}`)).not.toBe("read");
  });

  // The negative control: a path this page REFUSES is also a path nothing
  // gates. Without it the rows above are consistent with every path under a
  // product root returning `platform`, which would measure the prefix rather
  // than the declaration.
  it.each([...PRODUCT_IDS])("falls back to the entry ticket for an undeclared type on %s", (id) => {
    expect(resolveEntitySurface(id, "no-such-declared-type")).toBeNull();
    expect(capabilityForPath(`/${id}/no-such-declared-type`)).toBe("read");
  });
});
