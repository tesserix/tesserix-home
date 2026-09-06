# The billing write path — platform-api's half of the tenant discount

PR 2 of 3 for tesserix-home#331 / mark8ly#660. mark8ly's endpoints shipped and
are deployed; the console's mint and revoke shipped and are unmounted. **Nothing
connects them.** This builds the transport.

- PR 1 (mark8ly#766, #767, #772) — the endpoints. Merged, deployed.
- **PR 2 — this. platform-api's signed write path.**
- PR 3 — the console call, mounting both controls and rewriting
  `overrideMintedMessage`'s now-false third sentence.

## The contract, read from the shipped code rather than the issue

Both routes are **POST** (mark8ly#772 changed the remove from a DELETE carrying
a signed body — a body an intermediary may drop, which would surface as a
misleading 401):

```
POST /admin/billing/tenants/{bare-uuid}/discount
POST /admin/billing/tenants/{bare-uuid}/discount/remove
```

Request body, identical for both: `{"coupon_id": "...", "reason": "..."}`.

Response: `tenant_id`, `coupon_id`, `operation` (`apply`|`remove`), `reason`,
`performed_at`, `status` (`ok`|`partial`|`failed`), `requires_reconciliation`,
and `stores[]` — each with `store_id`, `outcome`, optional `subscription_id`,
`stripe_customer_id`, `stripe_subscription_id`, `failure_code`,
`failure_reason`.

Mandatory `Idempotency-Key` header. mark8ly scopes it
`tenant_discount:<op>:<tenant>:<key>` — **the operation is in the key, not just
the path**, so a key reused across apply and remove cannot replay.

## Two decisions this plan takes, neither of which has a precedent here

### 1. Gate on `billing` AND `publish-catalog`

Every existing billing route gates on `CapBilling` alone
(`billing/internal/handler/handler.go:79-85`). That is too weak for this one.

The console's own shipped mint checks **both** — `billing` for the surface and
`publish-catalog` for the verb, because the act creates a real object in a real
Stripe account (`apps/console/lib/tenant-pricing-override-write.ts:390-391`,
reasoned at `:370-375`). Applying that coupon to live subscriptions is the more
consequential half of the same operation, so it must not be gated more weakly
than minting it. `emailtemplates/internal/handler/handler.go:125-126` is the
precedent for stacking two.

Both aliases exist: `auth.CapBilling`, `auth.CapPublishCatalog`.

Send `publish-catalog` as the downstream `federation.Operator.Capability` — it
is the verb being exercised, and mark8ly records it on the audit row.

### 2. Re-project the per-store result; do not pass it through, do not invent a 207

`git grep "requires_reconciliation\|Partial"` over `platform-api` returns
**nothing**. There is no partial-success precedent, and `httpx` has no envelope
for one (`WriteData(status, data)` / `WriteError` only).

Return **200 with a re-projected domain type**, `status` and
`requires_reconciliation` as first-class fields. Not a 207: nothing in this
service speaks it, and a status code the console must learn to branch on buys
nothing over a field it already has to read.

**Re-project field by field, per the module's existing discipline**
(`service.go:128-145` decodes into typed structs and re-stamps `Source`; the
rule that a product's free-text message never reaches a browser is
`client.go:50-59` and `handler.go:165-172`). Each admitted field is a decision:

- `failure_reason` is mark8ly's **own fixed vocabulary**, not driver text — its
  handler already refuses to echo driver strings. Admit it, and say in a
  comment that this was checked, not assumed.
- `reason` is echoed back by mark8ly. It is the **operator's own input**, so
  admitting it is not the hazard the no-free-text rule guards against — but it
  is also redundant, since the caller supplied it. **Drop it.** Do not echo a
  field back to the caller that the caller sent.

## Tasks

Each is one atomic commit. Tests first.

### T1 — domain types

`platform-api/internal/modules/billing/internal/domain/billing.go` holds read
shapes only (`Money`, `Subscription`, `Trial`, `Failure`, the two pages). Add
the write shapes: the request, the per-store result, the whole result.

Name the outcomes as a type with a runtime list, the way this estate does
elsewhere, so an unknown outcome from a newer mark8ly is a **named** unknown
rather than an empty string rendered as if it meant something.

### T2 — the service

`billing/internal/service/service.go`. Today it only fans out reads
(`federation.FanOut`). This is a **targeted** write to one product, so it does
not fan out.

Model it on `tenants/internal/service/lifecycle.go`:

- `splitTenantID` on the **FIRST** colon (`lifecycle.go:111-117`) — a product's
  own id may contain one, and splitting on the last would aim a mutation at the
  wrong resource. A malformed id is **refused**, never guessed.
- Check the slug is in `s.slugs` before calling.
- Build `"/admin/billing/tenants/" + productID + "/discount"` (and
  `"/discount/remove"`). Bare product id — mark8ly's handlers take a bare UUID.
- `s.fed.Post(ctx, slug, path, body, op, federation.PostOptions{IdempotencyKey: key})`.
- **Return the federation error UNWRAPPED** (`lifecycle.go:89-95`) — wrapping
  with `%v` destroys `federation.ErrorCode`, which the handler needs. That
  comment exists because someone already got this wrong.

### T3 — the handler

`billing/internal/handler/handler.go`.

- Two routes on `RouteTable` — the **only** place routes are declared.
- `billing`'s `Route` struct has **no `Write` field**; the capability test's
  `exercise` uses it to inject an `Idempotency-Key`. Add it, following
  `emailtemplates`.
- **`Idempotency-Key` is required and refused, never generated**
  (`tenants/internal/handler/handler.go:103-107`). Note that
  `docs/PLATFORM-API-CONVENTIONS.md:382` says optional — the **code is right and
  the doc is stale**; follow the code and fix the doc in this PR.
- Cap the body, as tenants does (8 KiB).
- Error mapping, per `tenants/handler.go:151-173`: log unredacted →
  `ErrUnknownSource` → 400 → `federation.ErrorCode(err)` present → 400 naming
  the product's code → default 503. **Never `err.Error()`** — it carries
  hostnames.

### T4 — tests

The module's convention is a **real federation client with real signing against
an httptest fake product** — no service interface, no mocks
(`service_test.go:24-43`, `handler_test.go:57-82`).

`handler_test.go`'s `a.do` takes no body or headers; extend it the way
`emailtemplates` does. Update `capability_test.go` — its `want` map must gain
both routes or the suite goes red, which is the point.

Cover: the split refusing a bare or malformed id; the bare id reaching the
product; a missing `Idempotency-Key` refused **before** anything leaves the
process; the key forwarded; `partial` and `requires_reconciliation` surviving
re-projection; a product refusal mapping to 400 with its code; and **403 when
either capability is missing, asserting nothing reached the product** —
`emailtemplates/capability_test.go:96-115` is the shape.

## Out of scope

- **The console call.** PR 3, which also mounts both controls and rewrites
  `overrideMintedMessage` — `tenant-pricing-override-controls.tsx:62,84,94`
  flag it as MUST-REWRITE when attach lands.
- **Any local persistence.** Tenants sets the precedent: platform-api has no DB
  here and the product is the system of record. It forwards the idempotency key
  and deliberately does not deduplicate.

## Global constraints

- **Comment accuracy** — this estate's documented recurring defect. Run the
  command before writing the sentence that describes it; count anything you
  assert a count about.
- Do not weaken an existing assertion. Do not touch `apps/`.
- Go: `go build ./...`, `go vet ./...`, `gofmt -l`, `go test ./...` from
  `platform-api`, all clean.
- **Check whether any suite silently skips** without `TESSERIX_TEST_DB_*`. This
  module has no DB dependency and should add none — if a test skips, say so
  loudly rather than reporting a green run.
