# Product Admin Integration Contract v1

> **Status**: Draft for review | **Date**: 2026-08-14
> **Companion to**: `2026-08-14-admin-console-redesign-design.md`

## Why this exists

The Tesserix super-admin console integrates with each product differently, because
nothing ever said how. The audits behind the console redesign found:

- **Three transports.** mark8ly is read by federated SQL. Kora is read exclusively
  through an HMAC-signed admin API and deliberately has *no* DB access. HomeChef uses
  both — a signed gateway for 30 surfaces, direct SQL for payouts and delivery.
- **Two pagination envelopes.** Most HomeChef endpoints return `Paginated<T>`;
  `/audit-logs` returns a flat `{logs, total, page, limit}`, and both the web and mobile
  pages carry a comment apologising for it.
- **Three money conventions in one console.** Cancellations works in paise, support and
  promos in rupees, delivery-intelligence in USD. Nothing in the type system distinguishes
  them.
- **Two products deployed with no console presence at all.** dwellm8 runs a statutory
  money ledger and contributes zero rows to the console. Otto is a substantial deployed
  service with no registry row and no tile.
- **A shared-services tier the console never calls.** `adminFetch` defines an 8-service
  registry and has zero callers anywhere.

None of these are accidents. They are what happens when every integration is negotiated
from scratch. This document is the negotiation, done once.

## Scope

This contract governs how a **product** exposes itself to the **platform super-admin
console**. It does not govern product-internal APIs, tenant-facing APIs, or
service-to-service calls.

**Non-goals:** this is not a data-modelling standard, not an authorization model (see
the open problem at the end), and not a migration mandate for existing products beyond
what the console redesign's M2 already touches.

---

## 1. Registration

Every product declares itself once. A product that is not registered does not exist to
the console — no tile, no filter chip, no rows.

### 1.1 Source of truth

**Registration derives from ArgoCD, not from a hand-seeded table.** The `apps` registry
table holds only metadata ArgoCD cannot supply.

This is not a preference. The current registry has four rows seeded by SQL migrations,
while ArgoCD prod has ~16 namespaces. dwellm8 and Otto are invisible to the console
*because* the table is hand-maintained. A hand-seeded registry reproduces the exact bug
it is meant to fix.

### 1.2 Required metadata

| Field | Source | Purpose |
|---|---|---|
| `slug` | ArgoCD app / namespace | Route identity. Never displayed |
| `display_name` | registry | What operators read. **Separate from `slug`** |
| `namespace` | ArgoCD | Metrics, cost, logs correlation |
| `admin_api_base` | registry | Transport target (§2) |
| `argocd_app`, `kargo_project`, `kargo_stage` | registry | Delivery surface |
| `image_repo` | registry | Delivery surface |
| `db_cluster` | registry | Database health, backup status |
| `repo_url`, `runbook_url`, `owner` | registry | Launchpad tile |
| `observability_url`, `logs_url` | registry | Launchpad tile deep links |

`slug` and `display_name` **must** be separate fields. Fe3dr is one product with three
names — repo `Home-Chef-App`, slug `homechef`, brand `fe3dr.com` — and nobody should have
to know more than one of them.

### 1.3 Exclusions

Git worktrees (`hc-wt-*`) and docs mirrors are not products. Any registry derived by
scanning directories **must** exclude paths whose `.git` is a file rather than a
directory.

---

## 2. Transport

**One way in: the signed admin API gateway.**

```
console → /api/admin/apps/{slug}/gw/{path}  → HMAC-signed → product /admin/{path}
```

Kora is the reference implementation: zero database access from the console, every
read and write an HMAC-signed call with the admin's identity bound into the MAC, runtime
response validation, and typed error propagation preserving 400/401/403/404/409. It is
the best-engineered integration in the console and the cheapest to reason about.

### 2.1 Federated SQL is a legacy exception

Direct database reads (`lib/db/mark8ly*`, `lib/db/homechef-payouts`,
`lib/db/homechef-delivery`) are **grandfathered, not permitted**. A new product may not
choose them. Existing federated reads stay until the owning product exposes an equivalent
endpoint; each one is tracked as debt with a named owner.

