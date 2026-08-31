---
quick_id: 260831-j5r
slug: live-capability-revalidation
date: 2026-08-31
issue: tesserix-home#285
---

# Revoking a capability in Zitadel must take effect in the console in minutes, not a week

`/auth/callback` writes `roles: capabilitiesFor(...)` into the `tx_session` JWE
once, and nothing re-reads Zitadel for the 7-day life of that cookie. Remove an
operator's `hard-delete` in Zitadel and they keep it in the console for up to a
week. Proved on 2026-08-19 with the same mechanism pointing the harmless way:
four new roles were granted and neither operator saw them until re-login.

## Decisions already taken — implement these, do not re-litigate

1. **Authoritative capabilities live in the server-side store**, not the cookie.
2. **A revocation refuses the action and keeps the session.** No forced sign-out
   — a *granted* capability must not boot anyone, which is the annoyance that
   surfaced this issue.

## Constraints that produced those decisions

- `apps/console/middleware.ts` is deliberately **zero-I/O** on every request.
  Do not add a database read or a Zitadel call there. Its `isInternal` check
  keeps using the cookie.
- **Next.js forbids setting cookies during render**, so a server component that
  notices staleness cannot re-issue the session. Only route handlers and server
  actions can.
- The cookie has a hard 4096-byte ceiling this console has already crossed
  silently, causing `ERR_TOO_MANY_REDIRECTS`. Do not add fields to it.

## The split to preserve

- **Render-path `hasCapability(session?.roles, …)` calls stay cookie-based.**
  They hide buttons and surfaces — UX, not the control. Six call sites in
  `layout.tsx` and page components. Leave them alone.
- **The verb gate is the control.** `checkOperatorCapability` is called by 16
  server actions and route handlers before any mutation. That is what becomes
  live.

`docs/PLATFORM-API-CONVENTIONS.md` states the same division: *"The API is the
authorisation boundary. The console's checks are UX on top of it."* True for
federated surfaces — but the console writes to its own Postgres directly for
CRM, tools and tenants, and those writes never pass platform-api. The verb gate
is the only control on that path, which is why it is the one to fix.

## Tasks

### Task 1 — migration 0040

`apps/web/db/migrations/0040_operator_capabilities.sql`. Add to
`operator_api_tokens`:

- `capabilities text[]` — the MAPPED capability keys, exactly what
  `capabilitiesFor(email, roles)` produces for the cookie. Not raw Zitadel
  roles: two representations of the same grant that can disagree is the bug
  class this whole issue is about. Nullable — an existing row predates this.
- `capabilities_checked_at timestamptz` — nullable, same reason.

Follow the file's own commenting register: 0029 explains every column and why
its type is what it is. Say why `text[]` rather than jsonb (a flat list of
short keys, queried only as a whole), and that NULL means "never checked",
which the reader must treat as stale rather than as "holds nothing".

**THIS MIGRATION MUST BE APPLIED TO PRODUCTION BEFORE THE PR MERGES.** Kargo
deploys on merge and `db:migrate` does not ride along; a deployed console
querying a column that does not exist fails every gated action. Apply first,
verify, then merge.

### Task 2 — store the capabilities

`apps/console/lib/auth/operator-token-store.ts`:

- Extend `saveTokens` to persist `capabilities` and `capabilities_checked_at`.
- Add a reader returning both, alongside the existing token read.

Nothing here throws at its caller — that is the module's documented contract.
Keep it.

`apps/console/app/auth/callback/route.ts` — write the capabilities at login,
with `capabilities_checked_at = now()`. They are already computed there for the
cookie; store the same value rather than recomputing, so the two cannot drift.

### Task 3 — revalidate on an interval

`apps/console/lib/auth/platform-token.ts` already refreshes the access token
under a row lock with a bounded deadline. Reuse it.

**The interval is the whole point, and the obvious implementation gets it
wrong.** The access token lives ~12h, so refreshing only when it is near expiry
gives a TWELVE HOUR revocation window, not minutes. To get minutes the console
must refresh *proactively* — call the token endpoint because the capabilities
are stale, not because the token is.

- `CAPABILITY_REVALIDATE_SECONDS = 300` (5 minutes). Name it, and justify it in
  a comment: it is the stated window in #285's acceptance criterion, and the
  cost is one Zitadel refresh per active operator per 5 minutes, which at this
  estate's operator count is negligible.
- On refresh, re-derive capabilities from the NEW access token's
  project-scoped roles claim `urn:zitadel:iam:org:project:{projectId}:roles`
  (**not** the flat `urn:zitadel:iam:org:project:roles` — see #433; an operator
  token carries both but only the project-scoped form is correct), map through
  `capabilitiesFor`, and store with a fresh `capabilities_checked_at`.
- Zitadel may rotate the refresh token on use. `saveTokens` already persists
  what comes back — do not break that, or frequent revalidation will invalidate
  the session.

### Task 4 — the verb gate consults the store

`apps/console/lib/auth/operator.ts`. Add an async gate — keep the existing sync
`checkOperatorCapability` for the render path and for tests.

Order of checks, preserving the current semantics exactly:

1. no session → refuse
2. `!requiresCapability(provider)` → allow (legacy google sessions carry no
   roles; requiring one would refuse every write in local dev)
3. `isPlatformOperator(email)` → allow
4. otherwise: read the store. If `capabilities_checked_at` is within
   `CAPABILITY_REVALIDATE_SECONDS`, decide on the stored list. If stale or
   NULL, revalidate (Task 3) and decide on the result.

Update the 16 `checkOperatorCapability` call sites to await the new gate. All
16 are server actions or route handlers, so they are already async contexts.

**Failure mode — decide it deliberately and write it down.** If the store is
unreachable or the refresh fails, fall back to the cookie's snapshot and log at
WARN. Refusing every gated action during a database blip or a Zitadel outage is
its own outage, and the cookie's grant is still issuer-attested — merely stale.
State plainly in the comment that this widens the window during an outage, and
that it is the accepted trade.

### Task 5 — tests

- a capability present in the cookie but absent from a fresh store read is
  **refused** — this is the whole issue, and it must fail if the gate is
  reverted to reading the cookie
- a capability added in the store but absent from the cookie is **allowed**
  (the 2026-08-19 case, fixed in the same motion)
- a fresh `capabilities_checked_at` does NOT trigger a refresh (no Zitadel call)
- a stale one DOES
- a NULL `capabilities_checked_at` is treated as stale, not as "no capabilities"
- store unreachable → falls back to the cookie, and logs
- `isPlatformOperator` and the `requiresCapability(provider)` bypasses still
  short-circuit before any I/O
- the render-path `hasCapability` calls are unchanged

Run `pnpm test` (this repo is pnpm — `npm ci` fails, there is no
package-lock.json) and `pnpm --filter console build`. **A typecheck is not a
build**: `tsc` cannot see server-only code reaching the browser bundle, and
this task touches `server-only` modules. Run the build.

### Task 6 — commit

Single line, conventional commits, no body, no signature. Suggested:
`fix(console): revalidate operator capabilities against Zitadel, so a revocation takes effect in minutes rather than a week (#285)`

## Out of scope

- Do not shorten `TOKEN_LIFETIME_SECONDS`. The 7-day session stays; this change
  is precisely what decouples session lifetime from authorisation lifetime,
  which is #285's fourth acceptance criterion.
- Do not touch middleware.
- Do not change the render-path capability checks.
