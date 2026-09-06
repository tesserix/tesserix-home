// Package handler is the billing module's HTTP surface.
//
//	GET  /v1/billing/subscriptions   every product's recurring plans
//	GET  /v1/billing/trials          every product's expiring trials
//	     ?source=<slug>              narrow to one product
//	     ?limit=<n>                  rows asked of each product (default 100)
//	     ?include_stripe_managed=true  trials only; opts in rows products exclude
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
	Write   bool
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. capability_test ranges over it.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/billing/subscriptions",
		handler: func(h *Handler) http.HandlerFunc { return h.subscriptions }},
	{Method: http.MethodGet, Pattern: "/v1/billing/trials",
		handler: func(h *Handler) http.HandlerFunc { return h.trials }},
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
var trialParameters = []string{"source", "limit", "include_stripe_managed"}

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
	for _, r := range RouteTable {
		gate := surface
		if r.Write {
			gate = change
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

	page, err := h.svc.Trials(r.Context(), operatorFor(principal), service.Query{
		Source: strings.TrimSpace(query.Get("source")),
		Limit:  limit,
		// Only `true` opts in. Any other value is treated as absent rather
		// than rejected: this is a widening flag, and the safe reading of an
		// unrecognised value is the narrower result.
		IncludeStripeManaged: query.Get("include_stripe_managed") == "true",
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
