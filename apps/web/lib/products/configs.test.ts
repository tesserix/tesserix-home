import { describe, expect, it } from "vitest";
import { getProductConfig, listProductConfigs } from "@/lib/products/configs";

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

  // These four keys are the contract with /api/admin/apps/kora/kpis.
  // resolveKpiValue looks each tile up BY KEY in the KPI map; a key that
  // disagrees renders "—" with no error anywhere.
  it("declares the four tiles the kpis route populates", () => {
    const keys = getProductConfig("kora").businessKpiTiles.map((t) => t.key);
    expect(keys).toEqual([
      "food_index_missing",
      "ai_calls_24h",
      "ai_failures_24h",
      "decompose_over_budget_pct",
    ]);
    for (const tile of getProductConfig("kora").businessKpiTiles) {
      expect(tile.source).toBe("product");
    }
  });

  it("appears in the registry listing", () => {
    expect(listProductConfigs().map((c) => c.id)).toContain("kora");
  });
});
