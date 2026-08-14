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

// Fe3dr — India home-cooking marketplace (Customer + Vendor mobile apps +
// Go API). Single database (homechef_db). No subscriptions in v1, so pricing is
// omitted and the billing UI hides on its pages. Business KPIs are served by the
// product-scoped route /api/admin/apps/homechef/kpis (direct homechef_db reads
// via lib/db/homechef.ts) — see resolveKpiValue in product-overview-layout.tsx.
const homechef: ProductConfig = {
  id: "homechef",
  name: "Fe3dr",
  namespace: "homechef",
  cnpgClusterName: "homechef-postgres",
  sendGridProductTag: "homechef",
  // Left empty in v1: the per-table storage estimate routes through mark8ly's
  // pool today. Resources/DB-size on the overview come from CNPG Prometheus
  // metrics (cnpgClusterName), so this isn't needed for a working overview.
  rowCountTables: [],
  costAttribution: {
    requests: 0.5,
    storage: 0.3,
    egress: 0.2,
  },
  businessKpiTiles: [
    { key: "chefs_active", label: "Active chefs", hint: "verified + active", source: "product" },
    { key: "orders_today", label: "Orders today", hint: "since 00:00 IST", source: "product" },
    { key: "gmv_today", label: "GMV today", hint: "₹, excl. cancelled/refunded", source: "product" },
    { key: "approvals_pending", label: "Pending approvals", hint: "awaiting review", source: "product" },
  ],
};

// DevAI — AI-powered ALM + SRE platform (Python FastAPI + LangGraph agents:
// devai-api, devai-auth-bff, devai-dashboard, devai-mcp-*). Single namespace
// `devai`, CNPG cluster `devai-postgres`, no subscriptions in v1. There's no
// tenant/store model, so its overview KPIs are its OTel telemetry (ClickHouse:
// traces, errors, p95) + open platform incidents — served by the product-scoped
// route /api/admin/apps/devai/kpis. Traces/logs live on the global Observability
// page (already devai-filtered), incidents on Platform Tickets (product_id=devai),
// and service health on the Health page (namespace=devai).
const devai: ProductConfig = {
  id: "devai",
  name: "DevAI",
  namespace: "devai",
  cnpgClusterName: "devai-postgres",
  sendGridProductTag: "devai",
  rowCountTables: [],
  costAttribution: {
    requests: 0.5,
    storage: 0.3,
    egress: 0.2,
  },
  businessKpiTiles: [
    { key: "requests_24h", label: "Traces (24h)", hint: "root spans", href: "/admin/observability", source: "product" },
    { key: "errors_24h", label: "Errors (24h)", hint: "error spans", href: "/admin/observability", source: "product" },
    { key: "p95_ms", label: "p95 latency", hint: "ms (24h)", href: "/admin/observability", source: "product" },
    { key: "incidents_open", label: "Open incidents", hint: "open / in progress", href: "/admin/platform-tickets", source: "product" },
  ],
};

// Dwellm8 — India-first rental management (six Expo apps + one Go API,
// modular monolith per its ADR-0001). Single namespace `dwellm8`, CNPG
// cluster `dwellm8-postgres`, one database (dwellm8). No subscriptions —
// revenue is a payout fee — so pricing is omitted and the billing UI hides.
// KPI tiles are declared ahead of the product-scoped route; the shared
// /api/admin/apps/[product]/kpis has no dwellm8 branch yet, so it returns
// 501 and the overview renders an explicit "not instrumented yet" message
// instead of these tiles.
const dwellm8: ProductConfig = {
  id: "dwellm8",
  name: "Dwellm8",
  namespace: "dwellm8",
  cnpgClusterName: "dwellm8-postgres",
  sendGridProductTag: "dwellm8",
  rowCountTables: [],
  costAttribution: {
    requests: 0.5,
    storage: 0.3,
    egress: 0.2,
  },
  businessKpiTiles: [
    { key: "organisations_total", label: "Organisations", hint: "owners + firms", source: "product" },
    { key: "tenancies_active", label: "Active tenancies", hint: "active + in notice", source: "product" },
    { key: "listings_live", label: "Live listings", source: "product" },
    { key: "tickets_open", label: "Open tickets", hint: "maintenance", source: "product" },
  ],
};

// Kora — AI food logging (Expo mobile app + a single Go API, kora-api). One
// namespace `kora`, dedicated CNPG cluster `kora-postgres` (provisioned
// 2026-08-04; it was on the shared global-postgres before that). No
// subscriptions, so pricing is omitted and the billing section hides.
//
// Its overview KPIs are OPERATING signals rather than business ones: this
// surface exists to catch things like the food index sitting at 42% embedded
// for the life of the project, invisible because cmd/embed exits 0 when it
// gives up and the Kubernetes Job therefore reports Complete (#97). The first
// four are PromQL over the kora-api exporter; the last two are read-only
// Secret Manager metadata (listSecretVersions only, never a secret value —
// see lib/secrets/key-health.ts). All six are served by
// /api/admin/apps/kora/kpis. There is deliberately no per-user metric —
// Prometheus carries no user_id label (unbounded cardinality on a Managed
// Prometheus bill); ai_usage_events stays authoritative for that, see
// kora/docs/ai-usage-queries.md.
const kora: ProductConfig = {
  id: "kora",
  name: "Kora",
  namespace: "kora",
  cnpgClusterName: "kora-postgres",
  sendGridProductTag: "kora",
  rowCountTables: [],
  costAttribution: {
    requests: 0.5,
    storage: 0.3,
    egress: 0.2,
  },
  businessKpiTiles: [
    { key: "food_index_missing", label: "Food index gaps", hint: "rows with no embedding — should be 0", source: "product" },
    { key: "ai_calls_24h", label: "AI calls (24h)", hint: "successful provider calls", source: "product" },
    { key: "ai_failures_24h", label: "AI failures (24h)", hint: "errors + timeouts, excl. decompose/coach/embed", source: "product" },
    { key: "decompose_over_budget_pct", label: "Decompose over budget", hint: "% past 1.5s, successes only — 0% if decompose is failing", source: "product" },
    { key: "ai_keys_configured", label: "AI keys configured", hint: "gemini + openai — should be 2", source: "product" },
    { key: "ai_key_age_days", label: "Oldest AI key", hint: "days since last rotation", source: "product" },
  ],
};

const REGISTRY: Readonly<Record<string, ProductConfig>> = {
  mark8ly,
  homechef,
  devai,
  dwellm8,
  kora,
};

export function getProductConfig(id: string): ProductConfig {
  const config = REGISTRY[id];
  if (!config) throw new Error(`Unknown product: ${id}`);
  return config;
}

export function listProductConfigs(): ReadonlyArray<ProductConfig> {
  return Object.values(REGISTRY);
}
