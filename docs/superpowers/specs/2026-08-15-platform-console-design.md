# The platform console — what it is for

**Status:** draft for review, 2026-08-15
**Supersedes:** the working assumption that the console's home page shows tenants, stores and leads.

> This repository is public. Infrastructure identifiers are referred to by role; real values live in `tesserix-k8s`.

## The thesis

**One place to control every product.**

Control, not observation. The console must eventually *do* what an operator needs done — update a tenant's subscription, publish an announcement to two products, edit a template, answer a ticket — not merely display that those things exist elsewhere. Read-only surfaces are a step towards that, never the destination.

It is therefore the two-way channel between the operator and every product, plus the commercial control plane for all of them. It is not an infrastructure dashboard, and it is not a re-skin of `apps/web`'s admin. Its home page currently shows Mark8ly's tenants, stores and leads — one product's business numbers presented as estate health — because those were the metrics the available endpoint returned. That is the mistake this spec exists to correct.

Two consequences worth stating up front, because they constrain everything below:

- **Every capability in `apps/web/app/admin` must have a home here, or an agreed deletion.** The old admin cannot be retired while it is the only place something can be done. That is issue #103's delete-vs-port list, and it is a prerequisite, not a tidy-up.
- **Writes need a real auth story.** Reading through `apps/web`'s API is tolerable; issuing writes through an app being retired is not. The write path is where the API-dependency decision gets expensive, and it arrives in P3.

Four things belong to the platform, and one pattern belongs to every product.

| Area | Direction | State today |
|---|---|---|
| **Inbound** | products → platform | tickets work, cross-product; feedback has no channel |
| **Outbound** | platform → products | announcements work and are product-targeted; promos follow |
| **Commercial** | platform owns, products consume | Mark8ly-only underneath a product-generic URL |
| **Health** | context, not content | endpoints exist; status only, never charts |

## What is already true

Established by reading the code, not assumed:

- **`platform_tickets` is a genuine cross-product inbox.** Rows carry `product_id`, `tenant_id`, `subject`, `priority`, `submitted_by_name`/`email`, and a reply thread with `author_type: "merchant" | "platform_admin"`. It lives in `tesserix-postgres`, not a product database.
- **Announcements are genuinely multi-product.** `audience_filter` is JSONB matched as `audience_filter->'products' @> to_jsonb($1::text)`, and `/api/internal/platform-announcements` is the channel products call to fetch what applies to them. **This is the reference pattern** for everything else the platform owns.
- **Subscriptions are not.** `/api/admin/apps/[product]/subscriptions` looks product-generic, but the implementation imports `mark8ly-billing` and hardcodes Mark8ly's trial rules. The `[product]` segment is decorative — someone intended this shape and got as far as one product.
- **Per-product data is broadly reachable:** `/api/admin/apps/[product]/{tenants, subscriptions, kpis, metrics, revenue, payouts, onboarding, audit-logs, delivery}`, plus `/api/admin/tenants/[id]` and `/api/admin/users/{search,[email]}`.
- **Health sources report unavailability in-band.** `service-health` and `cnpg-health` return HTTP 200 carrying `available: false` when Prometheus is parked — *not* a 501. Any state mapping that keys only off the status code renders a parked plane as healthy.

## What the product research established

Read across Mark8ly, Fe3dr, Kora, DevAI, Dwellm8 and HMS on 2026-08-15. Several findings contradict what this spec assumed before.

### The old admin's failure mode is dashboards with no verbs

This is the precise shape of "right intention, poorly planned". Four platform pages are read-only queues offering no action at all: `erasure-requests` (GDPR — no approve or execute), `break-glass` (no rotate or disable), `outbox` (no requeue), `apps` (a registry; onboarding is a runbook).

Meanwhile Mark8ly's operators work queues that have no UI **anywhere**: `sea_manual_review_queue` on a five-business-day SLA that pauses the subscription clock; `customer_erasure_requests`, whose migration comment records that support reads it through a read-only DB role and dedupes by hand; `subscription_arbitrage_audit` appeals; and `migration_fast_path_reviews`, whose review endpoint is implemented but never mounted (TODO at `internal/handlers/admin/routes.go:779`). Mark8ly's README states billing P1–P14 have no runbooks and manual SQL against production is the norm.

