// hooks.ts — TanStack Query hooks over the HomeChef admin gateway. Types are the
// shared wire contracts. Every list is server-paginated (Paginated<T>).

import { Linking } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hc } from './api';
import type {
  AdminStats,
  AdminAnalytics,
  Activity,
  Paginated,
  ChefWithStats,
  UserWithStats,
  OrderRow,
  ReviewRow,
  MealPlanRow,
  ApprovalRequest,
  SupportTicket,
  StaffMember,
  WalletResponse,
  AdminCancellationRequest,
  OrderIssue,
  OrderIssueConfig,
  DeliveryFailuresResponse,
  DeliveryFaultClass,
  FSSAILockResponse,
  OrderDetailResponse,
  DeliveryIntelligenceResponse,
  BlockedChefsResponse,
  PayoutAutomationValue,
  PendingPayoutsResponse,
  PaymentGatewayStatus,
  StripeGatewayStatus,
} from '@tesserix/homechef-shared';

// These three shapes are returned by the HomeChef admin gateway but are NOT part
// of @tesserix/homechef-shared (the web pages declare them locally too). Keep them
// next to the hooks that produce them.
export interface ReviewerRef {
  firstName?: string;
  lastName?: string;
  email?: string;
}
export type ApprovalDetail = ApprovalRequest & { reviewedBy?: ReviewerRef | null };
export interface ApprovalHistoryEntry {
  id: string;
  fromStatus?: string;
  toStatus: string;
  notes?: string;
  createdAt: string;
  changedBy?: ReviewerRef | null;
}
export interface BackfillChef {
  chefId: string;
  userId: string;
  businessName: string;
}
export interface BackfillResponse {
  count: number;
  chefs: BackfillChef[];
  executed: boolean;
  notified: number;
}

export interface PendingRefundDay {
  dayId: string;
  date: string;
  slot: string;
  dishName: string;
  customerName: string;
  chefName: string;
  mealPlanNumber: string;
  chefChoice: string; // full | half
  refundAmount: number;
}

export const qk = {
  stats: ['hc', 'stats'] as const,
  analytics: ['hc', 'analytics'] as const,
  activities: (limit: number) => ['hc', 'activities', limit] as const,
  chefs: (p: object) => ['hc', 'chefs', p] as const,
  users: (p: object) => ['hc', 'users', p] as const,
  orders: (p: object) => ['hc', 'orders', p] as const,
  reviews: (p: object) => ['hc', 'reviews', p] as const,
  mealPlans: (p: object) => ['hc', 'meal-plans', p] as const,
  approvals: (p: object) => ['hc', 'approvals', p] as const,
  approval: (id: string) => ['hc', 'approval', id] as const,
  approvalHistory: (id: string) => ['hc', 'approval-history', id] as const,
  fssaiLocked: ['hc', 'fssai-locked'] as const,
  tickets: (p: object) => ['hc', 'tickets', p] as const,
  staff: (p: object) => ['hc', 'staff', p] as const,
  wallet: (id: string) => ['hc', 'wallet', id] as const,
  order: (id: string) => ['hc', 'order', id] as const,
  deliveryIntel: ['hc', 'delivery-intel'] as const,
  blockedChefs: ['hc', 'blocked-chefs'] as const,
  pendingPayouts: (include: string) => ['hc', 'pending-payouts', include] as const,
  pendingRefunds: ['hc', 'pending-refunds'] as const,
  gatewayStatus: ['hc', 'gateway-status'] as const,
  stripeStatus: ['hc', 'stripe-status'] as const,
};

export const useStats = () => useQuery({ queryKey: qk.stats, queryFn: () => hc.get<AdminStats>('/stats') });
export const useAnalytics = () =>
  useQuery({ queryKey: qk.analytics, queryFn: () => hc.get<AdminAnalytics>('/analytics'), refetchInterval: 30_000 });
export const useActivities = (limit = 15) =>
  useQuery({ queryKey: qk.activities(limit), queryFn: () => hc.get<Activity[]>('/activities', { limit }) });

export const useChefs = (p: { search?: string; status?: string; page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.chefs(p), queryFn: () => hc.get<Paginated<ChefWithStats>>('/chefs', p) });
export const useUsers = (p: { search?: string; role?: string; page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.users(p), queryFn: () => hc.get<Paginated<UserWithStats>>('/users', p) });
export const useOrders = (p: { status?: string; page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.orders(p), queryFn: () => hc.get<Paginated<OrderRow>>('/orders', p) });
export const useReviews = (p: { hidden?: boolean; page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.reviews(p), queryFn: () => hc.get<Paginated<ReviewRow>>('/reviews', p) });
export const useMealPlans = (p: { status?: string; page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.mealPlans(p), queryFn: () => hc.get<Paginated<MealPlanRow>>('/meal-plans', p) });
export const useApprovals = (p: {
  status?: string;
  search?: string;
  reminded?: string;
  escalated?: string;
  page?: number;
  limit?: number;
}) =>
  useQuery({ queryKey: qk.approvals(p), queryFn: () => hc.get<Paginated<ApprovalRequest>>('/approvals', p) });
