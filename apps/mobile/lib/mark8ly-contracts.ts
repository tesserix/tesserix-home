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

// ---- Lead activities --------------------------------------------------------
export type LeadActivityKind =
  | 'note' | 'dm_sent' | 'dm_received' | 'email_sent' | 'email_received'
  | 'call' | 'status_change' | 'assigned';

export interface LeadActivity {
  id: string;
  lead_id: string;
  kind: LeadActivityKind;
  actor_email: string;
  body: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
export interface LeadActivitiesResponse {
  activities: LeadActivity[];
}

// ---- Tenants ----------------------------------------------------------------
export type TenantStatus = 'active' | 'suspended' | 'archived';
export interface Tenant {
  id: string;
  name: string;
  owner_user_id: string;
  owner_email: string;
  status: TenantStatus;
  created_at: string;
  updated_at: string;
}
export interface TenantsResponse {
  tenants: Tenant[];
}

// ---- Tenant billing (detail) ------------------------------------------------
export interface TenantBilling {
  subscription: {
    plan: string;
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  synthesized: boolean;
  currency: string;
  trial: { daysRemaining: number | null; conversionLikelihood: 'low' | 'medium' | 'high' } | null;
  lifetimeRevenue: { amount: number; currency: string } | null;
  margin: { revenue: number; infraCost: number; margin: number; currency: string; inTrial: boolean; hasSubscription: boolean } | null;
  generatedAt: string;
}
export interface TenantDetailResponse {
  tenant: Tenant;
}

// ---- Subscriptions ----------------------------------------------------------
export interface SubscriptionRowItem {
  tenantId: string;
  tenantName: string;
  plan: string;
  status: string;
  mrr: number;
  currency: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialDaysRemaining?: number | null;
  conversionLikelihood?: 'low' | 'medium' | 'high';
  dunningState?: 'retrying' | 'exhausted' | null;
}
export interface SubscriptionsListResponse {
  summary: {
    totalMrr: number;
    currency: string;
    activeCount: number;
    trialCount: number;
    pastDueCount: number;
    cancelledThisMonth: number;
  };
  rows: SubscriptionRowItem[];
  generatedAt: string;
}

// ---- Onboarding funnel ------------------------------------------------------
export interface OnboardingFunnelStats {
  totalStarted: number;
  emailVerified: number;
  completed: number;
  inFlight: number;
  abandoned: number;
  medianTimeToCompleteSeconds: number | null;
  last24h: { started: number; completed: number };
}
export interface OnboardingSessionRow {
  id: string;
  email: string;
  business_name: string | null;
  status: string;
  email_verified_at: string | null;
  completed_at: string | null;
  tenant_id: string | null;
  last_activity_at: string;
  created_at: string;
  is_abandoned: boolean;
  hours_idle: number;
}
export interface OnboardingResponse {
  stats: OnboardingFunnelStats;
  sessions: OnboardingSessionRow[];
  filter: { status: string };
  generatedAt: string;
}

// ---- Audit logs -------------------------------------------------------------
export interface AuditEventRow {
  id: string;
  tenant_id: string;
  tenantName: string;
  store_id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  status: string;
  severity: string;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
export interface AuditLogsResponse {
  summary: { criticalLast24h: number };
  filterOptions: { actions: string[]; resourceTypes: string[] };
  rows: AuditEventRow[];
  sinceHours: number;
  generatedAt: string;
}

// ---- Email templates --------------------------------------------------------
export type Mark8lyDatabase = 'platform_api' | 'marketplace_api';
export interface EmailTemplateRow {
  database: Mark8lyDatabase;
  key: string;
  subject: string;
  status: 'published' | 'draft';
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}
export interface EmailTemplatesResponse {
  database: Mark8lyDatabase;
  templates: EmailTemplateRow[];
}
export interface EmailTestSendResponse {
  sent: true;
  to: string;
}