**Hence the organising rule: every console surface ships with a verb.** If an operator can only look at it, it belongs in the observability stack, not here.

### Authorization is flat, and the console inherits it

`app/auth/callback/route.ts:106` enforces an `ALLOWED_ADMIN_EMAILS` allowlist at login, so access is not open. But past that gate there is no authorization: **zero role guards across all 57 handlers** under `app/api/admin/**` and `app/api/internal/**`, and `middleware.ts` checks only that a session exists. Everyone allowlisted can rotate live payment-gateway keys, adjust wallet balances, execute reversals, hard-delete leads and fire irrevocable mass campaigns. The session cookie is scoped to `.tesserix.app`, so `apps/console` inherits this unchanged. Fixing it is an M0 blocker, because every later milestone adds destructive verbs.

### Products already own their operator surfaces

Fe3dr has ~200 `/admin/*` endpoints behind pool and staff-permission checks. Dwellm8 ships `apps/admin` with triage, approvals, reconcile and dispute screens. DevAI has pipeline and SRE dashboards. **The console renders against these; it does not reimplement them.** Reimplementation would repeat the mistake being corrected.

### Two products already meter AI cost

Kora writes a durable per-call ledger — `ai_usage_events` with tokens in and out, estimated cost, latency and outcome, indexed by user — and enforces budget caps. DevAI meters to integer micro-USD with per-user trial budgets and exposes it over HTTP. Neither is visible centrally, and Kora exposes no cost over HTTP at all. Cross-product AI cost is therefore a **surfacing** job, not an instrumentation project.

### Do not build on the dormant services

`subscription-service`, `tickets-service`, `audit-service`, `tenant-service`, `feature-flags-service`, `notification-hub` and `analytics-service` exist as repos and **none is deployed** — none appears in `tesserix-k8s`. They are artefacts of the older marketplace-microservices architecture that the root `CLAUDE.md` still describes. Treating them as existing foundations means reviving seven dead services first.

### Scope: seven rails

Platform, Mark8ly, Fe3dr, DevAI, Dwellm8, Kora and HMS. The prod cluster also runs FanZone, Guardix, Gameverse, Horoscope, Social, Blog and Planning Poker; these are deliberately out of scope. `ESTATE` currently lists six rails, omits HMS, and understates DevAI and Dwellm8 as placeholders — all three are wrong.

## Three ownership patterns already exist — pick deliberately

The estate has solved "platform authors, product consumes" three different ways. New capabilities should choose one on purpose rather than inherit whichever neighbour they were copied from.

| Pattern | Who owns the data | How it reaches the product | Used by |
|---|---|---|---|
| **Platform-owned** | `tesserix-postgres` | product calls `/api/internal/*` | announcements |
| **Product-owned, platform-authored** | the product's own DB | platform writes cross-DB, then pings the product to evict its cache | email templates |
| **Product-implemented** | the product's own DB and code | no shared contract at all | subscriptions (Mark8ly only) |

The email-template comment states the reasoning for the second explicitly: templates live in the product's DB "so the product owns its data and the runtime send path has no dependency on tesserix-home", with a cross-DB UPSERT plus a `/internal/templates/refresh` ping so the change is live within a request round-trip rather than after a 5-minute TTL.

That reasoning is about **runtime coupling on the send path** — a product must be able to send mail even if the platform is down. It applies to email and not to announcements, which is why the two differ legitimately. Apply the same test to each new capability: *if the platform is unavailable, must the product still function?* If yes, the product owns the data. If no, the platform can.

Subscriptions fail that test in the platform's favour — a product does not need to compute pricing while the platform is down; it needs to know what a tenant is entitled to, which is cacheable. So subscriptions take the platform-owned pattern.

## Decisions

### 1. Platform owns the subscription model — for the SaaS-seat products only

Following the announcement pattern, which already works here rather than one invented for this spec.

