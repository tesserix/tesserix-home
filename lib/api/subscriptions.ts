"use client";

import { useApi, apiFetch } from './use-api';

export interface SubscriptionPlan {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  currency: string;
  stripeProductId?: string;
  stripeMonthlyPriceId?: string;
  stripeYearlyPriceId?: string;
  maxProducts: number;
  maxUsers: number;
  maxStorageMb: number;
  features?: Record<string, boolean>;
  sortOrder: number;
  isActive: boolean;
  isFree: boolean;
  trialDays: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface TenantSubscription {
  id: string;
  tenantId: string;
  planId: string;
  plan?: SubscriptionPlan;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'expired' | 'suspended';
  billingInterval: 'monthly' | 'yearly';
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  trialStart?: string;
  trialEnd?: string;
  cancelAtPeriodEnd: boolean;
  canceledAt?: string;
  billingEmail?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SubscriptionInvoice {
  id: string;
  tenantId: string;
  subscriptionId?: string;
  stripeInvoiceId?: string;
  stripeHostedUrl?: string;
  stripeInvoicePdf?: string;
  status: 'draft' | 'open' | 'paid' | 'void';
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  periodStart?: string;
  periodEnd?: string;
  paidAt?: string;
  description?: string;
  createdAt?: string;
}

export interface SubscriptionStats {
  mrr: number;
  activeCount: number;
  trialingCount: number;
  pastDueCount: number;
  canceledCount: number;
  totalRevenue: number;
}

export interface EnhancedStats extends SubscriptionStats {
  trialConversionRate: number;
  expiringTrials7d: number;
  expiringTrials30d: number;
  expiredCount: number;
  suspendedCount: number;
}

export interface ExpiringTrial {
  id: string;
  tenantId: string;
  planId: string;
  plan?: SubscriptionPlan;
  status: string;
  trialStart?: string;
  trialEnd?: string;
  billingEmail?: string;
  createdAt?: string;
}

export interface ExtendTrialRequest {
  additionalDays: number;
  reason: string;
}

// Hooks

export function usePlans() {
  return useApi<SubscriptionPlan[]>('/api/subscriptions/plans');
}

export function useTenantSubscription(tenantId: string | null) {
  return useApi<TenantSubscription>(tenantId ? `/api/subscriptions/${tenantId}` : null);
}

export function useTenantInvoices(tenantId: string | null) {
  return useApi<SubscriptionInvoice[]>(tenantId ? `/api/subscriptions/${tenantId}/invoices` : null);
}

export function useSubscriptionStats() {
  return useApi<SubscriptionStats>('/api/subscriptions/stats');
}

export function useEnhancedStats() {
  return useApi<EnhancedStats>('/api/subscriptions/admin/stats/enhanced');
}

export function useExpiringTrials(days: number = 30) {
  return useApi<ExpiringTrial[]>(`/api/subscriptions/admin/expiring-trials?days=${days}`);
}

export interface AdminInvoicesResponse {
  invoices: SubscriptionInvoice[];
  total: number;
  limit: number;
  offset: number;
}

export function useAdminInvoices(status?: string, limit = 20, offset = 0) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return useApi<AdminInvoicesResponse>(`/api/subscriptions/admin/invoices?${params}`);
}

// Mutations

export async function createPlan(data: Partial<SubscriptionPlan>) {
  return apiFetch<SubscriptionPlan>('/api/subscriptions/plans', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updatePlan(id: string, data: Partial<SubscriptionPlan>) {
  return apiFetch<SubscriptionPlan>(`/api/subscriptions/plans/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deletePlan(id: string) {
  return apiFetch(`/api/subscriptions/plans/${id}`, {
    method: 'DELETE',
  });
}

export async function syncPlansToStripe() {
  return apiFetch('/api/subscriptions/plans/sync-stripe', {
    method: 'POST',
  });
}

export async function createCheckoutSession(tenantId: string, planId: string, billingInterval: string) {
  return apiFetch<{ checkout_url: string }>('/api/subscriptions/checkout', {
    method: 'POST',
    body: JSON.stringify({ tenant_id: tenantId, plan_id: planId, billing_interval: billingInterval }),
  });
}

export async function createPortalSession(tenantId: string) {
  return apiFetch<{ portal_url: string }>('/api/subscriptions/portal', {
    method: 'POST',
    body: JSON.stringify({ tenant_id: tenantId }),
  });
}

export async function cancelSubscription(tenantId: string) {
  return apiFetch(`/api/subscriptions/${tenantId}/cancel`, {
    method: 'POST',
  });
}

export async function reactivateSubscription(tenantId: string) {
  return apiFetch(`/api/subscriptions/${tenantId}/reactivate`, {
    method: 'POST',
  });
}

export async function changePlan(tenantId: string, planId: string) {
  return apiFetch(`/api/subscriptions/${tenantId}/change-plan`, {
    method: 'PUT',
    body: JSON.stringify({ plan_id: planId }),
  });
}

export async function extendTrial(tenantId: string, additionalDays: number, reason: string) {
  return apiFetch(`/api/subscriptions/admin/${tenantId}/extend-trial`, {
    method: 'POST',
    body: JSON.stringify({ additionalDays, reason }),
  });
}
