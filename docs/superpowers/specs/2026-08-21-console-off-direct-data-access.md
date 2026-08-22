# Taking the console off direct data access

**Status:** draft — **DECISION 1 resolved 2026-08-22** (§C1); DECISION 2 still open.
**Goal:** every console read and write reaches its data through the Go platform
API, authenticated with the operator's Zitadel token, with no direct Postgres
access and no calls into `apps/web`.

## Why this is worth doing, beyond tidiness

The obvious framing is "move SQL into Go". That is the least valuable part.

**The console currently has no authorization on most of its data.** `apps/web`'s
admin API has *zero role guards across all 57 handlers* under
`app/api/admin/**`: `middleware.ts` checks that a session exists, and
`ALLOWED_ADMIN_EMAILS` is enforced only at login. Past that gate, everyone
allowlisted can do everything. The console inherits this unchanged because the
`tx_session` cookie is scoped to `.tesserix.app`.

The platform API's contract is the opposite (§7): *"Every route names the
capability it needs. Nothing is inherited."* So this migration is the mechanism
that closes that gap, and it is the same gap #244 and #262–#267 describe. That
is the argument for doing it, and it is why the endpoints must not be ported as
"the same query behind a bearer token" — each one has to name a capability.

The console's own CRM path already does better than apps/web: every write goes
through `withCrmWrite` → `checkOperatorCapability` + `auditedOperation`. That
behaviour must survive the move, server-side.

## What is in scope

| Cluster | Endpoints | State |
|---|---|---|
| CRM queues + next action | 3 | **Go side done**; console still reads Postgres |
| CRM organisations (list, detail) | 2 | not built |
| CRM opportunity writes (stage, activity) | 2 | not built |
| CRM suppressions | 3 | not built |
| CRM import (preview, commit) | 2 | not built |
| CRM handoff + conversion link | 2 | not built |
| Conversion status | 1 | **greenfield** — console calls it; it has never existed |
| Support analytics | 1 | partly blocked |
| Estate audit log | 2 (split) | partly blocked |
| Dashboard | 0 | **no live callers** — split or delete |

## Constraints that shape every phase

### C1. The Go service can reach `tesserix_admin` and nothing else

`platform-api/internal/platform/config/config.go` builds ONE pgxpool against
`tesserix_admin`. `apps/web` additionally holds a cross-database grant into
mark8ly (`mark8ly_platform_admin`, CRUD on every table in both mark8ly
schemas).

Blocked on this, and only this: dashboard tenant/store counts, the
`tenant_names` enrichment on support analytics, and the mark8ly leg of the audit
log. All three flow through `apps/web/lib/db/mark8ly.ts`.

**DECISION 1 — does the Go service inherit that grant? — RESOLVED 2026-08-22: NO.**

Granting it repeats the coupling #210 and #160 exist to remove, on a second
service. Not granting it means those endpoints wait on mark8ly-owned APIs.
Everything blocked above hangs off this answer. Phases 1–6 do not.

**The answer is no.** `platform-api` does not inherit
`mark8ly_platform_admin`, and no cross-database grant replaces it. Every
mark8ly read reaches the console through mark8ly's own HTTP surface.

The deciding argument was not the coupling in the abstract. It is that mark8ly
was never designed for platform integration — its admin API is
`/admin/stores/:storeId/*` almost end to end, and the platform questions this
console asks have no store to scope to. A federated read does not fix that; it
hides it. The console would compensate in TypeScript for a boundary mark8ly
never drew, and that compensation is invisible from mark8ly's side, so nobody
there learns when they have broken it. Migrations in this estate are manual
while deploys are not, so the break lands unattended.

**What this costs.** The three items blocked above — dashboard tenant/store
counts, the `tenant_names` enrichment on support analytics, and the mark8ly leg
of the audit log — now wait on mark8ly-owned endpoints rather than on a grant.
That is a dependency on another repository's velocity, accepted deliberately.

**The unblock path**, specified in
`2026-08-22-mark8ly-console-integration-design.md`:

| blocked item | mark8ly endpoint that unblocks it |
|---|---|
| mark8ly leg of the audit log | `GET /admin/audit-logs` (issue 2) |
| `tenant_names` enrichment | `GET /admin/entities/tenants` (issue 3) |
| dashboard tenant/store counts | `GET /admin/kpis` (issue 8) — see DECISION 2 |

Note the interaction with DECISION 2: if the dashboard is deleted rather than
split, the third row disappears with it and `/admin/kpis` is wanted for the
Launchpad tile instead.

Phase 7 is therefore no longer "gated on DECISION 1" but sequenced behind
specific mark8ly issues, and it can start per-surface as each lands rather than
all at once.

### C2. Parity is the default; fixes are separate changes

Three open issues describe behaviour that is wrong today and identical on both
sides:

- **#301** — an erased contact still decides its organisation's follower band
  and is still treated as primary. `primaryContactFollowerClause`,
  its unknown-band mirror, and `primaryContactOrder` carry no `erased_at`
  predicate. The Go port kept this **deliberately**, and the issue says a fix
  must land on both sides in one change.
