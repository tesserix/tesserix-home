import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityError } from "@tesserix/platform-auth";
import { consolePath, routeCapability } from "@tesserix/console-core";

/**
 * The access gate (#262, R2).
 *
 * Before this, every operator who could log in could reach every page by
 * typing its URL. `routes.ts` says of its own capability field that it is "a
 * discoverability gate, not an access gate", and nothing consulted it.
 *
 * What is asserted here is the gate's contract, not its plumbing: which
 * capability is demanded for a path, that the demand goes to the LIVE check,
 * and that a refusal is a not-found rather than a forbidden.
 */

const headerBag = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (key: string) => headerBag.get(key) ?? null }),
}));

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

const checkOperatorCapabilityLive = vi.fn();
vi.mock("@/lib/auth/operator", () => ({
  checkOperatorCapabilityLive: (...args: unknown[]) => checkOperatorCapabilityLive(...args),
}));

const getCurrentSession = vi.fn();
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: () => getCurrentSession(),
  toCapabilities: (roles: string[]) => roles,
}));

const requiresCapability = vi.fn(() => true);
vi.mock("@/lib/internal-access", () => ({ requiresCapability: () => requiresCapability() }));
vi.mock("@/lib/tools-directory", () => ({ readToolsDirectory: async () => ({ tools: [] }) }));
vi.mock("@/lib/health", () => ({ readEstateHealth: async () => null }));
vi.mock("@/components/nav/sidebar", () => ({ ConsoleSidebar: () => null }));
vi.mock("@/components/nav/console-header", () => ({ ConsoleHeader: () => null }));

const { CONSOLE_PATHNAME_HEADER } = await import("@/lib/auth/console-pathname");
const ConsoleLayout = (await import("./layout")).default;

beforeEach(() => {
  vi.clearAllMocks();
  headerBag.clear();
  getCurrentSession.mockResolvedValue({ sub: "op-1", email: "ops@tesserix.app", roles: ["crm"] });
  checkOperatorCapabilityLive.mockResolvedValue(undefined);
  requiresCapability.mockReturnValue(true);
});

async function renderAt(pathname: string) {
  headerBag.set(CONSOLE_PATHNAME_HEADER, pathname);
  return ConsoleLayout({ children: null });
}

describe("the console access gate", () => {
  it("demands the capability the requested surface declares", async () => {
    await renderAt(consolePath("platform.crm"));

    expect(checkOperatorCapabilityLive).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "op-1" }),
      routeCapability("platform.crm"),
    );
  });

  // A detail page is not its own route entry. Without the prefix match it
  // would fall through to the entry capability and every record page in the
  // console would be reachable by anyone who can log in.
  it("guards a detail page with its surface's capability", async () => {
    await renderAt(`${consolePath("platform.crm")}/11111111-1111-4111-8111-111111111111`);

    expect(checkOperatorCapabilityLive).toHaveBeenCalledWith(
      expect.anything(),
      routeCapability("platform.crm"),
    );
  });

  // R2.2. A permission error confirms the surface exists and leaks the shape
  // of the estate; pages already answer not-found for records that do not
  // exist, so a restricted surface is indistinguishable from one never built.
  it("answers not-found, never forbidden, when the capability is unheld", async () => {
    checkOperatorCapabilityLive.mockRejectedValue(new CapabilityError("platform"));

    await expect(renderAt(consolePath("platform.secrets"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  // The gate must not swallow an outage as a refusal: a store that could not
  // be read is not the same fact as a capability the operator does not hold,
  // and turning one into a 404 would hide an incident behind a missing page.
  it("lets an unexpected failure propagate rather than reading it as a refusal", async () => {
    checkOperatorCapabilityLive.mockRejectedValue(new Error("the store is down"));

    await expect(renderAt(consolePath("platform.crm"))).rejects.toThrow("the store is down");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("renders the surface when the capability is held", async () => {
    await expect(renderAt(consolePath("platform.crm"))).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  // The legacy provider carries no capability claims, so enforcing would
  // refuse every surface to every operator. "Off means unchanged" is the same
  // contract `visibleNav` and the palette's `visibleTo` give — a gate that
  // disagreed with the rail about whether enforcement is on would hide a
  // surface it still served, or serve one it hid.
  it("does not enforce when the provider carries no capabilities", async () => {
    requiresCapability.mockReturnValue(false);

    await expect(renderAt(consolePath("platform.secrets"))).resolves.toBeTruthy();
    expect(checkOperatorCapabilityLive).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });

  // What actually broke the e2e run, and it is not only a test concern: the
  // auth bypass returns from middleware before a session exists, and
  // `checkOperatorCapabilityLive` throws on a null session BEFORE it checks
  // the provider. Ungated, that turned every page in the console into a 404 —
  // this layout's own comment says a null session should render the header
  // without identity rather than fail the whole console.
  it("renders with no session at all when enforcement is off", async () => {
    requiresCapability.mockReturnValue(false);
    getCurrentSession.mockResolvedValue(null);

    await expect(renderAt("/")).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

});
