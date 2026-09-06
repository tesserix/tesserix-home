// Package domain holds the billing module's types.
package domain

import "slices"

// Money is §4.2's shape: minor units with an explicit currency, never a bare
// number.
//
// §8.2 warns that this is the endpoint most likely to be handed a bare number,
// *because* Stripe amounts already arrive in minor units and the temptation is
// to pass them through uncurrencied. A bare 4900 is 49 dollars or 49 rupees
// depending on a fact the payload no longer carries.
type Money struct {
	// Amount is in MINOR units — cents, paise. Never a decimal.
	Amount   int64  `json:"amount"`
	Currency string `json:"currency"`
}

// Subscription is one recurring plan, from any product.
//
// Optional throughout where the product may not know: `amount` is absent when
// no catalog price resolves, and absent is not zero. Rendering a missing price
// as 0 would say "this tenant pays nothing", which is a different and wrong
// claim.
type Subscription struct {
	// Source is stamped from the slug the call was MADE to, never the body.
	Source     string `json:"source"`
	TenantID   string `json:"tenant_id"`
	TenantName string `json:"tenant_name,omitempty"`
	StoreID    string `json:"store_id,omitempty"`
	Plan       string `json:"plan"`
	Period     string `json:"period,omitempty"`
	// Status is the PRODUCT's vocabulary, rendered verbatim — the same rule
	// `EstateTenant.status` follows. A console-side enumeration would be a
	// second vocabulary that drifts from the first.
	Status            string `json:"status"`
	Amount            *Money `json:"amount,omitempty"`
	CurrentPeriodEnd  string `json:"current_period_end,omitempty"`
	CancelAtPeriodEnd bool   `json:"cancel_at_period_end"`
}

// Trial is one trial approaching its end, with the state that decides whether
// it converts.
//
// `payment_method_on_file` is the field that makes this a work queue rather
// than a report: a trial ending without one is the row somebody acts on.
type Trial struct {
	Source        string `json:"source"`
	TenantID      string `json:"tenant_id"`
	TenantName    string `json:"tenant_name,omitempty"`
	StoreID       string `json:"store_id,omitempty"`
	TrialEndsAt   string `json:"trial_ends_at"`
	DaysRemaining int    `json:"days_remaining"`
	Plan          string `json:"plan"`
	Period        string `json:"period,omitempty"`
	Amount        *Money `json:"amount,omitempty"`
	// BillingCurrency is separate from Amount.Currency deliberately: a trial
	// may have a billing currency chosen with no resolvable price yet, and
	// collapsing the two would lose that.
	BillingCurrency     string `json:"billing_currency,omitempty"`
	PaymentMethodOnFile bool   `json:"payment_method_on_file"`
	Status              string `json:"status"`
	// StripeManaged rows are excluded by default on the product side; carried
	// so a caller that opted them in can tell which they are.
	StripeManaged bool `json:"stripe_managed"`
}

// Failure is one source that could not be read, in the shape the console
// renders on every other federated surface.
type Failure struct {
	Source  string `json:"source"`
	Message string `json:"message"`
}

// SubscriptionPage is the subscriptions surface's response.
//
// `total` is the sum of each ANSWERING product's own total — the count of
// subscriptions it holds, which may exceed the bounded page returned. A failed
// product contributes nothing rather than zero, so the number understates the
// estate whenever `failures` is non-empty. That is what makes rendering the
// two together mandatory rather than tidy.
type SubscriptionPage struct {
	Data     []Subscription `json:"data"`
	Total    int            `json:"total"`
	Failures []Failure      `json:"failures"`
}

// TrialPage is the trials surface's response.
type TrialPage struct {
	Data     []Trial   `json:"data"`
	Total    int       `json:"total"`
	Failures []Failure `json:"failures"`
}

// --- the tenant discount write (§8.2's mutating half) ----------------------

// DiscountRequest is the body of both discount writes.
//
// The revoke carries one too, and the same one: it needs the coupon id to know
// which discount to take off — a subscription may carry several, and a
// merchant's own promo must survive — and it needs a reason for the same rule
// that makes the application need one. mark8ly refuses either field empty.
type DiscountRequest struct {
	CouponID string `json:"coupon_id"`
	// Reason is REQUIRED and travels to the product, which writes it into the
	// audit row inside each store's transaction. It does not come back: see
	// DiscountResult.
	Reason string `json:"reason"`
}

// StoreOutcome is what happened to ONE store.
//
// A named type with a runtime list rather than a bare string, unlike
// `Subscription.Status` beside it, because the two are not the same kind of
// field. A status is a product's own vocabulary rendered verbatim; this one is
// the record of whether a live billing arrangement changed, and a value this
// build cannot place must say so rather than arrive as an empty string that
// renders as though the store had no outcome at all.
type StoreOutcome string

