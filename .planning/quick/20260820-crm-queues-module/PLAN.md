# CRM queues: the second platform-API module, and the two extractions it settles

Implements the second module #269 called for, and settles the two kernel
decisions that were deliberately deferred until a second module existed.

Spec: `docs/PLATFORM-API-CONVENTIONS.md` (the conventions doc derived from
tickets). Template: `platform-api/internal/modules/tickets/`.

## Why queues, and why not the smaller-looking slices

Four CRM slices were surveyed. Two look smaller and are not:

- **Suppressions** is the trap. `isSuppressed` (`crm-repo.ts:1257`) and
  `findMatchingOrganisationId` (`:1433`) take an optional transaction handle,
  and THREE other write paths pass their own — `logActivity` via
  `assertNoSuppressedContact` (`:863`), `createContact`/`createOrganisation` via
  `assertNotSuppressed` (`crm-writes.ts:59`), and `commitImport` (`:1650`). Move
  that table behind HTTP and those become cross-service reads from inside a
  transaction, which §8 forbids.
- **Activities** is one insert that also writes `crm_opportunities` (the contact
  clock, `crm-repo.ts:915`) and reads `crm_suppressions`. Three tables per write.

Queues is the slice whose READS stress the undecided kernel piece while its
WRITE stays a single-column UPDATE with no cross-transaction coupling.

## What this plan does NOT do

- **No console migration.** The console keeps reading Postgres directly. Tickets
  shipped the same way (behind `PLATFORM_API_ORIGIN`, conventions §10); the
  console's dual-backend seam for CRM is a separate change, and mixing it in
  would make the contract and the cutover one reviewable unit when they are two.
- **No other CRM verb.** Twelve other write verbs exist; they follow once the
  seams below are settled.
- **No cursor-format reconciliation.** Console cursors (`direction|ts|uuid`) and
  Go cursors (versioned JSON) are mutually unreadable, and `paging/cursor.go:24`
  already argues that is acceptable while cursors stay opaque. It only becomes a
  problem at cutover, which is out of scope here — but note it there.

## Verified prerequisite

`testdb` applies all 29 migrations to a fresh database. `0021`'s guard is
`IF EXISTS (SELECT 1 FROM leads) AND NOT EXISTS (…migrated rows)`; no migration
seeds `leads`, so on a fresh database the first condition is false and the guard
passes. CRM Go tests are not blocked. (This was flagged as unverified and on the
critical path; it is now verified.)

## Tasks

### Task 1: extract `perform` into the kernel

`service.perform` (`modules/tickets/internal/service/service.go:267`) binds a
write, its audit row and its idempotency record in ONE transaction. §9 says it
moves when a second module needs it. This is that moment.

New kernel package — suggest `internal/platform/write`. It must carry:
- the `operation` type: `func(ctx, tx) (payload any, entry audit.Entry, status int, err error)`
- the pre-transaction replay `Lookup`, the transaction, and the concurrent-claim
  loser replaying the winner's stored body (`service.go:315`)
- `Written` (payload + status), or its kernel equivalent

Requirements:
- **Behaviour identical.** Tickets' existing tests are the proof; they must pass
  unchanged. If a test needs editing to accommodate the move, that is a signal
  the move changed something — stop and report rather than editing the test.
- Move the reasoning comments with the code. The "why all three are in one
  transaction" block is the most valuable thing in that function.
- The comment saying it is "a candidate for the kernel, not yet kernel" is now
  wrong — replace it with what the second module showed about the seam.
- `internal/architecture` must still pass: kernel depends on no module.

### Task 2: honest counts into `internal/platform/paging`

`paging.Page[T]` is `{Rows, HasMore}` (`cursor.go:154`). Tickets carries
`Total`, `Preceding`, `NextCursor`, `PreviousCursor` in its OWN
`repository.Page` (`repository/tickets.go:123`). A second module needing the
same counts would make a third copy, so the seam moves now.

Requirements:
- Extend the kernel so a module gets rows + `Total` + `Preceding` + both
  cursors without hand-rolling a page type. Whether that is a richer
  `Page[T]`, a `CountedPage[T]`, or a helper that assembles one is the
  implementer's call — argue it in the code.
- **`Total` and `Preceding` stay SQL-counted, never inferred.** A cursor carries
  no position of its own; that is why `Preceding` is counted rather than derived
  (`repository/tickets.go:128`).
- Keep the pointer semantics the wire relies on: in `httpx.Meta`
  (`response.go:83`) `preceding_count` and `total` are pointers so 0 ≠ absent.
- Tickets adopts it. Its golden files must not change — if a golden diff
  appears, the extraction altered the contract and that is a bug, not an update.
- The sequential-not-concurrent count+rows reasoning (`repository/tickets.go:135`
  — the pool is capped at 2) belongs with whatever now owns the pair.

### Task 3: the queues domain and repository

`platform-api/internal/modules/crm/` — public surface `crm.go` (`Config` +
`Register`), everything else under `internal/`.

