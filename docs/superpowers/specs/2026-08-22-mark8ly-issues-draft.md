# Mark8ly issues — FILED 2026-08-22

**Status:** all 17 filed in `tesserix/mark8ly` as **#274–#290**. This file is now
the record of what was asked and why; the issues themselves are authoritative.

**Date:** 2026-08-22
**Source:** `2026-08-22-mark8ly-console-integration-design.md` §5
**Contract:** `2026-08-14-product-admin-integration-contract.md` (v2)
**Target repo:** `tesserix/mark8ly`

## Filed issue map

| draft | filed | title |
|---|---|---|
| Issue 0 | [#274](https://github.com/tesserix/mark8ly/issues/274) | decide the platform admin front door |
| Issue 1 | [#275](https://github.com/tesserix/mark8ly/issues/275) | gateway calls with operator identity and capability |
| Issue 2 | [#276](https://github.com/tesserix/mark8ly/issues/276) | `GET /admin/audit-logs` cross-store |
| Issue 3 | [#277](https://github.com/tesserix/mark8ly/issues/277) | `GET /admin/entities/tenants` + detail |
| Issue 4 | [#278](https://github.com/tesserix/mark8ly/issues/278) | `GET /admin/entities/users` |
| Issue 5 | [#279](https://github.com/tesserix/mark8ly/issues/279) | `GET /admin/conversions?email=` |
| Issue 6 | [#280](https://github.com/tesserix/mark8ly/issues/280) | `GET /admin/inbox` |
| Issue 7 | [#281](https://github.com/tesserix/mark8ly/issues/281) | inbox actions + mount fast-path review |
| Issue 8 | [#282](https://github.com/tesserix/mark8ly/issues/282) | `GET /admin/kpis` |
| Issue 9 | [#283](https://github.com/tesserix/mark8ly/issues/283) | `GET /admin/onboarding/*` |
| Issue 10 | [#284](https://github.com/tesserix/mark8ly/issues/284) | `GET /admin/billing/subscriptions` |
| Issue 11 | [#285](https://github.com/tesserix/mark8ly/issues/285) | `GET /admin/billing/trials` |
| Issue 12 | [#286](https://github.com/tesserix/mark8ly/issues/286) | `POST .../trials/{id}/extend` |
| Issue 13 | [#287](https://github.com/tesserix/mark8ly/issues/287) | tenant suspend / unsuspend |
| Issue 14 | [#288](https://github.com/tesserix/mark8ly/issues/288) | tenant purge |
| Issue 15 | [#289](https://github.com/tesserix/mark8ly/issues/289) | `GET /admin/health` |
| Issue 16 | [#290](https://github.com/tesserix/mark8ly/issues/290) | conformance suite in CI |

> **Filing note, for next time.** `gh issue create` fails when run from inside a
> shell script in this estate and works as a direct command; the EMU error it
> prints is misleading. These were filed one at a time as direct commands.

---

## Issue 0 — decide the platform front door (discussion, not a PR)

**This is the one question the console cannot answer for mark8ly**, and it gates
the shape of everything below.

The contract addresses a *product* at one base URL (`admin_api_base`). Mark8ly's
platform-relevant data is split across two services:

| data | service |
|---|---|
| tenants, onboarding sessions, invitations, verifications | `platform-api` |
| audit logs, subscriptions, trials, erasure, SEA queue, fast-path, arbitrage, break-glass, stores | `marketplace-api` |

So one of these has to be the front door and reach the other, or the console has
to learn that mark8ly is two products — which it is not.

Recommendation, weakly held because this is mark8ly's topology to choose:
**`marketplace-api` fronts `/admin/*`**, since most of the data and the existing
`/admin/` tree and `internalsvc` boundary already live there, and it calls
`platform-api` for tenant and onboarding reads. A client in that direction is
less established than the reverse (`platform-api/internal/marketplaceapi/`
exists), so the opposite choice is defensible.

**Whatever is chosen, one base URL.** Two would make the console's per-product
client registry a per-service registry, which is the abstraction leak the
contract exists to prevent.

---

## Issue 1 — Accept platform gateway calls: verify signature, bind operator identity and capability

**Size:** S · **Blocks:** every issue below

The Tesserix platform console is moving off direct database access to mark8ly
(`mark8ly_platform_admin` grant is being retired) onto mark8ly's own HTTP
surface. Platform calls arrive signed, carrying the acting operator's identity
and the capability they are exercising.

Mark8ly has the trust primitive already — `internalsvc.RequireInternalAuth`
(`services/marketplace-api/internal/handlers/internalsvc/`) and the identical
`middleware.RequireInternalAuth` in `platform-api`. What it does not have is an
**actor**: `X-Internal-Auth` is one shared secret, so anything written under it
lands in the audit log attributed to "the platform", which is the same as
unattributed.

**Build:**
- A middleware for the platform admin surface that verifies the gateway
  signature and extracts `operator_id` and `capability`.
- Both written into every audit row the request produces.
- Reject a write that arrives with no capability. Do **not** infer one —
  authority is asserted upstream; mark8ly records it and refuses its absence.

**Acceptance:**
- A platform-originated write produces an audit row naming the operator, not the
  service.
- A request with a valid secret but no operator identity is refused on write
  paths, and permitted on read paths.
- Replay of a captured signed request outside its validity window is refused.

**Refs:** contract §2.2, §8.4.

---

## Issue 2 — `GET /admin/audit-logs`: cross-store, product-scoped

**Size:** M · **Unblocks:** the console's audit pilot; the mark8ly leg currently served by `apps/web`

`AuditLogsHandler` is mounted store-scoped only
(`services/marketplace-api/internal/handlers/admin/routes.go`, the
`/audit-logs` group under `storeRoute`). The console needs mark8ly's rows across
every store, as one source in an estate-wide timeline.

**Build:** `GET /admin/audit-logs` returning the standard envelope, filters
`action`, `actor`, `resource_type`, `from`, `to`, plus `store_id` as an optional
narrowing filter rather than a required scope.

**Acceptance:**
- Rows span stores; no `storeId` path parameter.
- Envelope is `{ "data": [...], "pagination": { page, limit, total } }` exactly —
  not the flat `{logs, total, page, limit}` variant.
- Empty result is `200` with `[]`, never `null` and never `{}`. (A Go `nil` slice
  serialised as `{}` has already crashed a console page in this estate, precisely
  when there was no data.)
- Timestamps ISO 8601 with offset.

**Refs:** contract §3.3, §4.1, §4.5.

---

## Issue 3 — `GET /admin/entities/tenants` and `/admin/entities/tenants/{id}`

**Size:** M · **Unblocks:** the console's Tenants surface; `tenant_names` enrichment

`platform-api/internal/tenant/handler.go` serves `listMyTenants` (caller-scoped)
and `getTenant`. Neither answers "every tenant on this platform, filterable".

**Build:** searchable directory with `q`, filters on status and created range,
plus a detail endpoint carrying a store rollup (count, and per-store status).

**Acceptance:**
- Standard envelope; `q` matches name, slug and owner email.
- Detail returns stores without a second round trip per store.
- No caller-scoping: this is the platform view.

**Refs:** contract §3.4.

---

## Issue 4 — `GET /admin/entities/users`

**Size:** S · **Unblocks:** estate-wide identity lookup and global search coverage

The console's global search reaches mark8ly-family sources only, so a user in
another product cannot be found — and the reverse gap applies here as mark8ly's
own users become reachable through one contract rather than a bespoke query.

**Scope deliberately: staff and operators, not merchants' end customers.** The
console does not query end users for any product today; that is a per-product
opt-in decision recorded in `console-core`'s `EstateProduct.endUserLookup`, and
mark8ly has not made it. Do not include customer records in this endpoint.

**Acceptance:** standard envelope; `q` matches email and name; no customer rows.

**Refs:** contract §3.4; `packages/console-core/src/estate.ts` on `endUserLookup`.

---

## Issue 5 — `GET /admin/conversions?email=`

**Size:** S · **Unblocks:** the CRM conversion column, blank today for every product

The platform CRM tracks leads and needs to know whether a lead's email has become
a tenant. The console already calls a `conversion-status` route through
`apps/web`; it has never been implemented for any product, so every conversion
signal currently resolves to `unknown`.

**The response semantics are load-bearing and were designed around a real trap.**
`404` cannot mean "not converted", because `404` is also what a framework returns
for a route that does not exist — the two are indistinguishable on the wire.

- `200 { "state": "converted", "ref": "<tenant id>", "label": "<tenant name>", "observed_at": "..." }`
- `200 { "state": "none" }` — the **only** honest way to assert not-converted
- anything else — the console reads as `unknown` and says so

**Acceptance:** a known-converted email returns `converted` with a resolvable
`ref`; an unknown email returns `200 { "state": "none" }`, not `404`.

**Refs:** `apps/console/lib/crm-conversion.ts` (RULING 28).

---

## Issue 6 — `GET /admin/inbox`: everything waiting on a human

**Size:** L · **Unblocks:** the CSM queue, erasure queue and appeals — none of which have an interface anywhere today

The single load-bearing contract endpoint. One shape for every queue, so the
console's front door needs no per-product knowledge.

**Kinds mark8ly must emit:**

| kind | source | note |
|---|---|---|
| `sea_manual_review` | `sea_manual_review_queue` | **`due_at` REQUIRED** — see below |
| `migration_fast_path` | `services/marketplace-api/internal/billing/migration` | see Issue 7 |
| `erasure_request` | `customer_erasure_requests` | append-only, no reader exists |
| `arbitrage_appeal` | `services/marketplace-api/internal/arbitrage` | |
| `onboarding_stalled` | `platform-api` onboarding sessions | idle beyond threshold |

**`sea_manual_review` is the urgent one.** Migration `000065` states it plainly:
entering that queue *immediately pauses the 14-day validation clock on the
associated subscription*, it carries a hard 5-business-day `sla_due_at`, and
sustained volume is supposed to trigger a capacity alert. Nothing reads the
table. A queue that silently pauses billing and that no one can see is the
strongest single argument for this endpoint.

Emit `sla_due_at` as `due_at`. Items with `status IN ('pending','in_review')`.

**Item shape** is contract §3.2 exactly: `id`, `kind`, `title`, `subtitle`,
`waiting_since`, `due_at`, `severity`, `href`, `actions[]`.

**Acceptance:**
- `waiting_since` on every item; `due_at` on every `sea_manual_review` item.
- `actions` lists only what a platform operator may actually invoke (Issue 7).
- Resolved items are absent, not returned with a resolved status.

**Refs:** contract §3.2; `services/marketplace-api/migrations/000065_sea_manual_review_queue.up.sql`.

---

## Issue 7 — `POST /admin/inbox/{id}/actions/{actionId}`, and mount the fast-path review route

**Size:** M · **Depends on:** Issue 6

Two things, together because the second is the first's most valuable instance.

**(a) Action execution.** Contract v1 let inbox items *declare* `actions` and
gave no way to invoke one, so a queue could describe work nobody could do.

- The action id must be one that item declared. Reject an action absent from the
  item's own `actions` array, even if mark8ly implements it — otherwise the
  declared list is documentation, not a contract, and the console cannot render
  safely from it.
- Destructive actions require an idempotency key: a queue action retried after a
  timeout must not fire twice.

**(b) Mount the fast-path review route.**
`services/marketplace-api/internal/handlers/admin/routes.go:779` carries:

```
// TODO: /internal/csm/migration-fast-path/:id/review wiring deferred —
// the /internal/ group and HeaderTrustAuth chain are not mounted here.
```

`migration.Handler.Review` exists and has tests
(`internal/billing/migration/handler.go:122`). The route is not mounted, so the
CSM review step is unreachable by any caller. Issue 1's middleware is the chain
that was missing.

**Acceptance:** an operator can approve or reject a fast-path submission through
the inbox, the decision is attributed to that operator, and a duplicate submit
with the same idempotency key is a no-op.

**Refs:** contract §3.2, §8.3.

---

## Issue 8 — `GET /admin/kpis`

**Size:** S

Headline counters for the console's Launchpad tile: active tenants, stores,
GMV, onboarding in flight, trials expiring.

**Do not return `{}` for anything uninstrumented — return `501 not_implemented`
per key or for the endpoint.** The console's existing KPI route falls through to
an empty object for unrecognised products, which is why one product has rendered
four em-dashes since launch: dashes that look like zeroes. "Not instrumented" and
"zero" must be distinguishable.

Money obeys §4.2 without exception: minor units, explicit currency.

**Refs:** contract §3.1, §4.2.

---

## Issue 9 — `GET /admin/onboarding/funnel` and `/admin/onboarding/sessions`

**Size:** M

The data exists in `platform-api/internal/onboarding` (sessions, verifications,
invitations) with no endpoint over it.

- `funnel` — started, email verified, completed, in flight, abandoned, median
  time to complete, last 24h started/completed.
- `sessions` — rows with status, idle hours, and an abandoned flag.

**Acceptance:** counters and rows agree with each other for the same window;
standard envelope on `sessions`.

---

## Issue 10 — `GET /admin/billing/subscriptions`: cross-tenant

**Size:** L · **The riskiest issue here**

Mark8ly's subscription surface is per-store
(`/admin/stores/:storeId/subscription`), and plans are Go descriptors in
`internal/billing/pricing/catalog.go` rather than DB rows. So "every
subscription across every tenant, with plan and status" may need a projection
rather than a query — this may be more than adding an endpoint, and the console
plan sequences it late for that reason.

Status vocabulary is already defined in
`services/marketplace-api/internal/subscription/models.go` (`trialing`,
`active`, `past_due`, `expired`). Do not invent a second one for this view.

**Acceptance:** standard envelope; filters on status and plan; money in minor
units with currency; one row per subscription with its tenant and store.

---

## Issue 11 — `GET /admin/billing/trials`: expiring, with dunning state

**Size:** M

"Which trials expire this week" is unanswerable anywhere in the estate today,
and it is the single most-requested platform view in the console backlog.

**Acceptance:** `?days=` window; each row carries trial end, current dunning
state, and the tenant it belongs to; ordered by soonest expiry.

---

## Issue 12 — `POST /admin/billing/trials/{id}/extend`

**Size:** S · **Depends on:** Issue 1

A platform-side trial extension, attributed to the operator who granted it.

**Acceptance:** requires a reason; the extension and its reason appear in
mark8ly's audit log against the operator; extending an already-converted
subscription is refused rather than silently ignored.

---

## Issue 13 — `POST /admin/tenants/{id}/suspend` and `/unsuspend`

**Size:** M · **Depends on:** Issue 1

Tenant lifecycle is a platform act with no endpoint. Reason codes are required,
not free text alone — an audit row saying *what* without *why* is the gap this
whole integration exists to close.

**Acceptance:** reason code from a defined set, plus optional free text; both in
the audit row with the operator; suspending an already-suspended tenant is a
no-op returning current state, not an error and not a double-write.

---

## Issue 14 — `POST /admin/tenants/{id}/purge`

**Size:** M · **Depends on:** Issue 1 · **Irreversible**

`services/marketplace-api/internal/tenantpurge/purge.go` exists with no
operator-facing entry point.

**Confirmation semantics are required**, per contract §8.3: the request carries
the tenant's current identifying state (slug, and expected store count), and the
purge is refused on mismatch. This is what stops a stale console tab from purging
a tenant that changed since the page was rendered.

**Acceptance:** mismatch is refused with `409`; a successful purge is audited
with the operator, the confirmation values supplied, and what was destroyed.

---

## Issue 15 — `GET /admin/health`

**Size:** S

Self-reported dependency health — queue depths, third-party integration status,
worker liveness. The things only mark8ly knows.

Not a substitute for cluster telemetry, and not the same as `/health` or
`/ready`, which answer "is this process alive" rather than "is this product
working".

---

## Issue 16 — Wire `@tesserix/admin-conformance` into CI

**Size:** S · **Depends on:** the console shipping the package

```
npx @tesserix/admin-conformance --base $ADMIN_API_BASE --slug mark8ly
```

Asserts the envelope, money-with-currency, ISO-8601 timestamps, empty-is-`[]`,
stable error codes, product-scoped audit rows, and `waiting_since` / `due_at` on
inbox items. Mark8ly declares which endpoints it implements; the suite skips the
rest and fails on any implemented endpoint that deviates.

**Blocked on the console side.** The package is specified in contract §5 and does
not exist yet. Filing the fifteen endpoint issues against a contract nothing
enforces is how v1's conventions became optional in the first place — so this
issue should be filed with the others and stay open as the visible debt.

---

## Not filed, deliberately

**Arbitrage appeals as a dedicated surface.** Real, but `/admin/inbox` already
carries the appeal queue as a `kind`. Reassess after the inbox lands.

**White-label app credentials.** Real, has runbooks
(`docs/runbooks/white-label-app-*.md`), and is the thinnest of the three
mark8ly-specific surfaces. Reassess with the above.

**Plan and promo authoring.** `BACKLOG.md` §P proposes moving Stripe-write
authority out of mark8ly to the platform. Separate spec — it touches real
billing, and folding it in would put a revenue outage inside a console migration.
