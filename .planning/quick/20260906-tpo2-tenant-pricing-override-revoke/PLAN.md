---
id: 20260906-tpo2
slug: tenant-pricing-override-revoke
date: 2026-09-06
issue: "#581 — the removal half of #331 (T4 of `260904-po1-tenant-pricing-override`)"
kind: quick
---

# Revoking a tenant pricing override — the console's two thirds of it

`#581`: `grantTenantPricingOverride` is the only writer. `removed_by` and
`removed_at` are declared, selected and mapped, and set by nothing outside
integration tests. A granted override is therefore permanent — and because
`0047`'s partial unique index counts a row with `removed_at IS NULL` as live, a
**corrected** override cannot be granted either. One mis-keyed discount is both
uncorrectable and blocking, and the operator's only route is SQL against
production.

This is `260904-po1`'s **T4**, which that plan named and left unbuilt.

## The finding that shapes the whole change

`#581` asks the revoke path to "detach the coupon in Stripe". **Deleting a
Stripe Coupon does not do that.** From Stripe's API reference for
`DELETE /v1/coupons/:id`:

> deleting a coupon does not affect any customers who have already applied the
> coupon; it means that new customers can't redeem the coupon

Removing a discount that is already applied is `DELETE
/v1/customers/:id/discount` — a **customer-scoped** call. The console cannot
make it: it has no Stripe customer id and no customer scope on its key, which
is the finding that retargeted `#331` onto option B in the first place.

So "revoke" is three operations with two owners:

