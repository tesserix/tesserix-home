import { describe, expect, it } from "vitest";
import { getProductConfig, listProductConfigs } from "@/lib/products/configs";
// The nav data and active-state logic that sidebar.tsx renders live in
// lib/products/nav-config.ts (a plain, browser-dependency-free module) rather
// than in components/admin/sidebar.tsx itself, specifically so they're
// testable: vitest.config.ts's `include` only covers lib/**/*.test.ts and
// app/**/*.test.ts (components/ is never discovered), and sidebar.tsx pulls
// in @tesserix/web, whose compiled output fails to resolve under Vitest's
// Node ESM loader. This file is the co-located home for kora's other
// config-surface assertions, so the nav entry and its active-state logic are
// asserted here rather than in a parallel, silently-unrun test file.
import { koraNav, isNavItemActive } from "@/lib/products/nav-config";

describe("kora product config", () => {
  it("is registered and resolvable by id", () => {
    const kora = getProductConfig("kora");
    expect(kora.id).toBe("kora");
    expect(kora.name).toBe("Kora");
    expect(kora.namespace).toBe("kora");
  });

  // Kora got a DEDICATED CloudNativePG cluster on 2026-08-04. Pointing this at
  // the shared global-postgres would silently report four other products'
  // database figures labelled as Kora's — a wrong number, not a missing one.
  it("points the DB panels at the dedicated cluster, not the shared one", () => {
    expect(getProductConfig("kora").cnpgClusterName).toBe("kora-postgres");
    expect(getProductConfig("kora").cnpgClusterName).not.toBe("global-postgres");
  });

  // Kora has no subscriptions, so the billing section must auto-hide.
  // hasBilling in product-overview-layout.tsx is Boolean(config.pricingByPlan).
  it("declares no pricing, so the billing section hides", () => {
    expect(getProductConfig("kora").pricingByPlan).toBeUndefined();
  });

  // These six keys are the contract with /api/admin/apps/kora/kpis.
  // resolveKpiValue looks each tile up BY KEY in the KPI map; a key that
  // disagrees renders "—" with no error anywhere.
  it("declares the six tiles the kpis route populates", () => {
    const keys = getProductConfig("kora").businessKpiTiles.map((t) => t.key);
    expect(keys).toEqual([
      "food_index_missing",
      "ai_calls_24h",
      "ai_failures_24h",
      "decompose_over_budget_pct",
      "ai_keys_configured",
      "ai_key_age_days",
    ]);
    for (const tile of getProductConfig("kora").businessKpiTiles) {
      expect(tile.source).toBe("product");
    }
  });

  it("appears in the registry listing", () => {
    expect(listProductConfigs().map((c) => c.id)).toContain("kora");
  });
});

describe("kora nav", () => {
  // Regression: "Service health" used to sit in this rail pointing at
  // /admin/health — the PLATFORM health page — so clicking it inside Kora
  // navigated the operator out of the product with no way back but the rail
  // switcher. Asserting the entries are non-empty first means this is a
  // genuine containment check and not a rail that happens to be empty.
  it("never links out of the Kora product surface", () => {
    expect(koraNav.length).toBeGreaterThan(0);
    for (const entry of koraNav as Array<{ name: string; href: string }>) {
      expect(entry.href).toMatch(/^\/admin\/apps\/kora(\/|$)/);
    }
  });

  it("has a Food index entry pointing at /admin/apps/kora/foods", () => {
    const foods = koraNav.find((entry) => entry.name === "Food index") as
      | { href: string }
      | undefined;
    expect(foods).toBeDefined();
    expect(foods?.href).toBe("/admin/apps/kora/foods");
  });

  // Real bug this task was told to check for: /admin/apps/kora/foods nests
  // under Overview's own href (/admin/apps/kora), so a bare
  // `pathname.startsWith(href)` keeps Overview marked active on the foods
  // route forever. Both halves are asserted — the "Overview not active"
  // half alone would also pass against a function that always returns
  // false, so it proves nothing on its own.
  it("does not keep Overview active once the user is on the nested foods route", () => {
    expect(isNavItemActive("/admin/apps/kora/foods", "/admin/apps/kora")).toBe(false);
    expect(isNavItemActive("/admin/apps/kora/foods", "/admin/apps/kora/foods")).toBe(true);
  });

  it("still marks Overview active on its own route", () => {
    expect(isNavItemActive("/admin/apps/kora", "/admin/apps/kora")).toBe(true);
    expect(isNavItemActive("/admin/apps/kora/", "/admin/apps/kora")).toBe(true);
  });

  it("has a Feedback entry pointing at /admin/apps/kora/feedback", () => {
    const fb = koraNav.find((entry) => entry.name === "Feedback") as { href: string } | undefined;
    expect(fb).toBeDefined();
    expect(fb?.href).toBe("/admin/apps/kora/feedback");
  });

  it("has a Users entry pointing at /admin/apps/kora/users", () => {
    const users = koraNav.find((entry) => entry.name === "Users") as { href: string } | undefined;
    expect(users).toBeDefined();
    expect(users?.href).toBe("/admin/apps/kora/users");
  });
});

