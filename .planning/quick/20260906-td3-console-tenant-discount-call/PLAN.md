# The console applies the discount it mints

PR 3 of 3 for #331. The console mints a Stripe Coupon and records it; mark8ly
attaches it to the tenant's subscriptions; platform-api carries the signed call
between them. **The first two shipped and are deployed.** This connects them,
mounts the controls, and corrects the copy that says the connection does not
exist.

- PR 1 — mark8ly#766/#767/#772. Deployed, verified, **#660 closed**.
- PR 2 — tesserix-home#605. Deployed as `main-b8b3be9`, 2/2 ready.
- **PR 3 — this.** Closes #331.

## The contract, read from the shipped code

```
POST /v1/billing/tenants/{<source>:<id>}/discount
POST /v1/billing/tenants/{<source>:<id>}/discount/remove
```

- **Pass the tenant id WHOLE.** platform-api splits on the first colon
  (`service/discount.go:54`). The console must not split — `tenants.ts`'s
  `splitTenantId` is for the `mintsFor` affordance only.
- Body `{coupon_id, reason}`, both required and non-blank on both verbs.
- `Idempotency-Key` mandatory, refused rather than generated.
- 200 `{success, data, meta}`; `data` carries `status`
  (`ok`/`partial`/`failed`/`unknown`), `requires_reconciliation` (always
  present), and `stores[]` with nine outcome values plus `unknown`.
- 400 for a refusal naming the product's code, 503 for unreachable, 403 for a
  missing capability. No 404, no 409.
- Gated on `billing` + `publish-catalog` — exactly what the console's seams
  already check, so **no capability change here**.

## Decision 1 — ordering: retire → detach → delete

The revoke seam today is **retire the row, then delete the coupon**, and its
comment (`:586-594`) gives the rule: pick the order whose residue is
*recoverable and nameable*. It also puts the delete **outside**
`auditedOperation` (`:651-661`) so a Stripe failure cannot throw past the audit
write and destroy the record of a retirement that genuinely happened.

**Neither comment covers a third step, because there was no third step when they
were written.** This plan decides it:

```
retire the row  →  ask mark8ly to detach  →  delete the coupon
```

Detach **before** delete, for the file's own stated reason. A failed detach
leaves an applied discount named by a retired row and by the returned result —
nameable, and the operator knows exactly what to chase. Deleting first and then
failing to detach leaves a live discount whose coupon object no longer exists,
which is strictly harder to reason about at the Stripe end.

Both new steps sit **outside** `auditedOperation`, for the reason already
written there.

On the grant side the order is unchanged and the attach appends:
`mint → record → attach`, the attach outside `auditedOperation`.

## Decision 2 — a DETERMINISTIC idempotency key, not `randomUUID()`

`tenant-lifecycle-write.ts:110` mints `randomUUID()` per call, and two other
seams copy it. **Do not copy it here.** This module already argues the opposite
at length (`:301-335`): a fresh key on every retry is the same as having no key,
and `mintKey` is deterministic on purpose. platform-api says the same
(`handler.go:163-167`), and mark8ly scopes the stored key
`tenant_discount:<op>:<tenant>:<key>`.

A stable identity exists: the recorded coupon id is unique per grant.

```
tenant-override-attach:v1:<tenantId>:<mode>:<couponId>
tenant-override-detach:v1:<tenantId>:<mode>:<couponId>
```

Version-prefixed, per `MINT_KEY_VERSION`'s reasoning. Separate prefixes because
mark8ly scopes by operation and a shared key across apply and remove is the bug
mark8ly#772's test pins.

**Say in a comment why this diverges from the lifecycle idiom**, or the next
reader will "make it consistent".

## Decision 3 — report `partial` honestly

`PricingOverrideWriteResult` is `{ok, couponId}` and cannot express a fan-out.
Widen it the way the revoke result was widened for `couponDeleted`.

The operator must be able to tell apart:

- every store applied;
- **some** stores applied (`status: "partial"`), which stores, and why the
  others did not;
