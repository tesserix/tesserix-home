package service

import (
	"bytes"
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

func testLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil)), &buf
}

func productServing(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
}

func TestEstateStampsEveryRowWithItsSource(t *testing.T) {
	srv := productServing(t, `{"data":[{"id":"1","action":"tenant.suspended","created_at":"2026-08-22T10:00:00Z"}]}`)
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL},
	}), srv.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"mark8ly"}, log).Estate(context.Background(), op(), "")
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(page.Entries))
	}
	if page.Entries[0].Source != "mark8ly" {
		t.Errorf("Source = %q, want mark8ly — a row that cannot say where it came from is missing the column an operator most needs", page.Entries[0].Source)
	}
}

func TestEstateNarrowsToOneSourceWhenAsked(t *testing.T) {
	srv := productServing(t, `{"data":[{"id":"1","action":"a","created_at":"2026-08-22T10:00:00Z"}]}`)
	defer srv.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: srv.URL},
		{Slug: "kora", BaseURL: srv.URL},
	}), srv.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"kora", "mark8ly"}, log).Estate(context.Background(), op(), "mark8ly")
	if err != nil {
		t.Fatalf("Estate: %v", err)
	}
	if len(page.Entries) != 1 || page.Entries[0].Source != "mark8ly" {
		t.Fatalf("entries = %+v, want only mark8ly rows", page.Entries)
	}
}

func TestEstateRefusesAnUnknownSourceRatherThanReturningNothing(t *testing.T) {
	fed := federation.NewClient(federation.NewRegistry(nil), http.DefaultClient)

	log, _ := testLogger()
	_, err := New(fed, []string{"mark8ly"}, log).Estate(context.Background(), op(), "nope")
	if err == nil {
		t.Fatal("an unknown source must be an error — silently returning zero rows is indistinguishable from 'nothing happened'")
	}
}

func TestEstateSurfacesAFailedSourceRatherThanFailingWhole(t *testing.T) {
	ok := productServing(t, `{"data":[{"id":"1","action":"a","created_at":"2026-08-22T10:00:00Z"}]}`)
	defer ok.Close()
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer down.Close()

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "mark8ly", BaseURL: ok.URL},
		{Slug: "kora", BaseURL: down.URL},
	}), ok.Client())

	log, _ := testLogger()
	page, err := New(fed, []string{"kora", "mark8ly"}, log).Estate(context.Background(), op(), "")
	if err != nil {
		t.Fatalf("Estate must not fail whole when one source is down: %v", err)
	}
	if len(page.Entries) != 1 {
		t.Errorf("entries = %d, want the one source that answered", len(page.Entries))
	}
	if len(page.Failures) != 1 || page.Failures[0].Product != "kora" {
		t.Fatalf("failures = %v, want one naming kora", page.Failures)
	}
}

// TestEstateLogsTheUnredactedCauseOfAFederationFailure proves the service
// calls Failure.Unwrap() and logs the real cause. Failure.Error is a coarse,
// closed-set string on purpose — it is rendered in a browser — but that
// leaves the operator with "connection failed" and nothing else unless
// something logs the unredacted cause server-side. This is that something.
func TestEstateLogsTheUnredactedCauseOfAFederationFailure(t *testing.T) {
	// An address nothing listens on: the transport error's cause names the
	// unreachable host, which sanitize() deliberately never lets onto the
	// wire.
	unreachable := "127.0.0.1:1"

	fed := federation.NewClient(federation.NewRegistry([]federation.Product{
		{Slug: "kora", BaseURL: "http://" + unreachable},
	}), &http.Client{})

	log, buf := testLogger()
	page, err := New(fed, []string{"kora"}, log).Estate(context.Background(), op(), "")
	if err != nil {
		t.Fatalf("Estate must not fail whole when one source is down: %v", err)
	}
	if len(page.Failures) != 1 {
		t.Fatalf("failures = %v, want one naming kora", page.Failures)
	}

	sanitized := page.Failures[0].Error
	logged := buf.String()

	if strings.Contains(sanitized, unreachable) {
		t.Fatalf("sanitized Failure.Error leaked the host: %q", sanitized)
	}
	if !strings.Contains(logged, unreachable) && !strings.Contains(logged, "connection refused") {
		t.Fatalf("log output = %q, want the unredacted cause (host %q or \"connection refused\"), not just %q", logged, unreachable, sanitized)
	}
}
