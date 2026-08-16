import { describe, expect, it } from "vitest";
import {
  isNavGroup,
  koraNav,
  platformNav,
  type NavEntry,
  type NavGroup,
} from "./nav";
import { isPending, isRetired, webPath } from "./routes";

function collectItems(
  entries: readonly NavEntry[],
): { name: string; route: Parameters<typeof webPath>[0] }[] {
  return entries.flatMap((entry) => (isNavGroup(entry) ? collectItems(entry.items) : [entry]));
}

describe("koraNav", () => {
  it("resolves every item's route through webPath without throwing", () => {
    // Catches a nav entry pointing at a route id that doesn't exist in
    // routes.ts — the exact drift (delivery-failures, missing chef-rewards
    // and tax-rates) that this package exists to prevent.
    for (const item of collectItems(koraNav)) {
      expect(() => webPath(item.route)).not.toThrow();
    }
  });
});

describe("platformNav", () => {
  it("offers no retired surface", () => {
    // A retired route has no page anywhere the console can send someone: the
    // capability moved into another surface. Listing it would put a door in
    // the rail that opens onto a redirect at best.
    const retired = collectItems(platformNav)
      .filter((item) => isRetired(item.route))
      .map((item) => `${item.name} (${item.route})`);
    expect(
      retired,
      `Retired routes must be dropped from the rail, not left in it: ` +
        `${retired.join(", ")}`,
    ).toEqual([]);
  });

  it("no longer carries Support analytics", () => {
    // #133 folded it into the Tickets surface as a tab. Naming it here rather
    // than relying on the count means re-adding the item fails with the reason
    // rather than with "expected 16 to be 15".
    const names = collectItems(platformNav).map((item) => item.name);
    expect(names).not.toContain("Support analytics");
    expect(names).toContain("Tickets");
  });

  it("still carries Live chat", () => {
    // #197 owns it, apps/web still serves it, and it is pending here. It was
    // deliberately left out of the #133 sweep.
    expect(collectItems(platformNav).map((item) => item.name)).toContain(
      "Live chat",
    );
  });

  it("carries the identity lookup in Operate, next to Tickets", () => {
    // #134's whole complaint is that the lookup exists and is unreachable
    // from any rail. Asserting the NAME and the GROUP, not just presence:
    // moving it into Governance would satisfy a presence check while
    // reproducing the original problem in a tidier location.
    const operate: NavGroup | undefined = platformNav
      .filter(isNavGroup)
      .find((group) => group.name === "Operate");
    expect(operate).toBeDefined();
    const names = operate!.items.map((item) => item.name);
    expect(names).toContain("Identity lookup");
    expect(names.indexOf("Identity lookup")).toBe(names.indexOf("Tickets") + 1);
  });

  it("shows the identity lookup as pending rather than linking it", () => {
    // The rail must describe the intended IA without claiming the page works.
    // There is no lookup surface in the console and no way to build one yet —
    // the console cannot enumerate users at all. In the rail, unnavigable; in
    // the palette, disabled.
    const lookup = collectItems(platformNav).find(
      (item) => item.route === "platform.identityLookup",
    );
    expect(lookup).toBeDefined();
    expect(isPending("platform.identityLookup")).toBe(true);
  });

  it("carries the estate audit log in Governance, at the top", () => {
    // #139. Asserting the GROUP, not just presence: Operate was the other
    // candidate and it is the wrong one. Identity lookup lives in Operate
    // because it is reached mid-ticket; the audit log is opened to answer "who
    // did this, and when", which is what Governance is for. Moving it into
    // Operate would satisfy a presence check while filing the accountability
    // surface under daily work.
    const governance: NavGroup | undefined = platformNav
      .filter(isNavGroup)
      .find((group) => group.name === "Governance");
    expect(governance).toBeDefined();
    const names = governance!.items.map((item) => item.name);
    expect(names).toContain("Audit log");
    expect(names[0]).toBe("Audit log");

    // And explicitly NOT in Operate, so a move is a failure rather than a
    // silently-passing duplicate.
    const operate: NavGroup | undefined = platformNav
      .filter(isNavGroup)
      .find((group) => group.name === "Operate");
    expect(operate!.items.map((item) => item.name)).not.toContain("Audit log");
  });

  it("links the audit log rather than showing it as pending", () => {
    // The console serves this page. `pending` would render it inert with a
    // SOON badge — a built surface unreachable from the rail, which is the
    // same failure #134 complains about, in reverse.
    const audit = collectItems(platformNav).find(
      (item) => item.route === "platform.auditLog",
    );
    expect(audit).toBeDefined();
    expect(isPending("platform.auditLog")).toBe(false);
  });

  it("resolves every item's route through webPath without throwing", () => {
    // Guards the guard above: if `collectItems` stopped descending into
    // groups it would return nothing and every assertion here would pass by
    // examining an empty list.
    //
    // `webPath` may legitimately return undefined for a console-native surface
    // (see RouteEntry.web); what it must never do is throw, which is what an
    // id absent from ROUTES does.
    const items = collectItems(platformNav);
    expect(items.length).toBeGreaterThan(10);
    for (const item of items) {
      expect(() => webPath(item.route)).not.toThrow();
    }
  });
});
