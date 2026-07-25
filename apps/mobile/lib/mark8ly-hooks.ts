// mark8ly-hooks.ts — TanStack Query hooks over Mark8ly's /api/admin routes via
// the `plat` client. product='mark8ly' is a hardcoded path segment on the
// product-scoped routes. Mutations invalidate their list/detail keys.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { plat } from './api';
import type { RevenueData, Mark8lyCriticalSummary, Lead, LeadsResponse } from './mark8ly-contracts';

const PRODUCT = 'mark8ly';

export const mk = {
  revenue: (days: number) => ['mk', 'revenue', days] as const,
  critical: ['mk', 'critical'] as const,
  leads: (p: object) => ['mk', 'leads', p] as const,
  leadActivities: (id: string) => ['mk', 'lead-activities', id] as const,
  tenants: (status: string) => ['mk', 'tenants', status] as const,
  tenant: (id: string) => ['mk', 'tenant', id] as const,
  tenantBilling: (id: string) => ['mk', 'tenant-billing', id] as const,
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
