package service

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

func op() federation.Operator {
	return federation.Operator{ID: "op-1", Capability: "platform"}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io_Discard{}, nil))
}

type io_Discard struct{}

func (io_Discard) Write(p []byte) (int, error) { return len(p), nil }

func product(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
}

const onePage = `{"data":[
  {"id":"t1","name":"Acme","owner_email":"a@x.test","status":"active","created_at":"2026-08-12T09:31:00Z"}
],"pagination":{"page":1,"limit":50,"total":1}}`

func TestEstateStampsTheSourceItCalledRatherThanTrustingTheBody(t *testing.T) {
	// The slug the call was MADE to wins over anything the body claims — a
	// product must not be able to name itself into another product's rows.
	srv := product(t, `{"data":[{"id":"t1","name":"Acme","status":"active","source":"kora"}],"pagination":{"page":1,"limit":50,"total":1}}`)
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())

	page, err := New(fed, []string{"mark8ly"}, testLogger()).Estate(context.Background(), op(), Query{})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Tenants) != 1 {
		t.Fatalf("got %d tenants, want 1", len(page.Tenants))
	}
	if page.Tenants[0].Source != "mark8ly" {
		t.Errorf("source = %q, want mark8ly — the body's claim must not win", page.Tenants[0].Source)
	}
}

func TestEstateNamespacesIdsBySource(t *testing.T) {
	// Two products returning primary key "1" are indistinguishable in a merged
	// list keyed by id, and the console dedupes on it.
	a := product(t, `{"data":[{"id":"1","name":"A","status":"active"}],"pagination":{"page":1,"limit":50,"total":1}}`)
	defer a.Close()
	b := product(t, `{"data":[{"id":"1","name":"B","status":"active"}],"pagination":{"page":1,"limit":50,"total":1}}`)
	defer b.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: a.URL, Secret: "s"},
		{Slug: "kora", BaseURL: b.URL, Secret: "s"},
	}), a.Client())

	page, err := New(fed, []string{"mark8ly", "kora"}, testLogger()).Estate(context.Background(), op(), Query{})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	ids := map[string]bool{}
	for _, tn := range page.Tenants {
		ids[tn.ID] = true
	}
	if !ids["mark8ly:1"] || !ids["kora:1"] {
		t.Errorf("ids = %v, want them namespaced as <source>:<id>", ids)
	}
}

func TestEstateReportsAFailingProductWithoutLosingTheOthers(t *testing.T) {
	ok := product(t, onePage)
	defer ok.Close()
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer down.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: ok.URL, Secret: "s"},
		{Slug: "kora", BaseURL: down.URL, Secret: "s"},
	}), ok.Client())

	page, err := New(fed, []string{"kora", "mark8ly"}, testLogger()).Estate(context.Background(), op(), Query{})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Tenants) != 1 {
		t.Errorf("got %d tenants, want the one source that answered", len(page.Tenants))
	}
	if len(page.Failures) != 1 || page.Failures[0].Source != "kora" {
		t.Errorf("failures = %+v, want one naming kora", page.Failures)
	}
}

// An unconfigured deployment must not be able to impersonate "no tenants".
func TestEstateWithNoProductsIsNotInstrumented(t *testing.T) {
	fed := federation.NewClient(federation.NewRegistry(nil), http.DefaultClient)
	_, err := New(fed, nil, testLogger()).Estate(context.Background(), op(), Query{})
	if err == nil || !strings.Contains(err.Error(), "configured") {
		t.Fatalf("err = %v, want ErrNotInstrumented", err)
	}
}

func TestEstateRefusesAnUnknownSource(t *testing.T) {
	srv := product(t, onePage)
	defer srv.Close()
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())

	_, err := New(fed, []string{"mark8ly"}, testLogger()).Estate(context.Background(), op(), Query{Source: "nope"})
	if err == nil {
		t.Fatal("an unknown source must be refused, not silently return nothing")
	}
}

func TestEstateNarrowsToOneSourceWhenAsked(t *testing.T) {
	var koraCalled bool
	a := product(t, onePage)
	defer a.Close()
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		koraCalled = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(onePage))
	}))
	defer b.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: a.URL, Secret: "s"},
		{Slug: "kora", BaseURL: b.URL, Secret: "s"},
	}), a.Client())

	if _, err := New(fed, []string{"mark8ly", "kora"}, testLogger()).
		Estate(context.Background(), op(), Query{Source: "mark8ly"}); err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if koraCalled {
		t.Error("kora was called despite source=mark8ly")
	}
}

// The bounded question: every product is asked the same one, and the search
// term reaches it rather than being applied after the fact on a truncated page.
func TestEstatePassesTheQueryAndBoundsToTheProduct(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(onePage))
	}))
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())

	if _, err := New(fed, []string{"mark8ly"}, testLogger()).
		Estate(context.Background(), op(), Query{Q: "acme", Status: "active", Limit: 25}); err != nil {
		t.Fatalf("Estate: %v", err)
	}
	for _, want := range []string{"q=acme", "status=active", "limit=25"} {
		if !strings.Contains(gotQuery, want) {
			t.Errorf("query %q is missing %q", gotQuery, want)
		}
	}
}

func TestEstateReturnsNonNilSlicesWhenEmpty(t *testing.T) {
	srv := product(t, `{"data":[],"pagination":{"page":1,"limit":50,"total":0}}`)
	defer srv.Close()
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL, Secret: "s"},
	}), srv.Client())

	page, err := New(fed, []string{"mark8ly"}, testLogger()).Estate(context.Background(), op(), Query{})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if page.Tenants == nil || page.Failures == nil {
		t.Error("both slices must be non-nil so they serialise as [] rather than null")
	}
}
