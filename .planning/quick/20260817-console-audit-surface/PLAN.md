---
id: 260817-audit
slug: console-audit-surface
date: 2026-08-17
issue: 139
status: in-progress
---

# One audit-log surface in the console

Issue #139. Architecture already decided in #158's reframe: **products keep owning
their audit, the console aggregates by reading each through an API.** No central
ingest, no product changes how it writes.

## The prerequisite nobody named

#139 says "replacing three implementations". The three are not three copies of
one thing — they are three different architectures, and **two of them are not
reachable over HTTP from the console at all**:

| Product | Path today | Console-reachable? |
|---|---|---|
| Mark8ly | `/api/admin/apps/[product]/audit-logs` → direct SQL into the mark8ly DB | Yes, but it is a #160 cross-DB grant |
| Kora | `/admin/apps/kora/audit` is a **server component** calling `lib/api/kora-admin.ts` directly, HMAC-signed to `KORA_API_URL` | **No** — there is no `/api/admin/` route for it at all |
| Fe3dr | `/admin/apps/homechef/audit-logs` → `/api/admin/apps/homechef/gw/[...path]` HMAC gateway | Yes |

So the console cannot aggregate anything until Kora's audit has an HTTP endpoint,
and the one route that *looks* product-generic is not. Its own comment says so:

> This route reads mark8ly's `platform_api` audit_logs. It is **NOT** generic:
> serving it for another product returned mark8ly's rows under that product's
> URL, so every product overview showed mark8ly's critical-event count.

That is the work. The console surface is the easy half.

## Why this belongs in `apps/web` even though `apps/web` is being retired

Only the **pages** are being deleted. The `/api/admin/*` layer explicitly stays —
the console calls it server-to-server for tickets and support analytics, and
`BASELINE.adminApiRoutes` is held at 51 by the ratchet precisely so it does not
shrink out from under the console. Per #131, that is the boundary: pages go, the
API layer is where the console's reads land.

The HMAC keys are the other reason. `KORA_BFF_HMAC_KEY` and the Fe3dr gateway
signing key live in the `apps/web` pod. Moving those into the console is a
secret-distribution change, not a refactor, and it is not in scope here.

## Note: this substantially delivers #158

#158 is "one audit timeline across products" in M6. Under its reframe as an
aggregating reader, it is nearly the same surface as this one — #139 is the
product-scoped view, #158 the estate-wide timeline, over the same normalised
data. Build the normalisation once. When this lands, #158 should be re-read
against what exists rather than planned from its original text.

---

## Task 1 — Make `/api/admin/apps/[product]/audit-logs` genuinely product-generic

Stop the route lying. It dispatches per product to that product's real source and
normalises every result onto one wire shape.

- **Mark8ly**: keep the existing `lib/db/mark8ly-audit` read for now. It is a
  #160 cross-DB grant and replacing it is that issue's job, not this one — but
  add a comment pointing at #160 so the debt is visible from here.
- **Kora**: call `listKoraEvents` from `lib/api/kora-admin.ts`. It already exists
  and is already used by the server component; this only puts it behind HTTP.
- **Fe3dr**: through the existing signed gateway.
- An unknown product is a **404**, not an empty list. The current hard gate is
  correct behaviour and must survive — silently returning nothing for a product
  that has audit is how the original bug (mark8ly's rows under every product's
  URL) got shipped.
- A product whose upstream is unconfigured is **501**, per the console's
  `NOT_IMPLEMENTED` contract. See #198: this repo currently answers 503 for that
  case, which the console renders as an error rather than "not measured". Get it
  right in the new code even though #198 fixes it elsewhere.
- One product failing must not fail the others. Partial results with a per-source
  failure list, the way `/admin/search`'s response already does it
  (`failures: {source, message}[]`).

**The wire shape is `AuditLogEntry`** — `{id, actor, action, target?, timestamp,
metadata?}` — because `@tesserix/web`'s `AuditLogViewer` is what renders it and
`console_audit_log` already stores exactly those columns. Every product's rows
normalise onto it at this boundary, once. If a product's audit cannot express
`actor`/`action`/`target`, that is the finding — record it, do not invent values.

## Task 2 — The console surface

- A `platform.auditLog` route id in `console-core` (there is none; `kora.audit`
  exists and is pending). Rail placement under Governance, not Operate — this is
  the accountability surface, unlike the identity lookup which was deliberately
  operational.
- Capability: `read`. Same argument as `platform.identityLookup` — every
  capability above `read` names a mutation, and an audit log that only
  privileged operators can read is an audit log that does not get read.
- Renders with `@tesserix/web`'s `AuditLogViewer`. It is exported from the barrel
  (`export * from './components/audit-log-viewer'`); do not grep the barrel for
  the symbol name, it lists none — see #203.
- Sources: the generic endpoint from Task 1, **plus the console's own
  `console_audit_log`** via `lib/db/audit-repo.ts`'s `recentAuditEntries`. The
  console's operator actions are one source among several, not a separate page.
- All five surface states via `resolveState`, imported from
  `@/components/kit/surface-state` — **not** from `states.tsx`, which carries a
  load-bearing `"use client"`. A server component importing a function from a
  client module gets a client reference that throws at runtime while `tsc`,
  `next build` and jsdom tests all pass.
- Filtering: product and actor. `console_audit_log` has an
  `(actor, occurred_at DESC)` index; the per-product sources are filtered
  upstream.

## Task 3 — Retire the three pages

Only after 1 and 2 are green.

- Redirect `/admin/apps/mark8ly/audit-logs`, `/admin/apps/kora/audit` and
  `/admin/apps/homechef/audit-logs` to the console surface.
- Delete those three `page.tsx` files and lower `BASELINE.adminPages` **in the
  same commit**. Read the ratchet's header first — lowering needs no
  justification, raising is the conversation, and there is a `SLACK = 5` drift
  guard.
- **Delete nothing under `app/api/admin/`.** `BASELINE.adminApiRoutes` stays at
  51. Task 1 adds no file — it changes an existing route.
- `kora.audit` in the route table becomes `retired`, matching how
  `platform.supportAnalytics` was handled in #199. `routes.console.test.ts`
  asserts on pending/retired sets — update deliberately.
- **Do not un-pend `platform.apps`.** The ticket-detail tenant link renders inert
  only because it is pending.

## Verification

- Root `pnpm test`, `pnpm lint` (now 6/6 after #205), `pnpm typecheck`,
  `pnpm build` for the console.
- `admin-surface.ratchet.test.ts` and `redirect-origin.guard.test.ts` green.
- A product whose upstream is down degrades to a listed failure, not a blank
  page — asserted.
