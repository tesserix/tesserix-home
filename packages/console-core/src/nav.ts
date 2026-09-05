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
  // Fourth entry, added alongside `kora.aiMetrics` in routes.ts — the full
  // surface behind the overview's three AI-resolution tiles.
  { name: "AI metrics", route: "kora.aiMetrics", icon: "bar-chart" },
];

/**
 * Mark8ly's product rail: an overview, one entry per §3.4 entity type the
 * product declares, and the CSM migration fast-path review queue.
 *
 * WHY THIS WAS ONE ENTRY UNTIL NOW — and why the record below is still true
 * of the surfaces it is about. Everything from here to the `inbox` note is
 * about the queue and the two surfaces deferred alongside it; the three
 * entries added since are a different set, described after it.
 *
 * The design (§2.3) names three: the CSM migration fast-path review queue,
 * arbitrage appeals, and app credentials. Only the first is built against
 * anything. The other two are deferred BY DECISION rather than by absence —
 * §5: arbitrage appeals and app credentials "are not on the list…
 * /admin/inbox already carries the appeal queue as a `kind`. A dedicated
 * surface for either is reassessed after the queue lands." App credentials
 * additionally live on mark8ly's own admin surface rather than /admin/*, and
 * are gated on a `rotate-credentials` capability the console has no way to
 * hold. Recorded here so a reader does not conclude two entries were
 * forgotten: this rail is §5's own sequencing, and this issue is the "after
 * the queue lands" the deferrals wait on.
 *
 * WHY A PRODUCT RAIL AT ALL, given §8.5 retired Kora's feedback into the
 * estate Inbox for implementing the same `/admin/inbox` contract: mark8ly's
 * migration offer is its own commercial product, and nothing else in the
 * estate has one. The review step presupposes mark8ly's migration model in a
 * way "what is waiting on a human" does not, so this queue fails §2's
 * decisive test — two products' rows could not sit in one table without a
 * column meaning something different in each. The full argument is on the
 * route in routes.ts; it is repeated here because this is the file where the
 * Kora precedent is visible three lines away.
 *
 * Not seeded from apps/web, unlike koraNav and platformNav: apps/web's
 * mark8ly rail is eight entries of tenant/onboarding/subscription surfaces
 * and contains nothing resembling this queue. This rail is console-native.
 *
 * `inbox` icon rather than a new key: the queue IS `/admin/inbox`'s
 * `migration_fast_path` kind, so the shared icon says something true about
 * it. Not a cost argument — a new key is one entry in one registry, and
 * icons.ts says why.
 *
 * THE THREE ENTRIES ADDED SINCE ARE NOT §2.3's OTHER TWO. Overview, Tenants
 * and Users are the generic `[product]` surfaces: `/mark8ly` reads §3.1
 * `kpis`, and `/mark8ly/tenants` and `/mark8ly/users` read §3.4 `entities`,
 * one page per type in `PRODUCTS.mark8ly.entities`. They are served by
 * `app/(console)/[product]/page.tsx` and `[product]/[entity]/page.tsx` with no
 * mark8ly page file of their own. So they are not arbitrage appeals or app
 * credentials arriving early — those two are still deferred by §5, exactly as
 * recorded above.
 *
 * They are listed here now rather than when their route ids were declared
 * because a rail entry advertises a door: routes.ts declared the ids ahead of
 * the pages on purpose (so the capability gate applied from the first day),
 * and the pages landed afterwards. This is the change that opens the doors.
 */
