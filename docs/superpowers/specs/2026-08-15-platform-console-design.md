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

### 1. Platform owns the subscription model; products consume it

Following the announcement pattern, which already works here rather than one invented for this spec.

One plans/pricing/subscription model in `tesserix-postgres`, authored in the console, targeted per product, consumed by products through an internal API. The alternative — every product keeps private billing and the console aggregates — means each product reimplements trials, renewals, discounts and invoicing. HMS is already partway down that road.

**Consequence for `tesserix/hms` M8:** the plan and pricing issues (#247–#259 — clinic, hospital, enterprise, government, per-bed, trials, discounts, renewals, invoicing) become *configuration of a shared model* rather than a private implementation, and belong with the console. The genuinely product-specific ones stay: #809 and #810 (demo tenants, synthetic Indian healthcare data) are PHI-shaped and HMS's own. #808 (CRM boundary and system-of-record contract) must be answered **before** any of it moves, because it decides whether the console owns prospects or reflects them.

### 2. Status, never charts

Observability is hosted separately. A console that redraws Grafana's charts will always be the worse copy and doubles the maintenance. Health tiles show state — healthy, degraded, not measured — with a count where one is meaningful, and link out to the real tool.

### 3. No links into `apps/web`

The old admin is being retired. Linking into it makes the console a shell around the app it replaces, and builds a dependency on something scheduled to disappear. Surfaces not yet built here render as pending. Linking out to *living* systems — Grafana, OpenBao — is a different thing and is fine.

### 4. Read `apps/web`'s admin API for now, behind the typed client

`lib/db` and `lib/metrics` back roughly sixty surfaces; extracting them before a single console surface exists is the "risk with no payoff" trade already rejected once. The console reads `/api/admin/*` through `PlatformApiClient`, which validates shapes at the boundary and preserves HTTP status, so swapping the source later touches one file.

**This has a deadline, not just a caveat.** `apps/web` cannot be switched off while the console depends on its API, and `/api/internal/platform-announcements` — which every product calls — lives there too. The internal channel must move before retirement, and that is a cross-product contract change, not a UI task. It is the single most likely thing to bite.

## Decomposition

Too large for one plan. Sequenced so each milestone produces something an operator can use:

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
