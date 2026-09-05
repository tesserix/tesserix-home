// Package handler is the announcements module's HTTP surface.
package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/announcements/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/idempotency"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/productscope"
)

// The lifecycle status a caller is asking on behalf of, when it names none.
//
// `active` matches what apps/web defaults to, so a caller that omits the
// parameter keeps seeing what it saw before the migration.
const defaultTenantStatus = "active"

// maxBodyBytes bounds an authoring request.
const maxBodyBytes = 1 << 20

var (
	errNoPrincipal     = errors.New("no principal on the request")
	errUnscopedMachine = errors.New("this caller is not configured for any product")
)

// listParameters is every parameter this route reads. Anything else is a 400.
var listParameters = []string{"tenant_status"}

type Handler struct {
	svc   *service.Service
	log   *slog.Logger
	scope *productscope.Registry
}

func New(svc *service.Service, log *slog.Logger, scope *productscope.Registry) *Handler {
	return &Handler{svc: svc, log: log, scope: scope}
}

// Routes registers the module's paths.
//
// MACHINE-ONLY, like the tickets module's create. This route answers "what
// should this product show its merchants", which is a question only a product
// asks — the console authors announcements through apps/web today, and #150
// will build its own surface rather than borrow this one.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	// What a PRODUCT reads. Its own machine capability, its own narrow shape.
	mux.Handle("GET /v1/announcements", auth.Authenticate(verifier, h.log,
		auth.RequireCapability(auth.CapReadAnnouncements, h.log, http.HandlerFunc(h.list))))

	// What an OPERATOR authors. `platform` AND `mass-send`, stacked the way the
	// tickets module stacks surface and verb — the surface says where they
	// work, the verb says they may do the irrevocable thing there.
	//
	// `mass-send` rather than `platform` alone is routes.ts's own choice for
	// this surface: "where the route exists only to perform one
	// high-blast-radius act, name the verb instead". Announcements are that.
	authoring := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapPlatform, h.log,
				auth.RequireCapability(auth.CapMassSend, h.log, handler)))
	}

	// A SUB-PATH rather than the same collection, because the shapes differ:
	// this one carries audience_filter, is_published and created_by, all three
	// of which are withheld from products on purpose. `/v1/tickets/summary` is
	// the precedent — a different view of the same rows gets its own path.
	mux.Handle("GET /v1/announcements/all", authoring(h.listAuthored))
	mux.Handle("POST /v1/announcements", authoring(h.create))
	mux.Handle("PATCH /v1/announcements/{id}", authoring(h.update))
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, listParameters); err != nil {
		h.fail(w, r, err)
		return
	}

	// The product comes from configuration keyed by the attested subject.
	// There is deliberately no `product` parameter: one would let a caller ask
	// about an audience it is not in.
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		h.fail(w, r, errNoPrincipal)
		return
	}
	productID, scoped := h.scope.ProductFor(principal.Subject)
	if !scoped {
		// Refused, not served unscoped. An unmapped machine has no product, so
		// there is no honest set of announcements to return — and the
		// tempting fallback, "everything untargeted", would be a different
		// answer dressed as the same one.
		h.log.ErrorContext(r.Context(),
			"an announcements caller resolves to no product — PRODUCT_SCOPE_* is missing an entry for this subject",
			slog.String("subject", principal.Subject))
		h.fail(w, r, errUnscopedMachine)
		return
	}

	// NO TENANT. Announcements are a broadcast filtered by lifecycle STATUS,
	// not a per-tenant resource — which is why this does not use the tickets
	// module's tenant rule. The status is asserted by the product, the same
	// trust model as the tenant there.
	status := query.Get("tenant_status")
	if status == "" {
		status = defaultTenantStatus
	}

	payload, err := h.svc.Active(r.Context(), productID, status)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	var envelope httpx.Error
	switch {
	case errors.As(err, &envelope):
	case errors.Is(err, errUnscopedMachine), errors.Is(err, errNoPrincipal):
		// 403, for the reason the tickets module learned in production: a
		// configuration refusal reported as a fault sends an operator to the
		// database instead of to PRODUCT_SCOPE_*.
		envelope = httpx.Forbidden("this caller is not configured for any product")
	default:
		envelope = httpx.Internal("request failed")
	}
	httpx.WriteError(w, r, envelope, h.log)
}

