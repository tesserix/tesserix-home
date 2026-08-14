# ADR-002: Delivery visibility on ArgoCD + Kargo (supersedes ADR-001)

**Status**: Accepted
**Date**: 2026-08-14
**Supersedes**: [ADR-001: Centralized Deployment & Release Management System](./ADR-001-DEPLOY-SYSTEM.md)

## Context

ADR-001 (Accepted, 2026-03-01) decided to build a custom Go `deploy-service` as a
deployment orchestrator, with a `tesserix-home` frontend under `/admin/deploy/`, and
explicitly **rejected** "Extend ArgoCD + Argo Rollouts" on the grounds that it offered
"no Cloud Run, no cost visibility, no target switching".

Five months later, every premise that decision rested on is false.

### What ADR-001 assumed, and what is actually true

| ADR-001 premise | Verified state (2026-08-14) |
|---|---|
| "100+ microservices across 6 product domains" | Services were consolidated. The `mp-*` tier and the shared platform tier no longer exist as repos or deployments (see issue #109); the platform runs as `mark8ly-platform-api`, `mark8ly-marketplace-api-{admin,storefront}`, `mark8ly-auth-bff`. `services.yaml` is a design registry, not a deployment inventory. |
| "deployed to GKE **and Cloud Run**" | **Zero Cloud Run resources.** Zero deployed Knative Services. One GKE **Standard** cluster (`tesseract-prod-in-gke`), single Spot node pool. `istio-config/values-prod.yaml` sets `cloudRun.enabled: false` — "all services migrated to GKE". |
| "integrates with **Keycloak** RBAC" | Keycloak was replaced by Google Identity Platform. Residual Keycloak references survive only in `istio-auth-policies` JWT config. |
| "Ability to switch services between GKE and Cloud Run" | Not a capability anyone needs — there is no second target. |
| Rejection reason: "no cost visibility" | OpenCost and Kubecost are deployed, and `lib/metrics/opencost.ts` already queries `/allocation/compute`. |
| `deploy-service` would be built (9 weeks, 3 phases) | **It was never built.** No repo, no chart, no ArgoCD app, no local source. |

### What exists now that did not exist in March

**Kargo** is deployed with 7 projects (`devai`, `homechef`, `infra`, `mark8ly`,
`support-platform`, `tesserix-blog`, `tesserix-home`), exposed at `kargo.tesserix.app`
behind Dex OIDC. Its `Freight`, `Promotion` and `Stage` objects carry per-product image
tags, timestamps, actor and outcome — which is the audit trail ADR-001 set out to build.

ArgoCD supplies live sync and health state per Application.

**And the console is already provisioned to read both.** `charts/apps/company/values.yaml`
sets `ARGOCD_API_URL`, the ExternalSecret syncs `ARGOCD_AUTH_TOKEN` from GCP Secret
Manager, and the NetworkPolicy already opens egress to the `argocd` namespace. **Zero
lines of code in `apps/web` use any of it.**

## Decision

**Do not build `deploy-service`.** Build a read-only **Delivery** surface in the console
on the ArgoCD and Kargo APIs.

The console's job is the cross-cutting view neither tool can produce:

- **One fleet row** — product → ArgoCD app → live image tag → Kargo Stage → sync/health →
  last promotion. ArgoCD is app-centric and Kargo is project-centric; nobody holds the
  fleet view today.
- **Workloads with a Kargo annotation but no Stage.** ~40 apps across 6 nonexistent Kargo
  projects currently sit in this state, including `kora-api`, `dwellm8-api`, `openbao` and
  `obs-api`/`obs-ui`. **Kargo cannot report a Stage that does not exist**, so this is
  invisible in both tools by construction — a computed, console-only fact.
- **Registered-vs-present drift** — 51 Application manifests in git that Kustomize never
  builds.

Scope additions to the `apps` registry: `argocd_app`, `kargo_project`, `kargo_stage`,
`image_repo`.

**Explicitly out of scope**, and deferred until something demands them: deployment locks,
approval workflows, target switching, and any write path. The console reads; ArgoCD and
Kargo remain the control plane.

## Rationale

1. **ADR-001's differentiators no longer differentiate.** Cloud Run support and target
   switching were the two things a custom service offered over ArgoCD+Kargo. Neither
   exists to support.
2. **The rejected alternative is now the deployed one.** Kargo was adopted after ADR-001
   and already does the orchestration ADR-001 specified.
3. **Cost.** ADR-001 budgeted 9 weeks for a Go service plus its database, Redis locks, SSE
   layer and adapters. `git shortlog` across the estate shows roughly **two engineers**. A
   9-week service to replace a read-only view of two APIs that already run is
   disproportionate, and ADR-001's own "Negative" section names the maintenance burden.
4. **The plumbing is already paid for.** Token, URL and network path exist and are unused.

## Consequences

### Positive
- The delivery timeline (BACKLOG J1) moves from "blocked on a new service" to a
  read-only surface with credentials already in place.
- No new critical-path dependency: if the console is down, ArgoCD and Kargo are unaffected.
- The Kargo-annotation-without-a-Stage gap becomes visible; today it is silent, and four
  live workloads deploy only by hand-editing git because of it.

### Negative
- No approval gates and no deployment locks. **Today there are none anyway** — every
  product auto-promotes straight to prod with `autoPromotionEnabled: true`, no
  `spec.verification` and no AnalysisTemplate anywhere in the repo. This ADR does not make
  that worse, but it does not fix it either; see issue #108.
- Two APIs to integrate rather than one owned service, each with its own auth.

### Risks
- **Kargo API stability.** Mitigation: the surface is read-only and degrades to ArgoCD-only
  data if Kargo is unreachable.
- **`docs/DEPLOY_SYSTEM.md` (1178 lines) specifies 12 `/admin/deploy/*` routes** that
  contradict the console's section model. Mitigation: retire that document with this ADR;
  do not leave two competing route plans in the repo.

## Follow-up

- Retire `docs/DEPLOY_SYSTEM.md`, or mark it superseded in its header.
- Fix the four Kargo-annotation-without-a-Stage workloads (issue #108) — that is a real
  delivery defect the new surface would merely report.
