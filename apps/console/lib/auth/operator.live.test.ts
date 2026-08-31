import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityError } from "@tesserix/platform-auth";
import type { CapabilityResolution } from "./platform-token";

/**
 * The live verb gate — tesserix-home#285.
 *
 * The question this file exists to answer is NOT "does `hasCapability` work"
 * (that has its own tests in `platform-auth`), it is "WHICH LIST DECIDES". A
 * grant that was revoked in Zitadel an hour ago is still in the session cookie
 * for the remaining six days of its life, so a gate that consults the cookie
 * is a gate that cannot be revoked. The store's answer has to WIN, in both
 * directions, and the first test below fails loudly if anyone reverts the gate
 * to reading `session.roles`.
 *
 * The resolver is doubled: the store's SQL, the row lock, the refresh and the
 * interval all have their own coverage in
 * `platform-token.capabilities.test.ts`. What is under test here is the
 * ordering of the four checks and what each outcome of the resolver is allowed
 * to mean.
 */

const state = vi.hoisted(() => ({
  /** What the resolver answers. */
  resolution: {
    source: "store",
    capabilities: [] as string[],
  } as CapabilityResolution,
  /** Every call, so the bypass tests can prove NO I/O was attempted. */
  calls: [] as unknown[],
}));

vi.mock("./platform-token", () => ({
  resolveLiveCapabilities: async (session: unknown) => {
    state.calls.push(session);
    return state.resolution;
  },
}));

const { checkOperatorCapabilityLive, checkOperatorCapability } = await import(
  "./operator"
);

const SESSION = {
  sub: "operator-1",
  sid: "sid-1",
  email: "not.on.the.allowlist@example.com",
  exp: Math.floor(Date.now() / 1000) + 86_400,
};

function fromStore(...capabilities: string[]): CapabilityResolution {
  return { source: "store", capabilities };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.calls = [];
  state.resolution = fromStore();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("the store decides, not the cookie", () => {
  it("REFUSES a capability the cookie carries and the store does not", async () => {
    // THE WHOLE ISSUE. `hard-delete` was revoked in Zitadel; the cookie was
    // minted before that and still says otherwise. If this passes, the gate
    // has been reverted to reading `session.roles` and a revocation takes a
    // week again.
    state.resolution = fromStore("crm");

    await expect(
      checkOperatorCapabilityLive(
        { ...SESSION, roles: ["crm", "hard-delete"] },
        "hard-delete",
        "zitadel",
      ),
    ).rejects.toThrow(CapabilityError);
  });

  it("ALLOWS a capability the store carries and the cookie does not", async () => {
    // The 2026-08-19 case, fixed in the same motion: four roles were GRANTED
    // and neither operator saw them until they signed in again.
    state.resolution = fromStore("crm", "hard-delete");

    await expect(
      checkOperatorCapabilityLive(
        { ...SESSION, roles: ["crm"] },
        "hard-delete",
        "zitadel",
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses when the store confirms an empty grant, cookie notwithstanding", async () => {
    // `[]` is a real answer — "every grant removed" — and must not be confused
    // with the store having nothing to say.
    state.resolution = fromStore();

    await expect(
      checkOperatorCapabilityLive(
        { ...SESSION, roles: ["crm"] },
        "crm",
        "zitadel",
      ),
    ).rejects.toThrow(CapabilityError);
  });
});

describe("when there is no live answer, the cookie decides and the fallback is visible", () => {
  it("falls back to the cookie's snapshot and WARNS", async () => {
    // Refusing every gated action during a database blip is its own outage,
    // and the cookie's grant is issuer-attested — merely stale.
    state.resolution = { source: "unavailable", reason: "store-unavailable" };

    await expect(
      checkOperatorCapabilityLive(
        { ...SESSION, roles: ["crm"] },
        "crm",
        "zitadel",
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("falling back");
  });

  it("still fails closed on the fallback when the cookie does not carry it either", async () => {
    state.resolution = { source: "unavailable", reason: "revalidation-failed" };

    await expect(
      checkOperatorCapabilityLive(
        { ...SESSION, roles: ["crm"] },
        "hard-delete",
        "zitadel",
      ),
    ).rejects.toThrow(CapabilityError);
  });

  it("does NOT warn for a session that predates the token store", async () => {
    // `no-sid` is an ordinary fact for seven days after the store shipped, not
    // a fault. Warning on it would fire for every such session and train
    // everyone to ignore the line that matters.
    state.resolution = { source: "unavailable", reason: "no-sid" };

    await expect(
      checkOperatorCapabilityLive(
        { sub: "operator-1", email: SESSION.email, roles: ["crm"] },
        "crm",
        "zitadel",
      ),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the bypasses short-circuit BEFORE any I/O", () => {
  it("refuses a missing session without consulting the store", async () => {
    await expect(
      checkOperatorCapabilityLive(null, "crm", "zitadel"),
    ).rejects.toThrow(CapabilityError);
    expect(state.calls).toEqual([]);
  });

  it("allows the legacy provider without consulting the store", async () => {
    // Legacy google sessions carry no roles at all; requiring one would refuse
    // every write in local dev.
    state.resolution = fromStore();

    await expect(
      checkOperatorCapabilityLive({ sub: "s" }, "crm", "google"),
    ).resolves.toBeUndefined();
    expect(state.calls).toEqual([]);
  });

  it("allows an allowlisted operator without consulting the store", async () => {
    // Load-bearing, not an optimisation: both operators on the current
    // allowlist take this branch, so in this estate today the mutation path
    // touches neither Postgres nor Zitadel.
    state.resolution = fromStore();

    await expect(
      checkOperatorCapabilityLive(
        { sub: "s", email: "mahesh.sangawar@gmail.com" },
        "hard-delete",
        "zitadel",
      ),
    ).resolves.toBeUndefined();
    expect(state.calls).toEqual([]);
  });
});

describe("the synchronous gate is unchanged", () => {
  it("still decides on the cookie, and does no I/O", () => {
    // Kept for the render path and for the one call site that must not depend
    // on the database — logout. Its own semantics are pinned by operator.test.ts;
    // this only asserts it did not quietly acquire the store.
    expect(() =>
      checkOperatorCapability({ roles: ["respond"] }, "respond", "zitadel"),
    ).not.toThrow();
    expect(state.calls).toEqual([]);
  });
});
