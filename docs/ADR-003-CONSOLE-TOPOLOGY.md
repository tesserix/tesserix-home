# ADR-003: One console, in place — a platform API and the retirement of the legacy surfaces

**Status**: Proposed
**Date**: 2026-08-18
**Amended**: 2026-08-18 — D7 (the console retires its direct database access)
and D8 (both principals authenticate through Zitadel).
**Related**: [ADR-002: Delivery visibility on ArgoCD + Kargo](./ADR-002-DELIVERY-VISIBILITY.md)

## Context

The console is being built inside `tesserix-home`, alongside the legacy admin it
replaces. Four questions arrived together, and they interact enough that
deciding them separately is how an estate ends up with four auth paths — the
condition #165 exists to unpick.

1. Where does the console live, and what does `tesserix-home` become?
2. Does the platform gain a Go API, and in what shape?
3. What happens to `apps/mobile`?
4. What happens to `secret-service` (M4)?

**The governing requirement, stated by Mahesh:** one console that handles
everything, in the manner of the GCP or AWS console — and one thing to manage,
not several.

### Verified state, 2026-08-18

Read from the code, the cluster, or the running deployment rather than from
documentation. Where a document disagreed, the document was wrong.

| Premise | Verified state |
|---|---|
| "the console needs a Go backend for pod-identity auth" | Not on its own. `secret-service` uses OpenBao Kubernetes auth and GCP Workload Identity; a Next.js pod has both. The case for Go is product integration and workers, not language capability. |
| "`apps/mobile` is the console's mobile app" | **No.** It calls `https://tesserix.app/api/admin/*` — the *legacy* admin API — and authenticates through `/api/auth/mobile/google`. It is the old admin's mobile face, on the old identity provider. |
| "mobile shares the console's route contract" | It does not. `apps/mobile` imports only `@tesserix/homechef-shared`; it has never consumed `console-core`. Yet `console-core`'s route table declares `mobile: string` as **required on every route** — a contract designed for mobile that mobile never adopted. |
| "the console is independently deployable" | It already is: own `Dockerfile.console`, own image, own Kargo promotion. Six promotions observed on 2026-08-18, each within minutes of merge. A separate repository would add nothing here. |
| "`tesserix-home` becomes marketing once the console ships" | Not while the console consumes `apps/web`'s `/api/admin/*` server-side — the audit log and the ticket surfaces do today. `apps/web` is currently the console's backend. |
| "the shared packages force a repo split to be expensive" | They do. `platform-auth` mints the `tx_session` cookie **both** apps read; `crm-country`'s own comment says it is *"THE ONLY PLACE THIS MAPPING LIVES"* and warns against a second copy. Splitting means publishing both as versioned packages. |
| "local development is slow because the repo is large" | The evidence points elsewhere. Playwright runs with `TESSERIX_DB_*` unset and **every CRM surface renders its error state by design**; #245 had to be proved with pglite integration tests. The constraint is absent dependencies, not repo size. |
| "`secret-service` is a secrets browser" | Its README is materially stale. It is a GitOps proposal flow: it opens pull requests against `tesserix-k8s`, edits `values.yaml` and the ArgoCD AppProject, and carries an in-app review/approve/merge/reject queue. |
| "`secret-service` can read secret values" | It cannot, and that is enforced outside its own code: the OpenBao policy grants `create/update/delete` on `kv/data/*` and **no `read`** — *"so that compromising the console still yields no secret value."* The equivalent GCP claim is **unverified**; that custom role is in neither repository. |
| "two-person integrity is in the application" | It is not. It rests on GitHub branch protection — the service holds no permission to merge. |
| "the estate has spare capacity for more services" | It runs ~30 Go services against a shared small Postgres. The console's own pool is `max: 2`, written into the code as the reason a check shares its caller's transaction rather than opening a second connection. Each new service multiplies that pressure. |

## Decision

### D1 — Everything stays in this repository; the legacy surfaces are deleted incrementally

No new repository. The platform API is built here, the new mobile app is built
here, and `apps/web/admin` and `apps/mobile` are **deleted as their replacements
ship** rather than migrated away from.

