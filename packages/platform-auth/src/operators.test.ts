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
  it("no longer grants an allowlisted operator every capability", () => {
    // Reversed deliberately. The old contract — full access regardless of the
    // grant, so a missing role assignment could not make the console unusable
    // — also made least privilege impossible and left #506's propose path and
    // #483's notification unreachable, because `platform` without
    // `rotate-credentials` could not exist. Entry is still the allowlist; the
    // power now comes from the grant. See capabilitiesFor's comment for the
    // accepted cost.
    expect(capabilitiesFor("samyak.rout@gmail.com", [], "")).toEqual([]);
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

describe("an allowlisted operator's POWER comes from their grant, not the list", () => {
  // The allowlist is the DOOR. It used to be the door and the keys: an
  // allowlisted address held every capability by construction, which made two
  // things impossible at once — least privilege for anyone, and the
  // propose-only operator that the secrets surface was built for (#506, #483).
  // Entry is unchanged; only the power derived from it moves to Zitadel.
  const listed = "samyak.rout@gmail.com";

  it("gives an allowlisted operator exactly the capabilities they were granted", () => {
    expect(capabilitiesFor(listed, ["read", "platform"])).toEqual([
      "read",
      "platform",
    ]);
  });

  it("no longer promotes an allowlisted operator to every capability", () => {
    // The specific regression this closes: `platform` without
    // `rotate-credentials` was unreachable, so the console could never render
    // the propose path and #483's notification had no possible recipient.
    expect(capabilitiesFor(listed, ["read", "platform"])).not.toContain(
      "rotate-credentials",
    );
  });

  it("gives an allowlisted operator with no grant no capabilities", () => {
    // Accepted trade, stated rather than discovered: they can still sign in —
    // entry is the allowlist — but they arrive able to do nothing until a
    // grant exists. Previously they arrived able to do everything.
    expect(capabilitiesFor(listed, [])).toEqual([]);
    expect(capabilitiesFor(listed, undefined as unknown as string[])).toEqual([]);
  });

  it("still narrows to the known vocabulary", () => {
    expect(capabilitiesFor(listed, ["read", "not-a-capability", "*"])).toEqual([
      "read",
    ]);
  });

  it("treats a non-allowlisted identity exactly as before", () => {
    expect(capabilitiesFor("someone.else@gmail.com", ["read"])).toEqual(["read"]);
    expect(capabilitiesFor("someone.else@gmail.com", [])).toEqual([]);
  });
});
