// Package handler is the tenants module's HTTP surface.
//
//	GET /v1/tenants           the estate tenant directory
//	    ?source=<slug>        narrow to one product
//	    ?q=<text>             free-text search, passed through to each product
//	    ?status=<status>      the product's own status vocabulary
//	    ?limit=<n>            rows asked of each product (default 100)
//
// # The capability is `platform`
//
// Tenants sits in the platform rail's Operate group, alongside the audit log
// and identity lookup, and is gated the same way. It is deliberately NOT
// `billing`: knowing a tenant exists is an operate concern, and only what they
// pay is a revenue one.
package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/tenants/internal/service"
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
	handler func(*Handler) http.HandlerFunc
}

// MaxLimit bounds what a caller may ask each product for. A request above it
// is REFUSED rather than clamped: silently returning fewer rows than asked for
// is how a caller comes to believe a page is complete when it is not.
const MaxLimit = 500

// estateParameters is every query parameter this route reads. Anything else is
// a 400 — see httpx.RejectUnknownParameters. A rejected typo is cheaper than a
// filter that silently did nothing.
var estateParameters = []string{"source", "q", "status", "limit"}

// reasonCodesParameters is the §8.8 read's only parameter, and it is REQUIRED
// — see the handler for why there is no fan-out to default to.
var reasonCodesParameters = []string{"source"}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. capability_test ranges over it.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/tenants",
		handler: func(h *Handler) http.HandlerFunc { return h.estate }},
	{Method: http.MethodPost, Pattern: "/v1/tenants/{id}/suspend",
		handler: func(h *Handler) http.HandlerFunc { return h.suspend }},
	{Method: http.MethodPost, Pattern: "/v1/tenants/{id}/unsuspend",
		handler: func(h *Handler) http.HandlerFunc { return h.unsuspend }},
	// A literal segment where the write routes take {id}, so it cannot be
	// mistaken for a tenant called "lifecycle": ServeMux prefers the literal.
	{Method: http.MethodGet, Pattern: "/v1/tenants/lifecycle/reason-codes",
		handler: func(h *Handler) http.HandlerFunc { return h.reasonCodes }},
}

// maxLifecycleBody caps what will be read from a lifecycle request. The body
// is two short strings; anything larger is a mistake or an attack, and reading
// it would make someone else's bug this process's memory problem.
const maxLifecycleBody = 8 << 10

func (h *Handler) suspend(w http.ResponseWriter, r *http.Request) {
	h.lifecycle(w, r, "suspend")
}

func (h *Handler) unsuspend(w http.ResponseWriter, r *http.Request) {
	h.lifecycle(w, r, "unsuspend")
}

// lifecycle serves both verbs. They differ only in which service call runs.
func (h *Handler) lifecycle(w http.ResponseWriter, r *http.Request, verb string) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}

	// Required, and refused rather than generated. A key this service invented
	// would be fresh on every retry, which is the same as having none — the
	// uniqueness that matters is of the CALLER's intent, and only the caller
	// can assert it. The kernel's idempotency package makes the same argument.
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		httpx.WriteError(w, r, httpx.BadRequest("the Idempotency-Key header is required for this write"), h.log)
		return
	}

	var in service.Lifecycle
	if err := json.NewDecoder(io.LimitReader(r.Body, maxLifecycleBody)).Decode(&in); err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("request body is not valid JSON"), h.log)
		return
	}
	// Presence only. The VALUE is the product's vocabulary — mark8ly declares
	// different sets for suspend and unsuspend — and validating it here would
	// be a second list that drifts. An empty one never reaches the product,
	// because a missing reason on a suspension is this surface's own concern:
	// the audit row it produces is read later by someone asking why.
	if strings.TrimSpace(in.ReasonCode) == "" {
		httpx.WriteError(w, r, httpx.BadRequest("reason_code is required"), h.log)
		return
	}

	op := federation.Operator{ID: principal.Subject, Capability: string(auth.CapPlatform)}
	tenantID := r.PathValue("id")

	var (
		result service.LifecycleResult
		err    error
	)
	if verb == "suspend" {
		result, err = h.svc.Suspend(r.Context(), op, tenantID, in, key)
	} else {
		result, err = h.svc.Unsuspend(r.Context(), op, tenantID, in, key)
	}
	if err != nil {
		h.writeLifecycleError(w, r, verb, tenantID, err)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, result, h.log)
}

