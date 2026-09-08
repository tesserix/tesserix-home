// Package handler is the billing module's HTTP surface.
//
//	GET  /v1/billing/subscriptions   every product's recurring plans
//	GET  /v1/billing/trials          every product's expiring trials
//	GET  /v1/billing/entitlements    every product's compiled plan-feature
//	                                 matrix, and the catalog mode it reads
//	     ?source=<slug>              narrow to one product
//	     ?limit=<n>                  rows asked of each product (default 100)
//	     ?include_stripe_managed=true  trials only; opts in rows products exclude
//	     ?include_signup=true      trials only; opts in tenants that signed up
//	                               and never completed checkout. Products
//	                               exclude them by default.
//	     ?days=<n>                 trials only; how far ahead to look. Absent
//	                               means the product's own default (7 days on
//	                               mark8ly, the same window its trials_expiring
//	                               KPI counts). Clamped to MaxDays.
//	POST /v1/billing/tenants/{id}/discount         apply a platform coupon
//	POST /v1/billing/tenants/{id}/discount/remove  take it back off
//
// `{id}` is `<source>:<id>`, the namespaced form the console addresses tenants
// with everywhere. The service splits it and sends the product its own bare id.
//
// # The capability is `billing`, and this is the first route to use it
//
// `packages/platform-auth/src/capabilities.ts` has declared `billing` since the
// vocabulary was written, marked RESERVED with the note that "the console has
// no billing surface today (0 of 28 routes)". This is that surface, so the
// reservation ends here.
//
// NOT `platform`, which every other Operate read uses. §8.2 exists to make a
// product "legible as a business", and revenue is the one estate surface where
// the capability vocabulary already drew a line — using `platform` would make
// that line decorative.
//
// The limitation worth stating rather than rediscovering: capabilities are
// estate-wide, not per-product (§7). So `billing` admits its holder to EVERY
// product's revenue, not a chosen one. That is a real consequence of turning
// this on, and it is smaller than leaving a required contract endpoint
// unreadable — but it is not nothing.
//
// # The entitlements read also admits a machine (#618)
//
// Entitlement parity cannot run unattended, because everything reaching this
// API resolves the OPERATOR's Zitadel token from their session and a CronJob
// has none. So `GET /v1/billing/entitlements` — and only that route — accepts
// EITHER `billing` or `read-entitlements`, the machine capability #618 added
// for exactly this.
//
// `billing` was NOT made a machine capability instead, which would have been
// the shorter change. Capabilities are estate-wide, so an unattended identity
// holding it could read every product's subscriptions, trials and coupon
// history in order to read a feature matrix.
//
// The Zitadel role does not exist yet, so today `read-entitlements` admits
// nobody and this alternative is inert. That is the correct answer rather than
// a bug: the code is in place and the grant is a separate, deliberate act.
//
// # The two writes gate on `publish-catalog` as well
//
// Reading what the estate bills is one thing; putting a coupon on a live
// Stripe subscription is another, and `billing` alone would not draw that line.
// The console's own shipped mint of these coupons already checks both — the
// surface for where an operator works, `publish-catalog` for the act of
// creating a real object in a real Stripe account — and attaching that coupon
// to live subscriptions is the more consequential half of the same operation.
// The email templates module stacks its pair the same way.
package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/billing/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// Handler serves the module.
type Handler struct {
	svc *service.Service
	log *slog.Logger
}

func New(svc *service.Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

// Route is one of the module's paths.
type Route struct {
	Method  string
	Pattern string
	// Write says the route carries a body and requires an Idempotency-Key —
	// and, on this module, that it changes a live billing arrangement, which
	// is what mounts the `publish-catalog` gate as well. The two coincide
	// because both of this module's writes are that kind of write;
	// capability_test asserts the correspondence rather than assuming it.
	Write bool
	// MachineCapability names the capability that ALSO admits this route, held
	// by a service identity instead of the `billing` surface. Empty on a route
	// no machine calls, which is every route but one.
	//
	// It is an ALTERNATIVE, not an addition. Write stacks a second gate (AND);
	// this offers a second way in (OR), for a route two different KINDS of
	// principal reach for the same reason. The two must not both be set on one
	// route — an unattended identity that may change live billing is a grant
	// nobody has made — and capability_test refuses that combination.
	MachineCapability auth.Capability
	handler           func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. capability_test ranges over it.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/billing/subscriptions",
		handler: func(h *Handler) http.HandlerFunc { return h.subscriptions }},
	{Method: http.MethodGet, Pattern: "/v1/billing/trials",
		handler: func(h *Handler) http.HandlerFunc { return h.trials }},
	{Method: http.MethodGet, Pattern: "/v1/billing/entitlements",
		MachineCapability: auth.CapReadEntitlements,
		handler:           func(h *Handler) http.HandlerFunc { return h.entitlements }},
	{Method: http.MethodPost, Pattern: "/v1/billing/tenants/{id}/discount", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.applyDiscount }},
	{Method: http.MethodPost, Pattern: "/v1/billing/tenants/{id}/discount/remove", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.removeDiscount }},
}

