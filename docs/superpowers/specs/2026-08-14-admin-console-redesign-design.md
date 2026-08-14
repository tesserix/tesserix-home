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
| `platform-data` | `lib/db/*`, `lib/metrics/*`, `lib/auth/*`, `lib/api/*`, `lib/secrets/*`, `lib/templates/*` | Anything React. Must remain importable from a Node context and unit-testable without a renderer. |
| `console-core` | Design tokens (colour, type scale, spacing, radii), the IA definition (sections, surfaces, routes), nav model and active-state logic, shared domain types, formatters | Any renderer-specific code. No `react-dom`, no `react-native`. Consumed by both `console` and `mobile`. |

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

- **Uptime + Service health → one "Health" surface.** They answer the same question from
  outside and inside; splitting them means checking two pages to learn one thing.
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
3. **Fe3dr is the largest batch and has the most redundancy** — ~25 surfaces, with known
   orphans (`payout-queue`, `delivery-intelligence` are off-rail and reachable only by
   URL) and pages already superseded by Support tabs. Migrating a page that is about to
   be deleted is the most expensive available mistake, so pruning gates the batch.
4. `apps/web/app/admin` is deleted only after the final batch lands. `apps/web` then
   becomes marketing-only, which also removes admin chrome, TipTap, and Recharts from the
   marketing bundle.

## Milestones

| | Milestone | Lands |
|---|---|---|
| **M0** | **Foundation** | `packages/platform-data` + `packages/console-core` extraction · `apps/console` scaffold · console kit · Launchpad · **Kora ported end-to-end as kit proof** |
| **M1** | **Front doors** | Inbox · Business dashboard · ⌘K entity search |
| **M2** | **Migration** | Keep/cut/merge pass per product (Fe3dr first) → port survivors · unified Templates · unified Audit · unified Directory · saved views · redirects · delete `apps/web/app/admin` |
| **M3** | **Growth** | Pipeline, funnels, cohorts, sequences |
| **M4** | **Secrets** | OpenBao inventory · rotation as tracked verified jobs · API key inventory (BACKLOG F5) |
| **M5** | **Mobile** | Rebuild `apps/mobile` on `console-core`; close the Kora gap; delete the second theme |
| **M6+** | **Platform ops** | Deployments timeline (J1) · cron/scheduled job status (E6) · DB backup health (O2) · roles & team management (H3) · failed-login tracker (O7) · alerting (O4) |

**Kora goes first in M0, not Fe3dr.** Fe3dr has ~25 surfaces and the fattest pages; it is
the wrong place to discover the kit is wrong. Kora has 5 surfaces and exercises list,
detail, form, and audit patterns.

## Dependencies and risks

| | Risk | Mitigation |
|---|---|---|
| M4 | Gated on the OpenBao migration actually happening | Ship inventory against GCP Secret Manager first; swap the backend later |
| M2 | Fe3dr prune requires operator judgement, not inference | Produce a keep/cut/merge inventory table and decide together before any porting |
| M0 | A wrong `console-core` boundary lets mobile drift again | `console-core` must contain zero renderer-specific code; enforced by lint and by the fact that both apps import it |
| M2 | Redirect coverage gaps break alert deep links and the mobile app | Every removed route gets an explicit redirect; verified by a route-parity test |
| M0–M2 | Long migration means two consoles coexist | New console is independently useful from M1; old console stays untouched until its surfaces move |

## Success criteria

- Answering "what needs my attention" takes one screen, not a tour of the nav.
- Answering "how is the business doing" takes one screen, cross-product.
- No raw `<table>` in `apps/console`; every list surface uses `DataTable`.
- No admin page exceeds 400 lines.
- One template workspace, one audit surface, one user directory.
- `apps/web` contains no admin code.
- `apps/console` and `apps/mobile` share one IA definition and one token set.
- Every pre-migration `/admin/*` URL still resolves.
