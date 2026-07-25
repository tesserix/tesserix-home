// Response shapes for Mark8ly product-admin routes: /api/admin/* (tenants, leads)
// and the product-scoped /api/admin/apps/mark8ly/*. Mirrors the web handlers;
// wire dates are ISO strings (server row types use Date). Extra fields ignored.

import type { LeadStatus } from './platform-contracts';

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

// ---- Leads -----------------------------------------------------------------
export interface Lead {
  id: string;
  email: string | null;
  instagram_handle: string | null;
  phone: string | null;
  name: string | null;
  company: string | null;
  location: string | null;
  category: string[];
  has_website: boolean | null;
  website_url: string | null;
  biography: string | null;
  tags: string[];
  followers_count: number | null;
  posts_count: number | null;
  is_starred: boolean;
  source: string | null;
  status: LeadStatus;
  notes: string | null;
  owner: string | null;
  created_at: string;
  updated_at: string;
  last_contacted_at: string | null;
  activity_count?: number;
}
export interface LeadsResponse {
  leads: Lead[];
}
