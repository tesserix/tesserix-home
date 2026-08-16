import type { IconKey } from "./icons";
import type { RouteId } from "./routes";

export interface NavItem {
  name: string;
  route: RouteId;
  icon: IconKey;
}

export interface NavGroup {
  name: string;
  icon: IconKey;
  items: readonly NavItem[];
}

export type NavEntry = NavItem | NavGroup;

export function isNavGroup(e: NavEntry): e is NavGroup {
  return "items" in e;
}

// Seeded from apps/web/lib/products/nav-config.ts's koraNav. Kora's rail has
// no groups yet — every entry is a flat NavItem — so this mirrors that shape
// exactly rather than inventing grouping the web app doesn't have.
export const koraNav: readonly NavEntry[] = [
  { name: "Overview", route: "kora.overview", icon: "layout-dashboard" },
  { name: "Food index", route: "kora.foods", icon: "database" },
  { name: "Audit trail", route: "kora.audit", icon: "scroll-text" },
  { name: "Feedback", route: "kora.feedback", icon: "message-square" },
  { name: "Users", route: "kora.users", icon: "users" },
];

/**
 * The platform rail — the console's default context, and the one its own home
 * page serves.
 *
 * apps/web renders these as a flat list. Grouped here into Operate / Health /
 * Governance because a flat sixteen is a wall: the groups say what a reader is
 * looking at before they read any label. The grouping is presentational; route
 * identity is unchanged, so nothing downstream depends on it.
 *
 * Most entries are still served by apps/web; the ones the console serves itself
 * are the ones without `pending` in routes.ts. They are listed here so one
 * source describes the rail, not to imply they all moved.
 */
export const platformNav: readonly NavEntry[] = [
  {
    name: "Operate",
    icon: "layout-dashboard",
    items: [
      { name: "Dashboard", route: "platform.dashboard", icon: "layout-dashboard" },
      { name: "Apps", route: "platform.apps", icon: "cloud" },
      { name: "Tickets", route: "platform.tickets", icon: "life-buoy" },
      // No "Support analytics" entry: it is a tab on Tickets now (#133), so a
      // rail item would be a second door onto the same page. The route id is
      // kept in routes.ts marked `retired` — mobile still serves that surface
      // standalone, and the id is what records where.
      { name: "Live chat", route: "platform.liveChat", icon: "message-square" },
      { name: "Announcements", route: "platform.announcements", icon: "megaphone" },
    ],
  },
  {
    name: "Health",
    icon: "activity",
    items: [
      { name: "Uptime", route: "platform.uptime", icon: "activity" },
      { name: "Service health", route: "platform.serviceHealth", icon: "heart-pulse" },
      { name: "Observability", route: "platform.observability", icon: "gauge" },
      { name: "Databases", route: "platform.databases", icon: "database" },
      { name: "Custom domains", route: "platform.customDomains", icon: "globe" },
    ],
  },
  {
    name: "Governance",
    icon: "shield",
    items: [
      { name: "Outbox", route: "platform.outbox", icon: "inbox" },
      { name: "Notification log", route: "platform.notificationLog", icon: "mail" },
      { name: "Lead templates", route: "platform.leadTemplates", icon: "mail" },
      { name: "GDPR queue", route: "platform.gdprQueue", icon: "shield" },
      { name: "Break-glass", route: "platform.breakGlass", icon: "key-round" },
      { name: "Settings", route: "platform.settings", icon: "settings" },
    ],
  },
];
