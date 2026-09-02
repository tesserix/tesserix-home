// Type-only import, deliberately. `Capability` is a contract with Zitadel and
// must have exactly one definition in the estate, but console-core is a pure
// data package and importing the platform-auth barrel for a value would drag
// `jose` and the session/CSRF machinery into every consumer's runtime graph.
// `import type` is erased at build, so this buys the shared type at zero
// runtime cost. No cycle: platform-auth does not depend on console-core.
import type { Capability } from "@tesserix/platform-auth";

// Route identity lives here, not in either app. This is what prevents the
// mediation/messaging and audit-log/audit-logs drift between web and mobile.
interface RouteEntry {
  /**
   * Path in `apps/web`. Optional, and the absence is meaningful: it records
   * that apps/web never served this surface, so there is nothing here being
   * retired and nothing for a reader to go and look at.
   *
   * Optional rather than required-with-a-plausible-value because the first
   * console-native surface (`platform.auditLog`) has no single predecessor —
   * apps/web has THREE product-scoped audit pages and no estate-wide one.
   * Naming any one of them here would record a third of the truth in the field
   * whose whole job is to say where the capability lives today, and the
   * console's aggregate is precisely not any one of them.
   *
   * `webPath` therefore returns `string | undefined`. Nothing renders from it —
   * apps/web has its own `lib/products/nav-config.ts` — so this field is a
   * record, and an honest gap in a record beats a confident wrong entry.
   */
  web?: string;
  /**
   * Path in the mobile app. Optional for the same reason `web` is: a route
   * that exists only in the console (`platform.tools`) has no mobile
   * counterpart to record, and a placeholder path here would claim one that
   * was never built. Every route before `platform.tools` happens to set this,
   * which is why it looked required — it never was one.
   */
  mobile?: string;
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
  /**
   * The surface has no page of its own any more: its capability was folded into
   * another route.
   *
   * Distinct from `pending`, and deliberately not a second spelling of it. A
   * pending entry is coming and belongs in the IA as a promise; a retired one is
   * not coming, and putting it in a rail would advertise a page that will never
   * be built. Renderers must leave retired ids out of navigation entirely —
   * guarded in nav.test.ts.
   *
   * The entry stays in the table rather than being deleted because retirement is
   * per-renderer: `mobile` may still serve the surface standalone, and this is
   * the one place that records which path that is.
   */
  retired?: boolean;
  /**
   * The capability an operator must hold to be OFFERED this route.
   *
   * This is a discoverability gate, not an access gate. The surface itself
   * still asserts its own capability (`assertCapability` fails closed); this
   * field exists so a renderer — the command palette, the rail — does not
   * advertise a destination the operator cannot use. Before it existed, every
   * palette entry declared `read`, the console entry ticket every internal
   * operator holds, so the filter ran against a constant and could only ever
   * hide everything or nothing.
   *
   * REQUIRED. It used to be optional, defaulting to `read` — and #261 found
   * what that cost: 26 of 30 routes declared nothing, so "unspecified" quietly
   * meant "everyone who can reach the console". A default that is also the
   * weakest capability in the system is not a safe default; it is an opt-out
   * nobody has to take deliberately.
   *
   * Making it required means adding a route asks the question. The answer is
   * usually the surface the route belongs to (`crm`, `support`, `platform`);
   * where the route exists only to perform one high-blast-radius act, name the
   * verb instead, because offering a page whose only purpose the operator
   * cannot carry out is a dead end — `platform.announcements` is `mass-send`
   * for exactly that reason.
   *
   * Lives here beside `pending`/`retired` because it is a property of route
   * IDENTITY. A lookup table in one app would drift from this one, which is
   * the whole reason this package exists.
   */
  capability: Capability;
}

