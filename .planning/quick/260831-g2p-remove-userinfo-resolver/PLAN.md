---
quick_id: 260831-g2p
slug: remove-userinfo-resolver
date: 2026-08-31
follows: tesserix-home#450, #453
---

# Remove the userinfo resolver — it has no reader

#452 added a userinfo lookup so `Principal.Name` and `Principal.Email` could be
populated for operators. #453 then removed both consumers deliberately: the CRM
audit actor is a subject by contract, and a staff ticket reply is signed
"Tesserix Support" with no email, because a merchant must not be shown a staff
member's personal identity.

What is left is a network call to Zitadel on the authentication path of every
operator request, feeding two fields nothing reads.

## Established facts — do NOT re-derive

Verified by grep across `platform-api/` on 2026-08-31, after #453:

- `Principal.Name` — **no reader.** Its only one was tickets' `actorOf`, removed in #453.
- `Principal.Email` — one remaining reference: `modules/tools/internal/handler/handler.go`
  builds `service.Actor{Subject: ..., Email: principal.Email}` at six call sites.
  The tools `service.Actor.Email` field is **declared and never read** — grep for
  `Email` under `modules/tools/internal/service/` returns only the field
  declaration and its comment.
- `Principal.Kind` — **no reader, and never had one**, in any module. Only
  comments mention it.

So removing the resolver costs nothing that is used.

## What to KEEP — this is not a revert of #450

`client_id` → `Kind` stays, in full:

- `Claims.ClientID`, `Config.ConsoleClientID`, `WithConsoleClientID`
- the kind assignment in `Verify`
- the startup WARN in `NewVerifierFromConfig` when `ZITADEL_CONSOLE_CLIENT_ID`
  is unset, and the `ZITADEL_CONSOLE_CLIENT_ID` env var itself

It is correct, attested by the issuer, costs nothing at runtime, and is the
right mechanism the moment anything does want to tell an operator from a
service. `Kind` having no reader today is not a reason to compute it wrongly.
**Do NOT touch `tesserix-k8s` — the env var stays.**

## Tasks

### Task 1 — delete the resolver

- Delete `internal/platform/auth/profile.go` and `profile_test.go` entirely:
  `ProfileResolver`, `userinfoResolver`, `errSubjectMismatch`, `profileCache`,
  `profileTTL`, `profileNegativeTTL`, `profileCacheMax`, `profileEntry`.
- In `verify.go`: remove `Principal.Name`, `Principal.Email`, the `profiles` and
  `profileTimeout` fields, `resolveProfile`, the `profileTimeout` constant, and
  `WithProfileResolver`.
- Remove `WithLogger` and the `Verifier.log` field **only if** nothing else uses
  them once `resolveProfile` is gone — check first. The startup WARN lives in
  `NewVerifierFromConfig` and uses `cfg.Log`, which is a different thing and
  must stay.
- In `oidc.go`: remove `OIDCParser.ProfileResolver()`, and `Claims.Email` plus
  its `stringFromClaims(claims, "email")` read. Keep `stringFromClaims` itself
  if `ClientID` still uses it — it does.
- `go mod tidy`: `golang.org/x/oauth2` should return to indirect.

### Task 2 — tools stops passing an email it never read

`modules/tools/internal/handler/handler.go` — drop `Email: principal.Email` from
all six `service.Actor{...}` literals, and remove the `Email` field from
`modules/tools/internal/service/service.go`'s `Actor`. Its comment says "Email
is what an operator recognises in the trail"; nothing ever read it, and the
trail is keyed by `Subject`. Say that in the removal, the way #453's crm change
did — the field was aspirational, not load-bearing.

### Task 3 — comments must not describe a thing that no longer exists

Several docstrings written by #452 explain the userinfo mechanism. Rewrite,
don't just delete, wherever the surrounding text still needs to say something:

- `Principal.Kind` — keep the `client_id` explanation and the "NEVER authorise
  on it" warning. Remove any reference to profile resolution.
- `Config.ConsoleClientID` — still accurate; check it does not mention userinfo.
- `README` / `docs/PLATFORM-API-CONVENTIONS.md` — #452 added entries describing
  the userinfo lookup. Correct them. Do NOT delete the `ZITADEL_CONSOLE_CLIENT_ID`
  documentation; only the profile-resolution part goes.

Record WHY the resolver went, not just that it did: it was built to populate an
audit identity that the product then decided must not be shown to a merchant
(#453). A future reader must not "restore" it thinking it was lost by accident.

### Task 4 — tests

- Delete tests that only exercised the removed machinery.
- **Keep and preserve** every `client_id` → `Kind` test from #452: operator,
  machine, unset `ConsoleClientID`, absent `client_id`, and
  `TestKindDoesNotAffectAuthorisation`.
- Fixtures still use the REAL recorded token shapes. Do not reintroduce an
  `email` claim into the operator fixture — a real operator access token has
  none, and that fixture is the record of it.

**Run the suite with Postgres — a bare `go test ./...` silently skips every
database test while still reporting `ok` (51 packages ok, 41 skipped in
`tickets/internal/handler` alone):**

```bash
docker run -d --name pgtest-g2p -e POSTGRES_PASSWORD=testpass -p 55432:5432 postgres:15-alpine
export TESSERIX_TEST_DB_HOST=localhost TESSERIX_TEST_DB_PORT=55432 \
       TESSERIX_TEST_DB_USER=postgres TESSERIX_TEST_DB_PASSWORD=testpass \
       TESSERIX_TEST_DB_NAME=postgres TESSERIX_TEST_DB_SSLMODE=disable
gofmt -l . && go build ./... && go vet ./... && go test -count=1 ./...
docker rm -f pgtest-g2p
```

Report which way it was run. A run without those variables is not a verified run.

### Task 5 — commit

Single line, conventional commits, no body, no signature. Suggested:
`refactor(platform-api): drop the userinfo resolver, whose identity nothing reads since the support signature landed`
