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

## The failure surface — REVISED after settling #660's contract

The plan first written here had the console audit before asking mark8ly to
attach, giving three steps and two gaps. **Settling the contract removed one of
them, and reversed who owns the audit row.**

`lib/tenant-lifecycle-write.ts` states the estate's position on federated
writes, on the console's first one:

> *"the audit row for this change is written by the PRODUCT, inside its own
> transaction, bound to the state change it describes … Adding a console-side
> audit row here would put a second, less trustworthy account of the same event
> in a different database — and the two would disagree the first time a write
> half-succeeded."*

So mark8ly writes it, in the attach transaction, from an operator + reason the
console passes through — exactly as lifecycle already passes `reasonCode` and
`reason`. That is stronger than #331's original framing, not weaker: the record
and the effect cannot disagree.

What is left:

```
createCoupon (Stripe)  ->  record the co_... (console)  ->  attach + audit (mark8ly #660)
                       ^
                     one gap
```

**The remaining gap is #521's, already solved.** A failure between
`createCoupon` and recording it leaves a live coupon in a Stripe account this
database does not name. `promo-actions.ts` answers it with
`MINT_INCOMPLETE_MESSAGE`, which never claims nothing happened — it says where
to look. Read that file before writing this one; do not re-derive it.

The failure the console reports for a failed attach is **"minted, not applied"**
— recoverable, and honestly distinct from both success and nothing-happened.
There is no longer a "recorded but not in force" state to describe.

`auditedOperation` (`lib/db/audit-repo.ts:441`) still applies to the console's
own mint record, for its ordering guarantees. It does not apply to the attach,
which this service does not audit.

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

### T3 — attach, via #660 — contract now SETTLED, see the issue

Call through `platformRequestWithMeta`, the way `tenant-lifecycle-write.ts`
does — the console does not call mark8ly directly. The contract endpoint id is
proposed as `billing/tenant-discount` (a v3→v4 amendment; the vocabulary is
closed and `declaration.ts` throws on an unknown key).

Send operator, tenant, coupon id, duration and reason. **Do not write a
console-side audit row for the attach** — mark8ly writes it in the same
transaction. Map a failure to "minted, not applied".

**T3 also finishes T2, and these two steps are the ones nothing else forces.**
T2 built `tenant-pricing-override-controls.tsx` and deliberately left it
unmounted, because a mounted control mints a real Stripe coupon that nothing
attaches — the option this plan rejects above — and because `0047` is applied
by hand. Nothing fails if T3 forgets them: the tests pass, the export is
consumed by its test file, and the directory carries only a comment. So they
are steps here:

1. **Mount `TenantPricingOverrideAction` in `tenant-directory.tsx`**, beside
   `TenantLifecycleAction`, and delete the pointer comment there. #331 closes
   with no reachable UI otherwise.
2. **Rewrite `overrideMintedMessage`.** Its third sentence — "Attaching it to
   their subscription is a separate step this console cannot do yet" — is true
   only until the attach lands, and its second says the tenant is still being
   charged list price. Both become false claims the moment T3 works. The tests
   in `tenant-pricing-override-controls.test.tsx` pin TODAY's wording, so they
   go red on the rewrite rather than before it: they are what makes the change
   deliberate, not what reminds you to make it. This list is that reminder.

Also consider moving the source check into the seam. The control disables its
button for a tenant no catalog source owns, and says in its own comment that
this is the affordance and not the rule — `grantTenantPricingOverride` would
mint for any tenant id. #660 will refuse a non-mark8ly tenant anyway, so
without the check the console mints first and learns second.

Blocked on #660 shipping the endpoint and the contract amendment landing. T1
and T2 are not.

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
