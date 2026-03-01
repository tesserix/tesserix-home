# ADR-001: Centralized Deployment & Release Management System

**Status**: Accepted
**Date**: 2026-03-01
**Decision Makers**: Platform Team

## Context

Tesserix manages 100+ microservices across 6 product domains deployed to GKE and Cloud Run. Deployments are managed through disconnected tools (GitHub Actions, ArgoCD, gcloud CLI, basic dashboard). There is no unified control plane, audit trail, deployment locks, approval workflows, or ability to switch between deployment targets.

## Decision

Build a custom **deploy-service** (Go) as the deployment orchestrator, with a **tesserix-home** frontend under `/admin/deploy/`. Keep ArgoCD as the GKE reconciler. deploy-service handles orchestration (what/when), ArgoCD handles reconciliation (how).

## Alternatives Considered

### 1. Flux + Flagger
- **Pros**: Native K8s, canary support via Flagger
- **Cons**: No Cloud Run support, lateral move from ArgoCD with migration cost
- **Rejected**: Same gap as ArgoCD (no Cloud Run), plus migration overhead

### 2. Google Cloud Deploy
- **Pros**: Native Cloud Run + GKE support, built-in approvals and canary
- **Cons**: Requires Skaffold, loses Keycloak RBAC integration, loses Istio auth
- **Rejected**: Poor integration with existing auth stack, vendor lock-in on delivery pipeline

### 3. Extend ArgoCD + Argo Rollouts
- **Pros**: Already deployed, native Kubernetes
- **Cons**: No Cloud Run, no cost visibility, no target switching, complex RBAC customization
- **Rejected**: Doesn't solve Cloud Run or unified view requirements

### 4. Custom deploy-service (chosen)
- **Pros**: Full control, integrates with Keycloak/Istio, supports both GKE and Cloud Run, enables target switching and cost visibility
- **Cons**: Build and maintenance cost
- **Accepted**: Best fit for our specific requirements

## Consequences

### Positive
- Single pane of glass for all 100+ services across all environments
- Full audit trail and RBAC integrated with existing Keycloak auth
- Ability to switch services between GKE and Cloud Run
- Cost visibility for infrastructure decisions
- Approval workflows for production safety

### Negative
- Additional Go service to maintain
- Must keep deploy-service and ArgoCD in sync (source of truth: ArgoCD for GKE state)
- Initial build cost (estimated 9 weeks across 3 phases)

### Risks
- deploy-service becomes a critical path dependency for deployments
  - **Mitigation**: All deployments remain achievable via ArgoCD CLI / kubectl / gcloud directly
- State drift between deploy-service DB and actual deployment state
  - **Mitigation**: Health checker reconciles every 10s; ArgoCD is authoritative for GKE

## Technical Decisions

### 1. Redis for Locks (not PostgreSQL advisory locks)
- **Reason**: TTL auto-expiry prevents stuck locks if process crashes
- **Trade-off**: Requires Redis dependency (already available in global namespace)

### 2. SSE over WebSockets for Real-time Events
- **Reason**: Unidirectional (server→client), proxy-friendly, simpler implementation
- **Trade-off**: No bidirectional communication (not needed for deployment progress)

### 3. Polling for Health Grid (not SSE per service)
- **Reason**: 100+ services × SSE connection = too many open connections
- **Trade-off**: 30s staleness on health status (acceptable for dashboard)

### 4. GORM for Database (not raw SQL)
- **Reason**: Consistent with all other Go services in the monorepo
- **Trade-off**: Some query optimization limitations (mitigated by raw SQL for complex queries)

### 5. Gin for HTTP (not stdlib)
- **Reason**: Consistent with all other Go services, middleware ecosystem, go-shared compatibility
- **Trade-off**: Framework dependency (minimal risk, widely adopted)

### 6. Append-only Deployments Table
- **Reason**: Immutable audit trail, no lost deployment history
- **Trade-off**: Table grows indefinitely (mitigated by archival policy)

### 7. Human Gate on Target Switches
- **Reason**: GKE↔Cloud Run migration is high-risk, needs human judgment
- **Trade-off**: Slower switch process (acceptable for safety)
