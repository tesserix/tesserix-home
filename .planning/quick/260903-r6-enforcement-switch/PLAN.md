---
id: 260903-r6
slug: enforcement-switch
date: 2026-09-03
issue: 266
kind: quick
---

# RBAC R6: a kill switch, the operator mapping, and the lockout #262 shipped with

## Where this starts

#266's sequence says "ship enforcement (#262, #263) with the switch **off**". That is not what happened — #529 shipped it on, gated only on `AUTH_PROVIDER === "zitadel"`, which is true in production. It is live now.

It is harmless *today* only because R6.1 is already satisfied: all three operators hold all 8 route capabilities (verified against Zitadel before merging; the one they lack, `read-plan-catalog`, is a machine capability no route requires). Nothing is refused because nothing can be.

The danger begins with the first narrowed grant — which is the entire point of RBAC.

## T1 — the lockout, which is not hypothetical

**`/` requires `platform`.** `platform.dashboard` declares it, and its console path is `/`.

`safeReturnPath` defaults to `/`, so every fresh sign-in lands there. An operator holding `crm` and `support` but not `platform` therefore signs in and receives a **404** — no shell, no rail, no way to reach the two surfaces they do hold. R6.4 names this as "the case most likely to be missed"; it is worse than the issue anticipated, because it strikes operators who hold surfaces, not only those who hold none.

It also contradicts the vocabulary. #261's own doc on `read` says it "grants the shell and home".

**Fix:** the console home requires the entry capability. The page renders the estate map and the tools directory — orientation, not privileged data.

**Done when:** an invariant test pins `capabilityForPath("/")` to the entry capability, so no future route change can make the landing page unreachable again.

## T2 — the switch (R6.2)

A **kill switch, not a toggle**: it can only ever DISABLE enforcement, never enable it where capability claims do not exist.

```
enforceRouteCapabilities = requiresCapability(provider) && flag !== "off"
```

Asymmetric on purpose. A symmetric toggle could be set "on" under the legacy provider, which carries no claims at all — and `visibleNav`/`visibleTo` fail closed, so that would refuse every surface to every operator: the exact lockout the switch exists to undo.

Unset means today's behaviour, so merging changes nothing — the same property `requiresCapability` was built for at the Zitadel cutover, and named in #266 as the precedent.

**Done when:** the flag disables both the gate and the rail filter together. They must not disagree: a gate off with a filter on hides surfaces it would serve; the reverse offers surfaces it refuses.

## T3 — the mapping (R6.3)

`docs/RBAC-CAPABILITIES.md`: surface → capability, and operator → capabilities as Zitadel actually holds them today. #266 calls this "the first time anyone will see, in one place, who can do what", so it is the review as much as the record.

## Out of scope, and why

**R6.4's non-production verification cannot be done as written.** There is one cluster. The narrow-role cases are covered by tests instead — including the no-surface operator, which is T1's invariant.

**Removing the switch (step 7) is not this issue's work**, but the acceptance asks for a stated plan, so the doc carries the condition for removing it rather than a date.
