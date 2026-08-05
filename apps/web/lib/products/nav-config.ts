// Admin sidebar nav data + the pure active-state logic that decides which
// entry is highlighted. Deliberately split out of components/admin/sidebar.tsx
// (which is a "use client" component that also imports @tesserix/web) for two
// reasons:
//   1. This module has no React-rendering or browser dependency, so it is
//      cheap to unit test directly.
//   2. It MUST be importable from a vitest test. vitest.config.ts's `include`
//      only covers lib/**/*.test.ts and app/**/*.test.ts — components/ is not
//      discovered at all — and even a components/**/*.test.ts file that
//      imported sidebar.tsx directly would drag in @tesserix/web's compiled
//      output, which fails to resolve under Vitest's Node ESM loader
//      ("Directory import '.../dist/components/accordion' is not
//      supported"). Keeping nav data/logic dependency-light here sidesteps
//      that entirely.
import {
  Activity,
  BadgeCheck,
  BarChart3,
  CalendarRange,
  ChefHat,
  ClipboardList,
  Cloud,
  CreditCard,
  Database,
  Gauge,
  Gift,
  Globe,
  HeartPulse,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  RotateCcw,
  Scale,
  ScrollText,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  TicketPercent,
  Truck,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import type { ComponentType } from "react";

export type NavItem = {
  name: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
};

export type NavGroup = {
  name: string;
  icon: ComponentType<{ className?: string }>;
  items: NavItem[];
};

export type NavEntry = NavItem | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return "items" in entry;
}

export const platformNav: NavEntry[] = [
  { name: "Dashboard", href: "/admin/dashboard", icon: LayoutDashboard },
  { name: "Apps", href: "/admin/apps", icon: Cloud },
  { name: "Tickets", href: "/admin/platform-tickets", icon: LifeBuoy },
  { name: "Support analytics", href: "/admin/analytics/support", icon: BarChart3 },
  { name: "Live chat", href: "/admin/support/live-chat", icon: MessageSquare },
  { name: "Announcements", href: "/admin/platform-announcements", icon: Megaphone },
  { name: "Uptime", href: "/admin/uptime", icon: Activity },
  { name: "Service health", href: "/admin/health", icon: HeartPulse },
  { name: "Observability", href: "/admin/observability", icon: Gauge },
  { name: "Databases", href: "/admin/databases", icon: Database },
  { name: "Custom domains", href: "/admin/custom-domains", icon: Globe },
  { name: "Outbox", href: "/admin/outbox", icon: Inbox },
  { name: "Notification log", href: "/admin/notifications/log", icon: Mail },
  { name: "Lead templates", href: "/admin/notifications/lead-templates", icon: Mail },
  { name: "GDPR queue", href: "/admin/erasure-requests", icon: Shield },
  { name: "Break-glass", href: "/admin/break-glass", icon: KeyRound },
  { name: "Settings", href: "/admin/settings", icon: Settings },
];

export const mark8lyNav: NavEntry[] = [
  { name: "Overview", href: "/admin/apps/mark8ly", icon: LayoutDashboard },
  { name: "Tenants", href: "/admin/apps/mark8ly/tenants", icon: Users },
  { name: "Onboarding", href: "/admin/apps/mark8ly/onboarding", icon: ClipboardList },
  { name: "Subscriptions", href: "/admin/apps/mark8ly/subscriptions", icon: CreditCard },
  { name: "Audit logs", href: "/admin/apps/mark8ly/audit-logs", icon: ScrollText },
  { name: "Leads", href: "/admin/apps/mark8ly/leads", icon: ClipboardList },
  // Same cross-tenant Otto inbox as the HomeChef rail — staff answer
  // mark8ly chats from here without switching product context.
  { name: "Live chat", href: "/admin/support/live-chat", icon: MessagesSquare },
  {
    name: "Notifications",
    icon: Mail,
    items: [
      {
        name: "Templates",
        href: "/admin/apps/mark8ly/notifications/templates",
        icon: Mail,
      },
    ],
  },
];