// The nine mark8ly declares, copied from its
// internal/billing/tenantdiscount/outcome.go. Only `applied` and `removed`
// changed Stripe; six more describe a store nothing was sent for, and `failed`
// is a store whose transaction rolled back.
const (
	StoreOutcomeApplied          StoreOutcome = "applied"
	StoreOutcomeAlreadyApplied   StoreOutcome = "already_applied"
	StoreOutcomeRemoved          StoreOutcome = "removed"
	StoreOutcomeNotApplied       StoreOutcome = "not_applied"
	StoreOutcomePending          StoreOutcome = "pending"
	StoreOutcomeNoOverride       StoreOutcome = "no_override"
	StoreOutcomeNoSubscription   StoreOutcome = "no_subscription"
	StoreOutcomeNoStripeCustomer StoreOutcome = "no_stripe_customer"
	StoreOutcomeFailed           StoreOutcome = "failed"

	// StoreOutcomeUnknown stands in for anything else — a missing field, or a
	// value a newer mark8ly added that this build has never heard of. Named,
	// so a console renders "this build does not recognise what happened here"
	// rather than nothing at all. The service logs the value it replaced.
	StoreOutcomeUnknown StoreOutcome = "unknown"
)

var storeOutcomes = []StoreOutcome{
	StoreOutcomeApplied, StoreOutcomeAlreadyApplied, StoreOutcomeRemoved,
	StoreOutcomeNotApplied, StoreOutcomePending, StoreOutcomeNoOverride,
	StoreOutcomeNoSubscription, StoreOutcomeNoStripeCustomer, StoreOutcomeFailed,
}

// ParseStoreOutcome narrows what the product sent.
//
// Returns StoreOutcomeUnknown rather than an error: one unrecognised outcome
// must not fail a report whose other lines are perfectly readable, and the
// change it describes has already happened either way.
func ParseStoreOutcome(raw string) StoreOutcome {
	out := StoreOutcome(raw)
	if slices.Contains(storeOutcomes, out) {
		return out
	}
	return StoreOutcomeUnknown
}

// DiscountStatus summarises the fan-out. Never a substitute for reading Stores.
type DiscountStatus string

const (
	// DiscountStatusOK — no store failed.
	DiscountStatusOK DiscountStatus = "ok"
	// DiscountStatusPartial — some stores failed and some did not. The answer
	// this surface exists to carry honestly: some of it happened.
	DiscountStatusPartial DiscountStatus = "partial"
	// DiscountStatusFailed — every store failed.
	DiscountStatusFailed DiscountStatus = "failed"
	// DiscountStatusUnknown — anything else, for the reason
	// StoreOutcomeUnknown exists.
	DiscountStatusUnknown DiscountStatus = "unknown"
)

var discountStatuses = []DiscountStatus{
	DiscountStatusOK, DiscountStatusPartial, DiscountStatusFailed,
}

// ParseDiscountStatus narrows the product's summary line.
func ParseDiscountStatus(raw string) DiscountStatus {
	status := DiscountStatus(raw)
	if slices.Contains(discountStatuses, status) {
		return status
	}
	return DiscountStatusUnknown
}

// DiscountStore is one store's line in the report.
//
// The optional ids are genuinely absent rather than empty for the outcomes
// that have none: a card-less trialing store has no Stripe subscription, and a
// store with no subscription row has neither.
type DiscountStore struct {
	StoreID string       `json:"store_id"`
	Outcome StoreOutcome `json:"outcome"`
	// SubscriptionID is the product's own subscription row id.
	SubscriptionID       string `json:"subscription_id,omitempty"`
	StripeCustomerID     string `json:"stripe_customer_id,omitempty"`
	StripeSubscriptionID string `json:"stripe_subscription_id,omitempty"`
	// FailureCode and FailureReason are set only for StoreOutcomeFailed.
	//
	// FailureReason is admitted, and this was CHECKED rather than assumed:
	// mark8ly's storeFailure (handlers/platformadmin/billing_tenant_discount.go)
	// returns one of five literal sentences chosen from the failure code, and
	// its own comment says the message "is composed here, never taken from
	// err.Error(): the domain wraps driver output, which is logged
	// server-side and not echoed". So it is that product's fixed vocabulary,
	// not the free text this package otherwise refuses to carry.
	FailureCode   string `json:"failure_code,omitempty"`
	FailureReason string `json:"failure_reason,omitempty"`
}

// DiscountResult is the whole fan-out, re-projected field by field.
//
// Deliberately NOT the product's JSON passed through. Two fields the product
// sends are absent here:
//
//   - `reason` — the OPERATOR's own input, echoed back. Not the hazard the
//     no-free-text rule guards against, and redundant either way: handing a
//     caller their own words back invites reading them as something the
//     product reported.
//   - nothing else. Every other field of mark8ly's report is carried.
type DiscountResult struct {
	// Source is stamped from the slug the call was MADE to, never the body —
	// the same rule every read on this surface follows. With TenantID, which
	// is the product's own bare id, it is the namespaced id the caller sent.
	Source   string `json:"source"`
	TenantID string `json:"tenant_id"`
	CouponID string `json:"coupon_id"`
	// Operation is "apply" or "remove", stamped from the call this service
	// made rather than read from the response.
	Operation string `json:"operation"`
	// PerformedAt is the instant the product's fan-out started, not per store.
	PerformedAt string         `json:"performed_at"`
	Status      DiscountStatus `json:"status"`
	// RequiresReconciliation is set when at least one store changed in Stripe
	// and the audit row explaining it did not commit.
	//
	// NOT omitempty, unlike the product's own field: this is the answer a
	// console must act on, and a reader forced to tell "false" from "absent"
	// to learn whether a billing arrangement diverged is one that will get it
	// wrong.
	RequiresReconciliation bool `json:"requires_reconciliation"`
	// Stores is the point of the report: outcomes differ per store, and the
	// summary above is a line about them, not a replacement for them.
	Stores []DiscountStore `json:"stores"`
}
