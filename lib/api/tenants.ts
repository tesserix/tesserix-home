"use client";

import { useApi, apiFetch } from './use-api';

// Types matching the tenant-service response shape
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  subdomain?: string;
  custom_domain?: string;
  use_custom_domain?: boolean;
  display_name?: string;
  admin_url?: string;
  storefront_url?: string;
  industry?: string;
  status?: string;
  plan?: string;
  email?: string;
  created_at?: string;
  updated_at?: string;
  // Stats from detail view
  stats?: {
    products?: number;
    orders?: number;
    customers?: number;
    revenue?: string;
  };
}

export interface TenantsResponse {
  data: Tenant[];
  total: number;
  page: number;
  pageSize: number;
}

interface TenantFilters {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Hook to fetch tenant list with filtering and pagination.
 */
export function useTenants(filters: TenantFilters = {}) {
  const params = new URLSearchParams();
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.search) params.set('search', filters.search);

  const queryString = params.toString();
  const url = `/api/tenants${queryString ? `?${queryString}` : ''}`;

  return useApi<TenantsResponse>(url);
}

/**
 * Hook to fetch a single tenant by ID.
 */
export function useTenant(id: string | null) {
  return useApi<Tenant>(id ? `/api/tenants/${id}` : null);
}

/**
 * Delete a single tenant (platform admin).
 */
export async function deleteTenant(id: string, reason: string) {
  return apiFetch(`/api/tenants/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ reason }),
  });
}

/**
 * Batch delete multiple tenants.
 */
export async function batchDeleteTenants(tenantIds: string[], reason: string) {
  return apiFetch('/api/tenants/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ tenant_ids: tenantIds, reason }),
  });
}

/**
 * Delete all tenants (requires confirmation text).
 */
export async function deleteAllTenants(confirmationText: string, reason: string) {
  return apiFetch('/api/tenants/delete-all', {
    method: 'POST',
    body: JSON.stringify({ confirmation_text: confirmationText, reason }),
  });
}

export interface DeletionPreview {
  tenant_id: string;
  slug: string;
  name: string;
  counts: Record<string, Record<string, number>>;
}

/**
 * Get a preview of what would be deleted (dry run).
 */
export async function getDeletionPreview(tenantIds?: string[]) {
  return apiFetch('/api/tenants/deletion-preview', {
    method: 'POST',
    body: JSON.stringify({ tenant_ids: tenantIds || [] }),
  });
}