One plans/entitlement/price-book model in `tesserix-postgres`, authored in the console, targeted per product, consumed by products through an internal API. The alternative — every product keeps private billing and the console aggregates — means each product reimplements trials, renewals, discounts and invoicing. HMS is already partway down that road.

**HMS validates this in writing, unprompted.** Issue #247 places billing metadata in *"the shared global control plane"*, required to contain no PHI — plan, entitlement, counts and money only — precisely so the country data-residency boundary is preserved. #255 and #259 restate it. HMS #247 is also the most fully specified statement of the model anywhere in the estate: plan versions, entitlements, limits and price books, with **immutability** (a subscription signed in March keeps March terms until explicitly migrated, because retro-mutating a live plan corrupts GST e-invoices already filed).

**The original wording overreached, and this narrows it.** The estate does not share one revenue shape:

| Product | Revenue shape | Shared model? |
|---|---|---|
| Mark8ly | SaaS subscriptions — Stripe, plan tiers, PPP pricing | yes |
| HMS | SaaS subscriptions — per-facility/user/bed, India tax | yes |
| Fe3dr | commission plus payouts and split settlement | **no** |
| Dwellm8 | fee-on-rent, double-entry ledger, TDS obligations | **no** |

Forcing a marketplace take-rate business into a plans-and-seats model would repeat, one layer down, the mistake of the decorative `[product]` URL segment.

Two constraints the shared model must carry, both generalised from HMS:

- **Module dependencies, not just entitlements.** HMS #254 frames its `requires` / `conflicts_with` graph as *clinical correctness*, not commerce — PharmaConnect without DoctorConnect produces an unfillable queue.
- **A billing state must never disable a safety-critical function.** HMS #258 requires that dunning never suspend clinical modules; degradation is graduated. That principle belongs in the shared model rather than in one product's copy of it.

