// Per-product configuration consumed by the Resources/Cost dashboards.
// Adding a new product (HomeChef, FanZone, …) is a config-only change:
// add an entry to lib/products/configs.ts. No layout code changes.

export interface KpiTileSpec {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly href?: string;
  readonly source: "platform" | "product";
}

export interface RowCountTable {
  readonly label: string;
  readonly tableName: string;
  readonly database: "platform_api" | "marketplace_api";
}

export interface CostAttributionWeights {
  readonly requests: number;
  readonly storage: number;
  readonly egress: number;
}

export interface ProductConfig {
  readonly id: string;
  readonly name: string;
  readonly namespace: string;
  readonly cnpgClusterName: string;
  readonly sendGridProductTag: string;
  readonly rowCountTables: ReadonlyArray<RowCountTable>;
  readonly costAttribution: CostAttributionWeights;
  readonly businessKpiTiles: ReadonlyArray<KpiTileSpec>;
  // Pricing — optional. Products without subscriptions (HomeChef in v1)
  // omit these and the billing UI gracefully hides on their pages.
  readonly pricingByPlan?: Readonly<Record<string, number>>;
  readonly pricingCurrency?: string;
  // Default trial length in days, used when synthesizing a trial for
  // tenants without a store_subscriptions row. Source of truth lives in
  // the product's billing service (mark8ly: TrialDays in
  // marketplace-api/internal/billing/trial/subscribe.go).
  readonly trialDays?: number;
}
