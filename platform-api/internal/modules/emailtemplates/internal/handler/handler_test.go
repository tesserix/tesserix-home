package handler_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/emailtemplates"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// The module is exercised through its REAL router, its real verifier and a
// real (httptest) product standing in for mark8ly. Only the token's signature
// is faked.
//
// The product's responses below are mark8ly's OWN golden files, copied
// verbatim from
// services/marketplace-api/internal/handlers/platformadmin/testdata/. A stub
// invented here would agree with whatever this author believed the contract
// was; these bytes are what the other repo pins.

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
	productSlug     = "mark8ly"

	// The list, three rows covering all three states.
	productListBody = `{"data":[` +
		`{"key":"dunning_day_5","state":"unauthored","sends_from":"embedded","has_embedded_default":true,"subject":"Payment failed for {{.StoreName}}"},` +
		`{"key":"giftcard_delivery","state":"draft","sends_from":"embedded","has_embedded_default":true,"subject":"Your gift card from {{.StoreName}}","version":7,"updated_at":"2026-08-20T16:45:00Z"},` +
		`{"key":"orderdoc_invoice","state":"published","sends_from":"row","has_embedded_default":true,"subject":"Order {{.OrderNumber}}","version":3,"updated_at":"2026-08-01T09:30:00Z","updated_by":"op_previous"}` +
		`]}`

	productDetailBody = `{"data":{"key":"orderdoc_invoice","state":"published","sends_from":"row",` +
		`"has_embedded_default":true,"subject":"Order {{.OrderNumber}}","version":3,` +
		`"updated_at":"2026-08-01T09:30:00Z","updated_by":"op_previous",` +
		`"html_body":"<p>{{.OrderNumber}}</p>","text_body":"{{.OrderNumber}}",` +
		`"variables":[{"name":"OrderNumber","type":"string","required":true}]}}`
)

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject:   subjectOperator,
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour),
		Roles:     roles,
	}
}

// call is one request the stub product received.
type call struct {
	method  string
	url     string
	body    string
	headers http.Header
}

type api struct {
	handler http.Handler
	t       *testing.T
	calls   chan call
}

