# Product Admin Integration Contract

> **Status**: v2 | **Date**: 2026-08-14, amended 2026-08-22
> **Companion to**: `2026-08-14-admin-console-redesign-design.md`
> **v2 amendments**: §8. They change §2 (transport) and §3 (endpoints), and
> close §7 (authorization). The original text of those sections is kept so
> the reasoning that produced it stays legible.

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

> **Amended in v2 (§8.1).** The gateway moves out of `apps/web`.

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

> **Amended in v2 (§8.2–§8.3).** Adds `/admin/billing/*`, inbox action
> execution, and domain writes.

Five endpoints make a product manageable. A product implementing none of them gets a
Launchpad tile and nothing else — which is a legitimate outcome for something like
tesserix-social.

### 3.1 `GET /admin/kpis`

> **Amended 2026-08-26 (§8.6).** The metrics map is wrapped in `data`. The
> shape below is current; the bare map it replaced is no longer conforming.

Returns a flat map of headline business metrics, under `data`.

```
{ "data": { "chefs_active": 412, "orders_today": 1877, "gmv_today": 984200 } }
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

**`metadata` is a STRING containing compact JSON of an object** — not prose, and
not a JSON object on the wire. See §8.7.

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

> **Closed in v2 (§8.4).** The capability model landed. This section is kept
> as the record of what was true on 2026-08-14, and why.

**The contract cannot currently express who may act.** Platform-admin is binary and
all-or-nothing; only store-scoped `can_*` relations are modellable, and console-side admin
identity is a flat allowlist.

The specifics were redacted before this repository was made public on 2026-08-14 and are
tracked privately at `tesserix/tesserix-infra` (issue #4).

Consequences that bind this contract:

- A roles/team-management surface (BACKLOG H3) cannot be built meaningfully.
- This contract cannot say "only a payments admin may resolve a payout hold", because that
  distinction does not exist anywhere in the platform.
- Every conformance-passing endpoint is reachable by every platform admin.

**This needs its own design.** Until it lands, the contract governs *shape*, not
*permission*, and that limitation should be explicit rather than discovered.

## 8. v2 amendments (2026-08-22)

Derived from `2026-08-22-mark8ly-console-integration-design.md`, which applied
this contract to mark8ly and found five places it did not yet reach.

### 8.1 Transport moves out of `apps/web`

§2 routes every call through `console → /api/admin/apps/{slug}/gw/{path}`. That
gateway lives in `apps/web`, which is being reduced to marketing pages. The
transport is otherwise unchanged — one signed gateway, identity bound into the
signature, no direct database access — but it is now served by the Go platform
API:

```
console → platform-api /v1/federation/{slug}/{path} → signed → product /admin/{path}
```

`platform-api` gains a `federation` module holding the contract definitions, the
per-product client registry, the fan-out and the partial-failure envelope
`{ data, failures: [{ product, error }] }`.

This is the same envelope `apps/console/lib/audit.ts` already consumes, so the
console-side shape does not change when the fan-out moves. That is deliberate:
it makes the re-homing of `/admin/audit-logs` a transport change with no
renderer change, which is why it is the pilot.

§2.1's ruling is unchanged and now has a resolved instance: `platform-api` does
**not** inherit `apps/web`'s `mark8ly_platform_admin` cross-database grant. This
closes DECISION 1 in `2026-08-21-console-off-direct-data-access.md`.

### 8.2 New required endpoint: `GET /admin/billing/*`

Five endpoints were enough to make a product *manageable*. They are not enough
to make it *legible as a business*, and the gap is specific: a flat `/admin/kpis`
map cannot express "which trials expire this week, with dunning state, across
tenants". That is a list with per-row state, not a headline number.

Two implementers exist (mark8ly, Fe3dr), so this is a contract endpoint rather
than a product-specific one.

```
GET /admin/billing/subscriptions   — cross-tenant, standard envelope (§4.1)
GET /admin/billing/trials          — expiring, with dunning state
POST /admin/billing/trials/{id}/extend
```

Money fields obey §4.2 without exception: minor units, explicit currency. This
is the endpoint most likely to be handed a bare number, because Stripe amounts
already arrive in minor units and the temptation is to pass them through
uncurrencied.

A product with no billing concept implements none of these. It must not return
`{}` or an empty list to mean "no billing" — that is indistinguishable from "no
subscriptions", which is a real and different answer. Return `501` per §3.1.

### 8.3 Writes: inbox actions, and domain writes

v1 defined no write path. §3.2's inbox items declare an `actions` array and
nothing said how to invoke one, so the load-bearing endpoint could describe work
but not let anyone do it.

**Inbox action execution:**

```
POST /admin/inbox/{id}/actions/{actionId}
```

The action id must be one the item itself declared. A product must reject an
action absent from that item's `actions` array rather than accepting any action
name it happens to implement — otherwise the declared list is documentation
rather than a contract, and the console cannot rely on it to render safely.

Destructive actions (`"destructive": true`) require an idempotency key. A queue
action retried after a timeout must not fire twice.

**Domain writes.** Some platform actions are not queue items — suspending a
tenant is not something waiting on a human, it is something a human decides. A
product exposing them uses ordinary REST under `/admin/`, with:

- the capability required, named per route, drawn from the vocabulary in §8.4;
- reason codes on anything reversible-but-consequential (suspend, unsuspend), so
  the audit row says *why* and not only *what*;
- confirmation semantics on anything irreversible (purge): the request carries
  the resource's current identifying state, and the product rejects a mismatch.

### 8.4 §7 closed — the authorization vocabulary exists

§7 recorded that platform-admin was binary, so this contract governed shape and
not permission, and every conformance-passing endpoint was reachable by every
platform admin.

That is no longer true. `packages/platform-auth/src/capabilities.ts` carries
eleven capabilities; `console-core`'s `routes.ts` requires one per route — a
*required* field since #261, because an optional one defaulting to `read` meant
26 of 30 routes silently admitted every operator; and `platform-api` enforces
`RequireCapability`.

So the contract can now say who may act, and does:

- **The gateway propagates the capability exercised**, alongside the operator
  identity §2.2 already binds into the signature.
- **Products write both into their own audit rows.** The console writes the same
  action into `console_audit_log`. Two records of one action, joinable on
  operator and timestamp, so "who did this" is answerable from either side.
- **A shared secret alone is insufficient for writes.** `X-Internal-Auth` carries
  no actor, so a write authenticated by it lands attributed to "the platform",
  which is the same as unattributed.
- **Products must not infer authority.** The capability is asserted at the
  gateway and by the console route; a product treats it as a fact to record, and
  refuses a request that arrives without one, rather than deciding for itself
  what an operator may do.

The limitation that remains, stated so it is not rediscovered: capabilities are
estate-wide, not per-product. There is no way to express "may act on mark8ly but
not on Fe3dr". That is a smaller open problem than §7's, and it is not blocking.

### 8.7 `/admin/audit-logs`: `metadata` is JSON-in-a-string

The shape pinned on mark8ly#276 described `metadata` as `"optional free text"`.
That reads as prose, and mark8ly — whose column is `jsonb` — asked twice which
was meant before filing #313. Stated properly here so the next implementer does
not have to ask.

**`metadata` is a string. Its content is compact JSON of a flat-ish object.**

```json
"metadata": "{\"plan\":\"pro\",\"previous_plan\":\"starter\"}"
```

This is not an encoding anyone needs to invent — it is what the estate already
produces, from two places:

- `apps/web/lib/audit/entry.ts`'s `stringifyMetadata` —
  `JSON.stringify(Object.fromEntries(kept))`, dropping `null`, `undefined` and
  `""` values, returning `undefined` when nothing survives
- `apps/console/lib/db/audit-repo.ts`'s `serialiseSummary`, for the console's
  own rows

Rules:

- **Omit the field when there is nothing to say.** Not `"{}"`, not `""`.
- **Drop empty values before stringifying**, as `stringifyMetadata` does.
- **Nested values are fine.** kora's and homechef's `before`/`after` diffs
  already arrive as nested objects inside the string.
- **It must be a string.** `apps/console/lib/audit.ts`'s `optionalStr` throws on
  anything else, and that failure is not scoped to the field — it fails the
  parse of the entire page. An object does not degrade here; it takes the audit
  log down.

**Why a string, given the sources are all structured.** Because the console
already reconstructs the structure: `audit-metadata.tsx` parses the string and
renders every key as its own labelled field — no whitelist, no truncation,
nested values as compact JSON behind their own label, and unparseable content
verbatim rather than as an error. It handles keys it has never seen, on purpose,
because products spread arbitrary per-event data in here.

So the object-on-the-wire alternative would buy readability that already exists,
at the cost of a breaking change to every product currently sending the string
form. If that trade ever becomes worth making, it is a contract amendment
applying to all products at once — never a per-product divergence.

---

### 8.6 `/admin/kpis` wraps its map in `data`

§3.1 originally specified a bare flat map at the top level. It is now
`{ "data": { ... } }`.

Found by `@tesserix/admin-conformance`'s first run against production: mark8ly
returns the wrapped shape, the contract said bare, and the suite reported the
conflict rather than picking a side. Which is the point of having it — but the
conflict still had to be resolved.

**Resolved toward the implementation, for three reasons.**

Every other contract endpoint already returns a `data` envelope: §4.1 is
`{ data, pagination }`, and §3.4's entity detail is `{ data }`. A client that
can always read `.data` is simpler than one that special-cases the single
endpoint returning something else, and "flat" in §3.1 was always about the
*metrics map* being flat — one level of scalars, no nesting — rather than about
where that map sits.

The migration cost is zero in both directions, so the decision is a design one
rather than an economic one. mark8ly is the only implementer of this endpoint
today, and **nothing consumes it**: there is no reader in `platform-api` or
`apps/console`. (`apps/web`'s `/api/admin/apps/[product]/kpis` returns a bare
map, but it is a different route with per-product branches, is not this
contract, and is being retired.)

Choosing the other way would have meant changing the one working
implementation and its tests to match a document that no code had yet agreed
with. That is the right call when a spec is load-bearing for multiple
implementers. With one implementer and no consumers, it is ceremony.

**What did NOT change:** §3.1's other rule stands unaltered — an uninstrumented
product answers `501 not_implemented`, never `200 {}` and now never
`200 {"data":{}}`. That rule exists because an empty object renders as
em-dashes indistinguishable from real zeroes, and wrapping it changes nothing
about that.

---

### 8.5 Where a surface belongs

The contract governs how a product exposes itself. It did not say where the
console puts what comes back, and the absence produced a draft design that
proposed console pages duplicating two that already existed.

> **A surface belongs on the platform rail when the operator's question spans
> products. It belongs on a product rail when the question presupposes the
> product.**

When ambiguous: *can two products' rows sit in one table without a column
meaning something different in each?* If yes, it is estate-shaped.

`nav.ts` already applies this without naming it — #133 folded support analytics
into a Tickets tab, #139 folded Kora's audit trail into the estate-wide audit
log. Both for the same reason: a second door onto one capability is worse than
one door, because an operator then has to know which door records the answer.

The practical consequence for products adopting this contract: implementing
`/admin/inbox` or `/admin/audit-logs` does **not** earn a product rail entry. It
makes the product a source in a surface that already exists. A product rail entry
is justified only by a surface no other product could share.


### 8.8 `GET /admin/lifecycle/reason-codes` — the vocabulary must be fetchable

§8.3 requires reason codes on anything reversible-but-consequential, and the
product is the authority on its own set. mark8ly complied on the day it was
written: seven suspend codes, four deliberately different unsuspend ones, and an
unrecognised code refused with §4.4's `invalid_reason_code`.

All correct, and all invisible. The codes were a Go var in
`internal/handlers/platformadmin/tenant_lifecycle.go`, reachable only by opening
that file. **A form cannot offer a menu it has no way to fetch**, so the console
shipped a hand-copied duplicate (tesserix-home#345).

A copied vocabulary drifts in two directions and only one of them is loud:

- a code the product has **retired** is offered → the write is refused, visibly,
  and someone acts on it;
- a code the product has **added** is missing → the option is silently absent,
  and the operator picks the nearest wrong one, which lands on an audit row and
  is never questioned again.

The second failure is the reason this is a required endpoint rather than a
convenience. So:

```
GET /admin/lifecycle/reason-codes

{
  "data": {
    "suspend":   [{ "code": "non_payment", "label": "Non-payment — dunning exhausted" }],
    "unsuspend": [{ "code": "appeal_upheld", "label": "Appeal upheld" }]
  }
}
```

- **Required of any product implementing §8.3's lifecycle writes**, and of no
  other. A product with no suspend endpoint owes nobody a vocabulary.
- **Both verbs are always present**, even where a product's two sets are
  identical. "The same codes apply" is a statement made by repeating them, not
  by omitting the key — an absent key leaves the console unable to render that
  form at all.
- **`code` is snake_case.** It crosses the wire into an audit row and is matched
  exactly by the product's own validator; a product serving `Non-Payment` would
  pass its own tests and break the moment two products' rows were read together.
- **`label` is required and human.** Without one the console renders the wire
  value, and `tos_violation` appears in front of an operator as a menu option.
- The product remains **authoritative**. This endpoint publishes the set; it does
  not move validation. A write carrying an unlisted code is still refused with
  `invalid_reason_code`, and a client that cached a stale list is still wrong in
  the loud direction.

Enforced by `@tesserix/admin-conformance` from v0.4.0, including the conditional:
a product declaring `tenant-lifecycle` without `lifecycle/reason-codes` fails.
That write endpoint is declarable but never called by the suite — a conformance
run that suspended a live merchant's tenant to confirm the route conforms is a
worse outcome than an unchecked route.

**The general problem, stated but not yet solved.** Reason codes are one instance
of "what vocabulary does this product use?", and they are the second instance to
surface. `Tenant.status` is also the product's own vocabulary and is also
rendered verbatim because the console has no way to know the valid set. That one
is harmless — rendering an unknown status verbatim is honest, where rendering an
unknown reason code as a *choice* is not — which is exactly why it does not
justify a discovery endpoint on its own.

`GET /admin/vocabulary`, covering statuses, entity types and inbox kinds
alongside reason codes, is the shape this wants eventually. It is deliberately
not built here. A discovery endpoint designed against one real consumer is
designed wrong, and §8.8 is a route it can absorb later without a second
migration: a product serving `/admin/vocabulary` would keep answering this path
too.


### 8.9 §3.4's entity row, named

§3.4 specifies the **envelope** and never the **row**. "Searchable records" and
§4.1's `{data, pagination}` say how many and how paged; they say nothing about
what a record contains. So each implementer decided, and two of them decided
differently:

- **Kora** emits `{id, type, label, sublabel, created_at}`, with `sublabel`
  documented in its own source as *"what distinguishes two records with the same
  Label"* — a user's handle, falling back to their email; a food's brand.
- **mark8ly** emits no `sublabel` at all.

Neither is wrong, because the contract does not say.

**What it cost.** platform-api's entities module modelled the row as
`{id, source, type, label, created_at}` and dropped `sublabel` — the fields were
read off Kora's *foods* response, and there was nothing to check them against. On
a **user** directory that is not cosmetic: display names are not unique, so two
users called "Mahesh" render identically and an operator cannot tell them apart.
Fixed in tesserix-home#364, but only after a surface made it obvious.

That is the shape of the failure. An underspecified row is invisible until a
consumer needs a field nobody wrote down, and by then the field has been dropped
somewhere in the middle.

#### The row a product serves

```
GET /admin/entities/foods?q=paneer

{
  "data": [
    { "id": "528ea893", "label": "Paneer butter masala",
      "sublabel": "Aroma", "created_at": "2026-08-22T07:16:52+00:00" }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 6421 }
}
```

| field | required | note |
|---|---|---|
| `id` | **yes** | product-local; the platform namespaces it (below) |
| `label` | **yes** | the human name |
| `sublabel` | no | the disambiguator |
| `created_at` | no | §4.3 when present |

- **`id` is the product's own identifier**, not a namespaced one. The product
  does not know its own slug in the estate's terms and must not guess it.
- **`label` is required and human.** A row whose label is a UUID is a row the
  Directory cannot render, and the ⌘K result it produces is unreadable.
- **`type` is not required in the row.** See "what the platform stamps".

#### `sublabel` is optional, and the optionality is the specification

Absent is a legitimate shape, not a deviation — mark8ly sends none, and that is
correct for a population whose labels are already unique.

**A consumer must render an absent `sublabel` as nothing.** Never a dash, never
"—", never "no brand". The two failures are not symmetric:

- rendering nothing where the product sent nothing is **honest** — the row simply
  has one line;
- rendering a placeholder makes *"this product does not send sublabels"* look
  identical to *"this record has no brand"*, which is a claim about the record
  that the product never made.

The second is the reason this is written down rather than left to each reader to
infer. A rule that lives only in the first consumer's head is re-derived, and
re-derived differently, by the second.

An empty string is **not** a way to say "absent". Omit the key.

#### What the platform stamps, and what it ignores

The row a **consumer** receives from `GET /v1/entities/{type}?source={slug}` is
not byte-identical to the row the product served. platform-api adds two fields
and takes them **from the request, never from the response body**:

| field | origin |
|---|---|
| `source` | the `source` query parameter |
| `type` | the `{type}` path segment |
| `id` | namespaced `slug:id` |

This is deliberate and worth stating so no product tries to be helpful. A product
that sends its own `type` has it overwritten; a product that sends the *wrong*
`type` is not believed. A `source` a product asserted about itself would be a
row's origin claimed by the row, which is precisely the field that must not be
forgeable — two products' `users` are different people, and a mislabelled origin
is worse than a failed read.

So: products **may** send `type`; nothing depends on it. Products **must not**
send `source`, and it is discarded if they do.

#### Conformance

Enforced by `@tesserix/admin-conformance` from **v0.5.0**. Until then the suite
declared `entities` and checked §4.1's envelope and §4.3's timestamps against it
but nothing about the row's own fields — which is how the divergence above
survived a suite already running against both implementers.

What it asserts, per row and reported per row:

- `id` and `label` are non-empty strings. A **numeric** `id` fails: it is a real
  shape, and a consumer's `String(id)` papers over it until two products' ids are
  compared. Whitespace-only counts as empty — a label of `"   "` renders as a
  blank line an operator cannot click.
- `sublabel`, **where the key is present**, is a non-empty string. Its absence is
  never a finding; a row without the key passes. What fails is `null` or `""` —
  absence signalled through a value, which is the shape that makes a consumer
  draw a placeholder where nothing belongs.
- `source` is absent. A row asserting its own origin is the one field that must
  not be forgeable.
- `created_at` is left to §4.3.

Two reporting rules worth knowing before reading a report. A page with **no
rows** is a `skip`, not a `pass` — a product with nothing to serve has
demonstrated nothing about its row shape, and `pass` would claim coverage the run
does not have. A `data` that is not an array is also a `skip`, because §4.1 and
§4.5 already report that and failing twice shows one deviation as two.

#### Deferred, and named: there is no way to fetch one record

§3.4 is a list endpoint with no by-id sibling, and nothing in this contract
provides one. That is not an omission in a product's implementation; it is
absent from the specification.

The consequence is concrete. tesserix-home#370 shipped Kora's food index with
rows that expand in place rather than linking to a detail page, because there is
no detail page to link to — the six fields above are the **entire** record the
console can hold, and a `/kora/foods/{id}` route would be a URL with nothing
behind it. Any consumer that wants more than a name and a disambiguator is
currently stuck.

`GET /admin/entities/{type}/{id}` is the obvious shape and is **deliberately not
specified here**, for §8.8's reason: an endpoint designed against no real
consumer is designed wrong, and the interesting question — whether a single record
is the same shape as a list row plus fields, or a product-defined document the
console renders generically — cannot be answered by guessing. It wants its own
amendment, written against a surface that has asked for specific fields.

Naming the row first is the cheaper half and does not block that: a get-one that
returns "the §8.9 row, plus product-defined detail" is a strictly easier thing to
specify than one that must also settle what the row is.


## 9. v3 amendments (2026-08-29)

Derived from `2026-08-29-admin-contract-v3-console-federation-design.md`, which
found eight mark8ly surfaces the console could not reach because their endpoints
had no ids in this contract's closed vocabulary.

**This is purely additive.** No v2 id changes shape, no envelope already in use
is redefined, and a product that declares none of the ids below is unaffected —
an undeclared endpoint is "not implemented," and the suite skips it, exactly as
it always has. The closed vocabulary goes from nine ids to seventeen.

### 9.1 `GET /admin/outbox`

Envelope: `data-pagination` (§4.1). Probed.

Undelivered and failed outbox rows — the estate's outgoing message queue,
exposed for operator visibility.

### 9.2 `GET /admin/email-sends`

Envelope: `data-pagination` (§4.1). Probed.

The transactional email delivery log.

### 9.3 `GET /admin/notifications`

Envelope: `data-pagination` (§4.1). Probed.

The product's own, product-owned notification log. This is **not** the
console's notification bell, which is derived from ticket rows and has no table
behind it — two different things sharing one word. Do not wire one into the
other on the strength of the name.

### 9.4 `GET /admin/break-glass`

Envelope: `data-pagination` (§4.1). Probed.

This is the first **read** in the estate gated on an exact capability *value*:
`rotate-credentials` (`middleware.go:367-385`). A suite run without that
capability gets a 403, which is the endpoint working correctly and would
report as a failure if the runner did not account for it. The runner sends
`--operator` and `--capability rotate-credentials`.

**Correction (2026-08-29):** an earlier version of this section claimed the
CronJob's signing identity must "hold" `rotate-credentials`, with a fallback
to `probe: false` if it could not be granted. That is false — there is no
grant to hold. `middleware.go:367-385` checks exact string equality between
the presented capability value and the literal string
`"rotate-credentials"`, plus a non-empty operator; no identity verification
of any kind sits behind it. Any caller that already holds the shared HMAC
secret used to sign requests can send the literal capability string and an
arbitrary operator identifier and pass. `break-glass` is declared and probed
like the other seven new ids.

### 9.5 `GET /admin/conversions`

Envelope: `free`. **Not probed.**

`GET /admin/conversions` requires `?email=`. Every value the suite could send
is either a real person's address — which makes the nightly run a scheduled PII
lookup — or a synthetic one, which exercises only the `state: "none"` branch
and asserts nothing about the endpoint's real behaviour. Neither is worth a
check. Declared, never invoked by the suite.

This is a distinct endpoint from `/internal/conversion-status`, which the CRM
calls directly under RULING 27 for a single lead's own state. `/admin/
conversions` is the same product's operator view of that data, federated the
same way every other admin read is. Neither retires the other, and this
amendment does not rewire one onto the other.

### 9.6 `GET /admin/onboarding/funnel` and `GET /admin/onboarding/sessions`

One surface, two endpoints — which is why they share a section number.

- `GET /admin/onboarding/funnel` — envelope `free`. The response nests
  `last_24h` (a grouped sub-window of counts) and `window` (a `{from,to}`
  pair) by design, which is neither a page nor a flat map of scalars.
  Identical reasoning to `lifecycle/reason-codes` (§8.8): §4.1 correctly
  reports a skip rather than asserting a shape the endpoint never had.
  Probed.
- `GET /admin/onboarding/sessions` — envelope `data-pagination` (§4.1).
  Probed.

The funnel is the headline counts; sessions are the individual records behind
them. Both read, both probed, and there is no write on this surface.

### 9.7 `POST /admin/tenants/{id}/purge`

Envelope: `free`. **Not probed.**

Identical reasoning to `tenant-lifecycle` (§8.8), and stronger. A conformance
run that suspends a real tenant to check an envelope is already worse than no
check; a run that *purges* one is unrecoverable, and there is no sandbox tenant
to point the suite at. The id exists so the console can discover that a
product supports purge at all — it is declarable and carries no wire check.

`GET /admin/tenants/{id}/purge/preview` is **deliberately not a separate id.**
It is the read half of one operation and is meaningless without the write;
splitting them would let a product declare a preview it cannot execute.

---

## Changelog

- **v3.1** (2026-08-29) — §9.6 correction: `onboarding/funnel`'s envelope was
  wrong in v3 as first published. It named `data-flat-map`, inferred from one
  line without reading `toFunnelRow`; the endpoint's response nests `last_24h`
  and `window` by design and was never a flat map of scalars. The envelope is
  now `free`, same reasoning as `lifecycle/reason-codes` (§8.8). mark8ly's
  handler was correct throughout — only the contract's declaration was wrong.
- **v3** (2026-08-29) — §9: eight endpoint ids added across seven surfaces —
  outbox, email-sends, notifications, break-glass, conversions,
  onboarding/funnel, onboarding/sessions, tenant-purge. Additive; no v2 id
  changed shape. `conversions` and `tenant-purge` are declarable but never
  probed.
- **v2.4** (2026-08-27) — §8.9: §3.4's entity row is named. `id` and `label`
  required, `sublabel` and `created_at` optional, and an absent `sublabel`
  rendered as nothing rather than a placeholder. Kora and mark8ly had already
  diverged and platform-api dropped the field in the middle (tesserix-home#364,
  #365). Also records what the platform stamps from the request rather than the
  body, and names the missing get-one as deferred.
- **v2.5** (2026-08-27) — §8.9's row is enforced by `@tesserix/admin-conformance`
  from v0.5.0 (design-system#35). No contract change; the amendment landed a day
  unenforced and this records that it no longer is. An absent `sublabel` passes —
  only a present-but-empty one fails.
- **v1** (2026-08-14) — initial draft, derived from the console redesign audits.
- **v2.3** (2026-08-26) — §8.8: `GET /admin/lifecycle/reason-codes`, required of
  any product implementing §8.3's lifecycle writes. §8.3 required the codes and
  said nothing about how anyone was meant to learn them, so the console
  hand-copied mark8ly's out of a Go source file (#345). Enforced by
  `@tesserix/admin-conformance` from v0.4.0, conditionally on the writes being
  declared. The general "what vocabulary does this product use?" problem is
  named and a discovery endpoint deliberately deferred.
- **v2.2** (2026-08-26) — §8.7: `/admin/audit-logs`'s `metadata` is specified
  as compact JSON in a string, resolving mark8ly#313. No implementation
  changes; the shape was already what the estate produced and the console
  rendered, but it was written down as "optional free text".
- **v2.1** (2026-08-26) — §8.6: `/admin/kpis` wraps its metrics map in `data`,
  resolving the conflict `@tesserix/admin-conformance` found on its first run
  against production. Enforced by that suite from v0.3.0.
- **v2** (2026-08-22) — §8: transport moved off `apps/web`; billing endpoint,
  inbox action execution and domain writes added; §7 closed by the capability
  model; surface-placement rule stated. Derived from
  `2026-08-22-mark8ly-console-integration-design.md`.
