// Package handler is the inbox module's HTTP surface.
//
//	GET /v1/inbox             everything waiting on a human, across products
//	    ?source=<slug>        narrow to one product
//	    ?limit=<n>            items asked of each product (default 100)
//
// # The capability is `platform`
//
// The inbox sits in the platform rail's Operate group beside the audit log and
// the tenant directory, and is gated the same way. Deliberately NOT `billing`
// or a verb capability: reading what is waiting is an operate concern, and
// nothing here acts on anything — §8.3's action execution does not exist on
// any product yet.
package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/inbox/internal/service"
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

// RouteTable is every route this module serves, and the ONLY place they are
// declared. capability_test ranges over it.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/inbox",
		handler: func(h *Handler) http.HandlerFunc { return h.estate }},
}

// DefaultLimit bounds what each product is asked for when the caller names no
// limit. Defaulted rather than left unset even though the console always sends
// one: an unbounded fan-out asks every product for its whole queue, and the
// federation client truncates at 1 MiB mid-JSON.
const DefaultLimit = 100

// MaxLimit is refused rather than clamped, matching the tenants module.
// Silently returning fewer items than asked for is how a caller comes to
// believe a queue is shorter than it is — which on this surface means
// believing work is done.
const MaxLimit = 500

// inboxParameters is every query parameter this route reads. Anything else is
// a 400 — see httpx.RejectUnknownParameters. A rejected typo is cheaper than a
// filter that silently did nothing.
var inboxParameters = []string{"source", "limit"}

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
	if err := httpx.RejectUnknownParameters(query, inboxParameters); err != nil {
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
		// request, so a product records who asked rather than "the platform".
		Capability: string(auth.CapPlatform),
	}, service.Query{
		Source: strings.TrimSpace(query.Get("source")),
		Limit:  limit,
	})
	if err != nil {
		// "No products configured" is 501, not an empty 200. An empty queue is
		// a real and reassuring answer; instrumentation that was never wired
		// must not be able to produce that reassurance.
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
// Absent means the service default. Present but not a positive integer is a
// 400 rather than a silent fallback: a caller who sent `limit=abc` has a bug,
// and answering it with the default hides it.
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