| step | effect | owner |
|---|---|---|
| Retire the console's row (`removed_by`/`removed_at`) | frees `0047`'s index, so a correction can be granted | **console — this plan** |
| Delete the Coupon in Stripe | it can never be attached to anyone again | **console — this plan** |
| Detach the discount from the customer, if attached | the tenant stops being charged less | mark8ly (`#660`'s counterpart), unbuilt |

`#581`'s point 2 — "decide the Stripe-side semantics deliberately: detaching
mid-period has different proration behaviour from letting it lapse" — is a real
decision and it is **not this repo's to make**, because only mark8ly can issue
the call it is about. Recorded here so the next reader does not go looking for
it in console code.

**What this plan therefore delivers is honest, not complete**, and the copy has
to say so in the register `overrideMintedMessage` already set: state what now
exists, state what is not in effect, and name what is still owed. A revoke that
reports "the discount is removed" would be the same class of untrue statement
that function exists to avoid.

Today the gap is empty rather than merely small: the attach half (T3) does not
exist, so no coupon this console minted can have been attached by it, and a
revoke here is complete in fact. The copy must still not depend on that — T3 is
what makes it stop being true, and nothing fails when it lands.

## Ordering, and which residue we choose

The two console steps can each fail. The order decides which wreckage an
operator is left holding.

- **Delete in Stripe, then retire the row.** A failure between leaves the row
  live and naming a deleted coupon. The index still blocks the correction — so
  the failure preserves *exactly the condition this issue exists to remove*.
- **Retire the row, then delete in Stripe.** A failure between leaves a live
  Coupon in Stripe named by a retired row. The correction is unblocked; the
  residue is one unattached coupon, and the row still names it so the message
  can too.

**Retire first.** It is the ordering whose failure mode is recoverable and
nameable, and `MINT_INCOMPLETE` in `tenant-pricing-override-write.ts` is the
precedent for how to report it — never claim nothing happened, send the
operator somewhere specific rather than invite a blind retry.

## Tasks

Each is one atomic commit. Tests first.

### T1 — `deleteCoupon` on the Stripe writer

`lib/billing/mark8ly/stripe-write.ts`. An eighth method on a surface whose
header argues at length for staying at seven, so the header changes too and
says why this one is admitted: it is the inverse of `createCoupon`, on the same
object, and the alternative is an operator deleting by hand in a dashboard.

- No idempotency key. Stripe accepts one on POST only; `del` is a DELETE.
  Every other method here takes one, so the omission needs its comment or it
  reads as forgotten.
- **An already-deleted coupon is success, not failure.** Stripe raises on it;
  the goal state — this coupon can never be redeemed — holds either way, and
  reporting failure would strand a retired row behind a step that can never
  pass. Catch on Stripe's `resource_missing` code specifically, not on any
  error, and not on message text.
- Return `{ id }` like everything else on the surface. Never the raw object.

### T2 — `retireTenantOverrideCoupon` in the repo

`lib/db/tenant-pricing-overrides-repo.ts`.

- `UPDATE … SET removed_by = $, removed_at = now() WHERE tenant_id = $ AND
  mode = $ AND removed_at IS NULL RETURNING …`. **The `removed_at IS NULL` in
  the WHERE is what makes it safe under a concurrent second revoke** — the
  loser updates zero rows and gets null back, rather than overwriting the first
  retirement's operator and timestamp. Same argument `readLiveTenantOverrideCoupon`
  makes for matching the index's predicate exactly.
- Returns the retired row, or `null` if there was no live one. Null is an
  answer, not an error — the seam maps it.
- The comment on `removedBy` at `:49` currently reads *"Set by #331's T4, never
  by the grant path"*. T4 is this. Rewrite it to name the function.

### T3 — `revokeTenantPricingOverride` in the write seam

`lib/tenant-pricing-override-write.ts`, beside the grant.

- Same capability pair as the grant, `billing` **and** `publish-catalog`, and
  for the grant's stated reason: this deletes a real object in a real Stripe
  account. Checked **inside** `auditedOperation`, so a refusal is a
  `capability.refused` row.
- Mandatory free-text reason, validated before anything is touched — `#331`:
  *"Removal is as audited as application."* It goes where the grant's reason
  goes, which today is **nowhere**: the grant already takes a `reason` destined
  for a T3 that does not exist, and the revoke's destination is that same
  federated call's counterpart. Take it, validate it, do not store it, and say
  so in the same words `TenantPricingOverrideInput.reason` uses. Inventing a
  console-side home for it now would contradict `0047`'s header on the way to
  making the two halves asymmetric.
- Read the live row first. No live override is a refusal with its own message,
  not a thrown error.
- Then: retire the row, then `deleteCoupon`. A `deleteCoupon` failure after a
  successful retirement returns a distinct result that names the coupon id and
  says the correction is now grantable — the recoverable state, reported as
  such.
- Audit action `billing.tenant.override.retire`. Not `.revoke`: the console's
  own act is retiring its record and deleting its object, and the discount's
  removal is mark8ly's row to write. `.mint` is the sibling and it is named for
  the same reason.

### T4 — the revoke affordance on the control

`app/(console)/platform/tenants/tenant-pricing-override-controls.tsx` and
`actions.ts`.

- A second dialog on the same control, modelled on the grant's: mandatory
  reason, an explicit `consequence` line, a `*_NOT_CONFIRMED` message for a
  rejected call.
- **The copy states all three facts.** What was retired and deleted; that a
  correction can now be granted; and that if mark8ly had attached this coupon,
  detaching it is mark8ly's step and has not happened. Exported as one directly
  tested function, `overrideRetiredMessage`, for the reason
  `overrideMintedMessage` is: the sentence that goes stale should go stale
  against a failing test.
- Assert the ABSENCE of "removed", "cancelled", "no longer discounted" and
  "refunded", the way the mint message's test asserts the absence of "granted"
  and "applied". The failure to guard against is a friendlier rewrite that
  means something untrue.
- Everything exported besides the component stays a pure function.

### T5 — the comments this change makes false

Run the greps; do not trust this list to be complete.

- `tenant-pricing-overrides-repo.ts:49` — "Set by #331's T4" (T2 covers it).
- `alreadyGranted` in the write seam — *"to change the terms, remove the
  override and grant a new one"* describes an operation that did not exist when
  it was written. It exists after T3; check the sentence is still accurate
  rather than accidentally right.
- The control's header and `260904-po1`'s T4 entry.

## Out of scope, stated so it is not smuggled in

- **Mounting the control.** `#581`'s point 3 is *"only then mount"*, and the
  "then" has not arrived: T3 of `260904-po1` — the attach — is still unbuilt,
  and mounting a control that mints a coupon nothing can attach is the option
  that plan explicitly rejects. Revoke ships to the same standard as grant:
  built, tested, unreachable.
- **Atomic replace** (`#581`'s point 4). With T3 landed, revoke-then-grant is
  two operator steps and the index no longer blocks the second, which is the
  whole complaint. An atomic replace would have to mint before retiring to
  avoid a gap in cover, and that ordering puts two live coupons against a
  uniqueness index that exists to forbid exactly that. It is a real question,
  and it needs the attach half to exist before it can be answered — until then
  "replace" cannot be defined, because nothing is applied to replace.
- **Anything customer-scoped in Stripe.** `#660`'s, entirely. See the table.

## Global constraints

- **Comment accuracy.** This estate's documented recurring defect. Run the
  command before writing the sentence that describes it; count anything you
  assert a count about. Do not describe a rule more broadly than the code
  implements it.
- `server-only` boundary: the control is a client component, the seam opens
  with `import "server-only"`, and importing one from the other is a build
  error by design. Keep it.
- Do not weaken an existing assertion. Do not touch `apps/web`.
- **pnpm, not npm**, and run from this worktree — `pnpm --filter` from the
  primary checkout verifies the primary checkout, not this one.
