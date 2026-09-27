# DevAI workload secret broker

DevAI's OpenBao adapter expects the workload broker formerly provided by the
standalone secret-service. The current console secrets API did not include those
routes, so `/internal/v1/workload-secrets/capabilities` returned 404 and new user
credentials could not be saved. Port the existing reviewed handler and Kubernetes
TokenReview adapter into the current API; default it off until explicitly scoped.

The assets are per-user provider credentials. Unauthenticated clients and other
workloads must not gain access. Kubernetes TokenReview verifies the requested
audience and the handler then checks the exact service-account subject allowlist.
Every path uses the configured namespace/app prefix, a 32-character owner hash,
and a bounded normalized secret name. The trusted DevAI workload owns the mapping
between authenticated users and owner hashes; an end-user bearer token is not a
workload credential. Foreign workload subjects receive 404. The console's Zitadel
capability checks remain separate and unchanged.

The interface is GET capabilities, PUT a nonempty bounded value, and DELETE a
soft-deleted value under `/internal/v1/workload-secrets`. It has no credential read,
list, or destroy route. It reuses the existing blind OpenBao client and metadata-only
audit logger. Kubernetes RBAC grants TokenReview, and existing namespace networking
restricts callers. No new datastore, service, background worker or infrastructure
capacity is needed. Request handling uses the existing server timeouts and bounded
body size.

Enable only with `WORKLOAD_SECRET_BROKER_ENABLED=true`, explicit audience,
comma-separated allowed subjects, namespace and app. DevAI's production settings
are audience `secret-service`, subject `system:serviceaccount:devai:devai-api`, and
prefix `devai/devai-api`. Invalid enabled configuration fails startup. Rollback is
a reviewed GitOps disablement of the flag; it restores the prior unavailable-write
behavior while existing OpenBao reads continue through the DevAI reader role.

Validation covers audience verification, missing/foreign identities, fixed paths,
malformed names, audit value redaction, soft deletion and route authentication.
The all-routes authorization test includes the broker routes. Full race-enabled
Go tests, formatting, vet and build passed locally. Deployment acceptance requires
DevAI workload capabilities, write/readback through the existing reader, and denial
for a different Kubernetes subject before migration/source deletion.
