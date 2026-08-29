// Package handler is the outbox module's HTTP surface.
//
//	GET /v1/outbox                    the estate outbox
//	    ?status=<s>                   forwarded to every product verbatim
//	    ?event_type=<s>               forwarded to every product verbatim
//	    ?older_than_minutes=<n>       forwarded when a positive integer
//	    ?since_hours=<n>              forwarded when a positive integer
//	    ?tenant_id=<s>                forwarded to every product verbatim
//	    ?page=<n>                     forwarded when a positive integer
//	    ?limit=<n>                    forwarded when a positive integer
//
// # The capability is `platform`
//
// Taken from `platform.outbox` in packages/console-core/src/routes.ts, which
// is the console surface this serves and is gated the same way as the audit
// log and the tenant directory: this is a governance surface an operator
// opens deliberately, not one rendered on every page.
//
// # `page` and `limit` are per-product, not per-estate
//
// This route has no `?source=` to narrow a read to one product — unlike
// audit and inbox, the six accepted filters are exactly mark8ly's own
// (outbox.go:173-201), and that list has no source concept. `page` and
// `limit` are forwarded to EVERY federated product as-is and each product's
// `pagination` envelope is then discarded (see the service's reasoning for
// why merging it would be meaningless): `?page=2` means "page 2 of each
// product's own outbox", not "page 2 of the merged estate list". An operator
// paging past a product with fewer rows than others will see that product's
// contribution shrink or vanish from the page while others keep contributing
// theirs — a real gap in this surface today, with no filter available to
// work around it.
package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/outbox/internal/service"
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
	// handler is unexported so the table stays a description of the surface
	// rather than a handle on it.
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. capability_test ranges over it.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/outbox",
		handler: func(h *Handler) http.HandlerFunc { return h.estate }},
}

// outboxParameters is every query parameter this route reads. Anything else
// is a 400 — see httpx.RejectUnknownParameters. A rejected typo is cheaper
// than a filter that silently did nothing.
var outboxParameters = []string{
	"status", "event_type", "older_than_minutes", "since_hours", "tenant_id", "page", "limit",
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
	if err := httpx.RejectUnknownParameters(query, outboxParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	olderThanMinutes, err := readOptionalPositiveInt(query, "older_than_minutes")
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}
	sinceHours, err := readOptionalPositiveInt(query, "since_hours")
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}
	page, err := readOptionalPositiveInt(query, "page")
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}
	limit, err := readOptionalPositiveInt(query, "limit")
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	svcQuery := service.Query{
		Status:           strings.TrimSpace(query.Get("status")),
		EventType:        strings.TrimSpace(query.Get("event_type")),
		OlderThanMinutes: olderThanMinutes,
		SinceHours:       sinceHours,
		TenantID:         strings.TrimSpace(query.Get("tenant_id")),
		Page:             page,
		Limit:            limit,
	}

	result, err := h.svc.Estate(r.Context(), federation.Operator{
		ID:         principal.Subject,
		Capability: string(auth.CapPlatform),
	}, svcQuery)
	if err != nil {
		// The zero-value domain.Page{} on this path has NIL slices, which
		// serialise as null — never fall through to WriteData here.
		//
		// A deployment federating no products for this endpoint at all is
		// 501, not an empty 200: the console maps that status to
		// "instrumentation-unavailable", which is the honest reading of a
		// registry nobody has declared an outbox implementer into yet — the
		// real state of production today.
		if errors.Is(err, service.ErrNotInstrumented) {
			httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
			return
		}
		// Estate promises only ErrNotInstrumented today — every other
		// failure a federated source can produce is absorbed into
		// page.Failures rather than returned as an error — so this branch is
		// unreachable in practice. Kept as a hard failure-closed path rather
		// than deleted, and deliberately does NOT echo err.Error() to the
		// client the way the ErrNotInstrumented branch above does: that
		// error's text is a fixed, safe sentinel this package controls, but
		// a future second error case reaching this arm might not be, and
		// httpx.Internal's own doc is explicit that its message must never
		// be the cause. Log the real cause server-side; tell the caller only
		// that the request failed.
		h.log.Error("outbox: estate read failed", "error", err)
		httpx.WriteError(w, r, httpx.Internal("could not read the estate outbox"), h.log)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, result, h.log)
}

// readOptionalPositiveInt reads one integer bound. Absent means "no opinion"
// — the parameter is left off the federated request entirely, so each
// product applies its own default. Present-but-not-a-positive-integer is a
// 400 naming the parameter: this estate refuses parameters it cannot read
// rather than silently dropping them (#307), and a silently dropped
// `?limit=abc` is a caller who believes they bounded a request that was not
// bounded at all.
func readOptionalPositiveInt(query url.Values, name string) (*int, error) {
	raw := strings.TrimSpace(query.Get(name))
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return nil, httpx.BadRequest(name + " must be a positive integer").
			WithDetails(map[string]any{name: raw})
	}
	return &value, nil
}
