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
| **`docs/superpowers/plans/2026-08-14-m0-foundation.md`** (entry gate) | Kora's CI "pushes to a different GCP project, so the image 404s" — named as a blocking M0 entry-gate condition | **Already fixed; the gate condition was stale when written.** `gh api orgs/tesserix/packages/container/kora%2Fkora-api/versions` returns a version created 2026-08-14T06:09Z tagged both `latest` and `8b6c523…`, the commit whose CI went green at 06:01Z. Same root cause as the `values.yaml` `TODO(ci)` below — fixed 2026-07-28 by `8924efc`, and the claim outlived it into a *new* document. |

### The M0 entry gate, as actually verified (2026-08-14)

The gate named three conditions. Checking each against the live system rather than the plan
gave a materially different answer — one condition was already met, and **the blocker that
actually mattered was not on the list at all**:

| Gate condition | Verified reality |
|---|---|
| CI must push to `ghcr.io/tesserix/kora/kora-api` | **Already true.** See the row above. |
| The `kargo-kora` project must exist | **True.** `kargo-manifests/projects/kora/{project.yaml,stages/prod.yaml,warehouses/services.yaml}` — Project, Namespace and ProjectConfig all present. |
| `kora-postgres` must have backups | **Blocked.** `tesserix-k8s#241` open, unmerged. |
| *(unnamed by the plan)* | **Blocked, and decisive.** The Kargo warehouse subscribes to `branch: deploy` in `tesserix/kora`; that branch **does not exist** (404 — only a WIP `ci/advance-deploy-branch`). The CI job meant to fast-forward it, `kora#161`, is still open. It watches `deploy` rather than `main` deliberately, to avoid promoting a commit before its image is pullable. With no such branch, Kargo discovers zero freight and Kora cannot ship — green CI and a published image notwithstanding. |

The lesson is narrower than "the gate was wrong": a gate written as a list of *remembered*
blockers drifts in both directions. It kept a fixed problem on the list and never learned
about the one that replaced it. Re-derive gate conditions from the live system at the moment
you need them, not from the last document that enumerated them.

### A second failure mode: documents describing an API that does not exist

Distinct from stale *state*, and it recurred four times across two plans. Briefs specified
`StatusBadge status=` as a domain value, a props-based `EmptyState`, and a `LoadingState`
component; the M0 plan then described `BulkActionsBar` as taking `destructive`/`run`,
`ErrorState`'s `code`/`details` as non-strings, `StatusBadge`'s `status` as a domain value
again, and `BreadcrumbLink` as accepting `asChild`. **Every one was wrong**; the real
`@tesserix/web` `.d.ts` files won in all four cases (see PR #114).

Notably the M0 plan *itself* carried a constraint saying "read a component's real API before
using it" — and its own briefs still got four APIs wrong. A warning about a failure mode is
not a substitute for checking. Read `node_modules/@tesserix/web/dist/components/<name>/`
before writing the JSX.

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
