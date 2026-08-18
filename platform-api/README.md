# platform-api

The Tesserix platform API — one deployable, internally modularised by domain.
Decided in [ADR-003](../docs/ADR-003-CONSOLE-TOPOLOGY.md) D2; scaffolded by
[#277](https://github.com/tesserix/tesserix-home/issues/277).

**It currently serves two probes and composes no domain modules.** That is
deliberate: the scaffold proves the delivery path end to end while the only
thing at risk is a health check.

## Why it exists

The console consumes eight endpoints from `apps/web`'s admin API and reads
`tesserix-postgres` directly through its own pool. ADR-003 D1 and D7 retire
both: every read and write the console performs eventually crosses this API,
and `apps/web` is left holding only the marketing site.

## Layout

```
cmd/server/          composition — the only place allowed to import every module
internal/
  platform/          the kernel: config, database, httpx. Depends on no module.
    config/          environment loading and validation
    database/        the tesserix-postgres pool
    httpx/           the error envelope, the probes, JSON conventions
  modules/           domain modules. See doc.go for the rule.
  architecture/      the import-graph check that enforces that rule
```

## The module boundary rule

**A module must not import another module.** Modules compose through the kernel,
or through an interface the consumer defines and the provider satisfies.

Two mechanisms, because one is not enough:

- **Go `internal/` visibility.** A module's guts live under
  `modules/<name>/internal/…`, which only code rooted at `modules/<name>/` may
  import. The compiler refuses anything else.
- **The import-graph check** in `internal/architecture`. `modules/billing`
  importing `modules/tickets` — the public package, not its internals —
  *compiles perfectly well*, because they share the `modules/` root. That is
  the import a modular monolith actually dies of, and it is what the check
  forbids.

Both were verified against a deliberate violation before this landed:
`go build` accepted the cross-module import and the check rejected it.

ADR-003 D2a makes the whole modular-monolith decision contingent on this
enforcement landing with the *first* module, not the third — which is why it
ships against an empty `modules/` directory.

Read `internal/modules/doc.go` before adding a module.

## Running it

```sh
TESSERIX_DB_HOST=localhost \
TESSERIX_DB_USER=tesserix \
TESSERIX_DB_PASSWORD=… \
TESSERIX_DB_SSLMODE=disable \
go run ./cmd/server
```

It reads the **same** database with the **same** credentials as the console and
`apps/web` — `apps/console/lib/db/tesserix.ts` says so in its own header. No
migration is involved in adopting a domain; a module is a Go rewrite of queries
that already exist.

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `APP_ENV` | `development` | |
| `TESSERIX_DB_HOST` | — | required |
| `TESSERIX_DB_PORT` | `5432` | |
| `TESSERIX_DB_USER` | — | required |
| `TESSERIX_DB_PASSWORD` | — | required |
| `TESSERIX_DB_NAME` | `tesserix` | |
| `TESSERIX_DB_SSLMODE` | `require` | |
| `TESSERIX_DB_MAX_CONNS` | `2` | see below |

Startup fails loudly and names every missing variable at once, rather than
booting half-configured and failing on the first request.

### The pool is small on purpose

`TESSERIX_DB_MAX_CONNS` defaults to **2**, matching the console. ADR-003 D2a
treats the pool constraint as measured rather than theoretical: ~30 services
share a small Postgres, and the console's `max: 2` is written into its code as
the reason a suppression check shares its caller's transaction rather than
opening a second connection.

Starting at 2 makes the migration net-neutral by construction — this pool rises
as modules land while the console's falls as its data layer retires under D7.
Raising it should be a deliberate act with a reason.

## Probes

| | | |
|---|---|---|
| `GET /health` | liveness | **Does not touch the database.** A liveness probe that fails on a dependency outage asks Kubernetes to restart a working process, which cannot bring the database back and adds restart churn to an incident. |
| `GET /ready` | readiness | Checks the database. A pod that cannot reach Postgres should leave the rotation without being killed. Answers `SERVICE_UNAVAILABLE`, not an internal error — the distinction [#198](https://github.com/tesserix/tesserix-home/issues/198) exists for. |

## Conventions

**Error envelope** — `{code, message, details?}`, field-compatible with
`go-shared`'s `AppError` so a client written against another Tesserix service is
not surprised. The module itself is **not** imported; see the reasoning in
`internal/platform/httpx/errors.go`.

**No ORM.** pgx directly. The data layer this service is absorbing is
hand-written SQL — keyset pagination (#240, #241) and a contact clock that must
advance in the same transaction as an activity insert (#245). Porting that
through a query builder turns a mechanical translation into a re-derivation.

**net/http, not Gin.** A deviation from the estate, recorded in
`internal/platform/httpx/router.go` with the trigger for revisiting it.

## Tests

```sh
go test ./...                                  # everything
go test ./internal/architecture/...            # the boundary rule
```

CI runs `gofmt`, a tidy check, `go vet`, the boundary check as its own step, and
`go test -race`.

## Not done yet

Authentication ([#278](https://github.com/tesserix/tesserix-home/issues/278) —
Zitadel, both principals), the conventions document and the first module
([#269](https://github.com/tesserix/tesserix-home/issues/269) — tickets), and
the Helm chart, ArgoCD Application and Kargo stage, which live in `tesserix-k8s`
and `kargo-manifests`.
