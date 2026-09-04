// Package handler is the entities module's HTTP surface.
//
//	GET /v1/entities/{type}?source=<slug>   one product's records of one type
//	    ?q=<text>                            search text, forwarded verbatim
//	    ?limit=<n>                           rows asked for (default 100)
//
// # The capability is `platform`
//
// Same gate as the other Operate reads — the tenant directory, which reads
// §3.4's `tenants` type, already uses it.
package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/entities/internal/service"
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
	{Method: http.MethodGet, Pattern: "/v1/entities/{type}",
		handler: func(h *Handler) http.HandlerFunc { return h.read }},
}

// DefaultLimit is what a product is asked for when the caller names none.
const DefaultLimit = 100

// MaxLimit is refused rather than clamped, matching the tenants and inbox
// modules: silently returning fewer rows than asked for is how a caller comes
// to believe a page is complete when it is not.
const MaxLimit = 500

var entityParameters = []string{"source", "q", "limit", "page"}

// Routes mounts the table behind the capability gate.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	for _, r := range RouteTable {
		mux.Handle(r.Method+" "+r.Pattern,
			auth.Authenticate(verifier, h.log,
				auth.RequireCapability(auth.CapPlatform, h.log, r.handler(h))))
	}
}

func (h *Handler) read(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return
	}

	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, entityParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	// Required, and there is deliberately no fan-out default: `users` in one
	// product and `users` in another are different populations, and merging
	// them makes a table whose columns mean different things per row.
	source := strings.TrimSpace(query.Get("source"))
	if source == "" {
		httpx.WriteError(w, r, httpx.BadRequest(
			"source is required: an entity type is one product's records, not the estate's"), h.log)
		return
	}

	entityType := strings.TrimSpace(r.PathValue("type"))
	if entityType == "" {
		httpx.WriteError(w, r, httpx.BadRequest("an entity type is required"), h.log)
		return
	}

	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	pageNumber, err := readPage(query.Get("page"))
	if err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	page, err := h.svc.Read(r.Context(), federation.Operator{
		ID: principal.Subject, Capability: string(auth.CapPlatform),
	}, source, entityType, service.Query{
		// Forwarded verbatim, not validated here — the product owns its own
		// rules and a copy of them would drift. See service.Query.Q.
		Q:     strings.TrimSpace(query.Get("q")),
		Limit: limit,
		Page:  pageNumber,
	})
	if err != nil {
		h.writeReadError(w, r, err)
		return
	}

	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

func (h *Handler) writeReadError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrNotInstrumented):
		httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
	case errors.Is(err, service.ErrUnknownSource), errors.Is(err, service.ErrTypeNotServed):
		// 501, NOT 400 (#546), and still two DIFFERENT messages — because
		// "kora has no tenants" and "there is no product called kroa" send
		// whoever hit it to check different things. Only the status changed;
		// the distinction the previous comment protected is untouched.
		//
		// Both are refusals of scope, not of syntax. The request was
		// well-formed and the console built it from its own rail; what it
		// names is simply not wired up in THIS deployment —
		// FEDERATION_PRODUCTS omits the slug, or FEDERATION_<SLUG>_ENTITIES
		// omits the type. NotImplemented is that sentence ("nothing here was
		// ever configured to produce it"), and it is the status the console
		// renders calmly. A 400 rendered a working configuration as an
		// outage.
		//
		// The status can no longer separate a typo'd slug from an unfederated
		// product, and that is not a distinction being thrown away: the
		// service never had it. s.types is the FEDERATED map; there is no
		// KNOWN-product set anywhere in this API, and building one would put a
		// drifting copy of the console's registry here to answer a question
		// only a hand-edited URL asks. A malformed REQUEST is still a 400 —
		// missing source, bad limit, bad page, unknown parameter — so 400 kept
		// the meaning it can actually enforce.
		httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
	default:
		// The product's §4.4 code is passed through where there is one. That
		// code is a stable machine-readable identifier by contract, and it is
		// how a caller learns their search was too short rather than that the
		// product is down — kora refuses a `q` under two characters with
		// `invalid_input`.
		if code, ok := federation.ErrorCode(err); ok {
			httpx.WriteError(w, r, httpx.BadRequest("the product refused this read: "+code), h.log)
			return
		}
		// Deliberately not err.Error(): a transport failure's text carries
		// hostnames, which is why the federation package sanitizes at all.
		httpx.WriteError(w, r, httpx.Unavailable("the product could not be reached"), h.log)
	}
}

// readPage parses the 1-based page number.
//
// Absent means the first page. Present but not a positive integer is a 400
// rather than a silent fallback: `?page=0` and `?page=-1` are bugs in whatever
// built the link, and answering them with page 1 hides a pager that has walked
// off the start of its range.
func readPage(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 1, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, httpx.BadRequest("page must be a positive integer")
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
