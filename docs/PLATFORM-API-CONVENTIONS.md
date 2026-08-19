# Platform API conventions

Derived from the tickets module (#269), not proposed ahead of it. Every rule
below is implemented, tested and pointed at the file that enforces it — because
#269's acceptance asks for "a written conventions document, derived from the
tickets module rather than proposed ahead of it", and a convention with no
implementation behind it is a preference.

Read this before writing the second module. Where it and the code disagree, the
code is right and this file is a bug.

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
- **The cursor is versioned and length-checked.** A cursor in a bookmark, minted
  before a sort component was added, would otherwise bind positionally against
  different columns — a page rendered from the wrong anchor, reported as a
  success.
- **`limit` is clamped, not rejected, and the applied value is echoed** in
  `meta.limit` so a short page is not mistaken for the end of the queue. A
  `limit` below 1 *is* rejected: asking for no rows is a caller bug, and quietly
  serving 50 would hide it.

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
paging, audit, idempotency, testdb. Kernel depends on no module. A helper that
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

**One thing deliberately not yet extracted.** `service.perform` — the
transaction script binding a write, its audit row and its idempotency record —
lives inside the tickets module, not in the kernel. Every module's writes will
want it. It moves when the *second* module needs it, because a shape extracted
from one example is a guess, and the second module is what shows whether the
seam is where it looks.

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
is deliberate, and it is the only reason this could merge:

> The platform API takes a Zitadel access token (ADR-003 D8). The console does
> not have one. `app/auth/callback/route.ts` destructures `id_token` out of the
> token exchange and drops `access_token` and `refresh_token`, and
> `SessionClaims` has nowhere to put one.

`lib/auth/platform-token.ts` is the seam that closes. It returns null today,
and the transport refuses to call the API without a token rather than sending
an unauthenticated request that comes back 401 saying nothing useful.

**To turn it on**, in order — the code half is now done:

1. ~~Retain `access_token` and `refresh_token` at callback; widen
   `SessionClaims`; refresh before expiry.~~ **Done.** `app/auth/callback/route.ts`
   keeps all three, `SessionClaims` carries them as optional fields (a session
   minted before this, or on mobile, stays valid), and
   `lib/auth/platform-token.ts` renews 60s ahead of expiry through the refresh
   grant. A refreshed token is not written back to the session — that needs a
   response to set a cookie on, and it is deliberately **not** in `middleware.ts`
   while login is being repaired; the module comment carries the note.
2. **Enable the Refresh Token grant on `console-web`.** Verified against the
   live instance: its grant types are `[AUTHORIZATION_CODE]` only, so Zitadel
   issues no refresh token however loudly the console asks. Until this lands,
   an operator can reach the platform API until the access token expires and
   not after — the code handles that, it just cannot fix it.
3. Add the platform API's project to the console's login scopes —
   `urn:zitadel:iam:org:project:id:{projectId}:aud`. **Already sent**; kept in
   the list because it is a prerequisite somebody will otherwise re-derive.
4. The two Zitadel checkboxes D8 calls prerequisites. **Both already correct**,
   verified on the live application: `accessTokenType: JWT` and
   `accessTokenRoleAssertion: true`. The failure mode they prevent is a
   perfectly valid token carrying no roles, which presents as an application
   bug rather than a configuration gap.
5. Set `PLATFORM_API_ORIGIN` on the console deployment.

Steps 2 and 5 are the ones left, and both are configuration rather than code.
Login must work first (tesserix-home#290, tesserix-k8s#489): a console nobody
can sign in to has no session to carry a token.

Until step 4, `apps/console/dev/admin-stub.mjs` keeps its four ticket routes.
It sheds them when the switch is on by default — #271 is explicit that the stub
shrinks as the platform API replaces these endpoints.