export const mark8lyNav: readonly NavEntry[] = [
  // Overview first, and `layout-dashboard` to match `kora.overview`: it is the
  // same kind of surface on the other product rail, so it looks the same.
  { name: "Overview", route: "mark8ly.overview", icon: "layout-dashboard" },
  // Then one entry per declared §3.4 entity type, in the order
  // `PRODUCTS.mark8ly.entities` lists them, so the rail and the registry can
  // be read side by side without reconciling two orders.
  //
  // `globe` is `platform.tenants`'s icon. Sharing it is deliberate: the two
  // are different route ids for different surfaces (routes.ts says why they
  // must stay separate), but they are the same KIND of thing to an operator
  // scanning a rail, and the RAIL an entry sits on is what says whose tenants
  // these are — the icon was never carrying that distinction. Same choice as
  // `key-round` and `inbox` on the platform rail, each of which sits on three
  // entries, and made on the same ground: a shared icon that reads correctly,
  // not a renderer edit avoided.
  { name: "Tenants", route: "mark8ly.tenants", icon: "globe" },
  // `users` for the same reason `kora.users` carries it.
  { name: "Users", route: "mark8ly.users", icon: "users" },
  // Last. It was first when it was the only entry; it moves to the end
  // because it is the one entry still `pending`, and a rail whose first row
  // is an unclickable SOON badge reads as a rail that does not work. No
  // stronger claim than that — the platform rail does not order pending
  // entries consistently either way (Break-glass sits mid-Governance with
  // built entries below it).
  //
  // The name renders mark8ly's vocabulary rather than translating it: the
  // queue is over the `migration_fast_path` inbox kind, and calling it
  // anything else on the rail would make the console and the product describe
  // the same rows with two different words.
  {
    name: "Migration fast-path review",
    route: "mark8ly.migrationFastPath",
    icon: "inbox",
  },
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
      // Directly after Dashboard: the dashboard says how the estate IS, the
      // inbox says what needs doing. Placed here rather than beside Tickets
      // (the other queue) because nav.test.ts pins Identity lookup as
      // Tickets + 1 — #134's fix — and inserting between them would reopen a
      // discoverability bug to satisfy a grouping preference.
      //
      // `inbox` is an existing IconKey and the right one: this entry IS the
      // queue of things waiting on a human. NOT `/admin/inbox` — that is the
      // per-product §3.2 contract, cited correctly by
      // `mark8ly.migrationFastPath` on its own rail. routes.ts is explicit
      // that implementing it makes a product a SOURCE in this surface rather
      // than earning it a rail entry, and records that apps/web never had an
      // estate-wide queue at all.
      { name: "Inbox", route: "platform.inbox", icon: "inbox" },
      { name: "Apps", route: "platform.apps", icon: "cloud" },
      // Directly after Apps, and deliberately NOT between Tickets and
      // Identity lookup: nav.test.ts pins those two as adjacent because #134
      // is a discoverability ticket, and pushing the lookup one row further
      // from the ticket queue is the beginning of the problem it fixed.
      //
      // Here reads correctly anyway — Apps says which products exist, Tenants
      // says who is on them. The two directories belong together.
      //
      // `globe` rather than a new "building" key, on sense rather than cost:
      // it is the estate-wide view of who is on the platform, not one
      // product's. (A new key costs one registry entry — see icons.ts.)
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
      // `users` icon rather than a new "search"/"user-search" key: this
      // surface returns people, which is what `users` says. A dedicated key
      // would read better and is affordable — one registry entry, see
      // icons.ts — but `users` is not saying anything false meanwhile.
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
      // Beside Break-glass: both are credential surfaces, and `key-round`
      // is reused on purpose rather than picked fresh — the same reasoning
      // as `scroll-text` on Audit log above, "the same kind of surface
      // should look the same in both rails". The chart cutover
      // (tesserix-k8s#808/#809) redeployed `secrets-api` against Zitadel and
      // it is verified live (602 real secrets across OpenBao and GSM, live
      // version history, a genuine empty reviews queue), so the condition
      // that kept these two unlisted no longer holds.
      { name: "Secrets", route: "platform.secrets", icon: "key-round" },
      // Listed, reversing an earlier decision to leave it reachable only
      // from a secret's own page. That reasoning assumed the reader is the
      // person who just proposed the change; an approver needs to find
      // SOMEONE ELSE'S proposal proactively, which a door reached only from
      // the secret they did not touch cannot offer. Governance already lists
      // Outbox and GDPR queue as exactly this shape of surface — a queue
      // that is usually empty and exists to be drained — so this fits the
      // group rather than being an exception to it.
      { name: "Secrets reviews", route: "platform.secretsReviews", icon: "key-round" },
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
      // Billing first in this group, ahead of the CRM cluster: the CRM is the
      // pipeline BEFORE a sale and billing is what happens after, so the rail
      // reads pipeline → customers → revenue only if revenue is not buried
      // under three lead-management entries.
      //
      // Growth rather than Operate: §8.2's purpose is to make a product
      // "legible as a business", which is this group's question. The trials
      // tab is genuinely a work queue, which argued for Operate — but
      // splitting the two §8.2 reads across two groups would put two doors on
      // one capability, and #133 settled that argument the other way.
      // `bar-chart` rather than a new "credit-card" key: this surface is the
      // business read of the estate, which is what `bar-chart` already says
      // on `platform.aiUsage`. Not a cost argument — a new key is one
      // registry entry, see icons.ts.
      { name: "Billing", route: "platform.billing", icon: "bar-chart" },
      // Directly after Billing and ahead of the CRM cluster, because that is
      // the order the funnel question sits in: the CRM is the pipeline before
      // a signup, onboarding is the signup itself, and billing is what
      // happens after one converts. Billing stays first for the reason
      // recorded above — revenue must not be buried under lead management —
      // so onboarding takes the next slot rather than the top one.
      //
      // Growth rather than Operate: this is not service upkeep. It is read to
      // answer where prospective tenants are dropping out, which is revenue
      // work in exactly the sense this group was created for.
      //
      // `users` is the only `users` left in Growth: the two CRM entries
      // below took `list-checks` and `globe` when they were told apart. A
      // dedicated "funnel" key would still read better and is affordable —
      // one registry entry, see icons.ts — it is simply not this change.
      { name: "Onboarding", route: "platform.onboarding", icon: "users" },
      // "Follow-ups", not "CRM". Every other entry in this group names what
      // you do or what you see; "CRM" named the system all of them
      // collectively are, which left it indistinguishable from Organisations
      // one row below — the console's operator asked whether both were
      // needed. They are different surfaces: this is the work (Due,
      // Drifting, Handoff and Closed, ordered by urgency, with next-action
      // affordances) and Organisations is the directory you browse. The page
      // already calls itself this — apps/console/app/(console)/platform/crm/
      // page.tsx heads its docblock "The CRM follow-up queue".
      //
      // "Work queue" was the alternative and is worse in this group: the
      // Billing trials tab and Do-not-contact are work queues too, so it
      // names the genre rather than this surface.
      //
      // `list-checks` rather than the `users` this shared with Organisations:
      // one icon on both is the other half of why they read as one thing
      // twice, and this queue is a list of leads each needing a next action.
      // The keys already declared and unused — `activity`, `gauge`,
      // `heart-pulse` — are metric and health glyphs that say nothing about
      // work to be done, so this is a new key rather than one of those.
      { name: "Follow-ups", route: "platform.crm", icon: "list-checks" },
      // Second, not last: an imported lead sits on neither queue for its
      // first fourteen days (Due needs a next action, Drifting needs a
      // quiet period), so browse is the only way to reach it in the
      // meantime.
      //
      // `globe` rather than the `users` this used to share with the entry
      // above. It is the icon `platform.tenants` and `mark8ly.tenants`
      // already carry for "a directory of organisations", and those two share
      // it on exactly the reasoning that applies here: same KIND of surface,
      // and the rail an entry sits on is what says whose organisations these
      // are. Growth is the pre-signup pipeline, so nobody reads this row as
      // the tenant directory.
      //
      // The note that used to sit here priced a dedicated key at "three
      // renderers changed, one of them apps/web". That was false, and it was
      // the whole justification for the duplicate icon: `apps/console` is the
      // only package that depends on console-core, so the cost was always one
      // registry entry. See icons.ts.
      { name: "Organisations", route: "platform.crmOrganisations", icon: "globe" },
      { name: "Do-not-contact", route: "platform.crmSuppressions", icon: "shield" },
      // `mail` for the same reason `platform.leadTemplates` carries it: this is
      // outreach copy. The two are different route ids for different surfaces
      // (see routes.ts) but they are the same KIND of thing to an operator
      // scanning the rail, so an icon that disagreed would be the confusing
      // part.
      { name: "Templates", route: "platform.crmTemplates", icon: "mail" },
      // `inbox` rather than a new "upload" key: leads arriving in bulk are
      // the same shape of thing `inbox` marks elsewhere on this rail. Not a
      // cost argument — a new key is one registry entry, see icons.ts.
      { name: "Import leads", route: "platform.crmImport", icon: "inbox" },
    ],
  },
];
