# platform-api

The Tesserix platform API — one deployable, internally modularised by domain.
Decided in [ADR-003](../docs/ADR-003-CONSOLE-TOPOLOGY.md) D2; scaffolded by
[#277](https://github.com/tesserix/tesserix-home/issues/277).

**It serves two probes and the tickets module.** The scaffold ([#277](https://github.com/tesserix/tesserix-home/issues/277)) proved the delivery
path end to end while the only thing at risk was a health check; the tickets
module ([#269](https://github.com/tesserix/tesserix-home/issues/269)) is the
first domain on it, and the conventions every later module copies were derived
from building it.

**Read [docs/PLATFORM-API-CONVENTIONS.md](../docs/PLATFORM-API-CONVENTIONS.md)
before writing the second module.**

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
    tickets/         the cross-product support queue (#269)
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
shipped against an empty `modules/` directory, one commit before there was
anything to enforce it on.

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
| `TESSERIX_DB_NAME` | `tesserix_admin` | matches the console
| `TESSERIX_DB_SSLMODE` | `require` | |
| `TESSERIX_DB_MAX_CONNS` | `2` | see below |
| `PLATFORM_API_AUTH_ENABLED` | `true` | opt-**out** since #269; see below |
| `ZITADEL_ISSUER` | — | required unless auth is off |
| `ZITADEL_PROJECT_ID` | — | required unless auth is off |
| `ZITADEL_CONSOLE_CLIENT_ID` | — | **optional**; see below |

### Authentication is on by default

It was opt-in while the service composed no modules and there was nothing to
protect. The tickets module is the event that comment was waiting for, so the
default flipped.

Setting `PLATFORM_API_AUTH_ENABLED=false` is now a request to serve a domain
module unauthenticated, which `httpx.RegisterModule` refuses by panicking at
wiring time — the escape hatch still exists and no longer opens onto anything.
The Zitadel values come from
[tesserix-k8s#446](https://github.com/tesserix/tesserix-k8s/pull/446).

Startup fails loudly and names every missing variable at once, rather than
booting half-configured and failing on the first request.

### `ZITADEL_CONSOLE_CLIENT_ID` labels the audit trail

It is the console's Zitadel application id. A token minted for it is an
operator's; anything else is a machine. The classification comes from the
`client_id` claim rather than from the shape of the claims, because an access
token carries no `email` at all and inferring from that recorded every human as
a service (#450).

Deliberately **not required**. It decides `Principal.Kind`, which is audit
labelling and never authorisation, so making it a boot dependency would let an
attribution setting take the API down. Unset is not silent either: the service
warns once at startup that every principal will be recorded as a service.

`Kind` is the whole of what the client id buys, and verification is otherwise
entirely local. #450 also fetched an operator's name and email from the
issuer's userinfo endpoint; #453 removed both consumers — the audit trail is
keyed by subject, and a staff reply to a merchant is signed "Tesserix Support"
— so the lookup was removed rather than left on the authentication path of
every operator request with nothing reading its result.

### The pool is small on purpose

`TESSERIX_DB_MAX_CONNS` defaults to **2**, matching the console. ADR-003 D2a
treats the pool constraint as measured rather than theoretical: ~30 services
share a small Postgres, and the console's `max: 2` is written into its code as
the reason a suppression check shares its caller's transaction rather than
opening a second connection.

Starting at 2 makes the migration net-neutral by construction — this pool rises
as modules land while the console's falls as its data layer retires under D7.
Raising it should be a deliberate act with a reason.

## The AI usage ingest

A second binary, `cmd/ai-usage-ingest`, writes the AI cost and token ledger the
console's AI usage surface reads. agentgateway exports OTLP spans to it, it
publishes them to JetStream keyed by span id, and a durable consumer writes
`ai_usage_events` and `ai_usage_hourly` in one transaction.

Separate from the API because their failure modes must not be shared: the
console has to keep answering while ingest is behind, and a burst of gateway
telemetry must not contend with an operator's page load. Same image, same
module — `internal/modules/aiusage/internal/ingest` owns both sides of the
ledger's shape so the reader and the writer cannot drift.

```sh
TESSERIX_DB_HOST=localhost \
TESSERIX_DB_USER=tesserix \
TESSERIX_DB_PASSWORD=… \
TESSERIX_DB_SSLMODE=disable \
AI_USAGE_NATS_URL=nats://localhost:4222 \
go run ./cmd/ai-usage-ingest
```

| Variable | Default | |
|---|---|---|
| `AI_USAGE_INGEST_ADDR` | `:4318` | OTLP/HTTP listener; `POST /v1/traces` |
| `AI_USAGE_NATS_URL` | in-cluster `nats` | JetStream, stream `AI_USAGE` |

It reads `config.LoadDatabase()` rather than `config.Load()`: it serves no
authenticated route, and demanding Zitadel settings it never uses would only
teach operators to set them to something false.

## Probes

| | | |
|---|---|---|
| `GET /health` | liveness | **Does not touch the database.** A liveness probe that fails on a dependency outage asks Kubernetes to restart a working process, which cannot bring the database back and adds restart churn to an incident. |
| `GET /ready` | readiness | Checks the database. A pod that cannot reach Postgres should leave the rotation without being killed. Answers `SERVICE_UNAVAILABLE`, not an internal error — the distinction [#198](https://github.com/tesserix/tesserix-home/issues/198) exists for. |

## Conventions

**Response envelope** — `go-shared`'s `StandardResponse`:
`{success, data|error, meta?, timestamp, request_id}`. The module itself is
**not** imported; see the reasoning in `internal/platform/httpx/errors.go`, and
the reversal of the scaffold's flatter shape in `response.go`.

**Keyset pagination** — cursors, honest totals, no page numbers (#240, #241).
A malformed cursor is a 400, never a silent first page.

**Idempotency** — `Idempotency-Key` on writes, recorded in the same transaction
as the write.

**Auditing** — the writer audits, in the operation's transaction, into
`console_audit_log`.

All four are argued at length in
[docs/PLATFORM-API-CONVENTIONS.md](../docs/PLATFORM-API-CONVENTIONS.md).

**No ORM.** pgx directly. The data layer this service is absorbing is
hand-written SQL — keyset pagination (#240, #241) and a contact clock that must
advance in the same transaction as an activity insert (#245). Porting that
through a query builder turns a mechanical translation into a re-derivation.

**net/http, not Gin.** A deviation from the estate, recorded in
`internal/platform/httpx/router.go` with the trigger for revisiting it.

## Tests

```sh
go test ./...                                  # everything the laptop can run
go test ./internal/architecture/...            # the boundary rule
```

**Most of what matters needs a database.** Every test that touches SQL goes
through `internal/platform/testdb`, which applies `apps/web/db/migrations` to a
fresh database per test — so a query is tested against the schema it will
actually run on. They **skip** without `TESSERIX_TEST_DB_HOST`, which keeps
`go test ./...` usable on a laptop, and CI fails if anything skipped there.

```sh
docker run -d --name pg -e POSTGRES_PASSWORD=testpass -p 55432:5432 postgres:15-alpine

TESSERIX_TEST_DB_HOST=localhost \
TESSERIX_TEST_DB_PORT=55432 \
TESSERIX_TEST_DB_PASSWORD=testpass \
go test -race ./...
```

`TESSERIX_TEST_DB_*`, never the service's own `TESSERIX_DB_*` — a suite that
picks up ambient production credentials and then truncates something is a
category of accident worth designing out.

Golden response files live in
`internal/modules/tickets/internal/handler/testdata/`. Regenerate with
`-update-golden` and read the diff: they are the contract the console's parsers
are written against.

CI runs `gofmt`, a tidy check, `go vet`, the boundary check as its own step, a
no-test-skipped check, and `go test -race`.

## Not done yet

The console can call this service and does not yet. `apps/console` speaks both
backends and `PLATFORM_API_ORIGIN` chooses; unset — the deployed state — is the
current behaviour exactly. The blocker is not this module: the console keeps
only the ID token at login and has no Zitadel access token to present
(ADR-003 D8). §10 of the [conventions](../docs/PLATFORM-API-CONVENTIONS.md)
lists what turning it on needs, in order.

Beyond tickets: the CRM and audit module (ADR-003 D7a — they move together, or
`auditedOperation`'s guarantee becomes a distributed transaction), secrets
(D3), and telemetry.
