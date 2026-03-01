# Centralized Deployment & Release Management System

> **Status**: Planned | **Owner**: Platform Team | **Last Updated**: 2026-03-01

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [deploy-service (Go Microservice)](#deploy-service)
4. [Database Schema](#database-schema)
5. [API Reference](#api-reference)
6. [Frontend (tesserix-home)](#frontend)
7. [Security Model](#security-model)
8. [Integration Points](#integration-points)
9. [Infrastructure](#infrastructure)
10. [Implementation Phases](#implementation-phases)
11. [Verification Plan](#verification-plan)
12. [Decision Log](#decision-log)

---

## Overview

### Problem

Tesserix manages 100+ microservices across 6 product domains deployed to GKE (Kubernetes) and Cloud Run. Current deployment management is fragmented:

- **GitHub Actions** for CI/CD pipelines
- **ArgoCD** for GKE GitOps reconciliation
- **gcloud CLI** for Cloud Run deployments
- **Basic releases dashboard** in tesserix-home (read-only GitHub workflow status)

There is no unified control plane, no audit trail, no deployment locks, and no approval workflows.

### Solution

Build a **lean deploy-service** (Go) as a thin coordinator that wraps ArgoCD and GitHub APIs, paired with a dashboard in tesserix-home. The key principle: **deploy-service coordinates (what/when/who), existing tools do the work (ArgoCD, Config Connector, GitHub Actions).**

This is the **foundation for an Internal Developer Platform (IDP)** — start lean, grow into it.

| Capability | How | Phase |
|-----------|-----|-------|
| Unified dashboard | tesserix-home aggregates ArgoCD + GitHub status | Phase 1 |
| Service catalog | deploy-service DB (source of truth for 100+ services) | Phase 1 |
| Release catalog | GitHub webhooks register releases in deploy-service | Phase 1 |
| Deploy triggers | deploy-service tells ArgoCD to sync | Phase 1 |
| Audit trail | Immutable append-only log in deploy-service DB | Phase 1 |
| Environment locks | Simple Redis key with TTL | Phase 1 |
| RBAC | Keycloak roles checked in deploy-service middleware | Phase 1 |
| Approval workflows | GitHub Environments (Phase 1), custom (Phase 2 if needed) | Phase 1-2 |
| Cloud Run management | **Config Connector CRDs via ArgoCD** (same GitOps pipeline) | Phase 2 |
| Cost visibility | Cloud Billing API batch job | Phase 3 |
| Canary | Argo Rollouts (GKE), Config Connector traffic split (Cloud Run) | Phase 3 |

### Design Principles

1. **deploy-service is a coordinator, not a replacement** — it tells ArgoCD "sync this app", records who asked, checks they're allowed to, and logs the result
2. **ArgoCD manages BOTH GKE and Cloud Run** — Cloud Run services are managed via Google Config Connector CRDs, giving a single GitOps pipeline
3. **No custom health checker** — ArgoCD handles GKE health, Cloud Run has built-in probes
4. **No custom canary engine** — use Argo Rollouts (GKE) and Config Connector traffic blocks (Cloud Run)
5. **Start lean, grow later** — each phase is independently valuable

### Team Context

- **4-10 engineers** managing deployments
- **6 product domains**: marketplace, fanzone, HMS, bookkeeping, homechef, global
- **Multi-level approval** required for production
- **IDP future**: This service catalog + deploy system is the foundation

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     tesserix-home (Next.js 16)                       │
│  /admin/deploy/*  — Dashboard, service catalog, deploy triggers      │
│  /api/deploy/*    — BFF proxy to deploy-service                      │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ bff_home_session → JWT → Istio headers
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│               deploy-service (Go, global namespace)                   │
│                                                                       │
│  Service Registry  │  Release Catalog  │  Deployment Log              │
│  Audit Logger      │  Env Lock (Redis) │  RBAC Middleware             │
│                                                                       │
│  ┌───────────────────────────────────┐  ┌──────────────┐             │
│  │ ArgoCD Adapter                    │  │ GitHub       │             │
│  │ (sync GKE apps + Cloud Run CRDs) │  │ Adapter      │             │
│  └───────────────────────────────────┘  └──────────────┘             │
└─────────────┬────────────────────────────────┬───────────────────────┘
              │                                │
    ┌─────────▼──────┐              ┌──────────▼──────┐
    │ PostgreSQL     │              │ Redis           │
    │ (deploy DB)    │              │ (env locks)     │
    └────────────────┘              └─────────────────┘
              │
    ┌─────────▼──────────────────────────────────────────┐
    │                    ArgoCD                            │
    │  Manages:                                           │
    │  • GKE Deployments (Helm charts)                    │
    │  • Cloud Run Services (Config Connector CRDs)       │
    │  • Argo Rollouts (canary/blue-green for GKE)        │
    └─────────────────────────────────────────────────────┘
```

### Why Config Connector for Cloud Run?

Instead of deploy-service calling the Cloud Run Admin API directly, we use **Google Config Connector** — a GCP-native K8s addon that creates CRDs for GCP resources including Cloud Run.

```yaml
# This K8s manifest IS a Cloud Run service — managed by ArgoCD like any other
apiVersion: run.cnrm.cloud.google.com/v1beta1
kind: RunService
metadata:
  name: orders-service
  namespace: config-connector
spec:
  location: asia-south1
  template:
    containers:
      - image: ghcr.io/tesserix/marketplace-services/orders-service:1.5.2
    scaling:
      minInstanceCount: 0
      maxInstanceCount: 10
  traffic:
    - type: TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST
      percent: 100
```

**Benefits:**
- **One GitOps pipeline** for both GKE and Cloud Run (ArgoCD manages both)
- **deploy-service only talks to ArgoCD** — no separate Cloud Run adapter needed
- **Canary for Cloud Run** = just change the `traffic` percentages in the manifest
- **Drift detection** built-in (ArgoCD reconciles)

### Data Flow

1. **User initiates deploy** → tesserix-home → deploy-service
2. **deploy-service** checks RBAC → acquires lock (Redis) → logs audit event
3. **deploy-service** calls ArgoCD API to sync the application
4. **ArgoCD** reconciles the manifest → GKE deployment or Config Connector CRD
5. **deploy-service** polls ArgoCD for sync status → logs completion
6. **Frontend** polls deploy-service for status updates

### Responsibility Boundaries

| Component | Responsibility |
|-----------|---------------|
| **deploy-service** | Service catalog, release catalog, deployment log, audit, locks, RBAC |
| **ArgoCD** | Reconciling desired state for GKE AND Cloud Run (via Config Connector) |
| **Config Connector** | Translating K8s CRDs into Cloud Run API calls |
| **Argo Rollouts** | Canary/blue-green strategies for GKE (Phase 3) |
| **GitHub Actions** | Building images, running tests, pushing artifacts |
| **GitHub Environments** | Approval gates for production deployments (Phase 1) |
| **tesserix-home** | User interface, BFF proxy, session management |

### What deploy-service Does NOT Do (by design)

| Avoided | Why | Instead |
|---------|-----|---------|
| Custom health checker | ArgoCD + Cloud Run already do this | Poll ArgoCD health status |
| Custom canary engine | Argo Rollouts (GKE) + Config Connector traffic (Cloud Run) | Trigger ArgoCD sync |
| Custom approval workflow (Phase 1) | GitHub Environments have required reviewers | Build custom in Phase 2 if needed |
| SSE streaming | Overkill for 4-10 engineers | Poll ArgoCD status every 5s |
| Cloud Run API calls | Config Connector handles this | ArgoCD syncs CRDs |
| Cost collector (Phase 1) | Nice-to-have, not critical | Add in Phase 3 |

---

## deploy-service

### Location

```
global-services/deploy-service/
├── cmd/main.go                    # Entry point
├── internal/
│   ├── config/config.go           # Configuration (env vars)
│   ├── models/                    # GORM models
│   │   ├── service.go
│   │   ├── environment.go
│   │   ├── deployment.go
│   │   ├── release.go
│   │   ├── audit.go
│   │   └── ...
│   ├── repository/                # Data access layer
│   │   ├── service_repo.go
│   │   ├── deployment_repo.go
│   │   ├── release_repo.go
│   │   └── ...
│   ├── services/                  # Business logic
│   │   ├── deployment_service.go  # Orchestration
│   │   ├── lock_service.go        # Redis lock manager
│   │   ├── health_service.go      # Health checker
│   │   ├── canary_service.go      # Canary engine
│   │   ├── approval_service.go    # Approval workflow
│   │   ├── release_service.go     # Release catalog
│   │   ├── audit_service.go       # Audit logging
│   │   ├── cost_service.go        # Cost collection
│   │   └── target_switch_service.go
│   ├── handlers/                  # HTTP handlers (Gin)
│   │   ├── service_handler.go
│   │   ├── deployment_handler.go
│   │   ├── release_handler.go
│   │   ├── webhook_handler.go
│   │   ├── health_handler.go
│   │   ├── sse_handler.go
│   │   └── response.go
│   ├── adapters/                  # External system adapters
│   │   ├── argocd/                # ArgoCD REST API client
│   │   ├── cloudrun/              # Cloud Run Admin API client
│   │   ├── github/                # GitHub API client
│   │   ├── kargo/                 # Kargo K8s API client
│   │   └── billing/               # Cloud Billing API client
│   ├── middleware/                 # Custom middleware
│   │   ├── rbac.go                # Role-based access control
│   │   ├── rate_limit.go          # Rate limiting
│   │   └── webhook_auth.go        # HMAC signature verification
│   ├── redis/                     # Redis operations
│   │   ├── lock.go                # Distributed lock (Lua script)
│   │   ├── sse.go                 # Pub/sub for SSE
│   │   └── cache.go               # Health cache
│   └── events/                    # SSE event types
│       └── types.go
├── migrations/                    # SQL migration files
│   └── 001_initial_schema.sql
├── Makefile
├── Dockerfile
├── go.mod
├── go.sum
├── .env.example
└── docker-compose.yml             # Local dev (Postgres + Redis)
```

### Key Internal Components

#### 1. Lock Manager

Redis-based distributed lock with PostgreSQL audit trail.

```
Lock Key:    deploy:lock:{service_id}:{environment_id}
Lock Value:  {deployment_id}
TTL:         30 minutes (prevents stuck locks)
Release:     Owner-only (Lua script for atomic check-and-release)
```

**Behavior:**
- Acquiring a lock creates both a Redis key AND a `deployment_locks` row
- If a deployment finishes (success/failure), the lock is released automatically
- If a process crashes, the TTL expires and the lock auto-releases
- Environment-wide locks (`deploy:lock:env:{environment_id}`) block all service deploys

#### 2. Health Checker

Polls the service's `/health` endpoint during and after deployment.

- **During deployment**: Every 10 seconds, configurable timeout (default 5 min)
- **3 consecutive failures**: Triggers auto-rollback
- **Results stored**: In `deployment_health_checks` table for audit
- **Cached in Redis**: `deploy:health:{service_id}:{env_id}` with 30s TTL

#### 3. Canary Engine

Step-based traffic progression with health-gated advancement.

**GKE (Istio):**
```yaml
# Modifies VirtualService weights
- route:
  - destination: { host: svc, subset: stable }
    weight: 90
  - destination: { host: svc, subset: canary }
    weight: 10
```

**Cloud Run:**
```
# Uses revision traffic split
gcloud run services update-traffic --to-revisions=rev-canary=10,rev-stable=90
```

**Steps example:**
```json
[
  { "weight": 10, "pause_seconds": 300, "health_check": true },
  { "weight": 25, "pause_seconds": 300, "health_check": true },
  { "weight": 50, "pause_seconds": 600, "health_check": true },
  { "weight": 100, "pause_seconds": 0, "health_check": true }
]
```

- After each step, health checks must pass before advancing
- Manual override: advance/abort/set-custom-weight
- Failure at any step: auto-revert to 100% stable

#### 4. Approval Workflow

Required for production environments (configurable per environment).

**Rules:**
- Environments with `requires_approval = true` hold deployments in `pending_approval`
- `required_approvers` defines how many approvals needed (default: 1)
- **Self-approve prevention**: The `initiated_by` user cannot approve their own deployment
- Rejection cancels the deployment with comment

**Notification flow:**
- On pending approval: dispatch via existing notification-service
- On approval/rejection: notify the deployment initiator

#### 5. Target Switch Orchestrator

State machine for migrating services between GKE and Cloud Run.

```
PLANNED → VALIDATING → DUAL_RUNNING → TRAFFIC_SHIFTING → CUTOVER_PENDING → COMPLETED
                                            ↕
                                         ABORTING → ABORTED
```

| State | Description |
|-------|-------------|
| PLANNED | Switch created, config validated |
| VALIDATING | New target provisioned, health check running |
| DUAL_RUNNING | Both targets serving (0% new) |
| TRAFFIC_SHIFTING | Gradual traffic shift (10% → 25% → 50% → 100%) |
| CUTOVER_PENDING | 100% on new target, awaiting human confirmation |
| COMPLETED | Old target scaled to 0, 24h rollback window |
| ABORTING | Reverting traffic to original target |
| ABORTED | Fully reverted |

**Human confirmation required** before final cutover (CUTOVER_PENDING → COMPLETED).

#### 6. SSE Event Emitter

Server-Sent Events for real-time deployment progress.

```
Redis Channel:  deploy:sse:{deployment_id}
HTTP Endpoint:  GET /v1/deployments/:id/events (SSE stream)
```

**Event types:**
- `deployment.status_changed` — status transitions
- `deployment.health_check` — health check results
- `deployment.canary_advanced` — canary weight changed
- `deployment.log` — deployment log entries
- `deployment.completed` — terminal event

---

## Database Schema

### Entity Relationship Diagram

```
services ──< service_environments >── environments
    │                  │
    │                  │
    ├──< deployments ──┤
    │        │         │
    │        ├──< deployment_approvals
    │        ├──< deployment_health_checks
    │        └──< deployment_locks
    │
    ├──< releases
    ├──< cost_snapshots
    └──< target_switches

audit_events (standalone, immutable)
```

### Tables

#### services
Source of truth for all 100+ services.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | Auto-generated |
| slug | VARCHAR(100) UNIQUE | URL-safe identifier (e.g., `settings-service`) |
| display_name | VARCHAR(200) | Human-readable name |
| product_domain | VARCHAR(50) | `marketplace\|fanzone\|hms\|bookkeeping\|homechef\|global` |
| service_type | VARCHAR(20) | `backend\|frontend\|worker\|cron` |
| repo_owner | VARCHAR(100) | GitHub org (e.g., `Tesseract-Nexus` or `tesserix`) |
| repo_name | VARCHAR(100) | GitHub repo name |
| build_workflow | VARCHAR(200) | Build workflow filename |
| release_workflow | VARCHAR(200) | Release workflow filename |
| health_endpoint | VARCHAR(200) | Health check path (default: `/health`) |
| depends_on | TEXT[] | Service slugs this depends on (deploy ordering) |
| is_active | BOOLEAN | Soft delete flag |

#### environments
Deployment target environments (dev, staging, prod).

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | Auto-generated |
| slug | VARCHAR(50) UNIQUE | e.g., `dev`, `staging`, `prod` |
| display_name | VARCHAR(100) | e.g., `Development`, `Staging`, `Production` |
| gcp_project_id | VARCHAR(100) | GCP project for this environment |
| gcp_region | VARCHAR(100) | Primary GCP region |
| k8s_cluster | VARCHAR(200) | GKE cluster name (if applicable) |
| argocd_server | VARCHAR(300) | ArgoCD API endpoint |
| requires_approval | BOOLEAN | Whether deployments need approval |
| required_approvers | INTEGER | Number of approvals needed |
| deployment_window_start | TIME | Start of allowed deployment window |
| deployment_window_end | TIME | End of allowed deployment window |
| is_locked | BOOLEAN | Environment-wide lock |
| locked_by | VARCHAR(200) | Who locked it |
| locked_reason | TEXT | Why it's locked |

#### service_environments
Per-service, per-environment deployment configuration and state.

| Column | Type | Description |
|--------|------|-------------|
| service_id | UUID FK | → services |
| environment_id | UUID FK | → environments |
| deployment_target | VARCHAR(20) | `gke\|cloud_run` |
| current_version | VARCHAR(200) | Currently deployed version |
| current_image | VARCHAR(500) | Currently deployed image URI |
| desired_version | VARCHAR(200) | Target version (for drift detection) |
| cloud_run_service_id | VARCHAR(200) | Cloud Run service ID (if cloud_run) |
| cloud_run_region | VARCHAR(100) | Cloud Run region (if cloud_run) |
| k8s_namespace | VARCHAR(100) | K8s namespace (if gke) |
| argocd_app_name | VARCHAR(200) | ArgoCD application name (if gke) |
| kargo_stage | VARCHAR(100) | Kargo stage name (if using Kargo) |
| helm_chart | VARCHAR(200) | Helm chart reference |
| health_status | VARCHAR(20) | `unknown\|healthy\|degraded\|unhealthy` |

#### deployments
Immutable append-only deployment log.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | Auto-generated |
| service_id | UUID FK | → services |
| environment_id | UUID FK | → environments |
| deployment_type | VARCHAR(30) | `release\|rollback\|hotfix\|canary\|target_switch` |
| strategy | VARCHAR(30) | `rolling\|canary\|blue_green\|recreate` |
| status | VARCHAR(30) | `pending_approval\|approved\|running\|succeeded\|failed\|cancelled\|rolled_back` |
| deployment_target | VARCHAR(20) | `gke\|cloud_run` |
| from_version | VARCHAR(200) | Previous version |
| to_version | VARCHAR(200) | Target version |
| from_image | VARCHAR(500) | Previous image URI |
| to_image | VARCHAR(500) | Target image URI |
| canary_weight | INTEGER | Current canary traffic weight |
| canary_steps | JSONB | Canary progression config |
| rollback_of | UUID FK | → deployments (if this is a rollback) |
| initiated_by | VARCHAR(200) | User ID who started the deploy |
| release_notes | TEXT | Deployment notes |
| failure_reason | TEXT | Why it failed (if applicable) |

#### releases
Release catalog — all built artifacts available for deployment.

| Column | Type | Description |
|--------|------|-------------|
| service_id | UUID FK | → services |
| version | VARCHAR(200) | Semver version |
| image_uri | VARCHAR(500) | Full container image URI |
| git_sha | VARCHAR(40) | Git commit SHA |
| git_tag | VARCHAR(200) | Git tag |
| changelog | TEXT | Release notes / changelog |
| build_run_id | BIGINT | GitHub Actions run ID |
| UNIQUE | (service_id, version) | One version per service |

#### audit_events
Immutable audit log (INSERT-only — no UPDATE/DELETE grants).

| Column | Type | Description |
|--------|------|-------------|
| event_type | VARCHAR(100) | e.g., `deployment.initiated`, `lock.acquired` |
| actor_id | VARCHAR(200) | User or system ID |
| actor_email | VARCHAR(300) | Actor's email |
| actor_ip | INET | Request IP address |
| resource_type | VARCHAR(50) | e.g., `deployment`, `environment`, `service` |
| resource_id | UUID | ID of affected resource |
| payload | JSONB | Event-specific data |

*Additional tables: `deployment_approvals`, `deployment_health_checks`, `deployment_locks`, `cost_snapshots`, `target_switches` — see full schema in [migrations/001_initial_schema.sql](../global-services/deploy-service/migrations/001_initial_schema.sql).*

### Redis Key Structure

```
deploy:lock:{service_id}:{environment_id}    → deployment_id (TTL: 30min)
deploy:lock:env:{environment_id}             → lock metadata (TTL: configurable)
deploy:sse:{deployment_id}                   → pub/sub channel for SSE events
deploy:health:{service_id}:{env_id}          → cached health status (TTL: 30s)
deploy:canary:{deployment_id}                → canary state machine
deploy:workflow:{github_run_id}              → GitHub workflow polling state
```

---

## API Reference

### Base URL

```
Production:  https://deploy.tesserix.app/v1
In-cluster:  http://deploy-service.global.svc.cluster.local:8080/v1
```

### Authentication

All endpoints (except webhooks) require Istio JWT with `platform-owner: true` claim. RBAC roles checked in middleware.

### Services & Environments

| Method | Path | Description | Role |
|--------|------|-------------|------|
| GET | `/v1/services` | List services (filter: domain, target, type) | viewer+ |
| GET | `/v1/services/:slug` | Service detail + state across all envs | viewer+ |
| POST | `/v1/services` | Register new service | admin |
| PUT | `/v1/services/:slug` | Update service metadata | admin |
| GET | `/v1/environments` | List environments | viewer+ |
| GET | `/v1/environments/:slug` | Environment detail + active deploys | viewer+ |
| PUT | `/v1/environments/:slug/lock` | Acquire environment lock | deployer+ |
| DELETE | `/v1/environments/:slug/lock` | Release environment lock | deployer+ |
| PUT | `/v1/environments/:slug/config` | Update approval rules, windows | admin |

### Deployments

| Method | Path | Description | Role |
|--------|------|-------------|------|
| POST | `/v1/deployments` | Initiate deployment | deployer+ |
| GET | `/v1/deployments` | List (filter: service, env, status, date) | viewer+ |
| GET | `/v1/deployments/:id` | Detail + health checks + approvals | viewer+ |
| POST | `/v1/deployments/:id/approve` | Approve pending deployment | approver+ |
| POST | `/v1/deployments/:id/reject` | Reject pending deployment | approver+ |
| POST | `/v1/deployments/:id/cancel` | Cancel pending/running deploy | deployer+ |
| POST | `/v1/deployments/:id/rollback` | Manual rollback | deployer+ |
| GET | `/v1/deployments/:id/events` | SSE stream (real-time) | viewer+ |
| GET | `/v1/deployments/:id/logs` | Aggregated logs | viewer+ |
| POST | `/v1/deployments/:id/canary/advance` | Advance canary step | deployer+ |
| POST | `/v1/deployments/:id/canary/abort` | Abort canary | deployer+ |
| PUT | `/v1/deployments/:id/canary/weight` | Set custom weight | deployer+ |

### Releases & Promotion

| Method | Path | Description | Role |
|--------|------|-------------|------|
| GET | `/v1/releases` | List all releases | viewer+ |
| GET | `/v1/releases/:service_slug` | Release history for service | viewer+ |
| POST | `/v1/releases/:service_slug` | Register release (from webhook) | webhook |
| POST | `/v1/promote` | Promote between environments | deployer+ |
| GET | `/v1/promote/pipeline/:service_slug` | Promotion pipeline state | viewer+ |

### Target Switching

| Method | Path | Description | Role |
|--------|------|-------------|------|
| GET | `/v1/targets/:service_slug/:env_slug` | Current target + migration status | viewer+ |
| POST | `/v1/targets/switch` | Initiate GKE↔Cloud Run switch | admin |
| GET | `/v1/targets/switch/:id` | Switch progress | viewer+ |
| POST | `/v1/targets/switch/:id/confirm` | Confirm cutover | admin |
| POST | `/v1/targets/switch/:id/abort` | Abort switch | admin |

### Observability & Cost

| Method | Path | Description | Role |
|--------|------|-------------|------|
| GET | `/v1/health-status` | Aggregated health for all services | viewer+ |
| GET | `/v1/health-status/:service_slug/:env` | Detailed health + metrics | viewer+ |
| GET | `/v1/costs/summary` | GKE vs Cloud Run per service | viewer+ |
| GET | `/v1/costs/comparison/:service_slug` | Cost comparison for switch | viewer+ |
| GET | `/v1/audit` | Audit event log | viewer+ |

### Webhooks (GitHub → deploy-service)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/v1/webhooks/github/release` | Register new release | HMAC-SHA256 |
| POST | `/v1/webhooks/github/workflow-run` | Workflow status update | HMAC-SHA256 |

### Request/Response Examples

#### Initiate Deployment

```http
POST /v1/deployments
Content-Type: application/json

{
  "service_slug": "settings-service",
  "environment_slug": "staging",
  "version": "1.5.2",
  "strategy": "rolling",
  "release_notes": "Fix connection pool leak"
}
```

**Response (202 Accepted):**
```json
{
  "success": true,
  "data": {
    "id": "d7e4f3a1-...",
    "status": "running",
    "service_slug": "settings-service",
    "environment_slug": "staging",
    "from_version": "1.5.1",
    "to_version": "1.5.2",
    "strategy": "rolling",
    "initiated_by": "user@tesserix.com",
    "initiated_at": "2026-03-01T10:00:00Z"
  }
}
```

#### Initiate Deployment (prod — requires approval)

```http
POST /v1/deployments
Content-Type: application/json

{
  "service_slug": "settings-service",
  "environment_slug": "prod",
  "version": "1.5.2",
  "strategy": "canary",
  "canary_steps": [
    { "weight": 10, "pause_seconds": 300, "health_check": true },
    { "weight": 50, "pause_seconds": 600, "health_check": true },
    { "weight": 100, "pause_seconds": 0, "health_check": true }
  ]
}
```

**Response (202 Accepted):**
```json
{
  "success": true,
  "data": {
    "id": "a1b2c3d4-...",
    "status": "pending_approval",
    "required_approvers": 1,
    "pending_approvals": [
      { "id": "x1y2z3-...", "status": "pending" }
    ]
  }
}
```

#### SSE Event Stream

```http
GET /v1/deployments/d7e4f3a1-.../events
Accept: text/event-stream
```

```
event: deployment.status_changed
data: {"status":"running","previous":"approved","timestamp":"2026-03-01T10:00:05Z"}

event: deployment.health_check
data: {"type":"http","status":"pass","http_status":200,"response_ms":45}

event: deployment.canary_advanced
data: {"weight":25,"step":2,"total_steps":4}

event: deployment.completed
data: {"status":"succeeded","duration_seconds":180}
```

---

## Frontend

### Route Structure

All deploy routes live under `/admin/deploy/`:

```
/admin/deploy/                              → Dashboard
/admin/deploy/services/                     → Service registry
/admin/deploy/services/[slug]/              → Service detail
/admin/deploy/services/[slug]/deploy        → Deploy wizard
/admin/deploy/environments/                 → Environment management
/admin/deploy/environments/[env]/           → Environment detail
/admin/deploy/promotions/                   → Promotion pipeline
/admin/deploy/releases/                     → Release catalog
/admin/deploy/targets/                      → Target management
/admin/deploy/targets/switch/[id]           → Switch wizard
/admin/deploy/audit/                        → Audit trail
/admin/deploy/costs/                        → Cost dashboard
```

### BFF Proxy

```
tesserix-home/app/api/deploy/[...path]/route.ts  → proxy to deploy-service
tesserix-home/app/api/deploy/deployments/[id]/events/route.ts  → SSE proxy
```

Uses `adminFetch('deploy-service', path)` pattern — same auth flow as other services.

### Component Architecture

```
DeployDashboard
├── ProductDomainTabs            (All | Marketplace | FanZone | HMS | ...)
├── EnvironmentStatusBar         (dev | staging | prod — health badges)
├── ActiveDeploymentsPanel       (SSE-driven, real-time progress)
│   └── ActiveDeploymentCard     (progress bar, canary %, rollback)
├── ServiceHealthGrid            (100+ services, color-coded)
│   └── ServiceHealthCard        (version, target, health, quick deploy)
└── RecentDeploymentsTable

ServiceDetailPage
├── ServiceHeader                (slug, domain, repo link)
├── EnvironmentMatrix            (row per env: version, target, health)
├── DeployWizard (dialog)
│   ├── Step 1: Version select   (from release catalog)
│   ├── Step 2: Strategy select  (rolling | canary | blue-green)
│   ├── Step 3: Canary config    (steps, pause, health checks)
│   ├── Step 4: Review & confirm (diff: from → to)
│   └── Step 5: Executing        (SSE feed, health results)
├── PromotionPipelineCard        (dev → staging → prod)
└── DeploymentHistoryTable

EnvironmentPage
├── LockBanner                   (who locked, why, unlock)
├── DeploymentWindowStatus
├── ActiveDeploymentsList
├── ServiceEnvironmentTable      (all services in this env)
└── EnvironmentConfigPanel       (approval rules, window)

PromotionPipelinePage
├── PromotionFlowDiagram         (visual pipeline per service)
├── PendingApprovalsPanel        (approve/reject with comments)
└── PromotionHistoryTable

TargetManagementPage
├── CostComparisonTable          (GKE vs Cloud Run per service)
├── MigrationCandidatesPanel     (recommended switches)
└── ActiveSwitchesPanel
    └── TargetSwitchCard         (progress, traffic split, confirm/abort)

AuditPage
├── AuditFilters                 (actor, type, resource, date)
└── AuditTable                   (immutable log, CSV export)
```

### State Management

| Pattern | Usage |
|---------|-------|
| `useApi()` hooks | All server state (services, environments, deployments) |
| SSE hooks | Real-time deployment progress (custom `useDeploymentSSE()` hook) |
| 30s polling | Health grid (100+ services — SSE per-service is too expensive) |
| `apiFetch()` | Mutations (deploy, approve, reject, lock, etc.) |

### SSE Hook Pattern

```typescript
// lib/api/deploy.ts
export function useDeploymentSSE(deploymentId: string | null) {
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [status, setStatus] = useState<DeploymentStatus>('unknown');

  useEffect(() => {
    if (!deploymentId) return;

    const source = new EventSource(`/api/deploy/deployments/${deploymentId}/events`);

    source.addEventListener('deployment.status_changed', (e) => {
      const data = JSON.parse(e.data);
      setStatus(data.status);
      setEvents(prev => [...prev, data]);
    });

    source.addEventListener('deployment.completed', () => {
      source.close();
    });

    return () => source.close();
  }, [deploymentId]);

  return { events, status };
}
```

---

## Security Model

### 1. Transport & Authentication

- **Istio mTLS** between all services (mesh-internal)
- **Istio AuthorizationPolicy** requires `platform-owner: true` JWT claim on all deploy-service endpoints (except webhooks)
- **Webhook endpoints** authenticated via HMAC-SHA256 signature (`X-Webhook-Signature` header)

### 2. RBAC (Keycloak Roles)

| Role | Permissions |
|------|------------|
| `platform-admin` | Full access — all environments including prod, service CRUD, config |
| `platform-deployer` | Deploy to dev/staging directly; initiate prod (requires approval) |
| `platform-approver` | Approve/reject production deployments |
| `platform-viewer` | Read-only access to all dashboards and logs |

**Enforcement**: deploy-service Go middleware checks JWT roles on every request. Role hierarchy is checked server-side — never trust frontend.

### 3. Guardrails

| Guard | Enforcement |
|-------|------------|
| Deployment locks | Redis atomic lock prevents concurrent deploys to same service+env |
| Self-approve prevention | `initiated_by` cannot appear in `approver_id` for same deployment |
| Deployment windows | Server-side time check; reject deploys outside configured window |
| Audit immutability | PostgreSQL user has INSERT-only on `audit_events` (no UPDATE/DELETE) |
| Rate limiting | 10 mutation actions per minute per user (Redis-backed) |

### 4. Secrets

| Secret | Storage | Access |
|--------|---------|--------|
| ArgoCD token | GCP Secret Manager | deploy-service SA only |
| GitHub token | GCP Secret Manager | deploy-service SA only |
| Webhook HMAC secret | K8s Secret | deploy-service + GitHub Actions |
| Deploy DB credentials | GCP Secret Manager | deploy-service SA only |
| Cloud Run SA key | Workload Identity | deploy-service K8s SA → GCP SA |

---

## Integration Points

### GitHub Actions

**Reusable workflow** (`register-release.yml`) called by all 94 release workflows:

```yaml
# .github/workflows/register-release.yml
on:
  workflow_call:
    inputs:
      service_slug: { required: true, type: string }
      version: { required: true, type: string }
      image_uri: { required: true, type: string }
    secrets:
      DEPLOY_SERVICE_WEBHOOK_SECRET: { required: true }

jobs:
  register:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -X POST $DEPLOY_URL/v1/webhooks/github/release \
            -H "X-Webhook-Signature: sha256=$(echo -n '${{ toJson(inputs) }}' | openssl dgst -sha256 -hmac '${{ secrets.DEPLOY_SERVICE_WEBHOOK_SECRET }}')" \
            -H "Content-Type: application/json" \
            -d '{
              "service_slug": "${{ inputs.service_slug }}",
              "version": "${{ inputs.version }}",
              "image_uri": "${{ inputs.image_uri }}",
              "git_sha": "${{ github.sha }}",
              "build_run_id": ${{ github.run_id }}
            }'
```

### ArgoCD (Single Pipeline for GKE + Cloud Run)

- deploy-service calls ArgoCD REST API (`/api/v1/applications/{name}/sync`)
- For Kargo-managed services: creates `Promotion` CRs via K8s API
- ArgoCD manages **both** GKE deployments and Cloud Run services (via Config Connector)
- deploy-service never calls Cloud Run API directly — ArgoCD handles it

### Cloud Run via Config Connector

Cloud Run services are managed as **K8s Custom Resources** using [Google Config Connector](https://cloud.google.com/config-connector/docs/overview):

```yaml
# ArgoCD syncs this → Config Connector creates/updates Cloud Run service
apiVersion: run.cnrm.cloud.google.com/v1beta1
kind: RunService
metadata:
  name: orders-service
  namespace: config-connector
spec:
  location: asia-south1
  template:
    containers:
      - image: ghcr.io/tesserix/marketplace-services/orders-service:1.5.2
        ports:
          - containerPort: 8080
    scaling:
      minInstanceCount: 0
      maxInstanceCount: 10
  traffic:
    - type: TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST
      percent: 100
```

- **Same GitOps workflow** as GKE: commit manifest → ArgoCD syncs → Config Connector applies
- **Canary**: Change `traffic` block percentages (e.g., 90% stable + 10% canary revision)
- **Rollback**: Revert manifest to previous image tag
- **No separate Cloud Run adapter** in deploy-service — ArgoCD is the single deployment path

### GitHub Org Migration (tesseract-nexus → tesserix)

The `services` table has `repo_owner` and `repo_name` fields — update per service as repos migrate:

```http
PUT /v1/services/settings-service
{ "repo_owner": "tesserix", "repo_name": "global-services" }
```

Old and new image URIs coexist in the `releases` table (`image_uri` stores full path).

---

## Infrastructure

### New Components

| Component | Namespace | Description |
|-----------|-----------|-------------|
| deploy-service | `global` | Go service (Helm chart in `tesserix-k8s/charts/apps/deploy-service/`) |
| deploy-db | `global` | PostgreSQL database (dedicated `deploy` DB) |
| Redis keyspace | `global` | Reuse existing Redis, add `locks` keyspace prefix |

### Terraform Changes

| Stack | Change |
|-------|--------|
| stack-06 (workload-identity) | deploy-service SA + IAM bindings |
| stack-07 (secrets) | Deploy DB credentials |
| stack-10 (cloud-run) | Cloud Run Admin API IAM roles for deploy-service SA |

### ArgoCD Application

```yaml
# argocd/prod/apps/global/deploy-service.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: deploy-service
  namespace: argocd
spec:
  project: global
  source:
    repoURL: https://github.com/tesserix/tesserix-k8s
    path: charts/apps/deploy-service
    targetRevision: HEAD
  destination:
    server: https://kubernetes.default.svc
    namespace: global
```

### Helm Values (Key)

```yaml
# charts/apps/deploy-service/values.yaml
replicaCount: 2
image:
  repository: ghcr.io/tesserix/deploy-service
  tag: latest

env:
  SERVER_PORT: "8080"
  DB_HOST: "postgresql.global.svc.cluster.local"
  DB_NAME: "deploy"
  REDIS_URL: "redis://redis.global.svc.cluster.local:6379"
  ARGOCD_API_URL: "https://argocd-server.argocd.svc.cluster.local"
  GCP_PROJECT_ID: "tesserix-prod"

serviceAccount:
  annotations:
    iam.gke.io/gcp-service-account: deploy-service@tesserix-prod.iam.gserviceaccount.com

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi

probes:
  liveness:
    path: /health
    port: 8080
  readiness:
    path: /ready
    port: 8080
```

---

## Implementation Phases

### Phase 1: Lean Foundation (Weeks 1-3)

**Critical fixes to existing code (first):**

1. Add authorization to all mutation endpoints in tesserix-home (`/api/releases/promote`, `/sync`, `/rollout`, `/promote-group`)
2. Fix ArgoCD `prune: true` default to `prune: false`
3. Scope ArgoCD token (service account with `get` + `sync` only)
4. K8s RBAC for tesserix-home ServiceAccount
5. Replace in-process `Map` cache with `unstable_cache`

**Backend (lean deploy-service):**

6. Scaffold `global-services/deploy-service/` Go module
7. Database schema: `services`, `environments`, `service_environments`, `releases`, `deployments`, `audit_events` tables
8. Seed service registry from existing `services.ts` (expand to all 100+ services)
9. Core CRUD API: services, environments, releases
10. GitHub webhook receiver (release registration)
11. Simple Redis environment lock (one key with TTL)
12. Audit event logging (append-only)
13. ArgoCD adapter: sync + status polling
14. RBAC middleware (check Keycloak JWT roles)
15. Deploy to `global` namespace

**Frontend (tesserix-home):**

16. Create `/admin/deploy/` route group with layout
17. Build `DeployDashboard` — aggregates ArgoCD status + deploy-service data
18. Build `ServiceDetailPage` with environment matrix and deploy button
19. Build `AuditPage` (read-only log)

**Integration:**

20. Add `register-release` step to 1 pilot workflow (auth-bff)
21. Wire deploy-service to ArgoCD API (sync + health polling)

### Phase 2: Config Connector + Approvals (Weeks 4-6)

**Infrastructure:**

1. Install Config Connector addon on GKE cluster
2. Create Config Connector RunService manifests for Cloud Run services
3. Add Config Connector-managed apps to ArgoCD (Cloud Run services now GitOps-managed)

**Backend:**

4. Custom approval workflow (if GitHub Environments prove insufficient)
5. Deployment window enforcement
6. Rate limiting on mutations
7. Promotion pipeline (dev → staging → prod) logic

**Frontend:**

8. DeployWizard (version select → strategy → review → execute)
9. PromotionPipelinePage + pending approvals
10. EnvironmentPage with lock controls

**Integration:**

11. Roll out `register-release` to all 94 workflows
12. Configure Keycloak roles: `platform-admin`, `platform-deployer`, `platform-approver`, `platform-viewer`
13. Kargo integration for GKE promotion pipelines

### Phase 3: Cost Intelligence + Canary (Weeks 7-9)

**Backend:**

1. Cloud Billing API integration (daily batch for cost snapshots)
2. Cost comparison logic (GKE vs Cloud Run per service)

**Infrastructure:**

3. Argo Rollouts setup for GKE canary/blue-green
4. Config Connector traffic split manifests for Cloud Run canary

**Frontend:**

5. CostComparisonPage
6. Canary deployment controls in deploy wizard
7. Migrate existing `/admin/releases` to `/admin/deploy/releases`

**Validation:**

8. Full E2E testing of all workflows
9. Verify Config Connector manages Cloud Run services correctly

---

## Verification Plan

| # | Test | Description | Acceptance Criteria |
|---|------|-------------|-------------------|
| 1 | Unit tests | Go tests for lock manager, health checker, canary, RBAC | 80%+ coverage on core packages |
| 2 | Integration tests | deploy-service → ArgoCD, Cloud Run, GitHub (mocked) | All adapters pass with mock servers |
| 3 | E2E smoke | Deploy test service via UI → ArgoCD sync → health pass → audit | End-to-end pass in staging |
| 4 | Lock contention | Two concurrent deploys to same service | Second deploy returns 409 Conflict |
| 5 | Approval flow | Initiate prod deploy → pending → approve → deploy proceeds | Status transitions correct |
| 6 | Canary test | Deploy canary → verify traffic split → advance → health checks | Traffic weights match config |
| 7 | Rollback test | Deploy bad version → auto-rollback triggers | Previous version restored |
| 8 | Target switch | GKE → Cloud Run in staging → abort → verify revert | Full state machine transitions |
| 9 | Auth test | platform-viewer attempts deploy | Returns 403 Forbidden |

---

## Decision Log

### Why deploy-service + Config Connector instead of off-the-shelf?

| Tool | GKE | Cloud Run | Approvals | Canary | Target Switch | Verdict |
|------|-----|-----------|-----------|--------|--------------|---------|
| ArgoCD alone | Native | No | Via Kargo | Via Rollouts | No | Needs Cloud Run |
| Flux + Flagger | Native | No native | Via Flagger | Via Flagger | No | Lateral move |
| Google Cloud Deploy | Via Skaffold | Native | Built-in | Built-in | Partial | Loses Keycloak/Istio |
| **deploy-service + ArgoCD + Config Connector** | Via ArgoCD | Via ArgoCD + Config Connector | Built-in | Via Argo Rollouts + CC traffic split | Built-in | **Best fit** |

**Decision**: ArgoCD manages **both** GKE and Cloud Run (via Config Connector). deploy-service is a thin coordinator that orchestrates what/when/who.

**Reasons:**
1. ArgoCD already deployed and working — no migration cost
2. Config Connector enables ArgoCD to manage Cloud Run as K8s CRDs — single GitOps pipeline for both targets
3. No separate Cloud Run adapter needed — ArgoCD is the single deployment path
4. Neither Flux nor Flagger supports Cloud Run natively
5. Google Cloud Deploy requires Skaffold, loses Keycloak RBAC + Istio auth integration
6. deploy-service stays lean: coordinates and tracks, doesn't reimplement deployment machinery
7. Foundation for future Internal Developer Platform (IDP) — start thin, grow into it

### Anti-Patterns to Avoid

| Anti-Pattern | Why | Instead |
|-------------|-----|---------|
| Store deploy state in localStorage/React | State loss on refresh/tab close | All state server-side in deploy-service |
| UI as only deployment path | Bus factor, no automation | ArgoCD CLI / GitHub Actions / kubectl always work |
| `Promise.allSettled` for ordered operations | Wrong execution order | Topological sort from `depends_on` |
| Session cookie = authorization | Authentication ≠ Authorization | Check Keycloak roles via RBAC middleware |
| Target switch as single API call | Too complex, needs human gates | Multi-step state machine with confirmation |
| Module-level `Map` for production state | Memory leak, pod-local | Redis or Next.js cache |

---

## Appendix: Environment Variables

### deploy-service

```env
# Server
SERVER_PORT=8080
GIN_MODE=release

# Database
DB_HOST=postgresql.global.svc.cluster.local
DB_PORT=5432
DB_USER=deploy_service
DB_NAME=deploy
DB_SSLMODE=require

# Redis
REDIS_URL=redis://redis.global.svc.cluster.local:6379

# ArgoCD
ARGOCD_API_URL=https://argocd-server.argocd.svc.cluster.local
ARGOCD_AUTH_TOKEN=<from GCP Secret Manager>

# GitHub
GITHUB_TOKEN=<from GCP Secret Manager>
GITHUB_WEBHOOK_SECRET=<from K8s Secret>

# GCP
GCP_PROJECT_ID=tesserix-prod
GCP_REGION=us-central1

# Keycloak
KEYCLOAK_BASE_URL=https://internal-idp.tesserix.app
KEYCLOAK_REALM=tesserix-internal

# Notifications
NOTIFICATION_SERVICE_URL=http://notification-service.global.svc.cluster.local:8090
```

### tesserix-home (additions)

```env
# Deploy service
DEPLOY_SERVICE_URL=http://deploy-service.global.svc.cluster.local:8080
```
