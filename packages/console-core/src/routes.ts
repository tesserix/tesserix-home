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
  // Kora's IA lives here; its SURFACES do not exist in the console yet. Without
  // `pending` the rail links to in-app routes that are not there — five 404s.
  "kora.overview": { web: "/admin/apps/kora", mobile: "/kora", exact: true, pending: true, capability: "platform" },
  "kora.foods": { web: "/admin/apps/kora/foods", mobile: "/kora/foods", pending: true, capability: "platform" },
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
  "kora.feedback": { web: "/admin/apps/kora/feedback", mobile: "/kora/feedback", pending: true, capability: "platform" },
  // Left at the `read` default deliberately: the list is readable, and whether
  // the surface also carries user deletion (`hard-delete`) is undecided until
  // it is built — staff scoping is blocked on #134.
  "kora.users": { web: "/admin/apps/kora/users", mobile: "/kora/users", pending: true, capability: "platform" },

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
  // Not because lookup is trivial, but because none of the seven capabilities
  // describes it, and CAPABILITIES is a closed contract with Zitadel — adding
  // an eighth is a role change on the `Platform Console` project, not an edit
  // here. Of the six above `read`, every one names a MUTATION: respond,
  // rotate-credentials, adjust-balance, execute-refund, mass-send,
  // hard-delete. Borrowing one to mean "may look people up" would be a lie
  // twice over — it would hide the lookup from support operators who should
  // have it, and it would imply the surface can do the thing the capability
  // actually names.
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

  // The AI path's spend, token usage and guardrail activity, sourced from the
  // agentgateway data plane rather than from any one product. No `web`: apps/web
  // never had this surface — the gateway postdates it.
  //
  // Capability `platform` rather than something narrower: this is a read-only
  // ledger view, and the operators who answer "why did Kora's bill move" are the
  // same ones who read the audit log.
  "platform.aiUsage": { mobile: "/platform/ai-usage", capability: "platform" },

  "platform.uptime": { web: "/admin/uptime", mobile: "/platform/uptime", pending: true, capability: "platform" },
  // The estate health page, reached from the header indicator. `read`, NOT
  // `platform`: the indicator renders for every operator, and a link that
  // 403s the person who can see it is worse than no link. `pending` is gone
  // because the console surface now exists; the `web` path stays, since
  // apps/web still serves its own.
  "platform.serviceHealth": { web: "/admin/health", mobile: "/platform/health", console: "/platform/health", capability: "read" },
  "platform.observability": { web: "/admin/observability", mobile: "/platform/observability", pending: true, capability: "platform" },
  "platform.databases": { web: "/admin/databases", mobile: "/platform/databases", pending: true, capability: "platform" },
  // Left at `read`: none of CAPABILITIES covers DNS mutation, and inventing a
  // mapping onto one that nearly fits would be worse than the default.
  "platform.customDomains": { web: "/admin/custom-domains", mobile: "/platform/custom-domains", pending: true, capability: "platform" },
  // Left at `read`: the outbox is a log. Whether it also offers a re-send
  // (which would be `mass-send`) is undecided until the surface is built.
  "platform.outbox": { web: "/admin/outbox", mobile: "/platform/outbox", pending: true, capability: "platform" },
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
