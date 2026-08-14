# Console deployment — design

**Status:** approved 2026-08-14
**Goal:** deploy `apps/console` to `console.tesserix.app` with a working live platform dashboard, proving the delivery path before product surfaces are built on it.

> **Note on detail level.** This repository is public. Infrastructure identifiers — GCP project names, Artifact Registry paths, GSM secret keys, cluster-internal DNS — are referred to by role rather than reproduced here. The exact values live in `tesserix-k8s`, and the PR against that repo carries them.

## Context

M0 landed `@tesserix/console-core`, `@tesserix/platform-auth`, the `apps/console` scaffold and the console kit (PR #114). None of it is deployed: the root `Dockerfile` builds `apps/web` only, no chart or ArgoCD Application exists for a console, and `console.tesserix.app` returns a Cloudflare 403 for an unrouted hostname.

Kora's port (M0 Tasks 5–6) remains blocked on delivery problems in other repositories. Deploying the console does not depend on it, and proving the delivery path while nothing depends on it is cheaper than proving it under pressure later.

Two facts discovered during design shape everything below:

1. **The session cookie is already scoped to `.tesserix.app`.** A console on a sibling subdomain inherits the session. It needs no OAuth flow of its own, and the known cross-origin `returnTo` limitation stays cosmetic rather than blocking.
2. **`apps/web` already exposes `/api/admin/dashboard`**, returning live platform counts across both databases, gated on the session cookie. A live dashboard therefore does **not** require pulling the deferred `platform-data` extraction forward.

## Goals

- A second deployable image for `apps/console`, built and promoted by the existing pipeline
- `console.tesserix.app` serving the console behind the existing session gate
- A live platform dashboard as the console's index, rendered through the kit
- All production configuration landed by PR against `tesserix-k8s`, never a direct commit

## Non-goals

- Extracting `platform-data` (`lib/db`, `lib/metrics`) — stays M1
- Porting Kora or any product surface — still gated
- Reducing `apps/web`'s route count — that is the M0 cutover, separately blocked
- Autoscaling, VPA, KEDA or uptime probes for the console — no traffic yet to justify them
- Changing how `apps/web` is built, promoted or served

## Architecture

### 1. Build and image

A second image, `tesserix-console`, built from **`Dockerfile.console` at the repository root** — not inside `apps/console`. The build context must be the workspace root regardless (it needs `pnpm-workspace.yaml`, the lockfile and `packages/*`), and keeping both Dockerfiles side by side makes their divergence visible. It mirrors the existing root `Dockerfile`, substituting the console's paths and entrypoint.

`apps/console/next.config.ts` already sets `output: "standalone"` and the correct `outputFileTracingRoot`, so the build shape matches. Unlike the web image, it must also copy `packages/console-core` and `packages/platform-auth` manifests in the dependency layer.

The image is separate from the web image rather than a combined one: a single image would couple two independent release lifecycles permanently and ship each app's dependencies to the other.

CI gains a second build-and-push step on `main`, using the conventions the existing pipeline and its consumers already depend on:

- `docker build --platform linux/amd64` (single-arch Docker v2 manifest)
- tags `main-<sha7>` and `latest`

Both must match, because the Kargo warehouse's tag regex and its deliberately-omitted `platform:` filter depend on them.

### 2. Delivery

The console is promoted by the **existing `tesserix-home` Kargo project**, not a new one:

- a second image subscription is added to its `services` warehouse
- the prod Stage's `argocd-update` step gains a `console` app alongside `company`

Both images are built from the same commit, so a single Freight promoting both is the accurate model — the two images are always the same source revision.

Two constraints already documented in that warehouse must be preserved when editing it:

- **No `platform:` filter.** Adding one silently drops every tag.
- **Keep `allowTagsRegexes` pinned** to the `main-<sha7>` form.

### 3. Chart and routing (`tesserix-k8s` PR)

A new chart modelled on the existing `company` chart, deliberately smaller:

| Included | Omitted, and why |
|---|---|
| Deployment, Service, ServiceAccount | HPA / VPA / KEDA ScaledObject — no traffic to scale |
| Ingress + VirtualService (`console.tesserix.app`) | Uptime-probe CronJob — add when the console is load-bearing |
| ConfigMap, ExternalSecret | Rollout RBAC — not needed until it self-updates |
| NetworkPolicy, PodDisruptionBudget, AuthorizationPolicy | |

A matching ArgoCD Application carries the `kargo.akuity.io/authorized-stage` annotation, without which Kargo refuses to mutate it.

An Istio AuthorizationPolicy must permit console → web on the admin API path, and the existing admin-surface deny policy must be checked against the new workload rather than assumed compatible.

### 4. Configuration and secrets

| Setting | Value | Why |
|---|---|---|
| Session cookie domain | `.tesserix.app` | Matches web, so the session is shared across subdomains |
| Public web URL | The web app's public origin | The console's unauthenticated redirect currently points at a localhost default; without this, production login is broken |
| Internal web origin | Cluster-internal service address | Dashboard calls stay inside the mesh rather than egressing to the public internet |
| Session encryption key | **The same secret as the web deployment** | The console must verify cookies the web app issued |

The shared session key is the sensitive part of this design. There is existing precedent in the same chart — an internal API token already shared with another admin workload from one source key, annotated "rotating means rotating both at once". The console's secret carries the same warning, naming both consumers.

No OAuth client, redirect URI or callback route is added for the console. It consumes the cookie the web app's flow issues.

### 5. The dashboard surface

The console's index becomes a server component that reads `/api/admin/dashboard` from the web app, forwarding the caller's session cookie, and renders through the kit — `PageHeader`, `StatTile`, and `SurfaceStateView`.

Tiles: tenants (total and active), stores, active apps, and leads bucketed by status.

A small typed client in `apps/console/lib/` owns the call. Its responsibilities:

- forward the session cookie from the incoming request
- validate the response shape at the boundary, so a changed contract fails loudly rather than rendering as zeroes
- **preserve the HTTP status on failure**, so `resolveState` can distinguish a 501 (instrumentation unavailable) from a 500 (error) — the distinction the kit exists to make

This is the one place the console depends on the web app at runtime, and the guard against that dependency is the typed boundary.

## Error handling

| Failure | Behaviour |
|---|---|
| No session | Middleware redirects to the web app's login (already implemented) |
| Dashboard endpoint returns 501 | `instrumentation-unavailable` — visibly parked, never zeroes |
| Dashboard endpoint returns any other error | `error` state with a retry |
| Response shape unrecognised | Treated as an error, not coerced — a silently-wrong dashboard is worse than a visibly broken one |
| Web app unreachable | `error` state; the console shell and nav still render |

## Testing

- Unit: the dashboard client — cookie forwarding, status preservation, and rejection of a malformed response
- Unit: state resolution for each failure mode above
- Existing suites must stay green: console-core, platform-auth, console, web
- Manual, post-deploy: an authenticated session on the web origin resolves on `console.tesserix.app` without re-login; an unauthenticated request redirects rather than serving a 200

No new end-to-end tests. The behaviour worth asserting here is the client's, and it is unit-testable.

## Risks

| Risk | Mitigation |
|---|---|
| Shared session key across two workloads | Documented at both consumers; rotation is a coordinated action |
| Console depends on the web app at runtime | Typed boundary; the shell degrades to an error state rather than failing to render |
| Untyped contract with `/api/admin/dashboard` | Response validated at the boundary |
| Editing a shared Kargo warehouse could disturb web's promotion | The two documented gotchas are preserved explicitly; the change is additive |
| A dead deployment if products stay blocked | The dashboard is real and useful independent of any product port |

## Rollout

1. `tesserix-home`: Dockerfile, CI build/push, dashboard client and surface — one PR
2. `tesserix-k8s`: chart, ArgoCD Application, Istio policy, secret wiring — one PR, reviewed and merged by a human
3. `kargo-manifests`: warehouse subscription and Stage update
4. DNS for `console.tesserix.app`
5. Verify: unauthenticated redirect, authenticated dashboard, correct state when the endpoint fails

Steps 2–4 touch repositories that auto-sync to production. Nothing there is committed directly.
