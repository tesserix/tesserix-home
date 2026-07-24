"use client";

import useSWR from "swr";
import type { SubscriptionRowItem } from "@/components/admin/billing/subscriptions-table";
import type { PlanChangeEntry } from "@/components/admin/billing/plan-change-timeline";
import type { RevenueData } from "@/components/admin/billing/revenue-section";

const fetcher = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

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

export type SubscriptionsFilter = "all" | "active" | "trial" | "past_due" | "cancelled";

export function useSubscriptionsList(productId: string, filter: SubscriptionsFilter) {
  const filterParam = filter === "all" ? "" : `?filter=${filter}`;
  return useSWR<SubscriptionsListResponse>(
    `/api/admin/apps/${productId}/subscriptions${filterParam}`,
    fetcher as (u: string) => Promise<SubscriptionsListResponse>,
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
}

export interface TenantBillingResponse {
  subscription: {
    plan: string;
    status: string;
    current_period_start: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  } | null;
  synthesized?: boolean;
  currency?: string;
  trial: {
    daysRemaining: number | null;
    conversionLikelihood: "low" | "medium" | "high";
  } | null;
  planHistory: PlanChangeEntry[];
  recentInvoices: Array<{
    event_id: string;
    event_type: string;
    received_at: string;
    processing_error: string | null;
    manual_review_required: boolean;
  }>;
  lifetimeRevenue: { amount: number; currency: string } | null;
  margin: {
    revenue: number;
    infraCost: number;
    margin: number;
    currency: string;
    inTrial: boolean;
    hasSubscription: boolean;
  } | null;
  generatedAt: string;
}

export function useTenantBilling(productId: string, tenantId: string) {
  return useSWR<TenantBillingResponse>(
    `/api/admin/apps/${productId}/tenants/${tenantId}/billing`,
    fetcher as (u: string) => Promise<TenantBillingResponse>,
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
}

export function useProductRevenue(productId: string, days: 30 | 90 | 365 = 30) {
  return useSWR<RevenueData>(
    `/api/admin/apps/${productId}/revenue?days=${days}`,
    fetcher as (u: string) => Promise<RevenueData>,
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
}
