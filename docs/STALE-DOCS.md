# Documents that describe systems which no longer exist

> Maintained because six separate findings during the 2026-08-14 console audit turned out
> to describe fixed or nonexistent problems. **Every one came from a document, a code
> comment, or a stale local clone — never from the live system.**

Check this file before planning against any design document in this estate.

## Known-wrong documents

| Document | What it claims | Reality (verified 2026-08-14) |
|---|---|---|
| **`CLAUDE.md`** (this repo) | Knative scale-to-zero, Cloud SQL `db-f1-micro`, ~30 `mp-*` Go microservices with per-service databases | **Zero deployed Knative Services. Zero Cloud Run. No Cloud SQL** — CloudNativePG on GKE **Standard** (not Autopilot), single cluster. The `mp-*` tier was consolidated into `mark8ly-platform-api` and `mark8ly-marketplace-api-{admin,storefront}`. |
| **`MIGRATION-MATRIX.md`** | Reads as a plan to migrate `tesserix-home`'s API layer onto the mark8ly monorepo | Documents a **completed** migration, in the opposite direction. Created by `973b014` (2026-04-30), "rebuild on tesserix-postgres + cross-DB". Its "legacy" `adminFetch` fanout has **zero callers**. Historical only — see issue #98. |
| **`services.yaml`** (`tesserix-infra`) | Reads as a deployment inventory of 46 services | A **design registry**. None of its 46 services has a chart. |
| **`docs/DOMAIN_MANAGEMENT_ARCHITECTURE.md`** | A Cloud-DNS NS-delegation issuer | Does not exist. Reality is Cloudflare CNAME-delegation to `acme.mark8ly.com`. |
| **`docs/ADR-001-DEPLOY-SYSTEM.md`** | 100+ services on GKE **and Cloud Run**, Keycloak RBAC | Superseded by ADR-002. Zero Cloud Run; Keycloak replaced by GIP; `deploy-service` was never built. |
| **`docs/DEPLOY_SYSTEM.md`** | 12 `/admin/deploy/*` routes | Contradicts the console's section model. Superseded with ADR-001. |
| **`tesserix-k8s/terraform-new/`** | Service accounts, IAM, buckets | **Outdated.** Not the source of truth. |

## Stale comments found in code

- `tesserix-k8s/charts/apps/kora-api/values.yaml` — a `TODO(ci)` saying Kora's CI pushes to
  the wrong GCP project. **Fixed 2026-07-28** (`8924efc` in `tesserix/kora`); the comment
  outlived it by weeks and made a non-issue look like an M0 blocker.

## The rule

**Trust the docs on shape; verify them on state.**

Structural claims — line counts, duplication, which file contains what — held up every
time. Claims about *state* — what exists, what is deployed, what a backend supports — did
not. Before scoping work on a claim about what exists:

- `gh api repos/<org>/<repo>` — does the repo still exist?
- `tesserix-k8s/argocd/prod` + `charts/apps` — is it actually deployed?
- `git log -- <file>` — is that TODO still true?

## Adding to this file

When a document turns out to be wrong, add a row rather than only fixing the immediate
problem. The cost here was not any single wrong finding — it was the same class of error
recurring six times because nothing recorded the first five.
