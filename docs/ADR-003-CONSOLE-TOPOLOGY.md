# ADR-003: One console, in place — a platform API and the retirement of the legacy surfaces

**Status**: Proposed
**Date**: 2026-08-18
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
new console surface at it. Sever the two existing `/api/admin/*` dependencies.
Fix and redesign the secrets flow in place (1–2), then absorb its UI. Stand up the
new mobile app. Delete each legacy surface as its replacement ships. D6 happens in
parallel and immediately.

## What would change this decision

- **D1**: a second team needing independent repository access, or a legacy
  surface that proves undeletable and starts constraining the console's
  structure. The trigger is coupling, not calendar.
- **D2**: a module whose scaling profile genuinely diverges — sustained CPU or a
  long-running workload — earns extraction. Sharing a process is the default,
  not a rule.
- **D3**: if the secrets backend's privileges narrow enough that its compromise
  is no worse than the API's, the separate deployable stops paying for itself.
- **D4**: Zitadel becoming HA with its bootstrap secrets stored outside the store
  it gates would remove the circularity, and the break-glass runbook could relax
  from prerequisite to good practice.
- **D5**: if mobile parity turns out to be wanted rather than a subset, the route
  contract inversion should be reconsidered before it is built, not after.