- nothing applied;
- **minted but not applied** — the coupon exists and no store carries it.

`requires_reconciliation` is its own fact and must survive to the UI: it means
Stripe moved and mark8ly could not record it, and it is not the same as a
failure.

Do **not** invent a per-store table component. The smallest honest rendering is
a sentence naming the counts plus a list of the stores that did not get it,
with `failure_reason` — which is mark8ly's fixed vocabulary, not driver text.

## Tasks

Each is one atomic commit. Tests first.

### T1 — the platform-api call

New `lib/tenant-discount-write.ts` (`server-only`), modelled on
`tenant-lifecycle-write.ts`: `platformRequestWithMeta`, read `.data`, narrow
every field defensively, map `PlatformApiError` by `.status` (400/403/503), and
recover the API's own sentence via the `apiMessage()` idiom.

**Handle an unset `PLATFORM_API_ORIGIN` explicitly.** `platformCall` throws a
`PlatformApiError` with **no status** (`platform-api.ts:225-226`), which falls
to `default` and would report a pure misconfiguration as an ambiguous failure.

**Write no console audit row** — the product owns the audit row for a federated
write (`tenant-lifecycle-write.ts:13-31`).

### T2 — wire the grant

`grantTenantPricingOverride`: after the row is recorded and outside
`auditedOperation`, attach. Widen the result per Decision 3. A failed attach is
**not** a failed grant — the coupon exists and is recorded; say so, in
`MINT_INCOMPLETE`'s register, and never claim nothing happened.

### T3 — wire the revoke

`revokeTenantPricingOverride`: retire → detach → delete, per Decision 1.
`couponDeleted` stays; add the detach outcome beside it. A failed detach means
the tenant **is still discounted** — the copy must say that plainly.

### T4 — the copy, and the tests that pin it

Every string and comment that says attach is impossible. Recon enumerated them;
**re-run the greps rather than trusting the list**:

- `overrideMintedMessage` third sentence (`:150`)
- `overrideRetiredMessage` closing sentence (`:215`)
- `consequence()` (`:257`) and `revokeConsequence()` (`:271`) — **no test pins
  these two, so they change silently. Add tests.**
- the module header (`:48-98`), including the whole
  `THIS CONTROL IS NOT MOUNTED` section
- `actions.ts:62-66` and `:86-93`
- `tenant-pricing-override-write.ts:34-38` and `:513-521`

The two test blocks that pin today's wording go red on purpose — they are the
checklist, not an obstacle. Keep the word-absence guards; **change what the
forbidden list means**, do not delete it. "Applied" may now be sayable where it
is true; "in force" must still not be claimed for a `pending` store.

### T5 — mount

`tenant-directory.tsx`: import `TenantPricingOverrideAction`, render it beside
`TenantLifecycleAction`, delete the pointer comment (`:281-289`). One component
renders both buttons and both dialogs — one JSX line.

**There is no `tenant-directory.test.tsx`.** Nothing asserts the control's
presence or absence. Add a test that it renders, or mounting is untested.

## Precondition, checked as live state

platform-api serving these routes is deployed: `main-b8b3be9`, 2/2 ready, 0
restarts, verified in the cluster on 2026-09-06 — not inferred from the merge.
The console deploys on merge, so mounting a control whose endpoint is absent
would surface as a 503 reading "the product could not be reached".

## Out of scope

- **Any change to what mark8ly or platform-api do.** Both are deployed; this PR
  is a caller.
- **A per-store UI component.** Decision 3.
- **Retrofitting the deterministic-key argument onto `tenant-lifecycle-write`.**
  Worth doing, not here.

## Global constraints

- **Comment accuracy** — this estate's documented recurring defect, and this PR
  is mostly comment correction. Run the command before writing the sentence.
- Server/client boundary: the seams are `server-only`, the control is a client
  component; go through `actions.ts`.
- **Console mutations are server actions here** — no client fetches to API
  routes, or the audit trail every sibling writes is skipped.
- Do not weaken an existing assertion. pnpm, and run from this worktree.
