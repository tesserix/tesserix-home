package handler_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/onboardingfunnel"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/auth"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/httpx"
)

const sessionsRoute = "/v1/onboarding/sessions"

// The PII this route carries, and the value every leak assertion looks for.
const merchantEmail = "priya@handloomsofkerala.example"

const liveSessions = `{"data":[` +
	`{"id":"sess-1","email":"` + merchantEmail + `","status":"in_progress",` +
	`"created_at":"2026-08-29T10:00:00Z","last_activity_at":"2026-08-29T10:04:00Z",` +
	`"idle_hours":19.5,"abandoned":true,"completed_at":null,"tenant_id":null}` +
	`],"pagination":{"page":1,"limit":50,"total":137}}`

// recording mounts the module over a product that records the query it was
// asked, so the clamp and the parameter narrowing are observable.
func recording(t *testing.T, body string) (*api, *url.Values) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	var seen url.Values
	product := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.Query()
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(product.Close)
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: productSlug, BaseURL: product.URL, Secret: "test-secret",
			Endpoints: []string{"onboarding"}},
	}), product.Client())
	mux := http.NewServeMux()
	verifier := auth.NewVerifier(stubParser{claims: tokenFor("platform")}, projectID)
	httpx.RegisterModule(mux, verifier, "onboardingfunnel", func(m *http.ServeMux) {
		onboardingfunnel.Register(m, onboardingfunnel.Config{
			Fed: fed, Slugs: []string{productSlug}, Verifier: verifier, Log: log,
		})
	})
	return &api{handler: httpx.WithMiddleware(mux), t: t}, &seen
}

func TestSessionsReturnsTheProductsRows(t *testing.T) {
	got := serveProduct(t, http.StatusOK, liveSessions, []string{productSlug}).
		get(sessionsRoute + "?source=" + productSlug)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	rows, ok := got.body["data"].([]any)
	if !ok {
		t.Fatalf("data is not an array: %s", got.raw)
	}
	if len(rows) != 1 {
		t.Fatalf("data = %v, want one row", rows)
	}
	row, _ := rows[0].(map[string]any)
	if row["id"] != "sess-1" || row["email"] != merchantEmail {
		t.Errorf("row = %v, want mark8ly's own row verbatim", row)
	}
}

// A field this module has never heard of reaches the console untouched — the
// same rule the funnel obeys, and the reason no sessionRow struct exists here.
func TestSessionsRendersTheProductsRowVocabularyVerbatim(t *testing.T) {
	got := serveProduct(t, http.StatusOK, `{"data":[{"id":"s1","referral_code":"HANDLOOM24"}],`+
		`"pagination":{"page":1,"limit":50,"total":1}}`, []string{productSlug}).
		get(sessionsRoute + "?source=" + productSlug)
	if !strings.Contains(got.raw, `"referral_code":"HANDLOOM24"`) {
		t.Errorf("body = %s, want the unknown field carried through", got.raw)
	}
}

// THE assertion, half one: nobody signed up is a 200 with an empty array.
func TestSessionsEmptyListIs200WithAnEmptyArray(t *testing.T) {
	got := serveProduct(t, http.StatusOK, `{"data":[],"pagination":{"page":1,"limit":50,"total":0}}`,
		[]string{productSlug}).get(sessionsRoute + "?source=" + productSlug)
	if got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	rows, ok := got.body["data"].([]any)
	if !ok || len(rows) != 0 {
		t.Errorf("data = %#v, want an empty array", got.body["data"])
	}
}

// Half two: every shape that is not a list is a 503, and no status on this
// route produces a `data` array the console could mistake for an empty queue.
func TestAListThatCouldNotBeReadIsNeverAnEmptyList(t *testing.T) {
	for name, c := range map[string]struct {
		status int
		body   string
	}{
		"null data":              {http.StatusOK, `{"data":null,"pagination":{"total":0}}`},
		"absent data":            {http.StatusOK, `{"pagination":{"total":0}}`},
		"an object":              {http.StatusOK, `{"data":{},"pagination":{"total":0}}`},
		"absent pagination":      {http.StatusOK, `{"data":[]}`},
		"absent total":           {http.StatusOK, `{"data":[],"pagination":{"page":1,"limit":50}}`},
		"an unreachable product": {http.StatusBadGateway, `{"error":"bad_gateway"}`},
	} {
		t.Run(name, func(t *testing.T) {
			got := serveProduct(t, c.status, c.body, []string{productSlug}).
				get(sessionsRoute + "?source=" + productSlug)
			if got.status != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503: %s", got.status, got.raw)
			}
			if _, present := got.body["data"]; present {
				t.Errorf("a failed read carried a data key: %s", got.raw)
			}
		})
	}
}

// The upstream's effective page size and total reach the console through the
// service's own envelope, so a client can see its request was narrowed rather
// than inferring it from a short page.
func TestSessionsEchoesTheEffectiveLimitAndTotal(t *testing.T) {
	got := serveProduct(t, http.StatusOK, liveSessions, []string{productSlug}).
		get(sessionsRoute + "?source=" + productSlug)
	meta, ok := got.body["meta"].(map[string]any)
	if !ok {
		t.Fatalf("no meta on the response: %s", got.raw)
	}
	if meta["total"] != float64(137) {
		t.Errorf("meta.total = %v, want 137", meta["total"])
	}
	if meta["limit"] != float64(50) {
		t.Errorf("meta.limit = %v, want the effective 50", meta["limit"])
	}
}

