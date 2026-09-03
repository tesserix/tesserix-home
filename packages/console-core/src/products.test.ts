import { describe, expect, it } from "vitest";
import {
  PRODUCTS,
  PRODUCT_IDS,
  RAIL_IDS,
  productDeclaresKpis,
  productEntities,
  productLabel,
  productNav,
  productSource,
  railNav,
  type ProductId,
} from "./products";
import { navItems, platformNav } from "./nav";
import { ROUTE_IDS, routeProduct, webPath, type RouteId } from "./routes";
import { capabilityForPath, routeForPath } from "./route-access";
import { ESTATE } from "./estate";

describe("the product registry", () => {
  it("gives every product at least one entity type, with no duplicates", () => {
    // Empty would mean a product in the registry that can serve no entity
    // page at all — a rail with a root and nothing under it. A duplicate would
    // render the same page twice under one rail, and (worse) would make any
    // count derived from this list wrong without anything failing.
    for (const id of PRODUCT_IDS) {
      const types = productEntities(id);
      expect(types.length, `${id} declares no entity types`).toBeGreaterThan(0);
      expect(new Set(types).size, `${id} declares a duplicate entity type`).toBe(
        types.length,
      );
    }
  });

  it("declares exactly the types each product's admin-conformance.json does", () => {
    // Named rather than counted, because the failure this catches is a WRONG
    // type, not a missing one: `/admin/entities/{type}` answers 400 for a type
    // the product never declared, and a count would pass straight through
    // that. Source of truth is the products' own `admin-conformance.json`
    // (mark8ly contractVersion 3, kora contractVersion 2) — platform-api takes
    // the same lists as FEDERATION_<SLUG>_ENTITIES and knows none of them
    // itself.
    expect(productEntities("kora")).toEqual(["users", "foods"]);
    expect(productEntities("mark8ly")).toEqual(["tenants", "users"]);
  });

  it("records that both products declare kpis", () => {
    // Kora's implementation answers 501 — uninstrumented. That is a runtime
    // state a page renders, not a reason to record the declaration as absent:
    // recording `false` would make the console stop asking and never notice
    // when Kora instruments it.
    expect(productDeclaresKpis("kora")).toBe(true);
    expect(productDeclaresKpis("mark8ly")).toBe(true);
  });

  it("holds only products that declare contract endpoints", () => {
    // HomeChef, DevAI, Dwellm8 and HMS are in ESTATE and have no
    // `admin-conformance.json` declaration, so every federated read for them
    // is a 400. Pinned by name so adding one before it declares fails with the
    // reason rather than shipping a rail of broken pages.
    expect([...PRODUCT_IDS].sort()).toEqual(["kora", "mark8ly"]);
  });
});

describe("the registry and ESTATE agree where they overlap", () => {
  // Asserted, never derived. `EstateProduct.context` is apps/web's rail
  // context key and already diverges from product identity for at least one
  // product (Fe3dr's context is "homechef"), so `source` is declared
  // separately in products.ts. This test is the cheap check that the two
  // have not drifted for the two products where they do coincide — it would
  // be worthless if either were computed from the other.
  it.each(PRODUCT_IDS)("matches ESTATE's entry for %s", (id: ProductId) => {
    const estate = ESTATE.find((entry) => entry.context === productSource(id));
    expect(estate, `no ESTATE entry with context "${productSource(id)}"`).toBeDefined();
    expect(estate?.name).toBe(productLabel(id));
  });
});

describe("rails", () => {
  it("is the products plus the platform rail, platform first", () => {
    // The platform rail is the estate, not a product: it has no federation
    // slug, no entity types and no conformance declaration. RAIL_IDS is
    // derived from PRODUCT_IDS so a new product needs no second edit here —
    // which is the property this whole module exists to provide.
    expect(RAIL_IDS).toEqual(["platform", ...PRODUCT_IDS]);
  });

  it("resolves the platform rail to platformNav and each product to its own", () => {
    expect(railNav("platform")).toBe(platformNav);
    for (const id of PRODUCT_IDS) {
      expect(railNav(id)).toBe(productNav(id));
    }
  });

  it("points every rail entry at a route id that exists", () => {
    // The same guard nav.test.ts applies per-rail, applied here over the rails
    // the REGISTRY yields — so a product added with a rail that was never
    // checked cannot slip in. `webPath` may legitimately return undefined for
    // a console-native surface; what it must not do is throw.
    for (const id of RAIL_IDS) {
      for (const item of navItems(railNav(id))) {
        expect(() => webPath(item.route), `${id}: ${item.route}`).not.toThrow();
      }
    }
  });
});

