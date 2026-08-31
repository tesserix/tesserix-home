---
quick_id: 260831-g2p
slug: remove-userinfo-resolver
date: 2026-08-31
status: complete
branch: refactor/drop-userinfo-resolver
follows: tesserix-home#450, #453
---

# Removed the userinfo resolver

Zitadel is no longer on the authentication path of any request. `Verify` is
entirely local for both principal types, and `auth.Principal` carries a subject,
capabilities and a kind — nothing else.

The `client_id` → `Kind` mechanism from #450 is untouched, as planned:
`Claims.ClientID`, `Config.ConsoleClientID`, `WithConsoleClientID`, the kind
assignment in `Verify`, and the startup WARN in `NewVerifierFromConfig` all
stay. `tesserix-k8s` was not touched, so `ZITADEL_CONSOLE_CLIENT_ID` keeps its
meaning.

## Files changed

Deleted:

- `platform-api/internal/platform/auth/profile.go`
- `platform-api/internal/platform/auth/profile_test.go`

Modified:

- `platform-api/internal/platform/auth/verify.go` — dropped `Principal.Name`,
  `Principal.Email`, `Claims.Email`, the `profiles` / `profileTimeout` / `log`
  fields, `WithProfileResolver`, `WithLogger`, the `profileTimeout` constant and
  `resolveProfile`. The `Principal` docstring now records WHY the resolver went.
- `platform-api/internal/platform/auth/oidc.go` — dropped `OIDCParser.provider`,
  `OIDCParser.ProfileResolver()`, the `stringFromClaims(claims, "email")` read,
  and the `WithProfileResolver` / `WithLogger` wiring. `stringFromClaims` and
  `Config.Log` docstrings rewritten.
- `platform-api/internal/platform/auth/verify_test.go` — the three
  `client_id` → `Kind` tests moved here from `profile_test.go`, plus the
  `validClaims()` fixture comment.
- `platform-api/internal/platform/auth/oidc_test.go` — three comments corrected.
- `platform-api/internal/modules/tools/internal/handler/handler.go` — six
  `service.Actor{...}` literals lost `Email: principal.Email`.
- `platform-api/internal/modules/tools/internal/service/service.go` —
  `Actor.Email` removed, with the reason recorded the way #453's crm change did.
- `platform-api/internal/modules/tickets/internal/handler/handler.go` — the
  `actorOf` comment no longer claims `Principal` still carries name and email.
- `platform-api/internal/modules/crm/internal/service/service.go` — one clause
  added so the historical account does not imply the resolver still exists.
- 15 module `handler_test.go` files — dropped `Email:` from their `auth.Claims`
  fixtures (the field no longer exists; a real operator token never carried it).
- `platform-api/go.mod` — `golang.org/x/oauth2` back to `// indirect`.
- `platform-api/README.md`, `docs/PLATFORM-API-CONVENTIONS.md` — the userinfo
  entries corrected; the `ZITADEL_CONSOLE_CLIENT_ID` documentation kept.

## Tests kept

Every `client_id` → `Kind` test from #450 survives:
`TestTheConsolesClientIDIdentifiesAnOperator`,
`TestAnUnsetConsoleClientIDMakesEveryoneAService`,
`TestAnAbsentClientIDIsAService`, `TestATokenFromAnotherClientIsAService`,
`TestKindDoesNotAffectAuthorisation`, `TestClientIDIsReadFromBothRealTokens`,
`TestNeitherRealAccessTokenCarriesAnEmail`. The recorded token fixtures are
unchanged — no `email` claim was reintroduced into the operator fixture.

Deleted with the machinery they exercised: the resolution, timeout and cache
tests (`TestAnOperatorsNameAndEmailComeFromUserinfo`,
`TestTheResolverIsNotCalledForAMachinePrincipal`,
`TestAUserinfoFailureDoesNotFailTheRequest`,
`TestASlowUserinfoIsBoundedAndStillSucceeds`,
`TestTheDefaultProfileTimeoutIsSet`,
`TestASecondRequestForTheSameSubjectIsServedFromTheCache`,
`TestAnExpiredCacheEntryIsResolvedAgain`,
`TestAFailedLookupIsNotRetriedWithinTheNegativeTTL`, `TestTheCacheIsBounded`).

## Test run — Postgres WAS exported

Run exactly as Task 4 specifies, from `platform-api/`, against
`postgres:15-alpine` in a container on port 55432, with all six
`TESSERIX_TEST_DB_*` variables exported:

```
gofmt -l .     # no output
go build ./... # no output
go vet ./...   # no output
go test -count=1 ./...
```

Result: **51 packages `ok`, 0 `FAIL`, 0 `SKIP`, 0 `panic`.** The remaining
lines of the 77 are `[no test files]`.

The database tests genuinely ran rather than skipping. Verified directly on the
package the plan names:

```
# with the TESSERIX_TEST_DB_* variables exported
$ go test -count=1 -v ./internal/modules/tickets/internal/handler/ | grep -cE '^--- (PASS|SKIP)'
41
$ ... | grep -cE '^--- SKIP'
0

# with TESSERIX_TEST_DB_HOST unset
$ env -u TESSERIX_TEST_DB_HOST go test -count=1 -v ./internal/modules/tickets/internal/handler/ | grep -cE '^--- SKIP'
41
```

Container removed afterwards (`docker rm -f pgtest-g2p`).

## Deviations and judgement calls

1. **The three classification tests were moved, not deleted.** The plan says
   delete `profile_test.go` entirely (Task 1) and also keep every
   `client_id` → `Kind` test (Task 4). Those three lived in `profile_test.go`,
   so they were moved verbatim into `verify_test.go`, which already owns the
   shared fixtures. One assertion inside
   `TestAnUnsetConsoleClientIDMakesEveryoneAService` checked `got.Name == ""`;
   since `Name` is gone it now asserts the thing that actually matters — an
   unconfigured console client id must not cost the caller its capabilities.

2. **Fifteen module test fixtures needed editing, which the plan did not list.**
   They built `auth.Claims{... Email: "operator@tesserix.test" ...}` and stopped
   compiling. Only the `Email` line was removed. These were never accurate
   anyway: a real operator access token carries no `email` claim, which is the
   whole of #450.

3. **Two comment fixes beyond the listed set**, both cases of a docstring
   describing something that no longer exists (Task 3's rule):
   - `docs/PLATFORM-API-CONVENTIONS.md` still described `Principal.Kind` as
     "inferred from the presence of an email claim" — stale since #450, not just
     since this change. Corrected to the `client_id` mechanism.
   - `crm/internal/service/service.go`'s historical account of #450 read as
     though the resolver were still live. One clause added; the history kept.

4. **`OIDCParser.provider` was removed too.** Not in the plan's list, but it was
   retained solely so `ProfileResolver()` could reach the userinfo endpoint from
   the same discovery document. With that method gone it was an unused field.

Nothing outside `platform-api/`, `docs/` and `.planning/` was touched.
`tesserix-k8s` was not touched.
