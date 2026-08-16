import { describe, expect, it } from "vitest";
import { CapabilityError } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "./operator";

describe("checkOperatorCapability", () => {
  it("passes when a zitadel session holds the capability", () => {
    expect(() =>
      checkOperatorCapability({ roles: ["read", "respond"] }, "respond", "zitadel"),
    ).not.toThrow();
  });

  it("refuses a zitadel session lacking the capability", () => {
    expect(() =>
      checkOperatorCapability({ roles: ["read"] }, "respond", "zitadel"),
    ).toThrow(CapabilityError);
  });

  it("refuses a missing session regardless of provider", () => {
    // Middleware already gates the route, but a verb must not depend on that:
    // a null session here means fail closed, even under the legacy provider.
    expect(() => checkOperatorCapability(null, "respond", "google")).toThrow(
      CapabilityError,
    );
    expect(() => checkOperatorCapability(null, "respond", "zitadel")).toThrow(
      CapabilityError,
    );
  });

  it("accepts a role-less session under the legacy provider", () => {
    // Legacy google sessions carry no roles at all; requiring one would block
    // every write in local dev. Mirrors isInternal's provider gate.
    expect(() =>
      checkOperatorCapability({}, "respond", "google"),
    ).not.toThrow();
  });

  it("refuses a role-less zitadel session", () => {
    expect(() => checkOperatorCapability({}, "respond", "zitadel")).toThrow(
      CapabilityError,
    );
  });
});
