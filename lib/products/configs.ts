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
  // Source of truth: mark8ly/services/marketplace-api/internal/billing/
  // pricing/catalog.go — the same Go map that feeds the Stripe bootstrap
  // CLI, so these AUD figures are exactly what Stripe charges. Spec
  // ref: docs/superpowers/specs/2026-04-17-subscription-model-design.md §4.1
  // (developed-market tier, monthly period, AUD baseline).
  //
  // Each store's actual billing_currency is read per-row from
  // subscription_plan_change_audit; this default is only a fallback for
  // brand-new trial tenants who have no plan-change history yet (so AUD
  // is correct for the platform default).
  //
  // PlanMarketplace has no Stripe Price object — it was scoped out of the
  // catalog (catalog.go: "PlanTrial and PlanMarketplace have no Price
  // objects — excluded"). We retain the key with a 0 fallback so any
  // legacy `plan = "marketplace"` rows in subscription tables don't
  // crash MRR/ARR computation; treat the resulting 0 contribution as
  // accurate for that bucket.
  pricingByPlan: {
    trial: 0,
    starter: 29,
    studio: 75,
    pro: 179,
    marketplace: 0,
  },
  pricingCurrency: "AUD",
  // §5.3 free-trial length, per mark8ly marketplace-api
  // internal/billing/trial/subscribe.go: TrialDays = 90.
  trialDays: 90,
};

// HomeChef — home-cooked food delivery (fe3dr.com). Single Postgres
// database (`homechef_db`), no per-tenant model, no subscriptions in v1 (so
// pricing/billing are omitted and the billing UI hides). Business KPIs are
// read from homechef_db via /api/admin/apps/homechef/kpis + lib/db/homechef.ts.
const homechef: ProductConfig = {
  id: "homechef",
  name: "HomeChef",
  namespace: "homechef",
  // HomeChef's Postgres lives in the postgresql-homechef namespace. Used only
  // for the (gracefully-degrading) CNPG resource metrics.
  cnpgClusterName: "postgresql-homechef",
  sendGridProductTag: "homechef",
  // No per-tenant row-count concept (not a multi-tenant DB like mark8ly).
  rowCountTables: [],
  costAttribution: {
    requests: 0.5,
    storage: 0.3,
    egress: 0.2,
  },
  businessKpiTiles: [
    { key: "active_chefs", label: "Active chefs", hint: "verified + active", source: "product" },
    { key: "orders_today", label: "Orders today", source: "product" },
    { key: "gmv_today", label: "GMV today", source: "product" },
    { key: "pending_approvals", label: "Pending approvals", hint: "awaiting verification", source: "product" },
  ],
};

const REGISTRY: Readonly<Record<string, ProductConfig>> = {
  mark8ly,
  homechef,
};

export function getProductConfig(id: string): ProductConfig {
  const config = REGISTRY[id];
  if (!config) throw new Error(`Unknown product: ${id}`);
  return config;
}

export function listProductConfigs(): ReadonlyArray<ProductConfig> {
  return Object.values(REGISTRY);
}
