# Admin Console Redesign — Design

> **Status**: Approved (design) | **Date**: 2026-08-14 | **Scope**: `tesserix-home` monorepo

## Problem

The Tesserix super-admin console (`apps/web/app/admin`, 72 pages, ~21.5k LOC of page
code) has two problems the operator feels daily:

1. **Information architecture.** The console is organised by *product → feature list*.
   The Platform rail is a flat 17-item list with no grouping. Product rails have wildly
   uneven depth — Fe3dr has ~25 surfaces across 7 collapsible groups, Kora has 5, and
   DevAI/Dwellm8 are an Overview plus links that navigate *out* of the product into
   platform-wide pages. Nothing in this structure serves the two jobs the operator
   actually comes to do: clear the things people are waiting on, and read the business.

2. **Visual consistency.** Each page invents its own table, filter bar, empty state, and
   page header. Shared layouts exist (`audit-logs-page-layout.tsx`,
   `product-overview-layout.tsx`, `subscriptions-page-layout.tsx`,
   `tenant-detail-layout.tsx`) but adoption was never finished — mark8ly's audit page is
   16 lines because it uses the shared layout; HomeChef's is 233 and Kora's is 148
   because they don't.

Secondary problems, all downstream of the two above:

- **Fat pages.** `mark8ly/leads/page.tsx` is 1437 lines; four more are 700–840;
  `settings/page.tsx` is 696. Project style guidance is 200–400 typical, 800 max.
