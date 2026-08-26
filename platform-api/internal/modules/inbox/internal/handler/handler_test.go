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

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/inbox"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

// The module is exercised through its REAL router, its real verifier and a
// real (httptest) product server standing in for kora — the only product that
// implements §3.2 today. Only the token's signature is faked.

const (
	subjectOperator = "zitadel-operator-1"
	projectID       = "386377618200461939"
	jwtShaped       = "header.payload.signature"
	productSlug     = "kora"
)

type stubParser struct{ claims *auth.Claims }

func (s stubParser) Parse(context.Context, string) (*auth.Claims, error) {
	copied := *s.claims
	return &copied, nil
}

func tokenFor(roles ...string) *auth.Claims {
	return &auth.Claims{
		Subject:   subjectOperator,
		Email:     "operator@tesserix.test",
		Audience:  []string{projectID},
		Issuer:    "https://auth.tesserix.app",
		ExpiresAt: time.Now().Add(time.Hour),
		Roles:     roles,
	}
}

type api struct {
	handler http.Handler
	t       *testing.T
	asked   chan string
}

func serve(t *testing.T) *api { t.Helper(); return serveSlugs(t, []string{productSlug}, "platform") }

// serveNoProducts mounts the same module with an EMPTY registry: the shape a
// deployment has before any product declares §3.2 in FEDERATION_<SLUG>_ENDPOINTS.
func serveNoProducts(t *testing.T) *api {
	t.Helper()
	return serveSlugs(t, nil, "platform")
}

func serveSlugs(t *testing.T, slugs []string, roles ...string) *api {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	asked := make(chan string, 4)
	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked <- r.URL.String()
		// §3.2's `{items, total}`, with `total` deliberately larger than the
		// rows returned — that is the product's queue DEPTH.
		_, _ = w.Write([]byte(`{"items":[{"id":"f1","kind":"feedback","title":"App crashed","waiting_since":"2026-08-20T09:00:00Z","actions":[]}],"total":7}`))
	}))
	t.Cleanup(product.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: product.URL, Secret: "test-secret"},
	}), product.Client())

	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor(roles...)}, projectID)
	// Through RegisterModule and the module's own Register, because that is
	// where the "no verifier, no module" guard lives — composing what
	// cmd/server composes.
	httpx.RegisterModule(mux, verifier, "inbox", func(m *http.ServeMux) {
		inbox.Register(m, inbox.Config{Fed: fed, Slugs: slugs, Verifier: verifier, Log: log})
	})

	return &api{handler: httpx.WithMiddleware(mux), t: t, asked: asked}
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (a *api) do(method, path string) response {
	a.t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Authorization", "Bearer "+jwtShaped)
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

func (a *api) get(path string) response { a.t.Helper(); return a.do(http.MethodGet, path) }

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

func TestInboxReturnsItemsAndTheProductsOwnTotal(t *testing.T) {
	a := serve(t)
	got := a.get("/v1/inbox")
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	data := got.data(t)
	items, _ := data["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %v, want 1: %s", data["items"], got.raw)
	}
	if data["total"] != float64(7) {
		t.Errorf("total = %v, want the product's own queue depth 7", data["total"])
	}
}

// The console iterates both collections; `null` is a different bug from `[]`.
func TestInboxRendersEmptyCollectionsAsArrays(t *testing.T) {
	a := serve(t)
	data := a.get("/v1/inbox").data(t)
	if _, ok := data["items"].([]any); !ok {
		t.Errorf("items is not an array: %v", data["items"])
	}
	if _, ok := data["failures"].([]any); !ok {
		t.Errorf("failures is not an array: %v", data["failures"])
	}
}

func TestInboxForwardsTheBoundToTheProduct(t *testing.T) {
	a := serve(t)
	a.get("/v1/inbox?limit=25")
	select {
	case url := <-a.asked:
		if !strings.Contains(url, "limit=25") {
			t.Errorf("product asked %q, want limit=25 forwarded", url)
		}
	default:
		t.Fatal("the product was never called")
	}
}

func TestInboxDefaultsTheBoundRatherThanAskingUnbounded(t *testing.T) {
	a := serve(t)
	a.get("/v1/inbox")
	select {
	case url := <-a.asked:
		if !strings.Contains(url, "limit=") {
			t.Errorf("product asked %q with no bound; an unbounded fan-out is truncated mid-JSON at 1 MiB", url)
		}
	default:
		t.Fatal("the product was never called")
	}
}

// Refused, not clamped. Silently returning fewer items than asked for is how a
// caller comes to believe a queue is shorter than it is — which on this
// surface means believing work is done.
func TestInboxRefusesAnOversizedLimit(t *testing.T) {
	if got := serve(t).get("/v1/inbox?limit=100000"); got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
}

func TestInboxRejectsBadAndUnknownParameters(t *testing.T) {
	a := serve(t)
	if got := a.get("/v1/inbox?limit=abc"); got.status != http.StatusBadRequest {
		t.Errorf("limit=abc: status = %d, want 400", got.status)
	}
	// A rejected typo is cheaper than a filter that silently did nothing.
	if got := a.get("/v1/inbox?kind=feedback"); got.status != http.StatusBadRequest {
		t.Errorf("unknown param: status = %d, want 400", got.status)
	}
}

func TestInboxRefusesAnUnknownSource(t *testing.T) {
	if got := serve(t).get("/v1/inbox?source=nosuchproduct"); got.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// 501, not an empty 200. An empty queue is a real and reassuring answer, and
// instrumentation that was never wired must not be able to produce that
// reassurance — an operator would read "nothing waiting" and move on.
func TestInboxIsNotImplementedWhenNoProductDeclaresIt(t *testing.T) {
	if got := serveNoProducts(t).get("/v1/inbox"); got.status != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", got.status, got.raw)
	}
}
