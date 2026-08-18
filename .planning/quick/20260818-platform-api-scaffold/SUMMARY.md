---
status: complete
date: 2026-08-18
issue: 277
---

# Platform API scaffold (#277)

## Shipped

A Go service at `platform-api/` serving two probes and composing no domain
modules, with its delivery path and boundary enforcement in place.

## Verified, not assumed

- **The boundary rule bites.** A deliberate `modules/billing` →
  `modules/tickets` import was created: `go build` accepted it (exit 0), the
  checker rejected it. Then `billing` → `tickets/internal/repository`: the
  compiler rejected that one. Both mechanisms demonstrated, then removed.
- **The service runs against a real Postgres.** Image built, run against
  postgres:15. `/health` stayed 200 with the database stopped; `/ready` returned
  503 `SERVICE_UNAVAILABLE`. The password appeared zero times in the logs.
- **Startup fails loudly.** With no credentials the process exits naming all
  three missing variables at once.

## Decisions made and recorded

| | |
|---|---|
| **go-shared declined** | Confirmed by Mahesh. Private repo (would need a credential in two build paths), its auth packages are GIP/OpenFGA which ADR-003 D8 replaces, and secret-service does not use it either. The envelope shape is mirrored field-for-field, with a test asserting it does not drift. |
| **No ORM; pgx directly** | The data layer being absorbed is hand-written SQL — keyset pagination (#240, #241), a contact clock sharing a transaction (#245). An ORM turns a mechanical port into a re-derivation. |
| **net/http, not Gin** | A deviation from the estate. Go 1.22+ ServeMux covers what is needed; one fewer dependency. Revisit trigger recorded when #278's middleware lands. |
| **Pool `max: 2`** | Matches the console. Migration is net-neutral by construction — this rises as modules land while the console's falls under D7. |

## Corrected during the work

- I claimed go-shared was dormant on Mahesh's report. **It is not** — remote
  pushed 2026-08-14, tagged to v1.8.3. The local checkout was stale. Recorded in
  `httpx/errors.go` so the false reason is not rediscovered as fact.
- Hand-rolled `replaceAll`/`indexOf` in `database.go` when `strings` has both.
  Replaced before commit.

## Coverage

74.3% total; 85.7% across tested packages. The gap is `cmd/server` (`main` and
`run` — process wiring), which is exercised by the manual end-to-end run above
but not automated. Stated rather than papered over.

## Findings worth acting on separately

- **`secret-service`'s Dockerfile references base images that do not exist.**
  `ghcr.io/tesserix/base-go-builder` and `base-distroless-static` are not
  published under the org. This scaffold uses upstream images instead.
- **`main` is not branch-protected on this repo.** Relevant because ADR-003 D4
  rests two-person integrity on branch protection — for `tesserix-k8s`, but
  worth knowing.

## Not done

The Helm chart, ArgoCD Application and Kargo stage — they live in `tesserix-k8s`
and `kargo-manifests`, so they are separate PRs in separate repos. Until they
land, "#277 acceptance: `/health` responds in the dev cluster" is unmet.
