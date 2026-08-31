---
quick_id: 260831-j5r
slug: live-capability-revalidation
date: 2026-08-31
issue: tesserix-home#285
status: complete
branch: fix/285-live-capability-revalidation
migration: apps/web/db/migrations/0040_operator_capabilities.sql
migration_applied: false
---

# Revoking a capability in Zitadel now bites in five minutes, not a week

The authoritative capability list moved out of the seven-day `tx_session`
cookie and into `operator_api_tokens`, beside the refresh token that is the
only way to ask Zitadel what an operator currently holds. The verb gate —
`checkOperatorCapabilityLive` — reads that list and revalidates it whenever it
is older than 300 seconds. The render path is unchanged and still reads the
cookie.

## THE MIGRATION IS NOT APPLIED

`apps/web/db/migrations/0040_operator_capabilities.sql` was written and is
exercised by the integration suite against pglite. **It has not been applied to
any database, and no cluster or database was contacted.** Apply it to
production and verify BEFORE merging: Kargo deploys on merge, `db:migrate` does
not ride along, and a deployed console selecting `capabilities` from a table
that lacks the column fails every gated action.

## Files changed

### New

| File | What |
|---|---|
| `apps/web/db/migrations/0040_operator_capabilities.sql` | `capabilities text[]` + `capabilities_checked_at timestamptz` on `operator_api_tokens`, both nullable, no index |
| `apps/console/lib/auth/operator.live.test.ts` | The gate: which list decides, in both directions, and the bypasses |
| `apps/console/lib/auth/platform-token.capabilities.test.ts` | The interval: fresh -> zero IdP calls, stale/NULL -> exactly one |
| `apps/console/lib/auth/render-path-capabilities.test.ts` | The split, asserted against the source files |

### Modified

| File | What |
|---|---|
| `packages/platform-auth/src/zitadel.ts` | `projectRolesClaim(projectId)` (exported, now used by both readers) and `rolesFromAccessToken` — verifies an access token and returns the project-scoped roles |
| `packages/platform-auth/src/zitadel.test.ts` | Coverage for both, using the file's existing local-JWKS harness |
| `apps/console/lib/auth/operator-token-store.ts` | `StoredOperatorTokens`/`OperatorTokensInput` carry capabilities; upsert COALESCEs so omission preserves; new key-free `readCapabilities` |
| `apps/console/lib/auth/platform-token.ts` | `CAPABILITY_REVALIDATE_SECONDS = 300`, `resolveLiveCapabilities`, `revalidateUnderLock` |
| `apps/console/lib/auth/operator.ts` | `checkOperatorCapabilityLive` beside the unchanged sync gate; module is now `server-only` |
| `apps/console/app/auth/callback/route.ts` | Computes `capabilitiesFor(...)` once and writes it to both the cookie and the store |
| 9 call sites (`crm/import/actions.ts`, `tickets/[id]/actions.ts`, `billing/catalog/actions.ts`, `api/internal/parity-check`, `api/notifications`, `api/search`, `lib/crm-write.ts`, `lib/tools-write.ts`, `lib/tenant-lifecycle-write.ts`) | `await checkOperatorCapabilityLive(...)` |
| `apps/console/app/auth/logout/route.ts` | Deliberately kept on the sync gate, with the reasoning written at the call site |
| `apps/console/lib/auth/platform-token.test.ts`, `lib/crm-write.test.ts`, `lib/tools-write.test.ts`, `lib/auth/operator-token-store.integration.test.ts` | Doubles widened for the new fields; the integration suite now loads 0040 too |

## Test output

`pnpm test` (turbo, all 8 packages):

```
@tesserix/homechef-shared:test:unit:  Test Files  1 passed (1)
@tesserix/homechef-shared:test:unit:       Tests  9 passed (9)
@tesserix/platform-auth:test:unit:  Test Files  7 passed (7)
@tesserix/platform-auth:test:unit:       Tests  120 passed (120)
@tesserix/console-core:test:unit:  Test Files  6 passed (6)
@tesserix/console-core:test:unit:       Tests  87 passed (87)
web:test:unit:  Test Files  23 passed (23)
web:test:unit:       Tests  261 passed (261)
console:test:unit:  Test Files  175 passed (175)
console:test:unit:       Tests  2930 passed (2930)

 Tasks:    8 successful, 8 total
```

