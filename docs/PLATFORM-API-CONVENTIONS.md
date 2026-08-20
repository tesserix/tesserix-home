# Platform API conventions

Derived from the tickets module (#269), not proposed ahead of it. Every rule
below is implemented, tested and pointed at the file that enforces it — because
#269's acceptance asks for "a written conventions document, derived from the
tickets module rather than proposed ahead of it", and a convention with no
implementation behind it is a preference.

Read this before writing the second module. Where it and the code disagree, the
code is right and this file is a bug.

**The second module has now been written, and it settled things the first could
only guess.** #269's stated purpose is that this file is the vehicle carrying
those settlements to the third module, so a decision the CRM queues module took
belongs here and not only in a Go comment under `modules/crm/internal/`, which
module three cannot import and will not necessarily read. Rules below marked
**(crm)** were decided there. Where the two modules DISAGREE, the disagreement
is written down as a disagreement rather than smoothed over — a convention that
described a state neither module is in would be worse than none.

---

## 0. Why tickets went first

Four of the console's eight `/api/admin/*` endpoints, its only write verb
outside the CRM, and a surface that exercises reads, writes, a status
transition and pagination at once. Enough to settle these conventions against
real requirements rather than hypothetical ones.

**It is not a port.** The endpoints it replaces are screen-shaped: `GET
/api/admin/platform-tickets` returns `{summary, rows}` — a standing count of
the whole queue welded to a filtered page of it, because one React component
wanted both. That shape is the thing #269 exists to refuse, and §2 is what
replaced it.

---

## 1. The response envelope

**Success and failure are both `StandardResponse`**, go-shared's shape, field
for field.

```jsonc
// 200
{ "success": true,  "data": { "ticket": {…} }, "meta": {…},
  "timestamp": "2026-08-19T09:41:02.5Z", "request_id": "7f3a…" }

// 404
{ "success": false, "error": { "code": "NOT_FOUND", "message": "no such ticket" },
  "timestamp": "…", "request_id": "…" }
```

`internal/platform/httpx/response.go`.

**This reversed the scaffold's decision, and the reversal is the lesson.** The
scaffold shipped the flat `{code, message, details}` error body, reasoning that
it was the estate's envelope. It is — `AppError` really does serialise that way
— but `AppError` is what a *handler returns*, not what a Tesserix service puts
on the wire. Every one of them writes it through `ErrorResponse`, which nests
it under `error` inside `StandardResponse`. The flat shape matched half the
convention and contradicted the other half, and a client would have had to
branch on which Tesserix service it was talking to.

Reversed at the first module because that is the last cheap moment. After it,
the shape is a contract products have pinned to and changing it costs a version.

**Rules:**

- `data` on success, `error` on failure, never both.
- `httpx.Error` carries **no JSON tags** and cannot serialise itself. A test
  asserts their absence — one added tag is how a second, subtly different error
  shape gets into the service.
- The HTTP status is never in the body. The response carries it; a body that
  restates it invites the two to disagree.
- Error codes are the estate's spelling (`NOT_FOUND`, `VALIDATION_FAILED`, …)
  so a client already handling them from another service handles them here.
- **Auth refusals are written by `internal/platform/auth`, not by `httpx`** —
  `httpx` imports `auth`, so the reverse edge would be a cycle. They must
  produce the same envelope; `httpx.TestRefusalsMatchTheAuthPackage` asserts it
  from the side that can see both.

### 1a. Request ids

`internal/platform/reqid`. Outermost middleware, so a request refused by
authentication still gets an id — a 401 nobody can correlate is exactly the one
someone will ask about. Echoed in the body and in the `X-Request-Id` header. An
inbound id is bounded and screened for control characters before it is trusted
into a response header.

### 1b. `error.details` **(crm)**

`details` is machine-readable, it is in the golden files, and products pin to
it. It therefore needs a rule, and until the CRM module it had three readings
in one service.

**A key is a request parameter; its value is the offending input, verbatim.**
The explanation is the `message`.

```jsonc
{ "code": "VALIDATION_FAILED",
  "message": "the filter is not valid: stage: unknown stage \"archived\"",
  "details": { "stage": "archived", "accepted": ["new", "contacted", "qualified"] } }
```

- **One key is not a parameter: `accepted`**, a JSON **array** of the values the
  endpoint would have taken. It earns the exception because "what should I have
  sent" is the only part of a refusal a client can act on programmatically. It
  is an array in every case — never a rendered Go value. `fmt`'s `%v` on a
  `[]Stage` produces `[new contacted qualified]`, and a client parsing accepted
  values out of a space-separated Go slice rendering breaks the day somebody
  changes a format verb, in a contract nobody thought they had touched.
- **A refusal is carried in pieces, not formatted early.** A message built with
  `fmt.Errorf` cannot be taken apart again into parameter, value and vocabulary,
  so the domain returns `domain.FilterRefusal{Parameter, Value, Reason, Accepted}`
  and the handler decides the wire shape (`handler.filterRefusal`).
- `Accepted` is **nil where the axis has no closed vocabulary**. A country code
  is a shape, not a list; enumerating 249 of them on every refusal is noise.
- **A list of names is keyed by the names.** `rejectUnknownParameters` answers
  `{"stge": "new", "accepted": [ … ]}`, not `{"unknown": ["stge"]}` — the
  caller who sent `?stge=new` wants the value beside the misspelling, and the
  rule is uniform.

**The divergence, so it is visible:** the tickets module has NOT been converted.
Its filter refusal is `{"status": err.Error()}` — key a parameter, value an
explanation. That is one commit's work and it is not this one; a module written
against this file should follow the rule above, and tickets is the exception
until it is fixed.

---

## 2. Resources are domain-shaped; the console composes

**The rule:** a module exposes domain operations. Screen composition happens in
the console's route handlers, which is a layer it already has —
`apps/console/lib/platform-api.ts` is a composition layer today, just pointed at
the wrong backend.

Concretely, `{summary, rows}` became two resources:

```
GET /v1/tickets           → { "tickets": [ … ] } + meta
GET /v1/tickets/summary   → { "summary": { … } }
```

**What it costs:** one extra request on the queue screen.
**What it buys:** the summary can be cached, polled or dropped independently of
the listing; a product consuming tickets is not made to fetch a console header
it will never render; and the summary stays a property of the *queue* — there
is no way to ask for a filtered one, which is how the "headline numbers do not
move as an operator narrows the list" property survives by construction rather
than by discipline.

**Every payload names its resource.** `{"tickets": […]}`, not a bare array;
`{"ticket": …, "replies": […]}`, not a merged object. A named object can gain a
sibling field without becoming a different type. A bare top-level array cannot.

**Empty collections serialise as `[]`, never `null`.** A client that types the
field as an array meets a type error on the response it is least likely to have
exercised.

**`snake_case`.** The estate's spelling, and what the console's parsers already
try first (`r.product_id ?? r.productId`). One deliberate exception is recorded
in `handler.go`: the reply endpoint accepts `newStatus` because that is what the
console already sends, with `new_status` accepted alongside it.

**Absence on a filter axis is a sibling flag: `<axis>_unset=true`. (crm)** Any
module filtering a nullable column meets this, so it is a wire convention
rather than a CRM detail. The console spells absence with a sentinel INSIDE the
axis — `UNASSIGNED_PRODUCT` is `"__unassigned__"` — because a Radix `Select`
cannot hold an empty-string item value. That is right where it lives and wrong
on a wire contract: `product` is a **text** column, so `"__unassigned__"` is a
value a row could legitimately carry, and a sentinel that can collide with real
data has no spelling that fixes it. A separate parameter cannot collide.

- `?product=acme` filters; `?product_unset=true` selects the rows with none.
- **Both together are refused**, never resolved by precedence: "product is acme
  AND product is absent" is a contradiction, and either precedence rule answers
  a question the caller did not ask while reporting success.
- **An empty value is NO filter.** `?product=` is identical to omitting it.
  Stated as contract rather than left to be discovered, because a caller
  sending it in the hope of selecting rows with no product otherwise gets every
  row and a 200.
- **Only axes whose column is nullable get the sibling.** `stage` is `NOT NULL`
  and has none; `owner` is nullable and has none either, because no product
  decision has been taken about a queue of unowned leads and pre-building the
  parameter would ship a filter with no meaning attached. Adding one later is
  additive.

**No third-party identifiers on the wire.** `submitted_by_user_id` and a reply
author's id are attribution the database keeps — a Firebase UID or a Zitadel
subject. Publishing them hands every caller a join key for no reader's benefit.

---

## 3. Pagination: keyset, with honest counts

`internal/platform/paging`. #240/#241 standardised the console on keyset;
#269 requires the API not to disagree with its own UI.

```jsonc
"meta": { "next_cursor": "…", "previous_cursor": "…",
          "preceding_count": 50, "total": 128, "limit": 50 }
```

- **`page`, `per_page` and `total_pages` are never emitted.** go-shared's
  `MetaData` offers them; this service does not, because advertising a page
  number it cannot honour is worse than not offering one.
- **`total` and `preceding_count` are pointers in Go**, so a genuine zero
  serialises. With `omitempty` on a plain int, an empty result loses its total
  and a client cannot tell "nothing matches" from "this endpoint does not
  report totals". That is the honest-totals half of #241.
- **The cursor is opaque and carries its own direction.** A direction sitting
  beside the cursor as a second parameter is one copy-paste away from being
  lost, and a cursor whose direction went missing does not fail — it renders the
  page on the wrong side of the anchor and says nothing.
- **A malformed cursor is a 400, never a silent first page.** Degrading shows
  the caller a different page from the one the URL asked for while reporting
  success. It is a bad *link*, not a flaky read, and the two want opposite
  advice.
- **The cursor is versioned, length-checked and CONTENT-checked, and every
  listing declares a `paging.Shape`. (crm)** See §3c: the length check alone
  does not deliver the guarantee this bullet used to claim.
- **`limit` is clamped, not rejected, and the applied value is echoed** in
  `meta.limit` so a short page is not mistaken for the end of the queue. A
  `limit` below 1 *is* rejected: asking for no rows is a caller bug, and quietly
  serving 50 would hide it.
- **A rejected `limit` is a 422, not a 400** — in both modules. This sentence
  used to say only "rejected", and a reviewer generalised 400 from it, which is
  the doc's fault rather than the reviewer's. The request is well-formed and
  the service understood it and declined, which is the same distinction §3's
  malformed-cursor 400 turns on from the other side: a cursor that cannot be
  parsed is a bad link, `limit=0` is a legible request for something the
  service will not do.

### 3a. Encoding, and why it is not the console's

`apps/console/lib/db/keyset-cursor.ts` encodes `direction|timestamp|uuid`. That
works there because both of its surfaces sort on one timestamp and one id. The
ticket queue sorts on four components — status bucket, priority rank,
`updated_at`, `id` — two of them derived, so a two-field codec cannot express
it, and widening the pipe format needs escaping rules because a component may
contain a pipe. The key is a list, encoded as JSON inside base64url. Both are
invisible to the caller.

### 3b. Mixed sort directions

The queue displays `bucket ASC, rank ASC, updated_at DESC, id DESC`. A row-value
comparison — what makes a keyset predicate correct over a composite sort —
compares the whole tuple in **one** direction.

**Negate the ascending integer components.** `bucket ASC` is exactly
`(-bucket) DESC`, so the tuple becomes uniformly descending and
`(-bucket, -rank, updated_at, id) < (…)` means precisely "sorts after this
row". The alternative — a chain of ORs, one per prefix of the sort key — is
what a query builder generates, is quadratic, and cannot use an index the way a
row comparison can.

### 3c. A cursor's shape, and why a length check is not enough **(crm)**

`paging.Decode` takes a `paging.Shape` — one `paging.Component` per `ORDER BY`
component — and it **replaced** the bare component count rather than joining
it. A listing that declares its key's shape has declared its length too, and a
second parameter for the length would be a number that could disagree with the
shape beside it. **A listing that declares no shape accepts no cursor**, which
is the right failure for one that forgot.

**Content, not just envelope.** The envelope check (base64, version, direction,
count) passed a two-component cursor carrying `["hello","world"]`, which then
reached `$1::timestamptz` and answered a bad *link* with a **500**. `Text`,
`Integer`, `Timestamp` and `UUID` are the components; a listing composes the
ones its `ORDER BY` uses. It is in the kernel because every listing binds its
key positionally into casts, so a module-local fix is the same check written
once per module.

**A cursor from one listing must be unusable on another, and the LENGTH is not
what delivers that.** The CRM's two queues both sort on a timestamp and a uuid.
One shared shape therefore accepted a **drifting** cursor — anchored on
`COALESCE(last_contacted_at, created_at)` — on `/v1/crm/queues/due`, where it
bound against `next_action_at` and returned **200** with `total` and
`preceding_count` computed consistently from an anchor that means something
else. Nothing looked wrong. That is precisely the failure the version and the
length check exist to prevent, arriving by a route neither of them covers, and
it is not hypothetical: the console avoids the same collision by giving the two
queues **separate query parameters** (`DUE_CURSOR_PARAM`, `DRIFT_CURSOR_PARAM`
in `apps/console/app/(console)/platform/crm/page.tsx`), a mitigation that could
not survive a port to one `?cursor=` on both routes.

**The rule: where two listings could mint interchangeable keys, one component
names the listing.** The CRM queues' key is `timestamp, uuid, queue-name`, and
`queueNamed` accepts only its own queue's name
(`modules/crm/internal/repository/queues.go`). The component anchors nothing —
it is never bound into the query — so it costs no parameter and no comparison,
and it travels inside the opaque string the way the version and the direction
do. It also composes: the refusal unwraps to `paging.ErrMalformedCursor`, so
the handler already answers the 400 §3 requires. Two shapes of the same length
and the same component types would have been the same check twice.

Tickets needs no such component today — four components, two of them derived,
make its keys structurally distinct — but "structurally distinct by luck" is
what the CRM had, so a third listing should check rather than assume.

---

## 4. Versioning

Paths carry `/v1/`. Nothing else does — no header negotiation, no query
parameter.

**The deprecation policy, so products can pin:**

- A **new optional field** in a response is not a version change. Clients must
  ignore unknown response fields.
- A **removed or renamed field**, a **changed type**, or a **narrowed
  accepted-value set** is a new version. `/v1/` keeps working alongside it.
- A version is announced before it is retired and retired no sooner than **two
  quarters** after its replacement ships. There is no automated enforcement of
  this yet; when there is, it belongs beside the golden files in §7.
- **Request bodies reject unknown fields** (`DisallowUnknownFields`). Stricter
  than most of the estate and deliberate here: an unknown field today is a field
  this service might mean something by tomorrow, and a caller sending
  `{"contnet": …}` should be told rather than answered with a 422 about an empty
  reply that names the wrong problem.
- **Reads reject unknown QUERY PARAMETERS, for the same reason. (crm)** A read
  has no body to decode strictly, and `handler.rejectUnknownParameters` is the
  equivalent strictness in the place a read can make it: a caller sending
  `?stge=new` is otherwise handed the WHOLE queue and a **200** — a filter that
  silently does nothing, which is the broader-result-set failure the whole
  validation budget of a listing is spent avoiding. It is a **400** (the
  request is not one this endpoint can be asked), with `accepted` listing the
  parameters it does read, per §1b.

  **The divergence, so a third module does not flip a coin and make it
  three-way:** the CRM module does this and **tickets does not** (#302). The
  convention is the CRM's. Tickets is the one to change.

---

## 5. Idempotency

`internal/platform/idempotency`, table `platform_api_idempotency`
(migration 0028).

`Idempotency-Key` on any write. **Optional** — requiring it would have broken
every caller on the day it shipped — but a header that is *present and unusable*
is a 400, never silently ignored: a caller who meant to be idempotent and got it
wrong must be told, not left believing their write was protected.

- The key is scoped to **(principal, key)**. Without the principal it is a
  guessable handle onto somebody else's stored response, and stored responses
  contain ticket content.
- The key also records its **operation**, so a key minted for a reply cannot
  replay a reply's stored response at the status endpoint.
- A **digest** of the request body is stored, never the body. Same key,
  different body → **409**, not a replay: replaying would silently discard the
  second request. The digest exists so that case can be detected without keeping
  a second copy of the merchant's conversation.
- **The record is written in the same transaction as the write.** A key in the
  table therefore always corresponds to a committed write. Recording first would
  refuse the retry of a request that never landed — worse than not having the
  feature.
- A concurrent duplicate loses on the primary key, rolls its own work back, and
  replays the winner's response.

**Why a table and not Redis:** the service has no Redis, ADR-003 D2a is explicit
about not adding infrastructure the estate cannot afford, and the guarantee
wanted is that the record and the write land together — which is a transaction,
and a second datastore cannot join one.

---

## 6. Where auditing lives

`internal/platform/audit`, writing `console_audit_log` — the console's table,
not a second store.

**The rule: the writer audits.** Whoever performs the mutation records it, in
the same transaction, and nobody audits a write somebody else performed.

The alternative rule — "the console audits everything it triggers" — cannot
survive a product calling the API directly: a service principal filing a ticket
never goes near the console, and its write would be unrecorded. Under ADR-003 D7
each domain ends up with exactly one writer, so exactly one trail; during a
migration the boundary is unambiguous, because "did I write this row" is a
question a caller can always answer.

**One transaction is where the guarantee comes from.** The console's
`auditedOperation` promises that an unauditable operation does not proceed, and
ADR-003 D2a cites that promise as a reason not to split these modules into
services. Here it is structural rather than ordered: the audit `INSERT` runs on
the caller's transaction, so a failed audit rolls the write back and there is no
window in which the write has landed and the record has not.

**Constraints, matching `apps/console/lib/db/audit-repo.ts` exactly:**

- `action` is a stable dotted identifier (`^[a-z][a-z0-9_.]{0,63}$`), never
  prose. Migration 0018 names it as the column a retention or alerting rule
  discriminates on.
- `metadata` carries **counts only**. A key that is not an identifier is
  **refused, not stripped** — a summary that tried to carry a row is a bug in
  the caller's summariser, and dropping the key would leave the bug in place
  under a row that looks fine.
- Keys are sorted, so two rows recording the same outcome compare equal as text.
- `occurred_at` is the **operation's** instant, not the insert's.
- Distinct acts get distinct actions. `tickets.reopen` is not `tickets.status`,
  because "what was undone" is not answerable by scanning status changes in
  general — and the distinction is only cheap to draw at the moment the
  transition is decided.

---

## 7. Authentication and authorisation

ADR-003 D8. Zitadel access tokens, two principal types, one issuer. Verified
against the JWKS; issuer, audience and expiry checked; roles read from
`urn:zitadel:iam:org:project:roles` and narrowed to #261's capability
vocabulary.

**The API is the authorisation boundary. The console's checks are UX on top of
it.** #244 puts surface refusal in the console's middleware; if this service
authorised only "is this a valid session", anything holding a session could call
a module directly and every console restriction would be decoration.

- **Every route names the capability it needs.** Nothing is inherited. #261
  spent an issue undoing the opposite arrangement on the console side, where 11
  of 14 mutating actions inherited the weakest gate by saying nothing.
- **Verbs layer on surfaces, they do not replace them.** A write requires both:
  `support` *and* `respond`. `respond` alone means "may reply where they may
  work", not "may reply anywhere".
- **Take the capability from `packages/console-core/src/routes.ts`.** It already
  declares one per surface; a module inventing its own would be a second
  vocabulary.
- **Never authorise on `Principal.Kind`.** It is a heuristic — Zitadel does not
  mark a client-credentials token distinctly, so it is inferred from the
  presence of an email claim. It is for logs and audit only.
- **`httpx.RegisterModule` panics without a verifier.** A module is registered
  through it, never by calling `Register` directly — including in tests, since a
  test that went around the guard would not be testing how the module is served.
- Since #269, `PLATFORM_API_AUTH_ENABLED` **defaults to true**. It was opt-in
  while nothing was being protected; the escape hatch still exists and no longer
  opens onto anything.

---

## 8. Module boundaries

`internal/modules/doc.go` is authoritative. In short: a module's public surface
is `Register` and `Config`; everything else lives under `modules/<name>/internal/`
where the compiler enforces it; and **a module must not import another module**,
which `internal/architecture` checks in CI because the public-package import
compiles perfectly well.

When a module genuinely needs another's data, declare the interface where it is
consumed and satisfy it in `cmd/server`. The provider does not learn the
consumer exists, and a later extraction becomes swapping a local implementation
for an HTTP client.

**Kernel is `internal/platform/…`:** config, database, httpx, auth, reqid,
paging, audit, idempotency, write, testdb. Kernel depends on no module. A helper that
two modules will both want belongs here — but see §9 on when to move it.

---

## 9. Testing

- **The SQL is the substance, so it is tested against the real schema.**
  `internal/platform/testdb` applies `apps/web/db/migrations` verbatim to a
  fresh database per test. A hand-written fixture agrees with whatever the
  author believed the schema was; drift then fails a deploy instead of a test.
  Two real bugs — a `text`/`uuid` mismatch from a CTE cast, and an
  over-inferred parameter type — were caught here and nowhere else.
- **Tests skip without `TESSERIX_TEST_DB_HOST`**, so `go test ./...` stays
  useful on a laptop. **CI supplies a Postgres and fails if they skipped**, so
  the skip cannot quietly become the normal case.
- `TESSERIX_TEST_DB_*`, never the service's own `TESSERIX_DB_*`. A suite that
  picks up ambient production credentials and then truncates something is a
  category of accident worth designing out.
- **A module's HTTP tests go through the real router, the real verifier and a
  real database.** Only the token signature is faked. #269 requires "a test that
  calling a module without the capability is refused"; the tickets module's is
  `TestEveryRouteRefusesAPrincipalWithoutTheSurfaceCapability`, and its
  companion `TestARefusalIsNotAnAccident` sends the same request *with* the
  capabilities, because a 403 caused by a missing route would satisfy the first
  test while proving nothing.
- **Golden response files are committed** under
  `internal/modules/tickets/internal/handler/testdata/`. Regenerate with
  `-update-golden` and read the diff: a contract change should be visible in a
  pull request, which is the point for a contract products pin to.

**Extractions happen on the second example, not the first.** `service.perform`
— the transaction script binding a write, its audit row and its idempotency
record — was held inside the tickets module until there was a second example,
because a shape extracted from one example is a guess. It is now
`internal/platform/write`, `write.Perform`.

The second example is the CRM queues module. Its Go implementation follows;
`write` has one caller today, and the shape was re-examined against the
console's **existing** CRM writes rather than against a Go module the compiler
can see. That is real, checkable evidence — `advanceStage` in
`apps/console/app/(console)/platform/crm/[organisation]/actions.ts` already
passes an outcome → `{action, summary}` function choosing `crm.stage.change`
or `crm.product.set` — but it is a second *example*, not a second consumer, and
the confidence should be read that way.

On that evidence the seam was where it looked, with one detail promoted from
incidental to load-bearing: the operation returns its audit entry *after* doing
the work. Tickets barely uses that; a signature demanding the entry up front
cannot express `advanceStage` at all. `write`'s package comment carries the
full judgement, including the two behaviours (a result-derived action, and a
no-op that still audits) that were checked against the shape and needed no
change to it.

The same rule moved the second seam. `paging.Page[T]` was rows and `HasMore`;
tickets carried `Total`, `Preceding` and both cursors in a page type of its own,
and every CRM listing needs the same. The kernel now has
`paging.CountedPage[T]` and `paging.Resolve`, which own the forward/backward
asymmetry — the backward `Preceding` adjustment, and which edge row anchors
which cursor. What did **not** move: the counts stay SQL-counted by the caller,
and the caller supplies the cursor `Key`, because which columns a key is made of
is an `ORDER BY` the kernel never sees. Counts are optional (`nil` opts out), so
a cheap "is there more" listing is not made to run a `COUNT`. Tickets adopted it
with no change to its tests and none to its golden files — for an extraction,
that is the acceptance criterion.

### 9a. Schema hazards a module inherits **(crm)**

**A `NOT VALID` CHECK is not a dormant constraint.** Postgres skips the
existing rows when the constraint is added, so historical rows sit in the table
violating it — but it evaluates the check on the **new row version of every
INSERT and UPDATE**, including an UPDATE that touches neither column the check
names. So a bare `next_action_at` bump on one of the ~155 grandfathered rows
migration 0021 left behind **aborts the whole transaction**, and under
`write.Perform` that transaction is also holding the audit row and the
idempotency record.

The full hazard, why the redundant-looking guard in the statement's `WHERE`
clause is not redundant, and the test that proves it against a real Postgres
rather than reasoning about it, are at the top of
`internal/modules/crm/internal/repository/next_action.go`. **Read it before
writing any write against `crm_opportunities`, or against any table carrying a
`NOT VALID` constraint** — the shape of the fix generalises: restate the check
as a row filter so the row does not match, then return a sentinel the handler
turns into a 422 naming what the operator must fix. The alternative is a
Postgres constraint-violation string on a 500.

---

## 10. The console's migration

Done, and **switched off**. `apps/console/lib/platform-api.ts` speaks both
backends; `PLATFORM_API_ORIGIN` decides which.

| Call site | Against the platform API |
|---|---|
| `fetchTicketDetail` | `GET /v1/tickets/{id}`. The envelope is stripped by the transport and `parseTicketDetail` reads the result **unchanged** — `author_type` validation included. |
| `fetchTickets` | Two calls, `GET /v1/tickets` and `GET /v1/tickets/summary`, composed in `fetchTicketsFromPlatformApi`. That composition is what §2 is for: the API serves domain resources, the console draws the screen. |
| `postTicketReply` | `POST /v1/tickets/{id}/replies`, same body, plus an `Idempotency-Key`. |
| `patchTicketStatus` | `PATCH /v1/tickets/{id}`, same body, plus an `Idempotency-Key`. |

**Unset — the deployed state — is byte-for-byte the current behaviour.** That
is deliberate, and it is the only reason this could merge. The constraint that
forced it, as it stood when this section was written:

> The platform API takes a Zitadel access token (ADR-003 D8). The console does
> not have one. `app/auth/callback/route.ts` destructures `id_token` out of the
> token exchange and drops `access_token` and `refresh_token`, and
> `SessionClaims` has nowhere to put one.

**That paragraph is history, not the present state** — #297/#298 closed it, and
what replaced it is not where it was going. The tokens do not live on the
session at all: they are in `operator_api_tokens` (migration 0029), keyed by a
random `sid` claim on the cookie, AES-256-GCM at rest, behind
`lib/auth/operator-token-store.ts`. They were moved out of the cookie because
putting them in it broke login outright — with ten roles the encrypted
`tx_session` cleared the browser's hard 4096-byte per-cookie limit and Chrome
DISCARDED the whole `Set-Cookie` silently. See
`.planning/debug/resolved/console-login-state-mismatch.md`.

`lib/auth/platform-token.ts` is the seam that closes, and it now returns a real
token. When one is absent the transport still refuses to call the API rather
than sending an unauthenticated request that comes back 401 saying nothing
useful.

**To turn it on**, in order — the code half is now done:

1. ~~Retain `access_token` and `refresh_token` at callback; widen
   `SessionClaims`; refresh before expiry.~~ **Done, but not as described.**
   The credentials went to `operator_api_tokens` rather than onto
   `SessionClaims`, for the cookie-size reason above; the claims still decode
   for sessions minted before the store, and `platform-token.ts` deliberately
   does **not** read them. `getPlatformApiToken()` renews 60s ahead of expiry
   under `SELECT ... FOR UPDATE` on the session's row, because Zitadel ROTATES
   refresh tokens on use and two concurrent refreshes would otherwise both
   spend the same one.

   **A refreshed token IS written back** — the earlier note here saying it is
   not, and that doing so would need a response to set a cookie on, described
   the cookie design that was abandoned. A server-side row needs no response:
   the new access token AND the rotated refresh token are UPDATEd inside the
   same transaction that authorised spending the old one. Dropping the rotated
   replacement is the specific bug the store exists to prevent.
2. ~~**Enable the Refresh Token grant on `console-web`.**~~ **Done**
   (2026-08-20, #304).

   The reasoning previously recorded here was wrong in a way worth keeping,
   because it is the trap: it said the missing grant meant "Zitadel issues no
   refresh token however loudly the console asks". Zitadel **issues** one
   regardless — a real login logged `hasRefreshToken: true` while the grant
   list was still `[AUTHORIZATION_CODE]` only. **Issuing and redeeming are
   separate permissions.** The console therefore stored a credential it was not
   allowed to spend, and the failure surfaced only about an hour in, when the
   first refresh was attempted, as every platform-API surface going unreachable
   for the rest of the 7-day session with nothing telling the operator that
   signing in again would fix it.

   Confirmed by probing the token endpoint with a deliberately invalid refresh
   token, which distinguishes a grant-level refusal from a token-level one
   without spending a live token: before, `unauthorized_client` /
   `grant_type "refresh_token" not allowed`; after, a token-level
   `Errors.User.RefreshToken.Invalid`.
3. Add the platform API's project to the console's login scopes —
   `urn:zitadel:iam:org:project:id:{projectId}:aud`. **Already sent**; kept in
   the list because it is a prerequisite somebody will otherwise re-derive.
4. The two Zitadel checkboxes D8 calls prerequisites. **Both already correct**,
   verified on the live application: `accessTokenType: JWT` and
   `accessTokenRoleAssertion: true`. The failure mode they prevent is a
   perfectly valid token carrying no roles, which presents as an application
   bug rather than a configuration gap.
5. Set `PLATFORM_API_ORIGIN` on the console deployment.

**Step 5 is the only one left**, and it is configuration rather than code.

Until step 5, `apps/console/dev/admin-stub.mjs` keeps its four ticket routes.
It sheds them when the switch is on by default — #271 is explicit that the stub
shrinks as the platform API replaces these endpoints.
