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

describe("an allowlisted platform operator holds only what they were granted", () => {
  it("REFUSES a risk verb for an allowlisted email with no roles", () => {
    // Reversed deliberately, and this is the sharp end of the change: an
    // allowlisted address used to pass every verb — including `hard-delete` —
    // with no grant at all. Entry is still the allowlist; the verbs now come
    // from Zitadel. An operator whose grant is missing can sign in and do
    // nothing, rather than sign in and do everything.
    expect(() =>
      checkOperatorCapability(
        { email: "mahesh.sangawar@gmail.com" },
        "hard-delete",
        "zitadel",
      ),
    ).toThrow(CapabilityError);
  });

  it("passes a risk verb once the grant actually carries it", () => {
    expect(() =>
      checkOperatorCapability(
        { email: "mahesh.sangawar@gmail.com", roles: ["read", "hard-delete"] },
        "hard-delete",
        "zitadel",
      ),
    ).not.toThrow();
  });

  it("does not extend that to any other email", () => {
    expect(() =>
      checkOperatorCapability(
        { email: "someone.else@gmail.com", roles: ["read"] },
        "hard-delete",
        "zitadel",
      ),
    ).toThrow(CapabilityError);
  });
});

describe("an allowlisted operator is checked against their grant, not waved through", () => {
  // The allowlist short-circuit here was the mutation-path twin of
  // capabilitiesFor's: an allowlisted email returned before any capability was
  // consulted, so every gated write succeeded for them regardless of grant.
  // With capabilities now derived from Zitadel, waving them through would keep
  // the old behaviour on exactly the path that matters most — writes.
  const listed = "samyak.rout@gmail.com";

  it("refuses an allowlisted operator who lacks the capability", () => {
    expect(() =>
      checkOperatorCapability(
        { email: listed, roles: ["read", "platform"] },
        "rotate-credentials",
        "zitadel",
      ),
    ).toThrow(CapabilityError);
  });

  it("allows an allowlisted operator who holds it", () => {
    expect(() =>
      checkOperatorCapability(
        { email: listed, roles: ["read", "rotate-credentials"] },
        "rotate-credentials",
        "zitadel",
      ),
    ).not.toThrow();
  });

  it("still short-circuits when the provider does not require capabilities", () => {
    // Local dev and pre-cutover google sessions carry no roles at all; this
    // branch is what keeps them working and must not be removed with the
    // allowlist one.
    expect(() =>
      checkOperatorCapability({ email: listed, roles: [] }, "rotate-credentials", "google"),
    ).not.toThrow();
  });
});
