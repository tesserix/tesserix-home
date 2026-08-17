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
  // No "Audit trail" entry: #139 folded Kora's trail into the estate-wide
  // `platform.auditLog`, so `kora.audit` is `retired` in routes.ts and a rail
  // item would be a door onto a redirect. The route id is kept there because
  // mobile still serves that screen standalone, and it records the web path
  // this app's redirect points away from. Guarded in nav.test.ts.
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
      // Placed here, directly after Tickets, because that is the workflow: a
      // ticket arrives, and the first question is who this person is across
      // the estate. Governance — beside the GDPR queue and break-glass — was
      // the other candidate, and it is where the surface's obligations point,
      // but it is the wrong answer to the issue's actual complaint. #134 is a
      // DISCOVERABILITY ticket: the lookup already exists and nobody finds it.
      // Filing it under Governance, which reads as policy and configuration
      // rather than daily work, would move it from unfindable to
      // findable-in-the-wrong-place. v1 returns staff and operators only,
      // which makes it an operational surface on its own terms.
      //
      // `users` icon rather than a new "search"/"user-search" key: IconKey is
      // consumed as `Record<IconKey, ...>` in every renderer, so adding a key
      // is a compile error in web, mobile and console until each maps one —
      // three apps changed for an entry that does not render a page yet.
      { name: "Identity lookup", route: "platform.identityLookup", icon: "users" },
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
      // First in Governance, and above the queues rather than below them: this
      // is the group's headline surface. The rest of Governance is work to be
      // done (an outbox to drain, an erasure queue to clear); the audit log is
      // the record of work already done, which is what makes the rest
      // accountable. #139 merged three product-scoped audit pages into it.
      //
      // Not in Operate, unlike Identity lookup. That one is reached mid-ticket;
      // this one is opened to answer "who did this, and when" — the same
      // question the GDPR queue and break-glass exist to make answerable.
      //
      // `scroll-text` matches `kora.audit`'s icon on purpose: the same kind of
      // surface should look the same in both rails, and Task 3 retires the Kora
      // entry into this one.
      { name: "Audit log", route: "platform.auditLog", icon: "scroll-text" },
      { name: "Outbox", route: "platform.outbox", icon: "inbox" },
      { name: "Notification log", route: "platform.notificationLog", icon: "mail" },
      { name: "Lead templates", route: "platform.leadTemplates", icon: "mail" },
      { name: "GDPR queue", route: "platform.gdprQueue", icon: "shield" },
      { name: "Break-glass", route: "platform.breakGlass", icon: "key-round" },
      { name: "Settings", route: "platform.settings", icon: "settings" },
    ],
  },
  {
    // Growth is a new group, not a fourth item bolted onto Operate. Operate
    // is service upkeep — the ticket queue, identity lookup, live chat,
    // announcements — all things done TO keep the platform running. A sales
    // queue is not upkeep: it is revenue work, done to bring tenants in
    // rather than to keep existing ones served. Filing it in Operate would
    // blur that line the same way filing the audit log there would have
    // blurred Governance's.
    name: "Growth",
    icon: "users",
    // All three CRM surfaces, not just the queue. Import and the
    // do-not-contact list were reachable only by typing their URLs, and a
    // page nobody can navigate to barely exists — which matters most for
    // exactly these two: the spec's emphasis is that suppression must be in
    // place BEFORE the first import, and an operator who cannot find the
    // list will simply import without it. Ordered queue → do-not-contact →
    // import so the rail reads in the order the work has to happen.
    items: [
      { name: "CRM", route: "platform.crm", icon: "users" },
      { name: "Do-not-contact", route: "platform.crmSuppressions", icon: "shield" },
      // `inbox` rather than a new "upload" key, for the reason already
      // recorded on "Identity lookup" above: IconKey is consumed as
      // `Record<IconKey, ...>` in web, mobile and console, so a new key is
      // three apps changed for one rail entry.
      { name: "Import leads", route: "platform.crmImport", icon: "inbox" },
    ],
  },
];