// `as const satisfies Record<string, RouteEntry>` keeps the literal keys (so
// `RouteId` is a real union, e.g. "kora.foods") while still checking every
// entry against the RouteEntry shape. Annotating the table itself as
// `Record<string, RouteEntry>` would widen every key to `string` and collapse
// `RouteId` to `string`, making the exported type meaningless.
export const ROUTES = {
  // NOT pending: the console serves this page — a Foods/Users/Needs
  // attention/AI resolution snapshot assembled entirely from routes that
  // already existed (`kora.foods`, `kora.users`, `platform.inbox`, and the
  // `/v1/kora/ai-metrics` federation). This route was already one of
  // `koraNav`'s entries when it was pending, just linking nowhere — so
  // un-pending it did not itself change the rail's entry count. The next
  // route below (`kora.aiMetrics`) is the one that takes `koraNav` from 3 to
  // 4; `estate.ts`'s Kora `entries` count is derived from `koraNav.length`,
  // so it tracks the rail automatically either way.
  "kora.overview": { web: "/admin/apps/kora", mobile: "/kora", exact: true, capability: "platform" },
  // NOT pending: the console serves this page — the full surface behind the
  // overview's three AI-resolution tiles (§B of the kora-overview part 2
  // plan). No `web` path: apps/web never served this, `/v1/kora/ai-metrics`
  // postdates it. `koraNav` gains a fourth entry for this route; `estate.ts`'s
  // Kora `entries` count is derived from `koraNav.length`, so it updates with
  // the rail rather than needing a second hand-maintained number.
  "kora.aiMetrics": { mobile: "/kora/ai-metrics", capability: "platform" },
  // NOT pending: the console serves this page. The FIRST product-rail surface
  // the console owns — every route it served before this was on the platform
  // rail.
  //
  // No `console` path: `consolePath` falls back to `mobile`, and the two agree
  // at /kora/foods. `web` stays recorded because apps/web still serves its own
  // version until that app is retired.
  "kora.foods": { web: "/admin/apps/kora/foods", mobile: "/kora/foods", capability: "platform" },
  // RETIRED, not pending (#139). Kora's audit trail is one source in the
  // console's estate-wide `platform.auditLog`, and there is no Kora-scoped audit
  // page coming to the console — `pending` would promise one. `/admin/apps/kora/audit`
  // is a redirect to /platform/audit-log?source=kora now; the `web` path stays
  // recorded because it is the one place that says where the capability used to
  // live, exactly as `platform.supportAnalytics` does after #133.
  //
  // `mobile` also stays: retirement is per-renderer, and expo-router still
  // serves that screen standalone.
  "kora.audit": { web: "/admin/apps/kora/audit", mobile: "/kora/audit", retired: true, capability: "platform" },
  // RETIRED, not pending — the same call #139 made for `kora.audit`, for the
  // same reason and with more evidence behind it. §8.5: implementing
  // `/admin/inbox` does not earn a product rail entry, it makes the product a
  // source in a surface that already exists.
  //
  // This is not a plan, it is already true on Kora's side: its `/admin/inbox`
  // MERGES feedback with unresolved-food items into one queue (verified in
  // tesserix/kora#474). So a Kora "Feedback" page would be a second door onto
  // rows Kora already serves through the estate queue — and an operator would
  // have to know which door records the answer.
  //
  // `pending` would promise a Kora-scoped feedback page in the console. None is
  // coming; the estate Inbox (#356) is where these land. `web` and `mobile`
  // stay recorded for the same reasons they do on `kora.audit`.
  "kora.feedback": { web: "/admin/apps/kora/feedback", mobile: "/kora/feedback", retired: true, capability: "platform" },
  // Left at the `read` default deliberately: the list is readable, and whether
  // the surface also carries user deletion (`hard-delete`) is undecided until
  // it is built — staff scoping is blocked on #134.
  // NOT pending: the console serves this page. Read-only — Kora's DELETE
  // exists but the console does not offer it, pending the verb-capability
  // decision that mark8ly#288 (tenant purge) also waits on. See the page.
  //
  // Left at the `read` default deliberately, as the previous comment said:
  // the list is readable, and whether this surface ever carries deletion
  // (`hard-delete`) is that same open decision.
  "kora.users": { web: "/admin/apps/kora/users", mobile: "/kora/users", capability: "platform" },

  // Mark8ly's product rail — one route, the CSM migration fast-path review
  // queue. `migrationFastPath` renders mark8ly's own vocabulary: it is the
  // literal inbox `kind` (`migration_fast_path`) that
  // `inbox_action_migration.go` implements, and a console-side synonym here
  // would mean the id in the rail and the id on the wire no longer match.
  //
  // WHY THIS IS A PRODUCT-RAIL ROUTE AND NOT PART OF THE ESTATE INBOX. The
  // rule in §2 — and §8.5, and the two retirements it already produced —
  // pushes a queue onto the platform rail: `kora.feedback` is `retired`
  // precisely because implementing `/admin/inbox` makes a product a SOURCE in
  // a surface that already exists rather than earning a rail entry. This is
  // the deliberate exception, not an oversight of that rule. Mark8ly's
  // migration offer is its own commercial product and nothing else in the
  // estate has one; the review STEP presupposes mark8ly's migration model in
  // a way "what is waiting on a human" does not, so the two products' rows
  // could not sit in one table without the columns meaning different things.
  // A reviewer who knows the Kora precedent should read this paragraph before
  // concluding it is the same mistake.
  //
  // PENDING STAYS, DELIBERATELY. `pending` means "the console has not built
  // this page", and clearing it before the page exists points the rail and
  // the palette at a 404 — the flag comes off per-surface as each page lands,
  // and this one has not. The endpoint being live upstream is a
  // PRECONDITION for building the page, not a substitute for it: mark8ly's
  // `GET /api/v1/platform/admin/inbox` and `POST
  // /api/v1/platform/admin/inbox/migration_fast_path/:id/actions/:actionId`
  // both answer 401 in production (against a control of 404 for an invented
  // path), so the surface is buildable. Building it is #406's follow-up, not
  // #406. This is a hold, not an omission.
  //
  // No `web` and no `mobile`: neither app ever served this surface — apps/web
  // ships mark8ly's eight-entry rail without it, and expo-router has no
  // screen for it. A placeholder path in either field would claim a
  // predecessor that does not exist (see RouteEntry.web).
  //
  // `platform` rather than a narrower verb: reviewing a fast-path request is
  // an estate-operator read plus an action on someone else's product, and
  // CAPABILITIES has no `approve`. The action itself must assert its own
  // capability when the page is built, exactly as `platform.leadTemplates`
  // records for test-sends.
  "mark8ly.migrationFastPath": {
    console: "/mark8ly/migration-fast-path",
    pending: true,
    capability: "platform",
  },

  // Platform rail. The console owns their identity so the rail can be built
  // from one source; none of the surfaces is built here yet.
  // Served at the console root: the estate map plus the internal tools
  // directory already live there, and it is the only way back to the
  // console home once a rail link has navigated away from it.
  "platform.dashboard": { web: "/admin/dashboard", mobile: "/platform", console: "/", capability: "platform" },
  // Managing the internal tools directory (#318 follow-up). `platform`
  // because every write on /v1/platform/tools requires it — the two READS
  // moved to `read` so the home page's directory renders for everyone, and
  // this surface is the other half of that split: one place where the write
  // affordances live, so the UI's gate and the API's cannot drift.
  "platform.tools": { console: "/platform/tools", capability: "platform" },
  "platform.apps": { web: "/admin/apps", mobile: "/platform/apps", exact: true, pending: true, capability: "platform" },
  // First surface built in the console — hence no `pending`. Served at
  // /platform/tickets there; apps/web keeps /admin/platform-tickets until it
  // is deleted.
  "platform.tickets": { web: "/admin/platform-tickets", mobile: "/platform/tickets", capability: "support" },
  // Retired on web and in the console (#133): the eight KPIs and the three
  // breakdowns are a tab on `platform.tickets` now, and `/admin/analytics/support`
  // is a redirect to it. Not `pending` — nothing is coming.
  //
  // `mobile` is corrected here from "/platform/support-analytics", which no
  // renderer ever served: expo-router puts the screen at
  // apps/mobile/app/platform/analytics-support.tsx, i.e.
  // "/platform/analytics-support", and (tabs)/platform.tsx links exactly that.
  // Recording the wrong path is the drift this package exists to prevent, and
  // it survived because nothing consumes this id's mobile path yet.
  "platform.supportAnalytics": { web: "/admin/analytics/support", mobile: "/platform/analytics-support", retired: true, capability: "support" },
  // A live-chat console is not a reading surface: it is opened to reply, and
  // `respond` is documented as "reply to tickets and chats". `platform.tickets`
  // is deliberately NOT `respond` — the queue is genuinely readable, and
  // replying from it asserts its own capability at the action.
  "platform.liveChat": { web: "/admin/support/live-chat", mobile: "/platform/live-chat", pending: true, capability: "respond" },
  // `mass-send` names announcements explicitly, and they are irrevocable once
  // sent. Offering the composer to someone who cannot send is a dead end.
  "platform.announcements": { web: "/admin/platform-announcements", mobile: "/platform/announcements", pending: true, capability: "mass-send" },
  // Cross-product identity lookup (#134): find one staff member or operator
  // across the estate, from one box, with an audit row per use.
  //
  // The id is new because there was none — seventeen `platform.*` entries and
  // not one of them named this, while `apps/web` has served `/admin/search`
  // the whole time with no rail entry anywhere in `nav-config.ts`. That is the
  // issue's complaint in one line: capability that exists and nobody can find.
  // Naming it is the fix, whatever renders it later.
  //
  // `identityLookup`, not `identity`: "Platform · Identity" reads as identity
  // PROVIDER configuration — Zitadel orgs, IdP settings — which is a different
  // surface someone will eventually want. The id says what it does.
  //
  // `pending`, and this is not a formality. The console cannot look up staff
  // at all today: `platform-auth` holds an OIDC *login* client (verifyIdToken,
  // extractRoles, isInternal), which verifies whoever is signing in; there is
  // no Zitadel Management API client anywhere in this repo, so nothing can
  // ENUMERATE users. Verifying the person in front of you and listing people
  // are different grants and the console holds only the first. The flag comes
  // off when the credential and the surface exist, not before.
  //
  // `web` points at `apps/web`'s existing `/admin/search`, which is where the
  // capability lives today. That is a record of where the surface currently
  // is, NOT a link target: `pending` means renderers link nowhere, including
  // there. `/admin/search` is scheduled for retirement, and its end-user
  // sources — storefront customers and marketing leads, returned today with no
  // opt-in and no audit row — are exactly what must not be carried over.
  //
  // CAPABILITY: left at the `read` default, deliberately.
  //
  // Not because lookup is trivial, but because none of the twelve
  // capabilities describes it, and CAPABILITIES is a closed contract with
  // Zitadel — adding a thirteenth is a role change on the `Platform Console`
  // project, not an edit here. Of the seven risk verbs, every one names a
  // MUTATION: respond, rotate-credentials, adjust-balance, execute-refund,
  // mass-send, hard-delete, publish-catalog. Borrowing one to mean "may look
  // people up" would be a lie twice over — it would hide the lookup from
  // support operators who should have it, and it would imply the surface can
  // do the thing the capability actually names.
  //
  // The tempting one is `hard-delete`, because it is the other people-shaped
  // surface (`platform.gdprQueue`). It is wrong: erasure and lookup are not
  // the same blast radius, and gating the estate's find-a-person box on the
  // right to delete users would leave the people who need it most unable to
  // see it.
  //
  // On "must be audited on every use": auditing is an OBLIGATION on the
  // surface, not a capability held by an operator. This field gates
  // DISCOVERABILITY — whether the palette and the rail offer the destination —
  // and no capability value would cause an audit row to be written. The audit
  // write is the surface's own job, tracked in #134 against audit-service, and
  // deliberately not guessed at here. Read-only, offered to every internal
  // operator, and accountable for every query is a coherent position; it is
  // the same one a hospital takes on its own access logs.
  //
  // Revisit if the surface ever grows an action beyond reading, per the
  // `capability` doc above: where a route's real capability is undecided
  // because the surface is pending, take the default and say so.
  "platform.identityLookup": { web: "/admin/search", mobile: "/platform/identity-lookup", pending: true, capability: "platform" },

  // The estate's audit timeline (#139): every product's audit trail plus the
  // console's own operator log, in one surface, newest first.
  //
  // NO `web` PATH, and that is the entry's most interesting field. apps/web
  // never served an estate-wide audit surface — it served three product-scoped
  // ones (`/admin/apps/mark8ly/audit-logs`, `/admin/apps/kora/audit`,
  // `/admin/apps/homechef/audit-logs`), which are three different
  // architectures rather than three copies of one page. Recording any single
  // one of them here would say "this is where the capability lives today" about
  // a third of it. `kora.audit` already records its own; the other two have no
  // route id, and inventing ids for pages Task 3 deletes would be worse. See
  // `RouteEntry.web`.
  //
  // NOT `pending`: the console serves this page. It is the second surface built
  // here after tickets.
  //
  // Governance, not Operate, and the placement is an argument rather than a
  // filing decision. `platform.identityLookup` went to Operate deliberately —
  // it is reached mid-ticket, as part of answering someone. An audit log is not
  // reached mid-anything: it is opened to answer "who did this, and when",
  // which is the same question the GDPR queue and break-glass exist to make
  // answerable. It belongs beside them.
  //
  // CAPABILITY: left at the `read` default, deliberately, and for the same
  // reason as the identity lookup. Every capability above `read` names a
  // mutation (respond, rotate-credentials, adjust-balance, execute-refund,
  // mass-send, hard-delete) and this surface performs none of them. The
  // temptation is to reach for one anyway on the grounds that an audit log is
  // sensitive — but an audit log only the highest-privileged operators can open
  // is an audit log nobody opens, and an unread accountability record is not
  // accountability. Reading it is also itself audited (the console's own
  // `console_audit_log` is one of the sources on this very page), which is the
  // control that actually applies here; no capability value can express it.
  "platform.auditLog": { mobile: "/platform/audit-log", capability: "platform" },

  // The secrets inventory. `platform` because reading the estate's secret
  // NAMES and their reader state is a governance read, not a mutation — the
  // credential verb gates writing a value, not seeing that one exists.
  //
  // No `web` path: apps/web never served this. Its predecessor is
  // secret-service's own UI, a separate application being retired, which is
  // not what this field records.
  //
  // NOT pending: the console serves this page, and the backend it talks to
  // is real. The chart cutover (tesserix-k8s#808/#809) redeployed
  // `secrets-api` against Zitadel; verified live in production, the
  // inventory lists 602 real secrets across OpenBao and GSM and detail pages
  // render live version history. It now has a sidebar entry in `nav.ts`,
  // beside Break-glass — a window that used to justify leaving it unlisted
  // (the backend was pinned pre-cutover) has closed, and there is no longer
  // a reason to route operators through ⌘K instead of the rail.
  "platform.secrets": { mobile: "/platform/secrets", capability: "platform" },

  // The review queue for access-change proposals raised against
  // `tesserix-k8s` — `secrets-api`'s `GET /api/reviews`.
  //
  // `platform`, not `rotate-credentials` — see `platform.secrets`'s comment
  // above for what this field actually gates: DISCOVERY, not access. This
  // `capability` only drives ⌘K palette visibility and nav filtering
  // (`lib/search.ts`'s `routeEntries`) — this console has no per-route view
  // enforcement on the render path (`middleware.ts` checks only session
  // validity and `isInternal(...)`). The real read gate lives entirely in
  // `secrets-api`: `GET /api/reviews` and `GET /api/reviews/:number` sit
  // behind the operator's own `RequireCapability(CapPlatform)` token check
  // (`secrets-api/internal/api/server.go`'s `authed` group), independent of
  // whatever this field says.
  //
  // Given that, the reason this ID is offered under `platform` rather than
  // `rotate-credentials` is still a two-tier design choice, just one about
  // what gets DISCOVERED, not what gets ALLOWED: if the palette only
  // surfaced this route to operators holding `rotate-credentials`, an
  // operator who could see a proposal (per the real, server-side gate) but
  // not act on it would have no way to find the queue at all. Discovery has
  // to be at least as wide as the real gate, or the palette misleads by
  // omission.
  //
  // Listed, like `platform.secrets`, now that the chart cutover
  // (tesserix-k8s#808/#809) has redeployed `secrets-api` against Zitadel and
  // it is verified live — the reviews queue returns a genuine empty state
  // from GitHub, not a "not configured" error. It also carries its own
  // rail-placement reasoning in `nav.ts` beyond just "the backend works
  // now": an approver needs to find someone else's proposal proactively,
  // which reaching the queue only from the secret you just changed does not
  // offer.
  //
  // No `web` predecessor, matching `platform.secrets`.
  //
  // The detail route (`/platform/secrets/reviews/[number]`) gets no id of its
  // own — detail routes are not registered in this console, matching
  // `secrets/[...path]` above.
  "platform.secretsReviews": { mobile: "/platform/secrets/reviews", capability: "platform" },

  // Creating a secret — the route the write form's create mode never had.
  // `[...path]/page.tsx` turns a 404 into `notFound()`, so a path holding
  // nothing has no detail page to offer a create from; this is the way in,
  // and the inventory's header action is the way to it.
  //
  // `platform`, not `rotate-credentials`, and NOT because the page is
  // harmless — the page itself gates on `platform` AND `rotate-credentials`
  // together and refuses to draw the form without both, because secrets-api
  // refuses the write without both. This field is DISCOVERY, and discovery
  // has to be at least as wide as the real gate or the palette misleads by
  // omission: an operator who can reach the surface but not complete the
  // write should find it and read why, not fail to find it and conclude the
  // console cannot create secrets. Same reasoning as `platform.secrets` and
  // `platform.secretsReviews` above, where it is written out in full.
  //
  // NO nav entry, deliberately, and here that is a statement rather than a
  // leftover: the rail lists SURFACES, and a create action is not one.
  // Operators arrive from the inventory's header, which is where this
  // console puts page actions.
  //
  // No `web` predecessor, matching the two secrets routes above.
  "platform.newSecret": { mobile: "/platform/secrets/new", capability: "platform" },

  // Everything waiting on a human, across every product implementing §3.2,
  // from platform-api's inbox module (#352).
  //
  // On the PLATFORM rail, not any product's, and §8.5 is explicit about why:
  // implementing /admin/inbox does not earn a product a rail entry, it makes
  // that product a source in a surface that already exists. This is that
  // surface — the same call #139 made for the audit trail, and the reason
  // `kora.feedback` above is `retired` rather than `pending`.
  //
  // `platform`, not a verb capability. Reading a queue changes nothing:
  // §8.3's action execution exists on no product yet, and when it does it will
  // be its own route with its own decision — the authority to see that work is
  // waiting is not the authority to do it.
  //
  // No `web` predecessor. apps/web never had an estate-wide queue; each
  // product's items were only ever visible on that product's own pages, which
  // is the fragmentation this surface exists to end.
  "platform.inbox": { mobile: "/platform/inbox", capability: "platform" },

  // §8.2's two reads — recurring plans and expiring trials — from
  // platform-api's billing module (#358).
  //
  // `billing`, and this is the FIRST route in the console to use it.
  // platform-auth's capabilities.ts has carried the capability since the
  // vocabulary was written, marked RESERVED with the note that "the console
  // has no billing surface today (0 of 28 routes)". That reservation ends
  // here, and that note is updated.
  //
  // NOT `platform`, which every other estate read uses. §8.2 exists to make a
  // product legible as a BUSINESS, and revenue is the one surface the
  // capability vocabulary already drew a line for — using `platform` would
  // have made that line decorative.
  //
  // The limitation worth stating: §7 records that capabilities are
  // estate-wide, not per-product, so a grant of `billing` opens EVERY
  // product's revenue rather than a chosen one.
  //
  // No `web` predecessor. apps/web never had an estate billing surface — each
  // product's subscriptions were only ever visible inside that product.
  "platform.billing": { mobile: "/platform/billing", capability: "billing" },

  // The plan catalog's read-only console surface, from
  // tesserix-home#326/#380/#385/#386 — 42 lookup keys, 78 amounts, 3 plans,
  // published per Stripe mode, plus the nightly parity check that gates
  // #327's Stripe write-key revocation.
  //
  // A CHILD of `platform.billing`, not a sibling on the rail — same reasoning
  // `platform.crmImport` recorded for `platform.crm`: this is a second door
  // onto data the Billing page already introduces, reached from a link on
  // that page rather than from its own rail entry. NOT added to `nav.ts` for
  // that reason.
  //
  // `billing`, matching its parent: the catalog and the parity evidence
  // behind #327's revocation are exactly the revenue-adjacent surface that
  // capability exists to gate, and a reader who cannot see subscriptions has
  // no business seeing the catalog they are billed from either.
  //
  // No `web`: apps/web never had a catalog surface — the catalog itself is
  // console-native, versioned in tesserix-home's own Postgres since #380.
  //
  // NOT `pending`: this id's page is what this task builds.
  "platform.billingCatalog": {
    mobile: "/platform/billing/catalog",
    capability: "billing",
  },

  // Every product's tenants in one shape, from platform-api's tenants module
  // (#342), which federates §3.4's /admin/entities/tenants.
  //
  // No `web` predecessor is recorded, and that is not an omission. apps/web's
  // /admin/tenants is a DIFFERENT surface — it reads and WRITES mark8ly's
  // tenants table directly over the cross-database grant (#210), which is the
  // thing this replaces rather than the thing it succeeds. Recording it as a
  // predecessor would suggest the two are the same page under two transports,
  // and would make "fall back to web" look like a rollback rather than a
  // return to the write path being removed.
  //
  // `platform`, not `billing`: knowing a tenant exists is an Operate concern.
  // Only what they pay is a Revenue one.
  "platform.tenants": { mobile: "/platform/tenants", capability: "platform" },

  // Where signups stall, read from the product that owns the funnel (#404).
  //
  // ON THE PLATFORM RAIL, not mark8ly's, and that is the whole filing
  // decision. §2's rule: a surface belongs here when the operator's question
  // spans products, and "where do signups stall" is a question every product
  // with onboarding has. mark8ly is the first implementer, not the only
  // conceivable one — which is exactly why platform-api's route is
  // `/v1/onboarding/funnel?source=mark8ly` and not a mark8ly-named one, while
  // Kora's food-resolution accuracy (no estate-generic equivalent at all) does
  // carry its product's name. Contrast `mark8ly.migrationFastPath`, which
  // presupposes mark8ly's migration model and could not share a table with
  // another product's rows.
  //
  // Console-only, like `platform.tools`: apps/web's mark8ly rail has tenant
  // and onboarding surfaces but no estate funnel, and mobile never served
  // one. There is no predecessor to record and nothing being retired.
  //
  // NOT `pending`: the console serves this page. `platform`, not `billing`,
  // matching the gate platform-api puts on the route — a funnel that ends in
  // a paid conversion is still an operational question, not a revenue surface.
  "platform.onboarding": { console: "/platform/onboarding", capability: "platform" },

  // The rows behind the funnel's counts (#448). A SEPARATE route rather than a
  // section of `platform.onboarding`, and the split is by question: the funnel
  // answers "where do merchants stall", this answers "which merchant do I
  // call". Different audiences, and different working shapes — one is a
  // glance, the other is a queue with filters and paging.
  //
  // It is also where the PII boundary falls. Every row is a merchant's email
  // address and no funnel tile is one, so the page most people open carries
  // none. A route id makes that boundary a thing the estate can see, rather
  // than a `?view=` on a surface whose id says nothing about it.
  //
  // NOT in `platformNav`, deliberately, and this is the one entry in the table
  // that is reached only from another page. A rail item would advertise the
  // list as a peer of the funnel, when it is the funnel's detail — and would
  // put the estate's one PII queue one click from every operator's landing
  // page. `platform.onboarding` is not `exact`, so this path still highlights
  // the Onboarding rail entry while an operator is here.
  //
  // Same capability as the funnel: platform-api gates both routes on
  // `platform`. That the rows carry PII is not a second capability — the
  // console has no verb capability for reading it, and inventing one here
  // would gate a surface on something no operator holds.
  "platform.onboardingSessions": {
    console: "/platform/onboarding/sessions",
    capability: "platform",
  },

  // The AI path's spend, token usage and guardrail activity, sourced from the
  // agentgateway data plane rather than from any one product. No `web`: apps/web
  // never had this surface — the gateway postdates it.
  //
  // Capability `platform` rather than something narrower: this is a read-only
  // ledger view, and the operators who answer "why did Kora's bill move" are the
  // same ones who read the audit log.
  "platform.aiUsage": { mobile: "/platform/ai-usage", capability: "platform" },

  "platform.uptime": { web: "/admin/uptime", mobile: "/platform/uptime", pending: true, capability: "platform" },
  // The estate health page. NOT `pending`: the console serves this surface at
  // /platform/health. It is reached from the header health indicator rather
  // than from the rail — the rail's Health group was deleted as dead
  // placeholders (see nav.ts) — and the `web` path stays recorded because
  // apps/web still serves its own.
  "platform.serviceHealth": { web: "/admin/health", mobile: "/platform/health", console: "/platform/health", capability: "platform" },
  "platform.observability": { web: "/admin/observability", mobile: "/platform/observability", pending: true, capability: "platform" },
  "platform.databases": { web: "/admin/databases", mobile: "/platform/databases", pending: true, capability: "platform" },
  // Left at `read`: none of CAPABILITIES covers DNS mutation, and inventing a
  // mapping onto one that nearly fits would be worse than the default.
  "platform.customDomains": { web: "/admin/custom-domains", mobile: "/platform/custom-domains", pending: true, capability: "platform" },
  // Left at `read`: the outbox is a log. Whether it also offers a re-send
  // (which would be `mass-send`) is undecided until the surface is built.
  //
  // NOT `pending`: the console serves this page at /platform/outbox, reading
  // the platform API's federated `GET /v1/outbox` (task 3 of the v1 outbox
  // federation plan). `pending` meant "the console has not kept this
  // promise" — it now has.
  "platform.outbox": { web: "/admin/outbox", mobile: "/platform/outbox", console: "/platform/outbox", capability: "platform" },
  "platform.notificationLog": { web: "/admin/notifications/log", mobile: "/platform/notifications", pending: true, capability: "platform" },
  // Left at `read`, though `mass-send` names "template test-sends": authoring a
  // template is not sending one, and the test-send action must assert
  // `mass-send` itself rather than the whole page being gated on it.
  "platform.leadTemplates": { web: "/admin/notifications/lead-templates", mobile: "/platform/lead-templates", pending: true, capability: "crm" },
  // The erasure queue exists to execute irreversible deletions — `hard-delete`
  // names leads, users and tenant archival.
  "platform.gdprQueue": { web: "/admin/erasure-requests", mobile: "/platform/gdpr", pending: true, capability: "hard-delete" },
  // The unambiguous one: `rotate-credentials` names break-glass rotation
  // outright, and this is the highest-blast-radius surface in the estate.
  "platform.breakGlass": { web: "/admin/break-glass", mobile: "/platform/break-glass", pending: true, capability: "rotate-credentials" },
  // Left at `read` despite `rotate-credentials` naming "Stripe settings":
  // platform settings is a container whose contents are not yet decided, and
  // gating the whole page on credential rotation would hide benign settings
  // from every operator who cannot rotate keys. Gate the Stripe section, not
  // the route, once the surface exists.
  "platform.settings": { web: "/admin/settings", mobile: "/platform/settings", pending: true, capability: "platform" },

  // The CRM: a sales queue for inbound leads, replacing apps/web's
  // Mark8ly-scoped leads page with an estate-native surface.
  //
  // `web` records `/admin/apps/mark8ly/leads` as the predecessor. That page is
  // a genuine ancestor of this queue — it is the thing being replaced, not
  // mirrored — and recording it is consistent with `platform.tickets`, which
  // records `/admin/platform-tickets` as its own `web` path even though that
  // page is already gone. `web` is a record of where a capability lived, not
  // a link; the no-linking rule lives on `isPending` and binds renderers, not
  // this field. See RouteEntry.web.
  //
  // NOT `pending`: the queue is this task's reason for existing, and later
  // tasks build the surface this id points at.
  "platform.crm": { web: "/admin/apps/mark8ly/leads", mobile: "/platform/crm", capability: "crm" },
  // No `web`: the import flow was never a distinct page in apps/web — it
  // lived inside the leads page itself, under `platform.crm`. There is no
  // separate predecessor to record.
  //
  // NOT `pending`: Task 8 builds the CSV import flow this id points at.
  "platform.crmImport": {
    mobile: "/platform/crm/import",
    capability: "crm",
  },
  // No `web`: a suppression list never existed in apps/web at all. This is
  // genuinely console-native, not a migrated surface.
  //
  // NOT `pending`: Task 7 builds the do-not-contact list this id points at.
  "platform.crmSuppressions": {
    mobile: "/platform/crm/suppressions",
    capability: "crm",
  },
  // CRM outreach copy: the DM/email templates an operator authors, renders per
  // lead in the composer, and archives. No `web` — nothing like it existed in
  // apps/web.
  //
  // ══ NOT `platform.leadTemplates`, AND THE NAMES ARE CLOSE ENOUGH TO MATTER ══
  //
  // `platform.leadTemplates` (above) is a DIFFERENT SURFACE that already
  // exists. It is the versioned MARKETING EMAIL registry the platform API
  // serves at `GET /lead-templates` — `htmlBody`/`textBody`/`version`/`status`,
  // plus a `POST /lead-templates/:key/test-send`, which is why its comment
  // names `mass-send`. `apps/mobile/app/platform/lead-templates.tsx` renders it
  // today.
  //
  // THIS id is CRM outreach copy: operator-authored, `crm_*`-scoped, and with
  // NO send path of any kind — an operator copies the rendered text and pastes
  // it into Instagram by hand. Reusing the other id would give one route id two
  // meanings across two renderers, and each renderer would have to guess which
  // it had been handed. Two surfaces, two ids.
  //
  // `mass-send` is therefore not asserted here and must not be added: nothing
  // on this surface sends. `crm`, like every other CRM route.
  //
  // NOT `pending`: this plan's Task 4 builds the surface this id points at.
  "platform.crmTemplates": {
    mobile: "/platform/crm/templates",
    capability: "crm",
  },
  // No `web`: an organisation browse surface never existed in apps/web. The
  // old leads page was a single flat list of lead rows with no concept of a
  // business distinct from the person, so there is no predecessor path to
  // record here.
  //
  // NOT `pending`: this plan's Task 3 builds the surface this id points at.
  "platform.crmOrganisations": {
    mobile: "/platform/crm/organisations",
    capability: "crm",
  },
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

/**
 * Path in `apps/web`, or `undefined` for a console-native surface — see
 * `RouteEntry.web`. Callers must treat the gap as "apps/web never had this",
 * not as "unknown route": an unknown id throws instead.
 */
export function webPath(id: RouteId): string | undefined {
  return getRoute(id).web;
}

export function mobilePath(id: RouteId): string | undefined {
  return getRoute(id).mobile;
}

/**
 * Path in the console, falling back to the mobile path.
 *
 * The console does NOT serve `apps/web`'s `/admin/*` paths. Those belong to an
 * app being retired, and `/admin/...` on a host that is itself the admin reads
 * as a leftover — which it would be.
 *
 * A route must set at least one of `console`/`mobile`, or it has no console
 * path at all and this throws — the same fail-closed shape `getRoute` already
 * uses for an unknown id, rather than silently returning `undefined` from a
 * function whose signature promises `string`.
 */
export function consolePath(id: RouteId): string {
  const entry = getRoute(id);
  const path = entry.console ?? entry.mobile;
  if (path === undefined) {
    throw new Error(`Route "${id}" has neither a console nor a mobile path`);
  }
  return path;
}

/**
 * True while the surface has no page in the console. Renderers must show these
 * as pending rather than linking them anywhere — see `RouteEntry.pending`.
 */
export function isPending(id: RouteId): boolean {
  return getRoute(id).pending === true;
}

/**
 * True once the surface has been folded into another route — see
 * `RouteEntry.retired`. Renderers must not offer it as a destination.
 */
export function isRetired(id: RouteId): boolean {
  return getRoute(id).retired === true;
}

/**
 * The capability required to be offered this route — see
 * `RouteEntry.capability`.
 *
 * An accessor rather than exported table access, for the same reason
 * `isPending` is one: callers get the default applied for them, so a route
 * without a declaration can never be read as "no capability required" (i.e.
 * `undefined`, which a `Set.has` check would silently fail on).
 *
 * The default is the literal value of `CONSOLE_ENTRY_CAPABILITY` in
 * platform-auth. It is written out rather than imported because importing it
 * would make this a runtime dependency — see the type-only import at the top of
 * this file. `capabilities.ts` treats these strings as immutable, so the
 * duplication cannot rot.
 */
export function routeCapability(id: RouteId): Capability {
  return getRoute(id).capability ?? "read";
}

/**
 * The path a route resolves to for one renderer, or `undefined` when that
 * renderer has no path for it.
 *
 * Extracted from `isRouteActive` rather than inlined twice, because
 * `isMostSpecificActiveRoute` compares target LENGTHS and so has to resolve
 * exactly the same string `isRouteActive` matched against. A second copy of
 * the `console ?? mobile` fallback would let the two drift, and the drift
 * would be silent: the comparison would still run, just against the wrong
 * string.
 */
function resolveTarget(
  id: RouteId,
  prefix: "web" | "mobile" | "console",
): string | undefined {
  const entry = getRoute(id);
  return prefix === "web"
    ? entry.web
    : prefix === "console"
      ? (entry.console ?? entry.mobile)
      : entry.mobile;
}

export function isRouteActive(
  currentPath: string,
  id: RouteId,
  prefix: "web" | "mobile" | "console",
): boolean {
  const entry = getRoute(id);
  const target = resolveTarget(id, prefix);
  // `web` and `mobile` are both optional (see RouteEntry), so a route can
  // have no path at all for a given renderer — a console-only surface like
  // `platform.tools` has no `mobile`, and a console-native one has no `web`.
  // Without this guard, `target` is `undefined` and the checks below fall
  // through to comparing against the literal string "undefined/" rather than
  // reporting "not active", which is the honest answer when there is no path
  // to be active against.
  if (target === undefined) return false;
  // Product roots are a strict prefix of their own children, so an exact
  // match is required or Overview stays highlighted on every nested route.
  if (entry.exact) return currentPath === target || currentPath === `${target}/`;
  // Match on segment boundaries, not bare string prefix: `startsWith(target)`
  // would also mark "/admin/apps/kora/foodsXYZ" active for "kora.foods",
  // since it merely shares a string prefix with the real nested route
  // "/admin/apps/kora/foods/...".
  return currentPath === target || currentPath.startsWith(`${target}/`);
}

/**
 * True when `id` is active for `currentPath` AND no other route in
 * `candidates` is active with a LONGER target — "most specific wins".
 *
 * Why this exists: `isRouteActive` matches on segment boundaries, so a route
 * whose target is a prefix of a sibling's is active on the sibling's pages
 * too. With both in one rail, two entries render as the current page at once
 * — `platform.secrets` (`/platform/secrets`) and `platform.secretsReviews`
 * (`/platform/secrets/reviews`) did exactly that on the reviews queue.
 *
 * WHY NOT `exact: true` on the parent, which fixes that one pair in a line:
 * `exact` would ALSO stop the parent highlighting on the pages that really
 * are its own — `/platform/secrets/new` and a secret's detail page
 * `/platform/secrets/<ns>/<app>/<name>` — where the rail should stay lit
 * because there is no other entry those pages belong to. `exact` is for a
 * product root whose children are owned by OTHER rail entries
 * (`kora.overview`); it is not a way to say "prefer my sibling", which is the
 * actual rule here. Hence a narrowing that asks what else is in the rail,
 * rather than a flag on the route.
 *
 * This narrows `isRouteActive`, it does not replace it: `exact` still applies
 * first, inside the delegated call.
 *
 * `candidates` is caller-supplied rather than read from `ROUTES`, because the
 * rule is about what a RAIL renders side by side. A route nested under
 * another that is not in the same rail (`platform.onboardingSessions`, which
 * is reached only from the funnel page) must not suppress the entry the
 * operator can actually see.
 */
export function isMostSpecificActiveRoute(
  currentPath: string,
  id: RouteId,
  candidates: readonly RouteId[],
  prefix: "web" | "mobile" | "console",
): boolean {
  if (!isRouteActive(currentPath, id, prefix)) return false;
  const target = resolveTarget(id, prefix);
  // Unreachable while `isRouteActive` returned true — it guards the same
  // `undefined` — but narrowing the type here beats a non-null assertion.
  if (target === undefined) return false;
  return !candidates.some((other) => {
    const otherTarget = resolveTarget(other, prefix);
    // STRICTLY longer, and that comparison is what excludes `id` itself —
    // there is no separate identity check, because length alone is the whole
    // rule. Relaxing this to `>=` would make every entry suppress itself (its
    // own target is never shorter than its own target) and also make two ids
    // resolving to the same path put each other out, so nothing would ever
    // highlight.
    if (otherTarget === undefined || otherTarget.length <= target.length) {
      return false;
    }
    return isRouteActive(currentPath, other, prefix);
  });
}
