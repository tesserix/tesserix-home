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
