"use client";

import { useApi, apiFetch } from './use-api';

/**
 * Go backend may return object-with-numeric-keys instead of array
 * (e.g. { "0": {...}, "1": {...} }). Normalize to array.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toArray<T>(val: T[] | Record<string, T> | null | undefined): T[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'object') return Object.values(val);
  return [];
}

export interface TicketComment {
  id: string;
  content: string;
  isInternal?: boolean;
  author?: {
    name: string;
    email: string;
    role: string;
  };
  // Go backend field names
  userId?: string;
  userName?: string;
  createdAt?: string;
  // Alternative field names
  created_by?: string;
  created_by_name?: string;
  created_by_email?: string;
  created_at?: string;
}

export interface Ticket {
  id: string;
  ticket_number?: string;
  tenant_id?: string;
  title: string;
  description?: string;
  type?: string;
  status: string;
  priority: string;
  tags?: string[];
  created_by?: string;
  created_by_name?: string;
  created_by_email?: string;
  created_at?: string;
  updated_at?: string;
  due_date?: string;
  assignees?: Array<{ id: string; name: string; email: string }>;
  attachments?: Array<Record<string, unknown>>;
  comments?: TicketComment[];
  sla?: Record<string, unknown>;
  history?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  updated_by?: string;
  // Populated by joining with tenant data
  tenant_name?: string;
}

export interface TicketsResponse {
  data: Ticket[];
  total: number;
  page: number;
  pageSize?: number;
  totalPages?: number;
  hasNext?: boolean;
  hasPrevious?: boolean;
}

interface TicketFilters {
  status?: string;
  priority?: string;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Hook to fetch ticket list with filtering and pagination.
 */
export function useTickets(filters: TicketFilters = {}) {
  const params = new URLSearchParams();
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.priority && filters.priority !== 'all') params.set('priority', filters.priority);
  if (filters.search) params.set('search', filters.search);

  const queryString = params.toString();
  const url = `/api/tickets${queryString ? `?${queryString}` : ''}`;

  return useApi<TicketsResponse>(url);
}

/**
 * Hook to fetch a single ticket by ID.
 * Optionally pass tenantId for cross-tenant platform admin fetches.
 */
export function useTicket(id: string | null, tenantId?: string | null) {
  const params = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
  const result = useApi<Ticket>(id ? `/api/tickets/${id}${params}` : null);

  // Normalize object-with-numeric-keys from Go backend to arrays
  if (result.data) {
    result.data.comments = toArray(result.data.comments);
    result.data.tags = toArray(result.data.tags);
  }

  return result;
}

/**
 * Update ticket status.
 * Optionally pass tenantId for cross-tenant platform admin updates.
 */
export async function updateTicketStatus(id: string, status: string, tenantId?: string | null) {
  return apiFetch(`/api/tickets/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status, ...(tenantId ? { tenantId } : {}) }),
  });
}

/**
 * Add a comment to a ticket.
 * Optionally pass tenantId for cross-tenant platform admin comments.
 */
export async function addTicketComment(id: string, content: string, isInternal = false, tenantId?: string | null) {
  return apiFetch(`/api/tickets/${id}/comments`, {
    method: 'POST',
    body: JSON.stringify({ content, isInternal, ...(tenantId ? { tenantId } : {}) }),
  });
}

/**
 * Update a ticket's details.
 */
export async function updateTicket(id: string, data: Partial<Ticket>) {
  return apiFetch(`/api/tickets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
