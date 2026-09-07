---
id: 260907-gf1
slug: grandfathering-stated
date: 2026-09-07
issue: 582
kind: quick
branch: feat/grandfathering-stated-582
---

# Grandfathering becomes a decision instead of a side effect (#582)

Publishing a price change creates the Stripe Price, updates the catalog, serves
the new amount on `/api/v1/plan-catalog`, and turns parity green. Every existing
subscriber goes on paying the old amount forever.

That is defensible — grandfathering is ordinary pricing policy. What is not
defensible is that it is currently **the shape of missing code rather than a
stated decision**, and those are indistinguishable from outside right up until
somebody wants a price rise to actually apply.

**Decision taken 2026-09-07: grandfather, deliberately.** This records it and
closes the misleading signal. It does NOT build a migration path.

## Why grandfathering rather than migrating — measured, not assumed

- **There are zero subscribers.** `store_subscriptions` is empty and 0 rows
  carry a `stripe_subscription_id` (mark8ly production, checked 2026-09-07).
  There is nobody to grandfather and nobody to migrate.
- **Production is deliberately on the Stripe TEST key** (mark8ly#371, decided
  2026-09-05, gated on open correctness work). Real subscribers cannot exist yet.
- **A migration path would be unexercised writer code against 0 rows.** This
  milestone has already been burned by exactly that — #521's plan says so in as
  many words, and an 18-day-broken publish path is the receipt.
- **It is blocked anyway.** Several jurisdictions require advance notice of a
  subscription price rise, and mark8ly sends no billing lifecycle emails at all
  (mark8ly#703). Migration cannot be lawful before that lands.

Migrating is the right conversation to have when there are subscribers AND
mark8ly#703 has landed. Not before, and this plan does not pre-empt it.

## What is actually wrong today

1. **The catalog UI describes a gap, not a policy.** `SUBSCRIBER_SAFETY_NOTE`
   (`draft-editor.tsx`) ends "until something migrates them deliberately (out of
   scope here)". That reads as *not built yet*. After this decision it is the
   intended behaviour and should read that way.
2. **The published contract says nothing.** `/api/v1/plan-catalog` serves an
   amount with no statement of which subscriptions it governs. A consumer
   reasonably reads "the price of this plan" as "what everyone on this plan
   pays". It is not.
3. **Parity's green is read as more than it means.** `readWindowStatus` reports
   "7/7 days clean, both pairs" and nothing anywhere states the boundary. Parity
   compares the CATALOG against Stripe PRICE OBJECTS. It never looks at a
   subscription. So it is fully green in exactly the situation this issue
   describes, and an operator has no way to know that from the surface.

## Decisions, settled — do not re-open these

1. **State the boundary; do not weaken the signal.** Parity is not wrong and
   must not start reporting a gap it was never asked about — #579 owns its
   scope. What is missing is a sentence saying what "clean" does and does not
   cover. Adding a false amber would be worse than the silence.
2. **No subscriber price-distribution view in this change.** With zero
   subscribers it would read `0` forever, and a metric that reads zero for the
   wrong reason is indistinguishable from one reading zero for the right one —
   the failure [[an-absent-metric-never-fires]] describes. It also cannot be
   built honestly yet: a discounted subscriber legitimately pays less than the
   catalog amount, and #593 has just made scoped promo codes real, so a naive
   amount-vs-catalog comparison would flag every redemption as drift. Build it
   when there are subscribers, discount-aware, and able to say "there are none"
   distinctly from "none have drifted".
3. **Contract wording is additive prose, not a new field.** No consumer needs a
   flag; they need the existing number's meaning stated. A field would invite a
   branch nobody can implement against.

## THE LESSON THIS TASK EXISTS UNDER

Every signal this system produces reports success while revenue does not move.
Nothing is broken — parity is correct, the publish path is correct, the catalog
is correct. They simply answer a narrower question than the one an operator
reads them as answering.

So the deliverable is not code. It is **making three surfaces state their own
boundary**, and the test of success is whether someone who has never read #582
can tell, from the console alone, that publishing a price does not move anybody
onto it.

## Tasks

- **T1 — the catalog UI states policy.** Rewrite `SUBSCRIBER_SAFETY_NOTE` so it
  reads as intended behaviour rather than an unbuilt feature, without losing what
  it already gets right. Its surrounding comment explains why it renders once at
  surface level; keep that.
- **T2 — the contract states which subscriptions the amount governs.**
  `/api/v1/plan-catalog`'s module doc, in the voice of its existing sections.
- **T3 — parity states its boundary.** One sentence where an operator reads the
  verdict, and the reasoning in `parity.ts` / `parity-run.ts`. Cross-reference
  #579 rather than restating its scope.
- **T4 — record the decision on #582** with the measurements above, and note what
  would reopen it (subscribers existing, or mark8ly#703 landing).

## Done means

- [ ] The console says grandfathering is the policy, not a missing feature
- [ ] `/api/v1/plan-catalog` states that its amount governs new subscriptions
- [ ] The parity surface states that "clean" does not mean subscribers are on the
      catalog price
- [ ] No new metric that would read zero for the wrong reason
- [ ] #582 carries the decision, the evidence, and its reopening conditions