- **#226** — erasure is undone by the next import: `findMatchingOrganisationId`
  matches on `lower(email)`/`instagram_handle`, both of which erasure nulls, so
  the person is recreated as a new organisation.
- **#248** — `source` / `sourced_at` / `lawful_basis` are written only by a
  one-shot migration script, never by the import or manual-create paths.

**A port is exactly the moment someone will fix these unilaterally. Do not.**
Each phase ports the behaviour as it stands and links the issue. Fixing them is
its own change, on both sides, reviewed as a behaviour change.

### C3. The wire contract already reaches the browser

- **Cursors.** `keyset-cursor.ts` encodes `(timestamp, uuid, direction)` and the
  encoded value reaches the browser as `?cursor=`. The API must keep the same
  codec, or every shared or bookmarked link breaks.
- **Sentinels.** `__unassigned__`, `__unknown__` are not display values — they
  switch SQL from `=` to `IS NULL`. They are part of the request contract.
- **`quietSince`** must remain the SQL `COALESCE` value, never recomputed
  client-side.

### C4. Atomicity must be reproduced server-side, never by chaining requests

Five call sites use `tesserixTx`, each for a stated reason:

1. `advanceStage` — `SELECT FOR UPDATE` + `UPDATE` + `INSERT` activity. The
   `stage_change` activity is the only record of when a stage was entered and is
   unreconstructable. **Never two endpoints.**
2. `setNextAction` — `FOR UPDATE` so a grandfathered row cannot change between
   check and write.
3. `logActivity` — the suppression check runs on the transaction's own client so
   a concurrent `addSuppression` cannot slip between check and insert; the
   activity and the `last_contacted_at` bump land together.
4. `commitImport` — whole-batch atomicity, **read-your-own-writes** (row 2's
   dedup must see row 1's uncommitted insert), and a connection budget: the
   console pool is `max: 2`.
5. `linkConversion` — `AND converted_at IS NULL` in the UPDATE *is* the
   concurrency guard, not a nicety.

### C5. Suppression normalisation must be byte-identical

Email `trim().toLowerCase()`, handle `normalizeInstagramHandle`
(`trim`, strip leading `@`, lowercase), matched against `lower()` partial
unique indexes and migration 0022's normalize trigger. **A single divergence
silently contacts someone who asked not to be.** Suppression is checked at
preview AND at commit AND on outbound logging — a preview can be minutes stale.

### C6. `previewImport` writes nothing, and today that is structural

There is no write statement in the function to reach. Behind HTTP it becomes a
claim about a handler. Keep preview on a genuinely read-only path.

### C7. "Not measured" must stay distinguishable from "broken"

The audit surface maps a 501 to `instrumentation-unavailable` rather than an
error (#198). `platformRequest` unwraps the envelope, so that signal has to be
re-expressed as an `error.code`, or the distinction is lost.

### C8. The dev stub is part of the contract

`apps/console/dev/admin-stub.mjs` stands in for apps/web in local dev and e2e.
Every migrated endpoint must be reflected there or console dev and
`e2e/console.spec.ts` break. §10 says the stub sheds routes as the platform API
replaces them.

### C9. Every migrated call keeps a dual path

`PLATFORM_API_ORIGIN` unset must remain byte-for-byte the old behaviour, exactly
as `fetchTickets` does it. That is what makes each phase revertible by removing
one variable, and it is why the tickets cutover could merge switched off.

## The strategy, and why this order

**Phase order is chosen so that each phase is independently shippable and the
riskiest work happens last, after the pattern is proven.**

1. **CRM queues console cutover.** No new Go code. Puts the first real traffic
   through a module deployed with zero callers, and proves the CRM transport
   end to end while the contract is still free to change.
2. **Organisation read** (list + detail). Two reads, one of them the largest
   query in the file. Read-only, so a mistake is visible and harmless.
3. **Opportunity writes** (stage, activity). First transactional writes; C4
   applies in full.
4. **Suppressions.** Small surface, but C5 makes correctness non-negotiable.
5. **Handoff + conversion link**, including the greenfield conversion-status.
6. **Import.** Highest risk, done last on purpose.
7. **Non-CRM surfaces**, each gated on the mark8ly endpoint that serves it
   (C1), not on a single decision. They land one at a time as those ship.

**DECISION 2 — the dashboard.** `fetchDashboard` has no live callers; the home
page deliberately stopped rendering those numbers. Options: delete it, or split
it into domain resources (`/v1/leads/summary`, `/v1/apps?status=active`) and let
the console compose. Deleting is cheaper and reversible from git.

## Definition of done, per phase

- The Go endpoint exists, names its capability, and has handler tests plus
  golden files.
- Repository tests run against a real Postgres with **zero skips** observed.
- The console function has a dual path gated on `PLATFORM_API_ORIGIN`.
- `dev/admin-stub.mjs` updated where the route was served there.
- Existing console tests still pass unchanged where they mock at the repo seam.
- `npx next build` run in `apps/console` before merge when imports changed.
- Behaviour is parity. Any deviation is called out in the PR and linked to an
  issue.