// Fe3dr secondary nav. Phase A ships the Overview only; the deeper admin
// surfaces (chefs/approvals, orders, payouts, delivery, customers) land with the
// 5B admin sub-features.
// Grouped to keep the rail scannable: two solo anchors (Overview, Analytics) +
// collapsible sections. Order Issues + Delivery Failures were removed entirely
// (they live as tabs in Support); Release Queue (payout-queue) and Delivery
// Intelligence stay off-rail but reachable by URL.
export const homechefNav: NavEntry[] = [
  { name: "Overview", href: "/admin/apps/homechef", icon: LayoutDashboard },
  {
    name: "Chefs & Trust",
    icon: ChefHat,
    items: [
      { name: "Chefs", href: "/admin/apps/homechef/chefs", icon: ChefHat },
      { name: "Approvals", href: "/admin/apps/homechef/approvals", icon: BadgeCheck },
      { name: "FSSAI", href: "/admin/apps/homechef/fssai", icon: Shield },
      { name: "Reviews", href: "/admin/apps/homechef/reviews", icon: ScrollText },
    ],
  },
  {
    name: "Customers",
    icon: Users,
    items: [
      { name: "Users", href: "/admin/apps/homechef/users", icon: Users },
      { name: "Wallets", href: "/admin/apps/homechef/wallets", icon: CreditCard },
    ],
  },
  {
    name: "Orders & Delivery",
    icon: ClipboardList,
    items: [
      { name: "Orders", href: "/admin/apps/homechef/orders", icon: ClipboardList },
      { name: "Meal Plans", href: "/admin/apps/homechef/meal-plans", icon: CalendarRange },
      { name: "Cancellations", href: "/admin/apps/homechef/cancellations", icon: Scale },
      { name: "Delivery (3PL)", href: "/admin/apps/homechef/delivery", icon: Truck },
    ],
  },
  {
    name: "Payments",
    icon: CreditCard,
    items: [
      { name: "Payouts", href: "/admin/apps/homechef/payouts", icon: CreditCard },
      { name: "Payout Setup", href: "/admin/apps/homechef/payout-setup", icon: Settings },
      { name: "Refund Payouts", href: "/admin/apps/homechef/refund-payouts", icon: RotateCcw },
      { name: "Payment Gateway", href: "/admin/apps/homechef/payment-gateway", icon: Wallet },
    ],
  },
  {
    name: "Support",
    icon: LifeBuoy,
    items: [
      { name: "Support", href: "/admin/apps/homechef/support", icon: LifeBuoy },
      { name: "Mediation", href: "/admin/apps/homechef/messaging", icon: MessageSquare },
      // The Otto inbox is cross-tenant and lives in the platform nav; surface
      // it here too, since a chat escalation is what creates the tickets above.
      { name: "Live chat", href: "/admin/support/live-chat", icon: MessagesSquare },
    ],
  },
  {
    name: "Marketing",
    icon: Megaphone,
    items: [
      { name: "Campaigns", href: "/admin/apps/homechef/campaigns", icon: Megaphone },
      { name: "Win-back", href: "/admin/apps/homechef/winback", icon: Gift },
      { name: "Loyalty", href: "/admin/apps/homechef/loyalty", icon: Sparkles },
      { name: "Chef Rewards", href: "/admin/apps/homechef/chef-rewards", icon: Gift },
      { name: "Promos", href: "/admin/apps/homechef/promos", icon: TicketPercent },
    ],
  },
  {
    name: "Settings",
    icon: SlidersHorizontal,
    items: [
      { name: "Platform Settings", href: "/admin/apps/homechef/platform-settings", icon: SlidersHorizontal },
      { name: "Tax Rates", href: "/admin/apps/homechef/tax-rates", icon: SlidersHorizontal },
      { name: "Staff", href: "/admin/apps/homechef/staff", icon: UserCog },
      { name: "Audit Log", href: "/admin/apps/homechef/audit-logs", icon: ScrollText },
    ],
  },
  { name: "Analytics", href: "/admin/apps/homechef/analytics", icon: BarChart3 },
];

// DevAI secondary nav. It has no product-scoped data pages of its own — its
// analytics + logs come from Observability (devai-filtered), incidents from
// Platform Tickets, and service health from the Health page. The Overview ties
// them together (KPI tiles deep-link out).
export const devaiNav: NavEntry[] = [
  { name: "Overview", href: "/admin/apps/devai", icon: LayoutDashboard },
  { name: "Observability", href: "/admin/observability", icon: Gauge },
  { name: "Service health", href: "/admin/health", icon: HeartPulse },
  { name: "Incidents", href: "/admin/platform-tickets", icon: LifeBuoy },
];