// ---- authoring ----------------------------------------------------------

func (h *Handler) listAuthored(w http.ResponseWriter, r *http.Request) {
	if err := httpx.RejectUnknownParameters(r.URL.Query(), nil); err != nil {
		h.fail(w, r, err)
		return
	}
	payload, err := h.svc.ListAuthored(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, payload, h.log)
}

type createRequest struct {
	Title    string `json:"title"`
	Body     string `json:"body"`
	Severity string `json:"severity"`
	// AudienceFilter is passed through unparsed — see domain.Authored.
	AudienceFilter map[string]any `json:"audience_filter"`
	StartsAt       *time.Time     `json:"starts_at"`
	EndsAt         *time.Time     `json:"ends_at"`
	// Publish is the SEND. Absent means draft, which is why this is not
	// spelled `is_published`: the request says what to do, the row says what
	// state it is in, and conflating them is how a typo becomes a broadcast.
	Publish bool `json:"publish"`
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	var request createRequest
	if err := json.Unmarshal(body, &request); err != nil {
		h.fail(w, r, httpx.BadRequest("the request body is not valid JSON"))
		return
	}

	key, err := h.readKey(r, principal, "announcements.create", body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.Create(r.Context(), principal.Subject, service.CreateInput{
		Title:          request.Title,
		Body:           request.Body,
		Severity:       request.Severity,
		AudienceFilter: request.AudienceFilter,
		StartsAt:       request.StartsAt,
		EndsAt:         request.EndsAt,
		IsPublished:    request.Publish,
	}, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

type updateRequest struct {
	Title    *string `json:"title"`
	Body     *string `json:"body"`
	Severity *string `json:"severity"`
	// EndsAt is read through a pointer-to-pointer idiom below: whether the KEY
	// was present is what distinguishes "clear the end date" from "leave it".
	EndsAt  *time.Time `json:"ends_at"`
	Publish *bool      `json:"publish"`
}

func (h *Handler) update(w http.ResponseWriter, r *http.Request) {
	principal, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}
	var request updateRequest
	if err := json.Unmarshal(body, &request); err != nil {
		h.fail(w, r, httpx.BadRequest("the request body is not valid JSON"))
		return
	}

	// Whether `ends_at` was SENT, not whether it was non-null. A caller that
	// sends `"ends_at": null` is expiring nothing and clearing the end date; a
	// caller that omits it is not talking about the end date at all.
	var present map[string]json.RawMessage
	_ = json.Unmarshal(body, &present)
	_, endsAtSent := present["ends_at"]

	key, err := h.readKey(r, principal, "announcements.update", body)
	if err != nil {
		h.fail(w, r, err)
		return
	}

	written, err := h.svc.Update(r.Context(), principal.Subject, r.PathValue("id"), service.UpdateInput{
		Title:       request.Title,
		Body:        request.Body,
		Severity:    request.Severity,
		EndsAtSet:   endsAtSent,
		EndsAt:      request.EndsAt,
		IsPublished: request.Publish,
	}, key)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteData(w, r, written.Status, written.Body, h.log)
}

// beginWrite resolves the principal and reads the body once.
func (h *Handler) beginWrite(w http.ResponseWriter, r *http.Request) (*auth.Principal, []byte, bool) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		h.log.ErrorContext(r.Context(), "a write route ran without a principal",
			slog.String("path", r.URL.Path))
		h.fail(w, r, errNoPrincipal)
		return nil, nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		h.fail(w, r, httpx.BadRequest("the request body could not be read"))
		return nil, nil, false
	}
	return principal, body, true
}

// readKey returns the caller's idempotency key, or nil if it sent none.
//
// The `asked` bool is why this is not a one-liner: an absent header is not a
// key, and passing a zero Key through would make every request its own replay
// candidate under the same empty value.
func (h *Handler) readKey(r *http.Request, principal *auth.Principal, operation string, body []byte) (*idempotency.Key, error) {
	key, asked, err := idempotency.FromRequest(r, principal.Subject, operation, body)
	if err != nil {
		return nil, err
	}
	if !asked {
		return nil, nil
	}
	return &key, nil
}
