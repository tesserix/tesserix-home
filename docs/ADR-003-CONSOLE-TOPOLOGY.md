# ADR-003: Console topology — platform API, repo boundary, and the secrets surface

**Status**: Proposed
**Date**: 2026-08-18
**Related**: [ADR-002: Delivery visibility on ArgoCD + Kargo](./ADR-002-DELIVERY-VISIBILITY.md)

## Context

Four questions arrived together, and they interact enough that deciding them
separately is how an estate ends up with four auth paths — the condition #165
exists to unpick.

1. Should the console gain a **Go backend**, because APIs are needed to
   integrate with products?
2. Should the console move to a **new repository**, leaving `tesserix-home` as
   a marketing site?
3. Should the console Next app be split into **multi-zone**?
4. Should **`secret-service`** migrate into the console (M4), and what happens
   to its deliberately independent authentication?

They are answered here as one decision because the answer to each constrains
the others.

### Verified state, 2026-08-18

Everything below was read from the code, the cluster, or the running
deployment rather than from documentation. Where a document disagreed, the
document was wrong.

| Premise | Verified state |
|---|---|
| "the console needs a Go backend for pod-identity auth" | Not on its own. `secret-service`'s API uses OpenBao Kubernetes auth (a projected ServiceAccount token) and GCP Workload Identity; a Next.js pod has both. The blocker is not language. |
| "the console is coupled to `apps/web`" | Partly, and it is narrowing. `packages/platform-auth` mints the `tx_session` cookie on `.tesserix.app` that **both** apps read; `console-core` holds routes, capabilities and the estate registry. Under Zitadel the console has its own `/auth`, so the login coupling is already gone. |
| "the console is not independently deployable" | It already is. Own `Dockerfile.console`, own image, own Kargo promotion. Six promotions were observed on 2026-08-18, each within minutes of merge. |
| "`tesserix-home` becomes marketing once the console is done" | Not yet true. `apps/web` still serves `/api/admin/*`, which the console consumes server-side (the audit log reads `apps/web`'s `/api/admin/apps/all/audit-logs`). It is the console's backend today. |
| "local development is slow because the repo is large" | The evidence points elsewhere. The Playwright suite runs with `TESSERIX_DB_*` unset and **every CRM surface renders its error state by design**; #245's real end-to-end proof had to be pglite integration tests. The constraint is absent dependencies, not build size. |
| "`secret-service` is a secrets browser" | Its README is materially stale. It is a GitOps proposal flow: it opens pull requests against `tesserix-k8s`, edits `values.yaml` and the ArgoCD AppProject, and carries an in-app review/approve/merge/reject queue. |
| "`secret-service` cannot read secret values" | True, and enforced outside its own code: the OpenBao policy grants `create/update/delete` on `kv/data/*` and **no `read`** — *"so that compromising the console still yields no secret value."* The equivalent GCP claim (a custom role excluding `versions.access`) is **unverified**; that role is not in either repository. |
| "moving secrets into the console is an auth swap" | It is a circularity. Zitadel's **own** session signing key and login-client PAT are stored in OpenBao under `kv/data/hms/api/*`. A secrets tool gated on Zitadel cannot be used to fix Zitadel. |
| "two-person integrity would carry over" | It would not, automatically. It is enforced by GitHub branch protection, not application logic — the service holds no permission to merge. One operator holding `rotate-credentials` in a unified console could propose and merge from one UI. |

## Decision

### D1 — A Go platform API, as its own service, not as "the console's backend"

Products needing to call platform capabilities is a real requirement and Go is
the right choice for it: the estate's services are Go, they share `go-shared`,
and the work involves subscribers and workers rather than request-scoped
handlers.

But that is a **platform API**, not a console BFF. The console's own needs —
reading the platform database, proxying to product APIs — are served by Next.js
route handlers today and no evidence was found that they are not.

So: build it as a service alongside the existing ones. #152 (migrate
`/api/internal/*` off `apps/web`) is already this work under another name, and
#161 (internal token scoping, the Fe3dr blanket gateway) is its authorisation
model.

**Rejected:** one console backend absorbing every platform concern. See D4 —
the blast-radius argument against it is concrete.

### D2 — The console stays in `tesserix-home` until the APIs leave it

The clutter argument is sound. The `/admin/` freeze exists *because* the apps
share a repo and a CI run, and every console change rebuilds and tests the
legacy admin.

