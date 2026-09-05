// Package handler is the email templates module's HTTP surface.
//
//	GET  /v1/email-templates                the estate registry
//	     ?source=<slug>                     narrow to one product
//	GET  /v1/email-templates/{id}           one template, bodies included
//	PUT  /v1/email-templates/{id}           save it
//	POST /v1/email-templates/{id}/test-send send a real one
//
// `{id}` is `<source>:<key>`. See domain.Row for why the key alone is not it.
//
// # The route shape, and the second source
//
// Only one product serves this registry today, and one already on the way is
// not a product but a SECOND SERVICE OF THE SAME ONE: mark8ly keeps its
// transactional templates in two services with mirrored tables, and federation
// reaches only marketplace-api. The auth mails — `password_reset`,
// `invitation`, `login_otp` — live in mark8ly's platform-api, which mark8ly#720
// will federate as its own slug.
//
// So the source is an AXIS of this surface from the first commit, not a
// parameter added later: a `?source=` filter on the listing and a namespaced
// id everywhere else. Adding the second source is then a registry declaration
// and nothing more — no path changes, no new routes, no client change beyond
// rendering a source it has already been given. The alternative shape,
// `/v1/email-templates/{key}`, is a single-source contract wearing a general
// name: the day the second registry arrives, either two products' `welcome`
// collide or every path in the console changes, and §4 makes the second of
// those a new version.
//
// This is the same answer the estate has already given three times — the
// audit, tenants and inbox modules all merge by source and namespace their ids
// — rather than a new one invented here.
//
// # The capabilities are `platform`, and `mass-send` for the test send
//
// `packages/console-core/src/routes.ts` declares `mark8ly.emailTemplates` as
// `platform`, matching every other `mark8ly.*` route: this is an estate
// operator reading and writing one product's records. The test send is the
// exception it names in the same breath — authoring a template is not sending
// one — so that route asserts `mass-send` on top, stacked the way the
// announcements module stacks the same pair for a broadcast.
package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/emailtemplates/internal/service"
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

// Route is one of the module's paths. Send marks the one route that puts a
// real email in front of a person, which is what earns the extra gate.
type Route struct {
	Method  string
	Pattern string
	// Write says the route carries a body and requires an Idempotency-Key.
	Write bool
	// Send says the route performs a send and gates on `mass-send` as well.
	Send    bool
	handler func(*Handler) http.HandlerFunc
}

// RouteTable is every route this module serves, and the ONLY place they are
// declared. Registration reads it, and capability_test ranges over it and
// fails on an entry it has no case for — so a route added without a capability
// decision turns the suite red rather than passing untested.
var RouteTable = []Route{
	{Method: http.MethodGet, Pattern: "/v1/email-templates",
		handler: func(h *Handler) http.HandlerFunc { return h.list }},
	{Method: http.MethodGet, Pattern: "/v1/email-templates/{id}",
		handler: func(h *Handler) http.HandlerFunc { return h.get }},
	{Method: http.MethodPut, Pattern: "/v1/email-templates/{id}", Write: true,
		handler: func(h *Handler) http.HandlerFunc { return h.save }},
	{Method: http.MethodPost, Pattern: "/v1/email-templates/{id}/test-send", Write: true, Send: true,
		handler: func(h *Handler) http.HandlerFunc { return h.testSend }},
}

// listParameters is every query parameter the listing reads. Anything else is
// a 400 — a rejected typo is cheaper than a filter that silently did nothing,
// and `?soruce=mark8ly` would otherwise return the whole estate and a 200.
var listParameters = []string{"source"}

// noParameters: the single-template routes take none, so any query string is
// refused. Stricter than it looks and right — there is nothing to ask for, so
// `?source=mark8ly` beside an id that already names one is a caller with a
// wrong model of this surface, and the two could disagree.
var noParameters = []string{}

// maxBodyBytes bounds a write. An HTML email body is the largest thing this
// surface carries; a megabyte is generous for one and small enough that
// somebody else's bug does not become this process's memory problem.
const maxBodyBytes = 1 << 20