// product is the default stub: mark8ly's own responses, keyed the way its
// handler keys them.
func product(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/admin/email-templates":
		_, _ = w.Write([]byte(productListBody))
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/admin/email-templates/"):
		_, _ = w.Write([]byte(productDetailBody))
	case r.Method == http.MethodPut:
		_, _ = w.Write([]byte(productDetailBody))
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/test-send"):
		_, _ = w.Write([]byte(`{"data":{"key":"orderdoc_invoice","to":"ops@tesserix.app","sent":true}}`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// refusing answers every request with one §4.4 refusal, so a test can pin what
// this surface makes of it.
func refusing(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

func serve(t *testing.T) *api {
	t.Helper()
	return serveWith(t, http.HandlerFunc(product), []string{productSlug}, "platform", "mass-send")
}

// serveNoProducts mounts the module with an EMPTY declaration: the shape every
// deployment is in until `email-templates` is added to
// FEDERATION_<SLUG>_ENDPOINTS.
func serveNoProducts(t *testing.T) *api {
	t.Helper()
	return serveWith(t, http.HandlerFunc(product), nil, "platform", "mass-send")
}

func serveWith(t *testing.T, upstream http.Handler, slugs []string, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	calls := make(chan call, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls <- call{method: r.Method, url: r.URL.String(), body: string(body), headers: r.Header.Clone()}
		upstream.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: srv.URL, Secret: "test-secret"},
	}), srv.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	// Through RegisterModule and the module's own Register, because that is
	// where the "no verifier, no module" guard lives — composing what
	// cmd/server composes.
	httpx.RegisterModule(mux, verifier, "emailtemplates", func(m *http.ServeMux) {
		emailtemplates.Register(m, emailtemplates.Config{
			Fed: fed, Slugs: slugs, Verifier: verifier, Log: log,
		})
	})

	return &api{handler: httpx.WithMiddleware(mux), t: t, calls: calls}
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (a *api) do(method, path, body string, headers map[string]string) response {
	a.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	out := response{status: rec.Code, raw: rec.Body.String()}
	// Every answer is enveloped, refusals included, so a body that will not
	// parse is a finding rather than an inconvenience.
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("%s %s: response is not JSON: %v (%s)", method, path, err, out.raw)
	}
	return out
}

func (a *api) get(path string) response { a.t.Helper(); return a.do(http.MethodGet, path, "", nil) }

func (a *api) put(path, body string) response {
	a.t.Helper()
	return a.do(http.MethodPut, path, body, map[string]string{"Idempotency-Key": "k-1"})
}

func (a *api) testSend(path, body string) response {
	a.t.Helper()
	return a.do(http.MethodPost, path, body, map[string]string{"Idempotency-Key": "k-1"})
}

func (a *api) lastCall() (call, bool) {
	a.t.Helper()
	var last call
	var seen bool
	for {
		select {
		case c := <-a.calls:
			last, seen = c, true
		default:
			return last, seen
		}
	}
}

func (r response) data(t *testing.T) map[string]any {
	t.Helper()
	if r.body["success"] != true {
		t.Fatalf("not a success: %s", r.raw)
	}
	data, ok := r.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is not an object: %s", r.raw)
	}
	return data
}

func (r response) errorCode(t *testing.T) string {
	t.Helper()
	body, ok := r.body["error"].(map[string]any)
	if !ok {
		t.Fatalf("no error object: %s", r.raw)
	}
	code, _ := body["code"].(string)
	return code
}

const invoiceID = productSlug + ":orderdoc_invoice"

// --- the listing -----------------------------------------------------------

func TestListReturnsEveryRegisteredKeyNamespacedByItsSource(t *testing.T) {
	a := serve(t)
	got := a.get("/v1/email-templates")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	rows, _ := got.data(t)["templates"].([]any)
	if len(rows) != 3 {
		t.Fatalf("templates = %v, want the product's three: %s", rows, got.raw)
	}
	first, _ := rows[0].(map[string]any)
	if first["id"] != productSlug+":dunning_day_5" {
		t.Errorf("id = %v, want the source-namespaced key", first["id"])
	}
	if first["source"] != productSlug {
		t.Errorf("source = %v, want %q stamped from the slug called", first["source"], productSlug)
	}
	if first["key"] != "dunning_day_5" {
		t.Errorf("key = %v, want the product's own unqualified key", first["key"])
	}
}

// The two axes are orthogonal and both survive the hop. A draft row and an
// absent row are different things and both send the embedded default; a
// console that received one collapsed field could not tell them apart.
func TestListKeepsStateAndSendsFromAsSeparateFields(t *testing.T) {
	a := serve(t)
	rows, _ := a.get("/v1/email-templates").data(t)["templates"].([]any)

	byKey := map[string]map[string]any{}
	for _, r := range rows {
		row, _ := r.(map[string]any)
		byKey[row["key"].(string)] = row
	}

	for _, want := range []struct{ key, state, sendsFrom string }{
		{"dunning_day_5", "unauthored", "embedded"},
		{"giftcard_delivery", "draft", "embedded"},
		{"orderdoc_invoice", "published", "row"},
	} {
		row := byKey[want.key]
		if row["state"] != want.state {
			t.Errorf("%s state = %v, want %q", want.key, row["state"], want.state)
		}
		if row["sends_from"] != want.sendsFrom {
			t.Errorf("%s sends_from = %v, want %q", want.key, row["sends_from"], want.sendsFrom)
		}
	}
}

// Absent, not zeroed. A version of 0 beside a template that is sending
// perfectly well reads as a broken row.
func TestListOmitsVersionAndAttributionForAnUnauthoredKey(t *testing.T) {
	a := serve(t)
	rows, _ := a.get("/v1/email-templates").data(t)["templates"].([]any)
	first, _ := rows[0].(map[string]any)
	for _, field := range []string{"version", "updated_at", "updated_by"} {
		if _, present := first[field]; present {
			t.Errorf("unauthored row carries %q = %v; it should be absent", field, first[field])
		}
	}
}

func TestListRendersEmptyCollectionsAsArrays(t *testing.T) {
	a := serveWith(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}), []string{productSlug}, "platform")

	data := a.get("/v1/email-templates").data(t)
	if _, ok := data["templates"].([]any); !ok {
		t.Errorf("templates is not an array: %v", data["templates"])
	}
	if _, ok := data["failures"].([]any); !ok {
		t.Errorf("failures is not an array: %v", data["failures"])
	}
}

