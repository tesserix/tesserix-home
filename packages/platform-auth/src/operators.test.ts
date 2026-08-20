import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./capabilities";
import {
  DEFAULT_PLATFORM_OPERATOR_EMAILS,
  capabilitiesFor,
  isPlatformOperator,
  platformOperatorEmails,
} from "./operators";

describe("the platform operator allowlist", () => {
  it("admits the two operators the console is for", () => {
    expect(isPlatformOperator("samyak.rout@gmail.com", "")).toBe(true);
    expect(isPlatformOperator("mahesh.sangawar@gmail.com", "")).toBe(true);
  });

  it.each([
    ["another gmail address", "someone.else@gmail.com"],
    ["a lookalike", "samyak.rout@gmail.com.attacker.tld"],
    ["a prefix of an allowed address", "samyak.rout@gmail.co"],
    ["empty", ""],
  ])("refuses %s", (_label, email) => {
    expect(isPlatformOperator(email, "")).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("refuses %s", (_label, email) => {
    expect(isPlatformOperator(email, "")).toBe(false);
  });

  it("compares case- and whitespace-insensitively", () => {
    // Zitadel echoes the address as the operator typed it at sign-up.
    expect(isPlatformOperator("  Samyak.Rout@Gmail.com ", "")).toBe(true);
  });

  it("reads an override list, so an operator can be added without a release", () => {
    const raw = "ops@tesserix.app, second@tesserix.app";
    expect(platformOperatorEmails(raw)).toEqual([
      "ops@tesserix.app",
      "second@tesserix.app",
    ]);
    expect(isPlatformOperator("ops@tesserix.app", raw)).toBe(true);
    // The override REPLACES the default; it is an allowlist, not an addition.
    expect(isPlatformOperator("samyak.rout@gmail.com", raw)).toBe(false);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["only separators", " , , "],
  ])("falls back to the built-in list when the override is %s", (_l, raw) => {
    expect(platformOperatorEmails(raw)).toEqual(DEFAULT_PLATFORM_OPERATOR_EMAILS);
  });
});

describe("capabilitiesFor", () => {
  it("grants an allowlisted operator every capability", () => {
    // Full access, regardless of what the identity provider granted — the
    // console must not be unusable because a role assignment is missing.
    expect(capabilitiesFor("samyak.rout@gmail.com", [], "")).toEqual([
      ...CAPABILITIES,
    ]);
  });

  it("narrows everyone else to the roles the provider actually granted", () => {
    expect(capabilitiesFor("someone.else@gmail.com", ["read", "crm"], "")).toEqual([
      "read",
      "crm",
    ]);
  });

  it("drops roles the capability model does not know", () => {
    expect(capabilitiesFor("someone.else@gmail.com", ["admin", "*"], "")).toEqual(
      [],
    );
  });
});
