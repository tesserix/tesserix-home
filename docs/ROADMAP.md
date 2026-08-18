# Roadmap

**Updated**: 2026-08-18
**Governing decision**: [ADR-003](./ADR-003-CONSOLE-TOPOLOGY.md) — one console, in
place, over a modular-monolith platform API.

This orders the milestones by dependency rather than by preference. The
sequencing rule is stated once, up front, because most of the ordering follows
from it.

---

## The sequencing rule

> **Do not build a console surface against `/api/admin/*`.**

The console consumes eight endpoints from `apps/web`'s admin API. Every new
surface built against them is a surface that must be migrated twice, and
`tesserix-home` cannot become the marketing site until they are gone.

That single rule places **M13 Platform API** before the feature milestones that
would otherwise consume the legacy API — M6, M7, M8, M9 — and before **M5
Mobile**, where the cost of getting it wrong is highest because a shipped app
cannot be re-pointed at will.

Two things are exempt and run immediately, because nothing gates them and they
unblock everything else: **local development** (#271) and the **RBAC vocabulary**
(#261).

---

## Now — foundations

Work that unblocks other work. Nothing here waits on anything.

| | | |
|---|---|---|
| **#271** | M13 | Seed a database, stub the admin API. The fastest feedback loop today is unit and pglite tests; no rendered surface can be exercised locally. |
| **#261** | M12 | Surface capabilities, and take every action off `read`. Blocking for all of M12, and the platform API must enforce the same vocabulary — so it is needed before the API's authorisation is designed, not after. |
| **#269** | M13 | Design the platform API contract instead of porting the admin endpoints. Settle conventions on the tickets module, then write them down. |
| **#272** | — | Legacy retirement tracking. Opened now so deletions land with their replacements rather than accumulating. |

**Decisions blocking #261**, on #244: the surface list, whether `support`
subsumes `respond`, roles versus raw capabilities in Zitadel, and what an
operator holding only `read` sees.

## Next — the platform API and what it unblocks

**M13 Platform API** — the load-bearing milestone. Tickets first: four of the
eight endpoints, the console's only write verb outside the CRM, and enough
surface to settle envelope, errors, pagination, versioning, auth and idempotency
against real requirements.

Module boundaries enforced from the **first** module — `internal/` visibility
plus an import-graph lint. ADR-003 D2a is explicit that the whole
modular-monolith decision depends on this landing early; if it slips, extraction
stops being cheap and the service-per-domain instinct becomes retroactively
correct.

Then the remaining endpoints: dashboard, support analytics, audit logs.
Conversion-status is **not** a migration — it exists for no product, and #246
records that every Handoff signal reads `unknown` in production. Design it or
withdraw the feature.

**M12 RBAC** follows #261 and interlocks with M13: capability enforcement belongs
in the API, not only the console (#269). If the API authorises only "is this a
valid session", the console's restrictions are decoration. Order within M12:
#261 → #264 (coverage) → #262 (enforcement) + #263 (visibility) → #265
(denials) → #267 (self-view), with **#266 gating anything going live** — grants
must exist in Zitadel before enforcement ships, and sessions live 7 days, so the
lead time is real.

## Then — surfaces, in dependency order

**M2 Migration (#137)** — generic `[product]` routes. Re-scoped after
verification: every file it names is in the frozen `apps/web/admin`, the console
has **no** `[product]` route at all, and only Kora has route ids. It is building
the generic shapes for the first time, plus a product notion in `console-core` —
not collapsing duplication. That `console-core` change blocks the rest of it.

**M4 Secrets** — #273 (fix and redesign the flow in place) → #274 (absorb the
UI) → #275 (unify on Zitadel). #275 is last, and gated on a break-glass runbook
that has been **exercised**, because Zitadel's own signing key and login-client
PAT live in the store this tool administers.

**M5 Mobile (#276)** — greenfield, after M13, targeting the platform API. The
route contract inversion (`mobile` becomes optional) lands first, because it is
cheaper before the app exists.

**M6 Platform ops · M7 Operator queues · M8 Commercial · M9 Outbound** — feature
milestones that should consume the platform API. Building them earlier means
building against `/api/admin/*` and migrating twice. #151 (template editor) is
cross-linked with #254: two of its four routes are the CRM's lead templates.

**M10 Backend cleanup** — mostly independent, and #198 ("not measured" rather
than an error for an unconfigured upstream) is small and worth doing early; it
is the same honesty class as the CRM work already shipped.

## In parallel — M11 CRM

Largely independent of the platform API, so it runs alongside rather than
waiting. It splits cleanly:

**Correctness** — buildable now, no decisions outstanding. #246 (Handoff still
truncates at 100, the last silent cap), #247 (no contact edit — correcting a
typo requires the DPDP erasure path), #248 (no lawful basis recorded since the
migration), #249 (no export; won/lost unreachable), #251 (opportunities cannot
be deleted), #252 (grouped smaller gaps), #250 (the funnel is recorded and
nothing reads it).

**Structural** — needs product decisions first. #254 (the CRM can neither send
nor receive), #255 (no ongoing lead source), #256 (one organisation cannot
convert to two products — cheapest now, nothing has converted yet), #257
(cadence), #258 (qualification), #259 (business reporting).

#254 and #255 are upstream of almost everything else in that second group:
cadence without sending is a to-do list, qualification prioritises a flow that
does not exist, and reporting measures a pipeline that is not moving.

**#259 is the one that should shape the rest.** If the honest answer is "the CRM
produced two tenants in six months", the right response is fixing the
acquisition motion, not building more surfaces. That argument cannot currently be
had with evidence.

## Blocked

Nine issues carry `blocked-external` or `track-b` and cannot start here: #111,
#136, #147, #148, #157, #165, #191, #194, #197, #210, #211, #226.

Two are worth watching because other work depends on them:

- **#211** (read-only Zitadel Management API credential) gates #244 R7.2 —
  "who holds what" is unanswerable in this repo today — and `platform.identityLookup`.
- **#165** (estate identity target) owns *which* IdP. ADR-003 D4 creates an
  exception it should record: the secrets surface keeps a second provider until
  the break-glass is proven.

`#226` is labelled `track-b` but is a live DPDP correctness bug — erasure is
undone by the next import because nothing reads `erased_at`. Worth re-checking
whether the label is still accurate.

---

## Not on the critical path, deliberately

- **The repository split.** ADR-003 D1 keeps everything here; the end state is
  reached by deleting legacy surfaces, not by migrating the console. A rename at
  the end is optional and cheap.
- **Multi-zone.** Revisit with a second team or a measured build problem.
- **Extracting further services.** Trigger table in ADR-003 D2a: different
  privileges, different scaling profile, or different lifecycle. Only secrets
  meets one today.

## How this stays honest

Each milestone's issues carry their own acceptance criteria; this document holds
only the ordering and the reasons for it. When an ordering reason stops being
true — the API migrates faster than expected, a second team appears, a module's
scaling profile diverges — the change belongs in the relevant ADR first and here
second.