// DefaultLimit is what each product is asked for when the caller names none.
const DefaultLimit = 100

// MaxLimit is refused rather than clamped: silently returning fewer rows than
// asked for is how a caller comes to believe a revenue page is complete.
const MaxLimit = 500

var subscriptionParameters = []string{"source", "limit"}

// entitlementParameters: `source` narrows to one product, and that is all.
// This read is one document per product rather than a page of rows, so
// `limit` is an unknown parameter here — refused rather than ignored, because
// a caller who sent one has a wrong model of the surface and a silently
// dropped bound is how someone comes to believe a matrix was truncated.
var entitlementParameters = []string{"source"}
var trialParameters = []string{"source", "limit", "include_stripe_managed", "include_signup", "days"}

// MaxDays is the widest expiry window this surface will ask a product for.
//
// 365 because that is mark8ly's own MaxExpiryWindow, and it is a bound rather
// than a claim: an operator-extended trial can end beyond a year, so the
// widest window is NOT "every trial" and no copy should say it is.
//
// CLAMPED, not refused — the opposite of MaxLimit above, and for the opposite
// reason. The product clamps to the same bound itself, so refusing here would
// invent a stricter contract than the one the product offers; and a window is
// declared on screen (the console names the active one), so a clamped window
// cannot be mistaken for a complete answer the way a silently shortened page
// can.
const MaxDays = 365

// noParameters: the discount writes take none, so any query string is refused.
// The id in the path already names the tenant and the product, and a caller
// adding `?source=` beside it has a wrong model of this surface — one the two
// could disagree about.
var noParameters = []string{}

// maxDiscountBody caps what will be read from a discount request. The body is
// two short strings; anything larger is a mistake or an attack, and reading it
// would make someone else's bug this process's memory problem. The tenants
// module bounds its lifecycle write at the same size.
const maxDiscountBody = 8 << 10

// Routes mounts the table behind its gates.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	surface := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapBilling, h.log, handler))
	}
	// The surface AND the verb, stacked the way the email templates module
	// stacks `platform` and `mass-send`: the surface says where an operator
	// works, the verb says they may do the consequential thing there. An
	// operator who may read the estate's revenue has not thereby been granted
	// permission to change a merchant's live billing.
	change := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapBilling, h.log,
				auth.RequireCapability(auth.CapPublishCatalog, h.log, handler)))
	}
	// EITHER the operator surface or one machine capability — the shape
	// RequireAnyCapability exists for, and the one #152's tickets reads
	// already use. An operator reaches the entitlement matrix through
	// `billing` because it is part of the estate's revenue terms; the
	// console's own unattended machine reaches it through
	// `read-entitlements` because parity has to run without a session.
	// Neither implies the other, so this is "either", not "both".
	//
	// Only the route that NAMES a machine capability gets this gate. The two
	// sibling reads keep the `billing`-only surface: widening them would hand
	// an unattended identity every product's subscriptions and trials, which
	// is a decision nobody has made.
	alsoMachine := func(machine auth.Capability) func(http.HandlerFunc) http.Handler {
		return func(handler http.HandlerFunc) http.Handler {
			return auth.Authenticate(verifier, h.log,
				auth.RequireAnyCapability(
					[]auth.Capability{auth.CapBilling, machine}, h.log, handler))
		}
	}
	for _, r := range RouteTable {
		gate := surface
		switch {
		case r.Write:
			gate = change
		case r.MachineCapability != "":
			gate = alsoMachine(r.MachineCapability)
		}
		mux.Handle(r.Method+" "+r.Pattern, gate(r.handler(h)))
	}
}