// homechef has the identical prefix-collision shape as kora/mark8ly: its
// Overview entry (`/admin/apps/homechef`) is a strict prefix of ~20 nested
// routes (chefs, orders, payouts, ...), so a bare `startsWith` would keep
// Overview marked active on every one of them, permanently. This was the one
// instance the generalized EXACT_MATCH_ROOTS allowlist fix (added for kora)
// left unfixed even though it fixes the exact same class of bug. Both halves
// asserted, same reasoning as the kora case above: the "not active on a
// nested route" half alone would also pass against a function that always
// returns false.
describe("homechef nav active-state", () => {
  it("does not keep Overview active on a nested homechef route", () => {
    expect(isNavItemActive("/admin/apps/homechef/chefs", "/admin/apps/homechef")).toBe(false);
  });

  it("still marks Overview active on its own route", () => {
    expect(isNavItemActive("/admin/apps/homechef", "/admin/apps/homechef")).toBe(true);
  });
});

describe("kora audit nav (slice 2)", () => {
  it("has an Audit trail entry pointing at /admin/apps/kora/audit", () => {
    const audit = koraNav.find((entry) => entry.name === "Audit trail") as
      | { href: string }
      | undefined;
    expect(audit).toBeDefined();
    expect(audit?.href).toBe("/admin/apps/kora/audit");
  });

  // The brief said to CONFIRM rather than assume that /admin/apps/kora being
  // in EXACT_MATCH_ROOTS keeps the Overview active-state bug from recurring
  // with the second nested route. Both halves asserted — the "not active"
  // half alone would pass against a function that always returns false.
  it("does not keep Overview active on the nested audit route", () => {
    expect(isNavItemActive("/admin/apps/kora/audit", "/admin/apps/kora")).toBe(false);
    expect(isNavItemActive("/admin/apps/kora/audit", "/admin/apps/kora/audit")).toBe(true);
  });

  // Slice 2 added the first route nested UNDER the food index. Food index must
  // stay active there (it is the section the user is in) while Audit trail
  // must not — a prefix match on the wrong entry would light up both.
  it("keeps Food index active on a food detail route without lighting up Audit trail", () => {
    expect(isNavItemActive("/admin/apps/kora/foods/3bd526ec-ab82-42fb-bf47-083fa0c4cde5", "/admin/apps/kora/foods")).toBe(true);
    expect(isNavItemActive("/admin/apps/kora/foods/3bd526ec-ab82-42fb-bf47-083fa0c4cde5", "/admin/apps/kora/audit")).toBe(false);
    expect(isNavItemActive("/admin/apps/kora/foods/new", "/admin/apps/kora/foods")).toBe(true);
  });

  // The audit route must not make the food index look active either — they are
  // siblings, and /admin/apps/kora/audit does not start with .../foods.
  it("does not light up Food index on the audit route", () => {
    expect(isNavItemActive("/admin/apps/kora/audit", "/admin/apps/kora/foods")).toBe(false);
  });
});
