# ADR-003: `platform-console` — one console, one repo, a modular-monolith API

**Status**: Proposed
**Date**: 2026-08-18
**Related**: [ADR-002: Delivery visibility on ArgoCD + Kargo](./ADR-002-DELIVERY-VISIBILITY.md)

## Context

The console is being built inside `tesserix-home`, alongside the legacy admin
it replaces. Four questions arrived together, and they interact enough that
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
| "the console is not independently deployable" | It already is: own `Dockerfile.console`, own image, own Kargo promotion. Six promotions observed on 2026-08-18, each within minutes of merge. |
| "`tesserix-home` becomes marketing once the console ships" | Not yet. `apps/web` still serves `/api/admin/*`, which the console consumes server-side. It is the console's backend today. |
| "local development is slow because the repo is large" | The evidence points elsewhere. Playwright runs with `TESSERIX_DB_*` unset and **every CRM surface renders its error state by design**; #245 had to be proved with pglite integration tests. The constraint is absent dependencies, not repo size. |
| "`secret-service` is a secrets browser" | Its README is materially stale. It is a GitOps proposal flow: it opens pull requests against `tesserix-k8s`, edits `values.yaml` and the ArgoCD AppProject, and carries an in-app review/approve/merge/reject queue. |
| "`secret-service` can read secret values" | It cannot, and that is enforced outside its own code: the OpenBao policy grants `create/update/delete` on `kv/data/*` and **no `read`** — *"so that compromising the console still yields no secret value."* The equivalent GCP claim is **unverified**; that custom role is in neither repository. |
| "two-person integrity is in the application" | It is not. It rests on GitHub branch protection — the service holds no permission to merge. |
| "the estate has spare capacity for more services" | It runs ~30 Go services against a shared small Postgres. The console's own pool is `max: 2`, written into the code as the reason a check shares its caller's transaction rather than opening a second connection. Each new service multiplies that pressure. |

## Decision

### D1 — A new repository, `platform-console`, drawn on the identity seam

It contains the console web app, a **new** mobile app, and the platform API.

The boundary is not arbitrary. Everything on each side shares an identity
provider, an API, and a lifecycle:

| `tesserix-home` | `platform-console` |
|---|---|
| marketing site | console web app |
| legacy `/admin/` | new mobile app |
| legacy mobile (`apps/mobile`) | platform API |
| Google auth, `/api/admin/*` | Zitadel, `console-core` |
| retires together | the product going forward |

`tesserix-home` becomes the marketing site once the left column retires. The
`/admin/` freeze remains the mechanism protecting the legacy admin until then.

**Cost, stated plainly:** `packages/platform-auth` mints the `tx_session` cookie
that `apps/web` **also** reads, and `crm-country`'s own comment says it is *"THE
ONLY PLACE THIS MAPPING LIVES"* and warns against a second copy. Both must be
published as versioned packages, or the split must wait for `/admin/` to retire.
Publishing is the lesser evil and is bounded: the coupling shrinks to nothing as
the legacy surfaces go.

### D2 — The platform API is a modular monolith

One deployable, internally modularised by domain (CRM, tickets, audit,
telemetry, secrets), rather than a service per domain.

Reasons, in order of weight:

1. **The estate cannot afford more services.** ~30 already, a shared small
   Postgres, and a `max: 2` pool per service written into the code as a real
   constraint. Consolidation reduces pool pressure; more services increase it.
2. **One thing to manage** — the governing requirement.
3. **Atomic change.** Adding a capability today touches `console-core`, the API
   and the mobile app. In one repo with one deployable that is one pull request.
4. **Local development is one process**, which is the ambition D5 exists to
   serve.

**Module boundaries must be enforced from the first module, not the third.** Go
`internal/` visibility plus an import-graph lint in CI. A modular monolith
without enforcement is a monolith within two quarters, and the enforcement is
cheap only before the modules exist.

### D3 — The console absorbs secrets; `secret-service` retires as a product

This is the governing requirement applied: one console, in the manner of the
GCP console.

**Retired:** the separate app, `secret-service.tesserix.app`, the separate
Google login, the separate repo, the separate deploy pipeline, the separate
review queue. Secrets become a console section like any other, and the review
queue merges into the console's own surfaces.

**Retained as a deployment detail:** the secrets backend stays its **own
deployable** inside `platform-console`, with its own service account — not a
module in the shared API process.