// A failed federated read must not look like an empty registry. The status
// stays 200 because a partial listing is still a listing — the failures array
// is what makes the gap honest, and it is the only thing that can.
func TestListReportsAFailedSourceRatherThanAnEmptyRegistry(t *testing.T) {
	a := serveWith(t, refusing(http.StatusInternalServerError, `{"error":"internal_error"}`),
		[]string{productSlug}, "platform")

	got := a.get("/v1/email-templates")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200 with a failure listed: %s", got.status, got.raw)
	}
	data := got.data(t)
	failures, _ := data["failures"].([]any)
	if len(failures) != 1 {
		t.Fatalf("failures = %v, want the one source that failed: %s", data["failures"], got.raw)
	}
	failure, _ := failures[0].(map[string]any)
	if failure["source"] != productSlug {
		t.Errorf("failure source = %v, want %q", failure["source"], productSlug)
	}
	if !strings.Contains(failure["message"].(string), "500") {
		t.Errorf("failure message = %v; the status is the one detail an operator can act on",
			failure["message"])
	}
}

func TestListRejectsUnknownParameters(t *testing.T) {
	if got := serve(t).get("/v1/email-templates?sorce=mark8ly"); got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 — a filter that silently did nothing is worse: %s",
			got.status, got.raw)
	}
}

func TestListRefusesAnUnknownSource(t *testing.T) {
	got := serve(t).get("/v1/email-templates?source=nosuchproduct")
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 — answered empty, a typo reads as 'that product has none': %s",
			got.status, got.raw)
	}
}

// 501, and this is the deployed state until `email-templates` is added to
// FEDERATION_MARK8LY_ENDPOINTS. The console renders 501 as "not wired yet" and
// every other non-2xx as an error; a parked surface must not read as a broken
// one.
func TestEveryRouteIsNotImplementedWhenNoProductDeclaresTheEndpoint(t *testing.T) {
	a := serveNoProducts(t)
	cases := []response{
		a.get("/v1/email-templates"),
		a.get("/v1/email-templates/" + invoiceID),
		a.put("/v1/email-templates/"+invoiceID, `{"subject":"s","html_body":"h","text_body":"t","status":"draft"}`),
		a.testSend("/v1/email-templates/"+invoiceID+"/test-send", `{"to":"ops@tesserix.app"}`),
	}
	for i, got := range cases {
		if got.status != http.StatusNotImplemented {
			t.Errorf("case %d: status = %d, want 501: %s", i, got.status, got.raw)
		}
	}
}

// The distinction 501 exists to carry, asserted as the PAIR: not configured is
// 501, configured and unreachable is 503. A surface that answers one status
// for both has lost it.
func TestAConfiguredButUnreachableProductIs503AndNot501(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close() // closed before use: nothing is listening.

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: dead.URL, Secret: "s"},
	}), dead.Client())
	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor("platform")}, projectID)
	httpx.RegisterModule(mux, verifier, "emailtemplates", func(m *http.ServeMux) {
		emailtemplates.Register(m, emailtemplates.Config{
			Fed: fed, Slugs: []string{productSlug}, Verifier: verifier, Log: log,
		})
	})
	a := &api{handler: httpx.WithMiddleware(mux), t: t}

	got := a.get("/v1/email-templates/" + invoiceID)
	if got.status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 — an unreachable product is a fault, not a parked surface: %s",
			got.status, got.raw)
	}
	// And the message carries no hostname: a transport error's text names
	// addresses, which is why the federation package sanitises at all.
	if strings.Contains(got.raw, dead.URL) {
		t.Errorf("the refusal leaked the product's address: %s", got.raw)
	}
}

// --- the single template ---------------------------------------------------

func TestGetReturnsTheBodiesAndTheDeclaredVariables(t *testing.T) {
	a := serve(t)
	got := a.get("/v1/email-templates/" + invoiceID)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	template, _ := got.data(t)["template"].(map[string]any)
	if template["html_body"] != "<p>{{.OrderNumber}}</p>" {
		t.Errorf("html_body = %v, want the product's raw template source", template["html_body"])
	}
	vars, _ := template["variables"].([]any)
	if len(vars) != 1 {
		t.Fatalf("variables = %v, want the one the product declares", template["variables"])
	}
	if template["id"] != invoiceID {
		t.Errorf("id = %v, want %q", template["id"], invoiceID)
	}
}