// writeLifecycleError maps a failed write onto a status an operator can act on.
//
// The product's §4.4 code is passed through where there is one. That code is a
// stable machine-readable identifier by contract, unlike its sibling
// `message`, which is free text from another product and never rendered. The
// alternative — collapsing every refusal to "responded 400" — leaves an
// operator staring at a form with no idea which field was wrong.
func (h *Handler) writeLifecycleError(w http.ResponseWriter, r *http.Request, verb, tenantID string, err error) {
	// Logged with the unredacted error and the tenant, because a failed
	// mutation is exactly what someone asks about afterwards.
	h.log.ErrorContext(r.Context(), "tenants: lifecycle write failed",
		"verb", verb, "tenant", tenantID, "error", err)

	if errors.Is(err, service.ErrUnknownSource) {
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
		return
	}
	if code, ok := federation.ErrorCode(err); ok {
		httpx.WriteError(w, r, httpx.BadRequest("the product refused this change: "+code), h.log)
		return
	}
	// No code to pass on. Deliberately NOT err.Error(): a transport failure's
	// text carries hostnames and addresses, which is why the federation package
	// sanitizes at all.
	// Unavailable rather than a new BadGateway helper: the kernel has no 502,
	// and "the owning product could not be reached" is what 503 already means
	// on this surface. Adding a status to httpx for one call site would put a
	// second way to say the same thing in the kernel.
	httpx.WriteError(w, r, httpx.Unavailable("the product could not be reached to "+verb+" this tenant"), h.log)
}

// Routes mounts the table behind the capability gate.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, r := range RouteTable {
		mux.Handle(r.Method+" "+r.Pattern,
			auth.Authenticate(verifier, h.log,
				auth.RequireCapability(auth.CapPlatform, h.log, r.handler(h))))
	}
}

func (h *Handler) estate(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		// Fail closed, before any work. Unreachable behind Authenticate in
		// production; if this route is ever mounted without it, the refusal
		// must come before the service is touched — otherwise status codes
		// alone tell an unverified caller which product slugs exist.
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}

	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, estateParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	page, err := h.svc.Estate(r.Context(), federation.Operator{
		ID: principal.Subject,
		// The operator's authority, taken from the verified session and never
		// from anything the client supplied. It is signed into every federated
		// request, so a product records who acted rather than "the platform".
		Capability: string(auth.CapPlatform),
	}, service.Query{
		Source: strings.TrimSpace(query.Get("source")),
		Q:      strings.TrimSpace(query.Get("q")),
		Status: strings.TrimSpace(query.Get("status")),
		Limit:  limit,
	})
	if err != nil {
		// "No products configured" is 501, not an empty 200: the console reads
		// it as instrumentation-unavailable rather than as "the estate has no
		// tenants", which are very different claims.
		if errors.Is(err, service.ErrNotInstrumented) {
			httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
			return
		}
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

// readLimit parses the per-product bound.
//
// Absent means the service's default, so a direct API caller gets the same
// bounded read the console asks for rather than an unbounded fan-out. Present
// but not a positive integer is a 400 rather than a silent fallback: a caller
// who sent `limit=abc` has a bug, and answering it with the default hides it.
func readLimit(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, httpx.BadRequest("limit must be a positive integer")
	}
	if n > MaxLimit {
		return 0, httpx.BadRequest("limit exceeds the maximum of " + strconv.Itoa(MaxLimit))
	}
	return n, nil
}

// reasonCodes serves contract §8.8 for ONE product.
//
// `source` is required and there is deliberately no fan-out. Every other read
// in this module merges across products; this one answers a write form's menu,
// and merging two products' vocabularies would offer an operator a code the
// owning product refuses — or, worse, one both accept and mean differently.
// tesserix-home#345 is the whole argument, and defaulting to "all products"
// would rebuild the borrowed-vocabulary bug on the server side.
func (h *Handler) reasonCodes(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}

	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, reasonCodesParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	source := strings.TrimSpace(query.Get("source"))
	if source == "" {
		httpx.WriteError(w, r, httpx.BadRequest(
			"source is required: reason codes are one product's vocabulary, not the estate's"), h.log)
		return
	}

	codes, err := h.svc.ReasonCodes(r.Context(), federation.Operator{
		ID: principal.Subject, Capability: string(auth.CapPlatform),
	}, source)
	if err != nil {
		h.writeReasonCodesError(w, r, source, err)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, codes, h.log)
}

// writeReasonCodesError maps a failed read onto a status the console can act
// on. Each branch renders differently: a gap the operator can do nothing about
// must not look like a form they filled in wrong.
func (h *Handler) writeReasonCodesError(w http.ResponseWriter, r *http.Request, source string, err error) {
	h.log.ErrorContext(r.Context(), "tenants: reason codes read failed", "source", source, "error", err)

	switch {
	case errors.Is(err, service.ErrNotInstrumented):
		httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
	case errors.Is(err, service.ErrUnknownSource):
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
	case errors.Is(err, service.ErrNoReasonCodes):
		// 501, not 200-with-nothing and not 502. The product answered, and
		// what it said is "I publish no vocabulary" — a contract gap on its
		// side (§8.8), which is exactly what not_implemented means here. The
		// console renders the action as unavailable rather than offering an
		// empty menu on a write that requires a code.
		httpx.WriteError(w, r, httpx.NotImplemented(
			"the product publishes no lifecycle reason codes (contract §8.8)"), h.log)
	default:
		// Deliberately not err.Error(): a transport failure's text carries
		// hostnames, which is why the federation package sanitizes at all.
		httpx.WriteError(w, r, httpx.Unavailable(
			"the product could not be reached for its lifecycle reason codes"), h.log)
	}
}
