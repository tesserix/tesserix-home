import { describe, expect, it } from "vitest";
import { isInternal, requiresCapability } from "./internal-access";

describe("today: AUTH_PROVIDER unset or google", () => {
  // The console is deployed and working. If this branch ever denies, every
  // operator is locked out the moment the package ships — so these cases are
  // the regression guard on "merging changes nothing in production".
  it.each([
    ["unset", undefined],
    ["google", "google"],
  ])("admits a role-less session when provider is %s", (_label, provider) => {
    expect(isInternal(undefined, provider)).toBe(true);
    expect(isInternal([], provider)).toBe(true);
  });

  it("does not require a capability", () => {
    expect(requiresCapability(undefined)).toBe(false);
    expect(requiresCapability("google")).toBe(false);
  });
});

describe("after cutover: AUTH_PROVIDER=zitadel", () => {
  it("requires a capability", () => {
    expect(requiresCapability("zitadel")).toBe(true);
  });

  it("admits an operator holding the entry capability", () => {
    expect(isInternal(["read"], "zitadel")).toBe(true);
    expect(isInternal(["read", "execute-refund"], "zitadel")).toBe(true);
  });

  it.each([
    ["no roles claim", undefined],
    ["an empty role set", [] as string[]],
  ])("refuses a session with %s", (_label, roles) => {
    // This is the case that matters: a valid, correctly-signed session from a
    // user who has no grant on the Platform Console project — a tenant or
    // customer once apps/web admits them. The cookie is shared; the access
    // must not be.
    expect(isInternal(roles, "zitadel")).toBe(false);
  });

  it("refuses roles that do not include the entry capability", () => {
    // Holding some other capability without `read` should not open the door.
    expect(isInternal(["respond"], "zitadel")).toBe(false);
    expect(isInternal(["hard-delete"], "zitadel")).toBe(false);
  });

  it("is not satisfied by an admin-shaped role", () => {
    expect(isInternal(["admin"], "zitadel")).toBe(false);
    expect(isInternal(["*"], "zitadel")).toBe(false);
  });
});

describe("an unrecognised provider fails safe for the console's purpose", () => {
  it("does not enable the strict gate on a typo", () => {
    // A typo'd provider must not silently enable role enforcement and lock
    // everyone out; the strict path is opt-in by exact match. The inverse risk
    // — a typo disabling enforcement after cutover — is covered by the
    // deployment setting the value explicitly, and by ALLOWED_ADMIN_EMAILS
    // remaining in force until it retires.
    expect(isInternal(undefined, "zitadelx")).toBe(true);
    expect(isInternal(undefined, "ZITADEL")).toBe(true);
  });
});
