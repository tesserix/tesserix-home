package handler

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

const (
	DefaultLimit = 50
	MaxLimit     = 200
)

type Handler struct {
	svc *service.Service
	log *slog.Logger
}

func New(svc *service.Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

// Routes mounts the module.
//
// Every route gates on `platform` and none on a verb: this module has no write.
// The gateway is the only writer of this ledger, and an operator changing what
// an LLM request cost is not a feature — it is the thing an audit trail exists
// to make impossible.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	read := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log, auth.RequireCapability(auth.CapPlatform, h.log, handler))
	}

	mux.Handle("GET /v1/ai/usage/summary", read(h.summary))
	mux.Handle("GET /v1/ai/usage/breakdown", read(h.breakdown))
	mux.Handle("GET /v1/ai/usage/guardrails", read(h.guardrails))
	mux.Handle("GET /v1/ai/usage/events", read(h.events))
}

// The accepted parameters per route. Declared rather than inferred so an
// endpoint that stops reading a filter also stops accepting it — a request
// asking for something the server silently ignores gets the wrong answer with
// no way to tell.
var (
	summaryParameters    = []string{"window", "product", "provider"}
	breakdownParameters  = []string{"window", "product", "provider", "by"}
	guardrailsParameters = []string{"window", "product", "provider"}
	eventsParameters     = []string{"window", "product", "provider", "outcome", "limit"}
)

func (h *Handler) summary(w http.ResponseWriter, r *http.Request) {
	q, err := h.query(r, summaryParameters)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	payload, err := h.svc.Summary(r.Context(), q)
	if err != nil {
		h.internal(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

func (h *Handler) breakdown(w http.ResponseWriter, r *http.Request) {
	q, err := h.query(r, breakdownParameters)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	by, err := domain.ParseDimension(r.URL.Query().Get("by"))
	if err != nil {
		h.fail(w, r, httpx.Validation("by is not a breakdown axis", map[string]any{"by": err.Error()}))
		return
	}
	payload, err := h.svc.Breakdown(r.Context(), q, by)
	if err != nil {
		h.internal(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

func (h *Handler) guardrails(w http.ResponseWriter, r *http.Request) {
	q, err := h.query(r, guardrailsParameters)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	payload, err := h.svc.Guardrails(r.Context(), q)
	if err != nil {
		h.internal(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

// events is a TAIL, not a paged list: newest first, capped, no cursor.
//
// §3 asks lists to page by keyset, and this deliberately does not. Raw events
// live 30 days and a busy hour is millions of them; paging into that depth is a
// question about aggregates, which the breakdown answers from rollups in a
// fraction of the cost. Offering a cursor here would advertise a traversal
// nobody should perform.
func (h *Handler) events(w http.ResponseWriter, r *http.Request) {
	q, err := h.query(r, eventsParameters)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	query := r.URL.Query()
	var outcome domain.Outcome
	if raw := query.Get("outcome"); raw != "" {
		outcome, err = domain.ParseOutcome(raw)
		if err != nil {
			h.fail(w, r, httpx.Validation("outcome is not an outcome", map[string]any{"outcome": err.Error()}))
			return
		}
	}

	limit, err := readLimit(query.Get("limit"))
	if err != nil {
		h.fail(w, r, err)
		return
	}

	payload, err := h.svc.Events(r.Context(), q, outcome, limit)
	if err != nil {
		h.internal(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

func (h *Handler) query(r *http.Request, allowed []string) (service.Query, error) {
	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, allowed); err != nil {
		return service.Query{}, err
	}
	window, err := domain.ParseWindow(query.Get("window"))
	if err != nil {
		return service.Query{}, httpx.Validation("window is not a window", map[string]any{"window": err.Error()})
	}
	return service.Query{
		Window:   window,
		Product:  query.Get("product"),
		Provider: query.Get("provider"),
	}, nil
}

func readLimit(raw string) (int, error) {
	if raw == "" {
		return DefaultLimit, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil {
		return 0, httpx.Validation("limit is not an integer", map[string]any{"limit": raw})
	}
	if limit < 1 || limit > MaxLimit {
		return 0, httpx.Validation("limit is out of range", map[string]any{
			"limit": limit,
			"max":   MaxLimit,
		})
	}
	return limit, nil
}

func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	httpx.WriteError(w, r, err, h.log)
}

// internal keeps the driver's error in the log and out of the response: a
// caller learns the request failed, and the request id is what joins the two.
func (h *Handler) internal(w http.ResponseWriter, r *http.Request, err error) {
	h.log.ErrorContext(r.Context(), "request failed",
		slog.Any("error", err),
		slog.String("path", r.URL.Path),
	)
	httpx.WriteError(w, r, httpx.Internal("request failed"), h.log)
}
