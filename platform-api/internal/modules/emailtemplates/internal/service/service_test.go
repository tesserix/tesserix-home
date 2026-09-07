package service_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync/atomic"
	"testing"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/emailtemplates/internal/domain"
	"github.com/tesserix/tesserix-home/platform-api/internal/modules/emailtemplates/internal/service"
	"github.com/tesserix/tesserix-home/platform-api/internal/platform/federation"
)

// These cover the refusals whose ORDER matters, which the HTTP tests can see
// the status of but not the reasoning behind.

func build(t *testing.T, slugs []string) *service.Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("a refused call still reached the product")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", Services: []federation.Service{{Name: "mark8ly", BaseURL: srv.URL, Secret: "s", Endpoints: []string{"email-templates"}}}}}), srv.Client())
	return service.New(fed, slugs, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func op() federation.Operator {
	return federation.Operator{ID: "operator-1", Capability: "platform"}
}

// "No product serves this" is checked BEFORE the id is parsed. With nothing
// declared every source is unknown, and telling an operator "unknown source:
// mark8ly" when the truth is "this deployment federates no registry" sends
// them to check a slug that is spelled correctly.
func TestAnUndeclaredDeploymentSaysSoRatherThanBlamingTheSource(t *testing.T) {
	s := build(t, nil)
	_, err := s.Get(context.Background(), op(), "mark8ly:orderdoc_invoice")
	if !errors.Is(err, service.ErrNotInstrumented) {
		t.Fatalf("err = %v, want ErrNotInstrumented", err)
	}
}

func TestAnIdIsRefusedBeforeAnythingIsCalled(t *testing.T) {
	s := build(t, []string{"mark8ly"})

	for name, id := range map[string]string{
		"no source":       "orderdoc_invoice",
		"empty key":       "mark8ly:",
		"empty source":    ":orderdoc_invoice",
		"unknown source":  "kora:orderdoc_invoice",
		"path traversal":  "mark8ly:../tenants/t1/suspend",
		"space in key":    "mark8ly:orderdoc invoice",
		"query smuggling": "mark8ly:orderdoc_invoice?x=1",
	} {
		t.Run(name, func(t *testing.T) {
			// Every verb, because the guard is shared and a verb that skipped
			// it would be the one that mattered: Save and TestSend are writes.
			if _, err := s.Get(context.Background(), op(), id); err == nil {
				t.Errorf("Get(%q) was allowed", id)
			}
			if _, err := s.Save(context.Background(), op(), id, service.Upsert{}, "k"); err == nil {
				t.Errorf("Save(%q) was allowed", id)
			}
			if _, err := s.TestSend(context.Background(), op(), id,
				service.TestSendRequest{To: "x@y.z"}, "k"); err == nil {
				t.Errorf("TestSend(%q) was allowed", id)
			}
		})
	}
}

// The tests below cover mark8ly's split registry (tesserix/mark8ly#720):
// marketplace-api (the DEFAULT service) and platform-api both declare
// `email-templates` under the one "mark8ly" slug.

// stubServer is a federated product's platform admin front door, recording
// how many times it was called so a test can assert the OTHER service was
// never reached. Hits is atomic because FanOutServices calls a product's
// services concurrently.
type stubServer struct {
	*httptest.Server
	hits atomic.Int32
}

// newStub answers every request with status (0 means 200) and body.
func newStub(t *testing.T, status int, body string) *stubServer {
	t.Helper()
	if status == 0 {
		status = http.StatusOK
	}
	st := &stubServer{}
	st.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		st.hits.Add(1)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(st.Close)
	return st
}

// strictStub fails the test if it is ever reached — for asserting a refusal
// (a malformed id, an unknown service) never calls anything, the same
// contract build's server already enforces for a single-service registry.
func strictStub(t *testing.T) *stubServer {
	t.Helper()
	st := &stubServer{}
	st.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		st.hits.Add(1)
		t.Error("a refused call still reached the product")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(st.Close)
	return st
}

// buildTwoServices wires "mark8ly" with two services — marketplace-api (the
// DEFAULT) and platform-api — the shape mark8ly#720 adds.
func buildTwoServices(t *testing.T, marketplace, platform *stubServer) *service.Service {
	t.Helper()
	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{
			Slug: "mark8ly",
			Services: []federation.Service{
				{Name: "marketplace-api", BaseURL: marketplace.URL, Secret: "s1", Endpoints: []string{"email-templates"}},
				{Name: "platform-api", BaseURL: platform.URL, Secret: "s2", Endpoints: []string{"email-templates"}},
			},
			DefaultService: "marketplace-api",
		},
	}), nil)
	return service.New(fed, []string{"mark8ly"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestListMergesRowsFromTwoServicesOfOneProduct(t *testing.T) {
	marketplace := newStub(t, 0, `{"data":[{"key":"orderdoc_invoice","state":"published",`+
		`"sends_from":"row","has_embedded_default":true,"subject":"Your invoice"}]}`)
	platform := newStub(t, 0, `{"data":[{"key":"welcome","state":"published",`+
		`"sends_from":"row","has_embedded_default":true,"subject":"Welcome"}]}`)
	s := buildTwoServices(t, marketplace, platform)

	page, err := s.List(context.Background(), op(), "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Failures) != 0 {
		t.Fatalf("Failures = %+v, want none", page.Failures)
	}
	if len(page.Templates) != 2 {
		t.Fatalf("Templates = %+v, want 2 rows", page.Templates)
	}

	byKey := make(map[string]domain.Row, len(page.Templates))
	for _, row := range page.Templates {
		byKey[row.Key] = row
	}

	if got := byKey["orderdoc_invoice"]; got.Source != "mark8ly" || got.ID != "mark8ly:orderdoc_invoice" {
		t.Errorf("default-service row = %+v, want Source mark8ly, ID mark8ly:orderdoc_invoice", got)
	}
	if got := byKey["welcome"]; got.Source != "mark8ly/platform-api" || got.ID != "mark8ly/platform-api:welcome" {
		t.Errorf("non-default-service row = %+v, want Source mark8ly/platform-api, ID mark8ly/platform-api:welcome", got)
	}

	// Deterministic order: source then key, so two identical reads render
	// identically.
	if !sort.SliceIsSorted(page.Templates, func(i, j int) bool {
		if page.Templates[i].Source != page.Templates[j].Source {
			return page.Templates[i].Source < page.Templates[j].Source
		}
		return page.Templates[i].Key < page.Templates[j].Key
	}) {
		t.Errorf("Templates = %+v, not in (source, key) order", page.Templates)
	}
}

// One service failing must not hide the other's rows, and must be surfaced —
// an operator seeing five templates instead of eleven, with no failure
// visible, is the worst outcome this module's List exists to prevent.
func TestListOneServiceFailingStillReturnsTheOthersRowsAndTheFailure(t *testing.T) {
	marketplace := newStub(t, 0, `{"data":[{"key":"orderdoc_invoice","state":"published",`+
		`"sends_from":"row","has_embedded_default":true,"subject":"Your invoice"}]}`)
	platform := newStub(t, http.StatusInternalServerError, `{"error":"boom"}`)
	s := buildTwoServices(t, marketplace, platform)

	page, err := s.List(context.Background(), op(), "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Templates) != 1 || page.Templates[0].Key != "orderdoc_invoice" {
		t.Fatalf("Templates = %+v, want exactly orderdoc_invoice", page.Templates)
	}
	if len(page.Failures) != 1 {
		t.Fatalf("Failures = %+v, want exactly one", page.Failures)
	}
	if page.Failures[0].Source != "mark8ly/platform-api" {
		t.Errorf("Failures[0].Source = %q, want mark8ly/platform-api", page.Failures[0].Source)
	}
	if page.Failures[0].Message == "" {
		t.Errorf("Failures[0].Message is empty, want a rendered reason")
	}
}

func TestGetSaveTestSendRouteToTheNamedServiceForASlugServiceID(t *testing.T) {
	marketplace := strictStub(t)
	platform := newStub(t, 0, `{"data":{"key":"welcome","state":"published",`+
		`"sends_from":"row","has_embedded_default":true,"subject":"Welcome",`+
		`"html_body":"<p>hi</p>","text_body":"hi","variables":[]}}`)
	s := buildTwoServices(t, marketplace, platform)
	id := "mark8ly/platform-api:welcome"

	detail, err := s.Get(context.Background(), op(), id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if detail.Source != "mark8ly/platform-api" || detail.ID != "mark8ly/platform-api:welcome" {
		t.Errorf("Get detail = %+v, want Source/ID naming platform-api", detail)
	}

	if _, err := s.Save(context.Background(), op(), id,
		service.Upsert{Subject: "x", Status: "draft"}, "idem-save"); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := s.TestSend(context.Background(), op(), id,
		service.TestSendRequest{To: "a@b.c"}, "idem-send"); err != nil {
		t.Fatalf("TestSend: %v", err)
	}

	if platform.hits.Load() != 3 {
		t.Errorf("platform hits = %d, want 3 (Get, Save, TestSend)", platform.hits.Load())
	}
	// marketplace is a strictStub: reaching it at all already failed the test
	// above via t.Error, this is belt-and-suspenders.
	if marketplace.hits.Load() != 0 {
		t.Errorf("marketplace hits = %d, want 0", marketplace.hits.Load())
	}
}

func TestGetSaveTestSendOnABareSlugKeyIDStillUseTheDefaultService(t *testing.T) {
	marketplace := newStub(t, 0, `{"data":{"key":"orderdoc_invoice","state":"published",`+
		`"sends_from":"row","has_embedded_default":true,"subject":"Invoice",`+
		`"html_body":"<p>hi</p>","text_body":"hi","variables":[]}}`)
	platform := strictStub(t)
	s := buildTwoServices(t, marketplace, platform)
	id := "mark8ly:orderdoc_invoice"

	detail, err := s.Get(context.Background(), op(), id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if detail.Source != "mark8ly" || detail.ID != "mark8ly:orderdoc_invoice" {
		t.Errorf("Get detail = %+v, want the bare mark8ly source", detail)
	}

	if _, err := s.Save(context.Background(), op(), id,
		service.Upsert{Subject: "x", Status: "draft"}, "idem-save-2"); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := s.TestSend(context.Background(), op(), id,
		service.TestSendRequest{To: "a@b.c"}, "idem-send-2"); err != nil {
		t.Fatalf("TestSend: %v", err)
	}

	if marketplace.hits.Load() != 3 {
		t.Errorf("marketplace hits = %d, want 3 (Get, Save, TestSend)", marketplace.hits.Load())
	}
	if platform.hits.Load() != 0 {
		t.Errorf("platform hits = %d, want 0", platform.hits.Load())
	}
}

// A malformed source (an empty or slash-containing service half) and a
// source naming a real product but no such service must both be refused
// before anything is called — never guessed at, on a read or a write.
func TestMalformedAndUnknownServiceIDsAreRefusedBeforeAnythingIsCalled(t *testing.T) {
	marketplace := strictStub(t)
	platform := strictStub(t)
	s := buildTwoServices(t, marketplace, platform)

	ids := map[string]string{
		"empty service":            "mark8ly/:welcome",
		"unknown service":          "mark8ly/unknown-service:welcome",
		"service name has a slash": "mark8ly/platform-api/extra:welcome",
	}
	for name, id := range ids {
		t.Run(name, func(t *testing.T) {
			if _, err := s.Get(context.Background(), op(), id); err == nil {
				t.Errorf("Get(%q) was allowed", id)
			} else if !errors.Is(err, service.ErrMalformedID) && !errors.Is(err, service.ErrUnknownSource) {
				t.Errorf("Get(%q) err = %v, want ErrMalformedID or ErrUnknownSource", id, err)
			}
			if _, err := s.Save(context.Background(), op(), id, service.Upsert{}, "k"); err == nil {
				t.Errorf("Save(%q) was allowed", id)
			}
			if _, err := s.TestSend(context.Background(), op(), id,
				service.TestSendRequest{To: "x@y.z"}, "k"); err == nil {
				t.Errorf("TestSend(%q) was allowed", id)
			}
		})
	}

	sources := map[string]string{
		"empty service":            "mark8ly/",
		"unknown service":          "mark8ly/unknown-service",
		"service name has a slash": "mark8ly/platform-api/extra",
	}
	for name, source := range sources {
		t.Run("List/"+name, func(t *testing.T) {
			if _, err := s.List(context.Background(), op(), source); err == nil {
				t.Errorf("List(source=%q) was allowed", source)
			} else if !errors.Is(err, service.ErrMalformedID) && !errors.Is(err, service.ErrUnknownSource) {
				t.Errorf("List(source=%q) err = %v, want ErrMalformedID or ErrUnknownSource", source, err)
			}
		})
	}

	if marketplace.hits.Load() != 0 || platform.hits.Load() != 0 {
		t.Fatalf("hits marketplace=%d platform=%d, want 0/0 — a refused id must call nothing",
			marketplace.hits.Load(), platform.hits.Load())
	}
}

// Sources() must enumerate exactly the values List's rows and the ?source=
// filter agree on — the bare slug for the default service, slug/service for
// the other — so the console's filter can reach every row.
func TestSourcesEnumeratesTheDefaultAndNonDefaultServiceLabels(t *testing.T) {
	marketplace := newStub(t, 0, `{"data":[]}`)
	platform := newStub(t, 0, `{"data":[]}`)
	s := buildTwoServices(t, marketplace, platform)

	got := s.Sources()
	want := []string{"mark8ly", "mark8ly/platform-api"}
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("Sources() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Sources() = %v, want %v", got, want)
		}
	}
}