Rationale: federated SQL couples the console to another product's schema. Every migration
in that product becomes a potential console outage, and the console's credentials become
a standing cross-product data-access grant.

### 2.2 Identity

The gateway binds the acting admin's identity into the signature. Products **must** use
the propagated identity for audit attribution and **must not** accept an actor identity
from the request body. Kora already does this correctly.

---

## 3. Required endpoints

Five endpoints make a product manageable. A product implementing none of them gets a
Launchpad tile and nothing else — which is a legitimate outcome for something like
tesserix-social.

### 3.1 `GET /admin/kpis`

Returns a flat map of headline business metrics.

```
{ "chefs_active": 412, "orders_today": 1877, "gmv_today": 984200 }
```

Feeds the Launchpad tile and the Business section. Keys are product-defined; the console
renders label and format from the registry.

**Unknown products must not silently return `{}`.** The current KPI route branches on
three products and falls through to an empty object, which is why dwellm8 has rendered
four em-dashes since launch. Return `501 not_implemented` so the console can say
"not instrumented" rather than showing dashes that look like zeroes.

### 3.2 `GET /admin/inbox` — the load-bearing one

Returns everything waiting on a human, in one shape:

```
{
  "items": [{
    "id": "uuid",
    "kind": "chef_approval",
    "title": "Sunita's Kitchen",
    "subtitle": "FSSAI expires in 3 days",
    "waiting_since": "2026-08-12T09:31:00Z",
    "due_at": "2026-08-19T09:31:00Z",
    "severity": "normal",
    "href": "/admin/directory/chefs/abc123",
    "actions": [{ "id": "approve", "label": "Approve", "destructive": false }]
  }],
  "total": 12
}
```

**This is what makes the console's front door possible without per-product knowledge.**
Today the Inbox would need to know that HomeChef calls them "approvals", mark8ly calls
them "onboarding sessions", devai calls them "approval gates", and dwellm8 calls them
"listing moderation". Under the contract, each product answers one question — *what is
waiting on a human?* — in one shape.

`due_at` is required where an SLA exists. Two known queues have real SLAs that nothing
surfaces today: devai's `approval_gates` expire after **one hour**, and mark8ly's
`sea_manual_review_queue` carries a **five-business-day** `sla_due_at` that pauses a
subscription clock.

### 3.3 `GET /admin/audit-logs`

Paginated audit trail using the standard envelope (§4.1). Filters: `action`, `actor`,
`resource_type`, `from`, `to`.

**Must be scoped to the calling product.** The existing shared route validates its
`:product` parameter and then queries mark8ly's table regardless — so the HomeChef,
DevAI, Dwellm8 and Kora overviews all display mark8ly's critical-event count. A route
that ignores its own scope parameter is worse than no route.

### 3.4 `GET /admin/entities/{type}`

Searchable records for the Directory and ⌘K. `type` is product-defined (`users`,
`chefs`, `orders`, `foods`). Supports `q`, and returns the standard envelope.

This is a coverage fix, not a nicety: global search today reaches only mark8ly-family
sources, so **a HomeChef or Kora user cannot be found from it at all**.

### 3.5 `GET /admin/health`

Self-reported dependency health — the things only the product knows (its own queue
depths, third-party integrations, worker liveness). Not a substitute for cluster
telemetry.

---

## 4. Conventions

Stated once so they stop being renegotiated per endpoint.

### 4.1 Pagination envelope

```
{ "data": [...], "pagination": { "page": 1, "limit": 50, "total": 320 } }
```

One shape. No flat `{logs, total, page, limit}` variants.

Note for consumers: the console's existing `DataTable` is 100% client-side and has no
`totalCount` or `onPageChange`. `ConsoleDataTable` is being built against this envelope.

### 4.2 Money

**Always minor units, always with an explicit currency.**

```
{ "amount": 98420, "currency": "INR" }
```

Never a bare number. The paise/rupee/USD split across three console pages is a live
footgun, and `console-core` will carry a money type that makes a bare number
unrepresentable.