// Dwellm8 secondary nav. Phase A ships the Overview only, like Fe3dr's first
// cut — the deeper product pages arrive with the dwellm8 branch of the
// product-scoped API routes.
export const dwellm8Nav: NavEntry[] = [
  { name: "Overview", href: "/admin/apps/dwellm8", icon: LayoutDashboard },
  { name: "Service health", href: "/admin/health", icon: HeartPulse },
  { name: "Observability", href: "/admin/observability", icon: Gauge },
  { name: "Incidents", href: "/admin/platform-tickets", icon: LifeBuoy },
];

// Kora secondary nav. Phase 1 shipped the Overview only; the food index
// (Slice 1 of the food-data admin design) is the first nested route under
// /admin/apps/kora — logs (Phase 2), user management (Phase 3) and economics
// (Phase 4) are still scoped but not designed. Service health is
// namespace-keyed and already works for kora.
export const koraNav: NavEntry[] = [
  { name: "Overview", href: "/admin/apps/kora", icon: LayoutDashboard },
  { name: "Food index", href: "/admin/apps/kora/foods", icon: Database },
  { name: "Service health", href: "/admin/health", icon: HeartPulse },
];

export type RailContext = "platform" | "mark8ly" | "homechef" | "devai" | "dwellm8" | "kora";

export function getActiveContext(pathname: string): RailContext {
  if (pathname.startsWith("/admin/apps/mark8ly")) return "mark8ly";
  if (pathname.startsWith("/admin/apps/homechef")) return "homechef";
  if (pathname.startsWith("/admin/apps/devai")) return "devai";
  if (pathname.startsWith("/admin/apps/dwellm8")) return "dwellm8";
  if (pathname.startsWith("/admin/apps/kora")) return "kora";
  return "platform";
}

export function getSecondaryNav(context: RailContext): { label: string; entries: NavEntry[] } {
  switch (context) {
    case "mark8ly":
      return { label: "Mark8ly", entries: mark8lyNav };
    case "homechef":
      return { label: "Fe3dr", entries: homechefNav };
    case "devai":
      return { label: "DevAI", entries: devaiNav };
    case "dwellm8":
      return { label: "Dwellm8", entries: dwellm8Nav };
    case "kora":
      return { label: "Kora", entries: koraNav };
    case "platform":
    default:
      return { label: "Platform", entries: platformNav };
  }
}

// Product "Overview" entries (`/admin/apps/{product}`) are a strict PREFIX of
// their own nested routes (e.g. `/admin/apps/kora` vs. `/admin/apps/kora/foods`).
// A bare `pathname.startsWith(href)` would keep Overview marked active on
// every nested route, permanently — nobody notices a link that is merely
// "also" highlighted. Roots with nested routes need an exact match instead;
// mark8ly hit this first (tenants/onboarding/etc. all nest under
// `/admin/apps/mark8ly`), and kora's food index is the same shape now that
// /admin/apps/kora/foods exists.
// homechef has the identical shape and has had it all along — its Overview
// entry (`/admin/apps/homechef`) is a strict prefix of ~20 nested routes
// (chefs, orders, payouts, ...) — it just hadn't been generalized to yet.
// devai and dwellm8 do NOT need an entry here: their non-Overview links all
// point at shared platform routes (/admin/observability, /admin/health,
// /admin/platform-tickets), none of which nest under /admin/apps/devai or
// /admin/apps/dwellm8, so `startsWith` never produces a false-positive match
// for either of those two.
const EXACT_MATCH_ROOTS = ["/admin/apps/mark8ly", "/admin/apps/kora", "/admin/apps/homechef"];

export function isNavItemActive(pathname: string, href: string): boolean {
  if (EXACT_MATCH_ROOTS.includes(href)) {
    return pathname === href || pathname === `${href}/`;
  }
  return pathname.startsWith(href);
}

export function isGroupActive(pathname: string, group: NavGroup): boolean {
  return group.items.some((item) => isNavItemActive(pathname, item.href));
}