The reason is narrow and specific rather than general caution. That backend
holds a GitHub PAT that can write anywhere in `tesserix-k8s`, OpenBao write
access, and cluster RBAC. In a single process, a defect anywhere in the API
shares an address space with those credentials. Keeping it separate costs
nothing operationally — same repo, same CI, same release, nothing extra to
manage — and preserves the property the OpenBao policy was deliberately written
to guarantee.

This is the GCP model: one console, many independently-privileged backends. The
unification is in the presentation, which is where the requirement actually
lives.

### D4 — Authentication unifies on Zitadel, with a non-console break-glass

Secrets move behind Zitadel with everything else. The second identity provider
goes.

**The circularity must be answered rather than avoided.** Zitadel's own session
signing key and login-client PAT are stored in OpenBao under
`kv/data/hms/api/*`. A secrets surface gated on Zitadel cannot be used to fix
Zitadel.

The resolution is that the emergency path does not run through the console at
all: an operator with cluster access reads and rotates through `kubectl` and the
OpenBao CLI directly. That is a legitimate break-glass, and it is how most
estates work.

**It must be written down and exercised once, before the second login is
removed.** Otherwise the console silently becomes the only known path and the
circularity becomes real the first time it matters.

**Two-person integrity must be preserved explicitly.** It rests on branch
protection today, not on code. Confirm `main` protection on `tesserix-k8s`, and
do not let one capability grant both propose and merge — see #244, which needs a
propose/approve split for this surface.

### D5 — The new mobile app is greenfield, on a subset principle

`apps/mobile` is to the console what `/admin/` is: the previous generation. It
is frozen and retires with the left column, not ported.

The new app is built in `platform-console`, consuming `console-core` from day
one — which is what the route table's `mobile` field always anticipated.

**Mobile is a deliberate subset**, so the route contract must invert.
`mobile: string` is currently **required on every route**, forcing every surface
to claim a mobile path. It becomes optional, with absence meaning "not on
mobile" — the same way `pending` and `retired` already mark routes renderers
must not link.

The principle for what belongs: **what gets done away from a desk.** Triage a
queue, approve or reject, acknowledge an alert, check a status, reply to a
ticket. Not CSV import, not bulk operations, not multi-field authoring, and not
destructive actions whose context will not fit on a phone.

Mobile presence is **orthogonal to capability**. An operator holding `crm` may
get the queue on mobile and not the import surface, so the route table expresses
both independently rather than conflating them.

### D6 — Fix local development directly; none of the above fixes it

A new repository inherits the constraint unchanged. What blocks local work:

- **No seeded database.** The pglite fixtures already used by the integration
  tests, promoted to a dev database with representative data.
- **No local stand-in for the admin API.** The e2e spec's own header names a
  stub upstream selected by env as *"the cheaper path and the obvious next
  increment"*.
- The dev auth bypass already exists and works.

Days of work, independent of every other decision here, and it also unblocks
e2e coverage for surfaces that cannot be tested today (#243's unfinished half).

## Consequences

**Accepted:**

- One console, one repository, one release train. The governing requirement is
  met.
- `platform-auth` and `crm-country` become published packages for as long as
  `/admin/` lives. A capability change touches two repos during that window.
- Three toolchains in one CI: Node, Go, Expo/EAS. `secret-service` already
  proves Node + Go in this estate via `go.work`; mobile adds the third, with an
  app-store cadence that does not match the others.
- The secrets backend remains a separate deployable. Not a second thing to
  manage — one repo, one pipeline — but a second process.
- A documented, exercised break-glass runbook becomes a prerequisite for
  removing the Google login, not a follow-up.
- Two images and two deployments for `secret-service` reduce to one backend; its
  chart, namespace and network policies are rewritten rather than deleted.

**Required before M4 work starts:**

1. Fix `tesserix/secret-service#16` — `ProposeAll` opens an empty pull request
   when the app is already whitelisted, and the guard already exists in a
   sibling function. It matters beyond tidiness: those PRs are near-identical in
   title to `tesserix-k8s#392`, a deliberate negative control that must never be
   merged.
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

**Sequencing.** The repo move is not the first step. In order: fix and redesign
the secrets flow in place (1–2); build the platform API with boundary
enforcement; migrate `/api/admin/*` consumers onto it as product surfaces land
(#137, #152); then move the console and stand up the new mobile app. D6 happens
in parallel and immediately.

## What would change this decision

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
