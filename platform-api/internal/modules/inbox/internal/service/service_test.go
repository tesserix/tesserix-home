package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

func op() federation.Operator {
	return federation.Operator{ID: "op-1", Capability: "platform"}
}

func testLogger() *slog.Logger {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil))
}

func serving(t *testing.T, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// svc wires one service over the given slug→body map, so a test states only
// what each product answers.
func svc(t *testing.T, bodies map[string]string) *Service {
	t.Helper()
	products := make([]federation.Product, 0, len(bodies))
	slugs := make([]string, 0, len(bodies))
	for slug, body := range bodies {
		products = append(products, federation.Product{
			Slug: slug, BaseURL: serving(t, body).URL, Secret: "s",
		})
		slugs = append(slugs, slug)
	}
	fed := federation.NewClient(federation.NewRegistry(products), nil)
	return New(fed, slugs, testLogger())
}

// §3.2's envelope is `{items, total}` — NOT §4.1's `{data, pagination}`. The
// inbox is the one contract endpoint with its own shape.
const koraQueue = `{"items":[
  {"id":"f1","kind":"feedback","title":"App crashed","waiting_since":"2026-08-20T09:00:00Z","actions":[]},
  {"id":"u9","kind":"unresolved_food","title":"ragi mudde","waiting_since":"2026-08-18T09:00:00Z","severity":"warning","actions":[{"id":"resolve","label":"Resolve","destructive":false}]}
],"total":7}`

func TestEstateReadsTheProductQueue(t *testing.T) {
	page, err := svc(t, map[string]string{"kora": koraQueue}).
		Estate(context.Background(), op(), Query{Limit: 100})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(page.Items))
	}
	// The product's own queue DEPTH, not the number of rows returned.
	if page.Total != 7 {
		t.Errorf("total = %d, want the product's own 7", page.Total)
	}
}

// A queue exists to surface what has waited longest. Newest-first would bury
// the most overdue item under whatever arrived a moment ago.
func TestEstateOrdersOldestFirst(t *testing.T) {
	page, _ := svc(t, map[string]string{"kora": koraQueue}).
		Estate(context.Background(), op(), Query{Limit: 100})
	if page.Items[0].ID != "kora:u9" {
		t.Errorf("first = %q, want the oldest (kora:u9)", page.Items[0].ID)
	}
}

// Two products returning item id "1" are indistinguishable in a merged queue.
func TestEstateNamespacesIDsAndStampsSource(t *testing.T) {
	page, _ := svc(t, map[string]string{"kora": koraQueue}).
		Estate(context.Background(), op(), Query{Limit: 100})
	for _, item := range page.Items {
		if item.Source != "kora" {
			t.Errorf("source = %q, want it stamped from the slug called", item.Source)
		}
		if len(item.ID) < 5 || item.ID[:5] != "kora:" {
			t.Errorf("id = %q, want it namespaced", item.ID)
		}
	}
}

// The slug the call was MADE to wins over anything the body claims: a product
// must not be able to name itself into another product's queue.
func TestEstateIgnoresASourceTheProductClaims(t *testing.T) {
	body := `{"items":[{"id":"1","source":"mark8ly","kind":"feedback","title":"x","waiting_since":"2026-08-20T09:00:00Z","actions":[]}],"total":1}`
	page, _ := svc(t, map[string]string{"kora": body}).
		Estate(context.Background(), op(), Query{Limit: 100})
	if page.Items[0].Source != "kora" {
		t.Errorf("source = %q; a product must not name itself into another's rows", page.Items[0].Source)
	}
}

// `null` is a different bug from `[]` in every language that reads it, and the
// console iterates this field.
func TestEstateNeverEmitsNullCollections(t *testing.T) {
	page, err := svc(t, map[string]string{"kora": `{"items":[{"id":"1","kind":"feedback","title":"x","waiting_since":"2026-08-20T09:00:00Z"}],"total":1}`}).
		Estate(context.Background(), op(), Query{Limit: 100})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	raw, err := json.Marshal(page)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, forbidden := range []string{`"items":null`, `"failures":null`, `"actions":null`} {
		if bytes.Contains(raw, []byte(forbidden)) {
			t.Errorf("emitted %s; the console iterates these", forbidden)
		}
	}
}

// An empty queue is a real and reassuring answer. Instrumentation that was
// never wired must not be able to produce that reassurance.
func TestEstateRefusesWhenNoProductsAreConfigured(t *testing.T) {
	s := New(federation.NewClient(federation.NewRegistry(nil), nil), nil, testLogger())
	if _, err := s.Estate(context.Background(), op(), Query{Limit: 100}); !errors.Is(err, ErrNotInstrumented) {
		t.Fatalf("err = %v, want ErrNotInstrumented", err)
	}
}

func TestEstateRefusesAnUnknownSource(t *testing.T) {
	_, err := svc(t, map[string]string{"kora": koraQueue}).
		Estate(context.Background(), op(), Query{Source: "nope", Limit: 100})
	if !errors.Is(err, ErrUnknownSource) {
		t.Fatalf("err = %v, want ErrUnknownSource", err)
	}
}

// One product failing must not take out the queue: the surviving product's
// items still render, and `failures` says the total is partial.
func TestEstateReportsAFailedProductWithoutLosingTheOthers(t *testing.T) {
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(broken.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "kora", BaseURL: serving(t, koraQueue).URL, Secret: "s"},
		{Slug: "other", BaseURL: broken.URL, Secret: "s"},
	}), nil)

	page, err := New(fed, []string{"kora", "other"}, testLogger()).
		Estate(context.Background(), op(), Query{Limit: 100})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Items) != 2 {
		t.Errorf("items = %d, want the healthy product's 2", len(page.Items))
	}
	if len(page.Failures) != 1 || page.Failures[0].Source != "other" {
		t.Fatalf("failures = %+v, want one naming `other`", page.Failures)
	}
	// The failed product contributes nothing to the depth. Counting it as zero
	// would understate the backlog while looking like a complete count —
	// `failures` is what says the number is partial.
	if page.Total != 7 {
		t.Errorf("total = %d, want only the answering product's 7", page.Total)
	}
}

// federation.FanOut runs `decode` in one goroutine per slug, so the total
// accumulator is written concurrently. This test exists to be run under -race
// with MORE THAN ONE product — a single-product test cannot catch it.
func TestEstateSumsTotalsAcrossProductsWithoutRacing(t *testing.T) {
	second := `{"items":[{"id":"z","kind":"review","title":"y","waiting_since":"2026-08-19T09:00:00Z","actions":[]}],"total":4}`
	page, err := svc(t, map[string]string{"kora": koraQueue, "other": second}).
		Estate(context.Background(), op(), Query{Limit: 100})
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if page.Total != 11 {
		t.Errorf("total = %d, want 7+4=11", page.Total)
	}
	if len(page.Items) != 3 {
		t.Errorf("items = %d, want 3 merged", len(page.Items))
	}
}