But splitting now carries `platform-auth` and `console-core` across a repo
boundary. `platform-auth` mints the session cookie both apps read; `console-core`
holds the capability vocabulary that M12 (#244) is about to change repeatedly.
Every capability addition would become a two-repo publish.

**Sequence:** build the platform API (D1) → migrate `/api/admin/*` consumers
onto it as product surfaces land (#137) → *then* split, when the shared packages
are the only coupling left and `apps/web` really is marketing.

The end state is the one proposed. The disagreement is only about doing it
first.

### D3 — No multi-zone for now

Multi-zone earns its cost with independent teams or slow builds. There is one
deploy cadence and `next build` takes a couple of minutes.

Against that, its costs land on exactly what is being built this quarter:

- **The shell is estate-wide.** The sidebar and command palette span every
  surface — the palette searches tickets, CRM and tools together. Each zone
  ships its own shell, making `console-core` a published contract and a nav
  change a coordinated release.
- **RBAC enforcement would be per-zone.** #244 R2 puts surface refusal in
  middleware. Multi-zone implements that security control once per zone, and one
  zone omitting it is a silent hole — the failure #264's coverage test exists to
  catch, made structurally harder.
- **Cross-zone navigation is a full page load.** Ticket → the customer's CRM
  record is the console's most common transition.

**Revisit when:** a second team owns a surface, or `next build` becomes a
measured constraint. Nothing here forecloses it; the contracts multi-zone would
need (`console-core` routes and capabilities) are being firmed up by M12 anyway.

### D4 — `secret-service` keeps its API, its namespace, and its independent authentication

Move **only the UI**, and only after the flow is fixed.

**The API stays where it is.** It runs in its own namespace with read-only
Kubernetes RBAC, an OpenBao-facing NetworkPolicy, metadata-server access
restricted to one pod, and a GitHub PAT that can write anywhere in
`tesserix-k8s`. Merging that into the console namespace puts the CRM, the ticket
queue and the secret store in one blast radius — the opposite of what that
isolation is for.

**Authentication stays independent.** Google + `ADMIN_EMAILS`, re-checked per
request. The circularity is concrete: Zitadel's own secrets live in the store
this tool administers. Either keep Google as the authenticator for the secrets
surface, or accept the coupling only once Zitadel is HA **and** its bootstrap
secrets live somewhere not gated by Zitadel.

**If the UI moves, proxy it through a console route handler** on the console's
own origin. Today `/api/*` and the UI are same-origin, so the cookie is
first-party and CORS never enters the picture. A proxy preserves that by
construction; a cross-origin call would mean widening `ALLOWED_ORIGINS`,
revisiting `SameSite`, and re-examining the `__Host-` cookie prefix.

**Two-person integrity must be preserved explicitly.** It rests on branch
protection, not code. Confirm `main` protection on `tesserix-k8s`, and do not
let one capability grant both propose and merge.

### D5 — Fix local development directly, because none of the above fixes it

The stated goal — develop and test locally, faster — is a dependency problem,
not a repo-layout problem. A new repository inherits it unchanged.

What actually blocks it:

- **No seeded database.** The pglite fixtures already used by the integration
  tests should be promoted to a dev database with representative CRM data.
- **No local stand-in for `apps/web`'s admin API.** The e2e spec's own header
  names this: a stub upstream selected via `WEB_INTERNAL_ORIGIN` is *"the
  cheaper path and the obvious next increment"*.
- The dev auth bypass already exists and works.

This is days of work, independent of every other decision here, and it also
unblocks e2e coverage for surfaces that cannot be tested today (#243's
unfinished half).

## Consequences

**Accepted:**

- The platform API becomes a new service repo, with its own lifecycle. One more
  service in an estate that already runs ~30.
- `tesserix-home` keeps both apps for longer than the end state implies, and the
  `/admin/` freeze remains the mechanism protecting the legacy admin.
- The console keeps a single Next app, and `console-core` remains an internal
  workspace package rather than a published one.
- The secrets surface keeps a second identity provider. That is a deliberate
  exception to "one estate, one IdP" and should be recorded as such in #165's
  ADR rather than treated as drift.
- Two deployments and two images for `secret-service` reduce to one if the UI
  moves; the API's chart, namespace and policies are untouched.

**Deferred, not rejected:**

- The console repo split (D2), pending the API migration.
- Multi-zone (D3), pending a second team or a measured build problem.
- Absorbing the `secret-service` API (D4), pending Zitadel HA and a bootstrap
  path that does not depend on it.

**Required before M4 work starts:**

1. Fix `tesserix/secret-service#16` — `ProposeAll` opens an empty pull request
   when the app is already whitelisted. The guard already exists in a sibling
   function. It matters beyond tidiness: those empty PRs are near-identical in
   title to `tesserix-k8s#392`, a deliberate negative control that must never be
   merged.
2. Redesign the flow in place, before moving it: the "new secret" dialog opens a
   whitelist PR and creates no secret; a grant writes the OpenBao role *before*
   its PR exists, so a live grant can survive a rejected proposal with no
   reconciliation; and three separate paths whitelist an app, producing
   differently-titled PRs and differently-shaped audit events.
3. Verify the GCP custom role that is claimed to exclude `versions.access`. It
   is not in either repository, and it is half of the "cannot read values"
   property.

## What would change this decision

- **D1/D2**: if `apps/web`'s admin API migrates faster than expected, the repo
  split becomes cheap sooner. The trigger is the coupling, not the calendar.
- **D3**: a second team owning a console surface, or a build time that measurably
  slows delivery.
- **D4**: Zitadel becoming HA, with its own bootstrap secrets stored outside the
  store it gates. That removes the circularity and makes a single IdP defensible.
- **D5**: none — this should happen regardless.