describe("routes and products name each other", () => {
  it("names a registered product wherever a route declares one", () => {
    // The type already enforces this at compile time. Kept as a test because
    // the table is `as const satisfies`, and a widening mistake there (or a
    // future `product` read that takes a plain string) would remove the
    // compile-time check without removing the field.
    for (const id of ROUTE_IDS) {
      const product = routeProduct(id);
      if (product === undefined) continue;
      expect(PRODUCT_IDS, `${id} names an unregistered product`).toContain(product);
    }
  });

  it("gives every product-prefixed route a product, and no platform route one", () => {
    // The id prefix was the ONLY expression of this relationship before the
    // field existed. Both directions matter and they fail differently: a
    // `kora.*` route with no product drops out of anything iterating a
    // product's surfaces, and a `platform.*` route WITH one would file an
    // estate surface under a product rail.
    for (const id of ROUTE_IDS) {
      const prefix = id.split(".")[0];
      if (prefix === "platform") {
        expect(routeProduct(id), `${id} is a platform route with a product`).toBeUndefined();
      } else {
        expect(routeProduct(id), `${id} has no product`).toBe(prefix);
      }
    }
  });
});

describe("the generic mark8ly surfaces are gated, not left on the entry ticket", () => {
  // THE SECURITY ASSERTION OF THIS TASK. `capabilityForPath` falls back to
  // `read` — the ticket every operator who can reach the console holds — for
  // any path no route id claims. So a page at one of these paths with no
  // declared id would be readable by every signed-in operator, and nothing
  // would report an error, because the fallback is not a failure path. These
  // rows are what make that impossible.
  const paths = ["/mark8ly", "/mark8ly/tenants", "/mark8ly/users"] as const;
  const expected = {
    "/mark8ly": "mark8ly.overview",
    "/mark8ly/tenants": "mark8ly.tenants",
    "/mark8ly/users": "mark8ly.users",
  } as const;

  it.each(paths)("resolves %s to its own route id", (path) => {
    // Its OWN id, not merely "some id": each path must reach the surface that
    // owns it, so a later id whose path collided with another's would fail
    // here rather than silently borrowing its neighbour's capability.
    //
    // This is NOT the guard on `exact`. `routeForPath` is
    // longest-console-path-wins, so the root cannot out-compete a declared
    // child either way and these rows stay green with `exact` removed. The
    // `/mark8ly/foods` control below is what actually bites.
    expect(routeForPath(path)).toBe(expected[path]);
  });

  it.each(paths)("requires `platform` at %s, not the read fallback", (path) => {
    expect(capabilityForPath(path)).toBe("platform");
    // Spelled out as well as compared, because "not read" is the actual
    // requirement and a future capability rename could satisfy the line above
    // while quietly reintroducing the fallback.
    expect(capabilityForPath(path)).not.toBe("read");
  });

  it("gates a record page under an entity list through its parent", () => {
    // Detail pages get no id of their own — `routeForPath`'s prefix match is
    // load-bearing here in a way it is not for rail highlighting, and an
    // ungated record page is worse than an ungated list.
    expect(capabilityForPath("/mark8ly/tenants/some-tenant-id")).toBe("platform");
  });

  it("has a page per declared entity type, and no page for an undeclared one", () => {
    // Ties the route ids to the registry rather than to a hand-written list:
    // a type added to `PRODUCTS.mark8ly` without a route id would ship a page
    // on the `read` fallback, which is the whole hazard above.
    for (const type of productEntities("mark8ly")) {
      expect(capabilityForPath(`/mark8ly/${type}`), `/mark8ly/${type}`).toBe("platform");
    }
    // The control, and the only row here that pins `exact: true` on
    // `mark8ly.overview`. `foods` is Kora's type, not mark8ly's, so nothing
    // claims this path and it falls back to the entry ticket. Drop `exact` and
    // the overview claims every undeclared `/mark8ly/*` descendant, and this
    // line — alone in this file — goes red. It also keeps the assertions above
    // honest: they measure the declaration, not merely the `/mark8ly` prefix.
    expect(capabilityForPath("/mark8ly/foods")).toBe("read");
  });
});

