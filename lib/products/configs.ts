import type { ProductConfig } from "./types";

const mark8ly: ProductConfig = {
  id: "mark8ly",
  name: "Mark8ly",
  namespace: "mark8ly",
  cnpgClusterName: "mark8ly-postgres",
  sendGridProductTag: "mark8ly",
  rowCountTables: [
    { label: "Stores", tableName: "stores", database: "marketplace_api" },
    { label: "Orders", tableName: "orders", database: "marketplace_api" },
    { label: "Products", tableName: "products", database: "marketplace_api" },
    { label: "Customers", tableName: "customer_profiles", database: "marketplace_api" },
  ],
  costAttribution: {
    requests: 0.5,
    storage: 0.3,
    egress: 0.2,
  },
  businessKpiTiles: [
    { key: "tenants_active", label: "Active tenants", hint: "of total", href: "/admin/apps/mark8ly/tenants", source: "product" },
    { key: "stores_total", label: "Stores", href: "/admin/apps/mark8ly/tenants", source: "product" },
    { key: "leads_total", label: "Leads", href: "/admin/apps/mark8ly/leads", source: "platform" },
  ],
  // PLACEHOLDER — confirm with mark8ly product owner before relying on
  // these in revenue/margin reports. Source of truth is Stripe; sync this
  // map whenever Stripe prices change. Plans per
  // mark8ly migration 000041_subscription_plan_v2_rename.
  pricingByPlan: {
    trial: 0,
    starter: 29,
    studio: 79,
    pro: 149,
    marketplace: 299,
  },
  pricingCurrency: "USD",
  // §5.3 free-trial length, per mark8ly marketplace-api
  // internal/billing/trial/subscribe.go: TrialDays = 90.
  trialDays: 90,
};

const REGISTRY: Readonly<Record<string, ProductConfig>> = {
  mark8ly,
};

export function getProductConfig(id: string): ProductConfig {
  const config = REGISTRY[id];
  if (!config) throw new Error(`Unknown product: ${id}`);
  return config;
}

export function listProductConfigs(): ReadonlyArray<ProductConfig> {
  return Object.values(REGISTRY);
}
