---
quick_id: 260831-m2v
slug: unconfigured-answers-501
date: 2026-08-31
issue: tesserix-home#198
---

# An unconfigured upstream answers 501, not 503

The console maps **501** to `instrumentation-unavailable` — a calm "not measured
yet" callout, which `states.tsx` documents as *"deliberately neither empty nor
error"*. It maps everything else to a red error state.

`apps/web`'s proxy routes return **503** when the upstream credential is unset,
which is the realistic "never switched on" case. So a parked integration renders
as though something is broken.

## The contract is already decided — do not re-invent it

`apps/web/app/api/admin/apps/[product]/audit-logs/route.ts:27-33` already states
it, and already implements it:

```
//   501 { error: "not_configured", failures }   every source is unwired
//   502 { error: "audit_unavailable", failures } every source failed
//
// 501, not 503, for an unwired upstream: it is the console's NOT_IMPLEMENTED
```

So #198's "decide the contract" step is done. What is missing is applying it to
the two routes that predate it, and recording it somewhere less incidental than
one route's header.

## The two outliers — established, do not re-survey

```
apps/web/app/api/admin/analytics/support/route.ts:63-66   !OTTO_INTERNAL_AUTH -> 503
apps/web/app/api/admin/otto/[...path]/route.ts:51-54      !OTTO_INTERNAL_AUTH -> 503
```

Both already return the right BODY (`{ error: "not_configured", ... }`); only
the status is wrong. `audit-logs` is already correct and must not be touched.

## Tasks

### Task 1 — align the two routes

Change both `{ status: 503 }` to `{ status: 501 }` for the unset-credential
branch ONLY. Leave every other status alone — in particular the **502** for an
upstream that was reached and failed, which is the distinction the contract
turns on: 501 means "never wired", 502/503 mean "wired and not answering".

At each site, say WHY in a comment rather than leaving a bare number: the
console renders 501 as `instrumentation-unavailable` and anything else as an
error, so a 503 here tells an operator something is broken when the integration
was simply never switched on. Cite #198 and point at `audit-logs/route.ts`'s
header as the contract.

### Task 2 — write the contract down once

Neither `apps/web/README.md` nor `docs/` records it; it lives only in one
route's header. Add it where this repo documents API response shapes — if there
is no such place, `docs/PLATFORM-API-CONVENTIONS.md` has a response-format
section and is the closest existing home, so add a short subsection there
naming the rule and both statuses.

State it as a rule for **every** `/api/admin/*` proxy the console reads, not as
a note about these two routes, because #198's point is that this recurs on every
surface built against a proxied product endpoint.

### Task 3 — a test per route

There are currently NO tests for either route
(`apps/web/app/api/admin/analytics/support/` and `.../otto/[...path]/` each
contain only `route.ts`). Add one file each:

- credential unset → **501**, and the body still carries `error:
  "not_configured"`
- credential set, upstream throws → **502** (unchanged; pins that the fix did
  not flatten the two cases into one)

Assert the status number directly. A test that imports the console's
`NOT_IMPLEMENTED` constant would pass even if both sides drifted together,
which is the self-consistency trap that has bitten this repo repeatedly.

Run `pnpm test` and `pnpm --filter web build`.

### Task 4 — commit

Single line, conventional commits, no body, no signature. Suggested:
`fix(web): answer 501 when an upstream integration is unconfigured, so the console shows parked rather than broken (#198)`

## Out of scope

- Do not touch `audit-logs/route.ts` — it is already correct and is the
  reference.
- Do not change any 502, or the 401 on unauthenticated.
- No console changes: the console already handles 501 correctly and has tests.
