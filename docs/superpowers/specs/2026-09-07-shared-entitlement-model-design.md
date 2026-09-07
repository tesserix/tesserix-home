# Shared entitlement model — design

**Issue:** tesserix-home#146
**Date:** 2026-09-07
**Status:** proposed

## Problem

The console owns the plan catalog's *prices* and nothing else. What a plan
*entitles* a tenant to — 26 features, some boolean, some capped — lives only in
mark8ly, compiled into the binary as `internal/plangate/matrix.go`'s
`map[Plan]map[Feature]int`, which "encodes spec §9 verbatim".

So the platform can publish that Pro costs $75 and has no representation at all
of what Pro *is*. #146 asks for the shared PHI-free plan / entitlement /
price-book model that HMS #247 specifies and that both SaaS-seat products need.

## What is already built, and must not be rebuilt

#146's acceptance criteria were written before #326 shipped, and building to them
literally would produce a second model beside the one in production. Verified in
`tesserix_admin` on 2026-09-07:

| #146 asks for | already exists |
|---|---|
| plan versions | `plan_catalog_revisions` (3 rows), `based_on_revision_id` ancestry |
| immutability | `plan_catalog_publications` (4 rows), one live publication per mode, `RESTRICT` on the revision FK |
| price books | `plan_catalog_prices` (126) + `plan_catalog_amounts` (234) |
| no PHI | trivially true — lookup keys, currencies, minor-unit integers |
| an internal API for products | `/api/v1/plan-catalog`, live and consumed |

**Versioning and immutability are solved.** This design adds entitlements to that
machinery rather than establishing new machinery.

## Scope

**In:** an entitlement value per `(revision, source, plan, feature)`, seeded from
plangate's matrix, published by the existing revision mechanism, and parity-checked
against what mark8ly actually enforces.

**Out, deliberately:**

- *Counting dimensions as data* (per-facility, per-user, per-bed) — HMS #251/#252/#253. Nothing exercises them and #148 is blocked on HMS#808.
- *Module dependency graph* (`requires` / `conflicts_with`) — HMS #254, same reason.
- *Multi-source.* The `source` column exists and is the seam, but its CHECK is `= 'mark8ly'` and `SINGLE_SOURCE` is hard-coded across ~10 console call sites. Widening it is real work for a consumer that does not exist.
- *mark8ly reading entitlements from the console.* The end state, and a separate decision — it puts a runtime dependency in the plan-gate hot path.

The exclusions are the point rather than a compromise. This milestone has twice
paid for machinery nothing exercised: a missing `transfer_lookup_key` survived a
green suite and broke every price change for 18 days, and #582 was closed on
2026-09-07 by declining to build a migration path against zero subscribers.

## Model

### One value, not two concepts

#146 says "entitlements, limits and price books" as three things. The only live
consumer treats the first two as one: `plangate` stores a single `int` per
`(plan, feature)` and reads it two ways —

```go
Disabled   = 0    // and the ZERO VALUE, so an unset cell fails closed
Unlimited  = -1
Negotiated = -2   // renders "contact sales"
// positive n      a cap
```

`IsAllowed()` asks whether it is non-zero; `Limit()` returns it. Modelling
entitlement and limit separately would invent a distinction the enforcement point
does not have, and every writer would then have to keep two columns agreeing.

**`Disabled = 0` being the zero value is carried into the schema as an invariant,
not an accident.** #149 states the generalisation — a billing state must never be
able to disable a safety-critical function — and a fail-closed zero is how that
is enforced rather than asserted. A fetched-nil or partially-loaded entitlement
set must not become permissive.

### Schema

```
plan_catalog_entitlements
    revision_id  uuid NOT NULL -> plan_catalog_revisions (id)
    source       text NOT NULL  -- 'mark8ly'; same closed vocabulary as prices
    plan         text NOT NULL  -- starter | studio | pro
    feature      text NOT NULL  -- the 26 known features
    value        integer NOT NULL
    PRIMARY KEY (revision_id, source, plan, feature)
```

26 features × 3 plans = **78 rows per revision** — the same count as
`plan_catalog_amounts`, which is a coincidence but a convenient sanity check.

Hanging off `revision_id` is what makes an entitlement change versioned and
published by the same machinery a price change is: draft on a revision, publish
the revision, and the entitlement moves with it. No second publication concept.

Open constraint question for review: whether `value` should CHECK
`value >= -2`. It forbids a third negative sentinel arriving silently, at the
cost of a migration when one legitimately does.

