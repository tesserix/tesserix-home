import { describe, expect, it } from "vitest";
import { isNavGroup, koraNav, platformNav, type NavEntry } from "./nav";
import { isRetired, webPath } from "./routes";

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

  it("resolves every item's route through webPath without throwing", () => {
    // Guards the guard above: if `collectItems` stopped descending into
    // groups it would return nothing and every assertion here would pass by
    // examining an empty list.
    const items = collectItems(platformNav);
    expect(items.length).toBeGreaterThan(10);
    for (const item of items) {
      expect(() => webPath(item.route)).not.toThrow();
    }
  });
});
