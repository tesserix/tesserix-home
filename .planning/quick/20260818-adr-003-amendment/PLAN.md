# Quick task: ADR-003 amendment + M13 Phase 0 issue set

**Date**: 2026-08-18
**Branch**: `docs/adr-003-platform-api-amendment`

## Why

Two decisions were settled in conversation today that ADR-003 does not record,
and one of them contradicts what the ADR currently says.

1. **The console becomes a pure UI over the platform API.** ADR-003 D1 scopes
   the migration to the eight `/api/admin/*` call sites and is *silent* on the
   console's direct database access. The blessing of that access is in the code
   — `apps/console/lib/db/tesserix.ts` calls it "the console reading its OWN
   store" — not in the ADR. The decision taken is broader than D1: `lib/db/*`
   — the CRM repo, audit, notifications, search — eventually becomes an HTTP
   client too. Left unrecorded, the ADR's silence plus that comment reads as
   permission, and the next person builds another direct-DB surface believing
   they are following the decision.

2. **Both principals authenticate via Zitadel.** ADR-003 D4 unifies *console
   login* on Zitadel but says nothing about how the platform API authenticates
   its callers. The decision taken is that the API takes Zitadel tokens for both
   an operator principal and a service principal — products call the platform
   API directly (filing tickets, for one). This closes #161's question about the
   blanket `INTERNAL_API_TOKEN` and it rules out the cheaper shortcut of sharing
   `SESSION_ENCRYPT_KEY` with the Go service.

## Verified before writing

Read from the code on 2026-08-18, not from documentation.

- No Go code in this repository yet. No `go.work`, no `platform-api/`.
- The eight admin call sites are in two files: `apps/console/lib/platform-api.ts`
  (seven) and `apps/console/lib/crm-conversion.ts` (one).
- `apps/console/lib/db/tesserix.ts` states in its own header that it mirrors
  `apps/web/lib/db/tesserix.ts` and reads "the same database with the same
  credentials". So an endpoint migration is a Go rewrite against the same
  tables — there is no data migration in this work.
- `tx_session` is a JWE, `alg: "dir"`, `enc: "A256GCM"`, keyed off a symmetric
  `SESSION_ENCRYPT_KEY` (`packages/platform-auth/src/session-jwt.ts`). Go could
  decrypt it. D8 declines to, and says why.
- `apps/console/lib/auth/oidc.ts` already requests `offline_access` and the
  project audience scope, but `app/auth/callback/route.ts` discards
  `access_token` and `refresh_token` — only ID-token claims reach the session.
  So the hook D8 needs exists and is unwired.

## Tasks

1. Amend `docs/ADR-003-CONSOLE-TOPOLOGY.md`: add D7 and D8, and correct the D1
   and D2 text that D7 supersedes. Record the CRM/audit transaction constraint.
2. Amend `docs/ROADMAP.md` where D7 changes the M11 sequencing argument — the
   CRM is no longer independent of the platform API in the way the roadmap
   assumes.
3. Create the M13 Phase 0 issues: service scaffold + module-boundary
   enforcement, and Zitadel dual-principal auth.
4. Update #269 with the Zitadel decision, replacing its open question about
   principal types.

## Out of scope

Writing any Go. Phase 0 scaffold is the next task, tracked by the issue this
one creates.
