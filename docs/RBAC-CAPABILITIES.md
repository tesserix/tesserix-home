# Who can do what in the console

The mapping #266 (R6.3) asks for: every surface and the capability that guards
it, and every operator and what Zitadel actually grants them. It is the record
and, as #266 puts it, *"the first time anyone will see, in one place, who can
do what"* — so it is also the review.

Read against `packages/console-core/src/routes.ts`, which is the source of
truth. If this file and that table disagree, the table is right and this file
is stale.

**Verified against production Zitadel on 2026-09-04**, project
`platform-console` (`386377618200461939`), org `TESSERIX`
(`386377229942128837`).

## Operators, as granted today

| Login | Capabilities held |
|---|---|
| `mahesh.sangawar@gmail.com` | all 12 human capabilities |
| `samyak.rout@gmail.com` | all 12 human capabilities |
| `unidevidp@gmail.com` | all 12, plus `read-plan-catalog` |
| `mark8ly-catalog-reader` *(machine)* | `read-plan-catalog`, `read-promo-catalog` |

The 12: `read`, `platform`, `crm`, `support`, `respond`, `billing`,
`mass-send`, `hard-delete`, `rotate-credentials`, `publish-catalog`,
`adjust-balance`, `execute-refund`.

**So nobody is narrow yet, and enforcement currently refuses nothing.** That
is why #262 could ship ahead of this issue without locking anyone out — R6.1
("grant first") was already satisfied. It is also why the switch below matters:
the first time a grant is narrowed is the first time the gate can bite.

`read-plan-catalog` is a MACHINE capability. No route requires it, and no
human needs it; `mark8ly-catalog-reader` uses it to pull the plan catalog.