// Routes mounts the table behind its gates.
func (h *Handler) Routes(mux *http.ServeMux, verifier *auth.Verifier) {
	surface := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapPlatform, h.log, handler))
	}
	// The surface AND the verb, stacked the way the tickets module stacks
	// support and respond: the surface says where an operator works, the verb
	// says they may do the irrevocable thing there. A test send is irrevocable
	// — it leaves the estate — and an operator who may author copy has not
	// thereby been granted permission to email anyone.
	send := func(handler http.HandlerFunc) http.Handler {
		return auth.Authenticate(verifier, h.log,
			auth.RequireCapability(auth.CapPlatform, h.log,
				auth.RequireCapability(auth.CapMassSend, h.log, handler)))
	}
	for _, r := range RouteTable {
		gate := surface
		if r.Send {
			gate = send
		}
		mux.Handle(r.Method+" "+r.Pattern, gate(r.handler(h)))
	}
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	op, ok := h.operator(w, r)
	if !ok {
		return
	}

	query := r.URL.Query()
	if err := httpx.RejectUnknownParameters(query, listParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	page, err := h.svc.List(r.Context(), op, strings.TrimSpace(query.Get("source")))
	if err != nil {
		h.fail(w, r, "list", err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, page, h.log)
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	op, ok := h.operator(w, r)
	if !ok {
		return
	}
	if err := httpx.RejectUnknownParameters(r.URL.Query(), noParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	detail, err := h.svc.Get(r.Context(), op, r.PathValue("id"))
	if err != nil {
		h.fail(w, r, "read", err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, map[string]any{"template": detail}, h.log)
}

func (h *Handler) save(w http.ResponseWriter, r *http.Request) {
	op, key, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}

	var in service.Upsert
	if err := decode(body, &in); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}

	detail, err := h.svc.Save(r.Context(), op, r.PathValue("id"), in, key)
	if err != nil {
		h.fail(w, r, "save", err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, map[string]any{"template": detail}, h.log)
}

func (h *Handler) testSend(w http.ResponseWriter, r *http.Request) {
	op, key, body, ok := h.beginWrite(w, r)
	if !ok {
		return
	}

	var in service.TestSendRequest
	if err := decode(body, &in); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return
	}
	// Refused here rather than left to the product, because the product's
	// refusal arrives as a bare code and this one has an obvious sentence. The
	// ADDRESS is not validated beyond being present: what a mail provider
	// accepts is not a regexp anyone here should own.
	if strings.TrimSpace(in.To) == "" {
		httpx.WriteError(w, r, httpx.BadRequest("to is required: a test send needs a recipient"), h.log)
		return
	}

	sent, err := h.svc.TestSend(r.Context(), op, r.PathValue("id"), in, key)
	if err != nil {
		h.fail(w, r, "test send", err)
		return
	}
	httpx.WriteData(w, r, http.StatusOK, map[string]any{"test_send": sent}, h.log)
}

// operator resolves who the call is made on behalf of.
//
// The capability is the SURFACE one on every route including the test send:
// it is the authority the product records the action under, and `platform` is
// what mark8ly's middleware checks. `mass-send` is this service's own gate on
// who may reach the route, not a second authority to sign with.
func (h *Handler) operator(w http.ResponseWriter, r *http.Request) (federation.Operator, bool) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		// Fail closed, before any work. Unreachable behind Authenticate in
		// production; if a route is ever mounted without it, the refusal must
		// come before the service is touched — otherwise status codes alone
		// tell an unverified caller which product slugs exist.
		httpx.WriteError(w, r, httpx.Unauthorized("no principal on an authenticated route"), h.log)
		return federation.Operator{}, false
	}
	// Taken from the verified session and never from anything the client
	// supplied. It is signed into the federated request, and mark8ly stamps
	// `updated_by` from it — which is why the write body carries no operator
	// id and mark8ly ignores one that is sent.
	return federation.Operator{ID: principal.Subject, Capability: string(auth.CapPlatform)}, true
}

// beginWrite does what both writes need before they differ: the principal, the
// idempotency key, and the bounded body.
func (h *Handler) beginWrite(w http.ResponseWriter, r *http.Request) (federation.Operator, string, []byte, bool) {
	op, ok := h.operator(w, r)
	if !ok {
		return federation.Operator{}, "", nil, false
	}
	if err := httpx.RejectUnknownParameters(r.URL.Query(), noParameters); err != nil {
		httpx.WriteError(w, r, err, h.log)
		return federation.Operator{}, "", nil, false
	}

	// Required, and refused rather than generated. A key this service invented
	// would be fresh on every retry, which is the same as having none — the
	// uniqueness that matters is of the CALLER's intent, and only the caller
	// can assert it. The tenants module refuses the same way.
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		httpx.WriteError(w, r,
			httpx.BadRequest("the Idempotency-Key header is required for this write"), h.log)
		return federation.Operator{}, "", nil, false
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("the request body could not be read"), h.log)
		return federation.Operator{}, "", nil, false
	}
	return op, key, body, true
}