// The clamp. An operator asking for ten thousand rows gets the ceiling, and
// gets it here — the far end's clamp lives in a service this deployment cannot
// see or version.
func TestAnOversizedLimitIsClampedBeforeItIsForwarded(t *testing.T) {
	a, seen := recording(t, liveSessions)
	if got := a.get(sessionsRoute + "?source=" + productSlug + "&limit=10000"); got.status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", got.status, got.raw)
	}
	if seen.Get("limit") != "200" {
		t.Errorf("forwarded limit = %q, want the clamped 200", seen.Get("limit"))
	}
}

// A limit within the ceiling is forwarded untouched: the clamp is a ceiling,
// not a rewrite.
func TestALimitWithinTheCeilingIsForwardedUnchanged(t *testing.T) {
	a, seen := recording(t, liveSessions)
	a.get(sessionsRoute + "?source=" + productSlug + "&limit=25")
	if seen.Get("limit") != "25" {
		t.Errorf("forwarded limit = %q, want 25", seen.Get("limit"))
	}
}

// mark8ly silently ignores a parameter it cannot parse, which turns a typo
// into a different question answered without saying so: `abandoned=yes`
// returns EVERY session to an operator who asked for the abandoned ones.
func TestAParameterThatWouldBeSilentlyIgnoredIsRefused(t *testing.T) {
	for name, query := range map[string]string{
		"a non-numeric limit":     "&limit=fifty",
		"a zero limit":            "&limit=0",
		"a negative limit":        "&limit=-5",
		"a non-numeric page":      "&page=two",
		"a zero page":             "&page=0",
		"a non-boolean abandoned": "&abandoned=yes",
	} {
		t.Run(name, func(t *testing.T) {
			got := serveProduct(t, http.StatusOK, liveSessions, []string{productSlug}).
				get(sessionsRoute + "?source=" + productSlug + query)
			if got.status != http.StatusBadRequest {
				t.Errorf("status = %d, want 400: %s", got.status, got.raw)
			}
		})
	}
}

// `source` addressed this hop and means nothing to mark8ly; forwarding it
// would be an unknown parameter at the far end.
func TestSourceIsNotForwardedToTheProduct(t *testing.T) {
	a, seen := recording(t, liveSessions)
	a.get(sessionsRoute + "?source=" + productSlug + "&status=in_progress")
	if seen.Has("source") {
		t.Errorf("source reached the product: %v", *seen)
	}
	if seen.Get("status") != "in_progress" {
		t.Errorf("status = %q, want it forwarded", seen.Get("status"))
	}
}

func TestSessionsRequiresASource(t *testing.T) {
	got := serveProduct(t, http.StatusOK, liveSessions, []string{productSlug}).get(sessionsRoute)
	if got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", got.status, got.raw)
	}
}

func TestSessionsRefusesAnUnknownParameter(t *testing.T) {
	got := serveProduct(t, http.StatusOK, liveSessions, []string{productSlug}).
		get(sessionsRoute + "?source=" + productSlug + "&idle_hours=24")
	if got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// PII on the wire: a failed read is rendered from this service's own strings,
// never from the product's body, so no session row can ride out on a 503.
func TestAFailedReadNeverRendersARow(t *testing.T) {
	for name, c := range map[string]struct {
		status int
		body   string
	}{
		"an unreadable 200": {http.StatusOK,
			`{"data":{"email":"` + merchantEmail + `"},"pagination":{"total":1}}`},
		"a refusal carrying rows": {http.StatusInternalServerError, liveSessions},
		"a body truncated mid-row": {http.StatusOK,
			`{"data":[{"id":"s1","email":"` + merchantEmail + `"`},
	} {
		t.Run(name, func(t *testing.T) {
			got := serveProduct(t, c.status, c.body, []string{productSlug}).
				get(sessionsRoute + "?source=" + productSlug)
			if got.status == http.StatusOK {
				t.Fatalf("status = 200 on a failed read: %s", got.raw)
			}
			if strings.Contains(got.raw, merchantEmail) || strings.Contains(got.raw, "@handloomsofkerala") {
				t.Errorf("a merchant email reached the response: %s", got.raw)
			}
		})
	}
}

// The declaration scoping the funnel uses scopes this too: both routes are
// mounted by the same mark8ly handler behind the same dependency.
func TestAnUndeclaredSourceIsRefused(t *testing.T) {
	got := serveProduct(t, http.StatusOK, liveSessions, []string{productSlug}).
		get(sessionsRoute + "?source=kora")
	if got.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400: %s", got.status, got.raw)
	}
}

// The product declared `onboarding` and does not mount the route: a
// declaration problem, which an operator fixes with an env var, not a restart.
func TestAProductThatDoesNotMountTheRouteIs404(t *testing.T) {
	got := serveProduct(t, http.StatusNotFound, `{"error":"not_found"}`, []string{productSlug}).
		get(sessionsRoute + "?source=" + productSlug)
	if got.status != http.StatusNotFound {
		t.Errorf("status = %d, want 404: %s", got.status, got.raw)
	}
}

func TestNoProductDeclaringOnboardingIs501(t *testing.T) {
	got := serveProduct(t, http.StatusOK, liveSessions, nil).
		get(sessionsRoute + "?source=" + productSlug)
	if got.status != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501: %s", got.status, got.raw)
	}
}
