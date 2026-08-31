---
quick_id: 260831-e4k
slug: fix-450-operator-identity
date: 2026-08-31
issue: tesserix-home#450
status: complete
branch: fix/450-operator-identity
---

# platform-api: identify operators by client_id, and resolve their name/email from userinfo

`verify.go` no longer infers the principal kind from `claims.Email != ""`. It
compares the token's `client_id` against the configured
`ZITADEL_CONSOLE_CLIENT_ID`, and for an operator resolves `name` and `email`
from the issuer's userinfo endpoint — cached, bounded by a timeout, and failing
soft.

## Files changed

### Auth (the fix)

- `platform-api/internal/platform/auth/verify.go` — `Claims.ClientID`,
  `Principal.Name`; `Principal.Kind` docstring rewritten (the "NEVER authorise
  on it" warning kept, the mechanism description replaced); `Verifier` gains
  `consoleClientID`, `profiles`, `profileTimeout`, `log`, configured through a
  new variadic `Option` so `NewVerifier(parser, projectID)` still compiles
  unchanged; `Verify` decides kind by client id and calls `resolveProfile`,
  which never returns an error.
- `platform-api/internal/platform/auth/profile.go` — **new**. `ProfileResolver`
  interface, `userinfoResolver` over the already-discovered `*oidc.Provider`,
  and `profileCache` (positive TTL 15m, negative TTL 1m, hard cap 1024 entries,
  eviction of expired-then-arbitrary).
- `platform-api/internal/platform/auth/oidc.go` — `OIDCParser` retains the
  provider and exposes `ProfileResolver()`; `Parse` reads `client_id`;
  `Config.ConsoleClientID` and `Config.Log`; `NewVerifierFromConfig` wires the
  resolver and WARNs once at startup when the client id is unset;
  `stringFromClaims` docstring updated for its second caller.
- `platform-api/internal/platform/config/config.go` — `Auth.ConsoleClientID`
  from `ZITADEL_CONSOLE_CLIENT_ID`, deliberately absent from the required list.
- `platform-api/cmd/server/main.go` — passes `ConsoleClientID` and the app
  logger.

### Downstream

- `platform-api/internal/modules/tickets/internal/handler/handler.go` —
  `actorOf` passes `principal.Name`; the now-false comment about the `name`
  claim is replaced with the `displayName()` consequence.
- crm's `auditActor()` unchanged, as planned — its subject fallback is correct
  for machine principals and it starts recording emails on its own.

### Tests

- `platform-api/internal/platform/auth/profile_test.go` — **new**. Kind matrix
  (console id, machine id, unset config, absent claim), resolver not called for
  a machine, fail-soft on error with the WARN asserted, bounded timeout,
  default timeout non-zero, cache hit / expiry / negative caching, cache bound.
- `platform-api/internal/platform/auth/verify_test.go` — fixtures rebuilt from
  the real tokens (`validClaims()` is now the real operator shape, **with no
  email**; new `machineClaims()`); the two email-heuristic tests rewritten.
- `platform-api/internal/platform/auth/oidc_test.go` — `operatorPayload` now
  carries its real `client_id`, `sub` and resourceowner claims; new tests that
  `client_id` is read from both real payloads, that `azp` is on neither, and
  that neither carries an `email`.
- `platform-api/internal/modules/tickets/internal/service/service_test.go` —
  **new**. `displayName()` returns the operator's name, not "Tesserix Support".
- `platform-api/internal/platform/config/config_test.go` — the console client
  id is read and its absence still loads.
- `platform-api/internal/platform/auth/middleware_test.go` — one asserted
  subject followed the fixture.

### Docs

- `platform-api/README.md`, `docs/PLATFORM-API-CONVENTIONS.md` — the new
  variable and why it is optional.

- `platform-api/go.mod` — `golang.org/x/oauth2` promoted from indirect to
  direct (`go mod tidy`); no version changed.

## Verification

`gofmt -l . && go build ./... && go vet ./... && go test -count=1 ./...` from
`platform-api/` — exit 0. gofmt, build and vet produced no output. 50 packages
`ok`, zero `FAIL`. Tail:

```
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency	5.158s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/paging	5.178s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/reqid	5.013s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/testdb	5.103s
ok  	github.com/tesserix/tesserix-home/platform-api/internal/platform/write	5.144s
```

`go test -race ./internal/platform/auth/` also passes (extra, not required) —
the cache takes a mutex and is exercised concurrently by the timeout test.

## Deviations and judgement calls

1. **Existing auth test fixtures had to change.** `validClaims()` set an email
   and several tests asserted `KindOperator` from it. Those assertions encoded
   the bug, so they were rewritten against the real token shapes rather than
   propped up. Nothing was deleted: the "kind must not affect authorisation"
   test still exists and now differs its two fixtures by `client_id`.
2. **Variadic `Option` on `NewVerifier`** rather than a second constructor. The
   plan allowed either; this keeps the existing signature literally unchanged.
3. **The timeout lives on `Verifier`, not inside `userinfoResolver`.** Verify
   owns the request path and so owns the deadline; it also lets the timeout
   test use 20ms instead of the real 3s.
4. **Added `Config.Log`** (not in the plan). The startup WARN and the
   per-request WARN would otherwise go to `slog.Default()`; main already
   `SetDefault`s, but passing the logger explicitly keeps the reqid handler in
   the chain by construction rather than by ordering luck.
5. **Subject check in `userinfoResolver`.** Userinfo's `sub` is compared with
   the token's. Not asked for; a name about to be written into an audit row
   under someone else's subject is worse than no name.
6. **Docs and a config test** beyond the plan's task list, for the new
   environment variable.

Not done, as instructed: no backfill, no migration, no cluster/database/Zitadel
access, no token minted or decrypted.
