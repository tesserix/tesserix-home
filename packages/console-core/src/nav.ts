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

/**
 * Every NavItem in a rail, with groups flattened away.
 *
 * Exported rather than left as a local helper in each caller, because there
 * are now two kinds of caller and they must agree: nav.test.ts walks the rails
 * to assert what they do and do not carry, and the console's command palette
 * walks them to decide what it may still advertise (a pending route with no
 * rail entry says LESS in the palette than the deleted rail did — see
 * `routeEntries` in apps/console/lib/search.ts). A second walker that stopped
 * descending into groups would silently report an empty rail, which is exactly
 * the failure mode nav.test.ts guards against for its own copy.
 */
export function navItems(entries: readonly NavEntry[]): readonly NavItem[] {
  return entries.flatMap((entry) =>
    isNavGroup(entry) ? navItems(entry.items) : [entry],
  );
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
  // No "Feedback" entry either, and for the same reason as Audit trail above:
  // Kora's `/admin/inbox` already merges feedback into the estate queue, so a
  // rail item here would be a second door onto rows the platform rail serves
  // (§8.5). `kora.feedback` is `retired` in routes.ts. Guarded in nav.test.ts.
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
      // Directly after Apps, and deliberately NOT between Tickets and
      // Identity lookup: nav.test.ts pins those two as adjacent because #134
      // is a discoverability ticket, and pushing the lookup one row further
      // from the ticket queue is the beginning of the problem it fixed.
      //
      // Here reads correctly anyway — Apps says which products exist, Tenants
      // says who is on them. The two directories belong together.
      //
      // `globe` rather than a new "building" key: IconKey is consumed as
      // `Record<IconKey, ...>` in every renderer, so adding one is a compile
      // error in web, mobile and console until each maps it — three apps
      // changed for an icon. `globe` is the closest existing sense: the
      // estate-wide view of who is on the platform, not one product's.
      { name: "Tenants", route: "platform.tenants", icon: "globe" },
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
  // No "Health" group: its five entries (Uptime, Service health,
  // Observability, Databases, Custom domains) were unbuilt `pending`
  // placeholders that led nowhere. Estate health now lives at the real
  // `/platform/health` page, reached from the header's health indicator —
  // not from a rail group. The route ids stay in routes.ts (apps/web still
  // serves those paths); only the nav entries are gone. Removed deliberately
  // — do not re-add this group.
  {
    // Its own group rather than an item in Operate or Governance. Operate is
    // service upkeep; Governance is policy and queues. AI spend is neither: it
    // is a bill and a guardrail record for one shared data plane that every
    // product routes through, and it is read for a reason — a cost spike —
    // that belongs to no other group's workflow. (The original argument here
    // placed it against a "Health" group; that group has since been deleted as
    // dead placeholders — see the marker above — so the comparison is gone but
    // the conclusion is not.)
    name: "AI",
    icon: "bar-chart",
    items: [{ name: "AI usage", route: "platform.aiUsage", icon: "bar-chart" }],
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
      // Managing the internal tools directory (#318 follow-up). Beside
      // Settings: both are configuration surfaces for the platform itself,
      // not a queue or a record of work done.
      { name: "Tools", route: "platform.tools", icon: "settings" },
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
      // Second, not last: an imported lead sits on neither queue for its
      // first fourteen days (Due needs a next action, Drifting needs a
      // quiet period), so browse is the only way to reach it in the
      // meantime.
      //
      // `users` duplicates the CRM item's icon, which is a wart — but
      // IconKey is consumed as `Record<IconKey, ...>` in web, mobile and
      // console (icons.ts:14-16), so a dedicated "building" key is three
      // renderers changed for one rail entry, one of them apps/web. The
      // duplicate icon is the cheaper wrong thing.
      { name: "Organisations", route: "platform.crmOrganisations", icon: "users" },
      { name: "Do-not-contact", route: "platform.crmSuppressions", icon: "shield" },
      // `inbox` rather than a new "upload" key, for the reason already
      // recorded on "Identity lookup" above: IconKey is consumed as
      // `Record<IconKey, ...>` in web, mobile and console, so a new key is
      // three apps changed for one rail entry.
      { name: "Import leads", route: "platform.crmImport", icon: "inbox" },
    ],
  },
];
