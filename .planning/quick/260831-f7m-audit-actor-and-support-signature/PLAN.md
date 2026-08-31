---
quick_id: 260831-f7m
slug: audit-actor-and-support-signature
date: 2026-08-31
follows: tesserix-home#450
---

# console_audit_log holds subjects, and a ticket reply is signed "Tesserix Support"

Two corrections to behaviour that #450 (`9c4c77e`) activated by populating
`Principal.Email` and `Principal.Name` for the first time.

## Evidence — established, do NOT re-derive

Do not query the cluster, the database, or Zitadel.

Live rows after a real operator reply and CRM note on 2026-08-31:

```
platform_ticket_replies  author_name="Mahesh Sangawar"  author_email="mahesh.sangawar@gmail.com"
crm_activities.actor     "mahesh.sangawar@gmail.com"     (console's own path — correct, leave alone)
console_audit_log.actor  "386888878927118733"            (subject, both rows)
```

`console_audit_log` had **zero** rows before that; both rows now in it are
subject-shaped and were written by the console.

## Task 1 — `console_audit_log.actor` is a subject, always

`internal/modules/crm/internal/service/service.go:99` `auditActor()` returns
`a.Email` when non-empty and falls back to `a.Subject`. Until #450 the email was
always empty for operators, so it wrote subjects and matched the contract by
accident. Now it will write emails.

That contract is documented and enforced on the console side, in
`apps/console/lib/crm-write.ts`, whose module comment records a copy that
"audited under `actor.email` while this wrapper always uses `actor.sub` (the
column's documented contract)" — and treats that divergence as the defect the
wrapper exists to prevent.

**Change `auditActor()` to return `a.Subject` unconditionally.**

Its current justifying comment is wrong on the facts and must be rewritten, not
merely trimmed. It claims:

> the console's existing CRM rows carry `actor.email`, this write appends to
> that same trail

`console_audit_log` had no rows at all when that was written. The rows that do
carry an email are `crm_activities.actor` — the CRM **timeline** the merchant-
facing UI renders — which is a different table with a different contract and is
written by the console, not here. The comment conflated the two. Say so, name
both tables, and cite `apps/console/lib/crm-write.ts` for the contract.

Once `Email` is unused there, drop it from the crm `Actor` struct and from the
`service.Actor{...}` literal at `crm/internal/handler/handler.go:329`.

## Task 2 — a staff reply is signed "Tesserix Support", and carries no email

`internal/modules/tickets/internal/service/service.go`.

A merchant reads these replies. A staff member's personal email address — and
their name — must not be what a merchant is shown. This path is unambiguously
staff: `InsertReply` is called with `AuthorType: domain.AuthorOperator`, and a
merchant's own replies arrive by a different path with a different author type,
so this change cannot affect how a merchant's own name is rendered.

- `displayName()` currently falls through `Name` → `Email` → `"Tesserix
  Support"`. Make it return the fixed label. Keep it a named function rather
  than inlining the literal, and rewrite its docstring: the label is not a
  fallback for missing data any more, it is the intended identity of a platform
  reply, and the reason is that the alternative discloses staff PII to a
  merchant. Note that `author_name` is NOT NULL and the console renders it
  directly, so it must never be empty.
- `AuthorEmail: actor.Email` → store no email. Use the empty string; the
  repository already wraps it in `nullIfEmpty` on insert
  (`repository/tickets.go:462`), so the column goes NULL rather than blank.
- `AuthorUserID: actor.Subject` is **unchanged**. That is what preserves
  internal attribution: who replied is still recorded, by subject, without
  putting it in front of a merchant. Say this in the comment, so a future reader
  does not "restore" the email thinking attribution was lost.
- `Actor.Name` and `Actor.Email` are then unused in this module. Remove both
  fields, and simplify `actorOf` in `tickets/internal/handler/handler.go:333`
  accordingly — including the comment there, which currently explains why
  `Name` is passed through.

## Out of scope — do NOT do these

- Do not remove `Principal.Name`, `Principal.Email`, or the userinfo resolver
  from `internal/platform/auth/`. After these two tasks they have no consumer,
  which is a real question, but it is being put to the user separately. Leave
  that package alone apart from what compiles.
- Do not write any data migration or backfill, and do not modify existing rows.
- Do not touch `crm_activities` or anything under `apps/console/`.

## Task 3 — tests

- `auditActor()` returns the subject even when an email is present.
- A reply's stored `author_name` is `"Tesserix Support"` even when the actor has
  a name and an email, and its `author_email` is empty.
- `author_user_id` still carries the subject — pin it, since it is now the only
  attribution on the row.
- Update or delete the tests added by #450 that assert the operator's name
  reaches `displayName()`; they encode the behaviour being reversed. Do not
  leave them asserting the old outcome.

Run `gofmt -l . && go build ./... && go vet ./... && go test -count=1 ./...`
from `platform-api/`.

## Task 4 — commit

Single line, conventional commits, no body, no signature. Suggested:
`fix(platform-api): keep console_audit_log on subjects and sign staff ticket replies as Tesserix Support`