Reads, ported from `crm-repo.ts` but domain-shaped, not screen-shaped:
- **Due** — `dueOpportunities` (`crm-repo.ts:461`)
- **Drifting** — `driftingOpportunities` (`:500`), which takes a `staleDays`
  parameter Due does not
- Both go through `queuePage` (`:362`) with `filterClause` (`:239`)

Filters — the 5-axis `QueueFilter` (`:50`): `product`, `stage`, `owner`,
`country`, `followers`. Notes:
- The follower band delegates to `primaryContactFollowerClause` (`:160`) and its
  unknown-band counterpart (`:208`) — a correlated subquery over the primary
  contact, not a column predicate.
- The console uses **sentinel strings** shared with its filter bar
  (`crm-filters.ts`: `UNASSIGNED_PRODUCT`, `UNKNOWN_COUNTRY`,
  `UNKNOWN_FOLLOWERS`). **Do not adopt the sentinels on the wire.** §2 says
  resources are domain-shaped; express absence in the query grammar
  (e.g. `product_unset=true`) and say in a comment why the sentinel was not
  carried across. This is a decision, not a translation.
- Filters validated BEFORE the query (C11), same predicate builder shared by the
  count and the page so "matching" cannot mean two things.

Use the kernel from Task 2 for the page. SQL only in the repository, over a
narrow `Querier` so it takes a pool or a tx (`repository/tickets.go:36`).

### Task 4: the wire contract and the handler

- `service/wire.go` — the JSON DTOs and the domain→wire mappers, kept separate
  from domain types so the DB shape can move without moving the contract
  (`tickets/internal/service/wire.go:17`). snake_case; empty collections `[]`
  not `null`; timestamps UTC-normalised (C22).
- **Do not port `OrganisationListRow`'s shape.** The console's row carries
  denormalised primary-contact fields and counts because it is a table row
  (`crm-repo.ts:2157`). Queue rows have the same temptation. Decide what the
  DOMAIN resource is and let the console compose the rest.
- `handler` — routes with per-route capability (C14), `readLimit` default 50 /
  max 200 clamped (C13), `DisallowUnknownFields` (C12), malformed cursor → 400
  never a silent page one (C9), sentinels mapped to statuses in `fail` (C21).
- Capability: `crm` from `packages/console-core/src/routes.ts` (C14 — take it
  from there, do not invent).

### Task 5: `setNextAction` as the module's write

`crm-repo.ts:730` — a single-column UPDATE on `crm_opportunities`, audited as
`crm.next_action.set` (`crm/[organisation]/actions.ts:139`).

- Goes through the Task 1 kernel: operation + audit row + idempotency record in
  one transaction.
- **THE HAZARD.** `crm_opportunities` carries a NOT VALID CHECK
  (`0021_crm_opportunities_product_check_reinstated.sql`) —
  `stage IN ('new','contacted') OR product IS NOT NULL` — evaluated on the NEW
  ROW VERSION of every UPDATE. So a bare `next_action` bump on one of the ~155
  grandfathered rows aborts the transaction. The console dodges it with an
  explicit guard (`crm-repo.ts:934`). The Go write must do the same, with a test
  that inserts a grandfathered row (stage `qualified`, `product NULL`) and
  proves the update succeeds. Nothing in tickets behaves like this and nothing
  in the conventions doc mentions it — so it gets written down.
- Audit `action` is a stable dotted identifier and `metadata` is counts only; a
  non-identifier key is REFUSED, not stripped (C18).

### Task 6: register, and prove the boundaries

- `cmd/server` registers via `httpx.RegisterModule` (C4 — never `Register`
  directly; it panics without a verifier, including in tests).
- `internal/architecture` must pass: no module imports another (C1).
- Required tests, by name, per §9 and #269:
  - `TestEveryRouteRefusesAPrincipalWithoutTheSurfaceCapability`
  - its companion proving a refusal is not an accident (same request WITH the
    capability succeeds — otherwise a missing route satisfies the first test
    while proving nothing)
- Golden response files committed under the handler's `testdata/`.

## Global constraints

- Tests against the REAL schema via `testdb`; `TESSERIX_TEST_DB_*` only, never
  the service's own `TESSERIX_DB_*` (§9).
- HTTP tests through the real router, real verifier, real database; only the
  token signature faked.
- `go build ./...`, `go vet ./...` and `go test ./...` must pass. **Run the
  build, not only the tests** — a green test run is not evidence a package
  compiles in every configuration.
- Single-line conventional-commit messages, no signature, no Co-Authored-By.
- Comments explain WHY, matching the surrounding density. This codebase's
  comments are load-bearing; a change that removes reasoning is a regression.

## Verification

- [ ] Tickets' tests and golden files pass UNCHANGED after both extractions
- [ ] `internal/architecture` passes
- [ ] A grandfathered opportunity (stage `qualified`, `product NULL`) accepts a
      `next_action` update
- [ ] A route without the capability is refused, and the same request with it
      succeeds
- [ ] `total` and `preceding_count` are SQL-counted and survive a round trip
      through the envelope as pointers
- [ ] Malformed cursor → 400