// decode parses a body, rejecting anything the struct does not declare (§4).
// An unknown field today is a field this service might mean something by
// tomorrow, and a caller sending `htmlBody` — the spelling the console's old
// cross-DB route used — must be told rather than have it silently dropped and
// the template saved with an empty body.
func decode(body []byte, into any) error {
	if len(body) == 0 {
		return httpx.BadRequest("a request body is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return httpx.BadRequest("the request body is not the expected JSON: " + err.Error())
	}
	return nil
}

// fail maps a failed federated call onto a status and a sentence.
//
// # The three answers that must not collapse into one
//
//   - 501 NOT_IMPLEMENTED — nothing was ever wired, or the product does not
//     serve this endpoint. `surface-state.ts` renders exactly this status as a
//     calm "not measured yet" callout; every other non-2xx is a red error.
//   - 503 SERVICE_UNAVAILABLE — configured, and could not be reached. A real
//     fault, and the console shows it as one.
//   - 503 EXTERNAL_SERVICE_ERROR — reached, and it answered with a failure of
//     its own. Same status, different code and different sentence, because the
//     operator's next step differs: check the product, not the network.
//
// §1c writes the first two as 501/502, and that section governs the console's
// own `/api/admin/*` proxy routes rather than this service — this kernel has
// no 502, and the tenants module records why: "the owning product could not be
// reached" is what 503 already means here. The console's proxy is where 502 is
// spelled; the distinction §1c exists to preserve survives either way, because
// it is carried by the STATUS and not by a body field.
//
// The product's §4.4 error code is mapped rather than echoed. It is a stable
// machine-readable identifier by contract, unlike its sibling `message`, which
// is free text from another product and is never rendered.
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, verb string, err error) {
	// Logged with the unredacted error: a failed save or send is exactly what
	// somebody asks about afterwards, and the wire-facing sentence is coarse
	// on purpose.
	h.log.ErrorContext(r.Context(), "emailtemplates: "+verb+" failed",
		"id", r.PathValue("id"), "error", err)

	switch {
	case errors.Is(err, service.ErrNotInstrumented):
		httpx.WriteError(w, r, httpx.NotImplemented(err.Error()), h.log)
		return
	case errors.Is(err, service.ErrUnknownSource), errors.Is(err, service.ErrMalformedID):
		httpx.WriteError(w, r, httpx.BadRequest(err.Error()), h.log)
		return
	case errors.Is(err, federation.ErrProductNotConfigured):
		httpx.WriteError(w, r, httpx.NotImplemented(
			"this deployment cannot reach the product that owns this template"), h.log)
		return
	}

	status, hasStatus := federation.StatusOf(err)
	code, hasCode := federation.ErrorCode(err)

	if hasStatus && !hasCode {
		// The product answered, and what it said carried no contract envelope.
		// A 404 here is the shape a route that is NOT MOUNTED has — mark8ly
		// mounts the PUT only when it can attribute the write to an operator,
		// and gin answers an unmounted method with a bare 404 — so this is
		// "the product does not serve this", not "no such template". A
		// template that genuinely does not exist arrives as `unknown_key`
		// below.
		if status == http.StatusNotFound {
			httpx.WriteError(w, r, httpx.NotImplemented(
				"the product does not serve this email template endpoint"), h.log)
			return
		}
		httpx.WriteError(w, r, httpx.ExternalService(
			"the product could not "+verb+" this template"), h.log)
		return
	}

	switch code {
	case "unknown_key":
		httpx.WriteError(w, r, httpx.NotFound(
			"no template is stored or registered under this key — keys are owned by the product's code"), h.log)
	case "invalid_template":
		// 422: the request is well-formed and the product declined it. The
		// product's own `problems` list does NOT reach here — federation keeps
		// the code and discards the free-text body — so the sentence says
		// where the detail is rather than pretending to carry it.
		httpx.WriteError(w, r, httpx.Validation(
			"the product rejected this template: check the subject and both bodies for unbalanced {{ }} "+
				"or an unparseable template expression", nil), h.log)
	case "invalid_status":
		httpx.WriteError(w, r, httpx.Validation(
			"status must be draft or published", nil), h.log)
	case "render_failed":
		httpx.WriteError(w, r, httpx.Validation(
			"the template could not be rendered for a test send — a variable it uses was not supplied", nil), h.log)
	case "invalid_recipient":
		httpx.WriteError(w, r, httpx.BadRequest("the product rejected the recipient address"), h.log)
	case "not_configured":
		// The product SAYING it is not switched on — no template registry
		// wired, or no send provider key. 501 rather than 503 for exactly the
		// reason §1c gives, and the same call the tenants module makes when a
		// product publishes no lifecycle reason codes.
		httpx.WriteError(w, r, httpx.NotImplemented(
			"the product has no email sending configured, so a test send cannot be made"), h.log)
	case "send_failed":
		httpx.WriteError(w, r, httpx.ExternalService(
			"the email provider rejected the test send"), h.log)
	case "":
		// No status and no code: never reached the product at all — DNS, TLS,
		// a timeout. Deliberately NOT err.Error(): a transport failure's text
		// carries hostnames and addresses, which is why the federation package
		// sanitises at all.
		httpx.WriteError(w, r, httpx.Unavailable(
			"the product that owns this template could not be reached"), h.log)
	default:
		// A code this surface has no sentence for. Passed through rather than
		// swallowed: an operator staring at a form needs SOMETHING to search
		// for, and the code is contract-stable text.
		httpx.WriteError(w, r, httpx.ExternalService(
			"the product refused this "+verb+": "+code), h.log)
	}
}