export const useTickets = (p: { status?: string; page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.tickets(p), queryFn: () => hc.get<Paginated<SupportTicket>>('/support/tickets', p) });
export const useStaff = (p: { page?: number; limit?: number }) =>
  useQuery({ queryKey: qk.staff(p), queryFn: () => hc.get<Paginated<StaffMember>>('/staff', p) });
export const useWallet = (userId: string) =>
  useQuery({ queryKey: qk.wallet(userId), queryFn: () => hc.get<WalletResponse>(`/wallet/${userId}`), enabled: !!userId });

// Cancellation arbitration (#475/#480): disputes + vendor timeouts. The admin
// picks the tier and the Go API issues/tops-up the refund. Amounts are in paise.
export const useCancellations = (status = '') =>
  useQuery({
    queryKey: ['hc', 'cancel-requests', status] as const,
    queryFn: () =>
      hc.get<{ data: AdminCancellationRequest[] }>('/cancel-requests', status ? { status } : undefined),
    refetchInterval: 30_000,
  });

export function useResolveCancellation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; reason: string; note?: string }) =>
      hc.post(`/cancel-requests/${a.id}/resolve`, { reason: a.reason, note: a.note ?? '' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'cancel-requests'] }),
  });
}

// Order-issue refunds (#262/#618): resolve (chef_clawback | platform_goodwill) or reject.
export const useOrderIssues = (status = 'pending') =>
  useQuery({
    queryKey: ['hc', 'order-issues', status] as const,
    queryFn: () => hc.get<{ data: OrderIssue[]; count: number }>('/order-issues', { status }),
    refetchInterval: 30_000,
  });

export function useResolveOrderIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; amount: number; faultPolicy: 'chef_clawback' | 'platform_goodwill' }) =>
      hc.post(`/order-issues/${a.id}/resolve`, { amount: a.amount, faultPolicy: a.faultPolicy }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'order-issues'] }),
  });
}

export function useRejectOrderIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => hc.post(`/order-issues/${id}/reject`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'order-issues'] }),
  });
}

export function useSetTicketStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; status: string }) =>
      hc.put(`/support/tickets/${a.id}/status`, { status: a.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'tickets'] }),
  });
}

// Order-issue refund policy (#262): the admin-tunable auto-approve cap.
export const useOrderIssueConfig = () =>
  useQuery({ queryKey: ['hc', 'order-issue-config'] as const, queryFn: () => hc.get<OrderIssueConfig>('/order-issue/config') });

export function useUpdateOrderIssueConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { enabled?: boolean; autoApproveCap?: number }) => hc.put('/order-issue/config', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'order-issue-config'] }),
  });
}

// Delivery-failure fault resolution (#613): confirm a fault → Go runs the money policy.
export const useDeliveryFailures = () =>
  useQuery({
    queryKey: ['hc', 'delivery-failures'] as const,
    queryFn: () => hc.get<DeliveryFailuresResponse>('/delivery-failures'),
    refetchInterval: 30_000,
  });

export function useResolveDeliveryFailure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { path: string; fault: DeliveryFaultClass }) => hc.post(a.path, { fault: a.fault }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'delivery-failures'] }),
  });
}

/** Generic mutation helper: PUT a verb path (verify/suspend/hide…) then invalidate. */
export function useAdminAction(invalidate: readonly unknown[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { method: 'put' | 'post' | 'del'; path: string; body?: unknown }) =>
      args.method === 'post'
        ? hc.post(args.path, args.body)
        : args.method === 'del'
          ? hc.del(args.path)
          : hc.put(args.path, args.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: invalidate }),
  });
}

// ---- Approvals detail + decide ---------------------------------------------
export const useApproval = (id: string) =>
  useQuery({
    queryKey: qk.approval(id),
    queryFn: () => hc.get<ApprovalDetail>(`/approvals/${id}`),
    enabled: !!id,
  });

export const useApprovalHistory = (id: string) =>
  useQuery({
    queryKey: qk.approvalHistory(id),
    queryFn: () => hc.get<{ data: ApprovalHistoryEntry[] }>(`/approvals/${id}/history`),
    enabled: !!id,
  });

// Badge the Escalated filter chip without loading the whole view: total only.
export const useEscalatedCount = () =>
  useQuery({
    queryKey: ['hc', 'approvals-escalated-count'] as const,
    queryFn: () => hc.get<Paginated<ApprovalRequest>>('/approvals', { escalated: 'true', page: 1, limit: 1 }),
    select: (d) => d.pagination.total,
  });

