---
id: 260904-po1
slug: tenant-pricing-override
date: 2026-09-04
issue: "#331 (console half) — counterpart tesserix/mark8ly#660"
kind: quick
---

# Per-tenant pricing overrides — the console half

`#331` was retargeted today after three of its premises were found false. This
plans what is left: the console **mints** a customer-scoped Stripe Coupon and
**records** who granted it and why; mark8ly **applies** it (#660).

## The surface question is settled, by precedent rather than preference

`#331`'s body said "surfaced on the tenant's detail view". There is no such
view — `app/(console)/platform/tenants/` holds `page.tsx` and
`tenant-directory.tsx` and no subdirectory.

But it does hold `tenant-lifecycle-controls.tsx`, whose own header reads
*"Suspending and unsuspending one tenant, **from its row in the directory**"*.
It is a dialog affordance on a directory row, with a mandatory reason, its
write behind `./actions.ts` in a `server-only` lib module, and the action
disabled for an unknown product.

That is #331's shape exactly. **Build the override control the same way, on the
same surface.** No new view, and no argument about where it belongs — the
estate already answered for the identically-shaped operation.

## THE SEQUENCING CONSTRAINT — this cannot ship alone

The console can mint and cannot attach. A minted-but-unattached coupon is
**worse than nothing**: an operator sees "20% off granted", the tenant is
charged full price, and the audit log says the discount exists.

So the console half is not independently shippable. Options, in preference
order:

1. **Agree #660's contract first**, build both halves against it, land mark8ly
   first. Preferred — it is one round-trip of agreement, not a dependency.
2. Build the console half behind a flag that hides the affordance until #660
   ships. Acceptable, but a flag guarding a half-built write is a thing people
   forget to remove.
3. Build console-first and let it fail at the attach step. **Rejected** — it
   makes the dangerous state reachable in production.

**Do not start T3 until #660's request/response shape is agreed.** T1 and T2
do not depend on it.

## The failure surface, which is the real design work

Three steps, two gaps:

```
createCoupon (Stripe)  ->  record + audit (console DB)  ->  attach (mark8ly #660)
                       ^                               ^
                     gap A                           gap B
```

**Gap A is already solved and must be copied, not re-derived.** `#521`'s
`promo-actions.ts` hit exactly this: a failure between `createCoupon` and
`recordStripeCoupon` leaves a live coupon in a Stripe account the database does
not name. Its answer is `MINT_INCOMPLETE_MESSAGE`, which *never claims nothing
happened* — it says where to look. Read that file before writing this one.

**Gap B is new.** The audit record is written before the attach, deliberately
(`#331`: "so a failure to apply still leaves the decision recorded"). That means
a failed attach produces a recorded decision that is not in force. The operator
message must say so plainly — "recorded, not applied" — and must not read as
either success or as nothing-happened.

`auditedOperation` (`lib/db/audit-repo.ts:441`) already gives the ordering
guarantees: `AuditUnavailableError` before the operation, refusal written on
throw, `AuditSummaryError` if `describe` is buggy, and the result discarded
either way. Use it; do not hand-roll the ordering.

## Tasks

### T1 — the write seam (`lib/tenant-pricing-override-write.ts`)

`server-only`, mirroring `lib/tenant-lifecycle-write.ts`. Owns the session, the
capability check, the Stripe mint via `createCoupon`
(`lib/billing/mark8ly/stripe-write.ts`), the audit record, and the error
mapping. Exports a result type the client control can render without knowing
any of it.

**Refuse on a read before calling Stripe**, the way `mintCouponAction` does, so
a second override on a tenant that already has one does not mint a second real
coupon and then fail. The authoritative at-most-one check lives in mark8ly
(#660) because only it can see the customer's existing discounts — this read is
the cheap half that stops the common case.

**Decide and record:** `CreateCouponSpec.discount` is typed `PromoCodeDiscount`,
named for #521. Either reuse it or introduce a shared discount-terms type. Do
not silently widen `PromoCodeDiscount` to mean two things. Note also that
`CreateCouponSpec.maxRedemptions` is Stripe's cap on the Coupon and is
deliberately unwired from `promo_codes.max_redemptions`; a per-tenant override
almost certainly wants neither.

### T2 — the row control (`tenant-pricing-override-controls.tsx`)

A dialog on the directory row, modelled on `tenant-lifecycle-controls.tsx`.

- **Mandatory reason.** #331 says free text. Lifecycle carries BOTH a reason
  *code* and free text — decide whether an override wants codes too, and say
  why. Free text alone is defensible; silently dropping the code because
  lifecycle's catalog does not have one for this is not.
- **Duration chosen explicitly** — `once` / `repeating` / `forever`, never
  defaulted. `repeating` requires months.
- Everything exported besides the component should be a pure function, so the
  properties worth defending are testable without driving a dialog — the reason
  lifecycle's file gives for the same split.

### T3 — attach, via #660 — **DO NOT START BEFORE ITS CONTRACT IS AGREED**

Call mark8ly's attach endpoint with the tenant and the `co_...`, after the audit
record lands. Map its failure to the "recorded, not applied" message from Gap B.

### T4 — removal

`#331`: "Removal is as audited as application." Same seam, same dialog shape,
same mandatory reason. Detach is #660's counterpart operation.

## Out of scope, stated so it is not smuggled in

- **A console tenant detail view.** Settled above.
- **Cross-tenant subscription reconciliation.** Once overrides exist, "what does
  this tenant pay us" stops being derivable from plan alone, and anything
  rendering amounts — including mark8ly#284's cross-tenant list — will show list
  price for a discounted tenant. #331 flags it; #660 notes the projection may be
  the better place to fix it. **Not this plan.**
- Anything touching a Stripe customer. That is #660's, entirely.

## Global constraints

- **Comment accuracy.** This estate's documented recurring defect, and this
  session produced eleven instances of it. Run the command before writing the
  sentence that describes it; count anything you assert a count about.
- Server/client boundary: the row control is a client component and the write
  seam opens with `import "server-only"` — importing the seam from the control
  is a build error by design. Keep it that way.
- Do not weaken an existing assertion. Do not touch `apps/web`.
- **pnpm, not npm.** Rebuild `@tesserix/console-core` before running console tests.