### 4.3 Timestamps

ISO 8601, UTC, with offset. `waiting_since`, `due_at`, `created_at`, `updated_at`.

### 4.4 Errors

```
{ "error": "not_found", "message": "Chef abc123 does not exist" }
```

`error` is a stable machine-readable code; `message` is for humans. Preserve HTTP
semantics — 409 for optimistic-concurrency conflicts, as Kora already does.

### 4.5 Empty is not error

An endpoint with no rows returns `200` with an empty `data` array. It must never return
`null`, and the gateway must never substitute `{}` — the console already fixed one
production crash caused by exactly that, where a Go `nil` slice became `{}`, defeated
every caller's `?? []`, and crashed pages precisely when they had no data.

### 4.6 Route identity

`console-core` owns route identity. Products do not choose console URLs. This is what
prevents the current `mediation` vs `messaging` vs `audit-log` vs `audit-logs` drift
between web and mobile.

---

## 5. Conformance

**A document alone produces exactly the drift it describes.** The enforcement mechanism
is the deliverable.

The console ships `@tesserix/admin-conformance`: a test suite a product runs against its
own admin API in CI.

```
npx @tesserix/admin-conformance --base $ADMIN_API_BASE --slug homechef
```

It asserts:

- Each implemented endpoint returns the declared shape
- The pagination envelope matches §4.1 exactly
- Money fields carry a currency and are integers
- Timestamps parse as ISO 8601 with offset
- Empty results are `200` + `[]`, never `null` or `{}`
- Errors carry a stable `error` code
- `/admin/audit-logs` scopes to the calling product (assert a foreign product's rows
  are absent)
- `/admin/inbox` items carry `waiting_since`, and `due_at` where an SLA is declared

A product declares which endpoints it implements; the suite skips the rest and **fails on
any implemented endpoint that deviates**. Partial implementation is legitimate;
silent deviation is not.

Kora and HomeChef are the first two conformance targets — which also proves the contract
is implementable rather than aspirational.

---

## 6. Adoption

The contract binds differently depending on where a product already is.

| Situation | Requirement |
|---|---|
| **New product** | Full contract before first console surface. Non-negotiable — this is where consistency is free |
| **Existing, being ported in M2** | Conformance on endpoints it already has; `/admin/inbox` added if it has a human queue |
| **Existing, not yet touched** | `/admin/inbox` only, if it has a queue. Everything else waits for its M2 batch |
| **No console presence** | Launchpad tile from registry metadata. No endpoints required |

`/admin/inbox` is the one endpoint worth asking for ahead of a product's migration batch,
because M1's unified Inbox depends on it and because the queues it exposes are the ones
currently invisible.

### Honest cost

This asks product teams for endpoints they do not have today, in **their** repos —
outside the console redesign's no-Go-service-changes constraint. Two mitigations: the
console keeps its grandfathered federated reads until a product ships its endpoints, so
nothing regresses while teams adopt; and `/admin/inbox` is usually a thin query over a
table that already exists, since every queue found in the audits already had a status
column and a timestamp.

---

## 7. Open problem: platform-admin authorization

**The contract cannot currently express who may act.**

`IsPlatformOwner` bypasses all OpenFGA checks and is derived from a Firebase tenant-name
prefix match on `"platform"`. Platform-admin is binary and all-or-nothing; only
store-scoped `can_*` relations are modellable. Console-side, admin identity is a flat
`ALLOWED_ADMIN_EMAILS` env allowlist.

Consequences:

- A roles/team-management surface (BACKLOG H3) cannot be built meaningfully.
- This contract cannot say "only a payments admin may resolve a payout hold", because
  that distinction does not exist anywhere in the platform.
- Every conformance-passing endpoint is reachable by every platform admin.

Several shared services compound this by having authentication with **no** authorization
at all — subscription-service's entire `/admin` group among them.

**This needs its own design.** Until it lands, the contract governs *shape*, not
*permission*, and that limitation should be explicit rather than discovered.

---

## Changelog

- **v1** (2026-08-14) — initial draft, derived from the console redesign audits.
