# Bringing Mark8ly into the platform console

**Status:** draft for review
**Date:** 2026-08-22
**Amends:** `2026-08-14-product-admin-integration-contract.md` (to v2)
**Resolves:** DECISION 1 in `2026-08-21-console-off-direct-data-access.md`

## What this is

Mark8ly is the largest product in the estate and the one the console knows
least well. `estate.ts` reserves a rail context for it (`context: "mark8ly"`,
`migrated: false`) and nothing fills it. Meanwhile the console's two remaining
runtime dependencies on `apps/web` — the audit fan-out and the CRM conversion
lookup — are both *mark8ly* reads wearing a legacy proxy.

This document says which mark8ly capabilities the console gets, where they sit
in the IA, what mark8ly has to build, and in what order.

It does not restate the integration contract. Three of the four domain
contracts this design started with turned out to be already specified there,
generically and better; what survives is recorded in §4 as a v2 amendment.

## 1. Decisions

Taken in conversation on 2026-08-22, recorded here because each one closed a
fork that the existing documents left open.

### D1 — API-first. No cross-database grant.

The console reaches mark8ly through mark8ly's own HTTP surface, never through
its database. This resolves **DECISION 1** in the off-direct-data-access spec:
`platform-api` does **not** inherit `apps/web`'s `mark8ly_platform_admin` grant.