describe("every declared entity type has a route id that gates its page", () => {
  // THE SECURITY ASSERTION OF THE GENERIC `[product]/[entity]` PAGE, stated
  // over the WHOLE registry rather than over mark8ly's three paths above.
  //
  // `app/(console)/[product]/[entity]/page.tsx` matches an arbitrary two-
  // segment path and renders any type `productEntities` declares. It is gated
  // by nothing but `capabilityForPath`, which falls back to `read` — the
  // ticket every operator who can reach the console holds — for a path no
  // route id claims. So a type added to `PRODUCTS` without its route id would
  // ship a page of one product's records readable by every signed-in
  // operator, and nothing would report an error: the fallback is not a
  // failure path. This is the row that must go red instead.
  //
  // The path is `/<product id>/<type>`: the first URL segment is the REGISTRY
  // KEY, because that is what `[product]` matches and what
  // `resolveProductParam` compares against `PRODUCT_IDS`. It equals
  // `productSource(id)` for both products today, and `ProductEntry.source` is
  // where the two are allowed to diverge.
  const declared = PRODUCT_IDS.flatMap((id) =>
    productEntities(id).map((type) => [id, type, `/${id}/${type}`] as const),
  );

  it("covers both products' types, so the rows below are not vacuous", () => {
    // A `flatMap` over an empty list produces an empty `it.each`, which passes
    // by running nothing. Four pairs: kora's users and foods, mark8ly's
    // tenants and users.
    expect(declared.map(([, , path]) => path)).toEqual([
      "/kora/users",
      "/kora/foods",
      "/mark8ly/tenants",
      "/mark8ly/users",
    ]);
  });

  it.each(declared)("gives %s's %s a route id at %s", (id, _type, path) => {
    const route = routeForPath(path);
    expect(route, `no route id claims ${path}`).toBeDefined();
    // Its OWN product's id, not merely "some id": a route claiming this path
    // while belonging to another product would be borrowing its neighbour's
    // capability, which is the same silent mis-gating the fallback produces.
    expect(routeProduct(route as RouteId), `${path} is claimed by another product`).toBe(id);
  });

  it.each(declared)("requires `platform` for %s's %s, not the read fallback", (_id, _type, path) => {
    expect(capabilityForPath(path)).toBe("platform");
    // Spelled out as well as compared, because "not the entry ticket" is the
    // actual requirement and a future capability rename could satisfy the line
    // above while quietly reintroducing the fallback.
    expect(capabilityForPath(path)).not.toBe("read");
  });

  // THE NEGATIVE CONTROL. Without it the two rows above are consistent with
  // `capabilityForPath` returning `platform` for every path under a product
  // root, which would make them measure the prefix rather than the
  // declaration. `no-such-declared-type` is declared by nobody, so nothing
  // claims these paths and each falls back to the entry ticket.
  //
  // It also bites on `exact: true`: drop it from `kora.overview` or
  // `mark8ly.overview` and that product's row goes red, because the root would
  // then claim every undeclared descendant. It is NOT the only such row —
  // `routes.ts` names the `/mark8ly/foods` control above as the pin for that
  // behaviour, and this covers kora as well rather than replacing it.
  it.each(PRODUCT_IDS)("falls back to the entry ticket for an undeclared type on %s", (id) => {
    const undeclared = `/${id}/no-such-declared-type`;
    expect(productEntities(id)).not.toContain("no-such-declared-type");
    expect(capabilityForPath(undeclared)).toBe("read");
  });
});

describe("the registry carries identity, not presentation", () => {
  it("holds no asset or layout fields", () => {
    // `RAILS` in apps/console's sidebar.tsx carries `mark`, `logo`, `onLight`
    // and `section`. Those are `apps/console/public/` concerns, and
    // console-core is a pure data package consumed by web, mobile AND console
    // — routes.ts refuses even a value import of `Capability` on that basis.
    // Pinned as a test because the pull to "just add the logo here" arrives
    // the moment Task 2 derives the rails from this table.
    const presentation = ["mark", "logo", "onLight", "section", "icon", "colour", "color"];
    for (const id of PRODUCT_IDS) {
      for (const field of presentation) {
        expect(PRODUCTS[id], `${id} carries presentation field "${field}"`).not.toHaveProperty(
          field,
        );
      }
    }
  });
});
