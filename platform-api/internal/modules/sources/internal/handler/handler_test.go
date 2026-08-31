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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/sources"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
	route           = "/v1/platform/sources"
)

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

type response struct {
	status int
	body   map[string]any
	raw    string
}

// serveDeclaring mounts the module through httpx.RegisterModule — what
// cmd/server composes — over the given declarations.
func serveDeclaring(t *testing.T, endpoints, entities map[string][]string, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	httpx.RegisterModule(mux, verifier, "sources", func(m *http.ServeMux) {
		sources.Register(m, sources.Config{
			Endpoints: endpoints, Entities: entities, Verifier: verifier, Log: log,
		})
	})
	return &api{handler: httpx.WithMiddleware(mux), t: t}
}

func serve(t *testing.T) *api {
	t.Helper()
	return serveDeclaring(t,
		map[string][]string{"mark8ly": {"onboarding", "outbox"}, "kora": {"onboarding"}},
		map[string][]string{"mark8ly": {"tenants"}, "kora": {"users", "foods"}},
		"platform")
}

func (a *api) do(method, path string) response {
	a.t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	out := response{status: rec.Code, raw: rec.Body.String()}
	if err := json.Unmarshal(rec.Body.Bytes(), &out.body); err != nil {
		a.t.Fatalf("%s %s: response is not JSON: %v (%s)", method, path, err, out.raw)
	}
	return out
}

func (a *api) get(path string) response { a.t.Helper(); return a.do(http.MethodGet, path) }

func endpointsOf(t *testing.T, got response) map[string]any {
	t.Helper()
	data, ok := got.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is not an object: %s", got.raw)
	}
	endpoints, ok := data["endpoints"].(map[string]any)
	if !ok {
		t.Fatalf("data.endpoints is not an object: %s", got.raw)
	}
	return endpoints
}

// The reason this route exists: the console hardcoded FUNNEL_SOURCE="mark8ly"
// because it had no way to learn which products declare `onboarding`, and a
// picker built without this would offer sources /v1/onboarding/funnel answers
// 400 for.
func TestSourcesNamesEveryProductDeclaringAnEndpoint(t *testing.T) {
	got := serve(t).get(route)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	onboarding, ok := endpointsOf(t, got)["onboarding"].([]any)
	if !ok {
		t.Fatalf("endpoints.onboarding is not an array: %s", got.raw)
	}
	if len(onboarding) != 2 || onboarding[0] != "kora" || onboarding[1] != "mark8ly" {
		t.Errorf("endpoints.onboarding = %v, want [kora mark8ly]", onboarding)
	}
}

// Entity types travel on the same route, for the same question one level down.
func TestSourcesNamesEveryProductServingAnEntityType(t *testing.T) {
	got := serve(t).get(route)
	data, _ := got.body["data"].(map[string]any)
	entities, ok := data["entities"].(map[string]any)
	if !ok {
		t.Fatalf("data.entities is not an object: %s", got.raw)
	}
	tenants, _ := entities["tenants"].([]any)
	if len(tenants) != 1 || tenants[0] != "mark8ly" {
		t.Errorf("entities.tenants = %v, want [mark8ly]", tenants)
	}
}

// An endpoint nobody declares is ABSENT, not present-and-empty. Absence is the
// registry's own absence-means-no rule surfaced unchanged; inventing an empty
// key for every name this service has ever heard of would be the canonical
// vocabulary the module deliberately does not keep.
func TestAnUndeclaredEndpointIsAbsentRatherThanEmpty(t *testing.T) {
	got := serve(t).get(route)
	if value, present := endpointsOf(t, got)["billing"]; present {
		t.Errorf("endpoints.billing = %v; nothing declares billing, so the key must be absent", value)
	}
}

// An estate federating nothing renders as two empty objects. A null here is a
// TypeError on `data.endpoints.onboarding`, and a console that crashes on an
// empty estate is worse than one that shows an empty picker.
func TestAnEmptyEstateRendersEmptyObjectsAndNotNull(t *testing.T) {
	got := serveDeclaring(t, nil, nil, "platform")
	res := got.get(route)
	if res.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", res.status, res.raw)
	}
	data, _ := res.body["data"].(map[string]any)
	if _, ok := data["endpoints"].(map[string]any); !ok {
		t.Errorf("data.endpoints = %#v, want an empty object", data["endpoints"])
	}
	if _, ok := data["entities"].(map[string]any); !ok {
		t.Errorf("data.entities = %#v, want an empty object", data["entities"])
	}
}

// This route reports CONFIGURATION, and the registry holds each product's HMAC
// secret next to its declarations. The secret must not be reachable from the
// response under any key.
func TestTheResponseCarriesNoSecret(t *testing.T) {
	got := serve(t).get(route)
	if strings.Contains(got.raw, "secret") || strings.Contains(got.raw, "Secret") {
		t.Errorf("body mentions a secret: %s", got.raw)
	}
}

// The route takes no parameters at all: it answers every "who declares X" at
// once. A stray parameter is a caller believing in a filter that does not
// exist, and answering it with the unfiltered list would confirm the belief.
func TestAnUnknownParameterIsRefused(t *testing.T) {
	got := serve(t).get(route + "?endpoint=onboarding")
	if got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// Same gate as every other Operate read.
func TestWithoutThePlatformCapabilityTheRouteRefuses(t *testing.T) {
	got := serveDeclaring(t, nil, nil, "support").get(route)
	if got.status != http.StatusForbidden {
		t.Errorf("status = %d, want 403: %s", got.status, got.raw)
	}
}