The end state is identical to the one a repo split would reach — marketing,
console, new mobile, platform API — arrived at by subtraction instead of
migration.

**Why in place:**

- **The expensive part disappears.** A split forces `platform-auth` and
  `crm-country` to become published packages, so every capability change becomes
  a two-repo release during exactly the period M12 is changing capabilities
  repeatedly. Staying put means that cost never arises.
- **Deletion is cheaper than migration.** `git rm` on the legacy surfaces and
  their workflows, versus recreating the console, mobile, API, CI, secrets,
  ArgoCD apps and Kargo pipelines somewhere new.
- **No dual-repo window** in which changes must be coordinated across two
  places.
- **Nothing requires a split.** The console is already independently deployable,
  and `secret-service` already proves Node + Go co-existing in this estate via
  `go.work`.

**The load-bearing commitment: the console stops depending on `/api/admin/*`.**
Without it, staying in place means the console keeps consuming `apps/web` and
`tesserix-home` never becomes marketing. Everything new targets the platform API
from the start; the existing dependencies migrate onto it.

Enumerated from the code, 2026-08-18 — **eight call sites across five
functional areas**, all server-side, all through `WEB_INTERNAL_ORIGIN`
(cluster-internal by default so these reads never egress):

| Area | Endpoint | Caller |
|---|---|---|
| Dashboard | `GET /api/admin/dashboard` | `lib/platform-api.ts:90` |
| Tickets | `GET /api/admin/platform-tickets` | `lib/platform-api.ts:174` |
| Tickets | `GET /api/admin/platform-tickets/{id}` | `:257` |
| Tickets | `POST /api/admin/platform-tickets/{id}/replies` | `:270` |
| Tickets | `PATCH /api/admin/platform-tickets/{id}` | `:290` |
| Support analytics | `GET /api/admin/analytics/support` | `:315` |
| Audit log | `GET /api/admin/apps/{product}/audit-logs` | `:365` |
| CRM handoff | `GET /api/admin/apps/{product}/conversion-status` | `lib/crm-conversion.ts:235` |

Two observations that shape the migration:

**The console authenticates by replaying the operator's own cookie** —
`fetch(..., { headers: { cookie: cookieHeader } })`. So `apps/web`'s admin API
authorises the operator directly, and this is precisely the `tx_session`
coupling that `platform-auth` exists to provide. Migrating these onto the
platform API removes that dependency as a side effect, which is why D1's cost
shrinks as the work proceeds rather than at the end.

**The conversion-status endpoint does not exist for any product.**
`lib/crm-conversion.ts` says so in its own comment, and #246 records that every
Handoff signal therefore reads `unknown` in production. That one is not a
migration at all — it is an endpoint to design, or a feature to withdraw.

**The real risk, named: "we will delete it once the console is finished" is the
kind of thing that does not happen.** In a separate repository the old one is
visibly legacy and dies of neglect. In one repository it simply sits there, and
"finished" keeps moving.

So retirement is made incremental and enforced rather than deferred:

- A tracking issue listing every legacy surface, its console equivalent, and its
  retirement criteria.
- Each legacy surface is deleted **in the pull request that ships its
  replacement**, wherever possible. Retirement becomes a merge checklist item,
  not a future project.
- The standing rule inverts over time: today *"do not touch `/admin/`"*; later
  *"you may only delete from `/admin/`"*.

**Two smaller measures:** CI path filters, so console changes stop rebuilding and
testing `apps/web` — that is most of the day-to-day clutter cost, and it is
configuration rather than architecture. And **rename the repository at the end**,
once marketing is the only legacy left. GitHub redirects the old URLs, so the
clean identity costs almost nothing when it is finally warranted.

### D2 — The platform API is a modular monolith, built in this repository

One deployable, internally modularised by domain (CRM, tickets, audit,
telemetry, secrets), rather than a service per domain. It lives here alongside
the console — `go.work`, as `secret-service` does today.

Reasons, in order of weight:

