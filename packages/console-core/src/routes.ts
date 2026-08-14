// Route identity lives here, not in either app. This is what prevents the
// mediation/messaging and audit-log/audit-logs drift between web and mobile.
interface RouteEntry {
  web: string;
  mobile: string;
  exact?: boolean;
}

// `as const satisfies Record<string, RouteEntry>` keeps the literal keys (so
// `RouteId` is a real union, e.g. "kora.foods") while still checking every
// entry against the RouteEntry shape. Annotating the table itself as
// `Record<string, RouteEntry>` would widen every key to `string` and collapse
// `RouteId` to `string`, making the exported type meaningless.
const ROUTES = {
  "kora.overview": { web: "/admin/apps/kora", mobile: "/kora", exact: true },
  "kora.foods": { web: "/admin/apps/kora/foods", mobile: "/kora/foods" },
  "kora.audit": { web: "/admin/apps/kora/audit", mobile: "/kora/audit" },
  "kora.feedback": { web: "/admin/apps/kora/feedback", mobile: "/kora/feedback" },
  "kora.users": { web: "/admin/apps/kora/users", mobile: "/kora/users" },
} as const satisfies Record<string, RouteEntry>;

export type RouteId = keyof typeof ROUTES & string;

// Indexing ROUTES[id] with the RouteId union yields a union of each entry's
// exact literal type (some of which lack an `exact` property at all, since
// `as const` doesn't add it as `exact?: undefined`), not a uniform
// RouteEntry. This helper's explicit return type re-widens to RouteEntry so
// callers can read `.exact` regardless of which entry they land on.
function getRoute(id: RouteId): RouteEntry {
  return ROUTES[id];
}

export function webPath(id: RouteId): string {
  return getRoute(id).web;
}

export function mobilePath(id: RouteId): string {
  return getRoute(id).mobile;
}

export function isRouteActive(currentPath: string, id: RouteId, prefix: "web" | "mobile"): boolean {
  const entry = getRoute(id);
  const target = prefix === "web" ? entry.web : entry.mobile;
  // Product roots are a strict prefix of their own children, so an exact
  // match is required or Overview stays highlighted on every nested route.
  if (entry.exact) return currentPath === target || currentPath === `${target}/`;
  // Match on segment boundaries, not bare string prefix: `startsWith(target)`
  // would also mark "/admin/apps/kora/foodsXYZ" active for "kora.foods",
  // since it merely shares a string prefix with the real nested route
  // "/admin/apps/kora/foods/...".
  return currentPath === target || currentPath.startsWith(`${target}/`);
}
