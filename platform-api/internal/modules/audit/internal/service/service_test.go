package service

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/audit/internal/domain"
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
	srv := productServing(t, `{"data":[{"id":"1","action":"tenant.suspended","timestamp":"2026-08-22T10:00:00Z"}]}`)
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
	srv := productServing(t, `{"data":[{"id":"1","action":"a","timestamp":"2026-08-22T10:00:00Z"}]}`)
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
	ok := productServing(t, `{"data":[{"id":"1","action":"a","timestamp":"2026-08-22T10:00:00Z"}]}`)
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
	if len(page.Failures) != 1 || page.Failures[0].Source != "kora" {
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

	sanitized := page.Failures[0].Message
	logged := buf.String()

	if strings.Contains(sanitized, unreachable) {
		t.Fatalf("sanitized Failure.Error leaked the host: %q", sanitized)
	}
	if !strings.Contains(logged, unreachable) && !strings.Contains(logged, "connection refused") {
		t.Fatalf("log output = %q, want the unredacted cause (host %q or \"connection refused\"), not just %q", logged, unreachable, sanitized)
	}
}

// TestPageMarshalsTheShapeTheConsoleParses pins the exact key set this
// module emits on the wire, because apps/console/lib/audit.ts's parseEntry
// and parseEstateAuditLog require these exact keys and nothing else. A
// rename here is a runtime failure in the browser, not a compile error
// anywhere — checking that "source" is present would still pass if "product"
// were also emitted, so this asserts the whole SET.
func TestPageMarshalsTheShapeTheConsoleParses(t *testing.T) {
	page := domain.Page{
		Entries: []domain.Entry{
			{
				ID:        "1",
				Actor:     "operator@tesserix.test",
				Action:    "tenant.suspended",
				Timestamp: time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC),
				Source:    "mark8ly",
				Target:    "tenant:123",
				Metadata:  `{"reason":"fraud"}`,
			},
		},
		Failures: []domain.Failure{
			{Source: "kora", Message: "timed out"},
		},
	}

	raw, err := json.Marshal(page)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	entries, ok := body["entries"].([]any)
	if !ok || len(entries) != 1 {
		t.Fatalf("entries = %v, want one entry", body["entries"])
	}
	entryKeys := keySet(entries[0].(map[string]any))
	wantEntryKeys := []string{"id", "actor", "action", "timestamp", "source", "target", "metadata"}
	if !sameSet(entryKeys, wantEntryKeys) {
		t.Fatalf("entry keys = %v, want exactly %v", entryKeys, wantEntryKeys)
	}

	failures, ok := body["failures"].([]any)
	if !ok || len(failures) != 1 {
		t.Fatalf("failures = %v, want one failure", body["failures"])
	}
	failureKeys := keySet(failures[0].(map[string]any))
	wantFailureKeys := []string{"source", "message"}
	if !sameSet(failureKeys, wantFailureKeys) {
		t.Fatalf("failure keys = %v, want exactly %v", failureKeys, wantFailureKeys)
	}
}

// TestPageOmitsOptionalEntryFieldsWhenEmpty proves target and metadata are
// genuinely optional on the wire — omitted, not sent as "" — matching the
// console's optionalStr, which only accepts a string or an absent/null key.
func TestPageOmitsOptionalEntryFieldsWhenEmpty(t *testing.T) {
	page := domain.Page{
		Entries: []domain.Entry{
			{
				ID:        "1",
				Actor:     "operator@tesserix.test",
				Action:    "tenant.suspended",
				Timestamp: time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC),
				Source:    "mark8ly",
			},
		},
		Failures: []domain.Failure{},
	}

	raw, err := json.Marshal(page)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	entry := body["entries"].([]any)[0].(map[string]any)
	entryKeys := keySet(entry)
	wantEntryKeys := []string{"id", "actor", "action", "timestamp", "source"}
	if !sameSet(entryKeys, wantEntryKeys) {
		t.Fatalf("entry keys = %v, want exactly %v (target/metadata omitted when empty)", entryKeys, wantEntryKeys)
	}

	if failures, ok := body["failures"].([]any); !ok || len(failures) != 0 {
		t.Fatalf("failures = %v, want an empty array, never null", body["failures"])
	}
}

func keySet(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sameSet(got, want []string) bool {
	gotSorted := append([]string(nil), got...)
	wantSorted := append([]string(nil), want...)
	sort.Strings(gotSorted)
	sort.Strings(wantSorted)
	if len(gotSorted) != len(wantSorted) {
		return false
	}
	for i := range gotSorted {
		if gotSorted[i] != wantSorted[i] {
			return false
		}
	}
	return true
}