Baseline before any change was 172 files / 2871 tests in `console`; this adds
3 files and 59 tests there, plus 8 in `platform-auth`.

## Build output

`pnpm --filter console build` — a real `next build`, not a typecheck, because
this touches `server-only` modules and `tsc` cannot see server-only code
reaching the browser bundle:

```
> console@0.1.0 build
> next build

▲ Next.js 16.2.11 (Turbopack)

⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
  Creating an optimized production build ...
✓ Compiled successfully in 5.4s
  Running TypeScript ...
  Finished TypeScript in 4.5s ...
  Collecting page data using 13 workers ...
✓ Generating static pages using 13 workers (7/7) in 78ms
```

All 37 routes built. The middleware-deprecation warning is pre-existing and
unrelated. `pnpm lint` and `pnpm typecheck` are also clean across the repo.

## Judgement calls and deviations

1. **Logout stays on the synchronous gate.** The plan said to convert the
   `checkOperatorCapability` call sites; `app/auth/logout/route.ts` is the one
   left behind, deliberately. Signing out must not depend on Postgres or
   Zitadel — the handler's own existing comment already commits to logout
   succeeding whatever the store does — and under the live gate an operator
   whose `read` was revoked would be refused at logout and left holding a
   cookie they cannot clear. The reasoning is written at the call site and
   pinned by a test.

2. **`rolesFromAccessToken` VERIFIES rather than decodes.** The plan says
   "re-derive capabilities from the NEW access token's project-scoped roles
   claim" without saying how. `zitadel.ts`'s module header already rejects
   decode-only for tokens carrying authorization data, and this answer
   overrides a signed session claim, so it verifies against the same cached
   JWKS with `audience: projectId`. The refresh and the verification share ONE
   `REFRESH_TIMEOUT_MS` budget so the documented coupling to
   `connectionTimeoutMillis` still holds.

3. **DEPLOY PRECONDITION — the Zitadel application must issue JWT access
   tokens.** Zitadel applications default to OPAQUE bearer access tokens, and
   with that default there is no roles claim to read: `rolesFromAccessToken`
   returns null, the gate falls back to the cookie, and revocation quietly
   reverts to the session lifetime. I did not verify the live setting — the
   task forbids contacting the cluster. The code warns ONCE per process naming
   the setting, and the fallback is logged, so the state is visible rather than
   silent. **Check `console-web`'s auth token type in Zitadel before relying on
   the five-minute window.**

4. **Capabilities are stored in PLAINTEXT, unlike the tokens beside them.** A
   capability key names a permission and is not a bearer credential, and — more
   importantly — this is the one column the gate must be able to read when
   `OPERATOR_TOKEN_ENCRYPT_KEY` is missing or rotated. `readCapabilities` needs
   a database and nothing else; an integration test pins that.

5. **The upsert COALESCEs rather than writing `EXCLUDED` unconditionally.** The
   token-refresh path renews a credential without asking about capabilities; a
   bare `EXCLUDED` would blank the list on every refresh and leave the gate
   permanently revalidating. Omission preserves; an empty array overwrites, so
   "confirmed empty" stays expressible. Pinned by two integration tests.

6. **The rotated refresh token is persisted even when the roles cannot be
   read.** By that point the old token is already spent, so returning early
   would cost the session its ability to refresh at all — turning a failed
   capability read into a forced sign-in.

7. **`projectRolesClaim` was extracted into `platform-auth`** rather than the
   claim name being written out a second time in the console. Two spellings of
   this string is the failure that cost a day in #433, and it presents as "this
   operator holds no roles" rather than as a typo.

8. **`operator.ts` is now `server-only`.** It transitively imports the store.
   No client component reached it (the real `next build` confirms), and the
   sync gate's behaviour is unchanged.

## Untouched, as instructed

- `apps/console/middleware.ts` — still zero-I/O; its `isInternal` check still
  reads the cookie.
- The six render-path `hasCapability(session?.roles, ...)` calls — unchanged,
  and now guarded by `render-path-capabilities.test.ts`.
- `TOKEN_LIFETIME_SECONDS` — the 7-day session stays. Decoupling session
  lifetime from authorisation lifetime is what this change delivers.
