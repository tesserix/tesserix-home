// Response shapes for Mark8ly product-admin routes: /api/admin/* (tenants, leads)
// and the product-scoped /api/admin/apps/mark8ly/*. Mirrors the web handlers;
// wire dates are ISO strings (server row types use Date). Extra fields ignored.

// ---- Overview: revenue + critical count ------------------------------------
export interface RevenueData {
  currency: string;
  mrr: number;
  arr: number;
  newTrials30d: number;
  cancelled30d: number;
  churnRate: number; // 0..1 ratio
  activeCount: number;
  generatedAt: string;
}
export interface Mark8lyCriticalSummary {
  summary: { criticalLast24h: number };
}
