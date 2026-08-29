---
slug: kora-user-names
created: 2026-08-29
status: in-progress
---

# Names instead of UUIDs on `/kora/ai-metrics`, and a guard for the bug that shipped

Two pieces. B exists because of A's predecessor: `/kora/ai-metrics` shipped broken
and six green gates missed it.

## A. Show a user's name, not their UUID

The per-user table currently renders `ce9afd1e-2c5f-4e21-83e3-540a85479ea7`. Kora's
`ai-metrics` payload carries **only** `user_id` — no name, no email.

The name is available from a different read the console already makes:
`GET /v1/entities/users?source=kora` returns `EntityRecord`s of
`{id, source, type, label, sublabel?, createdAt?}`, and per `entities.ts`'s own doc
Kora sends a user's handle as `label`, falling back to their email in `sublabel`.

**Approach — a console-side join.**

1. On `/kora/ai-metrics`, alongside the metrics read, fetch a page of kora users.
2. Build an `id -> EntityRecord` map.
3. Render the matched `label` (and `sublabel` where present, as the existing user
   directory does) in place of the raw id.
4. **Where no match is found, render the raw id.** Never a placeholder such as
   "Unknown user" — that would make "this id is outside the fetched window" look
   identical to "this user does not exist", which are different facts. Same rule
   this surface already applies to `first_try_rate_pct` and `last_activity_at`.
5. Link each row to `/kora/users` so an operator can go find the person.

**The limitation, to be stated in code and in the PR, not hidden.** There is no
id-filtered entity lookup: `entityParameters` is `source, q, limit, page`, and
unknown params are rejected. So the join can only name users inside the page of
users we fetch. Kora is small today, but at scale some rows will still show a UUID
— which is exactly why rule 4 matters. The clean long-term fix is Kora returning a
label on `ai-metrics` itself; that is a different repo and not this task.

Do **not** fetch every user to guarantee a match. Do **not** issue one request per
row.

## B. Pin which pagination convention each client expects

**The bug that shipped yesterday, stated precisely.** platform-api has **two**
pagination conventions and the console must match each producer:

| Module | Where pagination lives | Console reads it via |
|---|---|---|
| `entities` (`service.go:137`, `json:"pagination"`) | **inside `data`** | `platformRequest` → `parseEntities` reads `body.pagination` |
| `koraaimetrics` (`handler.go:86`, `httpx.WriteMeta`) | **in `meta`**, a sibling of `data` | `platformRequestWithMeta` → reads `meta` |

`/kora/ai-metrics` was written by pattern-matching its working siblings
`/kora/foods` and `/kora/users`, which use the first convention. Its producer uses
the second. The fixture asserted the first, so parser and tests agreed with each
other and both disagreed with the producer — and a passing test named *"refuses a
response with no pagination"* asserted production's failure as correct behaviour.

Types could not catch it (`platformRequest` returns `unknown`); lint and
`next build` cannot see across an HTTP boundary.

**What to build:**

1. A small shared test helper exposing the two envelope shapes explicitly — names
   should make the distinction unmissable, e.g. `paginationInsideData(...)` and
   `paginationInMeta(...)`.
2. Every console client that parses pagination uses the helper matching **its own
   producer**. Audit them; there may be more than the two known.
3. A doc comment on `platformRequest` / `platformRequestWithMeta` recording the
   table above, so the next person choosing between them has the fact rather than
   a coin flip.

The point is not more tests. It is that a fixture is a claim about what another
system sends, and these claims are now written where a reader can check them.

## Verification — all six

`vitest run`, `packages/*` `test:unit`, `packages/*` `typecheck`, `tsc --noEmit`,
`lint` (`--max-warnings 0`), `next build`.

## Out of scope

Asking Kora to return a label on `ai-metrics` (different repo). Changing either
platform-api convention — both are defensible; the defect was the console guessing
which one applied.