**Consequence for `tesserix/hms` M8:** the plan and pricing issues (#247–#259 — clinic, hospital, enterprise, government, per-bed, trials, discounts, renewals, invoicing) become *configuration of a shared model* rather than a private implementation, and belong with the console. The genuinely product-specific ones stay: #809 and #810 (demo tenants, synthetic Indian healthcare data) are PHI-shaped and HMS's own. #808 (CRM boundary and system-of-record contract) must be answered **before** any of it moves, because it decides whether the console owns prospects or reflects them.

### 1a. The console takes its roles from Zitadel

Added 2026-08-15, after finding Zitadel deployed in prod.

The console does **not** authenticate against GIP, and never did. `apps/web/app/auth/login/route.ts` runs a server-side Google OAuth flow and mints its own JWE session — *"Tesserix-home owns its own session cookie minting; auth-bff is no longer involved."*

Zitadel runs at `auth.tesserix.app` (v4.15.3, three replicas, CNPG-backed, in the `identity` AppProject), and it already provides organizations, projects and roles. **Taking roles from the IdP is a better answer to the flat-authorization problem than building a capability model in `platform-auth`** — it removes the allowlist-as-authorization pattern at the root instead of layering over it. `AllowDomainDiscovery: true` also means one hostname federates every tenant's SSO, which is the multi-product operator story the console exists for. HMS has already decided on Zitadel (ADR-0006), and GIP bills per monthly active user while Zitadel runs on cluster hardware already paid for.

**Two prerequisites, both blockers.** Zitadel Postgres backups are off pending a Workload Identity binding (`tesserix-k8s#308`) — three replicas guard against Spot node loss, not against logical corruption. And the masterkey is immutable, with no re-key possible, so custody and recovery must be written down (`tesserix-k8s#309`). Making more things depend on Zitadel before both are closed is the wrong order.

**The estate runs four identity paths** — Keycloak, GIP, raw Google OAuth, Firebase — and the documents disagree about which Zitadel replaces: `tesserix-k8s/docs/zitadel.md` says Keycloak, HMS ADR-0006 says GIP. That estate-level decision is tracked separately (#165) and deliberately does not gate the console's own move: one product moving is how the decision gets informed rather than deferred.

### 2. Status, never charts

Observability is hosted separately. A console that redraws Grafana's charts will always be the worse copy and doubles the maintenance. Health tiles show state — healthy, degraded, not measured — with a count where one is meaningful, and link out to the real tool.

### 3. No links into `apps/web`

The old admin is being retired. Linking into it makes the console a shell around the app it replaces, and builds a dependency on something scheduled to disappear. Surfaces not yet built here render as pending. Linking out to *living* systems — Grafana, OpenBao — is a different thing and is fine.

### 4. Read `apps/web`'s admin API for now, behind the typed client

`lib/db` and `lib/metrics` back roughly sixty surfaces; extracting them before a single console surface exists is the "risk with no payoff" trade already rejected once. The console reads `/api/admin/*` through `PlatformApiClient`, which validates shapes at the boundary and preserves HTTP status, so swapping the source later touches one file.

**This has a deadline, not just a caveat.** `apps/web` cannot be switched off while the console depends on its API, and `/api/internal/platform-announcements` — which every product calls — lives there too. The internal channel must move before retirement, and that is a cross-product contract change, not a UI task. It is the single most likely thing to bite.

## What separates platform from product

One test: **does it need cross-product context to be useful?** If yes it is platform. If it needs domain knowledge of a single product, it belongs to that product's rail.

Tickets are platform — a support person does not know which product an email concerns until they read it. Kora's food index is Kora's — nothing outside Kora has an opinion about it.

## Features worth building because the console exists

The point of this work is uplift, not transcription. These are capabilities the old admin could not have had, because it was organised as pages per product.

| # | Capability | Why only here | Cost today |
|---|---|---|---|
| F1 | **Cross-product staff identity lookup** — one email resolves to the accounts that person holds, with their tickets and tenants. **Staff-scoped**, see below | A page-per-product admin makes you check products one at a time | Low — `/api/admin/users/search` exists, though today it is off-rail and unnavigable |
| F2 | **⌘K over the estate** — jump to a tenant, ticket, service or user by typing | Needs one shell over everything; impossible per-product | Medium |
| F3 | **Health ↔ inbound correlation** — "tickets from Kora tripled while kora-api was degraded" | Both datasets are reachable; nothing else can join them | Medium |
| F4 | **One audit timeline** — who changed what, in which product, including console writes | Per-product audit logs exist; the join does not | Medium |
| F5 | **Erasure across products** — one GDPR request covering every product | Currently Mark8ly-only; a person's data does not respect product boundaries | High |
| F6 | **Deploy/version visibility** — which build each product runs, from Kargo and ArgoCD | Operators currently discover a stalled promotion by noticing the UI is old | Low–medium |

**F1 must be staff-scoped, and HMS is why.** A patient is not "a user of a product" — they are a Data Principal behind RLS, OpenFGA care-relationship checks, facility and department scoping, ABAC and consent-based sharing. An unscoped "find this person everywhere" would either bypass those checks or require break-glass with its own audit. HMS #808 adds that the CRM boundary is a **lawful-basis** boundary — marketing contacts sit under legitimate interest, clinical data under DPDP health processing — so joining them in one identity graph merges two lawful bases. Therefore: staff, operators and merchant-side users by default; end-user lookup opt-in per product; HMS patients never.

**Deliberately deferred: impersonation / support sessions.** Genuinely useful, but it needs an audit and consent story before it needs a UI, and safeguards are easier to design in than to retrofit.

**Uplift that is nearly free**, because the kit already provides it: URL-serialised filters so any view is linkable, bulk actions, the five honest states so a parked signal never renders as healthy, and keyboard-first navigation.

**Every product rail gets the same four shapes** — tenants → tenant detail (including subscription control) → users → that product's own domain surfaces. The consistency is itself the improvement: today each product's admin section was designed separately.

## Milestones

Too large for one plan. Sequenced so each milestone produces something an operator can use. Filed in `tesserix/tesserix-home` as issues under these milestones; the earlier P1–P5 sketch is retained below the table because its reasoning still holds.

| Milestone | Platform-level | Product-level |
|---|---|---|
| **M0 Foundation** *(in progress)* | Capability model in `platform-auth` **(blocker)**; enforce it across 57 routes; correct `ESTATE` | Kora port and cutover, gated on `kora#161` |
| **M1 Front doors** | One support surface (merges 6 routes); staff identity lookup; ⌘K; feedback contract | Fe3dr keeps its merchant↔customer tickets |
| **M2 Migration** | Generic `[product]` routes; route-count ratchet in CI; one audit-log surface | Fe3dr merge targets signed *before* porting |
| **M7 Operator queues** | Verbs for erasure, break-glass and outbox | Mark8ly SEA tax review, arbitrage appeals, migration fast-path |
| **M8 Commercial** | Shared PHI-free plan/entitlement/price-book | Mark8ly subscription control; HMS catalogue and invoicing |
| **M9 Outbound** | Announcements and promos; one template editor; migrate `/api/internal/*` | per-product template sets |
| **M3 Growth** | Leads CRM moved to the platform rail; CRM boundary contract | — |
| **M6 Platform ops** | One telemetry surface; deploy/version visibility; cross-product AI cost; one audit timeline | — |
| **M10 Backend cleanup** | Dormant services; cross-DB grants; token scoping; unmounted endpoints and lossy metering | — |

**M7 is the milestone that justifies the console.** Everything else improves on something that already works; M7 gives a home to work currently done with SQL and a spreadsheet.

### Original sequencing notes

**P1 — Inbound.** The platform home page becomes the cross-product ticket queue: product, tenant, submitter, waiting time, breach state. Health strip beneath it as context. Uses the kit's `QueueList`, whose opaque composite `key` fits `(product_id, ticket_number)` exactly. *Nothing new server-side; the endpoints exist.*

**P2 — Product rails.** Per product: tenants, users, and that product's own surfaces. Read first, then the writes that make it a control plane. This is where "view all users and important data" lands, and it is what makes the rails more than labels.

**Fe3dr is the test case, and it must not be ported wholesale.** It is the largest rail — nine top-level entries across seven groups — and the integration is bloated. Issue #103 already establishes the shape of the fix and it is worth repeating here because it is counter-intuitive: **Fe3dr has no dead weight.** Nothing is mocked or stubbed; the redundancy is *page count*, not capability. So every cut is **cut the route, keep the capability** — merge surfaces, do not drop functions. The merge targets need signing before anyone ports anything, or the residue at the end is the pages nobody wants (`tax-rates` at 608 lines, `platform-settings` at 458).

#103 also recommends making this a continuous per-surface ratchet — a CI check that the `page.tsx` count under `apps/web/app/admin` never increases — rather than a 55-item milestone with a cliff at the end. That check is cheap and should land with P2's first surface, not at the finish.

**P3 — Commercial.** The shared subscription model, then per-tenant subscription management inside the product rails. The largest piece, and the one needing #808 answered first.

**P4 — Outbound.** Announcement and promo authoring with product targeting; email and lead template editing (platform templates and each product's own); and migrating `/api/internal/*` off `apps/web`.

Note that email templates keep the product-owned pattern — the console becomes the authoring surface, writing cross-DB and pinging the product to evict its cache, exactly as `apps/web` does today. What moves is the *editor*, not the data.

**P5 — Feedback.** Requires a contract for products to push user feedback up. Deliberately last: inventing the contract before products can implement it is guesswork.

## Deliberately not in scope

- Charts or metric rendering of any kind
- `platform-data` extraction — deferred until the API dependency actually blocks retirement
- Kora's port (M0 Tasks 5–6) — still gated on `kora#161` and `tesserix-k8s#241`, and independent of everything here
- Any new endpoint in `apps/web` — if a signal is not already exposed, it waits for the owning milestone

## Open questions

1. **Ticket queue: mixed or grouped by product?** Mixed-and-urgent-first suits triage; grouped suits "how is Kora doing". Recommendation: mixed, with a product column.
2. **Which systems appear on the health strip**, and do OpenBao and Analytics expose status endpoints, or is reachability the honest best available?
3. **`tesserix/hms` #808** — the CRM system-of-record contract. Blocks P3.
