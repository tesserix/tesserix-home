// Route identity lives here, not in either app. This is what prevents the
// mediation/messaging and audit-log/audit-logs drift between web and mobile.
interface RouteEntry {
  web: string;
  mobile: string;
  exact?: boolean;
  /**
   * The surface is still served by `apps/web`, not the console. A renderer must
   * link to it on the web origin, or the console routes to a page it does not
   * have and the operator gets a 404.
   *
   * This flag is the migration made explicit: it flips to absent as each
   * surface moves, and the estate view counts what remains.
   */
  hostedByWeb?: boolean;
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

  // Platform rail. Every one of these is still rendered by apps/web — the
  // console owns their identity so the rail can be built from one source, but
  // `hostedByWeb` keeps the link honest until each surface actually moves.
  "platform.dashboard": { web: "/admin/dashboard", mobile: "/platform", hostedByWeb: true },
  "platform.apps": { web: "/admin/apps", mobile: "/platform/apps", exact: true, hostedByWeb: true },
  "platform.tickets": { web: "/admin/platform-tickets", mobile: "/platform/tickets", hostedByWeb: true },
  "platform.supportAnalytics": { web: "/admin/analytics/support", mobile: "/platform/support-analytics", hostedByWeb: true },
  "platform.liveChat": { web: "/admin/support/live-chat", mobile: "/platform/live-chat", hostedByWeb: true },
  "platform.announcements": { web: "/admin/platform-announcements", mobile: "/platform/announcements", hostedByWeb: true },
  "platform.uptime": { web: "/admin/uptime", mobile: "/platform/uptime", hostedByWeb: true },
  "platform.serviceHealth": { web: "/admin/health", mobile: "/platform/health", hostedByWeb: true },
  "platform.observability": { web: "/admin/observability", mobile: "/platform/observability", hostedByWeb: true },
  "platform.databases": { web: "/admin/databases", mobile: "/platform/databases", hostedByWeb: true },
  "platform.customDomains": { web: "/admin/custom-domains", mobile: "/platform/custom-domains", hostedByWeb: true },
  "platform.outbox": { web: "/admin/outbox", mobile: "/platform/outbox", hostedByWeb: true },
  "platform.notificationLog": { web: "/admin/notifications/log", mobile: "/platform/notifications", hostedByWeb: true },
  "platform.leadTemplates": { web: "/admin/notifications/lead-templates", mobile: "/platform/lead-templates", hostedByWeb: true },
  "platform.gdprQueue": { web: "/admin/erasure-requests", mobile: "/platform/gdpr", hostedByWeb: true },
  "platform.breakGlass": { web: "/admin/break-glass", mobile: "/platform/break-glass", hostedByWeb: true },
  "platform.settings": { web: "/admin/settings", mobile: "/platform/settings", hostedByWeb: true },
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

/**
 * True while the surface is still served by `apps/web`. A renderer must send
 * the operator to the web origin for these — linking in-app would route to a
 * page the console does not have.
 */
export function isHostedByWeb(id: RouteId): boolean {
  return getRoute(id).hostedByWeb === true;
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
