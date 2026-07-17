// Shared response shapes for the HomeChef Go `/admin/*` API.
//
// Single source of truth for BOTH the web admin (here, tesserix-home) and the
// mobile admin (apps/mobile-admin/lib/admin-types.ts in the Home-Chef-App repo)
// — kept in lockstep so the two surfaces speak the identical contract. Mirrors
// apps/api/handlers/admin.go, approval.go, delivery.go, staff.go, admin_wallet.go,
// admin_reviews.go, meal_plan.go. Extra fields on the wire are ignored.

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface Paginated<T> {
  data: T[];
  pagination: PaginationMeta;
}

// ---- Dashboard --------------------------------------------------------------
export interface AdminStats {
  totalUsers: number;
  newUsersToday: number;
  totalChefs: number;
  pendingVerifications: number;
  totalOrders: number;
  ordersToday: number;
  revenue: number;
  revenueToday: number;
  revenueChange: number;
  ordersChange: number;
}

export interface Activity {
  id: string;
  type: string;
  title: string;
  description: string;
  timestamp: string;
}

export interface AdminAnalytics {
  overview: {
    totalRevenue: number;
    totalOrders: number;
    avgOrderValue: number;
    activeUsers: number;
  };
  ordersByStatus: Record<string, number>;
}

// ---- Users ------------------------------------------------------------------
export interface UserWithStats {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  role: string;
  isActive: boolean;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt?: string | null;
  createdAt?: string;
}

// ---- Chefs ------------------------------------------------------------------
export interface ChefWithStats {
  id: string;
  userId: string;
  businessName: string;
  cuisines: string[];
  kitchenType?: string;
  isVerified: boolean;
  isActive: boolean;
  acceptingOrders: boolean;
  rating: number;
  createdAt: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  totalOrders: number;
  totalRevenue: number;
  menuItemCount: number;
  documentCount: number;
  onlineStatus: string;
}

export interface FSSAILockedChef {
  chefId: string;
  userId: string;
  businessName: string;
  fssaiExpiry?: string | null;
  daysSinceExpiry: number;
  overrideUntil?: string | null;
  overrideReason?: string;
  overrideBy?: string | null;
}

export interface FSSAILockResponse {
  locked: FSSAILockedChef[];
  overridden: FSSAILockedChef[];
  lockedCount: number;
  overriddenCount: number;
  missingExpiryCount: number;
}

// ---- Orders -----------------------------------------------------------------
export interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  total: number;
  paymentStatus: string;
  createdAt: string;
  customerName: string;
  chefName: string;
  itemCount: number;
}

// ---- Approvals --------------------------------------------------------------
export type ApprovalStatus = "pending" | "approved" | "rejected" | "info_requested";
export type ApprovalPriority = "urgent" | "high" | "normal" | "low";

export interface ApprovalDocument {
  id: string;
  type?: string;
  fileName?: string;
  status?: string;
}

export interface ApprovalRequest {
  id: string;
  type: string;
  status: ApprovalStatus;
  priority: ApprovalPriority;
  chefId?: string | null;
  partnerId?: string | null;
  submittedById: string;
  reviewedById?: string | null;
  // Computed by the API so every approval shows who submitted it + which
  // kitchen, regardless of type.
  requestedByName?: string;
  requestedByEmail?: string;
  kitchenName?: string;
  entityType: string;
  entityId: string;
  title: string;
  description: string;
  submittedData?: Record<string, unknown>;
  adminNotes?: string;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  documents?: ApprovalDocument[];
  fssaiLooksCommercial?: boolean | null;
  kitchenTypeNonHome?: boolean | null;
}

export interface ApprovalCounts {
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  total: number;
}

// ---- Reviews ----------------------------------------------------------------
export interface ReviewRow {
  id: string;
  chefId: string;
  customerId: string;
  rating: number;
  text?: string;
  comment?: string;
  isHidden: boolean;
  hiddenReason?: string;
  createdAt: string;
}

