# The console as the plan catalog's authoring surface

**Status:** design, for review
**Date:** 2026-08-27
**Issues:** tesserix-home#326 (P1a, landed), #327 (P2, gated), §P of `BACKLOG.md`
**Supersedes nothing.** Extends the read-only catalog delivered by #371/#372/#373/#377/#378.

## Purpose

Make the console the place a mark8ly price is changed, so that changing one does
not mean opening the Stripe Dashboard, and so that the catalog stops being
maintained in places that can quietly disagree.

Designed as the **reference pattern** other products follow. What generalises
and what does not is stated in §9, deliberately, because the parts that do not
generalise are the parts most likely to be copied wrongly.

## Non-goals

- Promo codes and global discounts (§P P4). Separate Stripe objects, own
  lifecycle.
- Per-tenant overrides (§P P5).
- Kora's catalog. Kora is mid-migration — Cashfree is being removed
  (kora#479) and StoreKit IAP becomes the rail before public launch
  (kora#487), which puts part of its catalog in App Store Connect rather than
  Stripe. Designing for it now means guessing. See §9.
- Changing what an existing subscription is billed. See §6.

## 1. Established facts

Everything here was verified against the running system on 2026-08-27, not
taken from documentation.

**1.1 Stripe Prices are mostly immutable.** `PriceUpdateParams` accepts exactly:

```
active  currency_options  lookup_key  metadata  nickname  tax_behavior  transfer_lookup_key
```

`unit_amount`, `currency`, `recurring` and `product` cannot be changed. Altering
a headline amount therefore means **creating a new Price and archiving the old
one**, moving the `lookup_key` across with `transfer_lookup_key: true`.

**1.2 The baseline currency is always `usd`.** `catalog.go` builds each
`developed` descriptor with `Currency: "usd"` and carries the other six in
`Options`, which become Stripe `currency_options`. Each `ppp` descriptor is its
own Price whose baseline is that PPP currency.

**1.3 The consequence, which shapes the whole surface.** Of the catalog's 78
amounts:

| cell | count | Stripe operation |
|---|---|---|
| developed, non-`usd` | 36 | **update in place** (`currency_options`) |
| developed, `usd` | 6 | create + transfer + archive |
| ppp (own Price) | 36 | create + transfer + archive |

**42 of 78 edits replace a Price object. 36 do not.** An operator must be able
to see which before confirming.

**1.4 The catalog matches Stripe today.** 42 lookup keys, 78 amounts, **0
differences** in test mode. Intervals are correct on all 42, products are
exactly three and correctly mapped.

**1.5 Live mode has never been bootstrapped** — 0 prices, 0 products, 0
subscriptions. Both mark8ly billing secrets hold `sk_test_` keys despite
`prod-` prefixes.

**1.6 `billing-bootstrap` is mode-agnostic**: it takes a key by flag or
environment and reads `pricing.AllDescriptors()`. Live is a key swap and one
idempotent CLI run.

## 2. Authority: a versioned catalog

The console's tables become the source of truth; Stripe holds a projection that
publishing keeps in step and the parity check verifies. This is what §P's P3a
already assumes — `marketplace-api` reads the catalog from the console.

Add `plan_catalog_revisions`:

| column | note |
|---|---|
| `id` | |
| `status` | `draft` \| `published` \| `superseded` |
| `created_by`, `created_at` | operator identity, for the audit trail |
| `published_at`, `published_by` | null until published |
| `note` | why this change was made — free text, required on publish |

`plan_catalog_prices` and `plan_catalog_amounts` gain `revision_id`. Partial
unique indexes enforce **exactly one `published`** and **at most one `draft`**.

Three things fall out of this that are otherwise separate work: editing never
touches what Stripe reflects; the audit trail exists without being built; and
the parity check gets an unambiguous answer to *"compare against what?"* — the
published revision. At 78 rows, a full snapshot per revision is free.

**A manual Stripe Dashboard edit is drift, not a new truth.** The parity check
reports it and the fix is to re-publish or to correct the catalog. That is the
point of choosing an authority.

## 3. Draft, then publish

Editing mutates the draft revision only. Publishing is a separate, confirmed
action.

### 3.1 The publish plan is the product

Before anything reaches Stripe the console computes a typed plan — one entry per
operation, derived from the diff between draft and published revisions and
classified by §1.3:

- `update_currency_option` — in place
- `replace_price` — create new, `transfer_lookup_key: true`, archive old
- `update_tax_behavior` — in place
- `create_price` — a plan or currency Stripe does not have
- `archive_price` — removed from the catalog

The screen leads with counts (*"3 updated in place, 2 replaced, 1 archived"*)
and lists the detail. **A summary that said only "6 prices changed" would hide
the distinction that matters**: replacement retires a Price object and mints a
new one.

### 3.2 Publishing is not atomic, so it is resumable

Stripe has no transactions across calls. A publish that fails halfway must leave
a state that is **visible and resumable**, never unknown.

- Every planned operation is persisted before execution, with its outcome.
- Operations execute in a deterministic order — creates before archives, so a
  `lookup_key` is never unclaimed between calls.
- Each carries a Stripe idempotency key derived from `(revision_id, operation
  id)`, so a retry cannot double-create.
- A partially applied publish is re-runnable and completes the remainder.

### 3.3 Verification is the parity check

After publishing, the catalog and Stripe should agree, and the existing check
says so independently on its next run — or immediately via the
operator-triggered route.

This is worth stating plainly because it is the strongest property in the
design: **the mechanism built to make P1a's window trustworthy is exactly what
proves a publish did what its diff promised.** The check is not part of the
write path and cannot be fooled by it.

## 4. The write client

`lib/billing/stripe-write.ts`, exposing exactly `createPrice`, `updatePrice`,
`archivePrice`. `server-only`. Separate module, separate credential
(`STRIPE_WRITE_KEY_TEST` / `_LIVE`), separate Stripe instance.

**The parity check keeps using the read-only client and the read-only key.** If
the check could write, the argument that made its window trustworthy collapses —
and #327 revokes mark8ly's write key on the strength of that window. Two
credentials, two modules, no shared instance, and a guard test asserting the
read client still exposes no write method.

## 5. Modes

Everything is per mode, as the parity check already is. A draft is published to
one mode at a time, and the plan states which. Publishing to `test` and to
`live` are separate acts with separate confirmations.

**Live must be bootstrapped before it can be published to.** Until then the
catalog surface shows `not_bootstrapped` for live and publishing to it is
refused with that reason, rather than attempting 42 creates through a surface
designed for edits.

## 6. What does not change

**Existing subscriptions keep their original Price.** Archiving a Price does not
reprice anyone already on it; Stripe holds the subscription's price reference.
So an edit never silently changes what a live customer pays.

This is a genuine safety property and the surface should say so, because the
opposite is the thing an operator will fear. Migrating existing subscribers to a
new price is a different operation, deliberately not in this design.

## 7. Safety properties, in order of importance

1. The parity check cannot write — different key, different module.
2. Publishing is confirmed against a plan that names Stripe's real operations.
3. A partial publish is visible and resumable, never unknown.
4. Idempotency keys make retries safe.
5. Every revision records who and why.
6. Live and test are separate acts.
7. Existing subscriptions are untouched by construction.

## 8. Testing

- The plan builder, as a pure function: every cell class in §1.3 produces the
  right operation. This is where a mistake is cheapest to catch and most costly
  to miss.
- Resumability: a plan half-executed, then re-run, completes exactly the
  remainder and repeats nothing.
- Idempotency keys are stable across retries and distinct across operations.
- Publishing to live while `not_bootstrapped` is refused.
- The read client still has no write methods (existing guard, extended).
- Integration: publish a draft against Stripe **test mode**, then run the parity
  check and assert `clean`. This is the end-to-end proof and it costs nothing —
  test mode is where the catalog already lives.

## 9. What generalises, and what does not

**Generic — the pattern other products follow:**

- a versioned catalog with one published revision
- draft → typed plan → confirmed publish
- persisted, resumable, idempotent execution
- an independent parity check as verification
- a gateway adapter behind a narrow interface

**Not generic, and dangerous to copy:**

- *what a price is*. mark8ly's is a Stripe Price with `currency_options` and PPP
  siblings. Kora's is a credit pack in integer paise with 18% GST computed in
  code, a 2% platform fee, 30-day validity and a quota grant — and after
  kora#487 part of it lives in **App Store Connect**, where Apple owns the price
  tiers and takes 15–30%.
- *which gateway*, and how many. mark8ly has one. Kora is heading for three
  storefronts (Stripe, StoreKit, Play Billing).
- Stripe's immutability rules (§1.1). They are Stripe's, not a general truth,
  and the create-and-replace dance exists only because of them.

**The recommendation this leads to:** build this for mark8ly, land it, and only
then generalise against Kora as a real second case. An abstraction designed
against one working example is designed wrong — the argument contract §8.8 and
§8.9 both made when deferring their own generalisations.

**A cross-storefront problem worth naming now**: if Kora's price ends up
expressed in Stripe *and* App Store Connect *and* Play Console, that is three
hand-maintained copies of one catalog — the exact problem #326 exists to
eliminate, rebuilt somewhere new. A parity check across storefronts is the same
idea and is cheaper to design before the copies exist.

## 10. Open questions

1. **Who may publish?** The `billing` capability gates the surface today. Is
   publishing the same capability, or a narrower one? Not answered here.
2. **Rollback.** Revisions make "publish the previous revision" expressible, but
   it is not a true undo: a replaced Price is archived, and republishing mints
   another new one rather than restoring the old. Worth deciding whether to
   offer it at all rather than implying an undo that does not exist.
3. **Does `marketplace-api` read the catalog before or after this ships?** §P's
   P3a is a separate issue and the ordering affects whether a bad publish can
   reach checkout.
