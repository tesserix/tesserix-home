// Route identity lives here, not in either app. This is what prevents the
// mediation/messaging and audit-log/audit-logs drift between web and mobile.
interface RouteEntry {
  web: string;
  mobile: string;
  /**
   * Path in `apps/console`. Optional: when absent the console serves the
   * `mobile` path, which is already the clean shape (`/platform/tickets`)
   * rather than `apps/web`'s `/admin/*` legacy.
   *
   * A third field rather than reusing `mobile` outright, because a console
   * rendering from a field called `mobile` is exactly the quiet drift this
   * package exists to prevent — and the two will diverge the first time a
   * surface needs a different shape on a phone.
   */
  console?: string;
  exact?: boolean;
  /**
   * The surface is not built in the console yet.
   *
   * A renderer must NOT link it — not in-app (the page does not exist) and not
   * to `apps/web` either: the old admin is being retired, so linking there
   * builds a dependency on something scheduled to disappear, and quietly makes
   * the console a shell around the app it replaces. Show the entry as pending
   * instead, so the rail describes the intended IA without lying about what
   * works.
   *
   * The flag comes off per-surface as each page lands here.
   */
  pending?: boolean;
}

// `as const satisfies Record<string, RouteEntry>` keeps the literal keys (so
// `RouteId` is a real union, e.g. "kora.foods") while still checking every
// entry against the RouteEntry shape. Annotating the table itself as
// `Record<string, RouteEntry>` would widen every key to `string` and collapse
// `RouteId` to `string`, making the exported type meaningless.
const ROUTES = {
  // Kora's IA lives here; its SURFACES do not exist in the console yet. Without
  // `pending` the rail links to in-app routes that are not there — five 404s.
  "kora.overview": { web: "/admin/apps/kora", mobile: "/kora", exact: true, pending: true },
  "kora.foods": { web: "/admin/apps/kora/foods", mobile: "/kora/foods", pending: true },
  "kora.audit": { web: "/admin/apps/kora/audit", mobile: "/kora/audit", pending: true },
  "kora.feedback": { web: "/admin/apps/kora/feedback", mobile: "/kora/feedback", pending: true },
  "kora.users": { web: "/admin/apps/kora/users", mobile: "/kora/users", pending: true },

  // Platform rail. The console owns their identity so the rail can be built
  // from one source; none of the surfaces is built here yet.
  "platform.dashboard": { web: "/admin/dashboard", mobile: "/platform", pending: true },
  "platform.apps": { web: "/admin/apps", mobile: "/platform/apps", exact: true, pending: true },
  // First surface built in the console — hence no `pending`. Served at
  // /platform/tickets there; apps/web keeps /admin/platform-tickets until it
  // is deleted.
  "platform.tickets": { web: "/admin/platform-tickets", mobile: "/platform/tickets" },
  "platform.supportAnalytics": { web: "/admin/analytics/support", mobile: "/platform/support-analytics", pending: true },
  "platform.liveChat": { web: "/admin/support/live-chat", mobile: "/platform/live-chat", pending: true },
  "platform.announcements": { web: "/admin/platform-announcements", mobile: "/platform/announcements", pending: true },
  "platform.uptime": { web: "/admin/uptime", mobile: "/platform/uptime", pending: true },
  "platform.serviceHealth": { web: "/admin/health", mobile: "/platform/health", pending: true },
  "platform.observability": { web: "/admin/observability", mobile: "/platform/observability", pending: true },
  "platform.databases": { web: "/admin/databases", mobile: "/platform/databases", pending: true },
  "platform.customDomains": { web: "/admin/custom-domains", mobile: "/platform/custom-domains", pending: true },
  "platform.outbox": { web: "/admin/outbox", mobile: "/platform/outbox", pending: true },
  "platform.notificationLog": { web: "/admin/notifications/log", mobile: "/platform/notifications", pending: true },
  "platform.leadTemplates": { web: "/admin/notifications/lead-templates", mobile: "/platform/lead-templates", pending: true },
  "platform.gdprQueue": { web: "/admin/erasure-requests", mobile: "/platform/gdpr", pending: true },
  "platform.breakGlass": { web: "/admin/break-glass", mobile: "/platform/break-glass", pending: true },
  "platform.settings": { web: "/admin/settings", mobile: "/platform/settings", pending: true },
} as const satisfies Record<string, RouteEntry>;

export type RouteId = keyof typeof ROUTES & string;

/**
 * Every route id, for exhaustive iteration.
 *
 * Derived from ROUTES rather than listed, so a route added without a
 * corresponding entry here is impossible — the failure mode a hand-maintained
 * list has is that guards silently stop covering new routes.
 */
export const ROUTE_IDS = Object.keys(ROUTES) as readonly RouteId[];

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

/**
 * Path in the console, falling back to the mobile path.
 *
 * The console does NOT serve `apps/web`'s `/admin/*` paths. Those belong to an
 * app being retired, and `/admin/...` on a host that is itself the admin reads
 * as a leftover — which it would be.
 */
export function consolePath(id: RouteId): string {
  const entry = getRoute(id);
  return entry.console ?? entry.mobile;
}

/**
 * True while the surface has no page in the console. Renderers must show these
 * as pending rather than linking them anywhere — see `RouteEntry.pending`.
 */
export function isPending(id: RouteId): boolean {
  return getRoute(id).pending === true;
}

export function isRouteActive(
  currentPath: string,
  id: RouteId,
  prefix: "web" | "mobile" | "console",
): boolean {
  const entry = getRoute(id);
  const target =
    prefix === "web"
      ? entry.web
      : prefix === "console"
        ? (entry.console ?? entry.mobile)
        : entry.mobile;
  // Product roots are a strict prefix of their own children, so an exact
  // match is required or Overview stays highlighted on every nested route.
  if (entry.exact) return currentPath === target || currentPath === `${target}/`;
  // Match on segment boundaries, not bare string prefix: `startsWith(target)`
  // would also mark "/admin/apps/kora/foodsXYZ" active for "kora.foods",
  // since it merely shares a string prefix with the real nested route
  // "/admin/apps/kora/foods/...".
  return currentPath === target || currentPath.startsWith(`${target}/`);
}