func TestGetAsksTheProductForTheKeyWithoutTheSourcePrefix(t *testing.T) {
	a := serve(t)
	a.get("/v1/email-templates/" + invoiceID)
	c, ok := a.lastCall()
	if !ok {
		t.Fatal("the product was never called")
	}
	if c.url != "/admin/email-templates/orderdoc_invoice" {
		t.Errorf("product asked %q; the source prefix is this surface's, not the product's", c.url)
	}
}

// A bare key names no product. Refused rather than guessed at — guessing means
// choosing a product to read from, and there is no safe default once a second
// source holds the same keys.
func TestAnIdWithNoSourceIsRefused(t *testing.T) {
	if got := serve(t).get("/v1/email-templates/orderdoc_invoice"); got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// The one place in this service where a path traversal would also be an
// authenticated, operator-attributed one: the key becomes a path segment on a
// SIGNED request to the product's platform admin prefix.
func TestAKeyThatIsNotAKeyNeverReachesTheProduct(t *testing.T) {
	a := serve(t)
	// PERCENT-ENCODED, which is the form that actually arrives at the handler:
	// net/http's ServeMux cleans a literal `..` out of the path before routing,
	// but it DECODES a segment before binding {id}, so `..%2F` reaches
	// PathValue as `../` inside one segment. That is the traversal this
	// surface has to refuse itself.
	for _, id := range []string{
		productSlug + ":..%2Ftenants%2Ft1%2Fsuspend",
		productSlug + ":orderdoc%20invoice",
		productSlug + ":",
	} {
		got := a.do(http.MethodGet, "/v1/email-templates/"+id, "", nil)
		if got.status != http.StatusBadRequest {
			t.Errorf("%q: status = %d, want 400: %s", id, got.status, got.raw)
		}
	}
	if c, called := a.lastCall(); called {
		t.Errorf("a refused key still reached the product: %s %s", c.method, c.url)
	}
}

// --- the write -------------------------------------------------------------

const validSave = `{"subject":"Order {{.OrderNumber}}","html_body":"<p>x</p>","text_body":"x",` +
	`"variables":[{"name":"OrderNumber","type":"string","required":true}],"status":"published"}`

func TestSaveForwardsThePutWithTheKeyAndTheIdempotencyHeader(t *testing.T) {
	a := serve(t)
	got := a.put("/v1/email-templates/"+invoiceID, validSave)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	c, ok := a.lastCall()
	if !ok {
		t.Fatal("the product was never called")
	}
	if c.method != http.MethodPut || c.url != "/admin/email-templates/orderdoc_invoice" {
		t.Errorf("product asked %s %s, want PUT /admin/email-templates/orderdoc_invoice", c.method, c.url)
	}
	if c.headers.Get("Idempotency-Key") != "k-1" {
		t.Errorf("Idempotency-Key = %q, want the caller's own key forwarded",
			c.headers.Get("Idempotency-Key"))
	}
}

// Refused rather than generated. A key this service invented would be fresh on
// every retry, which is the same as having none.
func TestAWriteWithoutAnIdempotencyKeyIsRefusedBeforeTheProductIsCalled(t *testing.T) {
	a := serve(t)
	got := a.do(http.MethodPut, "/v1/email-templates/"+invoiceID, validSave, nil)
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
	if c, called := a.lastCall(); called {
		t.Errorf("the write still reached the product: %s %s", c.method, c.url)
	}
}

// The operator id is signed, not sent. mark8ly stamps `updated_by` from the
// signed caller and ignores one in the body, so a body carrying one would be a
// field this surface accepts and nothing honours.
func TestSaveSendsNoOperatorIdInTheBodyAndSignsOneInstead(t *testing.T) {
	a := serve(t)
	a.put("/v1/email-templates/"+invoiceID, validSave)
	c, ok := a.lastCall()
	if !ok {
		t.Fatal("the product was never called")
	}
	if strings.Contains(c.body, "updated_by") || strings.Contains(c.body, subjectOperator) {
		t.Errorf("the write body carries an operator id: %s", c.body)
	}
	if c.headers.Get("X-Platform-Operator") != subjectOperator {
		t.Errorf("X-Platform-Operator = %q, want the verified subject %q",
			c.headers.Get("X-Platform-Operator"), subjectOperator)
	}
}

// §4: an unknown field today is a field this service might mean something by
// tomorrow. `htmlBody` is the spelling the console's old cross-DB route used,
// and silently dropping it would save a template with an empty body.
func TestSaveRefusesTheOldCamelCaseSpelling(t *testing.T) {
	a := serve(t)
	got := a.put("/v1/email-templates/"+invoiceID,
		`{"subject":"s","htmlBody":"<p>x</p>","text_body":"x","status":"draft"}`)
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
	if c, called := a.lastCall(); called {
		t.Errorf("a body this service does not accept still reached the product: %s", c.body)
	}
}

// --- the test send ---------------------------------------------------------

func TestTestSendReportsTheAddressItWasAskedFor(t *testing.T) {
	a := serve(t)
	got := a.testSend("/v1/email-templates/"+invoiceID+"/test-send", `{"to":"ops@tesserix.app"}`)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	sent, _ := got.data(t)["test_send"].(map[string]any)
	if sent["to"] != "ops@tesserix.app" || sent["sent"] != true {
		t.Errorf("test_send = %v, want the address asked for and sent:true", sent)
	}
}

func TestTestSendRequiresARecipient(t *testing.T) {
	a := serve(t)
	got := a.testSend("/v1/email-templates/"+invoiceID+"/test-send", `{"to":"  "}`)
	if got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
	if c, called := a.lastCall(); called {
		t.Errorf("a send with no recipient still reached the product: %s", c.body)
	}
}

// --- what a product's refusal becomes --------------------------------------

// Each upstream failure gets its own status and its own sentence. Collapsing
// them leaves an operator staring at a form with no idea which of "this key
// does not exist", "your braces are unbalanced" and "email is not switched on"
// happened.
func TestEachProductRefusalMapsToItsOwnAnswer(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		body       string
		wantStatus int
		wantCode   string
	}{
		{"unknown key", http.StatusNotFound, `{"error":"unknown_key","message":"no template"}`,
			http.StatusNotFound, httpx.CodeNotFound},
		{"bad template", http.StatusBadRequest, `{"error":"invalid_template","message":"subject: braces"}`,
			http.StatusUnprocessableEntity, httpx.CodeValidation},
		{"bad status", http.StatusBadRequest, `{"error":"invalid_status","message":"draft or published"}`,
			http.StatusUnprocessableEntity, httpx.CodeValidation},
		{"render failed", http.StatusUnprocessableEntity, `{"error":"render_failed","message":"no StoreName"}`,
			http.StatusUnprocessableEntity, httpx.CodeValidation},
		// The product SAYING it is not switched on. 501, not 503: no email
		// provider configured is a parked integration, not an outage.
		{"not configured", http.StatusServiceUnavailable, `{"error":"not_configured","message":"no sender"}`,
			http.StatusNotImplemented, httpx.CodeNotImplemented},
		// Reached, and it answered with a failure of its own.
		{"send failed", http.StatusBadGateway, `{"error":"send_failed","message":"provider said no"}`,
			http.StatusServiceUnavailable, httpx.CodeExternalService},
		// A bare 404 with no contract envelope is an UNMOUNTED route — which
		// is the shape mark8ly's PUT has when it cannot attribute a write —
		// not a missing template.
		{"route not mounted", http.StatusNotFound, `404 page not found`,
			http.StatusNotImplemented, httpx.CodeNotImplemented},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := serveWith(t, refusing(c.status, c.body), []string{productSlug}, "platform", "mass-send")
			got := a.testSend("/v1/email-templates/"+invoiceID+"/test-send", `{"to":"ops@tesserix.app"}`)
			if got.status != c.wantStatus {
				t.Fatalf("status = %d, want %d: %s", got.status, c.wantStatus, got.raw)
			}
			if code := got.errorCode(t); code != c.wantCode {
				t.Errorf("code = %q, want %q: %s", code, c.wantCode, got.raw)
			}
		})
	}
}

// The product's free-text message is another product's prose and never reaches
// a browser. Only its stable code informs the sentence.
func TestAProductsFreeTextMessageIsNeverRendered(t *testing.T) {
	a := serveWith(t, refusing(http.StatusBadRequest,
		`{"error":"invalid_template","message":"pg: relation email_templates does not exist"}`),
		[]string{productSlug}, "platform")

	got := a.put("/v1/email-templates/"+invoiceID, validSave)
	if strings.Contains(got.raw, "relation email_templates") {
		t.Errorf("the product's own text reached the response: %s", got.raw)
	}
}