1. **The estate cannot afford more services.** ~30 already, a shared small
   Postgres, and a `max: 2` pool per service written into the code as a real
   constraint. Consolidation reduces pool pressure; more services increase it.
2. **One thing to manage** — the governing requirement.
3. **Atomic change.** Adding a capability touches `console-core`, the API and the
   mobile app. In one repository that is one pull request.
4. **Local development is one process**, which is the ambition D6 exists to
   serve.

**Module boundaries must be enforced from the first module, not the third.** Go
`internal/` visibility plus an import-graph lint in CI. A modular monolith
without enforcement is a monolith within two quarters, and the enforcement is
cheap only before the modules exist.

#### D2a — Why core-plus-secrets, and not a service per domain

The alternative considered was one service per domain — `platform-core`,
`platform-secrets`, `platform-crm`, `platform-tickets`, and so on. The shape
decided here is **`platform-core` as a modular monolith plus `platform-secrets`
as a separate deployable** (D3), with further extraction when a module earns it.

Note that "core plus secrets" *is* the two-service split; the disagreement is
only about splitting the core further.

**Two properties currently relied upon argue against splitting the core:**

1. **The pool constraint is measured, not theoretical.** `max: 2` per service
   against a shared small Postgres, written into the code as the reason a
   suppression check shares its caller's transaction rather than opening a
   second connection. Four platform services is eight connections before
   anything else runs.
2. **Transaction boundaries would break.** `auditedOperation` guarantees that an
   unauditable operation does not proceed — one transaction today. Split CRM
   from audit and that becomes a distributed transaction or a lost guarantee.
   The same holds inside the CRM: #245's contact clock advances opportunities in
   the same transaction as the activity insert, precisely so a write cannot
   half-land.

**The estate's own history is a caution, not an endorsement.** ~30 Go services
suggests a house style, but #159 is "Decide the fate of seven dormant undeployed
services" — the estate has already demonstrated it creates more services than it
operates.

**The decisive argument is reversibility.** With boundaries enforced —
`internal/` visibility plus an import-graph lint — extracting a module later is
mechanical, because the seams already exist. Starting distributed and merging
back is not. So being wrong in this direction costs an extraction; being wrong
in the other costs distributed transactions, pool exhaustion, and N services to
run locally, which is the condition D6 exists to remove.

**A module is extracted when it has a forcing reason, not a structural
preference:**

| Trigger | Status |
|---|---|
| **Different privileges** | Already met by secrets — hence D3. |
| **Different scaling profile** — sustained CPU, a long-running worker, read-heavy enough to want its own replicas | Not met today. Telemetry is the plausible future candidate. |
| **Different lifecycle** — a second team deploying independently | Not met today. |

CRM, tickets and audit meet none of them: all three are request-scoped,
operator-driven, and share both the session and the capability model.

**This decision depends entirely on the enforcement landing with the first
module, not the third.** Without it, the modules erode, extraction stops being
cheap, and the service-per-domain instinct becomes retroactively correct. The
enforcement is the thing that keeps the option open.

### D3 — The console absorbs secrets; `secret-service` retires as a product

This is the governing requirement applied: one console, in the manner of the GCP
console.

**Retired:** the separate app, `secret-service.tesserix.app`, the separate Google
login, the separate repository, the separate deploy pipeline, the separate review
queue. Secrets become a console section like any other, and the review queue
merges into the console's own surfaces.

**Retained as a deployment detail:** the secrets backend stays its **own
deployable**, with its own service account — not a module inside the shared API
process.

The reason is narrow rather than general caution. That backend holds a GitHub PAT
that can write anywhere in `tesserix-k8s`, OpenBao write access, and cluster RBAC.
In a single process, a defect anywhere in the API shares an address space with
those credentials. Keeping it separate costs nothing operationally — same
repository, same CI, same release — and preserves the property the OpenBao policy
was deliberately written to guarantee.

This is the GCP model: one console, many independently-privileged backends. The
unification is in the presentation, which is where the requirement actually lives.

### D4 — Authentication unifies on Zitadel, with a non-console break-glass