`read-promo-catalog` (tesserix-home#521) is the second machine capability, and
it guards `GET /api/v1/promo-catalog`. **Created and granted to
`mark8ly-catalog-reader` on 2026-09-04**, verified against production: a token
for that service user carries exactly `["read-plan-catalog",
"read-promo-catalog"]` and the endpoint answers `200`. It is deliberately NOT
implied by `read-plan-catalog`: reading published prices and enumerating every
promo code in the estate are different grants, and folding them together would
silently widen the grant `mark8ly-catalog-reader` already holds.

### Minting a machine token to test either endpoint

The scope matters more than it looks, and getting it wrong costs an hour. Three
variants were measured against production Zitadel:

| scope | audience | roles claim |
|---|---|---|
| `openid …:{projectId}:aud` | correct | **NONE** |
| `openid …:{projectId}:aud urn:zitadel:iam:org:projects:roles` | correct | correct |
| `openid urn:zitadel:iam:org:projects:roles` | **wrong** (the client id) | NONE |

Only the middle one works:

```bash
curl -s -X POST https://auth.tesserix.app/oauth/v2/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  --data-urlencode 'scope=openid urn:zitadel:iam:org:project:id:386377618200461939:aud urn:zitadel:iam:org:projects:roles'
```

**A token minted without the roles scope fails with `401`, not `403`**, which
is the part that misleads. `verifyMachineAuthHeader` derives `orgId` from
inside the roles claim, so a token with no roles fails the `isInternal` check,
and the catch block wraps any failure as `MachineTokenError`. The token
verifies perfectly against the JWKS and still answers 401 — indistinguishable
from a bad credential, so it reads as "my token is wrong" rather than "my scope
is wrong". Credentials for `mark8ly-catalog-reader` live in the
`mark8ly-console-catalog` secret in the `mark8ly` namespace.

## Surfaces, by capability

Retired routes are omitted. *pending* means the surface is declared but not yet
built — it still carries its capability, so it is gated the day it ships.

### `read` — console entry, and the shell

`read` guards no surface, by design: `routes.test.ts` holds an invariant that no
route may resolve to it, because a surface gated on the ticket every operator
already holds is not gated at all.

It does guard **the landing page**. `capabilityForPath("/")` returns `read`
because `safeReturnPath` sends every fresh sign-in to `/`, and an operator who
could not load it would be locked out of the console entirely — including out
of the surfaces they do hold. The shell is not a surface.

### `platform` — 26 surfaces

`/` *(dashboard content; the shell itself is `read`)*, `/platform/ai-usage`,
`/platform/apps`, `/platform/audit-log`, `/platform/custom-domains`,
`/platform/databases`, `/platform/health`, `/platform/identity-lookup`,
`/platform/inbox`, `/platform/notifications`, `/platform/observability`,
`/platform/onboarding`, `/platform/onboarding/sessions`, `/platform/outbox`,
`/platform/secrets`, `/platform/secrets/new`, `/platform/secrets/reviews`,
`/platform/settings`, `/platform/tenants`, `/platform/tools`,
`/platform/uptime`, `/kora`, `/kora/ai-metrics`, `/kora/foods`, `/kora/users`,
`/mark8ly/migration-fast-path`

### `crm` — 6 surfaces

`/platform/crm`, `/platform/crm/import`, `/platform/crm/organisations`,
`/platform/crm/suppressions`, `/platform/crm/templates`,
`/platform/lead-templates`

### `billing` — 2 surfaces

`/platform/billing`, `/platform/billing/catalog`

### One surface each

| Capability | Surface |
|---|---|
| `support` | `/platform/tickets` |
| `respond` | `/platform/live-chat` |
| `mass-send` | `/platform/announcements` |
| `hard-delete` | `/platform/gdpr` |
| `rotate-credentials` | `/platform/break-glass` |

### Capabilities that guard no surface

`publish-catalog`, `adjust-balance`, `execute-refund` are **verbs**, asserted by
actions rather than by routes — #261 took every action off `read` and gave it
its own. `read-plan-catalog` and `read-promo-catalog` are the machine
capabilities above; each guards a versioned API route rather than a console
surface.

## What the review shows

**`platform` is two thirds of the console.** 26 of 39 surfaces. A role that
withholds it withholds most of the product, so "narrow" in practice means
"holds `platform` plus some" far more often than it means a small set. If
finer separation is wanted — secrets apart from tenants, say — it needs new
capabilities, not new grants.

**The verb capabilities are the sharp ones.** `hard-delete`,
`rotate-credentials`, `execute-refund` and `adjust-balance` are each held by
every operator today. They are the grants worth narrowing first, because each
guards an irreversible action, and narrowing them costs nobody a surface.

**Everyone is an everything-operator.** There is currently no operator whose
grants describe a job. Until at least one exists, the gate is untested against
real narrowness — the tests cover it, production does not.

## The switch

`CONSOLE_RBAC_ENFORCEMENT=off` on the console deployment turns route
enforcement off: the gate stops refusing and the rail stops hiding, together.
Anything else — unset, empty, a typo — leaves enforcement ON.

It can only ever subtract. It cannot enable enforcement under a provider that
carries no capability claims, because that would refuse every surface to every
operator: both filters fail closed.

**Use it when** a grant narrowed by mistake has locked someone out. The refusal
is a 404 that is deliberately indistinguishable from "never built", so the
symptom will not explain itself — an operator reporting "that page is gone" is
what this looks like from the outside.

**How:** set it in `charts/apps/console/values-prod.yaml` and let ArgoCD sync.
It is a pod restart, not a rebuild.

## Removing the switch (#266 step 7)

A permanent bypass of the check the console exists to perform is exactly what
`internal-access.ts` already warns about for the `google` branch of
`requiresCapability`. This one is meant to go the same way.

**The condition, so it is not left to memory:** remove it once at least one
operator has held a genuinely narrow grant, across a full session lifetime
(7 days), without needing the switch. That is the evidence that grants and
enforcement agree. Until then it stays, and this section is the reminder that
it is not permanent.

Removing it means deleting `enforcesRouteCapabilities`' flag argument and its
test, and unsetting the variable in the chart — the gate then follows
`requiresCapability` alone.