// ---- Wallet -----------------------------------------------------------------
export interface WalletTxn {
  id: string;
  userId: string;
  amount: number;
  type: string;
  source: string;
  reason: string;
  balanceAfter: number;
  createdAt: string;
}

export interface WalletResponse {
  balance: number;
  currency: string;
  transactions: WalletTxn[];
  count: number;
}

// ---- Meal Plans -------------------------------------------------------------
export interface MealPlanRow {
  id: string;
  chefId: string;
  customerId: string;
  status: string;
  startDate?: string;
  endDate?: string;
  mealCount?: number;
  daysPerWeek?: number;
  pricePerMeal?: number;
  totalPrice?: number;
  createdAt: string;
}

// ---- Delivery ---------------------------------------------------------------
export interface DeliveryStats {
  totalPartners: number;
  verifiedPartners: number;
  onlinePartners: number;
  totalDeliveries: number;
  activeDeliveries: number;
  todayDeliveries: number;
  todayEarnings: number;
}

export interface DeliveryPartnerSummary {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string;
  vehicleType: string;
  vehicleNumber?: string;
  isVerified: boolean;
  isOnline: boolean;
  isActive: boolean;
  rating: number;
  totalDeliveries: number;
  createdAt: string;
}

// ---- Support: tickets + order issues ---------------------------------------
export interface SupportTicket {
  id: string;
  ticketNumber: string;
  reporterId: string;
  reporterRole: string;
  assignedToId?: string | null;
  orderId?: string | null;
  category: string;
  priority: string;
  status: string;
  subject: string;
  description: string;
  resolution?: string;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderIssue {
  id: string;
  orderId: string;
  chefId: string;
  customerId: string;
  reason: string;
  description?: string;
  requestedAmount: number;
  refundAmount: number;
  status: string;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Admin-tunable refund policy for order issues (#262/#618): refunds up to the cap
// auto-approve; above it they queue for review. Mirrors GET/PUT /admin/order-issue/config.
export interface OrderIssueConfig {
  enabled: boolean;
  autoApproveCap: number;
  defaultFaultPolicy?: string;
}

// ---- Cancellation arbitration (#475 / #480) ---------------------------------
// Disputed cancellations + vendor timeouts an admin rules on. The admin picks the
// tier matching what actually happened; the Go API issues the refund (timeout) or
// tops it up to the difference (dispute). Amounts are snapshotted in paise; the
// platform fee is never refundable and the admin can only RAISE a refund, never
// claw one back. Mirrors apps/api/handlers/admin_cancellation.go.
export interface AdminCancellationRequest {
  id: string;
  orderId: string;
  status: string;
  customerReason?: string;
  vendorReason?: string;
  disputeReason?: string;
  refundTotalPaise: number;
  vendorKeptPaise: number;
  refundExecuted: boolean;
  createdAt: string;
}

// The refund tiers, shared verbatim with the vendor + customer + web + mobile
// surfaces. The percentage each tier refunds is admin-configurable server-side
// (cancel.refund.*_pct in PlatformSettings); the hints reflect the defaults.
export const CANCEL_REASONS = [
  { value: "not_started", label: "Not started yet", hint: "Customer gets most of it back (~90%)" },
  { value: "materials_purchased", label: "Ingredients bought", hint: "Materials covered — ~40% back" },
  { value: "in_preparation", label: "Already cooking", hint: "Preparation started — no refund" },
  { value: "ready", label: "Already made", hint: "Food is ready — no refund" },
] as const;

export type CancelReasonValue = (typeof CANCEL_REASONS)[number]["value"];

// ---- Payouts (admin release queue, #388) ------------------------------------
// Mirrors apps/api/services/payout_release.go PendingPayout + the GetPendingPayouts
// envelope. The hold lifecycle matches models/payout_hold.go PayoutHoldStatus.
export type PayoutHoldStatus =
  | "awaiting_customer_confirmation"
  | "release_eligible"
  | "released"
  | "withheld"
  | "reversed"
  | "disputed";

export interface PendingPayout {
  aggType: "order" | "meal-plan-day";
  id: string;
  chefId: string;
  amount: number;
  holdStatus: PayoutHoldStatus;
  deliveredAt?: string | null;
  ageHours: number;
  customerConfirmedAt?: string | null;
  context: string;
}

export interface PendingPayoutsResponse {
  payouts: PendingPayout[];
  count: number;
}

// ---- Staff ------------------------------------------------------------------
export interface StaffMember {
  id: string;
  userId: string;
  user?: { email?: string; firstName?: string; lastName?: string };
  staffRole: string;
  department?: string;
  title?: string;
  isActive: boolean;
  permissions?: string[];
  lastActiveAt?: string;
  createdAt: string;
}

// ---- Delivery-failure resolution queue (#613) --------------------------------
// The read-only admin queue over apps/api GET /admin/delivery-failures. An admin
// confirms a fault per row and the matching resolve-delivery-failure endpoint runs
// the money policy (customer → chef paid, no refund; platform/chef → full refund +
// chef payout blocked). Categories are disjoint (gateway/chef-self-delivery → an
// OrderIssue; meal-plan days / group orders → status=failed shells, no issue).
export type DeliveryFaultClass = "customer" | "platform" | "chef";

export interface OrderDeliveryFailure {
  issueId: string;
  orderId: string;
  orderNumber: string;
  customerId: string;
  chefId: string;
  total: number;
  holdStatus: PayoutHoldStatus;
  description: string;
  reason: string;
  suggestedFault: string;
  reportedBy: string;
  createdAt: string;
}

export interface DayDeliveryFailure {
  dayId: string;
  mealPlanId: string;
  mealPlanNumber: string;
  customerId: string;
  chefId: string;
  date: string;
  price: number;
  holdStatus: PayoutHoldStatus;
  updatedAt: string;
}

export interface GroupDeliveryFailure {
  groupId: string;
  hostId: string;
  chefId: string;
  subtotal: number;
  tax: number;
  holdStatus: PayoutHoldStatus;
  updatedAt: string;
}

export interface DeliveryFailuresResponse {
  orderIssues: OrderDeliveryFailure[];
  mealPlanDays: DayDeliveryFailure[];
  groupOrders: GroupDeliveryFailure[];
  count: number;
}

// ── Win-back offers (#42) ────────────────────────────────────────────────────
// Auto-offers a discounted promo when a customer lapses or a subscriber
// cancels/suspends. Config is the winback.* PlatformSettings block, so every
// value here is admin-tunable at runtime — no deploy.

export interface WinbackConfig {
  enabled: boolean;
  discountPercent: number;
  maxDiscount: number;
  validityDays: number;
  lapseThresholdDays: number;
  cooldownDays: number;
}

export interface WinbackTriggerStat {
  trigger: string;
  total: number;
  reactivated: number;
}

export interface WinbackAnalytics {
  total: number;
  offered: number;
  reactivated: number;
  expired: number;
  reactivationRate: number;
  byTrigger: WinbackTriggerStat[];
}

// What fired the offer. Kept in sync with the Go side's trigger values.
export const WINBACK_TRIGGER_LABEL: Record<string, string> = {
  lapsed: "Customer lapsed",
  subscription_cancelled: "Subscription cancelled",
  subscription_suspended: "Subscription suspended",
};

// ── Loyalty (#40) ────────────────────────────────────────────────────────────
// Points earned per rupee, redeemable as wallet store credit, plus streaks and
// tiers. Config is the loyalty.* PlatformSettings block — runtime-tunable.

export interface LoyaltyConfig {
  enabled: boolean;
  pointsPerRupee: number;
  redeemRate: number;
  minRedeem: number;
  streakThreshold: number;
  streakBonus: number;
  streakGraceDays: number;
  tierSilverAt: number;
  tierGoldAt: number;
}

export interface LoyaltyAnalytics {
  members: number;
  outstandingPts: number;
  pointsEarned: number;
  pointsRedeemed: number;
  activeStreaks: number;
  longestStreak: number;
}

// ── Order issues (#43) — status union ────────────────────────────────────────
// The OrderIssue / OrderIssueConfig contracts already exist above; this only
// names the status values the admin screen filters on.
//
// NOTE: resolving an issue credits the customer's WALLET (services/order_issue.go
// RefundIssueToWallet -> CreditWallet, source=refund), NOT the original payment
// method — and wallet store credit is unspendable in production while
// WALLET_CHECKOUT_ENABLED is unset (its `false` default stands). Pre-existing
// server behaviour carried over verbatim from the HomeChef admin-portal, not
// introduced by this screen; rerouting it to the gateway means touching the
// chef-clawback / platform-goodwill payout guards (#549/#582/#586/#618) and is
// tracked separately.
export type OrderIssueStatus = "pending" | "auto_refunded" | "resolved" | "rejected";

// ── Promos (#39) ─────────────────────────────────────────────────────────────
// Discount codes. fundingSource decides WHO PAYS: "platform" absorbs the
// discount, "chef" deducts it from that chef's payout — so a chef-funded promo
// needs chefId, and budgetCap bounds the exposure either way.

export type PromoDiscountType = "percentage" | "fixed";
export type PromoFundingSource = "platform" | "chef";

export interface Promo {
  id: string;
  code: string;
  description: string;
  discountType: PromoDiscountType;
  discountValue: number;
  minOrderAmount: number;
  maxDiscount: number;
  usageLimit: number;
  usageCount: number;
  perUserLimit: number;
  validFrom: string;
  validUntil?: string;
  isActive: boolean;
  applicableTo: string;
  fundingSource: PromoFundingSource;
  chefId?: string;
  budgetCap: number;
  budgetSpent: number;
}

export interface PromoAnalytics {
  code: string;
  fundingSource: string;
  redemptions: number;
  totalDiscount: number;
  uniqueUsers: number;
  usageLimit: number;
  usageCount: number;
  budgetCap: number;
  budgetSpent: number;
  budgetRemaining: number;
  budgetUtilisation: number;
}

// ── Mediation / messaging (#53) ──────────────────────────────────────────────
// Chat between a customer and a chef is ADMIN-MEDIATED: there is no direct
// channel. Every message lands in the relay queue and reaches the recipient only
// when an admin relays it. So an unattended inbox does not degrade the feature —
// it silently stops it: nobody's message is delivered.
//
// piiDetected flags a message the server thinks leaks a phone number/address —
// relaying it hands over contact details and lets the pair take the order
// off-platform.

export type MediationRole = "customer" | "chef" | "admin";
export type RelayStatus = "pending" | "relayed" | "blocked";

export interface MediatedMessage {
  id: string;
  conversationId: string;
  orderId: string;
  senderId: string;
  senderRole: MediationRole;
  recipientRole: MediationRole;
  content: string;
  piiDetected: boolean;
  relayStatus: RelayStatus;
  relayedById?: string;
  relayedAt?: string;
  attachmentId?: string;
  filename?: string;
  contentType?: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  orderId: string;
  customerId: string;
  chefId: string;
  status: "open" | "closed";
  createdAt: string;
  lastMessageAt?: string;
}

export const MEDIATION_ROLE_LABEL: Record<MediationRole, string> = {
  customer: "Customer",
  chef: "Chef",
  admin: "Admin",
};

// ── Payment gateway (#262) ───────────────────────────────────────────────────
// The LIVE Razorpay / Stripe credentials the platform charges with. Writing
// these re-points every payment and refund at a different merchant account —
// see the 2026-07-17 key swap, where a new test key meant the old merchant's
// Route linked accounts and webhook no longer resolved.
//
// The API never returns a secret: status carries only keyPrefix (e.g.
// "rzp_test_") and whether each secret is set. Nothing here should ever render
// or echo a secret back.

export interface PaymentGatewayStatus {
  configured: boolean;
  /** "test" | "live", derived server-side from the key itself. */
  mode: string;
  webhookUrl: string;
  webhookSecretSet: boolean;
  /** Leading fragment of the key id — enough to tell test from live, never the key. */
  keyPrefix: string;
  error: string;
}

export interface StripeGatewayStatus extends PaymentGatewayStatus {
  publishableKeySet: boolean;
}

// The API test-fires the new credentials against the gateway before storing
// them; `verified` is that result and `testError` the gateway's complaint.
export interface UpdateKeysResponse {
  message: string;
  verified?: boolean;
  testError?: string;
}

// ── Platform policy / pricing ────────────────────────────────────────────────
// The PlatformSettings blocks that decide the economics of every order. These
// are runtime-tunable on purpose (no deploy), which also means a typo here
// re-prices the platform immediately.

export interface PlatformPolicy {
  /** Platform's cut of the order — the fee the customer is charged. */
  serviceFeePercent: number;
  taxPercent: number;
  baseDeliveryFee: number;
  perKmDeliveryFee: number;
  /** Share of the order that reaches the chef. */
  chefPayoutPercent: number;
  driverPayoutPercent: number;
  timezone: string;
  openingTime: string;
  closingTime: string;
  /** ISO weekday numbers the platform accepts orders on. */
  operatingDays: number[];
  closedMessage: string;
}

export interface SubscriptionTierPrices {
  monthly: number;
  quarterly: number;
  yearly: number;
}

export interface SubscriptionPricing {
  country: string;
  currency: string;
  trialDays: number;
  minEarningsThreshold: number;
  standard: SubscriptionTierPrices;
  premium: SubscriptionTierPrices;
  premiumCommissionRate: number;
}

export interface ReferralConfig {
  enabled: boolean;
  referrerReward: number;
  refereeReward: number;
  monthlySpendCap: number;
}

// ── Audit log ────────────────────────────────────────────────────────────────
// The record of who changed what. Note this is NOT the Paginated<T> envelope the
// rest of the HomeChef admin uses — /admin/audit-logs returns a flat
// { logs, total, page, limit }.

export interface AuditUser {
  firstName?: string;
  lastName?: string;
  email?: string;
}

export interface AuditLogEntry {
  id: string;
  /** Null for system/cron-driven changes with no acting human. */
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: string;
  newValue?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
  user?: AuditUser;
}

export interface AuditLogResponse {
  logs: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
}

// ── Marketing campaigns (#56) ────────────────────────────────────────────────
// The one admin surface that reaches customers OUTSIDE an order: a send goes to
// everyone the segment matches, at once, and cannot be recalled. `preview`
// exists precisely so the audience is a known number before that happens.
//
// segment is stored as a JSON string on the wire but authored as SegmentCriteria
// — parse defensively, a bad blob must not take the page down.

export interface SegmentCriteria {
  roles?: string[];
  recency?: "" | "active" | "lapsed";
  recencyDays?: number;
  cities?: string[];
  subscription?: "" | "active" | "paused" | "none";
  newWithinDays?: number;
}

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "cancelled";

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  sendPush: boolean;
  sendEmail: boolean;
  pushTitle: string;
  pushBody: string;
  emailSubject: string;
  emailHtml: string;
  /** JSON-encoded SegmentCriteria. */
  segment: string;
  scheduledAt?: string;
  sentAt?: string;
  recipients: number;
  createdAt: string;
}

export interface CampaignInput {
  name: string;
  sendPush: boolean;
  sendEmail: boolean;
  pushTitle: string;
  pushBody: string;
  emailSubject: string;
  emailHtml: string;
  segment: SegmentCriteria;
}

// matched is who the segment selects; reachable* is who can actually be
// contacted. The gap matters — a customer with no FCM token is matched but
// unreachable by push (see the device-token 404 that left every vendor without
// one).
export interface SegmentPreview {
  matched: number;
  reachablePush: number;
  reachableEmail: number;
}

export interface CampaignChannelMetrics {
  sent: number;
  failed: number;
  opened: number;
}

export interface CampaignMetrics {
  recipients: number;
  push: CampaignChannelMetrics;
  email: CampaignChannelMetrics;
}

/** Tolerates a malformed blob — a bad segment must not break the list. */
export function parseSegment(raw: string): SegmentCriteria {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as SegmentCriteria) : {};
  } catch {
    return {};
  }
}