Secrets move behind Zitadel with everything else. The second identity provider
goes.

**The circularity must be answered rather than avoided.** Zitadel's own session
signing key and login-client PAT are stored in OpenBao under `kv/data/hms/api/*`.
A secrets surface gated on Zitadel cannot be used to fix Zitadel.

The resolution is that the emergency path does not run through the console at
all: an operator with cluster access reads and rotates through `kubectl` and the
OpenBao CLI directly. That is a legitimate break-glass, and it is how most estates
work.

**It must be written down and exercised once, before the second login is
removed.** Otherwise the console silently becomes the only known path and the
circularity becomes real the first time it matters.

**Two-person integrity must be preserved explicitly.** It rests on branch
protection today, not on code. Confirm `main` protection on `tesserix-k8s`, and do
not let one capability grant both propose and merge — see #244, which needs a
propose/approve split for this surface.

### D5 — The new mobile app is greenfield, on a subset principle

`apps/mobile` is to the console what `/admin/` is: the previous generation. It is
frozen and deleted when its replacement ships, not ported.

The new app is built here, consuming `console-core` from day one — which is what
the route table's `mobile` field always anticipated.

**Mobile is a deliberate subset**, so the route contract must invert.
`mobile: string` is currently **required on every route**, forcing every surface to
claim a mobile path. It becomes optional, with absence meaning "not on mobile" —
the same way `pending` and `retired` already mark routes renderers must not link.

The principle for what belongs: **what gets done away from a desk.** Triage a
queue, approve or reject, acknowledge an alert, check a status, reply to a ticket.
Not CSV import, not bulk operations, not multi-field authoring, and not
destructive actions whose context will not fit on a phone.

Mobile presence is **orthogonal to capability**. An operator holding `crm` may get
the queue on mobile and not the import surface, so the route table expresses both
independently rather than conflating them.

### D6 — Fix local development directly; none of the above fixes it

Neither a new repository nor a new API would have fixed this. What blocks local
work:

- **No seeded database.** The pglite fixtures already used by the integration
  tests, promoted to a dev database with representative data.
- **No local stand-in for the admin API.** The e2e spec's own header names a stub
  upstream selected by env as *"the cheaper path and the obvious next
  increment"*. This one shrinks as D1 severs the dependency.
- The dev auth bypass already exists and works.

