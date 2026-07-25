// mark8ly-hooks.ts — TanStack Query hooks over Mark8ly's /api/admin routes via
// the `plat` client. product='mark8ly' is a hardcoded path segment on the
// product-scoped routes. Mutations invalidate their list/detail keys.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { plat } from './api';
import type { RevenueData, Mark8lyCriticalSummary, LeadsResponse, LeadActivitiesResponse, TenantsResponse, TenantStatus, TenantBilling, TenantDetailResponse, SubscriptionsListResponse, OnboardingResponse, AuditLogsResponse } from './mark8ly-contracts';
import type { LeadStatus } from './platform-contracts';

const PRODUCT = 'mark8ly';

export const mk = {
  revenue: (days: number) => ['mk', 'revenue', days] as const,
  critical: ['mk', 'critical'] as const,
  leads: (p: object) => ['mk', 'leads', p] as const,
  leadActivities: (id: string) => ['mk', 'lead-activities', id] as const,
  tenants: (status: string) => ['mk', 'tenants', status] as const,
  tenant: (id: string) => ['mk', 'tenant', id] as const,
  tenantBilling: (id: string) => ['mk', 'tenant-billing', id] as const,
  subscriptions: (filter: string) => ['mk', 'subscriptions', filter] as const,
  onboarding: (status: string) => ['mk', 'onboarding', status] as const,
  audit: (severity: string) => ['mk', 'audit', severity] as const,
};

// ---- Overview ---------------------------------------------------------------
export const useRevenue = (days = 30) =>
  useQuery({ queryKey: mk.revenue(days), queryFn: () => plat.get<RevenueData>(`/apps/${PRODUCT}/revenue`, { days }) });

export const useCriticalCount = () =>
  useQuery({
    queryKey: mk.critical,
    queryFn: () => plat.get<Mark8lyCriticalSummary>(`/apps/${PRODUCT}/audit-logs`, { severity: 'critical', since_hours: 24 }),
  });

// ---- Leads ------------------------------------------------------------------
export const useLeads = (filters: { status?: string; q?: string; starred?: boolean }) =>
  useQuery({
    queryKey: mk.leads(filters),
    queryFn: () =>
      plat.get<LeadsResponse>('/leads', {
        status: filters.status && filters.status !== 'all' ? filters.status : undefined,
        q: filters.q || undefined,
        starred: filters.starred ? 'true' : undefined,
      }),
  });

// ---- Lead detail actions ----------------------------------------------------
export const useLeadActivities = (id: string) =>
  useQuery({
    queryKey: mk.leadActivities(id),
    queryFn: () => plat.get<LeadActivitiesResponse>(`/leads/${id}/activities`),
    enabled: !!id,
  });

export function useSetLeadStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: LeadStatus) => plat.patch<{ lead: unknown }>(`/leads/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mk', 'leads'] });
      qc.invalidateQueries({ queryKey: mk.leadActivities(id) });
    },
  });
}

export function useToggleLeadStar(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (is_starred: boolean) => plat.patch<{ lead: unknown }>(`/leads/${id}`, { is_starred }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mk', 'leads'] }),
  });
}

export function useLogLeadActivity(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { kind: string; body: string }) => plat.post<{ activity: unknown }>(`/leads/${id}/activities`, a),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mk.leadActivities(id) });
      qc.invalidateQueries({ queryKey: ['mk', 'leads'] });
    },
  });
}

export function useSendLeadEmail(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templateKey: string) =>
      plat.post<{ sent: true; recipient: string; messageId: string }>(`/leads/${id}/send-email`, {
        templateKey,
        idempotencyKey: `lead-${id}-${templateKey}-${Date.now()}`,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mk.leadActivities(id) });
      qc.invalidateQueries({ queryKey: ['mk', 'leads'] });
    },
  });
}

// ---- Tenants ----------------------------------------------------------------
export const useTenants = (status: string) =>
  useQuery({
    queryKey: mk.tenants(status),
    queryFn: () => plat.get<TenantsResponse>('/tenants', { status: status !== 'all' ? status : undefined }),
  });

export function useSetTenantStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: TenantStatus) => plat.patch<{ tenant: unknown }>(`/tenants/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mk', 'tenants'] });
      qc.invalidateQueries({ queryKey: mk.tenant(id) });
    },
  });
}

// ---- Tenant detail ----------------------------------------------------------
export const useTenant = (id: string) =>
  useQuery({ queryKey: mk.tenant(id), queryFn: () => plat.get<TenantDetailResponse>(`/tenants/${id}`), enabled: !!id });

export const useTenantBilling = (id: string) =>
  useQuery({ queryKey: mk.tenantBilling(id), queryFn: () => plat.get<TenantBilling>(`/apps/${PRODUCT}/tenants/${id}/billing`), enabled: !!id });

// ---- Subscriptions ----------------------------------------------------------
export const useSubscriptions = (filter: string) =>
  useQuery({
    queryKey: mk.subscriptions(filter),
    queryFn: () => plat.get<SubscriptionsListResponse>(`/apps/${PRODUCT}/subscriptions`, { filter: filter !== 'all' ? filter : undefined }),
  });

// ---- Onboarding -------------------------------------------------------------
export const useOnboarding = (status: string) =>
  useQuery({
    queryKey: mk.onboarding(status),
    queryFn: () => plat.get<OnboardingResponse>(`/apps/${PRODUCT}/onboarding`, { status }),
  });

// ---- Audit logs -------------------------------------------------------------
export const useMark8lyAuditLogs = (severity: string) =>
  useQuery({
    queryKey: mk.audit(severity),
    queryFn: () => plat.get<AuditLogsResponse>(`/apps/${PRODUCT}/audit-logs`, { severity: severity !== 'all' ? severity : undefined }),
  });