- **Duplicated systems.** Two complete email-template stacks (see
  [Templates](#templates-consolidation)); three audit pages; four user surfaces.
- **Web ↔ mobile drift.** `apps/mobile` mirrors the console screen-for-screen (72
  screens) with its own kit and theme. Kora is absent from mobile entirely; mobile still
  carries `delivery-failures`, which web dissolved into Support tabs.
- **Marketing and admin share one app.** `apps/web` serves both the public marketing site
  and the console, so marketing drags admin chrome, TipTap, and Recharts into its bundle.

### What is NOT the problem

Data availability is not a constraint. `lib/db/*` (24 modules) already performs federated
reads directly against product databases, and `lib/metrics/*` already integrates
Prometheus, OpenCost, ClickHouse, and SendGrid. Every surface in this design is buildable
without Go service changes.

## Goals

- Reorganise the console around **jobs**, not products.
- Establish **one** set of console primitives and migrate every surface onto them.
- Add the capabilities the operator asked for: unified Inbox, real business dashboard,
  global entity search, saved views, and a Growth/CRM section.
- Keep the federated data layer intact — it is the accumulated value in this repo.
- Bring `apps/mobile` onto the same IA and tokens so the two stop drifting.

## Non-goals

- **No Go service changes.** Federated DB reads and existing product APIs are the ceiling.
  A queue that needs unreachable data is deferred, not backfilled with backend work.
- **No rewrite of `lib/db`, `lib/metrics`, `lib/auth`, or the API route layer.** These are
  extracted and reused as-is.
- **Centralized pricing & discounts (BACKLOG P)** stays parked. It touches live billing
  and needs its own design.
- **Tenant "view as" / read-only impersonation (BACKLOG F2)** stays out. It is a
  high-risk auth change, not a redesign task.
- **Feature flag explorer (BACKLOG H1)** is cut. See
  [Vendored tools](#rule-vendored-tools).

## Approach

### New app, no rewrite

`apps/console` is a new Next.js app. It is *not* a greenfield rebuild: the data,
metrics, and auth layers are extracted into shared packages and consumed unchanged. The
UI shell and page interiors — the tired part — are rebuilt on the new IA and kit.

Surfaces port product-by-product. `apps/web/app/admin` is deleted only when the last
surface has moved, at which point `apps/web` becomes marketing-only. This gives
greenfield freedom on the UI with an incremental cutover instead of a big-bang.

### Package boundary

```
packages/
  platform-data/     federated DB reads, metrics integrations, auth, product API clients
  console-core/      design tokens, IA definition, nav model, shared domain types
apps/
  console/           Next.js super-admin console  → platform-data + console-core
  mobile/            Expo super-admin app         → platform-data + console-core
  web/               marketing site only          → (neither)
```

| Package | Contains | Explicitly excludes |
|---|---|---|
| `platform-data` | `lib/db/*`, `lib/metrics/*`, `lib/auth/*`, `lib/api/*`, `lib/secrets/*`, `lib/templates/*`, the HomeChef signed-gateway client, **and the API response contracts mobile currently hand-maintains** | Anything React. Must remain importable from a Node context and unit-testable without a renderer. |
| `console-core` | Design tokens (colour, type scale, spacing, radii), the IA definition (sections, surfaces, routes), nav model and active-state logic, shared domain types, formatters | Any renderer-specific code. No `react-dom`, no `react-native`. Consumed by both `console` and `mobile`. |

Two constraints on `console-core`, both learned from how mobile drifted:

- **Icons ship as string keys, never component references.** Web resolves them through
  `lucide-react`, mobile through `lucide-react-native`; a shared array of component refs
  cannot exist.
- **Routes ship renderer-prefixed.** Web is `/admin/apps/<product>/…`, mobile is
  `/<product>/…`. `console-core` owns route *identity*; each app owns the prefix.

`console-core` alone does not close the drift. Mobile also hand-maintains ~786 LOC of API
response contracts (`platform-contracts.ts`, `mark8ly-contracts.ts`, `otto-contracts.ts`)
that duplicate web's `lib/db` types. That is a second, independent drift channel and it
belongs in `platform-data`.

`console-core` is the mechanism that stops web/mobile drift. The IA is *data* in a
package both apps read, not a structure each app hand-maintains. Getting this boundary
wrong in M0 means mobile drifts again immediately.

The existing `lib/products/nav-config.ts` is the seed for `console-core`'s nav model —
it is already React-free and unit-tested for exactly this reason — but its `RailContext`
/ `getSecondaryNav` product-rail concept is replaced by the section model below.

## Information architecture

Product becomes a **filter**, not a level of hierarchy. A product chip in the header
scopes every section.

### Landing (`/`) — Launchpad

One tile per internal app and tool: live status dot, deep links to its observability,
analytics, logs, repo, and runbook. The Inbox count and the Business headline ride on
it, so the first screen answers "anything waiting, are we healthy, where am I going".

Backed by the existing `apps` registry table (`db/migrations/0012_seed_apps_registry.sql`,
`0013_seed_devai_app.sql`, `0015_seed_kora_app.sql`) and the `/api/admin/apps` route.

The Launchpad absorbs the DevAI and Dwellm8 rails, which are already nothing but a
tile's worth of links.

### Sections

| Section | Surfaces | Absorbs from today |
|---|---|---|
| **Inbox** | Unified cross-product action queue | `platform-tickets`, `support/live-chat`, `homechef/approvals`, `homechef/fssai`, `erasure-requests`, `homechef/payout-queue`, `homechef/cancellations`, `homechef/messaging`, `outbox` (stuck rows), `mark8ly/onboarding` (stalled), stale secrets |
| **Business** | Revenue, subscriptions, dunning, cost-per-tenant margin, per-product P&L, support analytics | `dashboard`, `mark8ly/subscriptions`, `analytics/support`, `homechef/analytics` |
| **Growth** | Lead pipeline, waitlist, funnels, cohorts, sequences, **Templates**, campaigns, announcements | `mark8ly/leads`, `notifications/lead-templates`, `mark8ly/notifications/templates`, `platform-announcements`, `homechef/campaigns`, `homechef/winback`, `homechef/loyalty`, `homechef/promos`, `homechef/chef-rewards`, `mark8ly/onboarding` |
| **Operate** | Observability, **Health** (uptime + service health merged), Databases, Outbox, Custom domains, Notification log | `observability`, `uptime`, `health`, `databases`, `custom-domains`, `outbox`, `notifications/log` |
| **Directory** | Users, tenants, chefs, orders, foods, wallets, staff — searchable entity records | `search`, `users/[email]`, `mark8ly/tenants`, `homechef/chefs`, `homechef/users`, `homechef/orders`, `homechef/wallets`, `homechef/staff`, `kora/foods`, `kora/users`, `homechef/reviews`, `kora/feedback`, `homechef/meal-plans` |
| **Governance** | **Audit** (unified), **Secrets** (OpenBao inventory + rotation), API keys, GDPR history, Break-glass, Roles | `homechef/audit-logs`, `mark8ly/audit-logs`, `kora/audit`, `break-glass`, `erasure-requests` (history view) |
| **Settings** | Platform settings, apps registry, product settings, tax rates, payment gateway | `settings`, `apps`, `homechef/platform-settings`, `homechef/tax-rates`, `homechef/payment-gateway`, `homechef/payout-setup` |

The 17-item flat Platform rail disappears entirely. Every item lands in a section above.
`getActiveContext` / `getSecondaryNav` and the rail-switcher concept are removed.

### Products in the nav

Product-specific surfaces that genuinely do not generalise live under a **Products**
group at the bottom of the nav — not as peers of Inbox. A surface earns a place there
only if it fails to map into a section above; the default assumption is that it maps.

### Merges decided in this design

- **Uptime + Service health → one "Health" surface with two tabs.** An earlier draft of
  this design merged them into a single table. **Audit refuted that.** They do not answer
  the same question: `uptime` reads `tenant_uptime_probes` keyed by product + tenant +
  hostname, from *outside* the cluster through Cloudflare→Istio→app, covering tenant
  storefronts only. `health` reads Prometheus `kube_pod_*` keyed by namespace + workload,
  from *inside*, covering every workload including services with no storefront. One table
  would lose per-tenant latency (a pod can be Ready and still serve 500s), crash-loop
  visibility between 5-minute probes, the Knative `idle`-is-not-failure distinction, and
  all non-storefront services. Design: **one surface, one nav destination, two tabs**
  ("External / probes", "Internal / workloads") under a shared rollup header. Mobile has
  the same split and follows the same shape.
- **Three audit pages → one Audit surface** with a product filter. `mark8ly/audit-logs`
  already proves the shared layout works (16 lines); the other two are unported copies.
- **Four user surfaces → Directory** with one entity search across products.
- **Support disappears as a section.** Tickets and live chat are queues → Inbox. Support
  analytics is a number → Business. Nothing is left to hold a section.

## Templates consolidation

There are currently two complete template systems:

| | `lead-templates` | `email-templates` |
|---|---|---|
| Owner | Platform (`tesserix_admin` DB) | Product (cross-DB write into `mark8ly_platform_api`) |
| Purpose | tesserix-home sends directly to a lead or marketing audience | Product transactional sends via the product's own pipeline |
| UI | `/admin/notifications/lead-templates` + `[key]` | `/admin/apps/mark8ly/notifications/templates` + `[key]` |
| API | list, `[key]`, `[key]/test-send` | list, `[key]`, `[key]/test-send` |
| DB module | `lib/db/lead-templates.ts` (258 lines) | `lib/db/email-templates.ts` (161 lines) |

**The data split is correct and stays.** Product transactional templates must live in the
product's DB so the runtime send path has no dependency on tesserix-home. What is wrong
is that the split was expressed as *two of every screen*.

**Design:** one Templates workspace under Growth. A single list with a **Scope** column
(Platform / Mark8ly / Fe3dr / …), one editor, one preview, one test-send flow. Two
adapters behind a single `TemplateStore` interface:

```
interface TemplateStore {
  list(scope): Template[]
  get(scope, key): Template
  upsert(scope, key, draft): void   // product adapter also pings the product's
                                    // /internal/templates/refresh to evict its cache
  testSend(scope, key, to): void
}
```

HomeChef's campaign/promo/winback content is a third template-ish system and folds in
here during M2's Fe3dr batch.

## Console kit

Primitives live in `apps/console` (web renderer) and `apps/mobile` (native renderer),
both driven by tokens and types from `console-core`.

| Primitive | Responsibility |
|---|---|
| `PageHeader` | Title, description, breadcrumb, primary/secondary actions, product-scope chip |
| `DataTable` | Columns, sort, pagination, row selection, bulk actions, and the four states below |
| `FilterBar` | Typed filter descriptors → URL query params; feeds saved views |
| `StatTile` | Single metric with label, delta, trend sparkline, optional deep link |
| `DetailLayout` | Two-column entity detail: summary rail + tabbed body |
| `QueueList` | Inbox rows: what, which product, how long waiting, primary action |
| `EmptyState` / `ErrorState` / `LoadingState` | The three non-happy paths, one implementation each |

**Every list surface must use `DataTable`.** The current failure mode is that a shared
layout existed and pages opted out of it. Adoption is enforced by lint rule: no raw
`<table>` in `apps/console/app/**`.

`DataTable` owns empty, error, loading, and zero-results-after-filter as first-class
states — not as ad-hoc JSX per page. These are where per-page divergence currently
concentrates.

## New capabilities

### Inbox

A unified cross-product queue. Each source contributes items via a common shape:

```
interface InboxItem {
  id, kind, product, title, subtitle,
  waitingSince: Date,
  href: string,
  actions: InboxAction[]     // resolvable inline where safe
}
```

Sources (all reachable from `platform-data` today): platform tickets, live chat, chef
approvals, FSSAI review, GDPR erasure, payout release, cancellations, mediation, stuck
outbox rows, stalled onboarding, stale secrets (M4).

Counts appear in the nav. "Nothing waiting" is a real, designed state, not an empty
table.

### Business dashboard

Replaces the current mark8ly-flavoured dashboard (BACKLOG A6). Cross-product revenue,
subscriptions, dunning, churn, cost-per-tenant margin, per-product P&L. Built on
`lib/metrics/{revenue,margin,opencost,cost-proxy,tenant-metrics}.ts`, which already exist.

### Global entity search (⌘K)

Today's command palette finds page names. The rework finds *entities* — users, tenants,
orders, chefs, tickets, foods — via `lib/db/users-search.ts` and per-product lookups.
Search-first navigation is what makes IA depth stop mattering for lookups.

### Saved views

Any list can be filtered, sorted, and saved as a named view pinned to the nav (e.g.
"Fe3dr payouts pending > 3d"). Requires `FilterBar` to serialise to URL query params —
which is why filter state lives in the URL, not component state.

### Growth / CRM

- **Pipeline** — leads with stage, owner, next action; detail with activity timeline and
  email history. Built on existing `leads`, `lead_activities`, `email_events` tables
  (migrations 0005, 0007–0011).
- **Funnel** — waitlist → lead → onboarding started → tenant live → paying.
- **Cohorts** — retention/conversion per product (Fe3dr chef and customer funnels, Kora
  activation, Mark8ly onboarding drop-off), unified under Growth rather than buried in
  each product rail.
- **Sequences** — multi-step outbound email on `lead_templates` + SendGrid; enrol a lead,
  send steps on a schedule, stop on reply, track opens/clicks via `email_events`.

### Secrets (OpenBao)

Read-only inventory across products — which secrets exist, age of current version, owner,
which workloads consume them, what is stale or expiring. Staleness raises Inbox items.

**Rotation is modelled as a tracked job, never a button.** `lib/secrets/key-health.ts`
documents why: Kora's keys reach pods as env vars via an ExternalSecret with a 1h refresh,
so writing a new version rotates nothing until ESO refreshes *and* the pod restarts.
OpenBao does not remove this. A rotation job is:

```
write new version → poll for sync → verify workload picked it up → done | failed
```

with the in-progress state visible throughout. A button that writes a version and reports
success would be lying about a three-step operation.

If the OpenBao migration slips, inventory ships against GCP Secret Manager first
(`key-health.ts` already reads it) and the backend swaps later.

## Rule: vendored tools

**The console does not rebuild a vendored tool's own UI. It owns the cross-cutting,
tenant-centric view that tool cannot produce, and links out for everything else.**

Applied:

- **GrowthBook / feature flags** — BACKLOG H1 is **cut**. `feature-flags-service` is a
  stateless proxy in front of GrowthBook; a console explorer would be a third-hand view
  of someone else's source of truth, desyncing the moment anyone edits GrowthBook
  directly. Kept instead: a Launchpad tile, and a **read-only flags strip on tenant
  detail** ("which flags are on for this tenant") with a link out to change them.
  GrowthBook is flag-centric; the operator is tenant-centric.
- **ArgoCD, Grafana, ClickHouse, OpenBao UI** — Launchpad tiles, not console pages.
- **Deliberate exception: the existing Observability dashboard.** It rolls up per-app and
  per-tenant (requests, error rate, p50/p95/p99, service table, traces) in a way the
  current Grafana is not configured for. This assumption is **re-tested during M2**
  rather than assumed to hold.

## Mobile

`apps/mobile` is an Expo app mirroring the console screen-for-screen (72 screens) with
its own `components/kit.tsx` and `lib/theme.ts`. It has already drifted: Kora is absent
entirely, and `delivery-failures` survives there after web dissolved it into Support tabs.

Mobile is therefore not a follow-on project — it is the reason the kit is built as
**shared tokens + two renderers**. `console-core` holds the tokens, IA, and nav model;
`apps/console` and `apps/mobile` each render them. M5 rebuilds mobile on that base,
closes the Kora gap, and deletes the second theme file.

## Migration and cutover

1. Old `/admin/*` URLs keep resolving via redirects to their new section routes.
   Bookmarks, alert deep links, and the mobile app must not break mid-migration.
2. Surfaces port **per product batch**. Each batch is gated on a **keep/cut/merge
   inventory pass** done with the operator before any code is written.
3. **Fe3dr is the largest batch. Its redundancy is in page count, not capability.**
   An earlier draft assumed Fe3dr carried dead weight to delete. **Audit refuted that.**
   A repo-wide sweep of all 32 pages found **zero mocked, stubbed, or dead data sources** —
   every surface hits either the HMAC-signed Go gateway or a real `homechef_db` query.
   There is no free deletion here. Every entry on the Fe3dr cut list is
   *cut the route, keep the capability*. See [Fe3dr consolidation](#fe3dr-consolidation).
4. `apps/web/app/admin` is deleted only after the final batch lands. `apps/web` then
   becomes marketing-only, which also removes admin chrome, TipTap, and Recharts from the
   marketing bundle.

## Fe3dr consolidation

32 surfaces. Nothing is dead. The work is merging routes, not deleting features.

| Consolidation | From | Into | Saves |
|---|---|---|---|
| **Payments hub** | `payouts`, `payout-setup`, `payout-queue` | `/payouts` with tabs (Statements, Blocked chefs, Holds) | ~250–300 lines |
| **Automations & programs** | `winback`, `loyalty`, `chef-rewards` | one `PolicyConfigCard`-driven surface | ~200 lines |
| **Queues** | `approvals`, `fssai`, `cancellations`, `messaging`, `support`'s 3 tabs | Inbox | page shells dissolve |
| **Directory** | `users`, `orders`, `meal-plans`, `wallets`, `chefs` | Directory (wallets and test-sessions become detail tabs) | ~600 lines |
| **Audit** | `homechef/audit-logs` | unified Audit | 233 → ~16 lines |
| **Business** | `homechef/analytics` | Business | — |
| **Launchpad** | `homechef/page.tsx` | tile | — |

`refund-payouts` stays **out** of the payments hub and joins the **cancellations/refunds**
surface instead: opposite money direction (platform→customer), different gateway
(Razorpay), different entity (meal-plan-days). Nothing in it touches chef settlement.

`campaigns` and `promos` stay separate — their models share zero fields.

Three constraints for the people doing these merges:

- **Fe3dr's audit surface must keep using the gateway's `/audit-logs`**, which returns a
  flat `{logs, total, page, limit}` envelope rather than `Paginated<T>`. Do **not** point
  it at `/api/admin/apps/[product]/audit-logs` — that route returns mark8ly rows for any
  product (see Defects). The unified Audit surface needs one adapter per source, not one
  shared route.
- **`payment-gateway`'s three credential cards and `PayoutRailPanel`'s card are ~70%
  identical**, down to a verbatim shared comment. One `<CredentialSlotCard>` absorbs
  ~350 lines across the two files.
- **`support`'s Tickets tab duplicates `/admin/platform-tickets` in shape only** — same
  status vocabulary, same tone maps, same table skeleton, but different data and a
  different audience (Fe3dr end-customers vs merchant→Tesserix). Extract a shared
  `TicketTable` and tone maps; do **not** merge the surfaces. See Open Questions.

### The two "orphans" are not dead weight

Both `payout-queue` and `delivery-intelligence` have zero `<Link>` references repo-wide.
Both are fully live, and **mobile links both from its hub**. This inverts the earlier
assumption:

- **`payout-queue`** performs release / withhold / reverse / bulk-release of real escrow
  money while being undiscoverable to anyone who has not read the source. `payout-setup`
  even instructs the operator to release holds "from the Release Queue" — a cross-page
  instruction pointing at a page nothing links to. This is a **discoverability defect on
  the highest-consequence money actions in the product**, not a candidate for deletion.
- **`delivery-intelligence`** is the *self-delivery pricing engine* cost dashboard. It
  shares zero endpoints and zero metrics with `/delivery` (3PL couriers) — two unrelated
  systems that happen to share a word. It becomes a tab on `/delivery`.

### Boilerplate share (evidence for the kit)

`meal-plans` 79% · `orders` 74% · `users` 66% · `audit-logs` 48% · `payouts` 46% ·
`payout-queue` 43% · `payout-setup` 42%. The loading/empty/rows triad is byte-for-byte
identical across four files; the `<thead>` className string is byte-identical across six
more. **Every Fe3dr page over 400 lines except `tax-rates` and `approvals/[id]` is large
from copy-paste, not complexity.** `DataTable` + `FilterBar` is worth ~1,200–1,500 lines
in this batch alone.

## Defects found during audit

These are pre-existing and must be fixed **before or during** the port, not after. Two
were found independently by two auditors.

| | Defect | Consequence |
|---|---|---|
| **P0** | **Web cannot resolve 2 of 3 delivery-failure types.** The gateway returns `{orderIssues, mealPlanDays, groupOrders}`; `support/page.tsx` types the response as `{orderIssues}` only and posts solely to `/order-issues/:id/resolve-delivery-failure`. `/meal-plan-days/:id/…` and `/group-orders/:id/…` are called nowhere on web. | Money sits in escrow unless an operator uses the phone. **Caused by dissolving the standalone delivery-failures page into a Support tab and narrowing the type while doing it — precisely the failure mode this migration risks repeating.** |
| **P0** | **Mobile approve has no `requiredDocsMissing` guard.** Web disables Approve when documents are missing; mobile does not, and also drops both compliance warning banners. | A non-compliant kitchen can be approved from mobile that web would block. Server-side enforcement must be verified independently of this redesign. |
| **P1** | **`/api/admin/apps/[product]/audit-logs` ignores its `:product` param.** It validates the product, then unconditionally queries `lib/db/mark8ly-audit`. | "Critical events (24h)" on the HomeChef, DevAI, Dwellm8 and Kora overviews all show **mark8ly's** count. The unified Audit surface must not naively adopt this route as its backend. |
| **P2** | **Dead deep links.** `chefs`, `users`, and `reviews` are linked to with query params (`?chefId=`, `?search=`) but none call `useSearchParams`. | `chefs → reviews?chefId=`, `orders/[id] → users?search=` and others silently land unfiltered. The URL-serialised `FilterBar` fixes this by construction — verify that it does. |
| **P1** | **Mobile drops `mode` when approving.** Web sends `{notes, mode}` to `/approvals/:id/approve`; mobile sends `{notes}` only. | A chef approved from the phone may land in the wrong test/live mode. Compounds the missing-docs guard above — the mobile approval path needs a full review, not a patch. |
| **P1** | **Web's "block message" is not confirm-gated.** `messaging/page.tsx` gates *relay* behind a confirm only when `piiDetected`, and gates *block* not at all. Mobile confirm-gates both. | A one-click, irreversible, silent drop — the sender is never told. |
| **P1** | **`wallets` adjusts a customer's balance with no confirmation dialog at all.** Validation is only `amount > 0` and a non-empty reason. Far less consequential settings edits are gated behind a destructive confirm. | Unguarded money movement. |
| **P1** | **Four separate implementations of the per-chef payout-automation tri-state**, three of them reachable from the same screen: `/chefs/{id}/payout-automation` (payout-setup), `/chefs/{id}/disburse-automation` (chef-payout-profile), `/chefs/{id}/easy-split-mode` (easy-split-panel), plus the platform-wide toggle in payout-automation-panel. Same three values, different order, different endpoints. | An operator has no way to know which control applies. Consolidating the payments hub must resolve this, not just co-locate them. |
| **P2** | **`staff` hardcodes `limit: 50` with no pagination UI**, despite rendering `pagination.total` in its own subtitle. | A 51st staff member is silently invisible. |
| **P2** | **Inconsistent dialog conventions on money-moving actions.** `refund-payouts`, `approvals`, and `delivery` use raw `window.confirm`/`window.alert`; every peer uses the shared `useConfirm` with `tone: "destructive"`. | Least-guarded prompts sit on the most consequential actions. |
| **P3** | `lib/db/mark8ly-refunds.ts` — 137 lines, zero callers in web or mobile. | Delete rather than port. |
| **P2** | **Money units are inconsistent across pages.** `cancellations` works in paise (`formatINR(paise / 100)`); `support` and `promos` pass rupees straight to `formatINR`. | A live footgun. `console-core` must own a single money helper with the unit in the type. |
| **P2** | **Naming drift breaks deep-linking.** Web's sidebar says "Mediation" while the route is `/messaging`; mobile's route is `/mediation`. Web is `audit-logs`, mobile is `audit-log`. | `console-core` owns route identity precisely to prevent this; normalise during the port. |
| **P3** | `delivery-intelligence` has no inbound link on web. **Mobile added one** (`delivery.tsx` → `/homechef/delivery-intelligence`) per a documented decision; web never got the equivalent. | One-line fix, independent of the redesign. |
| **P3** | `dwellm8` KPIs: `[product]/kpis` has branches for devai/kora/homechef and no dwellm8 case, falling through to `{}`. | Four tiles have rendered `—` since launch. Wire the branch or drop the tiles. |

## Capability ceiling already paid for

The HomeChef Go gateway exposes endpoints with **no console UI at all**. These need no
backend work — only a surface. The ones that map cleanly onto the new IA:

- **Inbox** — `/customer-risk` (+ config, recompute, review): an entire fraud surface ·
  `/chef-penalties` (+ waive) · `/reports` (+ resolve) · `/meal-plan-days/:id/approve-skip`
- **Governance** — `/security/api-keys` CRUD, `/security/policy`
- **Business** — `/invoices`, `/credit-notes`, `/ledger/reconcile`, `/subscriptions/stats`
- **Operate** — `/delivery/zones` CRUD, `/delivery/partners`, `/delivery/stats`
- **Exports** — `/exports/{orders,revenue,users}.csv`

Note: `/security/api-keys` is HomeChef-scoped. It does **not** satisfy BACKLOG F5, which
asks for a cross-product API key inventory (see M4 below).

## Milestones

| | Milestone | Lands |
|---|---|---|
| **M0** | **Foundation** | `packages/platform-data` + `packages/console-core` extraction · `apps/console` scaffold · console kit · Launchpad (+ registry schema additions) · **Kora ported AND refactored onto the primitives** · one `QueueList` surface · P1/P2 defect fixes |
| **M1** | **Front doors** | Inbox · Business dashboard · ⌘K entity search |
| **M2** | **Migration** | Consolidation pass per product (Fe3dr first) → port survivors · unified Templates · unified Audit · unified Directory · saved views · redirects · **DB backup health (O2)** · **tenant kill-switch with reason codes (H2)** · **read-only per-tenant flag strip** · delete `apps/web/app/admin` |
| **M3** | **Growth** | Pipeline, funnels, cohorts, sequences |
| **M4** | **Secrets** | OpenBao inventory · rotation as tracked verified jobs. **Not F5** — see below |
| **M5** | **Mobile** | Rebuild `apps/mobile` on `console-core`; close the Kora gap; resync tokens; delete the second theme |
| **M6+** | **Platform ops** | Cron/scheduled job status (E6) · roles & team management (H3) · failed-login tracker (O7) · alerting (O4) · public status page (I2) · cross-product API key inventory (F5) |

### Why Kora, and why the M0 scope grew

**Kora goes first, not Fe3dr.** Fe3dr has 32 surfaces and the fattest pages; it is the
wrong place to discover the kit is wrong. Kora has 5 surfaces (~1,854 LOC) and is the
best-engineered area of the console — optimistic-concurrency 409 handling, runtime
response validation, and error discipline that never conflates empty with error.

**But porting Kora as-is proves less than it appears.** None of Kora's 7 dedicated pages
instantiates a shared component; they hand-roll markup that merely *resembles* the kit.
Porting them proves the primitives' behavioural contract — genuinely valuable — but not
**reuse**, which is the exact failure mode this project exists to fix. So M0 also
requires:

- A **refactor-onto-primitives pass** on those 7 pages. Without it, M0 proves nothing
  about adoption.
- **One `QueueList` surface.** Kora has zero candidates today, and `QueueList` is the
  primitive M1's entire Inbox depends on. Discovering it is wrong in M1 is the expensive
  version of that mistake.
- **Multi-select + bulk status change on Kora Feedback** — the only bulk-action candidate
  in the batch; single-row status change already exists.
- **Suspense/skeleton on the Foods index.** Kora's 7 server-rendered pages currently have
  no loading UI at all.
- **`apps` registry schema additions** — the table has `status` and `admin_url` but no
  observability / logs / repo / runbook columns. The Launchpad needs them, and there is
  no POST/PUT route today.

### M4 cannot deliver F5

BACKLOG F5 (API key inventory) assumes an `api_keys` table. `grep -rn "api_keys"` across
`lib` and `db` returns **nothing** — no reachable product DB module reads such a table.
`lib/secrets/key-health.ts` is a different feature (AI-provider secrets in GCP Secret
Manager, by name list), and HomeChef's `/security/api-keys` gateway endpoint is
product-scoped, not the cross-product inventory F5 describes. F5 moves to M6+ and is
gated on backend work.

### Two items move earlier because they are nearly free

- **O2 (DB backup health) → M2.** `lib/metrics/cnpg-health.ts` *already queries*
  `cnpg_collector_last_available_backup_timestamp` / `_last_failed_backup_timestamp` and
  returns them per cluster. The module's own comment says backup detail was scoped out of
  the databases page because "that's a separate page (O2)". Pure UI work.
- **H2 (tenant kill-switch) → M2.** Not a new capability — a half-built one. The
  row-locked (`FOR UPDATE`), zod-validated federated write already exists and ships on
  both web and mobile today, behind a bare `window.confirm`. Missing only: reason codes,
  an audit record, and placement on tenant detail. That is a governance gap, not a
  feature request.

## Dependencies and risks

| | Risk | Mitigation |
|---|---|---|
| M4 | Gated on the OpenBao migration actually happening | Ship inventory against GCP Secret Manager first; swap the backend later |
| M2 | Fe3dr prune requires operator judgement, not inference | Produce a keep/cut/merge inventory table and decide together before any porting |
| M0 | A wrong `console-core` boundary lets mobile drift again | `console-core` must contain zero renderer-specific code; icons as string keys, routes renderer-prefixed; contracts move to `platform-data` |
| M2 | **Dissolving a page into a tab can silently drop capability.** This already happened once: the P0 delivery-failure defect was caused by folding a standalone page into a Support tab and narrowing the response type while doing it. | Every consolidation must enumerate the source page's endpoints and assert each still has a caller. This is a checklist item per merge, not a review comment. |
| M5 | Mobile tokens are not merely drifted — they describe a different brand. `theme.ts` claims to carry "the exact hex values" from web; web was repainted 2026-08-11 and mobile never received it. Focus ring changed hue entirely, borders use a different mechanism, the cobalt accent has no mobile equivalent, and fonts differ. | M5 is a **resync**, not a dedup. Budget accordingly. |
| — | `docs/DEPLOY_SYSTEM.md` pre-specifies 12 `/admin/deploy/*` routes that contradict this section model | Reconcile before either lands. Do not silently override a deliberately-written document. |
| M2 | Redirect coverage gaps break alert deep links and the mobile app | Every removed route gets an explicit redirect; verified by a route-parity test |
| M0–M2 | Long migration means two consoles coexist | New console is independently useful from M1; old console stays untouched until its surfaces move |

## Open questions

These cannot be answered from source and are cheap to settle:

1. **Does `audit_logs` contain login events?** `getAuditFilterOptions()` already runs
   `SELECT DISTINCT action`. If login actions appear, O7 (failed-login tracker) is a
   filter preset on the unified Audit surface — small. If not, it needs audit-service
   emission and should be cut.
2. **What is the `feature-flags` service's per-tenant endpoint shape?** The BFF plumbing
   exists (`adminFetch('feature-flags', …)`) and `settings/page.tsx` has a dead link to
   `/admin/feature-flags`. GrowthBook itself is unreferenced repo-wide — so build against
   the service, not against GrowthBook assumptions.
3. **Has the SendGrid webhook been configured?** `notifications/log` queries real data but
   the table is empty pending an ops step, not a code change.
4. **Is Stripe key management deliberately excluded from mobile?** Probably a correct
   security boundary; worth confirming rather than assuming.
5. **Should Fe3dr support tickets and platform tickets eventually share a backend?**
   A product question, not a code one. Today they are genuinely different data (Fe3dr
   end-customers vs merchant→Tesserix), and `platform-tickets` is empty pending its
   filing UI in mark8ly admin (Phase 5.5). Recommendation until that lands: share the
   component, not the surface.
6. **Is the Observability dashboard still worth owning in-console?** The vendored-tools
   rule says link out; the current exception assumes Grafana is not configured for
   per-app/per-tenant rollup. Re-test in M2.

## Success criteria

- Answering "what needs my attention" takes one screen, not a tour of the nav.
- Answering "how is the business doing" takes one screen, cross-product.
- No raw `<table>` in `apps/console`; every list surface uses `DataTable`.
- No admin page exceeds 400 lines.
- One template workspace, one audit surface, one user directory.
- `apps/web` contains no admin code.
- `apps/console` and `apps/mobile` share one IA definition and one token set.
- Every pre-migration `/admin/*` URL still resolves.
