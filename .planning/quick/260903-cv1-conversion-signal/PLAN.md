---
id: 260903-cv1
slug: conversion-signal
date: 2026-09-03
issue: 246
kind: quick
---

# Wire the CRM conversion signal through federation (#246)

## What is already true, verified rather than assumed

**The producer exists and is deployed.** mark8ly's marketplace-api serves
`GET /api/v1/platform/admin/conversions?email=` — `ConversionsHandler` (#279),
mounted at `routes.go:246` behind `deps.TenantDirectory`. It returns exactly
the contract shape (`state` / `ref` / `label` / `observed_at`) and honours the
rule that a miss is `200 {"state":"none"}`, never a 404.

Probed in production 2026-09-03, with a negative control because a bare 401
proves nothing on this surface:

```
/admin/conversions?email=…      no auth   401   (mounted, signature rejected)
/admin/definitely-not-a-route   no auth   404   (control)
/admin/conversions?email=…      +secret   401   (X-Internal-Auth is the WRONG
/admin/definitely-not-a-route   +secret   404    scheme here — platformadmin
                                                 wants the signed federation
                                                 envelope, not a bare secret)
```

**The road exists.** tesserix platform-api already federates to that exact
surface: `FEDERATION_MARK8LY_BASE_URL=…/api/v1/platform`, secret in
`mark8ly-federation`, and `federation.Client.Get(ctx, slug, path, op)` speaks
the signed envelope `platformadmin.RequirePlatformAuth` wants.

**Only the consumer is missing.** `apps/console/lib/crm-conversion.ts` targets
`{WEB_ORIGIN}/api/admin/apps/{product}/conversion-status`, and that route does
not exist in apps/web — nine sibling routes do, this is not one. So every
Handoff signal reads `unknown`, `suggestion` is always null, and the
`method: "matched"` path at `handoff-view.tsx:141` is unreachable. That is
what #505 observes as "nothing computes a match".

## The road chosen, and the ruling it supersedes

Ruling 27 (#153) says the console never calls a product directly and must go
through apps/web, *"which holds the HMAC keys Kora and Fe3dr require — moving
those keys into the console would be a secret-distribution change, not a
refactor."*

That premise does not hold here. apps/web holds Kora's, Homechef's and Otto's
credentials; it holds **no mark8ly credential** — the `company` deployment has
`MARK8LY_PLATFORM_API_URL` and no signing key for that surface. Honouring the
ruling literally would mean distributing a new secret to a second workload,
which is the exact cost the ruling exists to avoid.

And apps/web is being **retired to a marketing page**, so a tenth admin proxy
route there is work with a known expiry.

So: federation, via platform-api. No new secret anywhere.

## Tasks

### T1 — platform-api serves the signal

`GET /v1/crm/conversion-status?product=<slug>&email=<email>`, gated on `crm`
like every other route in the module, added to `RouteTable` so the existing
capability test covers it.

- A product that does not declare the `conversions` endpoint answers **501**,
  through `Registry.SlugsImplementing` — the absence-means-no rule the registry
  already applies to `inbox`. Not 404: 404 is what a missing route returns, and
  the two must stay distinguishable (Ruling 28).
- mark8ly's 200 body is passed through **unchanged**. The console's
  `parseConversionBody` is strict and already correct; re-shaping here would be
  a second contract to keep in step.
- An upstream failure is a failure, never a fabricated `none`.

**Done when:** the route answers 501 for an undeclared product, passes a
declared product's body through, and never turns an error into `none`.

### T2 — the console asks platform-api

Retarget `fetchConversionSignal` at `PLATFORM_API_ORIGIN`. Everything else in
`crm-conversion.ts` — the strict parser, Ruling 28's non-2xx→`unknown`, Ruling
29's 8s timeout — is unchanged and still correct.

**Done when:** the client calls platform-api, its existing tests still pass,
and the module comment records that Ruling 27 is superseded and why.

### T3 — declare the endpoint

`FEDERATION_MARK8LY_ENDPOINTS` gains `conversions` in tesserix-k8s.

**This is a live-system precondition, not a merge step.** T1 answers 501 for
every product until it lands, so the env change must be applied BEFORE T1's
image is promoted, or the feature ships inert.

### T4 — Handoff's 100-row truncation

#246's other half. 259 leads through a 100-row cap loses the tail silently.
Separate commit; do not let it hold up T1–T3.
