import { describe, expect, it } from "vitest";
import { isNavGroup, koraNav, type NavEntry } from "./nav";
import { webPath } from "./routes";

function collectItems(entries: NavEntry[]): { name: string; route: Parameters<typeof webPath>[0] }[] {
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
