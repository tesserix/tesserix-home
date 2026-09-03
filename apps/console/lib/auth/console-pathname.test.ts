import { describe, expect, it } from "vitest";
import {
  ROUTE_IDS,
  capabilityForPath,
  consolePath,
  isShellRoute,
  routeCapability,
  routeForPath,
  type RouteId,
} from "@tesserix/console-core";

import { consoleGatePathname } from "./console-pathname";

/**
 * Percent-encoding must not walk past the console's access gate.
 *
 * `nextUrl.pathname` is not percent-decoded, but Next's router decodes the
 * params it captures — so before `consoleGatePathname` the gate and the page
 * resolved the same request from two different strings. `/%6Dark8ly` matched
 * no console route, fell back to the entry capability `read`, and then
 * rendered Mark8ly's overview because `[product]` matched the raw segment and
 * `resolveProductParam` received the decoded `"mark8ly"`.
 *
 * This is branch-introduced rather than latent: `[product]` is the console's
 * first top-level dynamic segment. Every route before it had a static first
 * segment, so an encoded path 404'd at the router — `/%70latform/inbox` still
 * does.
 *
 * The gate is asked here as the middleware asks it: `consoleGatePathname` and
 * then `capabilityForPath`. That composition, not either half, is the control.
 */
const gate = (pathname: string) => capabilityForPath(consoleGatePathname(pathname));

/**
 * The two properties of the route table that make normalisation safe, asserted
 * rather than assumed — `consoleGatePathname`'s "can only raise the
 * requirement" argument rests on them, and a route added later could break
 * either one without any other test noticing.
 */
describe("the route-table premises normalisation depends on", () => {
  it("declares no console path containing a percent sign", () => {
    // If a route path could be spelled with an escape, normalisation could
    // turn a path that matched it into one that does not — the one direction
    // that would LOWER a requirement.
    const encoded = ROUTE_IDS.map((id) => consolePath(id)).filter((p) => p.includes("%"));

    expect(encoded).toEqual([]);
  });

  it("nests no route under another that declares a different capability", () => {
    // Normalisation can only make `routeForPath` resolve to the same route or
    // to a MORE SPECIFIC one. That is a downgrade only if a nested route asks
    // for less than the route it sits under — including by being a shell
    // route, which `capabilityForPath` answers with the entry capability.
    const routes = ROUTE_IDS.map((id) => ({
      id,
      path: consolePath(id),
      capability: routeCapability(id),
      shell: isShellRoute(id),
    }));

    const downgrades = routes.flatMap((outer) =>
      routes
        .filter(
          (inner) =>
            outer.path !== "/" &&
            inner.id !== outer.id &&
            inner.path.startsWith(`${outer.path}/`) &&
            (inner.shell || inner.capability !== outer.capability),
        )
        .map((inner) => `${outer.path} (${outer.capability}) -> ${inner.path}`),
    );

    expect(downgrades).toEqual([]);
  });
});

describe("an encoded path is gated as its canonical form", () => {
  // The three paths measured against a running dev server, each of which
  // rendered another product's data on the `read` ticket.
  it.each([
    ["/%6Dark8ly", "/mark8ly"],
    ["/mark8ly/%74enants", "/mark8ly/tenants"],
    ["/%6Bora", "/kora"],
  ])("%s demands what %s demands", (encoded, canonical) => {
    expect(consoleGatePathname(encoded)).toBe(canonical);
    expect(gate(encoded)).toBe("platform");
    expect(gate(encoded)).not.toBe("read");
  });

  it("decodes a lower-case escape the same as an upper-case one", () => {
    // `%6d` and `%6D` are the same byte. A gate that only understood one of
    // them would be a one-character bypass.
    expect(gate("/%6dark8ly")).toBe("platform");
    expect(gate("/%6Dark8ly")).toBe("platform");
  });

  it("gates an encoded detail path by its surface", () => {
    expect(gate("/mark8ly/%74enants/some-tenant-id")).toBe("platform");
  });

  it("leaves an unencoded path byte-identical", () => {
    for (const id of ROUTE_IDS) {
      const path = consolePath(id);
      expect(consoleGatePathname(path), path).toBe(path);
    }
  });
});

