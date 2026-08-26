// Package domain holds the billing module's types.
package domain

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
