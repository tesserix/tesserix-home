// Package handler is the audit module's HTTP surface.
//
//	GET /v1/audit             the estate timeline
//	    ?source=<slug>        narrow to one product
//	    ?limit=<n>            rows asked of each product (default 200)
//	    ?since_hours=<n>      how far back each product reaches (default 720)
//
// # The capability is `platform`
//
// Taken from `platform.auditLog` in packages/console-core/src/routes.ts:250,
// which is the console surface this serves. Reads are gated, unlike the tools
// module's: the audit log is not rendered on every page for every operator,
// it is a Governance surface opened deliberately.
package handler

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/service"
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
// The bounds every product is asked for when the caller names none.
//
// The SAME numbers apps/console/lib/platform-api.ts sends as AUDIT_LIMIT and
// AUDIT_SINCE_HOURS. NOT the same as apps/web's own defaults: apps/web's
// DEFAULT_SINCE_HOURS is 24, not 720 — 720 is only apps/web's MAX_SINCE_HOURS
// ceiling. What matches here is what the console sends, not what the other
// transport defaults to when nobody asks. Defaulting rather than leaving them
// unset matters even with the console always sending them: an unbounded
// fan-out asks each product for its entire audit log, and the federation
// client truncates the answer at 1 MiB mid-JSON.
const (
	DefaultLimit      = 200
	DefaultSinceHours = 720

	// MaxLimit and MaxSinceHours mirror apps/web's own MAX_LIMIT and
	// MAX_SINCE_HOURS. Mirrored VALUE, not mirrored BEHAVIOUR: apps/web
	// clamps a value above its maximum down to the maximum, silently.
	// This handler refuses instead — see readBound and checkMax below.
	//
	// That is a deliberate divergence between the two transports, not an
	// oversight. This estate's convention is to refuse a parameter it
	// cannot honour rather than quietly substitute something else for it —
	// the same rule that makes a stray unknown parameter a 400
	// (httpx.RejectUnknownParameters) rather than an ignored one. Silently
	// turning `?limit=5000` into `limit=1000` is exactly that kind of quiet
	// substitution, just on a value instead of a name. Refusing it is
	// consistent with the rest of this handler's stance even though it
	// means this endpoint answers 400 where apps/web would answer 200.
	//
	// It is also invisible in practice: the console only ever sends
	// AUDIT_LIMIT/AUDIT_SINCE_HOURS (200/720, both within these maximums),
	// so nothing observable through the console changes.
	MaxLimit      = 1000
	MaxSinceHours = 720
)

// estateParameters is every query parameter this route reads. Anything else is
// a 400 — see httpx.RejectUnknownParameters.
var estateParameters = []string{"source", "limit", "since_hours"}

var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/audit",
		handler: func(h *Handler) http.HandlerFunc { return h.estate }},
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

	limit, err := readBound(query.Get("limit"), "limit", DefaultLimit, MaxLimit)
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}
	sinceHours, err := readBound(query.Get("since_hours"), "since_hours", DefaultSinceHours, MaxSinceHours)
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	page, err := h.svc.Estate(r.Context(), federation.Operator{
		ID:         principal.Subject,
		Capability: string(auth.CapPlatform),
	}, service.Query{
		Source:     strings.TrimSpace(query.Get("source")),
		Limit:      limit,
		SinceHours: sinceHours,
	})
	if err != nil {
		// The zero-value domain.Page{} on this path has NIL slices, which
		// serialise as null — never fall through to WriteData here.
		//
		// A deployment federating no products at all is 501, not a 400 and
		// not an empty 200: the console maps that status to
		// "instrumentation-unavailable", which is the honest reading of a
		// registry nobody configured. Everything else Estate refuses is a bad
		// request — today, a source that is not a product.
		if errors.Is(err, service.ErrNotInstrumented) {
			httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
			return
		}
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

// readBound parses one of the two bounds the products are asked for.
//
// Absent means the default, so a direct API caller gets the SAME window the
// console asks for rather than an unbounded read. Present-but-not-a-positive-
// integer, or present-but-over-max, is a 400 naming the parameter: this
// estate refuses parameters it cannot read (or honour) rather than silently
// coercing them (#307), and a silently coerced `?limit=abc` — or a silently
// clamped `?limit=5000` — is a truncated audit timeline nobody was told
// about.
//
// A 400, not the 422 httpx.Validation returns: a malformed or out-of-range
// query parameter is the same class of malformed request that
// httpx.RejectUnknownParameters already answers 400 for on this same
// handler, and one HTTP surface should not answer two different shapes for
// one concern.
func readBound(raw, name string, fallback, max int) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, httpx.BadRequest(name + " is not an integer").
			WithDetails(map[string]any{name: raw})
	}
	if value < 1 {
		return 0, httpx.BadRequest(name + " must be a positive integer").
			WithDetails(map[string]any{name: value})
	}
	if value > max {
		return 0, httpx.BadRequest(fmt.Sprintf("%s must not exceed %d", name, max)).
			WithDetails(map[string]any{name: value, "max": max})
	}
	return value, nil
}
