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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/conversions"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
	productSlug     = "mark8ly"
	route           = "/v1/conversions"
)

// A conversion as mark8ly serves it — `conversionResponse` in its
// platformadmin package.
const liveConversion = `{"state":"complete","ref":"tnt_01H","label":"Acme Studio",` +
	`"observed_at":"2026-09-03T02:00:00Z"}`

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject:  subjectOperator,
		Audience: []string{projectID}, Issuer: "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour), Roles: roles,
	}
}

type api struct {
	handler http.Handler
	t       *testing.T
}

func serve(t *testing.T) *api {
	t.Helper()
	return serveProduct(t, http.StatusOK, liveConversion, []string{productSlug}, "crm")
}

// serveProduct mounts the module through httpx.RegisterModule — what
// cmd/server composes — over a product answering the given status and body.
func serveProduct(t *testing.T, status int, body string, slugs []string, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(product.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: product.URL, Secret: "test-secret",
			Endpoints: []string{"conversions"}},
	}), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	httpx.RegisterModule(mux, verifier, "conversions", func(m *http.ServeMux) {
		conversions.Register(m, conversions.Config{
			Fed: fed, Slugs: slugs, Verifier: verifier, Log: log,
		})
	})
	return &api{handler: httpx.WithMiddleware(mux), t: t}
}

type response struct {
	status int
	raw    string
}

func (a *api) get(path string) response {
	a.t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	return response{status: rec.Code, raw: rec.Body.String()}
}

func TestAnswersWithTheProductsOwnBody(t *testing.T) {
	got := serve(t).get(route + "?source=mark8ly&email=owner%40example.com")

	if got.status != http.StatusOK {
		t.Fatalf("status = %d, body = %s", got.status, got.raw)
	}
	var envelope struct{ Data json.RawMessage }
	if err := json.Unmarshal([]byte(got.raw), &envelope); err != nil {
		t.Fatalf("response is not an envelope: %v (%s)", err, got.raw)
	}
	if string(envelope.Data) != liveConversion {
		t.Errorf("data was rewritten\n got: %s\nwant: %s", envelope.Data, liveConversion)
	}
}

func TestBothParametersAreRequired(t *testing.T) {
	for _, tc := range []struct{ name, query string }{
		{"no source", "?email=owner%40example.com"},
		{"no email", "?source=mark8ly"},
		{"blank source", "?source=%20&email=owner%40example.com"},
		{"blank email", "?source=mark8ly&email=%20"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := serve(t).get(route + tc.query); got.status != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 (%s)", got.status, got.raw)
			}
		})
	}
}

func TestAnUnknownParameterIsRefused(t *testing.T) {
	got := serve(t).get(route + "?source=mark8ly&email=a%40b.com&tenant=sneaky")
	if got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (%s)", got.status, got.raw)
	}
}

// The gate is `crm`, not `platform`: the caller is an operator working leads
// in the Handoff tab, and gating on `platform` would mean someone who can work
// the CRM cannot see whether their own leads converted.
func TestTheGateIsCRM(t *testing.T) {
	withCRM := serveProduct(t, http.StatusOK, liveConversion, []string{productSlug}, "crm")
	if got := withCRM.get(route + "?source=mark8ly&email=a%40b.com"); got.status != http.StatusOK {
		t.Errorf("an operator holding crm was refused: %d %s", got.status, got.raw)
	}

	withoutCRM := serveProduct(t, http.StatusOK, liveConversion, []string{productSlug}, "platform")
	got := withoutCRM.get(route + "?source=mark8ly&email=a%40b.com")
	if got.status != http.StatusForbidden {
		t.Errorf("status = %d, want 403 for an operator without crm (%s)", got.status, got.raw)
	}
}

// Ruling 28's rule, enforced on this side of the wire: whatever went wrong,
// the response must not carry a state the console could read as an answer.
func TestNoFailureCarriesAState(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		body     string
		slugs    []string
		source   string
		wantCode int
	}{
		{"product not declared", http.StatusOK, liveConversion,
			[]string{productSlug}, "kora", http.StatusBadRequest},
		{"nothing declares conversions", http.StatusOK, liveConversion,
			nil, "mark8ly", http.StatusNotImplemented},
		{"declared but not mounted", http.StatusNotFound, `{"error":"not_found"}`,
			[]string{productSlug}, "mark8ly", http.StatusNotFound},
		{"product declines", http.StatusNotImplemented, `{"error":"not_implemented"}`,
			[]string{productSlug}, "mark8ly", http.StatusNotImplemented},
		{"upstream 500", http.StatusInternalServerError, `{"error":"boom"}`,
			[]string{productSlug}, "mark8ly", http.StatusServiceUnavailable},
		{"signature rejected", http.StatusUnauthorized, `{"error":"unauthenticated"}`,
			[]string{productSlug}, "mark8ly", http.StatusServiceUnavailable},
		{"a 200 that is not an answer", http.StatusOK, `<html>gateway</html>`,
			[]string{productSlug}, "mark8ly", http.StatusServiceUnavailable},
		{"a 200 with an invented state", http.StatusOK, `{"state":"maybe","observed_at":"x"}`,
			[]string{productSlug}, "mark8ly", http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := serveProduct(t, tc.status, tc.body, tc.slugs, "crm")
			got := a.get(route + "?source=" + tc.source + "&email=a%40b.com")

			if got.status != tc.wantCode {
				t.Errorf("status = %d, want %d (%s)", got.status, tc.wantCode, got.raw)
			}
			if got.status == http.StatusOK {
				t.Fatalf("a failure answered 200: %s", got.raw)
			}
			// The one thing every branch must have in common.
			var envelope struct {
				Data *struct {
					State string `json:"state"`
				} `json:"data"`
			}
			_ = json.Unmarshal([]byte(got.raw), &envelope)
			if envelope.Data != nil && envelope.Data.State != "" {
				t.Errorf("a failure carried state %q: %s", envelope.Data.State, got.raw)
			}
		})
	}
}

// The lead's address and the product's account label are PII. A failure
// response is written from the handler's own strings, so neither can be
// reflected back into a body that gets logged or screenshotted.
func TestAFailureEchoesNeitherTheEmailNorTheProductsBody(t *testing.T) {
	a := serveProduct(t, http.StatusInternalServerError,
		`{"error":"boom","owner":"leaked@example.com","label":"Acme Studio"}`,
		[]string{productSlug}, "crm")

	got := a.get(route + "?source=mark8ly&email=lead%40example.com")

	for _, secret := range []string{"lead@example.com", "leaked@example.com", "Acme Studio"} {
		if strings.Contains(got.raw, secret) {
			t.Errorf("response echoed %q: %s", secret, got.raw)
		}
	}
}
