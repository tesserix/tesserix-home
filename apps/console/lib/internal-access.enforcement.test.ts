import { describe, expect, it } from "vitest";
import { enforcesRouteCapabilities } from "./internal-access";

/**
 * The RBAC kill switch (#266, R6.2).
 *
 * #262's gate fails closed with no wildcard and no superuser, and refuses with
 * a 404 indistinguishable from "never built". A grant narrowed by mistake
 * therefore removes an operator's access with no signal and no way back except
 * a redeploy. This is the way back, and what matters about it is the
 * asymmetry: it may only ever subtract.
 */
describe("enforcesRouteCapabilities", () => {
  it("enforces by default under zitadel, so merging the switch changes nothing", () => {
    expect(enforcesRouteCapabilities("zitadel", undefined)).toBe(true);
    expect(enforcesRouteCapabilities("zitadel", "")).toBe(true);
  });

  it("stops enforcing when explicitly turned off", () => {
    expect(enforcesRouteCapabilities("zitadel", "off")).toBe(false);
    expect(enforcesRouteCapabilities("zitadel", "  OFF  ")).toBe(false);
  });

  // The asymmetry. A symmetric toggle set "on" under a provider that carries
  // no capability claims would refuse EVERY surface to EVERY operator, because
  // visibleNav and the gate both fail closed — the exact lockout this switch
  // exists to undo.
  it("cannot enable enforcement where capabilities do not exist", () => {
    expect(enforcesRouteCapabilities("google", "on")).toBe(false);
    expect(enforcesRouteCapabilities("google", "true")).toBe(false);
    expect(enforcesRouteCapabilities(undefined, "on")).toBe(false);
  });

  // A typo must fail in the safe direction. Anything that is not exactly the
  // off-word leaves enforcement on, which is today's behaviour — no parser, so
  // no parser bug can silently disable the gate.
  it("leaves enforcement on for any value that is not the off word", () => {
    for (const typo of ["offf", "0", "false", "no", "disabled", "OFF!"]) {
      expect(enforcesRouteCapabilities("zitadel", typo), typo).toBe(true);
    }
  });
});
