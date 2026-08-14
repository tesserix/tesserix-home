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