func (h *Handler) applyDiscount(w http.ResponseWriter, r *http.Request) {
	h.discount(w, r, "apply")
}

func (h *Handler) removeDiscount(w http.ResponseWriter, r *http.Request) {
	h.discount(w, r, "remove")
}

// discount serves both verbs. They differ only in which service call runs.
func (h *Handler) discount(w http.ResponseWriter, r *http.Request, operation string) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}
	if err := httpx.RejectUnknownParameters(r.URL.Query(), noParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	// Required, and refused rather than generated. A key this service invented
	// would be fresh on every retry, which is the same as having none — the
	// uniqueness that matters is of the CALLER's intent, and only the caller
	// can assert it. The tenants and email templates modules refuse the same
	// way, and mark8ly refuses this endpoint without one too.
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		httpx.WriteError(w, r,
			httpx.BadRequest("the Idempotency-Key header is required for this write"), h.log)
		return
	}

	var in domain.DiscountRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxDiscountBody)).Decode(&in); err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("request body is not valid JSON"), h.log)
		return
	}
	// Both refused here rather than left to the product, because the product's
	// refusal arrives as a bare code and each of these has an obvious
	// sentence. The coupon id's VALUE is not checked beyond being present:
	// what Stripe accepts is not a regexp anyone here should own.
	if strings.TrimSpace(in.CouponID) == "" {
		httpx.WriteError(w, r, httpx.BadRequest("coupon_id is required"), h.log)
		return
	}
	// A discount applied without a stated reason is the gap this series exists
	// to close: the product writes this string into the audit row inside each
	// store's transaction, and that row is read later by someone asking why.
	if strings.TrimSpace(in.Reason) == "" {
		httpx.WriteError(w, r, httpx.BadRequest("reason is required"), h.log)
		return
	}

	op := federation.Operator{
		ID: principal.Subject,
		// `publish-catalog`, not the surface capability: it is the verb being
		// exercised, and mark8ly records the signed capability on the audit
		// row this write produces. The email templates module signs with its
		// surface capability instead, because there `mass-send` is this
		// service's own gate rather than an authority the product checks.
		Capability: string(auth.CapPublishCatalog),
	}
	tenantID := r.PathValue("id")

	var (
		result domain.DiscountResult
		err    error
	)
	if operation == "apply" {
		result, err = h.svc.ApplyDiscount(r.Context(), op, tenantID, in, key)
	} else {
		result, err = h.svc.RemoveDiscount(r.Context(), op, tenantID, in, key)
	}
	if err != nil {
		h.writeDiscountError(w, r, operation, tenantID, err)
		return
	}

	// 200 with the re-projected report, and NOT a 207. Nothing in this service
	// speaks 207, and a status code the console must learn to branch on buys
	// nothing over `status` and `requires_reconciliation` — fields it has to
	// read either way.
	httpx.WriteData(w, r, http.StatusOK, result, h.log)
}

// writeDiscountError maps a failed write onto a status an operator can act on.
//
// The product's §4.4 code is passed through where there is one. That code is a
// stable machine-readable identifier by contract, unlike its sibling
// `message`, which is free text from another product and never rendered. The
// alternative — collapsing every refusal to "responded 400" — leaves an
// operator staring at a form with no idea which part of it was wrong.
func (h *Handler) writeDiscountError(
	w http.ResponseWriter, r *http.Request, operation, tenantID string, err error,
) {
	// Logged with the unredacted error and the tenant, because a failed
	// billing change is exactly what someone asks about afterwards.
	h.log.ErrorContext(r.Context(), "billing: tenant discount write failed",
		"operation", operation, "tenant", tenantID, "error", err)

	if errors.Is(err, service.ErrUnknownSource) {
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
		return
	}
	if code, ok := federation.ErrorCode(err); ok {
		httpx.WriteError(w, r, httpx.BadRequest("the product refused this change: "+code), h.log)
		return
	}
	// No code to pass on. Deliberately NOT err.Error(): a transport failure's
	// text carries hostnames and addresses, which is why the federation
	// package sanitizes at all. 503 rather than a new 502 helper for the
	// reason the tenants module records: this kernel has no 502, and "the
	// owning product could not be reached" is what 503 already means here.
	httpx.WriteError(w, r, httpx.Unavailable(
		"the product could not be reached to "+operation+" this discount"), h.log)
}