## Keeping two copies honest

The console's entitlements and mark8ly's compiled matrix are two copies of one
truth. Nothing yet forces them to agree, and a console that *displays*
entitlements nobody is gated on is worse than one that displays none.

**Parity, reusing the machinery prices already use.** Extend the existing runner
to compare console entitlements against what mark8ly enforces, so drift is a
parity failure on a surface operators already read, and the table has a live
consumer from its first commit.

```
today:  plan_catalog_amounts   <-> Stripe Price objects   (per mode + source)
added:  plan_catalog_entitlements <-> plangate matrix     (per source)
```

### The mode asymmetry, and how it is resolved

Entitlement *values* involve no Stripe account, so they look mode-independent.
They are not: **which revision is live is per-mode**, and mark8ly compiles exactly
one matrix while reading the catalog at whatever `CONSOLE_CATALOG_MODE` says
(`test` today, and it moves at the live-key swap — mark8ly#371).

Comparing the *other* mode's live revision against that matrix produces permanent
unactionable drift: a revision nobody enforces, against a matrix nobody applies to
it. An always-red signal is one nobody reads.

**Decision: parity runs only against the mode mark8ly actually reads, and
mark8ly's endpoint reports which mode that is.** The console cannot see
`CONSOLE_CATALOG_MODE`, and hard-coding `test` would go silently wrong at the
swap. A self-describing response couples nothing and cannot go stale.

`plan_catalog_parity_runs.mode` is `NOT NULL`, so entitlement runs record the real
mode they compared — no sentinel meaning "not applicable".

## Data flow

```
console  plan_catalog_entitlements (draft on a revision, published per mode)
   |
   |  parity run reads BOTH sides and compares
   v
platform-api  GET /v1/billing/entitlements        (federation; this repo)
   |
   v
mark8ly       GET /admin/billing/entitlements     (thin handler)
                 -> plangate.AllFeatures() + AllFeatureLimits(plan)
                 -> plus the catalog mode it reads
```

The chain mirrors `/v1/billing/subscriptions` and `/v1/billing/trials` exactly —
same federation, same capability gate, same failure semantics. No new transport.

mark8ly's handler is thin by construction: `AllFeatureLimits(plan) map[string]int`
and `AllFeatures()` already exist and are already the canonical accessors. The
endpoint must derive from them, never restate the matrix, or it becomes a third
copy.

## Sequencing

1. **Migration** — `plan_catalog_entitlements`, applied to production *before*
   merge (Kargo deploys on merge; `db:migrate` does not ride along — and #613's
   preflight now refuses to start a console whose ledger is behind, so a missed
   apply stalls the rollout rather than breaking the surface).
2. **Seed** — write plangate's 78 values onto a revision, so the table holds the
   truth before anything compares it.
3. **mark8ly endpoint** + **platform-api federation** — the comparison target.
4. **Parity comparison** — the console reads both sides and records a run.
5. **Authoring** — last, once values are proven to match. Editing entitlements
   before parity exists means editing something nothing checks.

Each step is verifiable alone. Steps 1–2 are inert but harmless; step 4 is where
the design starts paying.

## Testing

- Schema constraints asserted against a real Postgres, by constraint **name** — the pattern `promo-codes.integration.test.ts` and `0051` already use.
- The seed asserted against `plangate`'s actual values, not a transcription. A hand-copied expectation would pass while disagreeing with the enforcement point, which is the exact failure this design exists to detect.
- Parity's comparator unit-tested for agreement, for each direction of drift, and for a feature present on one side only.
- The fail-closed invariant given its own test: a missing or nil entitlement must read as `Disabled`, never as permitted.

## Risks

- **The seed is a transcription risk.** It must be generated from plangate's values via the endpoint, not typed. Mitigated by ordering: step 3 before a final seed, or a seed test that fails against drift.
- **A third copy.** mark8ly's endpoint must derive from `AllFeatureLimits`; anything else creates a copy that can disagree with the gate it describes.
- **Feature-list drift.** mark8ly's `allFeatures` is hand-maintained with a parity test asserting its length matches the const block. A feature added there and not here shows as parity drift — which is correct, and worth stating so it is not read as a defect.

## What would change this design

- HMS becoming imminent (HMS#808 answered) would pull counting dimensions and the module dependency graph back into scope, and both change the row shape.
- A decision to have mark8ly *read* entitlements rather than compile them would make parity a transitional step rather than the destination.
