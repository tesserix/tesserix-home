import { describe, expect, it } from "vitest";
import { GatewayError } from "./client";
import { flipBlockersFrom, forceFlipMessage } from "./test-flip";

describe("flipBlockersFrom", () => {
  it("reads the blocker list off a 409", () => {
    const err = new GatewayError(409, "This kitchen still has work in flight", {
      blockers: ["9 active orders", "18 unsettled payouts"],
    });
    expect(flipBlockersFrom(err)).toEqual(["9 active orders", "18 unsettled payouts"]);
  });

  it("returns undefined for any other failure, so a network blip never offers a force", () => {
    expect(flipBlockersFrom(new Error("Network request failed"))).toBeUndefined();
    expect(flipBlockersFrom(new GatewayError(500, "Server error", {}))).toBeUndefined();
    expect(flipBlockersFrom(new GatewayError(409, "Conflict", { blockers: [] }))).toBeUndefined();
    expect(flipBlockersFrom("not an error")).toBeUndefined();
  });
});

describe("forceFlipMessage", () => {
  it("names every blocker, so nobody forces a flip without seeing what it parks", () => {
    const msg = forceFlipMessage(["9 active orders", "1 active meal plan"]);
    expect(msg).toContain("9 active orders");
    expect(msg).toContain("1 active meal plan");
  });

  it("says the parking reverses on the way back to live", () => {
    expect(forceFlipMessage(["9 active orders"]).toLowerCase()).toContain("live");
  });
});