// approve | reject | request-info → PUT /approvals/:id/:action { notes }.
export function useDecideApproval(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { action: 'approve' | 'reject' | 'request-info'; notes: string }) =>
      hc.put(`/approvals/${id}/${a.action}`, { notes: a.notes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hc', 'approvals'] });
      qc.invalidateQueries({ queryKey: ['hc', 'approvals-escalated-count'] });
      qc.invalidateQueries({ queryKey: qk.approval(id) });
      qc.invalidateQueries({ queryKey: qk.approvalHistory(id) });
    },
  });
}

// Documents live privately in GCS; fetch a short-lived signed URL on demand and
// open it in the system browser.
export async function openApprovalDocument(id: string, docId: string): Promise<void> {
  const { url } = await hc.get<{ url?: string }>(`/approvals/${id}/documents/${docId}`);
  if (!url) throw new Error('Document is not available.');
  await Linking.openURL(url);
}

// ---- FSSAI lockouts --------------------------------------------------------
export const useFssaiLocked = () =>
  useQuery({ queryKey: qk.fssaiLocked, queryFn: () => hc.get<FSSAILockResponse>('/chefs/fssai-locked') });

// Dry-run list of chefs missing an FSSAI expiry (button-triggered, not a query).
export const fetchFssaiBackfill = () => hc.get<BackfillResponse>('/fssai-expiry-backfill');

// Send the one-time confirm-licence push to those chefs.
export function useNotifyFssaiBackfill() {
  return useMutation({ mutationFn: () => hc.post<BackfillResponse>('/fssai-expiry-backfill') });
}

// Adjust a customer wallet (credit/debit). Amounts are RUPEES. reason ≥ 3 chars.
export function useAdjustWallet(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { amount: number; reason: string; type: 'credit' | 'debit' }) =>
      hc.post(`/wallet/${userId}/adjust`, a),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.wallet(userId) }),
  });
}

// ---- Order detail + delivery intelligence ----------------------------------
export const useOrder = (id: string) =>
  useQuery({
    queryKey: qk.order(id),
    queryFn: () => hc.get<OrderDetailResponse>(`/orders/${id}`),
    enabled: !!id,
  });

export const useDeliveryIntelligence = () =>
  useQuery({
    queryKey: qk.deliveryIntel,
    queryFn: () => hc.get<DeliveryIntelligenceResponse>('/delivery/intelligence'),
    refetchInterval: 30_000,
  });

// ---- Payout setup: blocked chefs + automation toggle -----------------------
export const useBlockedChefs = () =>
  useQuery({ queryKey: qk.blockedChefs, queryFn: () => hc.get<BlockedChefsResponse>('/payouts/blocked-chefs') });

export function useSetPayoutAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { chefId: string; value: PayoutAutomationValue }) =>
      hc.put(`/chefs/${a.chefId}/payout-automation`, { value: a.value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.blockedChefs }),
  });
}

// ---- Payout queue: escrow release/withhold/reverse + bulk -------------------
export const usePendingPayouts = (includeAwaiting: boolean) =>
  useQuery({
    queryKey: qk.pendingPayouts(includeAwaiting ? 'awaiting' : 'eligible'),
    queryFn: () =>
      hc.get<PendingPayoutsResponse>('/payouts/pending', includeAwaiting ? { include: 'awaiting' } : undefined),
    refetchInterval: 30_000,
  });

// release (no reason) | withhold | reverse (reason) — path built by the caller.
export function usePayoutAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { path: string; reason?: string }) =>
      hc.post(a.path, a.reason !== undefined ? { reason: a.reason } : undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'pending-payouts'] }),
  });
}

export function useBulkReleasePayouts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: { aggType: string; id: string }[]) => hc.post('/payouts/release-bulk', { items }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hc', 'pending-payouts'] }),
  });
}

// ---- Refund payouts --------------------------------------------------------
export const usePendingRefunds = () =>
  useQuery({
    queryKey: qk.pendingRefunds,
    queryFn: () => hc.get<{ data: PendingRefundDay[] }>('/meal-plan-days/pending-refunds'),
  });

export function useExecuteRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dayId: string) => hc.post(`/meal-plan-days/${dayId}/execute-refund`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.pendingRefunds }),
  });
}

// ---- Payment gateway status (read-only) ------------------------------------
export const useGatewayStatus = () =>
  useQuery({ queryKey: qk.gatewayStatus, queryFn: () => hc.get<PaymentGatewayStatus>('/payment-gateway/status') });
export const useStripeStatus = () =>
  useQuery({ queryKey: qk.stripeStatus, queryFn: () => hc.get<StripeGatewayStatus>('/payment-gateway/stripe/status') });