func (h *Handler) subscriptions(w http.ResponseWriter, r *http.Request) {
	principal, query, ok := h.begin(w, r, subscriptionParameters)
	if !ok {
		return
	}
	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	page, err := h.svc.Subscriptions(r.Context(), operatorFor(principal), service.Query{
		Source: strings.TrimSpace(query.Get("source")),
		Limit:  limit,
	})
	if err != nil {
		h.writeReadError(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

// entitlements serves the compiled plan-feature matrix of every product that
// declares §8.2.
//
// No `limit` and no window: the matrix is compiled into the product's binary
// and answered whole, so there is nothing to bound.
func (h *Handler) entitlements(w http.ResponseWriter, r *http.Request) {
	principal, query, ok := h.begin(w, r, entitlementParameters)
	if !ok {
		return
	}

	page, err := h.svc.Entitlements(r.Context(), operatorFor(principal), service.Query{
		Source: strings.TrimSpace(query.Get("source")),
	})
	if err != nil {
		// The same mapping the two list reads use, and ErrNotInstrumented is
		// the branch that matters: 501, never an empty 200. An estate that
		// federates no billing product must not render as one whose plans
		// entitle nothing.
		h.writeReadError(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

func (h *Handler) trials(w http.ResponseWriter, r *http.Request) {
	principal, query, ok := h.begin(w, r, trialParameters)
	if !ok {
		return
	}
	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}
	days, err := readDays(query.Get("days"))
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	page, err := h.svc.Trials(r.Context(), operatorFor(principal), service.Query{
		Source: strings.TrimSpace(query.Get("source")),
		Limit:  limit,
		// Only `true` opts in. Any other value is treated as absent rather
		// than rejected: this is a widening flag, and the safe reading of an
		// unrecognised value is the narrower result.
		IncludeStripeManaged: query.Get("include_stripe_managed") == "true",
		// Same reading, and for the same reason: an unrecognised value on a
		// widening flag means the narrower result.
		IncludeSignup: query.Get("include_signup") == "true",
		Days:          days,
	})
	if err != nil {
		h.writeReadError(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

// begin does the checks both routes share.
func (h *Handler) begin(
	w http.ResponseWriter, r *http.Request, allowed []string,
) (*auth.Principal, url.Values, bool) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		// Fail closed, before any work — otherwise status codes alone tell an
		// unverified caller which product slugs exist.
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return nil, nil, false
	}
	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, allowed); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return nil, nil, false
	}
	return principal, query, true
}

func operatorFor(principal *auth.Principal) federation.Operator {
	return federation.Operator{
		ID: principal.Subject,
		// The capability actually exercised, so a product records that this
		// was a billing read rather than a generic platform one (§8.4).
		Capability: string(auth.CapBilling),
	}
}

func (h *Handler) writeReadError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrNotInstrumented):
		// 501, never an empty 200. §8.2 forbids an empty list meaning "no
		// billing" because it is indistinguishable from "no subscriptions" —
		// and an unconfigured estate must not render as a solvent one with no
		// customers.
		httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
	case errors.Is(err, service.ErrUnknownSource):
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
	default:
		httpx.WriteError(w, r, httpx.Unavailable("the billing sources could not be read"), h.log)
	}
}

// readDays validates the expiry window, in days.
//
// An empty value returns 0, which `trialsPath` sends as nothing at all: the
// product then applies its own default, which is the request the console has
// always made. Junk is refused here rather than forwarded for the product to
// reject — a surface that passes nonsense on is one refactor away from passing
// it somewhere that does not check.
func readDays(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, httpx.BadRequest("days must be a positive integer")
	}
	if n > MaxDays {
		return MaxDays, nil
	}
	return n, nil
}

func readLimit(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return DefaultLimit, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, httpx.BadRequest("limit must be a positive integer")
	}
	if n > MaxLimit {
		return 0, httpx.BadRequest("limit must be " + strconv.Itoa(MaxLimit) + " or fewer")
	}
	return n, nil
}