describe("what cannot be decoded is left raw, which is today's behaviour", () => {
  // Each of these must be no MORE permissive than the un-normalised gate. The
  // second assertion in each case is that comparison, spelled out.
  it("keeps a malformed segment as it arrived", () => {
    // `decodeURIComponent("%")` throws.
    expect(consoleGatePathname("/%")).toBe("/%");
    expect(capabilityForPath("/%")).toBe("read");
  });

  it("still decodes the segments around a malformed one", () => {
    // Per segment, not all-or-nothing: abandoning the whole path on one bad
    // segment would hand this back as `read`.
    expect(consoleGatePathname("/%70latform/crm/%")).toBe("/platform/crm/%");
    expect(gate("/%70latform/crm/%")).toBe("crm");
    expect(capabilityForPath("/%70latform/crm/%")).toBe("read");
  });

  it("keeps a segment that would decode to contain a slash", () => {
    // The router splits the RAW pathname, so `%2F` is not a boundary to it and
    // must not become one here — decoding it would invent path structure no
    // layer ever matched.
    expect(consoleGatePathname("/mark8ly/tenants%2Fx")).toBe("/mark8ly/tenants%2Fx");
    expect(consoleGatePathname("/%2Fmark8ly")).toBe("/%2Fmark8ly");

    // Both fall back to `read`, which is what the RAW path resolves to today —
    // the requirement is that this is no more permissive, and it is identical.
    // `mark8ly.overview` is declared `exact`, so an undecodable segment under
    // a product root matches no route at all rather than inheriting the root's
    // capability. The page refuses it independently: `[entity]` receives the
    // decoded `"tenants/x"`, which `resolveEntitySurface` does not know.
    expect(gate("/mark8ly/tenants%2Fx")).toBe("read");
    expect(capabilityForPath("/mark8ly/tenants%2Fx")).toBe("read");
    expect(gate("/%2Fmark8ly")).toBe("read");
    expect(capabilityForPath("/%2Fmark8ly")).toBe("read");
  });

  it("still decodes the segments around one holding a slash", () => {
    // The prefix-matching surfaces are where this is visible: `/platform/crm`
    // is not `exact`, so its detail paths resolve to it.
    expect(consoleGatePathname("/%70latform/crm/a%2Fb")).toBe("/platform/crm/a%2Fb");
    expect(gate("/%70latform/crm/a%2Fb")).toBe("crm");
    expect(capabilityForPath("/%70latform/crm/a%2Fb")).toBe("read");
  });

  it("keeps a segment that would decode to contain a NUL", () => {
    // `recordDeniedAttempt` carries this string into an INSERT on
    // `console_audit_log`; a Postgres `text` value cannot hold U+0000, so a
    // refusal would fail to record the path that caused it.
    expect(consoleGatePathname("/mark8ly%00")).toBe("/mark8ly%00");
    expect(consoleGatePathname("/mark8ly%00")).not.toContain("\u0000");
    // Raw and decoded both resolve to nothing, so this is not a weakening —
    // it is a refusal the audit row can actually name.
    expect(gate("/mark8ly%00")).toBe("read");
    expect(capabilityForPath("/mark8ly%00")).toBe("read");
    expect(gate("/%70latform/crm/x%00")).toBe("crm");
  });

  it("decodes once and does not chase a fixed point", () => {
    // `%2525` is `%25` after the router's single decode, and `%25` is the
    // param the page sees. A second pass would produce `%`, a string neither
    // the router nor the page ever holds.
    expect(consoleGatePathname("/platform/crm/%2525")).toBe("/platform/crm/%25");
  });
});

/**
 * The four dynamic segments whose VALUES may legitimately be percent-encoded.
 * Normalising for the gate must not over-gate them, and must not under-gate
 * them either: each resolves through `routeForPath`'s prefix match to the
 * surface that owns it, exactly as its unencoded form does.
 */
describe("the other dynamic routes keep working with encoded values", () => {
  it.each<[RouteId, string]>([
    ["platform.secrets", "/platform/secrets/tesserix/db%2Dpassword"],
    ["platform.secrets", "/platform/secrets/tesserix/nested/key%20with%20spaces"],
    ["platform.crm", "/platform/crm/acme%20holdings"],
    ["platform.tickets", "/platform/tickets/TCK%2D001"],
    ["platform.secretsReviews", "/platform/secrets/reviews/%31%32"],
  ])("%s still owns %s", (id, path) => {
    const normalised = consoleGatePathname(path);

    expect(routeForPath(normalised)).toBe(id);
    expect(capabilityForPath(normalised)).toBe(routeCapability(id));
  });

  it("does not let an encoded value borrow a nested surface's gate", () => {
    // `/platform/secrets/%72eviews` decodes onto `platform.secretsReviews`
    // rather than staying on `platform.secrets`. That is the more-specific
    // resolution normalisation is allowed to reach, and it is safe here only
    // because the two declare the same capability — which is exactly what the
    // nesting premise above asserts for the whole table.
    expect(routeForPath(consoleGatePathname("/platform/secrets/%72eviews")))
      .toBe("platform.secretsReviews");
    expect(gate("/platform/secrets/%72eviews")).toBe(
      capabilityForPath("/platform/secrets/reviews"),
    );
  });
});