The reason is not tidiness. Mark8ly was not designed for platform integration —
its admin API is `/admin/stores/:storeId/*` almost end to end, and the platform
questions the console asks ("which trials expire this week", "which erasure
requests are outstanding") have no store to scope to. A federated read does not
fix that; it hides it. The console would compensate in TypeScript for a boundary
mark8ly never drew, and the compensation is invisible from mark8ly's side, so
nobody there knows when they have broken it. Migrations in this estate are
manual while deploys are not, so the break lands unattended.

The cost is real and is accepted: surfaces blocked on mark8ly-owned endpoints
wait for mark8ly. §6 sequences around that rather than pretending it away.

A federated read remains defensible in exactly one shape — an append-only, wide,
high-volume record whose schema is frozen — and even then only as a stopgap with
an issue open behind it. No such stopgap is proposed here.

### D2 — The console is a platform-owner surface. It is not a merchant surface.

The console never grows a per-store product editor, order list, coupon builder
or category tree. That is mark8ly's admin; it exists, it is maintained, and
duplicating it would mean every merchant feature ships twice.

This is permanent, not a v1 scoping compromise.

### D3 — Contract-first, with mark8ly as first implementer.

Endpoints are defined product-agnostically wherever a second implementer is
visible, and mark8ly-specific only where none is.

The evidence for the second implementer, probed across the estate:

| concept | mark8ly | Fe3dr | Dwellm8 | Kora | verdict |
|---|---|---|---|---|---|
| audit trail | yes | yes | yes | yes | universal |
| tenant lifecycle | yes | yes | yes | — | strong |
| onboarding funnel | yes | yes | — | yes | strong |
| subscription / billing | yes | yes | weak | — | two implementers |
| erasure / compliance queue | yes | yes | — | — | two implementers |

No contract except audit is universal, and the second implementer differs per
contract. So contracts are **opt-in per product**, not a single bundle a product
either implements or does not.

### D4 — Contracts are declared, not discovered.

`EstateProduct` gains an optional `contracts` field. Absence means the product
implements none — the same absence-means-no mechanism as `endUserLookup`, and
for the same reason recorded there: exclusion by absence cannot be forgotten,
whereas a denylist gets edited by whoever is adding a product in a hurry.

The rail renders only declared contracts. Mark8ly's rail *is* its declaration,
and Fe3dr's later declaration costs the console one line.

## 2. Where surfaces live

The rule, which decides the hard cases rather than the easy ones:

> **A surface belongs on the platform rail when the operator's question spans
> products. It belongs on a product rail when the question presupposes the
> product.**

When that is ambiguous, the decisive test: *can two products' rows sit in one
table without a column meaning something different in each?* Erasure requests —
yes, identical shape. Mark8ly's geo-pricing arbitrage appeal — there is no
second product with one.

This is the same rule `nav.ts` already applies without naming it: #133 folded
support analytics into a Tickets tab, #139 folded Kora's audit trail into the
estate-wide audit log, both because a second door onto one capability is worse
than one door.

### 2.1 The platform rail gains four entries

All product-filtered.

| entry | group | why estate-shaped |
|---|---|---|
| Tenants | Operate | every product has them, identical shape; sibling of Identity lookup |
| Onboarding funnel | Growth | the four counters mean the same everywhere, and *lead → onboarding session → tenant* is one pipeline currently split across three places |
| Subscriptions | Revenue (new group) | mark8ly and Fe3dr both bill; "which tenants pay us" spans |
| Trials & dunning | Revenue | "which trials expire this week" is meaningless scoped to one product |

**Revenue is a new top-level group**, not an addition to Growth. Growth is
bringing tenants in; Revenue is what existing tenants pay and whether they are
paying it. `nav.ts` already draws that line between Operate and Growth for the
same reason.

### 2.2 The platform rail gains nothing else

`platform.gdprQueue` and `platform.breakGlass` **already exist** in the
Governance group. An earlier draft of this design proposed mark8ly copies of
both; that was wrong, and is recorded here so it is not proposed again. Audit,
tickets, live chat, outbox and notification log likewise already exist
estate-wide. Mark8ly becomes a **source** in each, never a copy of each.

### 2.3 The mark8ly rail is three entries

| entry | why product-shaped |
|---|---|
| CSM queue — migration fast-path review | mark8ly's migration offer is its own commercial product; nothing else has one |
| Arbitrage appeals — geo-pricing | one implementer; the appeal presupposes mark8ly's pricing model |
| App credentials — white-label Apple/Google | mark8ly-only add-on with its own runbooks |

`estate.ts` records `entries: 8` for Mark8ly. That number was read off
`apps/web`'s rail on 2026-08-15, and that rail is being retired. **It is revised
to 3** rather than padded to meet a count derived from the thing being replaced.

## 3. Architecture

Three layers. The middle one is new.

```
apps/console          renders; knows contracts, never products
      |  HTTP, operator Zitadel token + capability
platform-api          THE AGGREGATOR (new: federation module)
      |  HTTP, signed, operator identity bound
mark8ly / fe3dr / …   each implements the contracts it declares
```

**The console calls `platform-api` and nothing else.** It already does, through
`lib/platform-api.ts`. One auth model, one error shape, one place a product
outage is caught and reported as a partial result.

**`platform-api` grows a `federation` module** alongside `aiusage`, `crm`,
`tickets` and `tools`: contract definitions, the per-product client registry,
the fan-out, and the partial-failure envelope. That envelope is
`{ data, failures: [{ product, error }] }` — the shape `lib/audit.ts` already
consumes, so this adopts a proven envelope rather than inventing one.

### 3.1 The apps/web dependencies this removes

Both are mark8ly reads:

- `lib/platform-api.ts:615` → `/api/admin/apps/:product/audit-logs`
- `lib/crm-conversion.ts:235` → `/api/admin/apps/:product/conversion-status`

The second has never been built for any product — its own comment says so — so
every conversion signal in the CRM handoff queue resolves to `unknown` today.
The column is blank by construction, not by data.

`lib/crm-conversion.ts:189` carries the comment *"the console never talks to a
product directly, only ever to apps/web."* That sentence becomes false when this
lands and must be rewritten, not left to mislead.

### 3.2 Operator identity across the boundary

Contract §2.2 requires the acting operator's identity to be bound into the
signature and forbids products from taking an actor identity from the request
body. That is unchanged and correct.

What v1 could not express is **authority**: §7 records that platform-admin was
binary, so the contract governed shape and not permission. That is no longer
true. `packages/platform-auth/src/capabilities.ts` carries eleven capabilities,
`routes.ts` requires one per route (a *required* field since #261, because an
optional one defaulting to `read` meant 26 of 30 routes silently admitted every
operator), and `platform-api` enforces `RequireCapability`.

So the propagated identity now carries the capability exercised, and mark8ly
writes both into its own audit rows. The console writes the same action into
`console_audit_log`. Two records of one action, joinable on operator and
timestamp — which is what makes "who did this" answerable from either side.

`X-Internal-Auth` alone is insufficient for writes: it is one shared secret with
no actor, so a suspension or a purge would land in mark8ly's audit log
attributed to "the platform", which is the same as unattributed — worse than
today, because today those actions cannot be taken at all.

## 4. What mark8ly implements

Against the contract's endpoints, not bespoke ones. This is the correction that
shrank this design: `/admin/inbox` alone replaces four separate queue APIs an
earlier draft proposed, and it is explicitly designed for it — the contract
names *"mark8ly calls them onboarding sessions"* as a case it exists to solve.

| contract endpoint | mark8ly today | what is needed |
|---|---|---|
| `GET /admin/kpis` | none | tenants active, stores, GMV, in-flight onboarding, trials expiring |
| `GET /admin/inbox` | none | kinds: `migration_fast_path`, `sea_manual_review`, `arbitrage_appeal`, `erasure_request`, `onboarding_stalled` |
| `GET /admin/audit-logs` | store-scoped only | cross-store, product-scoped, standard envelope |
| `GET /admin/entities/{type}` | none | `tenants`, `users`; plus `/{id}` detail |
| `GET /admin/health` | `/health`, `/ready` | self-reported dependency health |
| `GET /admin/billing/*` | store-scoped only | **new in v2** — see §4.1 |

`due_at` matters here specifically: mark8ly's `sea_manual_review_queue` carries
a five-business-day SLA that pauses a subscription clock, and nothing surfaces
it today.

### 4.1 Billing is the one genuinely new contract endpoint

A flat KPI map cannot express "which trials expire this week, with dunning
state, across tenants". That is domain-shaped, it is the largest cluster of gaps
in `MIGRATION-MATRIX.md` (eight separate rows), and it is `BACKLOG.md`'s
phase 2. Two implementers exist (mark8ly, Fe3dr), so it is a contract and not a
mark8ly endpoint.

### 4.2 Two gaps in contract v1, closed in v2

- **Inbox items declare `actions` but nothing says how to invoke one.** v2 adds
  `POST /admin/inbox/{id}/actions/{actionId}`.
- **v1 defines no write endpoints at all** beyond those implied actions. Tenant
  suspension and purge are not queue items and need domain writes. v2 adds a
  write section stating the capability and attribution requirements.

## 5. The mark8ly issue list

Sixteen, each sized as a mergeable PR, ordered so mark8ly can start at the top
without waiting on the console. Drafted in full at
`2026-08-22-mark8ly-issues-draft.md`.

Preceded by **Issue 0**, which is a discussion rather than a PR and which the
console cannot decide: mark8ly's platform-relevant data is split across two
services — tenants and onboarding in `platform-api`, everything else in
`marketplace-api` — so one of them must front `/admin/*` and reach the other.
The contract addresses a product at one base URL, and two would turn the
console's per-product client registry into a per-service registry.

Two findings from drafting them are worth surfacing here, because they change
how urgent this is rather than how it is built:

- **`sea_manual_review_queue` pauses billing and nobody can see it.** Migration
  `000065` states that entering the queue *immediately pauses the 14-day
  validation clock on the associated subscription*, with a hard five-business-day
  `sla_due_at`. No endpoint reads the table. This is the strongest single
  argument for `/admin/inbox`.
- **The CSM fast-path review step is unreachable by any caller.**
  `migration.Handler.Review` exists and is tested;
  `handlers/admin/routes.go:779` records that its route was never mounted
  because the `/internal/` group and `HeaderTrustAuth` chain are not there. The
  business process has a handler, tests, and no door.

| # | issue | size | blocks |
|---|---|---|---|
| 1 | Accept platform gateway calls: verify signature, bind operator identity + capability, write both to audit | S | everything |
| 2 | `GET /admin/audit-logs` — cross-store, product-scoped, standard envelope | M | console pilot |
| 3 | `GET /admin/entities/tenants` + `/{id}` — searchable directory with store rollup | M | Tenants rail entry |
| 4 | `GET /admin/entities/users` — closes global-search coverage | S | Identity lookup |
| 5 | `GET /admin/conversions?email=` — has this email become a tenant | S | CRM conversion column |
| 6 | `GET /admin/inbox` — the five queue kinds, with `due_at` on the SEA queue | L | CSM queue, erasure, appeals |
| 7 | `POST /admin/inbox/{id}/actions/{actionId}` — action execution | M | acting on any queue |
| 8 | `GET /admin/kpis` — headline counters; `501` when uninstrumented, never `{}` | S | Launchpad tile |
| 9 | `GET /admin/onboarding/funnel` + `/sessions` — counters and in-flight | M | Onboarding funnel |
| 10 | `GET /admin/billing/subscriptions` — cross-tenant | L | Subscriptions |
| 11 | `GET /admin/billing/trials` — expiring, with dunning state | M | Trials & dunning |
| 12 | `POST /admin/billing/trials/{id}/extend` | S | trial intervention |
| 13 | `POST /admin/tenants/{id}/suspend` + unsuspend, reason codes | M | tenant lifecycle |
| 14 | `POST /admin/tenants/{id}/purge` — operator entry to `tenantpurge` | M | tenant teardown |
| 15 | `GET /admin/health` — self-reported dependency health | S | Service health |
| 16 | Wire `@tesserix/admin-conformance` into CI | S | prevents drift |

Issue 1 first and alone: it is the foundation and it is small. Everything after
it parallelises.

Arbitrage appeals and white-label app credentials are not on the list. They are
real, but they are the thinner two of the three mark8ly-specific surfaces, and
`/admin/inbox` already carries the appeal queue as a `kind`. A dedicated surface
for either is reassessed after the queue lands.

## 6. Sequencing on the console side

**Audit is the pilot.** The contract is already designed, the renderer already
consumes it, and it is the surface currently standing on the app being deleted.
Landing it proves console → `platform-api` federation → mark8ly end to end with
zero design risk, and removes one of the two legacy dependencies.

1. **Audit re-homing.** Federation module in `platform-api`; `lib/audit.ts`
   stops pointing at `apps/web`. Needs mark8ly issues 1–2.
2. **Tenants + conversions.** Removes the second legacy dependency and unblocks
   the CRM conversion column. Needs 3–5.
3. **Inbox.** The CSM queue currently has no interface anywhere. Needs 6–7.
4. **Onboarding funnel.** Needs 9.
5. **Billing.** Largest ask, most likely to slip; deliberately last of the reads.
   Needs 10–12.
6. **Tenant lifecycle writes.** First destructive platform writes; last on
   purpose. Needs 13–14.

Each step keeps the dual path the off-direct-data-access spec requires (C9):
`PLATFORM_API_ORIGIN` unset stays byte-for-byte the old behaviour, so each phase
is revertible by removing one variable.

## 7. Changes to `console-core`

Small, but the package compiles into three apps, so each is a coordinated change.

- `EstateProduct` gains `contracts?: readonly ContractId[]` (D4).
- `ESTATE`'s Mark8ly entry: `entries` 8 → 3, `contracts` declared.
- `routes.ts` gains the four platform entries and three mark8ly entries, each
  naming its capability: Tenants `platform`, Onboarding funnel `platform`,
  Subscriptions `billing`, Trials & dunning `billing`, CSM queue `platform`,
  Arbitrage appeals `platform`, App credentials `rotate-credentials`.
- `nav.ts` gains the Revenue group and the mark8ly rail.
- `EstateProduct.migrated` and `RouteEntry.web` become vestigial once `apps/web`
  is marketing-only. Flagged, not blocked on; a cleanup pass of its own.

## 8. Risks

**Billing may be more than an endpoint.** Mark8ly's billing is per-store with
plan descriptors as Go constants rather than DB rows, so "cross-tenant
subscriptions" may need a projection rather than a query. If mark8ly pushes
back, billing is the contract that slips — which is why §6 puts it late and why
nothing else depends on it.

**The console depends on another repo's velocity.** This is the accepted cost of
D1. The mitigation is that the contract's own adoption section already permits
partial implementation: a product declares which endpoints it serves and the
console renders what is declared, so a slipping endpoint degrades one rail entry
rather than blocking the migration.

**Conformance does not exist yet.** `@tesserix/admin-conformance` is specified in
contract §5 and not built. Without it the contract governs by document alone,
which is the drift it exists to prevent. Issue 16 is mark8ly's side; the console
owes the package.

## 9. Non-goals

- **No per-store merchant surfaces**, ever (D2).
- **No second tickets queue, audit page or chat inbox** — estate-shaped surfaces
  stay on the platform rail (§2.2).
- **No plan or pricing authoring.** `BACKLOG.md` §P proposes moving Stripe-write
  authority out of mark8ly into the platform. That is a separate spec: it touches
  real billing, and folding it in would put a revenue outage inside a console
  migration.
- **No impersonation / "view as"** (`BACKLOG.md` F2, High risk).
- **No fixes to known CRM defects while porting.** Constraint C2 of the
  off-direct-data-access spec applies unchanged: #301, #226 and #248 are ported
  as they stand, each linked, each fixed as its own reviewed change on both
  sides.