Days of work, independent of every other decision here, and it also unblocks e2e
coverage for surfaces that cannot be tested today (#243's unfinished half).

### D7 — The console becomes a pure UI over the platform API

D1 commits the console to dropping `/api/admin/*`. This goes further: the
console stops reading the database directly as well. Every read and write it
performs eventually crosses the platform API, and `apps/console/lib/db/*` — the
CRM repository, audit, notifications, search — retires module by module as the
API absorbs each domain.

**Why the eight endpoints are not enough.** D1's target is `tesserix-home`
becoming the marketing site, and its stated blocker is the console consuming
`apps/web`. But the console also holds its own `pg.Pool` against
`tesserix-postgres`, and `lib/db/tesserix.ts` says in its own header that it
mirrors `apps/web/lib/db/tesserix.ts` and reads *"the same database with the
same credentials."* Two Node processes and, shortly, a Go service all writing
the same tables is not an end state anybody chose — it is what remains if only
D1 is executed.

**This ADR was silent on it, which is not the same as deciding it.** The comment
in `tesserix.ts` calls this "the console reading its OWN store — tesserix-postgres
is platform-owned, not a product database", and that reasoning is sound for what
it addressed: it argues the console is not coupling a product to the platform's
availability. It was never an argument that the console should hold a connection
pool once a platform API exists. Recorded here so the silence stops reading as
permission.

**What this costs, stated plainly.** The console pays a network hop where it
currently pays a query, and its route handlers become composition over HTTP
rather than over SQL. That is the same cost D1 already accepted for the eight
endpoints, extended to the rest.

**What it buys** is the thing D1 is actually for. A domain whose only writer is
the platform API has one place to enforce capabilities, one audit trail, and one
contract for products to consume. A domain with two writers has none of those,
and the console's capability checks stay decoration — the same failure #269
names for the API itself.

#### D7a — CRM and audit migrate together, in one module

Not a sequencing preference. `auditedOperation` guarantees that an unauditable
operation does not proceed, and it does so by sharing one transaction. #245's
contact clock advances an opportunity in the same transaction as the activity
insert, precisely so a write cannot half-land.

Migrate the CRM to the API while audit stays in the console — or the reverse —
and that guarantee becomes a distributed transaction or is quietly lost. They
move as one module, in one migration. This is D2a's transaction-boundary
argument applied to the migration order rather than to the service split.

#### D7b — What this does to M11

The roadmap runs M11 CRM in parallel on the stated grounds that it is "largely
independent of the platform API." Under D7 that independence has an expiry date,
and the sequencing rule — *do not build a console surface against `/api/admin/*`*
— acquires a second clause: **do not build a new CRM surface against the
console's own pool either**, once the CRM module is scheduled.

The split that follows:

- **M11 correctness** (#246–#252) continues on the direct-DB path. These are
  small, several are nearly done, and holding live bugs — an erasure path used
  to fix a typo, a silent cap at 100 — behind an API that does not exist yet
  would be trading a real defect for an architectural one.
- **M11 structural** (#254–#259) targets the platform API. These are new
  surfaces; building them twice is exactly what the sequencing rule exists to
  prevent.

### D8 — The platform API authenticates both principals through Zitadel

The API takes Zitadel access tokens. Two principal types, one issuer:

- **An operator**, acting through the console.
- **A service** — a product calling the platform API directly. Filing a platform
  ticket on a merchant's behalf is the concrete case, and it is what
  `/api/internal/*` does today.

Validation is the same on both paths: verify against Zitadel's JWKS, check the
issuer and the platform API's audience, then read
`urn:zitadel:iam:org:project:roles` and map it to the capability vocabulary
#261 defines. The principals differ in which roles they hold, not in how they
are proven.

**The cheaper option, and why it is declined.** `tx_session` is a JWE — `alg:
"dir"`, `enc: "A256GCM"`, off a symmetric `SESSION_ENCRYPT_KEY`. A Go service
could decrypt it in a few lines and ship the tickets module without touching
Zitadel. It is rejected because it answers only the operator half: a product has
no `tx_session` and never will, so the service principal would need a second
mechanism anyway — which is how an estate acquires the fourth auth path #165
exists to unpick. It also spreads a symmetric secret across two deployables in
two languages, to authenticate a principal an asymmetric issuer already attests.

**This answers #161.** `INTERNAL_API_TOKEN` is one shared bearer for every
caller of `/api/internal/*`. Its replacement is a Zitadel machine user per
calling product, holding only the roles that product needs. Scoping stops being
a policy nobody can enforce and becomes a role grant that either exists or does
not.

**The wiring the console already half-has.** `lib/auth/oidc.ts` requests
`offline_access` and the project audience scope, and `app/auth/callback/route.ts`
then discards `access_token` and `refresh_token`, keeping only ID-token claims.
So the console must retain the refresh token and add the platform API's project
to its login scopes. Sessions live 7 days and access tokens do not, which is why
the refresh token is required rather than convenient.

**Two Zitadel settings are prerequisites, not implementation detail.** The
console's application must issue **JWT** access tokens rather than opaque ones,
or every API request costs an introspection round-trip. And roles must be
asserted on the **access** token, not only the ID token. Both are checkboxes in
Zitadel's UI, and `oidc.ts` already documents this estate hitting the adjacent
version of this trap: the failure mode is a perfectly valid token carrying no
roles at all, *"which presents as an application bug rather than a configuration
gap."* Verify both before the first module's authorisation is written.

## Consequences

**Accepted:**

- One repository, one release train, no migration project. The governing
  requirement is met by subtraction.
- `platform-auth` and `crm-country` stay internal workspace packages. No
  publishing, no version skew.
- The repository keeps both generations for as long as retirement takes, so the
  freeze discipline remains a convention rather than a boundary — which is why
  D1 makes deletion a merge checklist item rather than a milestone.
- Three toolchains in one CI: Node, Go, Expo/EAS. `secret-service` proves Node +
  Go via `go.work`; mobile adds an app-store cadence that does not match the
  others.
- The secrets backend remains a separate deployable. Not a second thing to
  manage — one repository, one pipeline — but a second process.
- A documented, exercised break-glass runbook becomes a prerequisite for removing
  the Google login, not a follow-up.
- A repository rename at the end is optional and cheap; nothing depends on it.
- The console pays a network hop where it pays a query today, and its route
  handlers compose over HTTP rather than SQL (D7). Accepted as the cost of a
  single writer per domain.
- The console's connection pool retires with its last direct-DB module, which
  returns two connections to a shared small Postgres — a modest gain against
  D2a's measured constraint, in the opposite direction from adding a service.
- M11 CRM stops being independent of the platform API for new surfaces (D7b).
  Correctness work continues on the direct-DB path; structural work targets the
  API.
- Two Zitadel configuration settings become prerequisites for the first module's
  authorisation (D8), with a failure mode that presents as an application bug.

**Required before M4 work starts:**

1. Fix `tesserix/secret-service#16` — `ProposeAll` opens an empty pull request
   when the app is already whitelisted, and the guard already exists in a sibling
   function. It matters beyond tidiness: those PRs are near-identical in title to
   `tesserix-k8s#392`, a deliberate negative control that must never be merged.
2. Redesign the flow **before** moving it. The "new secret" dialog opens a
   whitelist PR and creates no secret; a grant writes the OpenBao role *before*
   its PR exists, so a live grant can survive a rejected proposal with no
   reconciliation; and three separate paths whitelist an app, producing
   differently-titled PRs and differently-shaped audit events. Porting a flow
   already known to be wrong is the expensive way to do this.
3. Verify the GCP custom role claimed to exclude `versions.access`. It is in
   neither repository, and it is half of the "cannot read values" property.
4. Confirm branch protection on `tesserix-k8s@main`, since it is what enforces
   two-person integrity.

**Sequencing.** Build the platform API with boundary enforcement, and point every
new console surface at it. Sever the `/api/admin/*` dependencies, then — per D7 —
the console's own database access, CRM and audit together. Fix and redesign the
secrets flow in place (1–2), then absorb its UI. Stand up the new mobile app.
Delete each legacy surface as its replacement ships. D6 happens in parallel and
immediately.

Tickets is the first module (#269): it exercises reads, a write, a status
transition and pagination, and settles the conventions against real requirements.
D8's two Zitadel settings are verified before its authorisation is written, and
#261's vocabulary is what that authorisation enforces.

## What would change this decision

- **D1**: a second team needing independent repository access, or a legacy
  surface that proves undeletable and starts constraining the console's
  structure. The trigger is coupling, not calendar.
- **D2**: a module whose scaling profile genuinely diverges — sustained CPU or a
  long-running workload — earns extraction. Sharing a process is the default,
  not a rule. The full trigger list is in D2a; the one that would invalidate the
  decision rather than refine it is boundary enforcement failing to land with
  the first module.
- **D3**: if the secrets backend's privileges narrow enough that its compromise
  is no worse than the API's, the separate deployable stops paying for itself.
- **D4**: Zitadel becoming HA with its bootstrap secrets stored outside the store
  it gates would remove the circularity, and the break-glass runbook could relax
  from prerequisite to good practice.
- **D5**: if mobile parity turns out to be wanted rather than a subset, the route
  contract inversion should be reconsidered before it is built, not after.
- **D7**: a measured latency or availability cost that the composition layer
  cannot absorb would justify keeping a read path on the pool. A *preference*
  for the query would not — that is the argument the ADR is answering. D7a is
  firmer: it only relaxes if `auditedOperation`'s single-transaction guarantee
  is deliberately given up, which is a separate decision.
- **D8**: if Zitadel cannot assert roles on access tokens for machine users, the
  service principal needs another design — and that should be settled before the
  tickets module ships, not discovered by it.
